import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { createFakeOmpPackage } from "../omp/fixtures/claude-credits/fake-omp-package.mjs";

/**
 * The Node side of bin/cody-omp-claude-credits.mjs: how a Claude API key reaches the Bun child
 * and what is allowed to come back.
 *
 * A key in an argument list is readable by every process on the machine, so it travels on STDIN.
 * Nothing that returns may carry one: the helper answers with a row id, the credits provider the
 * key lives under (`anthropic-api`, `anthropic-api-2`, … one per key) and the last four
 * characters. And a helper that misbehaves — prints garbage, dies early, answers the wrong
 * question — must read as "unavailable", never as a throw that takes the request down with it.
 * The helper here is a small recording script, run by node; the REAL helper's request handling is
 * checked at the end, and its dealings with a real AuthStorage are in
 * lib/omp/claude-credits-omp.test.mjs.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "cody-claude-keys-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "CODY_PACKAGE_DIR", "PI_CONFIG_FILES", "CODY_OMP_BIN", "CODY_BUN_BIN", "OMP_WEB_BUN_BIN", "HOME", "OMP_PROFILE", "PI_PROFILE", "CLAUDE_HELPER_MODE", "CLAUDE_HELPER_LOG"].map((key) => [key, process.env[key]]));
const agentDir = path.join(scratch, "agent");
mkdirSync(agentDir, { recursive: true });
const fakeOmp = createFakeOmpPackage(scratch);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_PACKAGE_DIR = repoRoot;
process.env.PI_CONFIG_FILES = "";
process.env.CODY_OMP_BIN = fakeOmp.bin;
process.env.HOME = scratch;
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;
delete process.env.CODY_BUN_BIN;
delete process.env.OMP_WEB_BUN_BIN;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { addClaudeApiKey, listClaudeApiKeys } = await jiti.import("./omp-claude-credits.ts");
const { invalidateOmpCliCache } = await jiti.import("../omp/omp-cli.ts");

test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  invalidateOmpCliCache();
  rmSync(scratch, { recursive: true, force: true });
});

// Obviously fake, and long enough to be told apart from anything else in a process listing.
const KEY = "sk-ant-api03-FAKE-wrapper-key-0001";
const LOG = path.join(scratch, "helper-log.jsonl");

/**
 * What a stand-in helper does, by mode. One script serves every case: it records what it was
 * given (arguments, the command line as the kernel shows it to other processes, stdin, whether
 * the key is in its environment) and then answers as the mode says. No backticks or template
 * holes in here: the text is embedded in a template literal.
 */
const HELPER = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
const mode = process.env.CLAUDE_HELPER_MODE ?? "ok";
// A helper that dies before it has read a byte.
if (mode === "early-exit") process.exit(1);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let request = null;
try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
let cmdline = null;
try { cmdline = readFileSync("/proc/self/cmdline", "utf8").split("\0"); } catch {}
const key = typeof request?.key === "string" ? request.key : null;
if (process.env.CLAUDE_HELPER_LOG) {
  appendFileSync(process.env.CLAUDE_HELPER_LOG, JSON.stringify({
    argv: process.argv,
    cmdline,
    request,
    keyInEnv: key ? Object.values(process.env).some((value) => String(value).includes(key)) : null,
  }) + "\n");
}
const operation = request?.operation;
const asked = request?.provider ?? "anthropic-api";
const emit = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
const last4 = key ? key.slice(-4) : "none";
if (mode === "stderr-secret") process.stderr.write("storing " + key + " failed in the middle\n");
switch (mode) {
  case "ok":
  case "stderr-secret":
    emit(operation === "add" ? { type: "add", ok: true, id: 7, last4, provider: asked } : { type: "list", ok: true, keys: [{ id: 3, last4: "0001", provider: "anthropic-api" }, { id: 5, last4: "0002", provider: "anthropic-api-2" }] });
    break;
  case "held-elsewhere":
    // The key text is already stored under ANOTHER credits provider: the answer names that row.
    emit({ type: "add", ok: true, id: 3, last4, provider: "anthropic-api-3" });
    break;
  case "leaky":
    // A helper that answers with more than it should: the wrapper must hand on only what it asked for.
    emit(operation === "add"
      ? { type: "add", ok: true, id: 7, last4, provider: asked, key, apiKey: key, token: "sk-ant-oat01-FAKE-leaked-token", extra: { nested: key } }
      : { type: "list", ok: true, secret: "sk-ant-api03-FAKE-leaked-secret", keys: [{ id: 3, last4: "0001", provider: "anthropic-api", key: "sk-ant-api03-FAKE-first-0001" }, { id: 5, last4: "0002", provider: "anthropic-api-2", apiKey: "sk-ant-api03-FAKE-second-0002", credential: { key: "x" } }] });
    break;
  case "mixed-rows":
    emit({ type: "list", ok: true, keys: [
      { id: 3, last4: " 0001 ", provider: " anthropic-api " }, { id: "4", last4: "0004", provider: "anthropic-api" }, { id: 1.5, last4: "0005", provider: "anthropic-api" },
      { id: 6, provider: "anthropic-api" }, { id: 7, last4: "", provider: "anthropic-api" }, { last4: "0008", provider: "anthropic-api" },
      null, "junk", 12, [], { id: 9007199254740993, last4: "0009", provider: "anthropic-api" }, { id: 10, last4: "0010", provider: "anthropic-api-2" },
      // Providers that are not the credits': the plans' own pool, one past the ceiling, a first slot spelled with a number, none, not text.
      { id: 11, last4: "0011", provider: "anthropic" }, { id: 12, last4: "0012", provider: "anthropic-api-9" }, { id: 13, last4: "0013", provider: "anthropic-api-1" },
      { id: 14, last4: "0014" }, { id: 15, last4: "0015", provider: 5 },
    ] });
    break;
  case "empty-list": emit({ type: "list", ok: true, keys: [] }); break;
  case "garbage": emit("this is not a frame {"); break;
  case "partial": emit('{"type":"list","ok":true,"keys":[{"id":3,'); break;
  case "silent": break;
  case "array": emit("[1,2,3]"); break;
  case "noise-first": emit("loading omp...\n" + JSON.stringify(operation === "add" ? { type: "add", ok: true, id: 7, last4, provider: asked } : { type: "list", ok: true, keys: [] })); break;
  case "wrong-type": emit(operation === "add" ? { type: "list", ok: true, keys: [] } : { type: "add", ok: true, id: 7, last4: "0001", provider: "anthropic-api" }); break;
  case "refused": emit({ type: operation, ok: false, code: "credential_add_failed", message: "omp did not keep the key." }); break;
  case "refused-bare": emit({ type: operation, ok: false }); break;
  case "no-id": emit({ type: "add", ok: true, last4, provider: asked }); break;
  case "bad-id": emit({ type: "add", ok: true, id: "7", last4, provider: asked }); break;
  case "fractional-id": emit({ type: "add", ok: true, id: 7.5, last4, provider: asked }); break;
  case "no-last4": emit({ type: "add", ok: true, id: 7, last4: "  ", provider: asked }); break;
  case "no-provider": emit({ type: "add", ok: true, id: 7, last4 }); break;
  case "plan-provider": emit({ type: "add", ok: true, id: 7, last4, provider: "anthropic" }); break;
  case "past-the-ceiling": emit({ type: "add", ok: true, id: 7, last4, provider: "anthropic-api-9" }); break;
  case "flood": process.stdout.write("x".repeat(300 * 1024)); break;
  default: emit({ type: "error", ok: false, code: "invalid_request", message: "Unknown mode " + mode });
}
`;

const packageDir = path.join(scratch, "package");
mkdirSync(path.join(packageDir, "bin"), { recursive: true });
const helperPath = path.join(packageDir, "bin", "cody-omp-claude-credits.mjs");
writeFileSync(helperPath, HELPER);

const deps = (extra = {}) => ({ helperPath, bunBin: process.execPath, packageRoot: () => path.join(scratch, "omp-package"), agentDir: () => agentDir, ...extra });

/** Run one wrapper call with the stand-in helper in `mode`. */
async function withMode(mode, action) {
  process.env.CLAUDE_HELPER_MODE = mode;
  try {
    return await action();
  } finally {
    delete process.env.CLAUDE_HELPER_MODE;
  }
}
const calls = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
process.env.CLAUDE_HELPER_LOG = LOG;
beforeEach(() => rmSync(LOG, { force: true }));

// ── Where the key goes ───────────────────────────────────────────────────────

// Spelled out: the ids a request names are part of the contract with the helper and with omp.
const FAMILY = ["anthropic-api", "anthropic-api-2", "anthropic-api-3", "anthropic-api-4", "anthropic-api-5", "anthropic-api-6", "anthropic-api-7", "anthropic-api-8"];

test("the key reaches the helper on stdin, and appears nowhere a process listing, an argument or the environment could show it", async () => {
  const result = await withMode("ok", () => addClaudeApiKey(KEY, "anthropic-api", deps()));
  assert.deepEqual(result, { ok: true, id: 7, last4: "0001", provider: "anthropic-api" });

  const [call, ...rest] = calls();
  assert.deepEqual(rest, [], "one helper run");
  assert.deepEqual(call.request, { operation: "add", packageRoot: path.join(scratch, "omp-package"), agentDir, providers: FAMILY, key: KEY, provider: "anthropic-api" }, "the request, key included, arrived on stdin");
  assert.deepEqual(call.argv, [process.execPath, helperPath], "the helper is given its script and nothing else");
  assert.ok(!JSON.stringify(call.argv).includes(KEY.slice("sk-ant-api03-".length)), "no argument carries the key, or a piece of it");
  assert.equal(call.keyInEnv, false, "the key is not in the child's environment either");
  if (process.platform === "linux") {
    assert.ok(Array.isArray(call.cmdline), "the kernel's view of the command line was read");
    assert.ok(!call.cmdline.join(" ").includes(KEY.slice("sk-ant-api03-".length)), "nothing a `ps` would print holds the key");
  }
});

test("each key is stored under the provider it is asked for, and the answer names the provider that holds it", async () => {
  const second = await withMode("ok", () => addClaudeApiKey(KEY, "anthropic-api-2", deps()));
  assert.deepEqual(second, { ok: true, id: 7, last4: "0001", provider: "anthropic-api-2" });
  assert.equal(calls()[0].request.provider, "anthropic-api-2");
  // A key omp already holds under another credits provider is not stored twice: the answer is THAT row.
  const held = await withMode("held-elsewhere", () => addClaudeApiKey(KEY, "anthropic-api-2", deps()));
  assert.deepEqual(held, { ok: true, id: 3, last4: "0001", provider: "anthropic-api-3" });
});

test("a list request carries no key at all, and names only the credits providers to look under", async () => {
  const result = await withMode("ok", () => listClaudeApiKeys(deps()));
  assert.deepEqual(result, { available: true, keys: [{ id: 3, last4: "0001", provider: "anthropic-api" }, { id: 5, last4: "0002", provider: "anthropic-api-2" }] });
  assert.deepEqual(calls().map((call) => call.request), [{ operation: "list", packageRoot: path.join(scratch, "omp-package"), agentDir, providers: FAMILY }]);
  assert.ok(!FAMILY.includes("anthropic"), "never the plans' own pool");
});

test("without explicit dependencies it asks omp where it lives and the instance where its data is", async () => {
  // CODY_OMP_BIN names the fake package: the helper is told that package and this agent dir.
  const result = await withMode("ok", () => listClaudeApiKeys({ helperPath, bunBin: process.execPath }));
  assert.equal(result.available, true);
  assert.deepEqual(calls().map((call) => call.request), [{ operation: "list", packageRoot: realpathSync(fakeOmp.root), agentDir, providers: FAMILY }]);
});

test("the helper is found at bin/cody-omp-claude-credits.mjs under the package directory", async () => {
  const previous = process.env.CODY_PACKAGE_DIR;
  process.env.CODY_PACKAGE_DIR = packageDir;
  try {
    const result = await withMode("ok", () => listClaudeApiKeys({ bunBin: process.execPath, packageRoot: () => "/unused", agentDir: () => agentDir }));
    assert.equal(result.available, true);
    assert.deepEqual(calls().map((call) => call.argv[1]), [helperPath]);
  } finally {
    process.env.CODY_PACKAGE_DIR = previous;
  }
  assert.ok(existsSync(path.join(repoRoot, "bin", "cody-omp-claude-credits.mjs")), "and the real package ships one");
});

// ── What comes back ──────────────────────────────────────────────────────────

test("only a row id, a provider and the last four characters come back, however much more the helper says", async () => {
  const added = await withMode("leaky", () => addClaudeApiKey(KEY, "anthropic-api-2", deps()));
  assert.deepEqual(added, { ok: true, id: 7, last4: "0001", provider: "anthropic-api-2" });
  assert.deepEqual(Object.keys(added).sort(), ["id", "last4", "ok", "provider"]);
  assert.ok(!JSON.stringify(added).includes("FAKE"), "nothing of the key or the leaked token");

  const listed = await withMode("leaky", () => listClaudeApiKeys(deps()));
  assert.deepEqual(listed, { available: true, keys: [{ id: 3, last4: "0001", provider: "anthropic-api" }, { id: 5, last4: "0002", provider: "anthropic-api-2" }] });
  for (const row of listed.keys) assert.deepEqual(Object.keys(row).sort(), ["id", "last4", "provider"]);
  assert.ok(!JSON.stringify(listed).includes("FAKE"));
});

test("what the helper writes to stderr is drained, never returned and never fatal", async () => {
  const result = await withMode("stderr-secret", () => addClaudeApiKey(KEY, "anthropic-api", deps()));
  assert.deepEqual(result, { ok: true, id: 7, last4: "0001", provider: "anthropic-api" });
  assert.ok(!JSON.stringify(result).includes("storing"));
});

test("a list keeps the well-formed rows under a credits provider and drops the rest, whitespace trimmed", async () => {
  const result = await withMode("mixed-rows", () => listClaudeApiKeys(deps()));
  // Dropped: bad ids, no last four, junk rows, and every row under a provider that is not one of the credits'
  // (the plans' own pool, one past the ceiling, `anthropic-api-1`, none, not text).
  assert.deepEqual(result, { available: true, keys: [{ id: 3, last4: "0001", provider: "anthropic-api" }, { id: 10, last4: "0010", provider: "anthropic-api-2" }] });
});

test("an empty list is an answer — omp holds no keys — and not the same as no answer", async () => {
  assert.deepEqual(await withMode("empty-list", () => listClaudeApiKeys(deps())), { available: true, keys: [] });
  assert.equal((await withMode("silent", () => listClaudeApiKeys(deps()))).available, false);
});

// ── A helper that misbehaves ─────────────────────────────────────────────────

test("a helper that prints garbage, half a frame, nothing, noise before the frame or a non-frame is unavailable, never a throw", async () => {
  for (const mode of ["garbage", "partial", "silent", "array", "noise-first", "wrong-type", "early-exit", "flood"]) {
    const listed = await withMode(mode, () => listClaudeApiKeys(deps()));
    assert.deepEqual(listed, { available: false, keys: [], reason: "The key helper did not answer." }, mode);

    const added = await withMode(mode, () => addClaudeApiKey(KEY, "anthropic-api", deps()));
    assert.equal(added.ok, false, mode);
    assert.equal(added.code, "inconclusive", mode);
    assert.match(added.message, /did not answer; check the list before trying again/, mode);
    assert.ok(!JSON.stringify(added).includes(KEY), `${mode}: nothing echoes the key`);
  }
});

test("a helper that exits without reading its stdin cannot crash the server, whatever the request weighs", async () => {
  // 4 MiB cannot fit in a pipe nobody reads: the write fails with EPIPE, which must stay a quiet no-answer.
  const added = await withMode("early-exit", () => addClaudeApiKey("sk-ant-api03-" + "A".repeat(4 * 1024 * 1024), "anthropic-api", deps()));
  assert.deepEqual([added.ok, added.code], [false, "inconclusive"]);
  const listed = await withMode("early-exit", () => listClaudeApiKeys(deps()));
  assert.equal(listed.available, false);
});

test("a refusal is passed on with the helper's own words, and a bare refusal gets plain ones", async () => {
  const refused = await withMode("refused", () => addClaudeApiKey(KEY, "anthropic-api", deps()));
  assert.deepEqual(refused, { ok: false, code: "credential_add_failed", message: "omp did not keep the key." });
  const bare = await withMode("refused-bare", () => addClaudeApiKey(KEY, "anthropic-api-2", deps()));
  assert.deepEqual(bare, { ok: false, code: "credential_add_failed", message: "The key could not be stored." });

  const listRefused = await withMode("refused", () => listClaudeApiKeys(deps()));
  assert.deepEqual(listRefused, { available: false, keys: [], reason: "omp did not keep the key." });
  const listBare = await withMode("refused-bare", () => listClaudeApiKeys(deps()));
  assert.deepEqual(listBare, { available: false, keys: [], reason: "The key list is unavailable." });
});

test("an add that succeeds without a usable row id, last four or credits provider is inconclusive, not saved", async () => {
  // The provider is what Cody files the pairing under: an answer that names none, the plans' own pool or a slot past the ceiling cannot be saved.
  for (const mode of ["no-id", "bad-id", "fractional-id", "no-last4", "no-provider", "plan-provider", "past-the-ceiling"]) {
    const result = await withMode(mode, () => addClaudeApiKey(KEY, "anthropic-api", deps()));
    assert.deepEqual([result.ok, result.code], [false, "inconclusive"], mode);
    assert.match(result.message, /without a row id/, mode);
    assert.ok(!JSON.stringify(result).includes(KEY), `${mode}: nothing echoes the key`);
  }
});

test("a helper that is not there, or cannot be started, is unavailable too", async () => {
  const noScript = await listClaudeApiKeys(deps({ helperPath: path.join(scratch, "missing-helper.mjs") }));
  assert.deepEqual(noScript, { available: false, keys: [], reason: "The key helper did not answer." });
  const noBun = await addClaudeApiKey(KEY, "anthropic-api", deps({ bunBin: path.join(scratch, "no-such-bun") }));
  assert.deepEqual([noBun.ok, noBun.code], [false, "inconclusive"]);
  assert.deepEqual(calls(), [], "neither ran anything");
});

test("with no omp to talk to, nothing is started and the reason says so", async () => {
  const saved = process.env.CODY_OMP_BIN;
  try {
    // No binary at all.
    process.env.CODY_OMP_BIN = path.join(scratch, "no-omp-here");
    invalidateOmpCliCache();
    const bare = { helperPath, bunBin: process.execPath, agentDir: () => agentDir };
    assert.deepEqual(await listClaudeApiKeys(bare), { available: false, keys: [], reason: "OMP runtime is not installed." });
    const added = await addClaudeApiKey(KEY, "anthropic-api", bare);
    assert.deepEqual(added, { ok: false, code: "unsupported", message: "OMP runtime is not installed." });

    // A binary that does not belong to an omp package: the credential modules cannot be found.
    mkdirSync(path.join(scratch, "loose"), { recursive: true });
    const loose = path.join(scratch, "loose", "omp");
    writeFileSync(loose, "#!/bin/sh\n");
    process.env.CODY_OMP_BIN = loose;
    invalidateOmpCliCache();
    const unsupported = await listClaudeApiKeys(bare);
    assert.equal(unsupported.available, false);
    assert.match(unsupported.reason, /package source is unavailable/);
    assert.equal((await addClaudeApiKey(KEY, "anthropic-api", bare)).code, "unsupported");
    assert.deepEqual(calls(), [], "no helper was started");
  } finally {
    process.env.CODY_OMP_BIN = saved;
    invalidateOmpCliCache();
  }
});

// ── The real helper's own request handling (no omp needed) ───────────────────

const realHelper = path.join(repoRoot, "bin", "cody-omp-claude-credits.mjs");
function runReal(stdin) {
  const result = spawnSync(process.execPath, [realHelper], { input: stdin, encoding: "utf8", timeout: 30_000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
  return { frame: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr, status: result.status };
}

const request = (extra) => JSON.stringify({ packageRoot: "/x", agentDir, providers: FAMILY, ...extra });

test("the real helper refuses what it was not asked in the shape it understands, and answers in frames", () => {
  // Removal is deliberately not here: it goes through the credential helper, which also purges the soft-deleted row.
  for (const bad of ["", "not json", "[]", request({ operation: "remove" }), request({ operation: "list", packageRoot: undefined }), request({ operation: "list", agentDir: 5 })]) {
    const { frame, status } = runReal(bad);
    assert.deepEqual(frame, { type: "error", ok: false, code: "invalid_request", message: "Malformed request." }, JSON.stringify(bad));
    assert.equal(status, 1);
  }
  const keyless = runReal(request({ operation: "add", provider: "anthropic-api" }));
  assert.deepEqual(keyless.frame, { type: "add", ok: false, code: "invalid_request", message: "A key is required." });
  const empty = runReal(request({ operation: "add", provider: "anthropic-api", key: "" }));
  assert.deepEqual(empty.frame, { type: "add", ok: false, code: "invalid_request", message: "A key is required." });
  assert.equal(empty.status, 1);
});

test("the real helper only ever looks at the credits providers: a request that names the plans' pool, a slot past the ceiling or nothing is refused whole", () => {
  for (const providers of [
    undefined, // the providers are part of EVERY request
    [],
    "anthropic-api", // a name, not a list
    ["anthropic"], // the plans' own pool: an API key there would be dead weight
    ["anthropic-api", "anthropic"], // one foreign name poisons the whole request
    ["anthropic-api-9"], // one past the ceiling
    ["anthropic-api-1"], // the first slot is spelled without a number
    ["anthropic-api-10"],
    ["anthropic-apix"],
    ["openai-codex"],
    [5],
    [null],
    ["anthropic-api", ""],
  ]) {
    for (const extra of [{ operation: "list" }, { operation: "add", key: KEY, provider: "anthropic-api" }]) {
      const { frame, status } = runReal(request({ ...extra, providers }));
      assert.deepEqual(frame, { type: "error", ok: false, code: "invalid_request", message: "Malformed request." }, `${JSON.stringify(providers)} ${extra.operation}`);
      assert.equal(status, 1);
      assert.ok(!JSON.stringify(frame).includes(KEY));
    }
  }
  // An add must name one of the providers the request lists: the key is never filed anywhere the caller did not name.
  for (const provider of [undefined, "anthropic", "anthropic-api-2", "anthropic-api-9", 3]) {
    const { frame, status } = runReal(request({ operation: "add", key: KEY, providers: ["anthropic-api"], provider }));
    assert.deepEqual(frame, { type: "add", ok: false, code: "invalid_request", message: "A credits provider is required." }, String(provider));
    assert.equal(status, 1);
  }
});

test("the real helper, pointed at an omp it cannot load, says so without echoing the key — and the wrapper reports it", async () => {
  const emptyPackage = path.join(scratch, "not-omp");
  mkdirSync(emptyPackage, { recursive: true });
  writeFileSync(path.join(emptyPackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));

  const direct = runReal(request({ operation: "add", packageRoot: emptyPackage, key: KEY, provider: "anthropic-api-2" }));
  assert.deepEqual(direct.frame, { type: "add", ok: false, code: "unsupported", message: "OMP's installed credential modules are unavailable." });
  assert.ok(!direct.stderr.includes(KEY) && !JSON.stringify(direct.frame).includes(KEY));

  const real = { helperPath: realHelper, bunBin: process.execPath, packageRoot: () => emptyPackage, agentDir: () => agentDir };
  assert.deepEqual(await listClaudeApiKeys(real), { available: false, keys: [], reason: "OMP's installed credential modules are unavailable." });
  assert.deepEqual(await addClaudeApiKey(KEY, "anthropic-api-2", real), { ok: false, code: "unsupported", message: "OMP's installed credential modules are unavailable." });
});
