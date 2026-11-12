import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pruneCheckpointStore } from "../checkpoints";
import type { EngineSession } from "../harness/types";
import { getAgentDir, getSessionsDir } from "../omp/paths";
import { asNumber, isRecord } from "../type-guards";
import { PathMentions, scanProcessUsage, type MentionRoot } from "./mentions";
import { dataScratchDirFor, dataScratchRoot, listOrphanDataScratch, listSessionScratch, removeDataScratchDir, removeScratchDir, scratchRoot, type ScratchEntry } from "./scratch";
import { readDiskSettings, type DiskSettings } from "./settings";
import { readDiskAreas, type DiskArea } from "./status";
import { collectSweepCandidates, readLivePids, sweepCandidates, type SweepPlan, type SweepReferences, type SweepRoot } from "./sweep";
import { indexSessionFiles, lastActivityBySession, readTranscriptMentions, type SessionFile } from "./transcripts";
import { measureTree } from "./walk";

/**
 * Cody's own janitor: the ONLY cleanup there is. Nothing on the host removes
 * what an agent leaves behind (no cron, no host script, by the owner's choice),
 * and on 2026-11-04 a quota-less /tmp held 208 GB of leftovers and the server
 * stopped answering. One run does, in this order:
 *
 * 1. each chat's scratch dir (lib/disk/scratch.ts) idle for `scratchIdleDays`;
 * 2. the flat sweep of the system temp dir and `$HOME/tmp` (lib/disk/sweep.ts);
 * 3. undo snapshots past their age and size caps (lib/checkpoints.ts);
 * 4. if a disk is still over its budget, the scratch of the longest-idle chats
 *    first.
 *
 * It runs an hour after the last one (lib/harness/housekeeping.ts), at boot,
 * and on demand from Settings. It never throws: a step that fails is written
 * to `report.errors` and the rest still run. A running chat's scratch is never
 * removed, however old its files look.
 */

export type JanitorTrigger = "boot" | "hourly" | "manual";

export type JanitorRemovalReason = "scratch-idle" | "scratch-orphan" | "scratch-budget" | "tmp-idle" | "home-tmp-idle" | "checkpoint";

export interface JanitorRemoval {
  path: string;
  /** Apparent size (what `ls -l` adds up), which is what a person can check. */
  bytes: number;
  reason: JanitorRemovalReason;
}

export interface ScratchSize {
  dir: string;
  sessionIds: string[];
  bytes: number;
  /** The last time the chat, its transcripts or a file inside touched it. */
  lastUsedAt: number;
  /** The chat's engine is running: this folder is never removed. */
  live: boolean;
}

export interface JanitorReport {
  trigger: JanitorTrigger;
  startedAt: number;
  finishedAt: number;
  /** Everything removed (or, in a dry run, everything that would be), biggest first. */
  removed: JanitorRemoval[];
  freedBytes: number;
  /** The scratch dirs that remain after this run. */
  scratch: ScratchSize[];
  /** What the undo snapshots hold after this run. */
  checkpointBytes: number;
  areasBefore: DiskArea[];
  areasAfter: DiskArea[];
  errors: string[];
}

/** The chats whose engines are running now. */
export interface LiveSessions {
  /** Every id a running chat is known by. */
  ids: Set<string>;
  /** The folders they work in (their undo snapshots are kept). */
  cwds: Set<string>;
  /** The scratch dirs their engines run in. A chat continued under an id its
   *  index entry never learned is still found by the dir it uses. */
  dirs: Set<string>;
}

/** What the janitor reads from the machine. A test hands in stand-ins so it
 *  never touches the real temp dir or process table. */
export interface JanitorEnvironment {
  tmpRoot: string;
  /** `$HOME/tmp`; null when there is none. */
  homeTmpRoot: string | null;
  /** The process table (`/proc`); null when this machine has none. */
  procRoot: string | null;
  sessionsDir: string;
  /** null: the registry could not be read, so every chat counts as running. */
  liveSessions: () => LiveSessions | null;
  readAreas: () => DiskArea[];
}

export interface JanitorOptions {
  trigger?: JanitorTrigger;
  /** The time to judge ages against (default: now). */
  now?: number;
  /** Work out and report what would go, and delete nothing. Never saved as the last run. */
  dryRun?: boolean;
  /** How long one run may take before it leaves the rest for the next. */
  budgetMs?: number;
  /** Settings to use instead of the saved ones, field by field. */
  settings?: Partial<DiskSettings>;
  environment?: Partial<JanitorEnvironment>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const GIB = 1024 ** 3;
const RUN_BUDGET_MS = 30 * 60_000;
/** Shares of the run budget by which the slower steps must be done. */
const SCRATCH_PHASE_SHARE = 0.35;
const SWEEP_PHASE_SHARE = 0.85;
/** Budget pressure takes only chats idle at least this long. */
const BUDGET_MIN_IDLE_MS = 6 * HOUR_MS;
/** A chat active within this long may reuse any temp path its transcript names. */
const TRANSCRIPT_WINDOW_MS = 72 * HOUR_MS;
const MAX_ERRORS = 40;
const REPORT_FILE_NAME = "cody-janitor-report.json";

declare global {
  /** One run at a time across the custom server and the request side, which hold separate module copies. */
  var __codyDiskJanitor: { running: Promise<JanitorReport> | null } | undefined;
  /** The live-session registry lib/rpc-manager.ts keeps; read here without importing that module. */
  var __ompSessions: Map<string, EngineSession> | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deviceOf(target: string): number | null {
  try {
    return fs.statSync(target).dev;
  } catch {
    return null;
  }
}

/**
 * The chats whose engines are running, read from the registry
 * lib/rpc-manager.ts keeps on `globalThis` (as lib/notifications/quota-watch.ts
 * does): loading that module into the custom server's own copy just to read a
 * Map would drag in the biggest import graph there is. A registry that was
 * never created means no chat was ever started; one that is not a Map is
 * unknown, and unknown means "everything is running".
 */
function readLiveSessions(): LiveSessions | null {
  const registry = globalThis.__ompSessions;
  const live: LiveSessions = { ids: new Set(), cwds: new Set(), dirs: new Set() };
  if (registry === undefined) return live;
  if (!(registry instanceof Map)) return null;
  for (const [key, session] of registry) {
    if (typeof key === "string") live.ids.add(key);
    if (typeof session?.sessionId === "string" && session.sessionId !== "") live.ids.add(session.sessionId);
    if (typeof session?.cwd === "string" && session.cwd !== "") live.cwds.add(path.resolve(session.cwd));
    if (typeof session?.scratchDir === "string" && session.scratchDir !== "") live.dirs.add(path.resolve(session.scratchDir));
  }
  return live;
}

function defaultEnvironment(): JanitorEnvironment {
  const homeTmp = path.join(os.homedir(), "tmp");
  let homeTmpRoot: string | null = null;
  try {
    if (fs.statSync(homeTmp).isDirectory()) homeTmpRoot = homeTmp;
  } catch {
    // No $HOME/tmp: nothing to sweep there.
  }
  return {
    tmpRoot: os.tmpdir(),
    homeTmpRoot,
    procRoot: "/proc",
    sessionsDir: getSessionsDir(),
    liveSessions: readLiveSessions,
    readAreas: () => readDiskAreas(),
  };
}

/** One scratch dir, measured, and what the run decided about it. */
interface ScratchState {
  entry: ScratchEntry;
  bytes: number;
  /** The last time anything touched it: the chat's own record, its transcripts, or a file inside. */
  activeAt: number;
  live: boolean;
  orphan: boolean;
  /** May be removed once idle: not running, no process using it, nothing mounted inside, and (for an
   *  orphan, which names no chat) the process table could be read and the walk finished. */
  removable: boolean;
  dev: number | null;
  /** The chat's twin on the data disk (`CODY_DATA_SCRATCH`), and what is in it. */
  dataDir: string | null;
  dataBytes: number;
  dataDev: number | null;
  removed: boolean;
}

interface Run {
  now: number;
  dryRun: boolean;
  settings: DiskSettings;
  env: JanitorEnvironment;
  deadline: number;
  removed: JanitorRemoval[];
  errors: string[];
  unreportedErrors: number;
  /** Bytes this run removed, by device: a ZFS dataset reports freed space a few seconds late, so the budget pass trusts the sum too. */
  freedByDevice: Map<number, number>;
}

function note(run: Run, message: string): void {
  if (run.errors.length < MAX_ERRORS) run.errors.push(message);
  else run.unreportedErrors += 1;
}

function record(run: Run, removal: JanitorRemoval, dev: number | null): void {
  run.removed.push(removal);
  if (dev !== null) run.freedByDevice.set(dev, (run.freedByDevice.get(dev) ?? 0) + removal.bytes);
}

async function guarded(run: Run, step: string, work: () => Promise<void> | void): Promise<void> {
  try {
    await work();
  } catch (error) {
    note(run, `${step}: ${errorText(error)}`);
  }
}

/** Paths a sweep must never take, or take anything that contains: Cody's own
 *  state, the home dir, the server's working dir, and the server's own
 *  transpile cache. That last one lives in the temp dir when the install dir
 *  is read-only, is written only when a module changes, and a running server
 *  that finds it gone fails the next import it makes (measured), so it cannot
 *  be told from litter by age. */
function protectedPaths(env: JanitorEnvironment): string[] {
  return [scratchRoot(), dataScratchRoot(), getAgentDir(), os.homedir(), process.cwd(), path.join(env.tmpRoot, "jiti")].map((entry) => path.resolve(entry));
}

function realPathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** The directories text and processes may name, with the other ways text spells them. */
function mentionRoots(env: JanitorEnvironment): MentionRoot[] {
  const roots: MentionRoot[] = [];
  const add = (root: string, spellings?: string[]): void => {
    roots.push({ path: root, spellings });
    const real = realPathOrNull(root);
    if (real !== null && real !== root) roots.push({ path: real });
  };
  add(path.resolve(env.tmpRoot));
  if (env.homeTmpRoot !== null) {
    const relative = path.relative(os.homedir(), env.homeTmpRoot).split(path.sep).join("/");
    const underHome = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    add(path.resolve(env.homeTmpRoot), underHome ? [`~/${relative}`, `$HOME/${relative}`, `\${HOME}/${relative}`] : []);
  }
  add(scratchRoot());
  add(dataScratchRoot());
  return roots;
}

/** Is this scratch dir a running chat's: by any id the chat has, or by the dir its engine runs in? Unknown counts as running. */
function isRunning(live: LiveSessions | null, entry: ScratchEntry): boolean {
  return live === null || entry.sessionIds.some((id) => live.ids.has(id)) || live.dirs.has(path.resolve(entry.dir));
}

/** A scratch dir is removed only if this still holds when it is about to go: a chat resumed since the listing owns its dir again. */
function stillIdle(run: Run, state: ScratchState, minIdleMs: number): boolean {
  const fresh = listSessionScratch().find((candidate) => candidate.dir === state.entry.dir);
  if (!fresh || isRunning(run.env.liveSessions(), fresh)) return false;
  return run.now - Math.max(fresh.lastUsedAt, state.activeAt) >= minIdleMs;
}

async function removeScratch(run: Run, state: ScratchState, reason: JanitorRemovalReason, minIdleMs: number): Promise<void> {
  try {
    if (!run.dryRun) {
      if (!stillIdle(run, state, minIdleMs)) return;
      if (!(await removeScratchDir(state.entry.dir))) {
        note(run, `Could not remove the scratch folder ${state.entry.dir}`);
        return;
      }
    }
    state.removed = true;
    record(run, { path: state.entry.dir, bytes: state.bytes, reason }, state.dev);
    if (state.dataDir !== null && state.dataBytes > 0) record(run, { path: state.dataDir, bytes: state.dataBytes, reason }, state.dataDev);
  } catch (error) {
    note(run, `Could not remove the scratch folder ${state.entry.dir}: ${errorText(error)}`);
  }
}

/** Does a running process use this data-disk dir (or its real path, when the root is a link)? Unknown counts as used. */
function heldByProcess(processes: PathMentions | null, dir: string): boolean {
  if (processes === null) return true;
  const real = realPathOrNull(dir);
  return processes.has(dir) || (real !== null && processes.has(real));
}

/**
 * Data-disk scratch dirs no chat owns any more (the chat's index entry and its
 * tmp dir are both gone, e.g. after the chat was forgotten): removed once
 * nothing inside changed for `scratchIdleDays`, no process uses them and no
 * running chat's engine lives in the twin tmp dir. The pairs of chats that
 * still exist go with their tmp dir (`removeScratch`). Needs the running chats
 * and the process table, like an orphan tmp dir does.
 */
async function removeOrphanDataScratch(run: Run, live: LiveSessions | null, processes: PathMentions | null, deadline: number): Promise<void> {
  if (live === null || processes === null) return;
  const liveNames = new Set([...live.dirs].map((dir) => path.basename(dir)));
  const idleMs = run.settings.scratchIdleDays * DAY_MS;
  for (const dir of listOrphanDataScratch()) {
    if (liveNames.has(path.basename(dir)) || heldByProcess(processes, dir)) continue;
    const tree = await measureTree(dir, { deadline });
    if (!tree.complete || tree.crossedDevice || run.now - tree.newestModifiedMs < idleMs) continue;
    try {
      if (!run.dryRun) {
        const again = run.env.liveSessions();
        if (again === null || [...again.dirs].some((candidate) => path.basename(candidate) === path.basename(dir))) continue;
        if (!(await removeDataScratchDir(dir))) {
          note(run, `Could not remove the scratch folder ${dir}`);
          continue;
        }
      }
      record(run, { path: dir, bytes: tree.bytes, reason: "scratch-orphan" }, tree.dev);
    } catch (error) {
      note(run, `Could not remove the scratch folder ${dir}: ${errorText(error)}`);
    }
  }
}

/** Measure every scratch dir (the report lists them all) and work out which may go once idle. */
async function measureScratch(
  run: Run,
  live: LiveSessions | null,
  activity: Map<string, number>,
  processes: PathMentions | null,
  deadline: number,
): Promise<ScratchState[]> {
  const states: ScratchState[] = [];
  // Chats that are not running first: they are what may be removed, and a time limit should cut off the sizes of the running ones.
  const entries = listSessionScratch().sort((a, b) => Number(isRunning(live, a)) - Number(isRunning(live, b)));
  for (const entry of entries) {
    const tree = await measureTree(entry.dir, { deadline });
    const dataDir = dataScratchDirFor(entry.dir);
    const data = dataDir === null ? null : await measureTree(dataDir, { deadline });
    let activeAt = Math.max(entry.lastUsedAt, tree.newestModifiedMs, data?.newestModifiedMs ?? 0);
    for (const id of entry.sessionIds) activeAt = Math.max(activeAt, activity.get(id) ?? 0);
    const orphan = entry.sessionIds.length === 0;
    const isLive = isRunning(live, entry);
    const held = (processes?.has(entry.dir) ?? false) || (dataDir !== null && processes !== null && heldByProcess(processes, dataDir));
    states.push({
      entry,
      bytes: tree.bytes,
      activeAt,
      live: isLive,
      orphan,
      removable: !isLive && !held && !tree.crossedDevice && !(data?.crossedDevice ?? false) && (!orphan || (processes !== null && tree.complete && (data?.complete ?? true))),
      dev: tree.dev,
      dataDir,
      dataBytes: data?.bytes ?? 0,
      dataDev: data?.dev ?? null,
      removed: false,
    });
  }
  return states;
}

/** If a disk the scratch dirs live on is over its budget, remove the scratch of the longest-idle chats, one at a time, until it is not. */
async function relieveBudget(run: Run, states: ScratchState[], before: DiskArea[]): Promise<void> {
  const devices = [deviceOf(scratchRoot()), deviceOf(dataScratchRoot())].filter((dev): dev is number => dev !== null);
  if (devices.length === 0) return;
  const limit = run.settings.budgetPercent / 100;
  /** The devices (of the scratch dirs) that are over budget now. */
  const overBudget = (): Set<number> => {
    const over = new Set<number>();
    let areas: DiskArea[];
    try {
      areas = run.env.readAreas();
    } catch {
      return over;
    }
    for (const area of areas) {
      const dev = deviceOf(area.path);
      if (area.totalBytes <= 0 || dev === null || !devices.includes(dev)) continue;
      const first = before.find((earlier) => earlier.id === area.id)?.usedBytes ?? area.usedBytes;
      const used = Math.min(area.usedBytes, first - (run.freedByDevice.get(dev) ?? 0));
      if (used / area.totalBytes > limit) over.add(dev);
    }
    return over;
  };
  if (overBudget().size === 0) return;
  // A chat's folder is worth removing only if it holds something on a disk that is over budget.
  const frees = (state: ScratchState, over: Set<number>): boolean =>
    (state.bytes > 0 && state.dev !== null && over.has(state.dev)) || (state.dataBytes > 0 && state.dataDev !== null && over.has(state.dataDev));
  const idle = states
    .filter((state) => !state.removed && state.removable && run.now - state.activeAt >= BUDGET_MIN_IDLE_MS)
    .sort((a, b) => a.activeAt - b.activeAt);
  for (const state of idle) {
    const over = overBudget();
    if (over.size === 0) return;
    if (!frees(state, over)) continue;
    await removeScratch(run, state, "scratch-budget", BUDGET_MIN_IDLE_MS);
  }
}

function reportPath(): string {
  return path.join(getAgentDir(), REPORT_FILE_NAME);
}

/** Atomic and 0600, like every other state file in the data dir. */
function saveReport(report: JanitorReport): void {
  const file = reportPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(report)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

const TRIGGERS: Record<string, true> = { boot: true, hourly: true, manual: true };
const REASONS: Record<string, true> = {
  "scratch-idle": true,
  "scratch-orphan": true,
  "scratch-budget": true,
  "tmp-idle": true,
  "home-tmp-idle": true,
  checkpoint: true,
};

function isArea(value: unknown): value is DiskArea {
  return isRecord(value)
    && typeof value.id === "string" && typeof value.path === "string" && typeof value.level === "string"
    && [value.totalBytes, value.availableBytes, value.usedBytes, value.freeFraction].every((field) => asNumber(field) !== undefined);
}

function isRemoval(value: unknown): value is JanitorRemoval {
  return isRecord(value) && typeof value.path === "string" && asNumber(value.bytes) !== undefined
    && typeof value.reason === "string" && Object.hasOwn(REASONS, value.reason);
}

function isScratchSize(value: unknown): value is ScratchSize {
  return isRecord(value) && typeof value.dir === "string" && Array.isArray(value.sessionIds)
    && value.sessionIds.every((id) => typeof id === "string")
    && asNumber(value.bytes) !== undefined && asNumber(value.lastUsedAt) !== undefined && typeof value.live === "boolean";
}

/** The last real run (a dry run is never saved). A missing or damaged file reads as no run. */
export function readLastJanitorReport(): JanitorReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(reportPath(), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.trigger !== "string" || !Object.hasOwn(TRIGGERS, parsed.trigger)) return null;
  const startedAt = asNumber(parsed.startedAt);
  const finishedAt = asNumber(parsed.finishedAt);
  if (startedAt === undefined || finishedAt === undefined) return null;
  const list = <T>(value: unknown, keep: (item: unknown) => item is T): T[] => (Array.isArray(value) ? value.filter(keep) : []);
  return {
    trigger: parsed.trigger as JanitorTrigger,
    startedAt,
    finishedAt,
    removed: list(parsed.removed, isRemoval),
    freedBytes: asNumber(parsed.freedBytes) ?? 0,
    scratch: list(parsed.scratch, isScratchSize),
    checkpointBytes: asNumber(parsed.checkpointBytes) ?? 0,
    areasBefore: list(parsed.areasBefore, isArea),
    areasAfter: list(parsed.areasAfter, isArea),
    errors: list(parsed.errors, (item): item is string => typeof item === "string"),
  };
}

async function execute(options: JanitorOptions): Promise<JanitorReport> {
  const started = Date.now();
  const now = options.now ?? started;
  const env: JanitorEnvironment = { ...defaultEnvironment(), ...options.environment };
  const run: Run = {
    now,
    dryRun: options.dryRun === true,
    settings: { ...readDiskSettings(), ...options.settings },
    env,
    deadline: started + (options.budgetMs ?? RUN_BUDGET_MS),
    removed: [],
    errors: [],
    unreportedErrors: 0,
    freedByDevice: new Map(),
  };
  const phaseEnd = (share: number): number => started + (run.deadline - started) * share;
  let areasBefore: DiskArea[] = [];
  let states: ScratchState[] = [];
  let checkpointBytes = 0;
  const { settings } = run;

  await guarded(run, "Reading disk space", () => {
    areasBefore = env.readAreas();
  });
  // Unknown (the registry could not be read) keeps every chat's scratch and every workspace's snapshots.
  let live: LiveSessions | null = null;
  await guarded(run, "Reading the running chats", () => {
    live = env.liveSessions();
  });
  let files: SessionFile[] = [];
  await guarded(run, "Reading chat transcripts", async () => {
    files = await indexSessionFiles(env.sessionsDir);
  });

  // The process ids now running: a pid-looking number in a `$HOME/tmp` folder name only counts as stale when it is not one of these.
  let livePids: Set<number> | null = null;
  await guarded(run, "Reading process ids", async () => {
    livePids = await readLivePids(env.procRoot);
  });

  const sweepRoots: SweepRoot[] = [{ path: env.tmpRoot, idleMs: settings.tmpIdleHours * HOUR_MS, reason: "tmp-idle", directoriesOnly: false }];
  if (env.homeTmpRoot !== null && realPathOrNull(env.homeTmpRoot) !== realPathOrNull(env.tmpRoot)) {
    sweepRoots.push({
      path: env.homeTmpRoot,
      idleMs: settings.homeTmpIdleHours * HOUR_MS,
      reason: "home-tmp-idle",
      directoriesOnly: true,
      leftover: { idleMs: settings.testLeftoverIdleHours * HOUR_MS, livePids },
    });
  }
  let candidates: SweepPlan = { candidates: [], searched: [] };
  await guarded(run, "Listing the temp folders", async () => {
    candidates = await collectSweepCandidates(sweepRoots, { now, protectedPaths: protectedPaths(env) });
  });

  // One look at the process table serves the scratch dirs and the sweep alike.
  let processes: PathMentions | null = null;
  let roots: MentionRoot[] = [];
  await guarded(run, "Reading the process list", async () => {
    roots = mentionRoots(env);
    const seen = new PathMentions(roots, candidates.searched);
    if (env.procRoot !== null && (await scanProcessUsage(seen, { procRoot: env.procRoot }))) processes = seen;
  });

  await guarded(run, "Scratch folders", async () => {
    states = await measureScratch(run, live, lastActivityBySession(files), processes, phaseEnd(SCRATCH_PHASE_SHARE));
    for (const state of states) {
      if (state.removable && now - state.activeAt >= settings.scratchIdleDays * DAY_MS) {
        await removeScratch(run, state, state.orphan ? "scratch-orphan" : "scratch-idle", settings.scratchIdleDays * DAY_MS);
      }
    }
    await removeOrphanDataScratch(run, live, processes, phaseEnd(SCRATCH_PHASE_SHARE));
  });

  await guarded(run, "Temp folders", async () => {
    if (candidates.candidates.length === 0) return;
    // Read twice by the sweep: once for the decisions, once more just before anything goes.
    const readReferences = async (): Promise<SweepReferences | null> => {
      if (env.procRoot === null) return null;
      const processesNow = new PathMentions(roots, candidates.searched);
      if (!(await scanProcessUsage(processesNow, { procRoot: env.procRoot }))) return null;
      const transcripts = new PathMentions(roots, candidates.searched);
      await readTranscriptMentions(await indexSessionFiles(env.sessionsDir), transcripts, { now, windowMs: TRANSCRIPT_WINDOW_MS });
      return { processes: processesNow, transcripts };
    };
    const first = await readReferences();
    if (first === null) {
      note(run, "The list of running programs could not be read, so the temp folders were left alone.");
      return;
    }
    const { swept, errors } = await sweepCandidates(candidates.candidates, {
      ...first,
      now,
      dryRun: run.dryRun,
      deadline: phaseEnd(SWEEP_PHASE_SHARE),
      refresh: readReferences,
    });
    for (const entry of swept) record(run, entry.removal, entry.dev);
    for (const message of errors) note(run, message);
  });

  await guarded(run, "Undo snapshots", async () => {
    const running = env.liveSessions();
    if (running === null) return;
    const pruned = await pruneCheckpointStore({
      maxBytes: settings.checkpointMaxGb * GIB,
      maxAgeMs: settings.checkpointMaxAgeDays * DAY_MS,
      now,
      liveCwds: running.cwds,
      dryRun: run.dryRun,
    });
    for (const removal of pruned.removed) record(run, { ...removal, reason: "checkpoint" }, pruned.dev);
    for (const message of pruned.errors) note(run, message);
    checkpointBytes = pruned.totalBytes;
  });

  await guarded(run, "Disk budget", () => relieveBudget(run, states, areasBefore));

  let areasAfter: DiskArea[] = [];
  await guarded(run, "Reading disk space", () => {
    areasAfter = env.readAreas();
  });
  if (run.unreportedErrors > 0) run.errors.push(`…and ${run.unreportedErrors} more problems`);
  run.removed.sort((a, b) => b.bytes - a.bytes);
  const report: JanitorReport = {
    trigger: options.trigger ?? "manual",
    startedAt: now,
    finishedAt: now + (Date.now() - started),
    removed: run.removed,
    freedBytes: run.removed.reduce((sum, removal) => sum + removal.bytes, 0),
    scratch: states
      .filter((state) => !state.removed)
      .map((state) => ({ dir: state.entry.dir, sessionIds: state.entry.sessionIds, bytes: state.bytes + state.dataBytes, lastUsedAt: state.activeAt, live: state.live })),
    checkpointBytes,
    areasBefore,
    areasAfter,
    errors: run.errors,
  };
  if (!run.dryRun) {
    try {
      saveReport(report);
    } catch (error) {
      report.errors.push(`Could not save the report: ${errorText(error)}`);
    }
  }
  return report;
}

/** `execute`, with the promise that it never rejects kept even by a failure before its first step. */
async function executeSafely(options: JanitorOptions): Promise<JanitorReport> {
  try {
    return await execute(options);
  } catch (error) {
    const now = options.now ?? Date.now();
    return {
      trigger: options.trigger ?? "manual",
      startedAt: now,
      finishedAt: now,
      removed: [],
      freedBytes: 0,
      scratch: [],
      checkpointBytes: 0,
      areasBefore: [],
      areasAfter: [],
      errors: [`The disk janitor could not start: ${errorText(error)}`],
    };
  }
}

/**
 * Run the janitor once. A call made while a real run is in progress joins it
 * and gets its report. A dry run reports what a real one would remove, shares
 * nothing with it, and is not saved.
 */
export function runDiskJanitor(options: JanitorOptions = {}): Promise<JanitorReport> {
  if (options.dryRun) return executeSafely(options);
  const flight = (globalThis.__codyDiskJanitor ??= { running: null });
  if (flight.running) return flight.running;
  const running = executeSafely(options).finally(() => {
    flight.running = null;
  });
  flight.running = running;
  return running;
}

export function isDiskJanitorRunning(): boolean {
  return Boolean(globalThis.__codyDiskJanitor?.running);
}
