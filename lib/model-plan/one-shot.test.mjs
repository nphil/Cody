import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { runOneShotModel } = await jiti.import("./one-shot.ts");

/** A fake omp that records the argv it was handed and replays NDJSON frames. */
function fakeOmp(dir, { frames = [], exitCode = 0 } = {}) {
  const argvLog = join(dir, "argv.json");
  const bin = join(dir, "omp");
  const body = frames.map((frame) => JSON.stringify(frame)).join("\n");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    `require("fs").writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
    `process.stdout.write(${JSON.stringify(body ? `${body}\n` : "")});`,
    `process.exit(${exitCode});`,
  ].join("\n"));
  chmodSync(bin, 0o755);
  return { bin, readArgv: () => JSON.parse(readFileSync(argvLog, "utf8")) };
}

const assistantTurn = (text) => ({
  type: "turn_end",
  message: { role: "assistant", content: [{ type: "text", text }] },
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
