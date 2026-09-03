import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createPiProviderLogins } = await jiti.import("./pi-login.ts");

/**
 * A stand-in for bin/cody-pi-login.mjs that speaks the same line protocol
 * without needing pi installed.
 *
 * The real helper's job is to translate pi's callbacks into these frames; this
 * one produces every frame shape the driver has to survive, on demand, so the
 * bridge itself — URL out, pasted value in, device code, cancel, a helper that
 * dies — is what the tests exercise.
 */
const STUB = `
import { createInterface } from "node:readline";

const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const [command, providerId] = process.argv.slice(2);

const waiters = [];
const held = [];
function nextInput() {
  if (held.length > 0) return Promise.resolve(held.shift());
  return new Promise((resolve) => waiters.push(resolve));
}
const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  if (frame.type !== "input") return;
  const waiter = waiters.shift();
  if (waiter) waiter(frame.value);
  else held.push(frame.value);
});
const stop = () => { reader.close(); process.stdin.pause(); process.stdin.unref(); };

if (command === "list") {
  emit({
    type: "providers",
    providers: [
      { id: "anthropic", name: "Anthropic (Claude Pro/Max)", authenticated: false, usesCallbackServer: true },
      { id: "github-copilot", name: "GitHub Copilot", authenticated: true, usesCallbackServer: false, hint: "hint text" },
      { id: "", name: "nameless" },
    ],
  });
  stop();
} else if (command === "logout") {
  if (providerId === "unknown") emit({ type: "error", message: "no such provider: unknown" });
  else emit({ type: "done", provider: providerId });
  stop();
} else if (command === "login") {
  if (providerId === "anthropic") {
    // The callback-server shape: URL first, then whatever the user pastes.
    emit({ type: "progress", message: "agent-dir " + process.env.PI_CODING_AGENT_DIR });
    emit({ type: "progress", message: "package-root " + process.env.CODY_PI_PACKAGE_ROOT });
    emit({ type: "auth", url: "https://claude.ai/oauth/authorize?x=1", instructions: "Paste the final redirect URL here." });
    const pasted = await nextInput();
    emit({ type: "progress", message: "received " + pasted });
    emit({ type: "done" });
    stop();
  } else if (providerId === "device") {
    emit({ type: "auth", url: "https://github.com/login/device", instructions: "Enter code: WXYZ-1234" });
    emit({ type: "done" });
    stop();
  } else if (providerId === "prompted") {
    emit({ type: "prompt", message: "GitHub Enterprise URL/domain", placeholder: "company.ghe.com" });
    const answer = await nextInput();
    emit({ type: "progress", message: "answered " + answer });
    emit({ type: "done" });
    stop();
  } else if (providerId === "broken") {
    emit({ type: "error", message: "Token exchange request failed" });
    process.exitCode = 1;
    stop();
  } else if (providerId === "silent") {
    process.stderr.write("pi exploded\\n");
    process.exitCode = 3;
    stop();
  } else if (providerId === "hang") {
    emit({ type: "progress", message: "pid " + process.pid });
    setInterval(() => {}, 1000);
  } else {
    emit({ type: "error", message: "unknown provider " + providerId });
    process.exitCode = 1;
    stop();
  }
} else {
  emit({ type: "error", message: "unknown command " + command });
  process.exitCode = 1;
  stop();
}
`;

const workspace = mkdtempSync(join(tmpdir(), "cody-pi-login-"));
const stubScript = join(workspace, "stub-login.mjs");
writeFileSync(stubScript, STUB, "utf8");
const agentDir = join(workspace, "agent");
const packageRoot = join(workspace, "pi-package");

function deps(overrides = {}) {
  return {
    resolveBinary: () => join(workspace, "bin", "pi"),
    agentDir: () => agentDir,
    scriptPath: () => stubScript,
    findPackageRoot: () => packageRoot,
    ...overrides,
  };
}

/**
 * The panel's one paste box, as the route models it
 * (lib/harness/login-channel.ts): the next submission goes to whoever asked
 * first, and with nobody asking it is held. Rebuilt here rather than imported
 * so this test pins the DRIVER's behaviour against that contract, not against
 * one implementation of it.
 */
function makeUi() {
  const waiters = [];
  let heldValue = null;
  let cancelled = null;
  const events = { urls: [], deviceCodes: [], prompts: [], progress: [] };
  const controller = new AbortController();

  const next = () => new Promise((resolve, reject) => {
    if (cancelled) { reject(cancelled); return; }
    if (heldValue !== null) { const value = heldValue; heldValue = null; resolve(value); return; }
    waiters.push({ resolve, reject });
  });

  return {
    events,
    controller,
    submit(value) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value);
      else heldValue = value;
    },
    cancel() {
      cancelled = new Error("Login cancelled");
      controller.abort();
      for (const waiter of waiters.splice(0)) waiter.reject(cancelled);
    },
    ui: {
      onUrl: (url, instructions) => events.urls.push({ url, instructions }),
      onDeviceCode: (info) => events.deviceCodes.push(info),
      onPrompt: (message, placeholder) => {
        events.prompts.push({ message, placeholder });
        return next();
      },
      onManualInput: () => next(),
      onProgress: (message) => events.progress.push(message),
      signal: controller.signal,
    },
  };
}

/** Wait for a condition the child process drives, without a fixed sleep. */
async function until(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** True once the pid names no live (non-zombie) process. */
function isGone(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    // A killed child stays visible as a zombie until Node reaps it; that is
    // still "the child stopped running", which is what this asserts.
    return /^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return true;
  }
}

test("login relays the URL, forwards an unprompted paste and resolves on done", async () => {
  const surface = createPiProviderLogins(deps());
  const harness = makeUi();
  const flow = surface.login("anthropic", harness.ui);

  await until(() => harness.events.urls.length > 0, "the auth frame");
  assert.equal(harness.events.urls[0].url, "https://claude.ai/oauth/authorize?x=1");
  assert.match(harness.events.urls[0].instructions, /redirect URL/);
  // No code in those instructions, so no device-code panel.
  assert.equal(harness.events.deviceCodes.length, 0);
  // The child ran with the adapter's own agent dir and package root.
  assert.ok(harness.events.progress.includes(`agent-dir ${agentDir}`));
  assert.ok(harness.events.progress.includes(`package-root ${packageRoot}`));

  harness.submit("http://localhost:53692/callback?code=abc#state");
  await flow;
  assert.ok(harness.events.progress.includes("received http://localhost:53692/callback?code=abc#state"));
});

test("a device code in the instructions is surfaced beside the URL", async () => {
  const surface = createPiProviderLogins(deps());
  const harness = makeUi();
  await surface.login("device", harness.ui);
  assert.equal(harness.events.urls[0].url, "https://github.com/login/device");
  assert.deepEqual(harness.events.deviceCodes, [
    { userCode: "WXYZ-1234", verificationUri: "https://github.com/login/device" },
  ]);
});

test("a prompt frame asks through the UI and sends the answer back", async () => {
  const surface = createPiProviderLogins(deps());
  const harness = makeUi();
  const flow = surface.login("prompted", harness.ui);

  await until(() => harness.events.prompts.length > 0, "the prompt frame");
  assert.deepEqual(harness.events.prompts[0], {
    message: "GitHub Enterprise URL/domain",
    placeholder: "company.ghe.com",
  });
  harness.submit("company.ghe.com");
  await flow;
  assert.ok(harness.events.progress.includes("answered company.ghe.com"));
});

test("an error frame rejects with the engine's own words", async () => {
  const surface = createPiProviderLogins(deps());
  const harness = makeUi();
  await assert.rejects(surface.login("broken", harness.ui), /Token exchange request failed/);
});

test("a helper that dies without finishing rejects, carrying its stderr", async () => {
  const surface = createPiProviderLogins(deps());
  const harness = makeUi();
  await assert.rejects(surface.login("silent", harness.ui), (error) => {
    assert.match(error.message, /exited \(code 3\)/);
    assert.match(error.message, /pi exploded/);
    return true;
  });
});

test("cancelling rejects the flow and kills the child", async () => {
  const surface = createPiProviderLogins(deps());
  const harness = makeUi();
  const flow = surface.login("hang", harness.ui);
  const rejected = assert.rejects(flow, /cancel/i);

  await until(() => harness.events.progress.some((line) => line.startsWith("pid ")), "the child's pid");
  const pid = Number(harness.events.progress.find((line) => line.startsWith("pid ")).slice(4));
  assert.ok(Number.isInteger(pid) && pid > 0);

  harness.cancel();
  await rejected;
  await until(() => isGone(pid), `child ${pid} to exit`);
});

test("list maps pi's providers onto the seam's options", async () => {
  const surface = createPiProviderLogins(deps());
  const result = await surface.list();
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.providers, [
    {
      id: "anthropic",
      name: "Anthropic (Claude Pro/Max)",
      authenticated: false,
      kind: "oauth",
      canLogout: true,
    },
    {
      id: "github-copilot",
      name: "GitHub Copilot",
      authenticated: true,
      // No local callback server is pi-ai's own mark of the device flow.
      kind: "device",
      canLogout: true,
      hint: "hint text",
    },
  ]);
});

test("list fails soft when pi is not installed", async () => {
  const surface = createPiProviderLogins(deps({ resolveBinary: () => null }));
  const result = await surface.list();
  assert.deepEqual(result.providers, []);
  assert.match(result.reason, /Pi is not installed/);
});

test("list fails soft when the pi package cannot be found above the binary", async () => {
  const surface = createPiProviderLogins(deps({ findPackageRoot: () => null }));
  const result = await surface.list();
  assert.deepEqual(result.providers, []);
  assert.match(result.reason, /@mariozechner\/pi-coding-agent/);
});

test("list fails soft when the helper itself cannot run", async () => {
  const surface = createPiProviderLogins(deps({ scriptPath: () => join(workspace, "no-such-helper.mjs") }));
  const result = await surface.list();
  assert.deepEqual(result.providers, []);
  assert.match(result.reason, /Pi listed no sign-in providers/);
});

test("login refuses outright when pi is not installed", async () => {
  const surface = createPiProviderLogins(deps({ resolveBinary: () => null }));
  await assert.rejects(surface.login("anthropic", makeUi().ui), /Pi is not installed/);
});

test("logout resolves on done and rejects on the helper's error", async () => {
  const surface = createPiProviderLogins(deps());
  await surface.logout("anthropic");
  await assert.rejects(surface.logout("unknown"), /no such provider: unknown/);
});
