import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createJiti } from "jiti";

/**
 * Claude Code's adapter, pinned where getting it wrong is silent.
 *
 * The engine is TWO packages — the ACP adapter Cody drives and the `claude`
 * CLI the adapter drives — deliberately kept to one copy of the ~309 MB native
 * binary. Every assertion here is a load-bearing half of that arrangement: drop
 * one and the failure is an engine that installs cleanly, reports a healthy
 * version, and dies on the first chat turn.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

test("claude is registered and rides ACP", async () => {
  const { listHarnesses, getHarnessById } = await jiti.import("./index.ts");
  const claude = getHarnessById("claude");
  assert.ok(claude, "getHarnessById resolves claude");
  assert.ok(listHarnesses().some((adapter) => adapter.id === "claude"), "appears in the roster/picker");
  assert.equal(claude.experimental, true, "must carry the experimental chip");
  // The ACP adapter, not `claude`: it is what Cody installs and probes for.
  assert.equal(claude.binaryName, "claude-agent-acp");
  assert.equal(typeof claude.createSession, "function");
  assert.equal(claude.rpcUi, undefined, "exactly one of createSession/rpcUi may be present");
});

test("the install keeps ONE copy of the native CLI", async () => {
  const { getHarnessById } = await jiti.import("./index.ts");
  const claude = getHarnessById("claude");
  // The adapter is the package the update check compares with the registry.
  assert.equal(claude.installSpec, "@agentclientprotocol/claude-agent-acp@latest");
  // It bundles its own ~309 MB Claude CLI as a platform-gated optional
  // dependency. Cody skips that and installs the CLI it owns beside it — two
  // copies of the same native binary in one tools prefix is the disk
  // exhaustion the guards in install.ts exist for.
  assert.equal(claude.skipNativeOptional, true);
  assert.deepEqual(claude.installAlso, ["@anthropic-ai/claude-code@latest"]);
  // `@latest` on BOTH: every install is the update path, so the two halves of
  // the engine move together and neither can go stale on its own.
  for (const spec of [claude.installSpec, ...claude.installAlso]) {
    assert.match(spec, /@latest$/, `${spec} must be pinned @latest`);
  }
});

test("the health probe runs the CLI, not just the adapter", async () => {
  const { getHarnessById } = await jiti.import("./index.ts");
  const claude = getHarnessById("claude");
  // Bare --version is answered from the adapter's own package.json before it
  // looks at Claude at all, so it reports a healthy adapter with no CLI
  // underneath — which is exactly what skipNativeOptional creates on purpose
  // and what a failed companion install leaves behind by accident.
  assert.equal(claude.versionArgs, undefined, "the version probe is a bare --version: it must match installSpec");
  assert.deepEqual(claude.healthArgs, ["--cli", "--version"]);
  // Run bare, the adapter is a JSON-RPC server that would read a terminal's
  // keystrokes as protocol frames.
  assert.deepEqual(claude.cliArgs, ["--cli"]);
});

test("engineEnv points the adapter at Cody's CLI, and never at one the operator chose", async (t) => {
  const { getHarnessById } = await jiti.import("./index.ts");
  const { invalidateEngineBinCache } = await jiti.import("./engine-bin.ts");
  const claude = getHarnessById("claude");

  const dir = mkdtempSync(path.join(os.tmpdir(), "cody-claude-env-"));
  const cli = path.join(dir, "claude");
  writeFileSync(cli, "#!/bin/sh\n");
  const previousOverride = process.env.CODY_CLAUDE_CLI_BIN;
  const previousExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
  t.after(() => {
    if (previousOverride === undefined) delete process.env.CODY_CLAUDE_CLI_BIN;
    else process.env.CODY_CLAUDE_CLI_BIN = previousOverride;
    if (previousExecutable === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
    else process.env.CLAUDE_CODE_EXECUTABLE = previousExecutable;
    invalidateEngineBinCache("claude");
  });

  delete process.env.CLAUDE_CODE_EXECUTABLE;
  process.env.CODY_CLAUDE_CLI_BIN = cli;
  invalidateEngineBinCache("claude");
  assert.deepEqual(claude.engineEnv(), { CLAUDE_CODE_EXECUTABLE: cli });

  // An operator who exported the variable has chosen a CLI. Cody substituting
  // its own would be the hardest kind of bug to see: everything keeps working,
  // against the wrong binary.
  process.env.CLAUDE_CODE_EXECUTABLE = "/opt/somewhere/claude";
  assert.deepEqual(claude.engineEnv(), {}, "a deliberate export is never overruled");

  // No CLI anywhere is not a crash: the adapter reports its own missing-binary
  // error, which the ACP client surfaces as a notice.
  delete process.env.CLAUDE_CODE_EXECUTABLE;
  process.env.CODY_CLAUDE_CLI_BIN = path.join(dir, "absent");
  invalidateEngineBinCache("claude");
  assert.deepEqual(claude.engineEnv(), {});
});

test("capabilities claim only what is actually wired", async () => {
  const { getHarnessById } = await jiti.import("./index.ts");
  const { capabilities } = getHarnessById("claude");
  // A capability set to true renders a surface; a wrong `true` renders a
  // BROKEN surface, which is the failure mode the flags exist to prevent.
  // Moving to ACP brings a real approval channel, loadSession, thinking and
  // plan updates — none of which is a flag, because none of them gates a
  // surface. The flags that ARE false stay false because the surfaces they
  // gate are still built against omp's shapes.
  assert.equal(capabilities.liveSessions, true);
  for (const flag of ["models", "skills", "plugins", "mcp", "nativeSettings", "updates", "chatExtras", "fastMode", "advisor", "subagents", "memory"]) {
    assert.equal(capabilities[flag], false, `${flag} is not wired and must stay hidden`);
  }
});

test("creating a session without the adapter fails with an actionable message", async (t) => {
  const { createClaudeSession } = await jiti.import("./claude.ts");
  const { invalidateEngineBinCache } = await jiti.import("./engine-bin.ts");
  const previous = process.env.CODY_CLAUDE_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.CODY_CLAUDE_BIN;
    else process.env.CODY_CLAUDE_BIN = previous;
    invalidateEngineBinCache("claude-agent-acp");
  });
  process.env.CODY_CLAUDE_BIN = path.join(os.tmpdir(), "definitely-not-installed-claude-agent-acp");
  invalidateEngineBinCache("claude-agent-acp");
  assert.throws(
    () => createClaudeSession({ sessionId: "", cwd: process.cwd() }),
    /claude-agent-acp binary not found.*engine picker.*CODY_CLAUDE_BIN/s,
  );
});
