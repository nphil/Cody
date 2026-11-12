import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseRunOnWorkerArgs, runOnWorker, RUN_ON_WORKER_TOOL, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } = await jiti.import("./tool.ts");
const { MAX_COMMAND_BYTES } = await jiti.import("./remote.ts");
const { WORKER_ARCHES } = await jiti.import("../machines/types.ts");

/**
 * The agent-facing surface of `run_on_worker`: what the agent may pass and
 * what becomes of it. parseRunOnWorkerArgs must turn loose input into a clean
 * JobRequest (defaults, clamps, normalised architecture, tidy tool names and
 * lists) or give back one sentence saying what to fix. runOnWorker must never
 * reject, only return the sentence as an error result. The tool definition the
 * agent reads must declare exactly the parameters the parser reads. Valid
 * calls are not made here: they would reach the real scheduler and ssh.
 */

const ok = (raw) => {
  const parsed = parseRunOnWorkerArgs(raw);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
  return parsed.value;
};
const refused = (raw) => {
  const parsed = parseRunOnWorkerArgs(raw);
  assert.equal(parsed.ok, false, `expected a refusal for ${JSON.stringify(raw)}`);
  assert.equal(typeof parsed.message, "string");
  assert.ok(parsed.message.length > 0);
  return parsed.message;
};

// ---------- the command ----------

test("a command is required: missing, blank or not a string is refused with a sentence about command", () => {
  for (const command of [undefined, null, "", "   \n\t", 5, true, ["ls"], { a: 1 }]) {
    assert.match(refused({ command }), /command is required/, JSON.stringify(command));
  }
  assert.match(refused({}), /command is required/);
});

test("a command with a NUL character is refused", () => {
  assert.match(refused({ command: "echo a\0b" }), /NUL/);
});

test("a command is kept exactly as given, spaces and all", () => {
  assert.equal(ok({ command: "  bun install && bun run build\n" }).command, "  bun install && bun run build\n");
});

test("the command limit is 24 KB counted in bytes, so exactly that many is fine and one more is not", () => {
  assert.equal(MAX_COMMAND_BYTES, 24 * 1024);
  assert.equal(ok({ command: "a".repeat(MAX_COMMAND_BYTES) }).command.length, MAX_COMMAND_BYTES);
  assert.match(refused({ command: "a".repeat(MAX_COMMAND_BYTES + 1) }), /24 KB/);
});

test("the command limit counts bytes, not characters", () => {
  // 12289 two-byte characters are only 12289 characters but 24578 bytes
  const wide = "é".repeat(MAX_COMMAND_BYTES / 2 + 1);
  assert.ok(wide.length < MAX_COMMAND_BYTES);
  assert.match(refused({ command: wide }), /24 KB/);
  assert.equal(ok({ command: "é".repeat(MAX_COMMAND_BYTES / 2) }).command.length, MAX_COMMAND_BYTES / 2);
});

test("input that is not an object is refused", () => {
  for (const raw of [null, undefined, "ls", 42, true, [], [{ command: "ls" }]]) {
    assert.match(refused(raw), /needs an object/, JSON.stringify(raw));
  }
});

// ---------- defaults ----------

test("with only a command everything else takes its default", () => {
  assert.deepEqual(ok({ command: "make" }), {
    command: "make",
    cwd: undefined,
    include: undefined,
    results: [],
    arch: null,
    tools: [],
    timeoutMs: 1_800_000,
    fallbackLocal: true,
  });
});

test("the default timeout is 1800 s and the longest allowed 7200 s", () => {
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 1800);
  assert.equal(MAX_TIMEOUT_SECONDS, 7200);
});

test("null counts the same as leaving a field out", () => {
  const value = ok({ command: "make", cwd: null, include: null, results: null, arch: null, tools: null, timeoutSeconds: null, fallbackLocal: null });
  assert.deepEqual(value, ok({ command: "make" }));
});

test("unknown extra fields are ignored", () => {
  assert.deepEqual(ok({ command: "make", colour: "red" }), ok({ command: "make" }));
});

// ---------- timeout ----------

test("timeoutSeconds becomes milliseconds", () => {
  assert.equal(ok({ command: "x", timeoutSeconds: 90 }).timeoutMs, 90_000);
});

test("timeoutSeconds is clamped to 1 and 7200 seconds", () => {
  assert.equal(ok({ command: "x", timeoutSeconds: 0 }).timeoutMs, 1000);
  assert.equal(ok({ command: "x", timeoutSeconds: -50 }).timeoutMs, 1000);
  assert.equal(ok({ command: "x", timeoutSeconds: 1 }).timeoutMs, 1000);
  assert.equal(ok({ command: "x", timeoutSeconds: 7200 }).timeoutMs, 7_200_000);
  assert.equal(ok({ command: "x", timeoutSeconds: 7201 }).timeoutMs, 7_200_000);
  assert.equal(ok({ command: "x", timeoutSeconds: 1e9 }).timeoutMs, 7_200_000);
});

test("timeoutSeconds is rounded to a whole second", () => {
  assert.equal(ok({ command: "x", timeoutSeconds: 1.4 }).timeoutMs, 1000);
  assert.equal(ok({ command: "x", timeoutSeconds: 1.6 }).timeoutMs, 2000);
  assert.equal(ok({ command: "x", timeoutSeconds: 0.2 }).timeoutMs, 1000);
});

test("timeoutSeconds may be a number written as text, and an empty text means the default", () => {
  assert.equal(ok({ command: "x", timeoutSeconds: "120" }).timeoutMs, 120_000);
  assert.equal(ok({ command: "x", timeoutSeconds: " 45 " }).timeoutMs, 45_000);
  assert.equal(ok({ command: "x", timeoutSeconds: "" }).timeoutMs, 1_800_000);
});

test("timeoutSeconds that is not a finite number is refused", () => {
  for (const timeoutSeconds of ["soon", "12 minutes", Number.NaN, Infinity, -Infinity, "Infinity", {}, [], [5], true, false]) {
    assert.match(refused({ command: "x", timeoutSeconds }), /timeoutSeconds/, String(timeoutSeconds));
  }
});

// ---------- fallbackLocal ----------

test("fallbackLocal takes true or false, as booleans or as the words", () => {
  assert.equal(ok({ command: "x", fallbackLocal: true }).fallbackLocal, true);
  assert.equal(ok({ command: "x", fallbackLocal: false }).fallbackLocal, false);
  assert.equal(ok({ command: "x", fallbackLocal: "true" }).fallbackLocal, true);
  assert.equal(ok({ command: "x", fallbackLocal: "false" }).fallbackLocal, false);
});

test("any other fallbackLocal is refused", () => {
  for (const fallbackLocal of ["yes", "no", "TRUE", "", 0, 1, {}, []]) {
    assert.match(refused({ command: "x", fallbackLocal }), /fallbackLocal must be true or false/, JSON.stringify(fallbackLocal));
  }
});

// ---------- arch ----------

test("architecture names are normalised: amd64, x64 and X86_64 are x86_64; arm64 and AArch64 are aarch64", () => {
  for (const arch of ["x86_64", "amd64", "x64", "X86_64", "AMD64", " x64 "]) assert.equal(ok({ command: "x", arch }).arch, "x86_64", arch);
  for (const arch of ["aarch64", "arm64", "AArch64", "ARM64"]) assert.equal(ok({ command: "x", arch }).arch, "aarch64", arch);
});

test("an architecture that is none of them is refused and the message names the allowed ones", () => {
  const message = refused({ command: "x", arch: "riscv64" });
  assert.match(message, /x86_64/);
  assert.match(message, /aarch64/);
  assert.match(message, /riscv64/);
  refused({ command: "x", arch: 64 });
  refused({ command: "x", arch: ["x86_64"] });
  refused({ command: "x", arch: "   " });
});

test("an empty or null architecture means none", () => {
  assert.equal(ok({ command: "x", arch: "" }).arch, null);
  assert.equal(ok({ command: "x", arch: null }).arch, null);
  assert.equal(ok({ command: "x" }).arch, null);
});

// ---------- tools ----------

test("tool names are trimmed, lower-cased and de-duplicated, keeping the first-seen order", () => {
  assert.deepEqual(ok({ command: "x", tools: [" Node ", "RUST", "node", "docker", "Rust"] }).tools, ["node", "rust", "docker"]);
});

test("blank tool entries are dropped", () => {
  assert.deepEqual(ok({ command: "x", tools: ["", "  ", "go"] }).tools, ["go"]);
});

test("a single tool name written as a string is a list of one", () => {
  assert.deepEqual(ok({ command: "x", tools: "Node" }).tools, ["node"]);
});

test("tool names with odd characters are refused and the message names the offender as written", () => {
  for (const bad of ["rm -rf /", "node;ls", "Bad Name", "-leading-dash", "a/b", "x".repeat(33), "naïve"]) {
    const message = refused({ command: "x", tools: ["node", bad] });
    assert.ok(message.includes(JSON.stringify(bad).slice(1, -1)), `${bad} is named in: ${message}`);
    assert.match(message, /tools/);
  }
});

test("tool names with dots, plus, underscore and dash are fine, up to 32 characters", () => {
  assert.deepEqual(ok({ command: "x", tools: ["g++", "python3.12", "c_make", "a-b", "x".repeat(32)] }).tools, ["g++", "python3.12", "c_make", "a-b", "x".repeat(32)]);
});

test("more than 16 different tools are refused, exactly 16 is fine, and repeats do not count", () => {
  const names = Array.from({ length: 17 }, (_, index) => `tool${index}`);
  assert.equal(ok({ command: "x", tools: names.slice(0, 16) }).tools.length, 16);
  assert.match(refused({ command: "x", tools: names }), /more than 16/);
  assert.equal(ok({ command: "x", tools: [...names.slice(0, 16), ...names.slice(0, 16).map((name) => name.toUpperCase())] }).tools.length, 16);
});

test("tools that is not a list of strings is refused", () => {
  for (const tools of [{}, 5, true, [1], ["node", null], [["node"]]]) {
    assert.match(refused({ command: "x", tools }), /tools must be a list of strings/, JSON.stringify(tools));
  }
});

// ---------- include and results ----------

test("include and results keep a list of strings as given", () => {
  const value = ok({ command: "x", include: ["src/**", "package.json"], results: ["dist", "target/release/app"] });
  assert.deepEqual(value.include, ["src/**", "package.json"]);
  assert.deepEqual(value.results, ["dist", "target/release/app"]);
});

test("a single string becomes a list of one", () => {
  const value = ok({ command: "x", include: "src/**", results: "dist" });
  assert.deepEqual(value.include, ["src/**"]);
  assert.deepEqual(value.results, ["dist"]);
});

test("an empty include list means the default (undefined) while an empty results list stays empty", () => {
  const value = ok({ command: "x", include: [], results: [] });
  assert.equal(value.include, undefined);
  assert.deepEqual(value.results, []);
});

test("entries that are not strings are refused", () => {
  for (const bad of [[1], [null], ["a", {}], [["a"]], {}, 7, true]) {
    assert.match(refused({ command: "x", include: bad }), /include must be a list of strings/, JSON.stringify(bad));
    assert.match(refused({ command: "x", results: bad }), /results must be a list of strings/, JSON.stringify(bad));
  }
});

test("an entry with a NUL character is refused and the message names the field", () => {
  assert.match(refused({ command: "x", include: ["ok", "a\0b"] }), /include has an entry with a NUL/);
  assert.match(refused({ command: "x", results: "a\0b" }), /results has an entry with a NUL/);
});

test("an entry longer than 4096 characters is refused, exactly 4096 is fine", () => {
  assert.equal(ok({ command: "x", results: ["a".repeat(4096)] }).results[0].length, 4096);
  assert.match(refused({ command: "x", results: ["a".repeat(4097)] }), /results has an entry longer than 4096/);
  assert.match(refused({ command: "x", include: ["a".repeat(4097)] }), /include has an entry longer than 4096/);
});

// ---------- cwd ----------

test("cwd is kept as given, and null or missing means undefined", () => {
  assert.equal(ok({ command: "x", cwd: "packages/app" }).cwd, "packages/app");
  assert.equal(ok({ command: "x", cwd: "/abs/path" }).cwd, "/abs/path");
  assert.equal(ok({ command: "x", cwd: null }).cwd, undefined);
  assert.equal(ok({ command: "x" }).cwd, undefined);
});

test("cwd that is not a string or has a NUL character is refused", () => {
  assert.match(refused({ command: "x", cwd: 5 }), /cwd must be a path/);
  assert.match(refused({ command: "x", cwd: ["a"] }), /cwd must be a path/);
  assert.match(refused({ command: "x", cwd: {} }), /cwd must be a path/);
  assert.match(refused({ command: "x", cwd: "a\0b" }), /cwd has a NUL/);
});

// ---------- runOnWorker (bad input only) ----------

test("runOnWorker answers bad input with an error result, never a rejection", async () => {
  const ctx = { cwd: "/nonexistent-workspace", sessionId: "s-test" };
  const bad = [undefined, null, "ls", [], {}, { command: "" }, { command: "x\0" }, { command: "x", timeoutSeconds: "soon" }, { command: "x", arch: "mips" }, { command: "x", tools: ["bad name"] }, { command: "x", fallbackLocal: "maybe" }];
  for (const raw of bad) {
    const result = await runOnWorker(raw, ctx);
    assert.equal(result.isError, true, JSON.stringify(raw));
    assert.equal(typeof result.text, "string");
    assert.ok(result.text.length > 0);
    const parsed = parseRunOnWorkerArgs(raw);
    assert.equal(parsed.ok, false);
    assert.equal(result.text, parsed.message, "the agent reads the same sentence the parser gives");
  }
});

test("runOnWorker turns even an unexpected exception into an error result", async () => {
  const hostile = {
    get command() {
      throw new Error("boom");
    },
  };
  const result = await runOnWorker(hostile, { cwd: "/nonexistent-workspace", sessionId: "s-test" });
  assert.deepEqual(result, { text: "run_on_worker failed: boom", isError: true });
});

// ---------- the tool definition ----------

test("the tool is called run_on_worker and only command is required", () => {
  assert.equal(RUN_ON_WORKER_TOOL.name, "run_on_worker");
  assert.equal(RUN_ON_WORKER_TOOL.parameters.type, "object");
  assert.deepEqual(RUN_ON_WORKER_TOOL.parameters.required, ["command"]);
});

test("the parameters declared are exactly the ones the parser reads", () => {
  const declared = Object.keys(RUN_ON_WORKER_TOOL.parameters.properties).sort();
  assert.deepEqual(declared, ["arch", "command", "cwd", "fallbackLocal", "include", "results", "timeoutSeconds", "tools"]);

  // Every declared parameter is read: a bad value for it is refused.
  const badValue = { command: 5, cwd: 5, include: 5, results: 5, arch: "mips", tools: 5, timeoutSeconds: "soon", fallbackLocal: "maybe" };
  assert.deepEqual(Object.keys(badValue).sort(), declared, "the table covers every declared parameter");
  for (const name of declared) refused({ command: "x", [name]: badValue[name] });

  // Every parameter the parser reads is declared.
  const source = readFileSync(new URL("./tool.ts", import.meta.url), "utf8");
  const read = new Set([...source.matchAll(/\braw\.(\w+)/g)].map((match) => match[1]));
  if (/\{\s*command\s*\}\s*=\s*raw\b/.test(source)) read.add("command");
  assert.deepEqual([...read].sort(), declared);
});

test("every parameter has a type and a description for the agent", () => {
  for (const [name, schema] of Object.entries(RUN_ON_WORKER_TOOL.parameters.properties)) {
    assert.ok(["string", "array", "number", "boolean"].includes(schema.type), name);
    assert.ok(schema.description.length > 20, name);
    if (schema.type === "array") assert.equal(schema.items.type, "string", name);
  }
});

test("the arch choices offered are the architectures workers can have", () => {
  assert.deepEqual(RUN_ON_WORKER_TOOL.parameters.properties.arch.enum, [...WORKER_ARCHES]);
});

test("the timeout description quotes the real default and maximum", () => {
  const text = RUN_ON_WORKER_TOOL.parameters.properties.timeoutSeconds.description;
  assert.ok(text.includes(String(DEFAULT_TIMEOUT_SECONDS)));
  assert.ok(text.includes(String(MAX_TIMEOUT_SECONDS)));
});

test("the description tells the agent what a worker is, that quick work stays local, and about fallbackLocal and results", () => {
  const text = RUN_ON_WORKER_TOOL.description;
  assert.match(text, /worker/);
  assert.match(text, /quick commands/);
  assert.match(text, /local/);
  assert.match(text, /fallbackLocal/);
  assert.match(text, /`results`/);
});
