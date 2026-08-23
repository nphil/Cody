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

// An engine whose real entry point sits behind a subcommand is only verified
// by running THAT. Hermes is the live case: its ACP server ships as an
// optional extra, and `hermes --version` reports a healthy version whether or
// not the extra is installed — so verifying with a bare --version blesses an
// install whose every chat turn then dies.
test("a subcommand probe catches what a bare --version would bless", async () => {
  const bin = script("extras-missing", [
    'if [ "$1" = "acp" ]; then',
    '  echo "ACP dependencies not installed" >&2',
    '  exit 1',
    'fi',
    'echo "Hermes Agent v0.19.0 (2026.7.20)"',
    'echo "Python: 3.11.15"',
  ].join("\n"));

  // What the install route used to do: reports a healthy engine.
  assert.deepEqual(await probeEngineVersion(bin), { version: "0.19.0", error: null });

  // What it does now: the adapter's own versionArgs run the real entry point.
  const probed = await probeEngineVersion(bin, ["acp", "--version"]);
  assert.equal(probed.version, null);
  assert.match(probed.error, /ACP dependencies not installed/);
});

// An engine installed without its platform-native package fails with one
// useful sentence followed by a wall of stack frames. The length cap keeps the
// TAIL, so unfiltered it showed the frames and hid the sentence naming the fix.
test("a crash reports the sentence that names the fix, not its stack", async () => {
  const bin = script("native-missing", [
    'cat >&2 <<TRACE',
    'node:internal/modules/cjs/loader:1215',
    '  throw err;',
    '  ^',
    '',
    'Error: Missing optional dependency @openai/codex-linux-x64',
    `${"    at Module._resolveFilename (node:internal/modules/cjs/loader:1212:15)\\n".repeat(30).trimEnd()}`,
    'TRACE',
    'exit 1',
  ].join("\n"));

  const result = await probeEngineVersion(bin);
  assert.equal(result.version, null);
  assert.match(result.error, /Missing optional dependency @openai\/codex-linux-x64/);
  assert.ok(!/ {4}at /.test(result.error), `stack frames survived: ${result.error}`);
});

// One binary, two questions. An ACP adapter answers `--version` with its own
// package version and `--cli --version` with the version of the CLI it drives,
// and both are shown at once. Caching those against the binary NAME alone
// serves whichever answer landed first as though it were both — which reads as
// "Claude Code 0.70.0", the exact confusion the split labels exist to remove.
test("version probes cache per argv, and an install drops every one of them", async (t) => {
  const tools = mkdtempSync(join(tmpdir(), "cody-engine-version-cache-"));
  t.after(() => rmSync(tools, { recursive: true, force: true }));
  const bin = join(tools, "bin");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(bin, { recursive: true });
  // An adapter-shaped stub: bare --version is its own, `--cli --version` is
  // the CLI's, and the CLI's number is read out of the environment so the
  // "after an update" run can move it without rewriting the script.
  const file = join(bin, "split-engine");
  writeFileSync(file, '#!/bin/sh\nif [ "$1" = "--cli" ]; then echo "${STUB_CLI_VERSION:-2.1.238} (CLI)"; else echo "0.70.0"; fi\n');
  chmodSync(file, 0o755);

  const previousTools = process.env.CODY_TOOLS_DIR;
  process.env.CODY_TOOLS_DIR = tools;
  t.after(() => {
    if (previousTools === undefined) delete process.env.CODY_TOOLS_DIR;
    else process.env.CODY_TOOLS_DIR = previousTools;
  });

  const { getEngineVersion, invalidateEngineBinCache } = await jiti.import("./engine-bin.ts");
  invalidateEngineBinCache();

  assert.equal(await getEngineVersion("split-engine", "SPLIT"), "0.70.0");
  assert.equal(
    await getEngineVersion("split-engine", "SPLIT", ["--cli", "--version"], { STUB_CLI_VERSION: "2.1.238" }),
    "2.1.238",
    "the CLI probe must not be served the adapter's cached answer",
  );
  // Both are cached; the adapter's answer is unchanged by the second question.
  assert.equal(await getEngineVersion("split-engine", "SPLIT"), "0.70.0");

  // An update replaced the CLI. A cache HIT never expires, so nothing but the
  // install's own invalidation can dislodge it — and the install knows only
  // the primary binary's name, which is why it drops everything.
  invalidateEngineBinCache("split-engine");
  assert.equal(
    await getEngineVersion("split-engine", "SPLIT", ["--cli", "--version"], { STUB_CLI_VERSION: "2.1.241" }),
    "2.1.241",
    "the post-install invalidation must clear every argv's entry for that binary",
  );
});
