import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readEnv } from "../env";
import { subscribeEngineCrashes } from "../engine-crash-events";
import { EVENT_TAGS } from "../notifications/compose";
import { reportNtfyFailure } from "../notifications/dispatch";
import { publishNtfy } from "../notifications/ntfy";
import { recipientsForAccountEvent } from "../notifications/recipients";
import { isConfigured } from "../notifications/store";
import { isRecord } from "../type-guards";
import { getOmpVersion } from "./omp-cli";
import { getAgentDir } from "./paths";

/**
 * Watches the health of omp's SQLite store (`<agent dir>/agent.db`: logins,
 * credential blocks, settings, caches, usage history) and repairs what is safe
 * to repair.
 *
 * Why it exists: on 2026-11-07 the store's cache and usage-history indexes were
 * damaged (omp before 18.16.0 could drop its own file locks, omp issue #15586).
 * omp could no longer save a fresh usage report and went on serving a
 * five-day-old one; nothing said so.
 *
 * The work itself is `bin/cody-engine-db.mjs`, run as its own process: a full
 * integrity check would stall this server, and the store must never be opened
 * from inside an engine. Damage confined to tables the engine refills is
 * repaired in place, in one transaction that commits only when the file is
 * whole again and every other table is unchanged. Damage that reaches logins
 * or settings is never touched automatically: it is reported, pushed once, and
 * left for the owner.
 */

export const ENGINE_DB_STATE_FILE = "cody-engine-db.json";
export const ENGINE_DB_BACKUP_DIR = "cody-engine-db-backups";
export const ENGINE_DB_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** omp releases from this one on keep their locks when the store is read from inside the engine. */
export const ENGINE_DB_SAFE_OMP = "18.16.0";
const AFTER_CRASH_DELAY_MS = 30_000;
const HELPER_TIMEOUT_MS = 180_000;

export type EngineDbVerdict = "ok" | "derived" | "critical" | "unreadable" | "absent";

export interface EngineDbCheck {
  at: number;
  verdict: EngineDbVerdict;
  problems: number;
  tables: string[];
  sample: string[];
}

export interface EngineDbRepair {
  at: number;
  outcome: "repaired" | "not_needed" | "refused" | "failed";
  reason?: string;
  /** Rows kept per rebuilt table. */
  rebuilt?: Array<{ table: string; kept: number; complete: boolean }>;
}

export interface EngineDbStatus {
  lastCheck: EngineDbCheck | null;
  lastRepair: EngineDbRepair | null;
  backups: number;
  /** The installed omp predates the lock fix, so the damage can recur. */
  engineAtRisk: boolean;
  engineVersion: string | null;
}

interface StateFile {
  version: 1;
  lastCheck: EngineDbCheck | null;
  lastRepair: EngineDbRepair | null;
  /** What the owner was last told about, so one fault is one push. */
  notified: string | null;
}

export function engineDbPath(): string {
  return path.join(getAgentDir(), "agent.db");
}

function statePath(): string {
  return path.join(getAgentDir(), ENGINE_DB_STATE_FILE);
}

function backupDir(): string {
  return path.join(getAgentDir(), ENGINE_DB_BACKUP_DIR);
}

function helperPath(): string {
  const packageDir = readEnv("PACKAGE_DIR") ?? path.resolve(import.meta.dirname, "../..");
  return path.join(packageDir, "bin", "cody-engine-db.mjs");
}

const VERDICTS: readonly EngineDbVerdict[] = ["ok", "derived", "critical", "unreadable", "absent"];
const OUTCOMES: ReadonlyArray<EngineDbRepair["outcome"]> = ["repaired", "not_needed", "refused", "failed"];

function strings(value: unknown, cap: number): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, cap).map((entry) => entry.slice(0, 300)) : [];
}

/** A helper answer or a stored record, read defensively: anything odd is no reading at all. */
export function parseEngineDbCheck(value: unknown): EngineDbCheck | null {
  if (!isRecord(value)) return null;
  const verdict = VERDICTS.find((entry) => entry === value.verdict);
  if (!verdict || typeof value.at !== "number") return null;
  return { at: value.at, verdict, problems: typeof value.problems === "number" ? value.problems : 0, tables: strings(value.tables, 40), sample: strings(value.sample, 12) };
}

function parseRepair(value: unknown, at: number): EngineDbRepair | null {
  if (!isRecord(value)) return null;
  const outcome = OUTCOMES.find((entry) => entry === value.outcome);
  if (!outcome) return null;
  const rebuilt = Array.isArray(value.rebuilt)
    ? value.rebuilt.filter(isRecord).map((row) => ({ table: String(row.table), kept: typeof row.kept === "number" ? row.kept : 0, complete: row.complete !== false }))
    : undefined;
  return { at: typeof value.at === "number" ? value.at : at, outcome, ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 300) } : {}), ...(rebuilt ? { rebuilt } : {}) };
}

function readState(): StateFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(), "utf8"));
    if (isRecord(parsed)) {
      return {
        version: 1,
        lastCheck: parseEngineDbCheck(parsed.lastCheck),
        lastRepair: parseRepair(parsed.lastRepair, 0),
        notified: typeof parsed.notified === "string" ? parsed.notified : null,
      };
    }
  } catch { /* absent or unreadable: start clean */ }
  return { version: 1, lastCheck: null, lastRepair: null, notified: null };
}

function writeState(state: StateFile): void {
  try {
    const file = statePath();
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    console.warn(`[Cody] engine database: could not save the check result: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runHelper(args: string[]): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const script = helperPath();
  if (!existsSync(script)) {
    resolve(null);
    return promise;
  }
  execFile(process.execPath, [script, ...args], { timeout: HELPER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (_error, stdout) => {
    // The helper prints its verdict even when it exits non-zero; no JSON means no reading.
    try {
      resolve(JSON.parse(stdout));
    } catch {
      resolve(null);
    }
  });
  return promise;
}

/** `a` is an older release than `b` (dotted numbers; anything unparsable is not older). */
export function isOlderRelease(a: string | null, b: string): boolean {
  if (!a) return false;
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  if (left.some(Number.isNaN)) return false;
  for (let index = 0; index < right.length; index += 1) {
    const difference = (left[index] ?? 0) - right[index];
    if (difference !== 0) return difference < 0;
  }
  return false;
}

function countBackups(): number {
  try {
    return readdirSync(backupDir()).filter((name) => /^agent-\d+\.db$/.test(name)).length;
  } catch {
    return 0;
  }
}

export async function getEngineDbStatus(): Promise<EngineDbStatus> {
  const state = readState();
  const engineVersion = await getOmpVersion().catch(() => null);
  return { lastCheck: state.lastCheck, lastRepair: state.lastRepair, backups: countBackups(), engineAtRisk: isOlderRelease(engineVersion, ENGINE_DB_SAFE_OMP), engineVersion };
}

/** What a push says, or null when there is nothing the owner must do. */
export function describeEngineDbFault(check: EngineDbCheck, repair: EngineDbRepair | null): { key: string; title: string; body: string } | null {
  if (check.verdict === "ok" || check.verdict === "absent") return null;
  if (check.verdict === "critical" || check.verdict === "unreadable") {
    return {
      key: `${check.verdict}:${check.tables.join(",")}`,
      title: "Cody's engine database is damaged",
      body: "The damage reaches saved logins or settings, so Cody did not repair it by itself. Open Settings › System › Engine database to see what is affected.",
    };
  }
  if (repair && repair.outcome === "failed") {
    return {
      key: `failed:${check.tables.join(",")}`,
      title: "Cody could not repair its engine database",
      body: "Only cached data is damaged and your logins are fine, but the automatic repair did not go through. Open Settings › System › Engine database to try again.",
    };
  }
  return null;
}

async function notifyOnce(state: StateFile, check: EngineDbCheck, repair: EngineDbRepair | null): Promise<void> {
  const fault = describeEngineDbFault(check, repair);
  if (!fault) {
    state.notified = null;
    return;
  }
  if (state.notified === fault.key) return;
  let delivered = false;
  for (const recipient of recipientsForAccountEvent()) {
    const { prefs } = recipient;
    if (!isConfigured(prefs) || !prefs.events.engineDbDamaged.enabled) continue;
    const target = { server: prefs.server, topic: prefs.topic, token: prefs.token };
    const result = await publishNtfy(target, {
      title: fault.title,
      message: fault.body,
      priority: prefs.events.engineDbDamaged.priority,
      tags: [EVENT_TAGS.engineDbDamaged],
      ...(prefs.codyUrl ? { click: `${prefs.codyUrl}/?settings=system` } : {}),
    });
    if (result.ok) delivered = true;
    else reportNtfyFailure(recipient.key, target.server, "publish", result);
  }
  // Remembered only once somebody was told; with nobody listening the Settings card still shows it.
  if (delivered) state.notified = fault.key;
}

interface Globals { __codyEngineDb?: { running: Promise<EngineDbStatus> | null; crashTimer: NodeJS.Timeout | null; unsubscribe: (() => void) | null } }

function shared(): NonNullable<Globals["__codyEngineDb"]> {
  const scope = globalThis as Globals;
  scope.__codyEngineDb ??= { running: null, crashTimer: null, unsubscribe: null };
  return scope.__codyEngineDb;
}

export interface EngineDbRunDeps {
  helper?: (args: string[]) => Promise<unknown>;
  now?: () => number;
}

/**
 * Check the store and, when asked, repair it. `auto` repairs only damage
 * confined to refillable tables; `never` only looks. One run at a time: a
 * second caller gets the first run's answer. Never rejects.
 */
export function runEngineDbCheck(repair: "auto" | "never", deps: EngineDbRunDeps = {}): Promise<EngineDbStatus> {
  const state = shared();
  if (state.running) return state.running;
  const run = (async () => {
    const helper = deps.helper ?? runHelper;
    const now = deps.now ?? Date.now;
    const stored = readState();
    try {
      let check = parseEngineDbCheck(await helper(["check", engineDbPath()]));
      if (!check) return getEngineDbStatus();
      let repaired: EngineDbRepair | null = null;
      if (check.verdict === "derived" && repair === "auto") {
        const answer = await helper(["repair", engineDbPath(), backupDir()]);
        repaired = parseRepair(answer, now());
        const after = isRecord(answer) ? parseEngineDbCheck(answer.after) : null;
        if (after) check = after;
        if (repaired) {
          stored.lastRepair = repaired;
          console.log(`[Cody] engine database: repair ${repaired.outcome}${repaired.reason ? ` (${repaired.reason})` : ""}`);
        }
      }
      stored.lastCheck = check;
      await notifyOnce(stored, check, repaired);
      writeState(stored);
    } catch (error) {
      console.warn(`[Cody] engine database check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return getEngineDbStatus();
  })().finally(() => {
    state.running = null;
  });
  state.running = run;
  return run;
}

/** The housekeeping pass: a check when the last one is older than six hours (or there is none), with automatic repair. */
export async function checkEngineDbIfDue(now: number = Date.now()): Promise<void> {
  const last = readState().lastCheck;
  if (last && now - last.at < ENGINE_DB_CHECK_INTERVAL_MS) return;
  await runEngineDbCheck("auto");
}

/** A crashed engine may have died mid-write: look again shortly after, once per burst of crashes. */
export function watchEngineCrashesForDbCheck(): void {
  const state = shared();
  if (state.unsubscribe) return;
  state.unsubscribe = subscribeEngineCrashes(() => {
    if (state.crashTimer) return;
    state.crashTimer = setTimeout(() => {
      state.crashTimer = null;
      void runEngineDbCheck("auto");
    }, AFTER_CRASH_DELAY_MS);
    state.crashTimer.unref?.();
  });
}
