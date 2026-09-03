import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `runCliLogin` (lib/harness/cli-login.ts) is the ONE node-pty driver behind
 * Claude Code's, Codex's and Hermes' provider-login surfaces
 * (claude-login.ts, codex-login.ts, hermes-login.ts): it spawns a CLI,
 * strips escape sequences, and matches the small vocabulary each one's login
 * flow actually uses. These tests exercise that driver against a FAKE CLI —
 * a small Node script whose printed lines and exit behaviour are scripted
 * per test — rather than the real `claude`/`codex`/`hermes` binaries, so the
 * suite is deterministic and needs no installed engine or network access.
 *
 * What each engine's own module gets right (the exact regexes against
 * measured CLI output, JSON/plain-text status parsing, the ChatGPT-vs-API-key
 * and firstParty-vs-console distinctions) was verified separately against the
 * real, installed CLIs in throwaway HOME/CONFIG dirs — see the task report.
 * This file pins the shared mechanism those three modules all depend on.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { runCliLogin } = await jiti.import("./cli-login.ts");

const workDir = mkdtempSync(join(tmpdir(), "cody-cli-login-"));

/**
 * A CommonJS fake CLI: prints `plan.steps` in order, typing through a
 * `{type:"prompt"}` step by waiting for one line of stdin, and exits with
 * `plan.exitCode` (default 0) once the steps are exhausted. `{type:"hang"}`
 * never advances — the step list ends there — for testing abort/kill.
 * `.cjs` so it runs as CommonJS regardless of the repo's module type.
 */
const FAKE_CLI_PATH = join(workDir, "fake-cli.cjs");
writeFileSync(
  FAKE_CLI_PATH,
  `
const fs = require("fs");
const plan = JSON.parse(process.env.FAKE_CLI_PLAN || "{}");
if (process.env.FAKE_CLI_PIDFILE) fs.writeFileSync(process.env.FAKE_CLI_PIDFILE, String(process.pid));
const steps = plan.steps || [];
let i = 0;
function next() {
  if (i >= steps.length) { process.exit(typeof plan.exitCode === "number" ? plan.exitCode : 0); return; }
  const step = steps[i++];
  if (step.type === "print") {
    process.stdout.write(step.text + "\\n");
    setImmediate(next);
  } else if (step.type === "prompt") {
    process.stdout.write(step.text);
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (/[\\r\\n]/.test(buf)) {
        process.stdin.removeListener("data", onData);
        process.stdout.write("\\nRECEIVED:" + buf.replace(/[\\r\\n]+$/, "") + "\\n");
        next();
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  } else if (step.type === "hang") {
    // Deliberately never calls next(). Without an active handle, Node exits
    // on its own the instant the event loop drains (nothing left scheduled)
    // instead of actually sitting there to be killed — a real device-code
    // login is idle here only because it is off polling a server on a
    // timer, so an inert one stands in for that.
    setInterval(() => {}, 0x7fffffff);
  }
}
next();
`,
  "utf8",
);

let pidFileCounter = 0;

/** One fake-CLI spawn spec plus a pidfile path the script writes its own pid
 * to on startup, so a test can confirm the OS process is actually gone after
 * an abort — the same thing "the child is gone (ps)" checks manually. */
function fakeCliSpec(steps, exitCode, specOverrides = {}) {
  const pidFile = join(workDir, `pid-${++pidFileCounter}.txt`);
  return {
    pidFile,
    spec: {
      bin: process.execPath,
      args: [FAKE_CLI_PATH],
      env: { ...process.env, FAKE_CLI_PLAN: JSON.stringify({ steps, exitCode }), FAKE_CLI_PIDFILE: pidFile },
      cwd: workDir,
      url: /visit:\s*(\S+)/,
      ...specOverrides,
    },
  };
}

async function readPid(pidFile) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const text = readFileSync(pidFile, "utf8").trim();
      if (text) return Number(text);
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fake CLI never wrote a pid to ${pidFile}`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A ProviderLoginUi test double built the same way the real SSE route
 * (app/api/auth/login/[provider]/route.ts) builds one: onPrompt and
 * onManualInput share ONE FIFO of values a "user" submits, held until
 * someone asks. */
function makeTestUi() {
  const events = [];
  const waiters = [];
  let held = null;
  const nextValue = () => new Promise((resolve) => {
    if (held !== null) {
      const value = held;
      held = null;
      resolve(value);
      return;
    }
    waiters.push(resolve);
  });
  const controller = new AbortController();
  const ui = {
    onUrl: (url, instructions) => events.push({ type: "url", url, instructions: instructions ?? null }),
    onDeviceCode: (info) => events.push({ type: "deviceCode", ...info }),
    onPrompt: (message, placeholder) => {
      events.push({ type: "promptRequest", message, placeholder: placeholder ?? null });
      return nextValue();
    },
    onManualInput: () => nextValue(),
    onProgress: (message) => events.push({ type: "progress", message }),
    signal: controller.signal,
  };
  const submit = (value) => {
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else held = value;
  };
  return { ui, events, submit, abort: () => controller.abort() };
}

test("a URL is relayed to onUrl, and a value submitted only after the prompt is typed in", async () => {
  const { spec } = fakeCliSpec(
    [
      { type: "print", text: "Opening browser to sign in…" },
      { type: "print", text: "If the browser didn't open, visit: https://example.test/oauth?code=abc" },
      { type: "prompt", text: "Paste code here if prompted > " },
      { type: "print", text: "Login successful." },
    ],
    0,
  );
  const { ui, events, submit } = makeTestUi();
  spec.prompt = /Paste code here if prompted >\s*$/;

  const done = runCliLogin(spec, ui);
  // Wait for the prompt to actually appear before submitting — this is the
  // "asked, then answered" path (onPrompt), distinct from a value pasted
  // early (below).
  for (let i = 0; i < 100 && !events.some((e) => e.type === "promptRequest"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(events.some((e) => e.type === "url" && e.url === "https://example.test/oauth?code=abc"), "the URL reached onUrl");
  assert.ok(events.some((e) => e.type === "promptRequest"), "onPrompt was asked once the CLI's prompt appeared");
  submit("TEST-PASTE-VALUE");

  await done;
});

test("a value pasted before the CLI asks for it is typed in the moment the prompt appears", async () => {
  const { spec } = fakeCliSpec(
    [
      { type: "print", text: "If the browser didn't open, visit: https://example.test/oauth?code=early" },
      { type: "prompt", text: "Paste code here if prompted > " },
      { type: "print", text: "Login successful." },
    ],
    0,
  );
  spec.prompt = /Paste code here if prompted >\s*$/;
  const { ui, events, submit } = makeTestUi();

  const done = runCliLogin(spec, ui);
  // Submit immediately — before the CLI has printed its prompt at all.
  submit("EARLY-PASTE-VALUE");
  await done;

  assert.ok(!events.some((e) => e.type === "promptRequest"), "onPrompt is never asked when a value was already pasted");
});

test("a device code reaches onDeviceCode with the URL seen earlier as its verificationUri", async () => {
  const { spec, pidFile } = fakeCliSpec(
    [
      { type: "print", text: "To continue:" },
      { type: "print", text: "  1. Open: https://example.test/device?user_code=ABCD-1234" },
      { type: "print", text: "  2. If prompted, enter code: ABCD-1234" },
      { type: "print", text: "Waiting for approval..." },
      { type: "hang" },
    ],
    0,
  );
  spec.url = /^\s*1\.\s*Open:\s*(\S+)/;
  spec.deviceCode = /^\s*2\.\s*If prompted, enter code:\s*(\S+)/;
  const { ui, events, abort } = makeTestUi();

  const done = runCliLogin(spec, ui);
  for (let i = 0; i < 150 && !events.some((e) => e.type === "deviceCode"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const deviceEvent = events.find((e) => e.type === "deviceCode");
  assert.ok(deviceEvent, "onDeviceCode fired");
  assert.equal(deviceEvent.userCode, "ABCD-1234");
  assert.equal(deviceEvent.verificationUri, "https://example.test/device?user_code=ABCD-1234", "the URL seen earlier, not a fresh one");

  const pid = await readPid(pidFile);
  assert.ok(isAlive(pid), "the fake CLI is actually running before abort");
  abort();
  await assert.rejects(done, /cancelled/i);
  for (let i = 0; i < 100 && isAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(isAlive(pid), false, "abort kills the child process");
});

test("a nonzero exit rejects with the CLI's own last output lines", async () => {
  const { spec } = fakeCliSpec(
    [
      { type: "print", text: "Attempting sign-in…" },
      { type: "print", text: "Something went wrong: boom" },
    ],
    7,
  );
  const { ui } = makeTestUi();

  await assert.rejects(runCliLogin(spec, ui), /Something went wrong: boom/);
});

test("abort before anything is typed kills the child and rejects", async () => {
  const { spec, pidFile } = fakeCliSpec(
    [
      { type: "print", text: "If the browser didn't open, visit: https://example.test/oauth?code=stuck" },
      { type: "prompt", text: "Paste code here if prompted > " },
    ],
    0,
  );
  spec.prompt = /Paste code here if prompted >\s*$/;
  const { ui, abort } = makeTestUi();

  const done = runCliLogin(spec, ui);
  const pid = await readPid(pidFile);
  assert.ok(isAlive(pid));
  abort();
  await assert.rejects(done, /cancelled/i);
  for (let i = 0; i < 100 && isAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(isAlive(pid), false, "the child is gone after abort");
});

test.after(() => {
  rmSync(workDir, { recursive: true, force: true });
});
