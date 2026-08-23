import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Which transport each engine rides, pinned.
 *
 * Cody has three: omp's `rpcUi` NDJSON dialect, ACP for the open standard, and
 * the per-turn `createSession` fallback for CLIs that offer nothing better.
 * An engine silently moved to the wrong one — or left on the old one during a
 * migration — is not a loud failure. It is a chat window that looks fine and
 * cannot approve a tool call, or an engine that spawns a process per turn
 * while claiming a persistent session.
 *
 * This runs with no binaries, no network and no credentials: it asserts the
 * WIRING. `engine-bringup.mjs` is the companion that spawns the real thing.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { listHarnesses, getHarnessById } = await jiti.import("./index.ts");
const { AcpEngineSession } = await jiti.import("./acp-session.ts");
const { invalidateEngineBinCache } = await jiti.import("./engine-bin.ts");

/** The end state phase 3 commits Cody to. Changing an entry here is a
 * deliberate architectural decision, not a refactor. */
const EXPECTED_TRANSPORT = {
  // omp keeps rpc-ui: over ACP it loses subagent telemetry and the host-tool
  // bridge (set_host_tools → open_preview, preview_screenshot, read_app_logs),
  // which is a real loss for the founding engine and buys nothing it does not
  // already have.
  omp: "rpcUi",
  // pi rides the same dialect and has nothing to gain by moving.
  pi: "rpcUi",
  // These three speak ACP, which is the only transport with a real approval
  // channel.
  claude: "acp",
  codex: "acp",
  hermes: "acp",
};

/**
 * Build a session and see what class comes back. Nothing is spawned:
 * AcpEngineSession and TurnEngineSession both defer the child to
 * start()/waitUntilReady().
 *
 * A stub binary is planted first because some adapters resolve their binary
 * eagerly and throw "not installed" from createSession. Without it this test
 * could only run on a machine with every engine installed — which is neither
 * CI nor a developer's laptop, and would make the one check that answers
 * "did the migration actually happen" the one nobody ever sees run.
 */
function transportOf(adapter) {
  if (adapter.rpcUi) return "rpcUi";
  if (typeof adapter.createSession !== "function") return "none";
  const dir = mkdtempSync(join(tmpdir(), "cody-transport-"));
  const stub = join(dir, adapter.binaryName);
  const envKey = `CODY_${adapter.id.toUpperCase()}_BIN`;
  const previous = process.env[envKey];
  try {
    writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env[envKey] = stub;
    invalidateEngineBinCache(adapter.binaryName);
    const session = adapter.createSession({ sessionId: "", cwd: dir });
    return session instanceof AcpEngineSession ? "acp" : "turn";
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
    invalidateEngineBinCache(adapter.binaryName);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every engine rides the transport Cody says it does", () => {
  // Every engine is checked before anything is asserted. A bare assert inside
  // the loop throws on the FIRST mismatch and hides the rest, which during a
  // migration is the difference between "one engine left to move" and "two"
  // — precisely the question being asked.
  const actual = {};
  for (const [id] of Object.entries(EXPECTED_TRANSPORT)) {
    const adapter = getHarnessById(id);
    assert.ok(adapter, `${id} is not a registered engine`);
    actual[id] = transportOf(adapter);
  }
  assert.deepEqual(actual, EXPECTED_TRANSPORT);
});

test("no engine declares two transports, or none", () => {
  // Exactly one of rpcUi / createSession — the seam's own rule. Both would
  // make which one runs depend on rpc-manager's dispatch order; neither
  // leaves an engine that cannot chat at all.
  for (const adapter of listHarnesses()) {
    const hasRpc = Boolean(adapter.rpcUi);
    const hasFactory = typeof adapter.createSession === "function";
    assert.ok(hasRpc !== hasFactory, `${adapter.id} must declare exactly one of rpcUi / createSession`);
  }
});

test("the registry holds no engine this test forgot", () => {
  // A new engine must state its transport here, or it ships unpinned.
  const registered = listHarnesses().map((adapter) => adapter.id).sort();
  assert.deepEqual(registered, Object.keys(EXPECTED_TRANSPORT).sort());
});

test("an ACP engine can actually be launched: spec, binary name and version probe", () => {
  for (const [id, expected] of Object.entries(EXPECTED_TRANSPORT)) {
    if (expected !== "acp") continue;
    const adapter = getHarnessById(id);
    // Cody must be able to install it, or the picker offers an engine the
    // user cannot get.
    assert.ok(adapter.installSpec, `${id} has no installSpec`);
    assert.ok(adapter.binaryName, `${id} has no binaryName`);
    // The version probe has to run the REAL entry point. Hermes is the
    // cautionary case: `hermes --version` succeeds whether or not the [acp]
    // extra is present, so a bare probe blesses an install that dies on every
    // turn.
    const probe = adapter.versionArgs ?? ["--version"];
    assert.ok(Array.isArray(probe) && probe.length > 0, `${id} has an empty version probe`);
  }
});

test("every engine declares the full capability set", () => {
  // A capability the UI checks but an engine never declares reads as
  // undefined — falsy, so the surface hides, but silently and by accident
  // rather than by decision. Every flag must be an explicit boolean.
  const flags = [
    "liveSessions", "models", "skills", "plugins", "mcp", "nativeSettings",
    "updates", "chatExtras", "fastMode", "advisor", "subagents", "memory",
  ];
  for (const adapter of listHarnesses()) {
    for (const flag of flags) {
      assert.equal(
        typeof adapter.capabilities[flag], "boolean",
        `${adapter.id} does not declare capabilities.${flag}`,
      );
    }
  }
});

test("an engine claiming memory can actually produce it", () => {
  // The flag means BOTH that memory exists and that Cody can read it back.
  // omp keeps memory and cannot, which is why it reports false: a surface
  // that renders empty is worse than one that stays hidden.
  for (const adapter of listHarnesses()) {
    if (!adapter.capabilities.memory) {
      assert.equal(adapter.readMemory, undefined, `${adapter.id} exposes readMemory without claiming the capability`);
      continue;
    }
    assert.equal(typeof adapter.readMemory, "function", `${adapter.id} claims memory but cannot read it`);
  }
});
