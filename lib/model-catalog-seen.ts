import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "@/lib/omp/paths";
import { isRecord } from "@/lib/type-guards";

/**
 * The "seen" ledger: which models the user has been SHOWN, per engine.
 *
 * Curation hides models. omp's `enabledModels` and the composer's pinned
 * list are both exact-id allowlists, so a model released after the user
 * curated never appears anywhere — and nothing says the catalog grew. This
 * ledger is what makes "new" a fact rather than a guess: a model is new when
 * the catalog has it and no display of the catalog has recorded it yet.
 *
 * `markCatalogSeen` REPLACES the engine's list with what was just displayed
 * (it is a record of a display, not a union), and `diffNewModels` is the
 * pure comparison the "new models" route builds on. A ledger with no
 * `seenAt` has never been seeded: nothing is "new" retroactively on first
 * run, because the client seeds the ledger the first time it shows the
 * catalog and the diff is meaningful only from then on.
 *
 * Cody-level state, so it lives in the instance data dir
 * (`cody-model-catalog-seen.json`, via `getAgentDir()`) and survives engine
 * switches; it is keyed by engine id because each engine has its own
 * catalog. Keys are `provider/id`, omp's own dialect and what `modelKey()`
 * in lib/model-allow-list.ts produces.
 */

export const SEEN_LEDGER_FILE = "cody-model-catalog-seen.json";
const LEDGER_VERSION = 1;

export interface SeenLedger {
  seenKeys: string[];
  /** ISO timestamp of the last `markCatalogSeen`, or null when never seeded. */
  seenAt: string | null;
}

interface LedgerFile {
  version: number;
  engines: Record<string, { seenKeys: string[]; seenAt: string }>;
}

export function getSeenLedgerPath(): string {
  return path.join(getAgentDir(), SEEN_LEDGER_FILE);
}

/** Deduplicated, sorted, strings only — the canonical on-disk form. */
function normalizeKeys(keys: readonly unknown[]): string[] {
  const set = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set].sort();
}

function readLedgerFile(): LedgerFile {
  const empty: LedgerFile = { version: LEDGER_VERSION, engines: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getSeenLedgerPath(), "utf8"));
  } catch {
    // Missing or unreadable is "never seeded" — the same answer as corrupt.
    return empty;
  }
  if (!isRecord(parsed) || !isRecord(parsed.engines)) return empty;
  for (const [engineId, value] of Object.entries(parsed.engines)) {
    if (!engineId || !isRecord(value) || !Array.isArray(value.seenKeys) || typeof value.seenAt !== "string") continue;
    empty.engines[engineId] = { seenKeys: normalizeKeys(value.seenKeys), seenAt: value.seenAt };
  }
  return empty;
}

function writeLedgerFile(file: LedgerFile): void {
  const target = getSeenLedgerPath();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // Atomic: a crash mid-write leaves the previous ledger intact rather than a
  // truncated file that would read as "never seeded" and re-announce every
  // model as new.
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

export function readSeenLedger(engineId: string): SeenLedger {
  const entry = readLedgerFile().engines[engineId];
  return entry ? { seenKeys: [...entry.seenKeys], seenAt: entry.seenAt } : { seenKeys: [], seenAt: null };
}

/** Records that `keys` is what the user was just shown for `engineId`. The
 * engine's previous list is replaced, never merged: a model that left the
 * catalog leaves the ledger too, and one that returns is new again. */
export function markCatalogSeen(engineId: string, keys: readonly string[]): { seenKeys: string[]; seenAt: string } {
  const file = readLedgerFile();
  const entry = { seenKeys: normalizeKeys(keys), seenAt: new Date().toISOString() };
  file.engines[engineId] = entry;
  writeLedgerFile(file);
  return { seenKeys: [...entry.seenKeys], seenAt: entry.seenAt };
}

/** Which of `catalogKeys` the ledger has never recorded. Order follows
 * `catalogKeys`, so a caller that passes a sorted catalog gets a sorted
 * answer. */
export function diffNewModels(
  catalogKeys: readonly string[],
  ledger: { seenKeys: readonly string[]; seenAt: string | null },
): { newKeys: string[]; firstRun: boolean } {
  if (ledger.seenAt === null) return { newKeys: [], firstRun: true };
  const seen = new Set(ledger.seenKeys);
  const reported = new Set<string>();
  const newKeys: string[] = [];
  for (const key of catalogKeys) {
    if (seen.has(key) || reported.has(key)) continue;
    reported.add(key);
    newKeys.push(key);
  }
  return { newKeys, firstRun: false };
}
