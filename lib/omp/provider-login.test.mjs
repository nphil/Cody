import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * omp's login driver against a fake rpc-ui child and the REAL value channel
 * the route builds, in the order the route builds it. The case that matters
 * is the ordinary one: omp asks for the code the moment it prints the URL,
 * the user spends a while in the browser, and the paste arrives AFTER the
 * ask — the channel's first waiter is the paste watch, not the prompt, and
 * the driver has to hand that value to omp's outstanding request anyway.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createOmpProviderLogins } = await jiti.import("./provider-login.ts");
const { createLoginValueChannel } = await jiti.import("../harness/login-channel.ts");

function harness() {
  const sent = [];
  let onFrame = null;
  let resolveLogin;
  const loginDone = new Promise((resolve) => { resolveLogin = resolve; });
  const child = {
    waitReady: async () => {},
    sendCommand: () => loginDone,
    sendFrame: (frame) => sent.push(frame),
    dispose: async () => {},
  };
  const surface = createOmpProviderLogins({
    createChild: (handler) => { onFrame = handler; return child; },
    listProviders: async () => [{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }],
    afterLogin: () => {},
  });
  const channel = createLoginValueChannel();
  const frames = [];
  const abort = new AbortController();
  const ui = {
    onUrl: (url, instructions) => frames.push({ type: "auth", url, instructions }),
    onDeviceCode: (info) => frames.push({ type: "device_code", ...info }),
    onPrompt: (message, placeholder) => { frames.push({ type: "prompt_request", message, placeholder }); return channel.next(); },
    onManualInput: () => channel.next(),
    onProgress: (message) => frames.push({ type: "progress", message }),
    signal: abort.signal,
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
  return { surface, channel, frames, sent, ui, abort, tick, emit: (frame) => onFrame(frame), finish: () => resolveLogin({}) };
}

test("a code pasted AFTER omp asks for it answers that request", async () => {
  const h = harness();
  const running = h.surface.login("anthropic", h.ui);
  await h.tick();
  h.emit({ type: "extension_ui_request", method: "open_url", url: "https://claude.ai/oauth/authorize?x=1" });
  await h.tick();
  h.emit({ type: "extension_ui_request", method: "input", id: "42", title: "Authorization code" });
  await h.tick();
  assert.ok(h.frames.some((frame) => frame.type === "prompt_request"), "the panel was asked");
  h.channel.submit("CODE-FROM-BROWSER");
  await h.tick();
  assert.deepEqual(h.sent, [{ type: "extension_ui_response", id: "42", value: "CODE-FROM-BROWSER" }]);
  h.finish();
  await running;
});

test("a redirect URL pasted BEFORE omp asks is held and answers the first request", async () => {
  const h = harness();
  const running = h.surface.login("anthropic", h.ui);
  await h.tick();
  h.emit({ type: "extension_ui_request", method: "open_url", url: "https://claude.ai/oauth/authorize?x=1" });
  await h.tick();
  h.channel.submit("http://localhost:1455/auth/callback?code=early");
  await h.tick();
  h.emit({ type: "extension_ui_request", method: "input", id: "7", title: "Authorization code" });
  await h.tick();
  assert.deepEqual(h.sent, [{ type: "extension_ui_response", id: "7", value: "http://localhost:1455/auth/callback?code=early" }]);
  assert.ok(!h.frames.some((frame) => frame.type === "prompt_request"), "no prompt was needed");
  h.finish();
  await running;
});

test("a withdrawn request is not answered; the value waits for the next one", async () => {
  const h = harness();
  const running = h.surface.login("anthropic", h.ui);
  await h.tick();
  h.emit({ type: "extension_ui_request", method: "open_url", url: "https://claude.ai/oauth/authorize?x=1" });
  h.emit({ type: "extension_ui_request", method: "input", id: "1", title: "Authorization code" });
  await h.tick();
  h.emit({ type: "extension_ui_request", method: "cancel", targetId: "1" });
  h.channel.submit("late-value");
  await h.tick();
  assert.deepEqual(h.sent, [], "nothing answers a cancelled request");
  h.emit({ type: "extension_ui_request", method: "input", id: "2", title: "Authorization code" });
  await h.tick();
  assert.deepEqual(h.sent, [{ type: "extension_ui_response", id: "2", value: "late-value" }]);
  h.finish();
  await running;
});

test("list() maps omp's roster and fails soft when the utility child cannot answer", async () => {
  const h = harness();
  const list = await h.surface.list();
  assert.deepEqual(list.providers, [{ id: "anthropic", name: "Anthropic", authenticated: false, kind: "oauth", canLogout: false }]);
  const broken = createOmpProviderLogins({ listProviders: async () => { throw new Error("omp is not installed"); } });
  const failed = await broken.list();
  assert.deepEqual(failed.providers, []);
  assert.match(failed.reason, /not installed/);
});
