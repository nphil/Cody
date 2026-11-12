import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ompTestPackageBin, ompTestPackageSkip } from "./omp/omp-test-package.mjs";

/**
 * A chat omp carried on in a newer file, proven against the REAL omp.
 *
 * omp 18.13.2+ continues a session in a sibling file (new id, header
 * `continuationOf` naming the old one) when it cannot keep writing the original,
 * and a resume of the OLD file then opens the newest copy. Cody asks for chats by
 * id, so the id it asked for and the id that answers differ: everything it files
 * under the old id (owner, preset, Local-only snapshot, plan checklist, scheduled
 * messages, scratch dir) has to follow, and a second start for the old id has to
 * reach the running chat instead of opening a second child on the file the first
 * one holds. An older omp does none of this: the old file resumes as itself.
 *
 * The two files are written by hand to the shape omp writes (the shape was read off
 * a real continuation); the child, the resume lookup and the identity it reports
 * are the engine's own. Point CODY_OMP_BIN at either engine to run it against that
 * one. Needs omp and bun; skipped without them.
 */

const ompBin = ompTestPackageBin();
const skip = ompTestPackageSkip();

const root = mkdtempSync(path.join(os.tmpdir(), "cody-continuation-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "CODY_OMP_BIN", "CODY_SCRATCH_ROOT", "HOME", "PI_CONFIG_FILES", "OMP_PROFILE", "PI_PROFILE"].map((key) => [key, process.env[key]]));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "work");
const sessionsDir = path.join(agentDir, "sessions", "-continuation");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_SCRATCH_ROOT = path.join(root, "scratch");
process.env.HOME = root;
process.env.PI_CONFIG_FILES = "";
if (ompBin) process.env.CODY_OMP_BIN = ompBin;
// A named omp profile outranks PI_CODING_AGENT_DIR: never let one point this test at a real agent dir.
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;

test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const version = skip ? null : execFileSync(ompBin, ["--version"], { encoding: "utf8" }).trim().replace(/^omp\//, "");
const atLeast = (have, want) => {
  const a = have.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = want.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
/** Does this engine open the newest copy of a continued chat when asked for the old file? */
const followsContinuations = version !== null && atLeast(version, "18.13.2");

const A = "01a1cf03-0000-7000-8000-00000000000a";
const B = "01a1cf03-0000-7000-8000-00000000000b";
const entry = (id, parentId, at, message) => ({ type: "message", id, parentId, timestamp: new Date(at).toISOString(), message: { ...message, timestamp: at } });
const user = (id, parentId, at, text) => entry(id, parentId, at, { role: "user", content: [{ type: "text", text }], attribution: "user" });
const answer = (id, parentId, at, text) => entry(id, parentId, at, {
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "local",
  model: "primary",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
});
const fileName = (at, id) => `${new Date(at).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;
const write = (file, records) => writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

const startedAt = Date.now() - 3_600_000;
const movedAt = startedAt + 600_000;
const fileA = path.join(sessionsDir, fileName(startedAt, A));
const fileB = path.join(sessionsDir, fileName(movedAt, B));
const firstTurn = [user("a0000001", null, startedAt + 1_000, "first question"), answer("a0000002", "a0000001", startedAt + 2_000, "first answer")];
write(fileA, [{ type: "session", version: 3, id: A, timestamp: new Date(startedAt).toISOString(), cwd }, ...firstTurn]);
// What omp writes when it moves a live session off a file another process holds: the whole
// transcript again under a new id, the old id in `parentSession` and `continuationOf`, and what
// happened after the move.
write(fileB, [
  { type: "session", version: 3, id: B, timestamp: new Date(movedAt).toISOString(), cwd, parentSession: A, continuationOf: A },
  ...firstTurn,
  user("b0000001", "a0000002", movedAt + 1_000, "second question, after the move"),
  answer("b0000002", "b0000001", movedAt + 2_000, "second answer, after the move"),
]);
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("Cody reads the continuation link omp writes into a session header", { skip }, async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { readSessionHeader } = await jiti.import("./session-reader.ts");
  assert.equal(readSessionHeader(fileA)?.continuationOf, undefined);
  assert.equal(readSessionHeader(fileB)?.continuationOf, A);
  assert.equal(readSessionHeader(fileB)?.parentSession, A);
});

test("resuming the old id of a continued chat carries everything filed under it to the id omp opens, and a second start finds the running chat", { skip, timeout: 120_000 }, async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { getRpcSession, startRpcSession } = await jiti.import("./rpc-manager.ts");
  const { setSessionOwner, getSessionOwner } = await jiti.import("./auth/session-owners.ts");
  const overlay = await jiti.import("./model-presets/overlay.ts");
  const routing = await jiti.import("./local-model-routing.ts");
  const { resolveDisplaySessionId } = await jiti.import("./display/bus.ts");
  const planOverlay = await jiti.import("./plan-keeper/overlay.ts");
  const schedule = await jiti.import("./scheduled/store.ts");
  const scratch = await jiti.import("./disk/scratch.ts");

  // A configured local model, so the chat can be Local-only; nothing ever calls it.
  writeFileSync(path.join(agentDir, "models.yml"), [
    "providers:",
    "  local:",
    "    baseUrl: http://127.0.0.1:9/v1",
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    "      - id: primary",
    "        contextWindow: 24576",
    "        maxTokens: 8192",
  ].join("\n"));
  routing.writeLocalRoutingConfig({ primary: { provider: "local", modelId: "primary" }, fallbacks: [], roles: {} });

  setSessionOwner(A, "account-1");
  overlay.setSessionPreset(A, "high");
  routing.setSessionLocalOnly(A, true);
  const checklist = { "Write the tests": [{ content: "cover the continuation", status: "pending" }] };
  planOverlay.writePlanOverlay(A, { subtasks: checklist, autoCompleted: [], labels: {}, folds: {}, updatedAt: 5 });
  const inserted = schedule.insertItem({ sessionId: A, accountKey: "", message: "carry on", mode: "at", dueAt: Date.now() + 3_600_000, source: "user" });
  assert.equal(inserted.ok, true);
  const before = sha(fileA);

  const { session, realSessionId } = await startRpcSession(A, fileA, cwd);
  try {
    if (!followsContinuations) {
      // omp before 18.13.2 never follows the link: the old file resumes as itself and nothing moves.
      assert.equal(realSessionId, A);
      assert.equal(session.sessionId, A);
      assert.equal(getRpcSession(A), session);
      assert.equal(schedule.listItemsForSession(A).length, 1, "nothing was moved off the chat that is still its own");
      return;
    }
    assert.equal(realSessionId, B, "omp opened the newest copy");
    assert.equal(session.sessionId, B);
    assert.equal(session.sessionFile, fileB);
    assert.equal(getRpcSession(B), session);
    assert.equal(getRpcSession(A), undefined, "a route that reads a file by the old id still sees the frozen original");
    assert.equal(sha(fileA), before, "the old file is left exactly as it was");

    for (const id of [A, B]) {
      assert.equal(getSessionOwner(id), "account-1");
      assert.equal(overlay.readSessionPresetId(id), "high");
      assert.equal(routing.isSessionLocalOnly(id), true, `Local-only follows the chat to ${id === B ? "the new" : "keeps it on the old"} id`);
    }
    assert.deepEqual(planOverlay.readPlanOverlay(B)?.subtasks, checklist);
    assert.deepEqual(schedule.listItemsForSession(A), [], "moved, never copied: both ids would send it");
    assert.deepEqual(schedule.listItemsForSession(B).map((item) => item.id), [inserted.item.id]);
    assert.equal(resolveDisplaySessionId(A), B);
    assert.equal(scratch.ensureSessionScratch(B), session.scratchDir);

    const again = await startRpcSession(A, fileA, cwd);
    assert.equal(again.session, session, "the old id reaches the running chat instead of opening a second child on the file it holds");
    assert.equal(again.realSessionId, B);
  } finally {
    await session.destroyAndWait();
  }
});
