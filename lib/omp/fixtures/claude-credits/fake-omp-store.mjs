import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A stand-in for omp's credential store, for the tests of Cody's key handling.
 *
 * The two fake bridge scripts next to this file (`fake-credentials-helper.mjs`, the argv-driven
 * list/remove bridge, and `fake-keys-helper.mjs`, the stdin-driven list/add bridge) answer with
 * exactly the JSON frames the real Bun helpers print, but read and write ONE JSON file in the
 * agent directory instead of omp's SQLite store. Rows are shaped like the real ones: the
 * credential list never shows a secret, the key list shows only an id, the provider the key
 * lives under and the last four characters, and adding a key that is already held under ANY of
 * the credits providers the request names returns that existing row, with ITS provider — the
 * property that makes "the same key for the second account" detectable at all, now that every key
 * has a provider of its own (`anthropic-api`, `anthropic-api-2`, …).
 *
 * Besides the rows the file carries `faults` (what each bridge operation should do wrong) and
 * `watch` (files whose content each recorded operation snapshots, so a test can say what Cody's
 * own records looked like at the moment omp was asked to do something).
 */

const STORE = "fake-omp-store.json";
const OPERATIONS = "fake-omp-operations.jsonl";

export const FAKE_CREDENTIALS_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-credentials-helper.mjs");
export const FAKE_KEYS_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-keys-helper.mjs");

export const storeFile = (agentDir) => path.join(agentDir, STORE);
export const operationsFile = (agentDir) => path.join(agentDir, OPERATIONS);

export function readFakeStore(agentDir) {
  try {
    return JSON.parse(readFileSync(storeFile(agentDir), "utf8"));
  } catch {
    return { nextId: 1, rows: [], faults: {}, watch: [] };
  }
}

export function writeFakeStore(agentDir, store) {
  mkdirSync(agentDir, { recursive: true });
  const temp = `${storeFile(agentDir)}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(store, null, 2));
  renameSync(temp, storeFile(agentDir));
}

/** Add rows the way a login would, newest id last. Returns the ids given. */
export function addFakeRows(agentDir, rows) {
  const store = readFakeStore(agentDir);
  const ids = rows.map((row) => {
    const id = store.nextId;
    store.nextId += 1;
    store.rows.push({ provider: "anthropic", type: "oauth", identity: null, disabledCause: null, blockedUntil: null, key: null, ...row, id });
    return id;
  });
  writeFakeStore(agentDir, store);
  return ids;
}

export const planAccount = (identity, extra = {}) => ({ provider: "anthropic", type: "oauth", identity, ...extra });

export function updateFakeStore(agentDir, change) {
  const store = readFakeStore(agentDir);
  change(store);
  writeFakeStore(agentDir, store);
}

/** Make a bridge operation fail: "fail" (an `ok:false` frame), "garbage" (not JSON), "exit" (no answer). */
export function setFault(agentDir, operation, how) {
  updateFakeStore(agentDir, (store) => {
    if (how === null) delete store.faults[operation]; else store.faults[operation] = how;
  });
}

export function watchFiles(agentDir, files) {
  updateFakeStore(agentDir, (store) => { store.watch = [...files]; });
}

/** The credits provider family, spelled out here on purpose: the ids Cody must use are part of the contract with omp. */
export const CREDITS_PROVIDER_IDS = ["anthropic-api", ...Array.from({ length: 7 }, (_, index) => `anthropic-api-${index + 2}`)];

/** The API keys omp holds under the credits providers, in id order, secrets and providers included: for assertions only. */
export function fakeCreditsKeys(agentDir) {
  return readFakeStore(agentDir).rows
    .filter((row) => CREDITS_PROVIDER_IDS.includes(row.provider) && row.type === "api_key")
    .sort((a, b) => a.id - b.id)
    .map((row) => ({ id: row.id, key: row.key, provider: row.provider }));
}

export function readOperations(agentDir) {
  try {
    return readFileSync(operationsFile(agentDir), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// ── What the helper scripts use ──────────────────────────────────────────────

export function recordOperation(agentDir, store, entry) {
  const watched = {};
  for (const file of store.watch ?? []) watched[file] = existsSync(file) ? readFileSync(file, "utf8") : null;
  mkdirSync(agentDir, { recursive: true });
  appendFileSync(operationsFile(agentDir), `${JSON.stringify({ ...entry, watched })}\n`);
}

export function emit(value) {
  process.stdout.write(JSON.stringify(value));
}

/** Apply a fault. Returns true when the operation was already answered (or deliberately not). */
export function applyFault(store, operation, type) {
  const how = store.faults?.[operation];
  // A gate is not a failure: the helper answers normally, only later (see holdAtGate).
  if (!how || how === "gate") return false;
  if (how === "garbage") process.stdout.write("this is not a frame {");
  else if (how === "exit") process.exitCode = 1;
  else emit({ type, ok: false, code: "fake_fault", message: `The fake store refused ${operation}.` });
  return true;
}

// ── A gate: an operation held in flight until the test says so ───────────────
//
// A helper whose fault is "gate" says it is waiting and holds its operation — before it changes anything —
// until the test opens the gate. It lets a test make one operation overlap another deterministically (a key
// save that is still in flight when a status read arrives).

const gateWaitingFile = (agentDir) => path.join(agentDir, "fake-gate-waiting");
const gateOpenFile = (agentDir) => path.join(agentDir, "fake-gate-open");

export const isGated = (store, operation) => store.faults?.[operation] === "gate";

/** In a helper: announce it is holding its answer, and wait for the gate to open. */
export async function holdAtGate(agentDir) {
  writeFileSync(gateWaitingFile(agentDir), "1");
  while (!existsSync(gateOpenFile(agentDir))) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** In a test: wait until a gated helper is holding its answer. */
export async function waitUntilHeld(agentDir, timeoutMs = 60_000) {
  const started = Date.now();
  while (!existsSync(gateWaitingFile(agentDir))) {
    if (Date.now() - started > timeoutMs) throw new Error("no helper reached the gate");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** In a test: let the held answer go. */
export function openGate(agentDir) {
  writeFileSync(gateOpenFile(agentDir), "1");
}
