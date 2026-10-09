import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

/**
 * The rules about the message itself — its size, its time, the limits, the
 * quota it waits for — and what cancel, edit and send-now do to the store, run
 * on the real store file with a fake clock.
 */
const root = mkdtempSync(join(tmpdir(), "cody-scheduled-service-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const service = await jiti.import("./service.ts");
const store = await jiti.import("./store.ts");
const { SCHEDULED_LIMITS, QUOTA_GIVE_UP_MS } = await jiti.import("./types.ts");
const users = await jiti.import("../auth/users.ts");
const { setSessionOwner } = await jiti.import("../auth/session-owners.ts");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-05T23:00:00Z");
const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "member" });
const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });
setSessionOwner("alice-chat", alice.id);
setSessionOwner("alice-chat-2", alice.id);
setSessionOwner("bob-chat", bob.id);

afterEach(() => writeFileSync(store.scheduledStorePath(), "", { mode: 0o600 }));

const TIME = { zone: "America/New_York" };
const BROWSER = { zone: "UTC", requireOffset: true };
const by = (user, source = "user") => ({ user, source });
const plan = (result) => async () => result;
const deps = (planQuota = plan({ ok: false, code: "no_quota_reset" })) => ({ now: () => NOW, engineId: () => "omp", planQuota });

async function refused(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}

test("a timed message is stored for the instant named, as the agent or the person asked", async () => {
  const view = await service.createScheduled("alice-chat", { message: "run the suite", at: "2026-10-06T09:00" }, TIME, by(alice, "agent"), deps());
  assert.equal(view.at, "2026-10-06T13:00:00.000Z", "9 AM where the person is, not 9 AM UTC");
  assert.equal(view.mode, "at");
  assert.equal(view.source, "agent");
  assert.equal(view.status, "pending");
  assert.equal(view.sessionId, "alice-chat");
  assert.deepEqual(service.listScheduled("alice-chat").map((item) => item.id), [view.id]);
  assert.deepEqual(service.listScheduled("bob-chat"), []);
});

test("the browser's API takes an instant only: a time with no offset is refused, not guessed", async () => {
  const exact = await service.createScheduled("alice-chat", { message: "m", at: "2026-10-06T13:00:00.000Z" }, BROWSER, by(alice), deps());
  assert.equal(exact.at, "2026-10-06T13:00:00.000Z");
  const guessed = await refused(service.createScheduled("alice-chat", { message: "m", at: "2026-10-06T09:00" }, BROWSER, by(alice), deps()));
  assert.equal(guessed.code, "invalid_time");
});

test("what is refused, and why: every refusal carries a stable code and a plain sentence", async () => {
  const create = (input, time = TIME) => refused(service.createScheduled("alice-chat", input, time, by(alice), deps()));
  assert.equal((await create({ message: "   ", at: "2026-10-06T09:00" })).code, "message_required");
  assert.equal((await create({ message: 7, at: "2026-10-06T09:00" })).code, "message_required");
  assert.equal((await create({ at: "2026-10-06T09:00" })).code, "message_required");
  const tooLong = await create({ message: "x".repeat(SCHEDULED_LIMITS.maxMessageBytes + 1), at: "2026-10-06T09:00" });
  assert.equal(tooLong.code, "message_too_long");
  assert.equal((await create({ message: "é".repeat(SCHEDULED_LIMITS.maxMessageBytes / 2 + 1), at: "2026-10-06T09:00" })).code, "message_too_long", "bytes, not characters");
  assert.equal((await create({ message: "ok", at: "next tuesday" })).code, "invalid_time");
  assert.equal((await create({ message: "ok", at: 1759705200 })).code, "invalid_time");
  assert.equal((await create({ message: "ok", at: "2026-10-05T10:00:00Z" })).code, "time_in_past");
  assert.equal((await create({ message: "ok", at: new Date(NOW + 30 * DAY + 60_000).toISOString() })).code, "time_too_far");
  assert.equal((await create({ message: "ok" })).code, "choose_one_time", "neither");
  assert.equal((await create({ message: "ok", at: "2026-10-06T09:00", whenQuotaResets: true })).code, "choose_one_time", "both");
  for (const code of ["message_required", "message_too_long", "invalid_time", "time_in_past", "time_too_far", "choose_one_time"]) {
    const error = await create(code === "message_required" ? { message: "" } : { message: "ok" });
    assert.ok(error.message.length > 10 && error.status === 400, `${code} reads as a sentence`);
  }
  assert.deepEqual(store.listItems(NOW), [], "no refusal stored anything");
});

test("the edges of the window: 30 days exactly is fine, and a clock a few seconds slow does not turn 'now' into an error", async () => {
  const farthest = await service.createScheduled("alice-chat", { message: "m", at: new Date(NOW + 30 * DAY).toISOString() }, BROWSER, by(alice), deps());
  assert.equal(Date.parse(farthest.at), NOW + 30 * DAY);
  const justNow = await service.createScheduled("alice-chat", { message: "m", at: new Date(NOW - 20_000).toISOString() }, BROWSER, by(alice), deps());
  assert.equal(Date.parse(justNow.at), NOW, "clamped to now: due immediately");
  const tooLate = await refused(service.createScheduled("alice-chat", { message: "m", at: new Date(NOW - 61_000).toISOString() }, BROWSER, by(alice), deps()));
  assert.equal(tooLate.code, "time_in_past");
});

test("20 per chat and 100 per account: the next is refused with 409 and its own code", async () => {
  for (let index = 0; index < SCHEDULED_LIMITS.perChat; index += 1) {
    await service.createScheduled("alice-chat", { message: `m${index}`, at: "2026-10-06T09:00" }, TIME, by(alice, "agent"), deps());
  }
  const chat = await refused(service.createScheduled("alice-chat", { message: "one more", at: "2026-10-06T09:00" }, TIME, by(alice), deps()));
  assert.equal(chat.code, "too_many_for_chat");
  assert.equal(chat.status, 409);
  assert.match(chat.message, /20/);

  // Four more chats' worth take Alice to 100; the account limit follows the CHAT'S owner, not whoever is asking.
  for (const session of ["alice-chat-2", "alice-chat-3", "alice-chat-4", "alice-chat-5"]) {
    setSessionOwner(session, alice.id);
    for (let index = 0; index < SCHEDULED_LIMITS.perChat; index += 1) {
      await service.createScheduled(session, { message: `m${index}`, at: "2026-10-06T09:00" }, TIME, by(alice), deps());
    }
  }
  setSessionOwner("alice-chat-6", alice.id);
  const account = await refused(service.createScheduled("alice-chat-6", { message: "over", at: "2026-10-06T09:00" }, TIME, by(alice), deps()));
  assert.equal(account.code, "too_many_for_account");
  assert.equal(account.status, 409);
  const other = await service.createScheduled("bob-chat", { message: "bob is fine", at: "2026-10-06T09:00" }, TIME, by(bob), deps());
  assert.equal(other.sessionId, "bob-chat", "another account has its own allowance");
});

test("when quota resets: the reset, the model and the give-up time are stored from what the plan found", async () => {
  const seen = [];
  const quotaPlan = async (...args) => {
    seen.push(args);
    return { ok: true, target: { provider: "anthropic", modelId: "claude-opus-4-5", resetsAt: NOW + 3 * HOUR, label: "Claude · Secondary" } };
  };
  const view = await service.createScheduled(
    "alice-chat",
    { message: "continue", whenQuotaResets: true, model: { provider: "anthropic", modelId: "claude-opus-4-5" } },
    BROWSER,
    by(alice),
    deps(quotaPlan),
  );
  assert.equal(view.mode, "quota");
  assert.equal(view.at, new Date(NOW + 3 * HOUR).toISOString(), "due at the reset");
  assert.deepEqual(view.quota, { label: "Claude · Secondary", giveUpAt: new Date(NOW + 3 * HOUR + QUOTA_GIVE_UP_MS).toISOString() });
  const stored = store.findItem(view.id, NOW);
  assert.deepEqual(stored.quota, { provider: "anthropic", modelId: "claude-opus-4-5", label: "Claude · Secondary", giveUpAt: NOW + 3 * HOUR + QUOTA_GIVE_UP_MS });
  assert.deepEqual(seen, [["alice-chat", "omp", { provider: "anthropic", modelId: "claude-opus-4-5" }, NOW]], "the composer's own model is what is asked about");
});

test("when quota resets, with no model supplied the chat itself is asked; and an unknown reset is refused plainly", async () => {
  const seen = [];
  const noReset = async (...args) => { seen.push(args[2]); return { ok: false, code: "no_quota_reset" }; };
  const error = await refused(service.createScheduled("alice-chat", { message: "continue", whenQuotaResets: true }, TIME, by(alice, "agent"), deps(noReset)));
  assert.equal(error.code, "no_quota_reset");
  assert.deepEqual(seen, [null], "no model supplied");
  const noModel = await refused(service.createScheduled("alice-chat", { message: "continue", whenQuotaResets: true }, TIME, by(alice, "agent"), deps(plan({ ok: false, code: "no_model" }))));
  assert.equal(noModel.code, "no_model");
  const farOff = await refused(service.createScheduled("alice-chat", { message: "continue", whenQuotaResets: true }, TIME, by(alice), deps(plan({ ok: true, target: { provider: "anthropic", modelId: "m", resetsAt: NOW + 31 * DAY, label: "Claude" } }))));
  assert.equal(farOff.code, "time_too_far", "a weekly window that resets next month is out of range too");
  assert.deepEqual(store.listItems(NOW), []);
});

test("editing: a new text gets a new delivery identity, and a new time moves it", async () => {
  const view = await service.createScheduled("alice-chat", { message: "first", at: "2026-10-06T09:00" }, TIME, by(alice), deps());
  const retimed = await service.updateScheduled("alice-chat", view.id, { at: "2026-10-07T10:00" }, TIME, deps());
  assert.equal(retimed.at, "2026-10-07T14:00:00.000Z");
  assert.equal(store.findItem(view.id, NOW).deliveryNo, 0, "the same words keep the same identity");
  const reworded = await service.updateScheduled("alice-chat", view.id, { message: "second" }, TIME, deps());
  assert.equal(reworded.message, "second");
  assert.equal(store.findItem(view.id, NOW).deliveryNo, 1, "different words are a different delivery");
  const unchanged = await service.updateScheduled("alice-chat", view.id, { message: "second" }, TIME, deps());
  assert.equal(unchanged.message, "second");
  assert.equal(store.findItem(view.id, NOW).deliveryNo, 1);
  assert.equal((await refused(service.updateScheduled("alice-chat", view.id, { message: " " }, TIME, deps()))).code, "message_required");
  assert.equal((await refused(service.updateScheduled("alice-chat", view.id, { at: "2026-10-05T10:00:00Z" }, BROWSER, deps()))).code, "time_in_past");
  assert.equal((await refused(service.updateScheduled("alice-chat", view.id, { at: "2026-10-06T09:00", whenQuotaResets: true }, TIME, deps()))).code, "choose_one_time");
});

test("editing a quota message into a timed one drops the quota, and the other way round adds it", async () => {
  const target = { provider: "anthropic", modelId: "m", resetsAt: NOW + 2 * HOUR, label: "Claude" };
  const view = await service.createScheduled("alice-chat", { message: "q", whenQuotaResets: true }, TIME, by(alice), deps(plan({ ok: true, target })));
  const timed = await service.updateScheduled("alice-chat", view.id, { at: "2026-10-06T09:00" }, TIME, deps());
  assert.equal(timed.mode, "at");
  assert.equal(timed.quota, undefined);
  assert.equal(store.findItem(view.id, NOW).quota, undefined);
  const quota = await service.updateScheduled("alice-chat", view.id, { whenQuotaResets: true }, TIME, deps(plan({ ok: true, target })));
  assert.equal(quota.mode, "quota");
  assert.equal(quota.quota.label, "Claude");
});

test("a failed message becomes pending again when it is edited, under a new delivery identity", async () => {
  const view = await service.createScheduled("alice-chat", { message: "will fail", at: "2026-10-06T09:00" }, TIME, by(alice), deps());
  store.mutateItem(view.id, (item) => ({ ...item, status: "failed", attempts: 6, error: "boom", firstAttemptAt: NOW - HOUR }), NOW);
  const healed = await service.updateScheduled("alice-chat", view.id, { at: "2026-10-06T10:00" }, TIME, deps());
  assert.equal(healed.status, "pending");
  assert.equal(healed.error, undefined);
  const stored = store.findItem(view.id, NOW);
  assert.equal(stored.attempts, 0);
  assert.equal(stored.firstAttemptAt, undefined);
  assert.equal(stored.deliveryNo, 1, "the refused attempt's identity is retired");
});

test("a message another chat owns is invisible to this one: its id answers exactly like a missing one", async () => {
  const view = await service.createScheduled("alice-chat", { message: "mine", at: "2026-10-06T09:00" }, TIME, by(alice), deps());
  for (const act of [
    () => service.updateScheduled("bob-chat", view.id, { message: "stolen" }, TIME, deps()),
    () => service.cancelScheduled("bob-chat", view.id),
    () => service.sendScheduledNow("bob-chat", view.id, {}),
  ]) {
    const error = await refused(Promise.resolve().then(act));
    assert.equal(error.code, "item_not_found");
    assert.equal(error.status, 404);
  }
  assert.equal(store.findItem(view.id, NOW).message, "mine");
  assert.equal((await refused(Promise.resolve().then(() => service.cancelScheduled("alice-chat", "sch_nope")))).code, "item_not_found");
});

test("cancel removes a waiting message, and refuses one that is already being handed over", async () => {
  const waiting = await service.createScheduled("alice-chat", { message: "cancel me", at: "2026-10-06T09:00" }, TIME, by(alice), deps());
  assert.equal(service.cancelScheduled("alice-chat", waiting.id).message, "cancel me");
  assert.equal(store.findItem(waiting.id, NOW), null);
  assert.equal((await refused(Promise.resolve().then(() => service.cancelScheduled("alice-chat", waiting.id)))).code, "item_not_found", "a second cancel finds nothing");

  const sending = await service.createScheduled("alice-chat", { message: "too late", at: "2026-10-06T09:00" }, TIME, by(alice), deps());
  store.mutateItem(sending.id, (item) => ({ ...item, status: "sending" }), NOW);
  const error = await refused(Promise.resolve().then(() => service.cancelScheduled("alice-chat", sending.id)));
  assert.equal(error.code, "already_sending");
  assert.equal(error.status, 409);
  assert.equal((await refused(service.updateScheduled("alice-chat", sending.id, { message: "x" }, TIME, deps()))).code, "already_sending");
  assert.ok(store.findItem(sending.id, NOW), "it was left alone");

  // A failed message may be cancelled: that is how a person dismisses it.
  store.mutateItem(sending.id, (item) => ({ ...item, status: "failed", error: "x" }), NOW);
  service.cancelScheduled("alice-chat", sending.id);
  assert.equal(store.findItem(sending.id, NOW), null);
});

test("a message the chat only queued stays listed as waiting in the chat, and cancel and edit keep refusing it", async () => {
  const view = await service.createScheduled("alice-chat", { message: "after the reply", at: "2026-10-06T09:00" }, TIME, by(alice), deps());
  assert.equal(view.handedOver, undefined);
  const queued = await service.sendScheduledNow("alice-chat", view.id, { ...sender().deps, deliver: async () => "queued" });
  assert.equal(queued.delivered, false, "it is not in the conversation yet");
  assert.equal(queued.item.status, "sending");
  assert.equal(queued.item.handedOver, true);
  assert.equal(service.listScheduled("alice-chat")[0].handedOver, true);
  assert.equal((await refused(Promise.resolve().then(() => service.cancelScheduled("alice-chat", view.id)))).code, "already_sending");
  assert.equal((await refused(service.updateScheduled("alice-chat", view.id, { message: "x" }, TIME, deps()))).code, "already_sending");
  assert.equal(store.findItem(view.id, NOW).handedClientMessageId, `sched-${view.id}`);
});

function sender(deliver) {
  const delivered = [];
  return {
    delivered,
    deps: {
      now: () => NOW,
      deliver: async (item) => { delivered.push({ message: item.message, clientMessageId: store.clientMessageIdFor(item) }); await deliver?.(item); },
      readUsage: async () => ({ available: false, accounts: [], fetchedAt: "", stale: false }),
      notify: async () => { throw new Error("a person who pressed Send now is looking: nobody is notified"); },
    },
  };
}

test("send now delivers at once, whatever the item waited for, tells nobody, and leaves nothing behind", async () => {
  const quota = { ok: true, target: { provider: "anthropic", modelId: "m", resetsAt: NOW + 5 * HOUR, label: "Claude" } };
  const view = await service.createScheduled("alice-chat", { message: "do not wait", whenQuotaResets: true }, TIME, by(alice), deps(plan(quota)));
  const { deps: schedulerDeps, delivered } = sender();
  const result = await service.sendScheduledNow("alice-chat", view.id, schedulerDeps);
  assert.deepEqual(result, { delivered: true });
  assert.deepEqual(delivered, [{ message: "do not wait", clientMessageId: `sched-${view.id}` }], "no quota check was made for a person who said now");
  assert.equal(store.findItem(view.id, NOW), null);
});

test("send now that fails leaves a failed row with the reason, no background retry and no notification", async () => {
  const view = await service.createScheduled("alice-chat", { message: "will not go", at: "2026-10-06T09:00" }, TIME, by(alice), deps());
  const failing = sender(() => { throw new Error("The session stopped responding."); });
  const result = await service.sendScheduledNow("alice-chat", view.id, failing.deps);
  assert.equal(result.delivered, false);
  assert.equal(result.item.status, "failed");
  assert.equal(result.item.error, "The session stopped responding.");
  assert.equal(store.findItem(view.id, NOW).notBefore, undefined, "nothing retries behind the person's back");

  // Retry is send-now again, under a fresh delivery identity.
  const working = sender();
  assert.deepEqual(await service.sendScheduledNow("alice-chat", view.id, working.deps), { delivered: true });
  assert.deepEqual(working.delivered, [{ message: "will not go", clientMessageId: `sched-${view.id}-1` }]);
});

test("send now refuses a message that is being sent already", async () => {
  const view = await service.createScheduled("alice-chat", { message: "busy", at: "2026-10-06T09:00" }, TIME, by(alice), deps());
  store.mutateItem(view.id, (item) => ({ ...item, status: "sending" }), NOW);
  const error = await refused(service.sendScheduledNow("alice-chat", view.id, sender().deps));
  assert.equal(error.code, "already_sending");
});
