import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

test("hermes is registered as an engine", async () => {
  const { listHarnesses, getHarnessById } = await jiti.import("./index.ts");
  const hermes = getHarnessById("hermes");
  assert.ok(hermes, "getHarnessById resolves hermes");
  assert.ok(listHarnesses().some((adapter) => adapter.id === "hermes"), "appears in the roster/picker");
  assert.equal(hermes.experimental, true, "must carry the experimental chip");
  assert.equal(hermes.binaryName, "hermes");
  // Driven over ACP, so it is a createSession engine — never an rpcUi one.
  assert.equal(typeof hermes.createSession, "function");
  assert.equal(hermes.rpcUi, undefined, "exactly one of createSession/rpcUi may be present");
});

test("capabilities claim only what is actually wired", async () => {
  const { getHarnessById } = await jiti.import("./index.ts");
  const { capabilities } = getHarnessById("hermes");
  // A capability set to true renders a surface; a wrong `true` renders a
  // BROKEN surface, which is the failure mode the flags exist to prevent.
  assert.equal(capabilities.liveSessions, true, "chat is the point of phase 1");
  // `updates` stays false deliberately: it gates the engine's OWN self-update
  // route and the session-restart control, both omp-specific. Cody installing
  // Hermes through uv is a separate thing, driven by installSpec/installVia.
  // nativeSettings is TRUE: the settings panel is derived from Hermes' own
  // DEFAULT_CONFIG, so it renders real settings that really write back.
  assert.equal(capabilities.nativeSettings, true);
  // memory is TRUE: Hermes maintains MEMORY.md and USER.md itself and the
  // adapter hands them back, so the surface shows something real.
  assert.equal(capabilities.memory, true);
  // skills is TRUE: discovery walks Hermes' own nested skills tree,
  // enable/disable writes `skills.disabled` through Hermes' config writer, and
  // install shells `hermes skills install` (lib/harness/hermes-skills.ts).
  assert.equal(capabilities.skills, true);
  for (const flag of ["models", "plugins", "mcp", "updates", "chatExtras", "fastMode", "advisor", "subagents"]) {
    assert.equal(capabilities[flag], false, `${flag} is not wired yet and must stay hidden`);
  }
});

test("the agent dir follows HERMES_HOME, else ~/.hermes", async () => {
  const { getHarnessById } = await jiti.import("./index.ts");
  const hermes = getHarnessById("hermes");
  const previous = process.env.HERMES_HOME;
  try {
    delete process.env.HERMES_HOME;
    assert.equal(hermes.getAgentDir(), path.join(os.homedir(), ".hermes"));
    process.env.HERMES_HOME = "/custom/hermes";
    assert.equal(hermes.getAgentDir(), "/custom/hermes");
    // Blank must not yield a bare relative path.
    process.env.HERMES_HOME = "   ";
    assert.equal(hermes.getAgentDir(), path.join(os.homedir(), ".hermes"));
  } finally {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
  }
});

test("creating a session without the binary fails with an actionable message", async () => {
  const { createHermesSession } = await jiti.import("./hermes.ts");
  const previous = process.env.CODY_HERMES_BIN;
  try {
    // Point the override at a path that cannot resolve, so the ladder fails.
    process.env.CODY_HERMES_BIN = path.join(os.tmpdir(), "cody-no-hermes-here-4f1a");
    assert.throws(
      () => createHermesSession({ sessionId: "", cwd: os.tmpdir() }),
      /hermes binary not found.*engine picker.*CODY_HERMES_BIN/s,
      "names both remedies rather than throwing ENOENT from spawn later",
    );
  } finally {
    if (previous === undefined) delete process.env.CODY_HERMES_BIN;
    else process.env.CODY_HERMES_BIN = previous;
  }
});

test("hermes installs from PyPI through uv, with the ACP extra", async () => {
  const { getHarnessById } = await jiti.import("./index.ts");
  const hermes = getHarnessById("hermes");
  assert.equal(hermes.installVia, "uv", "a Python package cannot come from npm");
  // The extra is load-bearing: without it `hermes acp` exits with
  // "ACP dependencies not installed" and the engine can never start.
  assert.equal(hermes.installSpec, "hermes-agent[acp]");
  // `hermes --version` prints a report including "Python: 3.11.15"; a
  // first-match scan would report the Python version as the engine's.
  assert.deepEqual(hermes.versionArgs, ["acp", "--version"]);
});

test("pypiNameFromSpec strips extras and pins for registry lookups", async () => {
  const { pypiNameFromSpec } = await jiti.import("./updates.ts");
  assert.equal(pypiNameFromSpec("hermes-agent[acp]"), "hermes-agent");
  assert.equal(pypiNameFromSpec("hermes-agent[acp]==0.19.0"), "hermes-agent");
  assert.equal(pypiNameFromSpec("hermes-agent==0.19.0"), "hermes-agent");
  assert.equal(pypiNameFromSpec("hermes-agent>=0.19"), "hermes-agent");
  assert.equal(pypiNameFromSpec("hermes-agent"), "hermes-agent");
});
