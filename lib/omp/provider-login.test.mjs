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
const { createOmpProviderLogins, explainLoginError } = await jiti.import("./provider-login.ts");
const { createLoginValueChannel } = await jiti.import("../harness/login-channel.ts");

function harness() {
  const sent = [];
  let onFrame = null;
  let resolveLogin;
  let rejectLogin;
  const loginDone = new Promise((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });
  const stored = [];
  const child = {
    waitReady: async () => {},
    sendCommand: () => loginDone,
    sendFrame: (frame) => sent.push(frame),
    dispose: async () => {},
  };
  const surface = createOmpProviderLogins({
    createChild: (handler) => { onFrame = handler; return child; },
    listProviders: async () => [{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }],
    engineVersion: async () => null,
    afterLogin: (providerId) => { stored.push(providerId); },
    // These login-flow tests exercise the paste/prompt race, not account
    // listing — an unavailable snapshot keeps list() deterministic and never
    // reaches for the real (possibly live) omp installation.
    listCredentials: async () => ({ available: false, credentials: [] }),
    listUsage: async () => ({ accounts: [] }),
    removeCredential: async () => { throw new Error("not exercised by the login-flow tests"); },
    removeProvider: async () => { throw new Error("not exercised by the login-flow tests"); },
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
  return { surface, channel, frames, sent, stored, ui, abort, tick, emit: (frame) => onFrame(frame), finish: () => resolveLogin({}), fail: (message) => rejectLogin(new Error(message)) };
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

test("two sequential input requests in one login are each answered (Cloudflare Workers AI asks the token, then the account id)", async () => {
  const h = harness();
  const running = h.surface.login("anthropic", h.ui);
  await h.tick();
  h.emit({ type: "extension_ui_request", method: "open_url", url: "https://dash.cloudflare.com/profile/api-tokens", instructions: "Create an API token" });
  h.emit({ type: "extension_ui_request", method: "input", id: "tok", title: "Paste your Cloudflare API token" });
  await h.tick();
  h.channel.submit("cf-token");
  await h.tick();
  assert.deepEqual(h.sent, [{ type: "extension_ui_response", id: "tok", value: "cf-token" }]);
  h.emit({ type: "extension_ui_request", method: "input", id: "acct", title: "Enter your Cloudflare account ID" });
  await h.tick();
  assert.equal(h.frames.filter((frame) => frame.type === "prompt_request").length, 2, "the panel was asked twice");
  h.channel.submit("0123456789abcdef0123456789abcdef");
  await h.tick();
  assert.deepEqual(h.sent[1], { type: "extension_ui_response", id: "acct", value: "0123456789abcdef0123456789abcdef" }, "the second answer reaches the second request, not a stale waiter");
  assert.equal(h.sent.length, 2);
  h.finish();
  await running;
});

test("omp 18.22.1+ asks its at-your-own-risk question as an input BEFORE any URL: the panel gets the whole text, and the typed answer goes back to that request", async () => {
  const h = harness();
  const running = h.surface.login("risky-provider", h.ui);
  await h.tick();
  const warning = "⚠ Antigravity CLI (Gemini, Claude, GPT-OSS): use at your own risk\n\nGoogle's guidance on third-party coding agents is inconsistent.\n\nType \"yes\" to accept the risk and continue";
  h.emit({ type: "extension_ui_request", method: "input", id: "risk-1", title: warning, placeholder: "yes" });
  await h.tick();
  assert.deepEqual(h.frames, [{ type: "prompt_request", message: warning, placeholder: "yes" }], "the text reaches the panel unchanged, line breaks included, before any URL");
  assert.deepEqual(h.sent, [], "nobody answers for the person");
  h.channel.submit("yes");
  await h.tick();
  assert.deepEqual(h.sent, [{ type: "extension_ui_response", id: "risk-1", value: "yes" }]);
  // Accepted: the sign-in goes on as any other, the URL and then the code.
  h.emit({ type: "extension_ui_request", method: "open_url", url: "https://accounts.google.com/o/oauth2/auth?x=1", instructions: "Sign in with Google" });
  h.emit({ type: "extension_ui_request", method: "input", id: "code-1", title: "Paste the code" });
  await h.tick();
  h.channel.submit("4/CODE");
  await h.tick();
  assert.deepEqual(h.sent.at(-1), { type: "extension_ui_response", id: "code-1", value: "4/CODE" });
  h.finish();
  await running;
  assert.deepEqual(h.stored, ["risky-provider"]);
});

test("any answer but yes to the at-your-own-risk question goes to omp, which ends the sign-in in its own words and stores nothing", async () => {
  const h = harness();
  const running = h.surface.login("risky-provider", h.ui);
  await h.tick();
  h.emit({ type: "extension_ui_request", method: "input", id: "risk-2", title: "⚠ Antigravity CLI: use at your own risk\n\nType \"yes\" to accept the risk and continue", placeholder: "yes" });
  await h.tick();
  h.channel.submit("no");
  await h.tick();
  assert.deepEqual(h.sent, [{ type: "extension_ui_response", id: "risk-2", value: "no" }], "whatever was typed goes to omp, which decides");
  h.fail("Login cancelled");
  await assert.rejects(running, (error) => error.message === "Login cancelled" && error.code === undefined);
  assert.deepEqual(h.stored, [], "a cancelled sign-in changes nothing");
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

test("list() flags the at-your-own-risk sign-ins as terminal-only from the omp that refuses them over RPC, and still on 18.22.2 (the pasted code is a secret prompt)", async () => {
  const roster = [
    { id: "google-antigravity", name: "Antigravity", available: true, authenticated: false },
    { id: "antigravity-cli", name: "Antigravity CLI (at your own risk)", available: true, authenticated: false },
    { id: "google-gemini-cli", name: "Gemini CLI", available: true, authenticated: false },
  ];
  const listWith = async (version) => (await createOmpProviderLogins({
    listProviders: async () => roster,
    listCredentials: async () => ({ available: false, credentials: [] }),
    engineVersion: async () => version,
  }).list()).providers.filter((provider) => provider.terminalOnly).map((provider) => provider.id);
  assert.deepEqual(await listWith("18.8.3"), [], "18.8.3 opens the browser: the button stays");
  assert.deepEqual(await listWith("18.18.6"), []);
  assert.deepEqual(await listWith("18.18.7"), ["google-antigravity"]);
  assert.deepEqual(await listWith("18.19.0"), ["google-antigravity"]);
  assert.deepEqual(await listWith("18.20.1"), ["google-antigravity"], "antigravity-cli is new in 18.20.2");
  assert.deepEqual(await listWith("18.20.2"), ["google-antigravity", "antigravity-cli"]);
  assert.deepEqual(await listWith("18.22.0"), ["google-antigravity", "antigravity-cli"]);
  assert.deepEqual(await listWith("18.22.1"), ["google-antigravity", "antigravity-cli"], "18.22.1 passes the warning on, but antigravity-cli's pasted code is a secret prompt RPC mode still refuses");
  assert.deepEqual(await listWith("18.22.2"), ["google-antigravity", "antigravity-cli"]);
  assert.deepEqual(await listWith(null), [], "an unreadable version flags nothing; the refusal itself is translated");
});

test("an engine's refusal of an interactive sign-in becomes a plain terminal_only error", async () => {
  const refusal = "Provider 'google-antigravity' requires interactive prompts which are not supported in RPC mode. Use the terminal UI to log in.";
  const surface = createOmpProviderLogins({
    createChild: () => ({
      waitReady: async () => {},
      sendCommand: async () => { throw new Error(refusal); },
      sendFrame: () => {},
      dispose: async () => {},
    }),
    afterLogin: () => { throw new Error("a refused sign-in changes nothing"); },
  });
  const h = harness();
  await assert.rejects(surface.login("google-antigravity", h.ui), (error) => {
    assert.equal(error.code, "terminal_only");
    assert.match(error.message, /\/login/);
    assert.doesNotMatch(error.message, /RPC mode/);
    return true;
  });
  // Any other failure is passed through untouched.
  const other = createOmpProviderLogins({
    createChild: () => ({ waitReady: async () => {}, sendCommand: async () => { throw new Error("network down"); }, sendFrame: () => {}, dispose: async () => {} }),
  });
  await assert.rejects(other.login("anthropic", h.ui), (error) => error.message === "network down" && error.code === undefined);
  // The secret-input variant is refused the same way.
  const secret = "Provider 'x' requires secret input, which is not supported in RPC mode.";
  assert.equal(explainLoginError("x", new Error(secret)).code, "terminal_only");
});

test("list() ranks stored credentials per provider: id-ascending positions, ranked state, disabled and signed-out rows", async () => {
  const credentials = [
    { id: 2, provider: "anthropic", type: "oauth", identity: "nitinphilip@gmail.com", planType: null, disabledCause: null, blockedUntil: "2026-09-15T00:00:00.000Z" },
    { id: 5, provider: "anthropic", type: "oauth", identity: "nathanrkx@gmail.com", planType: null, disabledCause: null, blockedUntil: null },
    { id: 1, provider: "openai-codex", type: "oauth", identity: null, planType: null, disabledCause: "revoked", blockedUntil: null },
    { id: 3, provider: "openai-codex", type: "oauth", identity: "parked@example.com", planType: null, disabledCause: "logged out by user", blockedUntil: null },
  ];
  const usageAccounts = [
    { provider: "anthropic", id: "nitinphilip@gmail.com", identity: "nitinphilip@gmail.com", label: "Anthropic", planType: "pro", unlimited: false, windows: [{ id: "anthropic:7d", label: "7-day window", utilization: 100, resetsAt: "2026-09-15T00:00:00.000Z", state: "exhausted" }] },
    { provider: "anthropic", id: "nathanrkx@gmail.com", identity: "nathanrkx@gmail.com", label: "Anthropic", planType: "max", unlimited: false, windows: [{ id: "anthropic:7d", label: "7-day window", utilization: 1, resetsAt: "2026-09-20T00:00:00.000Z", state: "ok" }] },
  ];
  const surface = createOmpProviderLogins({
    listProviders: async () => [
      { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
      { id: "openai-codex", name: "OpenAI Codex", available: true, authenticated: false },
    ],
    listCredentials: async () => ({ available: true, credentials }),
    listUsage: async () => ({ accounts: usageAccounts }),
  });
  const list = await surface.list();
  const anthropic = list.providers.find((provider) => provider.id === "anthropic");
  assert.equal(anthropic.multiAccount, true);
  assert.equal(anthropic.canLogout, true);
  assert.deepEqual(anthropic.accounts, [
    { id: "2", label: "nitinphilip@gmail.com", position: 0, state: "limited", planType: "pro", resetsAt: "2026-09-15T00:00:00.000Z", canRemove: true },
    { id: "5", label: "nathanrkx@gmail.com", position: 1, state: "in_use", planType: "max", resetsAt: null, canRemove: true },
  ]);
  const codex = list.providers.find((provider) => provider.id === "openai-codex");
  assert.equal(codex.multiAccount, true);
  assert.deepEqual(codex.accounts, [
    { id: "1", label: "OpenAI Codex", position: 0, state: "signed_out", planType: null, resetsAt: null, canRemove: true },
    { id: "3", label: "parked@example.com", position: 1, state: "disabled", planType: null, resetsAt: null, canRemove: true },
  ]);
});

test("removeAccount delegates the numeric credential id and reports the bridge's outcome", async () => {
  const calls = [];
  const surface = createOmpProviderLogins({
    listProviders: async () => [],
    removeCredential: async (provider, credentialId) => { calls.push({ provider, credentialId }); return { removed: true, providerRemoved: false }; },
  });
  const outcome = await surface.removeAccount("anthropic", "5");
  assert.deepEqual(outcome, { removed: true, providerRemoved: false });
  assert.deepEqual(calls, [{ provider: "anthropic", credentialId: 5 }]);
});

test("removeAccount rejects a non-numeric account id without calling the bridge", async () => {
  const surface = createOmpProviderLogins({
    listProviders: async () => [],
    removeCredential: async () => { throw new Error("must not be called"); },
  });
  await assert.rejects(surface.removeAccount("anthropic", "not-a-number"));
});

test("removeAccount rejects with the bridge's own message on failure", async () => {
  const surface = createOmpProviderLogins({
    listProviders: async () => [],
    removeCredential: async () => ({ removed: false, providerRemoved: false, code: "unsupported", message: "OMP runtime is not installed." }),
  });
  await assert.rejects(surface.removeAccount("anthropic", "2"), /not installed/);
});

test("logout removes every credential for the provider, idempotent when nothing was there", async () => {
  const calls = [];
  const surface = createOmpProviderLogins({
    listProviders: async () => [],
    removeProvider: async (provider) => { calls.push(provider); return { removed: false, providerRemoved: false }; },
  });
  const outcome = await surface.logout("anthropic");
  assert.deepEqual(calls, ["anthropic"]);
  assert.deepEqual(outcome, { removed: false, count: 0 }, "nothing stored is reported as nothing removed, never as success");
});

test("logout says how many stored accounts it signed out", async () => {
  const surface = createOmpProviderLogins({
    listProviders: async () => [],
    removeProvider: async () => ({ removed: true, providerRemoved: true, count: 2 }),
  });
  assert.deepEqual(await surface.logout("anthropic"), { removed: true, count: 2 });
});

test("logout rejects with the bridge's own message on failure", async () => {
  const surface = createOmpProviderLogins({
    listProviders: async () => [],
    removeProvider: async () => ({ removed: false, providerRemoved: false, code: "credential_remove_failed", message: "boom" }),
  });
  await assert.rejects(surface.logout("anthropic"), /boom/);
});
