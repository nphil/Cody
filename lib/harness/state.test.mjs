import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

// Point the instance data dir (where cody-engine.json lives) at a fresh temp
// dir before the modules load, and clear anything that would move it: a named
// profile wins over PI_CODING_AGENT_DIR, and an ambient CODY_HARNESS would
// change what getHarness() falls back to.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cody-engine-test-"));
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;
delete process.env.CODY_HARNESS;
delete process.env.OMP_WEB_HARNESS;

const state = await jiti.import("./state.ts");
const harness = await jiti.import("./index.ts");

const statePath = state.getEngineStatePath();

test("a missing state file reads as empty and not onboarded", () => {
  state.clearEngineStateCache();
  assert.equal(existsSync(statePath), false);
  assert.deepEqual(state.readEngineState(), { version: 1, activeEngine: null, onboarded: false, updatedAt: "" });
  assert.equal(state.isEngineOnboarded(), false);
  // No file yet, so nothing overrides the env/default resolution.
  assert.equal(harness.getHarness().id, "omp");
});

test("writes round-trip through the file at 0600", () => {
  const written = state.writeEngineState({ activeEngine: "claude" });
  assert.equal(written.activeEngine, "claude");
  assert.equal(written.onboarded, false);
  assert.notEqual(written.updatedAt, "");

  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).activeEngine, "claude");

  state.clearEngineStateCache();
  const read = state.readEngineState();
  assert.equal(read.activeEngine, "claude");
  assert.equal(read.version, 1);
});

test("the onboarded flag persists without disturbing the selection", () => {
  state.clearEngineStateCache();
  assert.equal(state.isEngineOnboarded(), false);

  state.writeEngineState({ onboarded: true });
  state.clearEngineStateCache();
  const read = state.readEngineState();
  assert.equal(read.onboarded, true);
  assert.equal(read.activeEngine, "claude"); // partial write kept the engine
  assert.equal(state.isEngineOnboarded(), true);
});

test("a valid persisted engine beats CODY_HARNESS", () => {
  state.writeEngineState({ activeEngine: "codex" });
  state.clearEngineStateCache();
  process.env.CODY_HARNESS = "omp";
  try {
    assert.equal(harness.getHarness().id, "codex");
  } finally {
    delete process.env.CODY_HARNESS;
  }
});

test("an unknown persisted engine falls back instead of throwing", () => {
  // Hand-written file: writeEngineState is validated by callers, but a stale
  // state file from a build that knew more engines must not brick the server.
  writeFileSync(statePath, JSON.stringify({ version: 1, activeEngine: "ghost", onboarded: true }), { mode: 0o600 });
  state.clearEngineStateCache();
  assert.equal(state.readEngineState().activeEngine, "ghost");
  assert.equal(harness.getHarness().id, "omp");

  // …while an unknown env value still fails loudly.
  process.env.CODY_HARNESS = "nope";
  try {
    assert.throws(() => harness.getHarness(), /Unknown CODY_HARNESS "nope"/);
  } finally {
    delete process.env.CODY_HARNESS;
  }
});

test("selectHarness persists a known engine and rejects unknown ids", () => {
  state.clearEngineStateCache();
  assert.throws(() => harness.selectHarness("ghost"), /Unknown engine "ghost"/);
  assert.throws(() => harness.selectHarness(""), /Unknown engine/);

  const adapter = harness.selectHarness("CLAUDE "); // ids are normalized
  assert.equal(adapter.id, "claude");
  state.clearEngineStateCache();
  const read = state.readEngineState();
  assert.equal(read.activeEngine, "claude");
  assert.equal(read.onboarded, true); // selecting completes onboarding
  assert.equal(harness.getHarness().id, "claude");
});
