import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * A phone taps a button: an unauthenticated POST carrying only a token. These
 * drive the real route and the real token/recipient/settings code against fake
 * live sessions, and pin everything that must NOT answer: a used, forged or
 * expired button, a request that is gone or has changed, a person who is no
 * longer entitled.
 */
const root = mkdtempSync(join(tmpdir(), "cody-notify-action-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../../app/api/notifications/action/route.ts");
const dispatch = await jiti.import("./dispatch.ts");
const compose = await jiti.import("./compose.ts");
const store = await jiti.import("./store.ts");
const tokens = await jiti.import("./tokens.ts");
const users = await jiti.import("../auth/users.ts");
const owners = await jiti.import("../auth/session-owners.ts");

const configure = (patch = {}, key = "__instance") =>
  store.updateNotificationPrefs(key, { enabled: true, server: "https://ntfy.test", topic: "mytopic", codyUrl: "https://cody.test", answerButtons: true, ...patch });

/** Capture ntfy traffic (publishes and clears). */
function stubNetwork() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A live session in the registry, with dialogs and approvals it is "waiting"
 * on. `send` removes what it answers, as the real ones do.
 */
function liveSession(id, { alive = true, onSend } = {}) {
  const pendingUi = new Map();
  const pendingPermission = new Map();
  const sent = [];
  const session = {
    sessionId: id,
    sessionFile: "",
    cwd: root,
    isAlive: () => alive,
    getPendingUiRequest: (requestId) => pendingUi.get(requestId) ?? null,
    getPendingPermission: (requestId) => pendingPermission.get(requestId) ?? null,
    send: async (command) => {
      sent.push(command);
      if (onSend) return onSend(command, { pendingUi, pendingPermission });
      if (command.type === "extension_ui_response") pendingUi.delete(command.id);
      if (command.type === "respond_permission") {
        const had = pendingPermission.delete(command.requestId);
        return { answered: had };
      }
      return null;
    },
  };
  (globalThis.__ompSessions ??= new Map()).set(id, session);
  return { session, pendingUi, pendingPermission, sent, kill: () => globalThis.__ompSessions.delete(id) };
}

/** The buttons a phone would show for this pending request: sent through the real dispatcher, read back off the wire. */
async function buttonsFor(sessionId, { ui, permission }) {
  const net = stubNetwork();
  try {
    const offer = ui ? compose.answerOfferForUiRequest(ui) : compose.answerOfferForPermission(permission);
    assert.ok(offer, "the request offers buttons");
    dispatch.sendNotification({
      event: "approval",
      sessionId: sessionId,
      title: "Approval needed · Fix login",
      body: "x",
      tags: [],
      requestKey: offer.requestId,
      offer,
    });
    const deadline = Date.now() + 2_000;
    while (net.calls.length === 0 && Date.now() < deadline) await settle(5);
    const { actions } = net.calls[0].body;
    return actions.map((action) => ({ label: action.label, url: action.url, body: action.body, token: JSON.parse(action.body).t }));
  } finally {
    net.restore();
  }
}

const post = (body, init = {}) =>
  route.POST(new Request("http://cody.test/api/notifications/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...init.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

const tap = (button) => post(button.body);

const confirmRequest = (id = "r1") => ({ id, method: "confirm", title: "Allow tool: bash", message: "npm test" });
const permissionRequest = (id = "perm-1", toolTitle = "Run npm test") => ({
  type: "permission_request",
  requestId: id,
  toolCall: { title: toolTitle },
  options: [
    { optionId: "yes", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "no", name: "Deny", kind: "reject_once" },
  ],
});

const json = async (response) => ({ status: response.status, body: await response.json() });

test("a valid button answers the waiting dialog exactly once with the command the browser would send", async () => {
  configure();
  const live = liveSession("sess-a");
  live.pendingUi.set("r1", confirmRequest("r1"));
  const [allow, deny] = await buttonsFor("sess-a", { ui: confirmRequest("r1") });
  assert.deepEqual([allow.label, deny.label], ["Allow", "Deny"]);

  const net = stubNetwork();
  try {
    const first = await tap(allow);
    assert.deepEqual(await json(first), { status: 200, body: { ok: true } });
    assert.deepEqual(live.sent, [{ type: "extension_ui_response", id: "r1", confirmed: true }]);
    assert.equal(first.headers.get("access-control-allow-origin"), "*");
    assert.equal(first.headers.get("cache-control"), "no-store");

    // Clearing the notification is the observer's job once the request
    // resolves (end-to-end.test.mjs); the route itself sends nothing to ntfy.
    await settle();
    assert.equal(net.calls.filter((call) => call.method === "PUT").length, 0);

    // The same button again: spent.
    const again = await json(await tap(allow));
    assert.equal(again.status, 401);
    assert.equal(again.body.code, "invalid_token");
    assert.equal(live.sent.length, 1, "never answered twice");

    // The other button on the same notification: the request is gone now.
    const other = await json(await tap(deny));
    assert.equal(other.status, 410);
    assert.equal(other.body.code, "gone");
    assert.equal(live.sent.length, 1);
  } finally {
    net.restore();
    live.kill();
  }
});

test("each kind of dialog is answered in omp's own shape: select by option text, ask by question id and label", async () => {
  configure();
  const live = liveSession("sess-b");
  const select = { id: "sel", method: "select", title: "Pick", options: ["red", "green", "blue"] };
  const ask = { id: "ask", method: "ask", questions: [{ id: "q1", question: "Which?", options: [{ label: "Alpha" }, { label: "Beta" }] }] };
  live.pendingUi.set("sel", select);
  live.pendingUi.set("ask", ask);
  const selectButtons = await buttonsFor("sess-b", { ui: select });
  const askButtons = await buttonsFor("sess-b", { ui: ask });
  try {
    assert.equal((await tap(selectButtons[1])).status, 200);
    assert.equal((await tap(askButtons[0])).status, 200);
    assert.deepEqual(live.sent, [
      { type: "extension_ui_response", id: "sel", value: "green" },
      { type: "extension_ui_response", id: "ask", answers: [{ id: "q1", selectedOptions: ["Alpha"] }] },
    ]);
  } finally {
    live.kill();
  }
});

test("an ACP approval is answered with respond_permission and its one-shot option", async () => {
  configure();
  const live = liveSession("sess-acp");
  live.pendingPermission.set("perm-1", permissionRequest("perm-1"));
  const [allow, deny] = await buttonsFor("sess-acp", { permission: permissionRequest("perm-1") });
  try {
    assert.deepEqual([allow.label, deny.label], ["Allow", "Deny"]);
    assert.equal((await tap(deny)).status, 200);
    assert.deepEqual(live.sent, [{ type: "respond_permission", requestId: "perm-1", optionId: "no" }]);
  } finally {
    live.kill();
  }
});

test("a lasting grant can never be answered from a phone, even by a button that claims to", async () => {
  configure();
  const live = liveSession("sess-always");
  live.pendingPermission.set("perm-1", permissionRequest("perm-1"));
  const digest = compose.permissionDigest(permissionRequest("perm-1").toolCall, permissionRequest("perm-1").options);
  // Signed with the real key: only the answer route's own rule can stop this.
  const forged = tokens.issueAnswerToken({ sid: "sess-always", rid: "perm-1", u: "__instance", k: "permission", d: digest, a: { optionId: "always" } });
  try {
    const result = await json(await post({ t: forged }));
    assert.equal(result.status, 410);
    assert.deepEqual(live.sent, []);
  } finally {
    live.kill();
  }
});

test("only an answer the request itself offers is forwarded, rebuilt clean: nothing extra rides along", async () => {
  configure();
  const live = liveSession("sess-shape");
  const select = { id: "sel", method: "select", title: "Pick", options: ["red", "green"] };
  const confirm = confirmRequest("cf");
  const ask = { id: "ask", method: "ask", questions: [{ id: "q1", question: "Which?", options: [{ label: "Alpha" }, { label: "Beta" }] }] };
  live.pendingUi.set("sel", select);
  live.pendingUi.set("cf", confirm);
  live.pendingUi.set("ask", ask);
  // Signed with the real key and the right digest, so only the route's own answer check can stop these.
  const answer = (request, a) => post({
    t: tokens.issueAnswerToken({ sid: "sess-shape", rid: request.id, u: "__instance", k: "ui", d: compose.uiRequestDigest(request), a }),
  });
  try {
    for (const [request, a] of [
      [select, { value: "purple" }],
      [select, { value: 5 }],
      [select, { confirmed: true }],
      [confirm, { confirmed: "yes" }],
      [confirm, { value: "x" }],
      [ask, { answers: [{ id: "q1", selectedOptions: ["Gamma"] }] }],
      [ask, { answers: [{ id: "q1", selectedOptions: ["Alpha", "Beta"] }] }],
      [ask, { answers: [{ id: "other", selectedOptions: ["Alpha"] }] }],
      [ask, { answers: [] }],
      [ask, { value: "Alpha" }],
    ]) {
      assert.equal((await answer(request, a)).status, 410, JSON.stringify(a));
    }
    assert.deepEqual(live.sent, []);

    assert.equal((await answer(confirm, { confirmed: true, cancelled: true, extra: "x" })).status, 200);
    assert.equal((await answer(ask, { answers: [{ id: "q1", selectedOptions: ["Alpha"], customInput: "evil" }] })).status, 200);
    assert.deepEqual(live.sent, [
      { type: "extension_ui_response", id: "cf", confirmed: true },
      { type: "extension_ui_response", id: "ask", answers: [{ id: "q1", selectedOptions: ["Alpha"] }] },
    ]);
  } finally {
    live.kill();
  }
});

test("a request that is gone is 410 gone: no session, a dead session, nothing waiting, or an option that no longer exists", async () => {
  configure();
  // No such session.
  const [orphan] = await buttonsFor("nowhere", { ui: confirmRequest("r1") });
  assert.deepEqual(await json(await tap(orphan)), { status: 410, body: { error: "That request is no longer waiting for an answer.", code: "gone" } });

  // A dead session.
  const dead = liveSession("sess-dead", { alive: false });
  dead.pendingUi.set("r1", confirmRequest("r1"));
  const [deadButton] = await buttonsFor("sess-dead", { ui: confirmRequest("r1") });
  assert.equal((await tap(deadButton)).status, 410);
  assert.deepEqual(dead.sent, []);
  dead.kill();

  // Alive, but the dialog was answered elsewhere.
  const answered = liveSession("sess-answered");
  const [answeredButton] = await buttonsFor("sess-answered", { ui: confirmRequest("r1") });
  assert.equal((await tap(answeredButton)).status, 410);
  assert.deepEqual(answered.sent, []);
  answered.kill();

  // A select whose option has since gone.
  const changed = liveSession("sess-changed");
  const select = { id: "sel", method: "select", title: "Pick", options: ["red", "green"] };
  const [red, green] = await buttonsFor("sess-changed", { ui: select });
  changed.pendingUi.set("sel", { ...select, options: ["red"] });
  assert.equal((await tap(green)).status, 410, "the option is gone");
  assert.equal((await tap(red)).status, 410, "and the request is no longer the one the button was made for");
  assert.deepEqual(changed.sent, []);
  changed.kill();
});

test("an id reused for a DIFFERENT request is not answered: after a restart perm-1 can be something else entirely", async () => {
  configure();
  const live = liveSession("sess-reused");
  const [allow] = await buttonsFor("sess-reused", { permission: permissionRequest("perm-1", "Run npm test") });
  live.pendingPermission.set("perm-1", permissionRequest("perm-1", "Run rm -rf /"));
  try {
    assert.equal((await tap(allow)).status, 410);
    assert.deepEqual(live.sent, [], "the stale 'Allow' did not approve the new command");
  } finally {
    live.kill();
  }
  const omp = liveSession("sess-reused-omp");
  const [yes] = await buttonsFor("sess-reused-omp", { ui: confirmRequest("r1") });
  omp.pendingUi.set("r1", { ...confirmRequest("r1"), message: "rm -rf /" });
  try {
    assert.equal((await tap(yes)).status, 410);
    assert.deepEqual(omp.sent, []);
  } finally {
    omp.kill();
  }
});

test("ACP says it was already settled: that is gone, not an error", async () => {
  configure();
  const live = liveSession("sess-race", { onSend: async () => ({ answered: false }) });
  live.pendingPermission.set("perm-1", permissionRequest("perm-1"));
  const [allow] = await buttonsFor("sess-race", { permission: permissionRequest("perm-1") });
  try {
    assert.deepEqual((await json(await tap(allow))).body.code, "gone");
  } finally {
    live.kill();
  }
});

test("a forged, altered, expired or foreign token is 401 invalid_token and answers nothing", async () => {
  configure();
  const live = liveSession("sess-forge");
  live.pendingUi.set("r1", confirmRequest("r1"));
  const [allow] = await buttonsFor("sess-forge", { ui: confirmRequest("r1") });
  try {
    const [payload, signature] = allow.token.split(".");
    const edited = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    edited.a = { confirmed: false };
    const tampered = `${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${signature}`;
    for (const bad of [tampered, `${payload}.${signature.slice(0, -3)}AAA`, "garbage", "", `${allow.token}.extra`]) {
      const result = await json(await post({ t: bad }));
      assert.equal(result.status, 401, bad.slice(0, 20));
      assert.equal(result.body.code, "invalid_token");
    }
    for (const body of [{}, { t: 7 }, { t: null }, { token: allow.token }, [], "null", "not json at all"]) {
      const result = await json(await post(body));
      assert.ok(result.status === 401 || result.status === 400, JSON.stringify(body));
      assert.ok(["invalid_token", "invalid_body"].includes(result.body.code));
    }
    assert.deepEqual(live.sent, []);

    const expired = tokens.issueAnswerToken({
      sid: "sess-forge", rid: "r1", u: "__instance", k: "ui", d: compose.uiRequestDigest(confirmRequest("r1")), a: { confirmed: true }, expiresAt: Date.now() - 1_000,
    }, Date.now() - 10_000);
    const result = await json(await post({ t: expired }));
    assert.equal(result.status, 401);
    assert.match(result.body.error, /expired/);
    assert.deepEqual(live.sent, []);
    assert.equal((await tap(allow)).status, 200, "and the genuine button still works after all of that");
  } finally {
    live.kill();
  }
});

test("an oversized or malformed body is a 400 and is never read as a token", async () => {
  const huge = await json(await post(JSON.stringify({ t: "x".repeat(20_000) })));
  assert.equal(huge.status, 400);
  assert.equal(huge.body.code, "invalid_body");
  assert.equal((await json(await post("{ not json"))).status, 400);
});

test("turning answer buttons off, or notifications off, kills every button already on a phone", async () => {
  configure();
  const live = liveSession("sess-off");
  live.pendingUi.set("r1", confirmRequest("r1"));
  const [first, second, third] = [
    ...(await buttonsFor("sess-off", { ui: confirmRequest("r1") })),
    ...(await buttonsFor("sess-off", { ui: confirmRequest("r1") })),
  ];
  try {
    configure({ answerButtons: false });
    let result = await json(await tap(first));
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "forbidden");
    configure({ answerButtons: true, enabled: false });
    result = await json(await tap(second));
    assert.equal(result.status, 403);
    assert.deepEqual(live.sent, []);
    configure();
    assert.equal((await tap(third)).status, 200, "a button from before still works once the person is back to entitled");
    assert.equal(live.sent.length, 1);
  } finally {
    live.kill();
  }
});

test("a button stops working when its chat stops being the person's", async () => {
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "member" });
  const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "admin" });
  configure({}, alice.id);
  configure({}, bob.id);
  owners.setSessionOwner("sess-owned", alice.id);
  const live = liveSession("sess-owned");
  live.pendingUi.set("r1", confirmRequest("r1"));
  const [allow] = await buttonsFor("sess-owned", { ui: confirmRequest("r1") });
  const payload = tokens.verifyAnswerToken(allow.token).payload;
  assert.equal(payload.u, alice.id, "issued to the chat's owner");
  try {
    owners.setSessionOwner("sess-owned", bob.id);
    const result = await json(await tap(allow));
    assert.equal(result.status, 403);
    assert.deepEqual(live.sent, []);
  } finally {
    live.kill();
  }
});

test("two taps racing on one button: exactly one answers", async () => {
  configure();
  const live = liveSession("sess-race2", { onSend: async (command, { pendingUi }) => { await settle(30); pendingUi.delete(command.id); return null; } });
  live.pendingUi.set("r1", confirmRequest("r1"));
  const [allow] = await buttonsFor("sess-race2", { ui: confirmRequest("r1") });
  try {
    const [a, b] = await Promise.all([tap(allow), tap(allow)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 401]);
    assert.equal(live.sent.length, 1);
  } finally {
    live.kill();
  }
});

test("when the chat is restarting the button is handed back: 503, and the person can tap again", async () => {
  configure();
  let calls = 0;
  const live = liveSession("sess-restart", {
    onSend: async (command, { pendingUi }) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("The session is restarting"), { code: "session_restarting" });
      pendingUi.delete(command.id);
      return null;
    },
  });
  live.pendingUi.set("r1", confirmRequest("r1"));
  const [allow] = await buttonsFor("sess-restart", { ui: confirmRequest("r1") });
  try {
    const first = await json(await tap(allow));
    assert.equal(first.status, 503);
    assert.equal(first.body.code, "session_restarting");
    assert.equal((await tap(allow)).status, 200, "not spent: it never reached the session");
    assert.equal(live.sent.length, 2);
  } finally {
    live.kill();
  }
});

test("a session that died under the answer is gone; any other failure is 502 and is handed back too", async () => {
  configure();
  const dying = liveSession("sess-dying", { onSend: async () => { throw Object.assign(new Error("dead"), { code: "session_dead" }); } });
  dying.pendingUi.set("r1", confirmRequest("r1"));
  const [dyingButton] = await buttonsFor("sess-dying", { ui: confirmRequest("r1") });
  assert.equal((await json(await tap(dyingButton))).body.code, "gone");
  dying.kill();

  let attempts = 0;
  const flaky = liveSession("sess-flaky", {
    onSend: async (command, { pendingUi }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("socket hang up");
      pendingUi.delete(command.id);
      return null;
    },
  });
  flaky.pendingUi.set("r1", confirmRequest("r1"));
  const [flakyButton] = await buttonsFor("sess-flaky", { ui: confirmRequest("r1") });
  try {
    const failed = await json(await tap(flakyButton));
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, "answer_failed");
    assert.equal((await tap(flakyButton)).status, 200);
  } finally {
    flaky.kill();
  }
});

test("the browser's preflight is answered: ntfy's web app asks before it posts", async () => {
  const response = route.OPTIONS(new Request("http://cody.test/api/notifications/action", {
    method: "OPTIONS",
    headers: { Origin: "https://ntfy.example.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("access-control-allow-methods"), /POST/);
  assert.match(response.headers.get("access-control-allow-methods"), /OPTIONS/);
  assert.match(response.headers.get("access-control-allow-headers"), /Content-Type/i);
  assert.equal(await response.text(), "");
});

test("every answer carries the CORS headers, failures included, so the web app can read why", async () => {
  const bad = await post({ t: "nope" });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("access-control-allow-origin"), "*");
  const malformed = await post("{ nope");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("access-control-allow-origin"), "*");
});

test("the route reads no cookie: a request carrying someone's session cookie is treated exactly like one without", async () => {
  configure();
  const live = liveSession("sess-cookie");
  live.pendingUi.set("r1", confirmRequest("r1"));
  const [allow] = await buttonsFor("sess-cookie", { ui: confirmRequest("r1") });
  try {
    const refused = await json(await post({ t: "forged" }, { headers: { Cookie: "cody_session=whatever" } }));
    assert.equal(refused.status, 401, "a cookie is no substitute for the token");
    const accepted = await post(allow.body, { headers: { Cookie: "cody_session=whatever" } });
    assert.equal(accepted.status, 200);
  } finally {
    live.kill();
  }
});
