import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * From a draft to a published message, through the REAL settings store and
 * recipient resolution, with only the network stubbed: who is sent what, how
 * loudly, with which buttons, and what is suppressed.
 */
const root = mkdtempSync(join(tmpdir(), "cody-notify-dispatch-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const dispatch = await jiti.import("./dispatch.ts");
const compose = await jiti.import("./compose.ts");
const store = await jiti.import("./store.ts");
const presence = await jiti.import("./presence.ts");
const tokens = await jiti.import("./tokens.ts");
const paths = await jiti.import("../auth/paths.ts");
const users = await jiti.import("../auth/users.ts");
const owners = await jiti.import("../auth/session-owners.ts");

/** Capture what would go to ntfy. `delayFor(call)` can hold an answer back. */
function stubNetwork({ status = 200, delayFor = () => 0 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const call = {
      url: String(url),
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null,
      startedAt: calls.length,
      finished: false,
    };
    calls.push(call);
    const delay = delayFor(call);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    call.finished = true;
    if (status === "throw") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(status === 200 ? { id: "m1" } : { code: 50000, http: status, error: "ntfy says no" }), { status });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Wait until `count` requests were made (publishing is fire-and-forget). */
async function until(calls, count, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (calls.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return calls;
}

const quiet = () => new Promise((resolve) => setTimeout(resolve, 60));

const configure = (patch = {}, key = "__instance") =>
  store.updateNotificationPrefs(key, { enabled: true, server: "https://ntfy.test", topic: "mytopic", token: "tk_abc", codyUrl: "https://cody.test", ...patch });

const draftOf = (fields = {}) => ({
  event: "approval",
  sessionId: "sess-1",
  title: "Approval needed · Fix login",
  body: "Tool: bash\nnpm test",
  tags: ["my-project"],
  ...fields,
});

const approvalOffer = () =>
  compose.answerOfferForUiRequest({ id: "r1", method: "confirm", title: "Allow tool: bash", message: "npm test", expiresAt: undefined });

test("a configured recipient gets the message as ntfy JSON, with everything the draft says", async () => {
  configure();
  const net = stubNetwork();
  try {
    assert.ok(dispatch.sendNotification(draftOf({ requestKey: "r1", offer: approvalOffer() })));
    await until(net.calls, 1);
    assert.equal(net.calls.length, 1);
    const [call] = net.calls;
    assert.equal(call.url, "https://ntfy.test/");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.Authorization, "Bearer tk_abc");
    assert.equal(call.body.topic, "mytopic");
    assert.equal(call.body.title, "Approval needed · Fix login");
    assert.equal(call.body.message, "Tool: bash\nnpm test");
    assert.equal(call.body.priority, 4, "approval's default priority");
    assert.deepEqual(call.body.tags, ["lock", "my-project"]);
    assert.equal(call.body.click, "https://cody.test/?session=sess-1");
    assert.equal(call.body.sequence_id, compose.sequenceIdFor("sess-1", "r1"));
  } finally {
    net.restore();
  }
});

test("answer buttons are ntfy http actions, each carrying its own signed single-answer token", async () => {
  configure();
  const net = stubNetwork();
  try {
    dispatch.sendNotification(draftOf({ requestKey: "r1", offer: approvalOffer() }));
    await until(net.calls, 1);
    const { actions } = net.calls[0].body;
    assert.deepEqual(actions.map((action) => action.label), ["Allow", "Deny"]);
    for (const action of actions) {
      assert.equal(action.action, "http");
      assert.equal(action.url, "https://cody.test/api/notifications/action");
      assert.equal(action.method, "POST");
      assert.deepEqual(action.headers, { "Content-Type": "application/json" });
      assert.equal(action.clear, true);
    }
    const payloads = actions.map((action) => {
      const body = JSON.parse(action.body);
      assert.deepEqual(Object.keys(body), ["t"]);
      const verdict = tokens.verifyAnswerToken(body.t);
      assert.equal(verdict.ok, true);
      return verdict.payload;
    });
    assert.deepEqual(payloads.map((p) => p.a), [{ confirmed: true }, { confirmed: false }]);
    for (const payload of payloads) {
      assert.equal(payload.sid, "sess-1");
      assert.equal(payload.rid, "r1");
      assert.equal(payload.u, "__instance");
      assert.equal(payload.k, "ui");
    }
    assert.notEqual(payloads[0].n, payloads[1].n, "separate tokens");
    assert.ok(payloads.every((payload) => payload.exp > Date.now() && payload.exp <= Date.now() + 24 * 3600_000));
  } finally {
    net.restore();
  }
});

test("a button never outlives the request's own deadline, and none is offered for a request already past it", async () => {
  configure();
  const net = stubNetwork();
  try {
    const soon = Date.now() + 90_000;
    const offer = compose.answerOfferForUiRequest({ id: "r1", method: "confirm", title: "Allow tool: bash", expiresAt: soon });
    dispatch.sendNotification(draftOf({ requestKey: "r1", offer }));
    await until(net.calls, 1);
    const payload = tokens.verifyAnswerToken(JSON.parse(net.calls[0].body.actions[0].body).t).payload;
    assert.equal(payload.exp, soon);

    const expired = compose.answerOfferForUiRequest({ id: "r2", method: "confirm", title: "Allow tool: bash", expiresAt: Date.now() - 1 });
    dispatch.sendNotification(draftOf({ requestKey: "r2", offer: expired }));
    await until(net.calls, 2);
    assert.equal("actions" in net.calls[1].body, false);
  } finally {
    net.restore();
  }
});

test("no buttons when they are switched off, when Cody's address is unknown, or when the request offers none", async () => {
  const net = stubNetwork();
  try {
    configure({ answerButtons: false });
    dispatch.sendNotification(draftOf({ requestKey: "r1", offer: approvalOffer() }));
    configure({ answerButtons: true, codyUrl: "" });
    dispatch.sendNotification(draftOf({ requestKey: "r1", offer: approvalOffer() }));
    configure({ answerButtons: true, codyUrl: "https://cody.test" });
    dispatch.sendNotification(draftOf({ requestKey: "r1" }));
    await until(net.calls, 3);
    assert.equal(net.calls.length, 3);
    for (const call of net.calls) assert.equal("actions" in call.body, false);
    assert.equal("click" in net.calls[1].body, false, "no address, no link back either");
    assert.equal(net.calls[0].body.click, "https://cody.test/?session=sess-1", "buttons off still links to the chat");
  } finally {
    net.restore();
  }
});

test("an anonymous topic is published to without an Authorization header", async () => {
  configure({ token: null });
  const net = stubNetwork();
  try {
    dispatch.sendNotification(draftOf());
    await until(net.calls, 1);
    assert.equal(net.calls[0].headers.Authorization, undefined);
  } finally {
    net.restore();
  }
});

test("each recipient's own priority for the kind is used", async () => {
  const net = stubNetwork();
  try {
    configure({ events: { approval: { priority: 5 }, finished: { priority: 1 } } });
    dispatch.sendNotification(draftOf());
    dispatch.sendNotification(draftOf({ event: "finished", runMs: 999_999 }));
    await until(net.calls, 2);
    assert.deepEqual(net.calls.map((call) => call.body.priority), [5, 1]);
    assert.deepEqual(net.calls.map((call) => call.body.tags[0]), ["lock", "white_check_mark"]);
  } finally {
    net.restore();
    configure({ events: { approval: { priority: 4 }, finished: { priority: 3 } } });
  }
});

test("nothing is sent while unconfigured, switched off, or with that kind off", async () => {
  const net = stubNetwork();
  try {
    configure({ enabled: false });
    assert.equal(dispatch.sendNotification(draftOf()), null);
    configure({ enabled: true, server: "" });
    assert.equal(dispatch.sendNotification(draftOf()), null);
    configure({ server: "https://ntfy.test", topic: "" });
    assert.equal(dispatch.sendNotification(draftOf()), null);
    configure({ topic: "mytopic", events: { approval: { enabled: false } } });
    assert.equal(dispatch.sendNotification(draftOf()), null);
    assert.ok(dispatch.sendNotification(draftOf({ event: "question" })), "another kind is unaffected");
    await quiet();
    assert.equal(net.calls.length, 1);
  } finally {
    net.restore();
    configure({ events: { approval: { enabled: true } } });
  }
});

test("a run that finished too quickly is not announced; the owner's minimum decides, 0 meaning always", async () => {
  const net = stubNetwork();
  try {
    configure({ finishedMinSeconds: 60 });
    assert.equal(dispatch.sendNotification(draftOf({ event: "finished", runMs: 59_999 })), null);
    assert.ok(dispatch.sendNotification(draftOf({ event: "finished", runMs: 60_000 })));
    configure({ finishedMinSeconds: 0 });
    assert.ok(dispatch.sendNotification(draftOf({ event: "finished", runMs: 0 })));
    configure({ finishedMinSeconds: 60 });
    assert.equal(dispatch.sendNotification(draftOf({ event: "finished" })), null, "a run of unknown length counts as zero");
    await until(net.calls, 2);
    assert.equal(net.calls.length, 2);
  } finally {
    net.restore();
  }
});

test("waiting falls through to finished for an owner who turned waiting off, and respects the minimum then", async () => {
  const net = stubNetwork();
  try {
    const chain = (runMs) => draftOf({
      event: "waiting",
      title: "Waiting for your reply · Fix login",
      body: "… Which one?",
      fallback: draftOf({ event: "finished", title: "Reply finished · Fix login", body: "I looked at both.", runMs }),
    });
    configure({ finishedMinSeconds: 60, events: { waiting: { enabled: true } } });
    dispatch.sendNotification(chain(5_000));
    configure({ events: { waiting: { enabled: false } } });
    dispatch.sendNotification(chain(120_000));
    assert.equal(dispatch.sendNotification(chain(5_000)), null, "waiting off, and too short to be 'finished': silence");
    configure({ events: { waiting: { enabled: false }, finished: { enabled: false } } });
    assert.equal(dispatch.sendNotification(chain(120_000)), null, "both off");
    await until(net.calls, 2);
    assert.deepEqual(net.calls.map((call) => call.body.title), ["Waiting for your reply · Fix login", "Reply finished · Fix login"]);
  } finally {
    net.restore();
    configure({ events: { waiting: { enabled: true }, finished: { enabled: true } } });
  }
});

test("someone looking at this very chat is not told about it — only them, and only this chat", async () => {
  const net = stubNetwork();
  try {
    configure({ skipWhenViewing: true });
    presence.recordPresence("__instance", "sess-1");
    assert.equal(dispatch.sendNotification(draftOf()), null, "viewing the chat: skipped");
    assert.ok(dispatch.sendNotification(draftOf({ sessionId: "sess-2" })), "another chat is not");

    presence.recordPresence("__instance", "sess-1", Date.now() - 80_000);
    assert.ok(dispatch.sendNotification(draftOf()), "a report that old no longer counts");

    presence.recordPresence("__instance", "sess-1");
    presence.recordPresence("__instance", null);
    assert.ok(dispatch.sendNotification(draftOf()), "tab hidden: not viewing");

    presence.recordPresence("__instance", "sess-1");
    configure({ skipWhenViewing: false });
    assert.ok(dispatch.sendNotification(draftOf()), "unless they asked to hear about it anyway");
    await until(net.calls, 4);
    assert.equal(net.calls.length, 4);
  } finally {
    net.restore();
    presence.recordPresence("__instance", null);
    configure({ skipWhenViewing: true });
  }
});

test("taking a notification down waits for its publish, then clears it by sequence id; once", async () => {
  configure();
  const net = stubNetwork({ delayFor: (call) => (call.method === "POST" ? 80 : 0) });
  try {
    const sent = dispatch.sendNotification(draftOf({ requestKey: "r1", offer: approvalOffer() }));
    sent.clear();
    sent.clear();
    await until(net.calls, 2, 3_000);
    await quiet();
    assert.equal(net.calls.length, 2, "one publish, one clear, however many times clear() was called");
    const [publish, clear] = net.calls;
    assert.equal(publish.method, "POST");
    assert.equal(clear.method, "PUT");
    assert.equal(clear.url, `https://ntfy.test/mytopic/${compose.sequenceIdFor("sess-1", "r1")}/clear`);
    assert.equal(clear.headers.Authorization, "Bearer tk_abc");
    assert.equal(publish.finished, true, "the publish was complete before the clear was sent");
  } finally {
    net.restore();
  }
});

test("a notification with no request behind it has nothing to clear", async () => {
  configure();
  const net = stubNetwork();
  try {
    const sent = dispatch.sendNotification(draftOf({ event: "finished", runMs: 999_999 }));
    sent.clear();
    await until(net.calls, 1);
    await quiet();
    assert.deepEqual(net.calls.map((call) => call.method), ["POST"]);
  } finally {
    net.restore();
  }
});

test("a clear goes to the topic the notification was sent to, even if the settings changed since", async () => {
  configure({ topic: "first_topic" });
  const net = stubNetwork();
  try {
    const sent = dispatch.sendNotification(draftOf({ requestKey: "r1" }));
    await until(net.calls, 1);
    configure({ topic: "second_topic", token: "tk_other" });
    sent.clear();
    await until(net.calls, 2);
    assert.equal(net.calls[1].url, `https://ntfy.test/first_topic/${compose.sequenceIdFor("sess-1", "r1")}/clear`);
    assert.equal(net.calls[1].headers.Authorization, "Bearer tk_abc", "with the credentials it was sent with");
  } finally {
    net.restore();
    configure({ topic: "mytopic", token: "tk_abc" });
  }
});

test("a dead or refusing ntfy server never throws into the caller, and is logged once a minute without the topic or token", async () => {
  configure({ topic: "super_secret_topic", token: "tk_super_secret_token", server: "https://ntfy.test:8443" });
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  globalThis.__codyNotificationLogAt?.clear();
  try {
    for (const status of [500, "throw", 403]) {
      const net = stubNetwork({ status });
      try {
        assert.doesNotThrow(() => dispatch.sendNotification(draftOf()));
        await until(net.calls, 1);
      } finally {
        net.restore();
      }
    }
    assert.equal(lines.length, 1, "three failures inside a minute are one line");
    assert.match(lines[0], /publish failed for ntfy\.test:8443: ntfy says no \(HTTP 500\)/);
    assert.ok(!lines[0].includes("super_secret_topic"));
    assert.ok(!lines[0].includes("tk_super_secret_token"));

    globalThis.__codyNotificationLogAt.set("__instance", Date.now() - 61_000);
    const net = stubNetwork({ status: "throw" });
    try {
      dispatch.sendNotification(draftOf());
      await until(net.calls, 1);
    } finally {
      net.restore();
    }
    assert.equal(lines.length, 2, "a minute later it speaks again");
    assert.match(lines[1], /Could not reach the ntfy server/);
  } finally {
    console.warn = originalWarn;
    configure({ topic: "mytopic", token: "tk_abc", server: "https://ntfy.test" });
  }
});

test("a corrupted settings file means nothing is sent, and nothing throws", () => {
  const net = stubNetwork();
  const file = paths.getNotificationsPath();
  const good = readFileSync(file, "utf8");
  try {
    writeFileSync(file, "{ definitely not json");
    assert.doesNotThrow(() => assert.equal(dispatch.sendNotification(draftOf()), null));
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
    writeFileSync(file, good);
  }
});

test("on an instance with accounts, an unowned chat reaches every administrator on their OWN topic, and no member", async () => {
  const net = stubNetwork();
  try {
    const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" });
    const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "admin" });
    const carol = users.createUser({ username: "carol", fullName: "Carol", passwordHash: "x", role: "member" });
    configure({ topic: "alice_topic", token: "tk_alice" }, alice.id);
    configure({ topic: "bob_topic", token: "tk_bob", server: "https://bob-ntfy.test" }, bob.id);
    configure({ topic: "carol_topic" }, carol.id);

    dispatch.sendNotification(draftOf({ sessionId: "unowned-chat" }));
    await until(net.calls, 2);
    await quiet();
    assert.equal(net.calls.length, 2);
    const byUrl = Object.fromEntries(net.calls.map((call) => [call.url, call]));
    assert.equal(byUrl["https://ntfy.test/"].body.topic, "alice_topic");
    assert.equal(byUrl["https://ntfy.test/"].headers.Authorization, "Bearer tk_alice");
    assert.equal(byUrl["https://bob-ntfy.test/"].body.topic, "bob_topic");
    assert.equal(byUrl["https://bob-ntfy.test/"].headers.Authorization, "Bearer tk_bob");

    // A chat that belongs to Carol goes to Carol alone — not to the administrators.
    net.calls.length = 0;
    owners.setSessionOwner("carols-chat", carol.id);
    dispatch.sendNotification(draftOf({ sessionId: "carols-chat" }));
    await until(net.calls, 1);
    await quiet();
    assert.deepEqual(net.calls.map((call) => call.body.topic), ["carol_topic"]);
    assert.equal(net.calls[0].body.click, "https://cody.test/?session=carols-chat");

    // Presence is per person: Alice looking at the unowned chat does not silence Bob.
    net.calls.length = 0;
    presence.recordPresence(alice.id, "unowned-chat");
    dispatch.sendNotification(draftOf({ sessionId: "unowned-chat" }));
    await until(net.calls, 1);
    await quiet();
    assert.deepEqual(net.calls.map((call) => call.body.topic), ["bob_topic"]);
  } finally {
    net.restore();
  }
});
