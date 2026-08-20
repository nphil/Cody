import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { probeEngineVersion } = await jiti.import("./engine-bin.ts");

// Real executables, spawned for real: what the helper has to tell apart is a
// binary npm installed cleanly from one that exits 0 at install time and then
// fails on every invocation, and only the process itself can say which it is.
const dir = mkdtempSync(join(tmpdir(), "cody-engine-bin-test-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** Throwaway CLI in the temp dir. mode 0o644 makes one that cannot be run. */
function script(name, body, mode = 0o755) {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, mode);
  return file;
}

test("a binary that prints a version is reported as working", async () => {
  const bin = script("good", 'echo "2.1.236 (Claude Code)"');
  assert.deepEqual(await probeEngineVersion(bin), { version: "2.1.236", error: null });
});

test("a warning on stderr does not beat a version on stdout", async () => {
  const bin = script("noisy", 'echo "npm notice: update available" >&2\necho "codex-cli 0.147.0"');
  assert.deepEqual(await probeEngineVersion(bin), { version: "0.147.0", error: null });
});

test("a failing binary reports its own diagnostic and no version", async () => {
  const bin = script("broken", 'echo "Error: claude native binary not installed." >&2\nexit 1');
  const result = await probeEngineVersion(bin);
  assert.equal(result.version, null);
  assert.match(result.error, /native binary not installed/);
});

// The upstream break this exists for names the missing package, version tag and
// all, in its failure message. Reading that number back as "installed version"
// would report the broken engine as healthy.
test("a version inside a failure message is not mistaken for the installed one", async () => {
  const bin = script("broken-versioned", 'echo "@anthropic-ai/claude-code-linux-x64@2.1.237 missing" >&2\nexit 1');
  const result = await probeEngineVersion(bin);
  assert.equal(result.version, null);
  assert.match(result.error, /2\.1\.237 missing/);
});

test("a binary that cannot be run resolves rather than throwing", async () => {
  const notExecutable = script("not-executable", 'echo "1.0.0"', 0o644);
  const missing = join(dir, "never-installed");
  const [denied, absent] = await Promise.all([
    probeEngineVersion(notExecutable),
    probeEngineVersion(missing),
  ]);
  assert.equal(denied.version, null);
  assert.match(denied.error, /EACCES|not executable|permission/i);
  assert.equal(absent.version, null);
  assert.match(absent.error, /ENOENT/);
});

// Silence is still a failure: the caller needs a sentence to show either way.
test("a silent success is a failed probe with an explanation", async () => {
  const bin = script("silent", "exit 0");
  const result = await probeEngineVersion(bin);
  assert.equal(result.version, null);
  assert.ok(result.error.length > 0);
});

test("a long diagnostic is truncated to its tail", async () => {
  const bin = script(
    "verbose",
    'i=0\nwhile [ $i -lt 400 ]; do printf "stack frame %s at somewhere " "$i" >&2; i=$((i+1)); done\nprintf "LAST-FRAME" >&2\nexit 1',
  );
  const result = await probeEngineVersion(bin);
  assert.equal(result.version, null);
  // 400 characters plus the leading ellipsis that marks the cut.
  assert.ok(result.error.length <= 401, `error kept ${result.error.length} characters`);
  assert.ok(result.error.startsWith("…"));
  assert.ok(result.error.endsWith("LAST-FRAME"));
});
