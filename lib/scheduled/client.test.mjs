import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  ScheduledRequestError,
  cancelScheduled,
  createScheduled,
  listScheduled,
  sendScheduledNow,
  updateScheduled,
} = await jiti.import("./client.ts");

const item = (overrides = {}) => ({
  id: "s1",
  sessionId: "chat 1",
  message: "run the build",
  mode: "at",
  at: "2026-10-06T03:00:00.000Z",
  source: "user",
  status: "pending",
  createdAt: "2026-10-06T01:00:00.000Z",
  ...overrides,
});

/** Runs `body` with a fake fetch that answers `reply(url, init)` and records every call. */
async function withFetch(reply, body) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return reply(String(url), init);
  };
  try {
    await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

test("listing asks for the chat's rows with the id escaped, same-origin and never cached", async () => {
  const limits = { perChat: 20, perAccount: 100, maxDays: 30, maxMessageBytes: 65536 };
  await withFetch(() => json(200, { items: [item()], limits }), async (calls) => {
    const controller = new AbortController();
    const result = await listScheduled("chat 1/√", { signal: controller.signal });
    assert.deepEqual(result, { items: [item()], limits });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/sessions/chat%201%2F%E2%88%9A/scheduled");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal(calls[0].init.cache, "no-store");
    assert.equal(calls[0].init.signal, controller.signal);
  });
});

test("creating posts exactly the body it was given and returns the new row", async () => {
  const body = { message: "keep going", whenQuotaResets: true, model: { provider: "anthropic", modelId: "m1" } };
  await withFetch(() => json(201, { item: item({ mode: "quota" }) }), async (calls) => {
    const created = await createScheduled("s", body);
    assert.equal(created.mode, "quota");
    assert.equal(calls[0].url, "/api/sessions/s/scheduled");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body), body);
  });
});

test("editing PATCHes the row's own URL; cancelling DELETEs it; send-now POSTs to its own sub-route", async () => {
  await withFetch((url, init) => {
    if (init.method === "DELETE") return json(200, { ok: true });
    if (url.endsWith("/send-now")) return json(200, { ok: true, delivered: false, item: item({ status: "sending" }) });
    return json(200, { item: item({ message: "edited" }) });
  }, async (calls) => {
    const edited = await updateScheduled("s", "a/b", { message: "edited", at: "2026-10-07T00:00:00.000Z" });
    assert.equal(edited.message, "edited");
    assert.equal(calls[0].url, "/api/sessions/s/scheduled/a%2Fb");
    assert.equal(calls[0].init.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0].init.body), { message: "edited", at: "2026-10-07T00:00:00.000Z" });

    await cancelScheduled("s", "a/b");
    assert.equal(calls[1].url, "/api/sessions/s/scheduled/a%2Fb");
    assert.equal(calls[1].init.method, "DELETE");
    assert.equal(calls[1].init.body, undefined);

    const sent = await sendScheduledNow("s", "a/b");
    assert.deepEqual(sent, { ok: true, delivered: false, item: item({ status: "sending" }) });
    assert.equal(calls[2].url, "/api/sessions/s/scheduled/a%2Fb/send-now");
    assert.equal(calls[2].init.method, "POST");
  });
});

test("send-now that delivered carries no row, and a reply that does not say is an error", async () => {
  await withFetch(() => json(200, { ok: true, delivered: true }), async () => {
    assert.deepEqual(await sendScheduledNow("s", "x"), { ok: true, delivered: true });
  });
  await withFetch(() => json(200, { ok: true }), async () => {
    await assert.rejects(sendScheduledNow("s", "x"), (error) => error instanceof ScheduledRequestError && error.code === null);
  });
});

test("a refusal becomes a ScheduledRequestError carrying the HTTP status and the stable code", async () => {
  await withFetch(() => json(409, { error: "This chat already has 20.", code: "too_many_for_chat" }), async () => {
    await assert.rejects(createScheduled("s", { message: "m", at: "2026-10-06T03:00:00.000Z" }), (error) => {
      assert.ok(error instanceof ScheduledRequestError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "too_many_for_chat");
      assert.equal(error.message, "This chat already has 20.");
      return true;
    });
  });
  await withFetch(() => json(409, { error: "Already on its way.", code: "already_sending" }), async () => {
    await assert.rejects(cancelScheduled("s", "x"), (error) => error.code === "already_sending" && error.status === 409);
  });
});

test("a code the composer does not know, or no body at all, never pretends to be a known refusal", async () => {
  await withFetch(() => json(400, { error: "Nope", code: "something_new" }), async () => {
    await assert.rejects(listScheduled("s"), (error) => error.status === 400 && error.code === null && error.message === "Nope");
  });
  await withFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }), async () => {
    await assert.rejects(listScheduled("s"), (error) => error.status === 502 && error.code === null && error.message === "HTTP 502");
  });
});

test("a 2xx that is not the documented shape is an error, not an empty list or a row of undefined", async () => {
  await withFetch(() => json(200, { nope: true }), async () => {
    await assert.rejects(listScheduled("s"), (error) => error instanceof ScheduledRequestError);
    await assert.rejects(createScheduled("s", { message: "m", at: "2026-10-06T03:00:00.000Z" }), (error) => error instanceof ScheduledRequestError);
  });
  await withFetch(() => new Response("not json", { status: 200 }), async () => {
    await assert.rejects(listScheduled("s"), (error) => error instanceof ScheduledRequestError);
  });
});

test("a dead network is status 0, but an abort the caller asked for stays an abort", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(listScheduled("s"), (error) => error instanceof ScheduledRequestError && error.status === 0 && error.code === null);
    globalThis.fetch = async () => { throw new DOMException("Aborted", "AbortError"); };
    await assert.rejects(listScheduled("s"), (error) => !(error instanceof ScheduledRequestError) && error.name === "AbortError");
  } finally {
    globalThis.fetch = original;
  }
});
