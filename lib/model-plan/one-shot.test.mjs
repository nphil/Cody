import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { runOneShotModel, runOneShotModelStreaming } = await jiti.import("./one-shot.ts");

const test = process.platform === "win32"
  ? (name, fn) => nodeTest(name, { skip: "POSIX omp fixture is not runnable on Windows" }, fn)
  : nodeTest;

/** A fake omp that records the argv/cwd/env it was handed and replays NDJSON frames. */
function fakeOmp(dir, { frames = [], exitCode = 0, envKeys = [] } = {}) {
  const infoLog = join(dir, "info.json");
  const bin = join(dir, "omp");
  const body = frames.map((frame) => JSON.stringify(frame)).join("\n");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    `const envKeys = ${JSON.stringify(envKeys)};`,
    "const env = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));",
    `require("fs").writeFileSync(${JSON.stringify(infoLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }));`,
    `process.stdout.write(${JSON.stringify(body ? `${body}\n` : "")});`,
    `process.exit(${exitCode});`,
  ].join("\n"));
  chmodSync(bin, 0o755);
  const readInfo = () => JSON.parse(readFileSync(infoLog, "utf8"));
  return { bin, readInfo, readArgv: () => readInfo().argv };
}

const assistantTurn = (text) => ({
  type: "turn_end",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const toolStart = (toolCallId, toolName, args) => ({ type: "tool_execution_start", toolCallId, toolName, args });
const toolEnd = (toolCallId, toolName, result, isError = false) => ({
  type: "tool_execution_end",
  toolCallId,
  toolName,
  result,
  isError,
});

test("every value flag uses the joined form omp actually parses", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-one-shot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const omp = fakeOmp(dir, { frames: [assistantTurn("Proxmox backup script")] });

  const result = await runOneShotModel({
    bin: omp.bin,
    model: "anthropic/claude-haiku-4-5",
    systemPrompt: "You name things.",
    prompt: "name this",
  });
  assert.equal(result.text, "Proxmox backup script");

  const argv = omp.readArgv();
  // This is the whole point of the test. omp takes ONLY `--flag=value` for a
  // value flag: handed as two argv entries the flag is silently ignored — no
  // parse error, no warning, no clue at the call site. Measured against omp
  // 18, the space form meant the config overlay never loaded and
  // --system-prompt never applied, so the model answered the prompt as an
  // ordinary coding request instead of doing the job it was given.
  for (const flag of ["--config", "--system-prompt", "--model"]) {
    assert.ok(
      argv.some((entry) => entry.startsWith(`${flag}=`)),
      `${flag} must be passed as ${flag}=value; got ${JSON.stringify(argv)}`,
    );
    assert.ok(
      !argv.includes(flag),
      `${flag} appears bare, so its value is a separate argv entry and omp will ignore the flag`,
    );
  }

  assert.match(argv.find((entry) => entry.startsWith("--system-prompt=")), /You name things\./);
  // The prompt is the only positional: anything else here would be read as one.
  assert.equal(argv.at(-1), "name this");
});

test("no model means no --model, so omp resolves its own", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-one-shot-nomodel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const omp = fakeOmp(dir, { frames: [assistantTurn("ok")] });

  await runOneShotModel({ bin: omp.bin, systemPrompt: "s", prompt: "p" });
  const argv = omp.readArgv();
  assert.ok(!argv.some((entry) => entry.startsWith("--model")), JSON.stringify(argv));
});

test("the run neither saves a session nor pays for a generated title", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-one-shot-flags-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const omp = fakeOmp(dir, { frames: [assistantTurn("ok")] });

  await runOneShotModel({ bin: omp.bin, systemPrompt: "s", prompt: "p" });
  const argv = omp.readArgv();
  // --no-title is not tidiness: omp's title generator is itself a model call,
  // so without it every one-shot run pays for a second one.
  for (const flag of ["--no-tools", "--no-skills", "--no-rules", "--no-session", "--no-title", "--no-prewalk", "--no-extensions"]) {
    assert.ok(argv.includes(flag), `${flag} missing from ${JSON.stringify(argv)}`);
  }
});

test("a failing run reports the failure as a value, never a throw", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-one-shot-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const omp = fakeOmp(dir, { frames: [], exitCode: 2 });

  const result = await runOneShotModel({ bin: omp.bin, systemPrompt: "s", prompt: "p" });
  assert.equal(result.text, null);
  assert.match(result.error, /exit 2|no output/i);

  // A binary that is not there at all is the same shape, not an exception.
  const missing = await runOneShotModel({ bin: join(dir, "nope"), systemPrompt: "s", prompt: "p" });
  assert.equal(missing.text, null);
  assert.ok(missing.error);
});

test("tools requests --tools=<csv> and drops --no-tools entirely", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-one-shot-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const omp = fakeOmp(dir, { frames: [assistantTurn("ok")] });

  await runOneShotModel({ bin: omp.bin, systemPrompt: "s", prompt: "p", tools: ["web_search"] });
  const argv = omp.readArgv();
  assert.ok(argv.includes("--tools=web_search"), JSON.stringify(argv));
  assert.ok(!argv.includes("--no-tools"), JSON.stringify(argv));
});

test("omitting tools keeps the fully tool-free default", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-one-shot-notools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const omp = fakeOmp(dir, { frames: [assistantTurn("ok")] });

  await runOneShotModel({ bin: omp.bin, systemPrompt: "s", prompt: "p" });
  const argv = omp.readArgv();
  assert.ok(argv.includes("--no-tools"), JSON.stringify(argv));
  assert.ok(!argv.some((entry) => entry.startsWith("--tools=")), JSON.stringify(argv));
});

test("multiple tools join as one comma-separated flag, in order", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-one-shot-tools-multi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const omp = fakeOmp(dir, { frames: [assistantTurn("ok")] });

  await runOneShotModel({ bin: omp.bin, systemPrompt: "s", prompt: "p", tools: ["web_search", "read"] });
  const argv = omp.readArgv();
  assert.ok(argv.includes("--tools=web_search,read"), JSON.stringify(argv));
});

test("cwd overrides the default OS temp root", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-one-shot-cwd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wantedCwd = mkdtempSync(join(tmpdir(), "cody-one-shot-cwd-target-"));
  t.after(() => rmSync(wantedCwd, { recursive: true, force: true }));
  const omp = fakeOmp(dir, { frames: [assistantTurn("ok")] });

  await runOneShotModel({ bin: omp.bin, systemPrompt: "s", prompt: "p", cwd: wantedCwd });
  assert.equal(omp.readInfo().cwd, wantedCwd);
});

test("extraEnv layers on top of the child's environment", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-one-shot-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const omp = fakeOmp(dir, { frames: [assistantTurn("ok")], envKeys: ["PI_CODING_AGENT_DIR"] });

  await runOneShotModel({
    bin: omp.bin,
    systemPrompt: "s",
    prompt: "p",
    extraEnv: { PI_CODING_AGENT_DIR: "/tmp/isolated-agent-dir" },
  });
  assert.equal(omp.readInfo().env.PI_CODING_AGENT_DIR, "/tmp/isolated-agent-dir");
});

test("onToolStart/onToolEnd report every tool frame with a bounded result excerpt", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-one-shot-toolframes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const longText = "x".repeat(1000);
  const omp = fakeOmp(dir, {
    frames: [
      toolStart("call-1", "web_search", { query: "home assistant release" }),
      toolEnd("call-1", "web_search", { content: [{ type: "text", text: longText }] }),
      toolStart("call-2", "read", { path: "/etc/hostname" }),
      toolEnd("call-2", "read", { content: [{ type: "text", text: "boom" }] }, true),
      assistantTurn("done"),
    ],
  });

  const starts = [];
  const ends = [];
  const result = await runOneShotModelStreaming({
    bin: omp.bin,
    systemPrompt: "s",
    prompt: "p",
    tools: ["web_search"],
    onToolStart: (event) => starts.push(event),
    onToolEnd: (event) => ends.push(event),
  });

  assert.equal(result.text, "done");
  assert.deepEqual(starts, [
    { toolCallId: "call-1", toolName: "web_search", args: { query: "home assistant release" } },
    { toolCallId: "call-2", toolName: "read", args: { path: "/etc/hostname" } },
  ]);
  assert.equal(ends.length, 2);
  assert.equal(ends[0].toolCallId, "call-1");
  assert.equal(ends[0].isError, false);
  // Bounded: the 1000-char payload never reaches the caller whole.
  assert.ok(ends[0].resultExcerpt.length < longText.length);
  assert.ok(ends[0].resultExcerpt.endsWith("…"));
  assert.equal(ends[1].toolCallId, "call-2");
  assert.equal(ends[1].isError, true);
  assert.equal(ends[1].resultExcerpt, "boom");
});
