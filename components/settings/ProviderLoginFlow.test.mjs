import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `postLogout` is the ONE reader of `POST /api/auth/logout/<id>` for every
 * sign-out control (the per-account trash, the card's Sign out, Disconnect, the
 * drawer's Remove). The owner's failure was a control that answered "no
 * account matching that id" for an account that could not be removed; what a
 * control may tell the user rests on how this reads the answer.
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { postLogout, activeChatNote } = await jiti.import("./ProviderLoginFlow.tsx");
const { translate: t } = await jiti.import("../../lib/i18n/index.tsx");

function stubFetch(t, status, body) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test("a provider-wide sign-out sends no body and reads what the server says it removed", async (t) => {
  const calls = stubFetch(t, 200, { ok: true, provider: "anthropic", removed: true, count: 2, restarted: 1, active: 2 });
  const answer = await postLogout("anthropic");
  assert.deepEqual(calls.map((call) => [call.url, call.init.method, call.init.body]), [["/api/auth/logout/anthropic", "POST", undefined]]);
  assert.deepEqual(answer, { ok: true, removed: true, providerRemoved: false, restarted: 1, active: 2 });
});

test("a provider-wide sign-out that found nothing stored is not a success", async (t) => {
  stubFetch(t, 200, { ok: true, provider: "openrouter", removed: false, restarted: 0, active: 0 });
  assert.equal((await postLogout("openrouter")).removed, false);
});

test("one account is named in a JSON body, and its answer says whether the provider is now signed out", async (t) => {
  const calls = stubFetch(t, 200, { ok: true, provider: "anthropic", accountId: "7", providerRemoved: true, restarted: 0, active: 0 });
  const answer = await postLogout("anthropic", "7");
  assert.equal(calls[0].init.body, JSON.stringify({ accountId: "7" }));
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(answer, { ok: true, removed: true, providerRemoved: true, restarted: 0, active: 0 });
});

test("an account that is already gone is a refresh, not a failure", async (t) => {
  stubFetch(t, 404, { error: "That account is already gone — the list was out of date.", code: "not_found", restarted: 0, active: 0 });
  const answer = await postLogout("openrouter", "3");
  assert.equal(answer.ok, false);
  assert.equal(answer.notFound, true);
});

test("a real failure keeps the server's plain-English reason and is never mistaken for 'already gone'", async (t) => {
  stubFetch(t, 400, { error: "Cody could not delete the stored account (database is locked). Try again in a moment.", code: "logout_failed" });
  const answer = await postLogout("anthropic", "5");
  assert.deepEqual(answer, { ok: false, notFound: false, message: "Cody could not delete the stored account (database is locked). Try again in a moment." });

  stubFetch(t, 404, { error: "no such route" });
  assert.equal((await postLogout("anthropic", "5")).notFound, false, "only the route's own not_found code means a stale list");
});

test("an unreadable answer and a dead network both say so", async (t) => {
  stubFetch(t, 502, "<html>Bad gateway</html>");
  assert.deepEqual(await postLogout("anthropic"), { ok: false, notFound: false, message: "HTTP 502" });
  globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
  assert.deepEqual(await postLogout("anthropic"), { ok: false, notFound: false, message: "connect ECONNREFUSED" });
});

test("the mid-reply sentence appears only when some chat is mid-reply", () => {
  assert.equal(activeChatNote(0, t), undefined);
  assert.equal(activeChatNote(1, t), t("providerRemoval.activeChat"));
});
