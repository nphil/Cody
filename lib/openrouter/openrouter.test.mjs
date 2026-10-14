import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { fetchCredits, fetchKeyInfo, fetchActivity, fetchManagedKeys, updateKeyLimit } =
  await jiti.import("./api.ts");
const { getOpenRouterAccount, invalidateOpenRouterAccount } = await jiti.import("./account.ts");

/** A fetch stand-in that answers a fixed status/body and records its calls. */
function stubFetch(routes) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", auth: init?.headers?.Authorization });
      for (const [fragment, answer] of Object.entries(routes)) {
        if (String(url).includes(fragment)) {
          return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), {
            status: answer.status ?? 200,
          });
        }
      }
      return new Response(JSON.stringify({ error: { message: "Not Found", code: 404 } }), { status: 404 });
    },
  };
}

// ── The balance the UI reports ───────────────────────────────────────────────

test("remaining credits are derived, because OpenRouter only reports the totals", async () => {
  const stub = stubFetch({ "/credits": { body: { data: { total_credits: 20, total_usage: 11.5 } } } });
  const result = await fetchCredits("sk-or-test", { fetcher: stub.fetch });
  assert.equal(result.ok, true);
  assert.equal(result.value.remaining, 8.5);
});

test("an overdrawn account reports zero rather than a negative balance", async () => {
  // OpenRouter can report usage above the purchased total (in-flight spend
  // settles after the fact). "-$0.40 remaining" is not a quantity a user can
  // act on, and a negative would also invert the spent-fraction bar.
  const stub = stubFetch({ "/credits": { body: { data: { total_credits: 5, total_usage: 5.4 } } } });
  const result = await fetchCredits("sk-or-test", { fetcher: stub.fetch });
  assert.equal(result.ok, true);
  assert.equal(result.value.remaining, 0);
});

test("a credits body missing its totals is a shape error, not a zero balance", async () => {
  // The dangerous failure mode: silently reporting $0.00 would tell the user
  // they are out of credits when the read simply failed.
  const stub = stubFetch({ "/credits": { body: { data: { total_credits: "20" } } } });
  const result = await fetchCredits("sk-or-test", { fetcher: stub.fetch });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "bad_response");
});

// ── The auth-scope distinction the whole management-key UX rests on ──────────

test("activity's 403 and keys' 401 both read as management_key_required", async () => {
  // OpenRouter answers these two DIFFERENTLY for the same valid inference key:
  // 403 with an explanatory message on /activity, but a bare 401 "Invalid API
  // key" on /keys. Reporting the latter as `unauthorized` would tell the user
  // their working key is invalid, so both scope-gated reads must normalize to
  // the same code — that code is what the UI turns into "add a management key".
  const stub = stubFetch({
    "/activity": { status: 403, body: { error: { message: "Only management keys can fetch activity for an account", code: 403 } } },
    "/keys": { status: 401, body: { error: { message: "Invalid API key", code: 401 } } },
  });
  const activity = await fetchActivity("sk-or-test", { fetcher: stub.fetch });
  const keys = await fetchManagedKeys("sk-or-test", { fetcher: stub.fetch });
  assert.equal(activity.ok, false);
  assert.equal(activity.error.code, "management_key_required");
  assert.equal(keys.ok, false);
  assert.equal(keys.error.code, "management_key_required");
});

test("a rejected key on an ungated read stays unauthorized", async () => {
  // The counterpart: /credits is not scope-gated, so a 401 there really does
  // mean the key is bad and must not be excused as a missing scope.
  const stub = stubFetch({ "/credits": { status: 401, body: { error: { message: "Invalid API key", code: 401 } } } });
  const result = await fetchCredits("sk-or-bad", { fetcher: stub.fetch });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unauthorized");
});

test("an HTML error page never becomes the user-facing message", async () => {
  // An unknown path answers OpenRouter's Next.js 404 page. Surfacing that
  // markup in a toast would be gibberish.
  const stub = stubFetch({ "/credits": { status: 404, body: "<!DOCTYPE html><html><body>404</body></html>" } });
  const result = await fetchCredits("sk-or-test", { fetcher: stub.fetch });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error.message, /DOCTYPE|<html/);
});

test("no key short-circuits without a request", async () => {
  const stub = stubFetch({});
  const result = await fetchCredits("", { fetcher: stub.fetch });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "no_key");
  assert.equal(stub.calls.length, 0);
});

// ── Key info ────────────────────────────────────────────────────────────────

test("either provisioning flag marks a key as a management key", async () => {
  // OpenRouter reports both `is_management_key` and `is_provisioning_key`;
  // trusting only one would misclassify a key and hide the controls it unlocks.
  for (const field of ["is_management_key", "is_provisioning_key"]) {
    const stub = stubFetch({ "/key": { body: { data: { [field]: true } } } });
    const result = await fetchKeyInfo("sk-or-test", { fetcher: stub.fetch });
    assert.equal(result.ok, true);
    assert.equal(result.value.isManagementKey, true, field);
  }
});

test("an uncapped key reports a null limit, not zero", async () => {
  // Zero would render as "$0.00 of $0.00 left" — an exhausted cap — for a key
  // that in fact has no cap at all.
  const stub = stubFetch({ "/key": { body: { data: { label: "sk-or-v1-15f...879", usage: 10.9, limit: null } } } });
  const result = await fetchKeyInfo("sk-or-test", { fetcher: stub.fetch });
  assert.equal(result.ok, true);
  assert.equal(result.value.limit, null);
  assert.equal(result.value.usage, 10.9);
});

// ── The snapshot the popover renders ────────────────────────────────────────

function accountDeps(routes, { management = false } = {}) {
  const stub = stubFetch(routes);
  return {
    stub,
    deps: {
      fetcher: stub.fetch,
      resolveKey: () => ({ key: "sk-or-test", source: "engine" }),
      resolveManagementKey: () => (management ? "sk-or-mgmt" : null),
    },
  };
}

test("a failed key read still yields the balance", async () => {
  // Partial failure must not blank the section: the balance is the number the
  // user needs, and key info is enrichment around it.
  invalidateOpenRouterAccount();
  const { deps } = accountDeps({
    "/credits": { body: { data: { total_credits: 30, total_usage: 18 } } },
    "/key": { status: 500, body: { error: { message: "boom", code: 500 } } },
  });
  const snapshot = await getOpenRouterAccount({ ...deps, refresh: true });
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.credits.remaining, 12);
  assert.equal(snapshot.key, null);
  assert.equal(snapshot.error.code, "bad_response");
});

test("a failed balance read makes the whole snapshot unavailable", async () => {
  invalidateOpenRouterAccount();
  const { deps } = accountDeps({
    "/credits": { status: 500, body: { error: { message: "boom", code: 500 } } },
    "/key": { body: { data: { usage: 1 } } },
  });
  const snapshot = await getOpenRouterAccount({ ...deps, refresh: true });
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.credits, null);
});

test("activity is not requested without a management key", async () => {
  // With an inference key /activity is a guaranteed 403, so asking on every
  // 90-second poll would spend a request to learn nothing.
  invalidateOpenRouterAccount();
  const { stub, deps } = accountDeps({
    "/credits": { body: { data: { total_credits: 10, total_usage: 1 } } },
    "/key": { body: { data: { usage: 1 } } },
  });
  const snapshot = await getOpenRouterAccount({ ...deps, refresh: true });
  assert.equal(snapshot.hasManagementKey, false);
  assert.equal(snapshot.activity, null);
  assert.equal(stub.calls.some((call) => call.url.includes("/activity")), false);
});

test("a management key is used for activity and reported as available", async () => {
  invalidateOpenRouterAccount();
  const { stub, deps } = accountDeps({
    "/credits": { body: { data: { total_credits: 10, total_usage: 1 } } },
    "/key": { body: { data: { usage: 1 } } },
    "/activity": { body: { data: [{ date: "2026-09-02", usage: 2, requests: 9 }, { date: "2026-09-01", usage: 1, requests: 4 }] } },
  }, { management: true });
  const snapshot = await getOpenRouterAccount({ ...deps, refresh: true });
  assert.equal(snapshot.hasManagementKey, true);
  // Sorted oldest-first so a chart reads left-to-right in time order.
  assert.deepEqual(snapshot.activity.map((day) => day.date), ["2026-09-01", "2026-09-02"]);
  const activityCall = stub.calls.find((call) => call.url.includes("/activity"));
  assert.equal(activityCall.auth, "Bearer sk-or-mgmt");
});

test("no key configured is an unavailable snapshot, never a throw", async () => {
  invalidateOpenRouterAccount();
  const snapshot = await getOpenRouterAccount({
    fetcher: stubFetch({}).fetch,
    resolveKey: () => null,
    resolveManagementKey: () => null,
    refresh: true,
  });
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.error.code, "no_key");
});

test("concurrent callers share one upstream read", async () => {
  invalidateOpenRouterAccount();
  const { stub, deps } = accountDeps({
    "/credits": { body: { data: { total_credits: 10, total_usage: 1 } } },
    "/key": { body: { data: { usage: 1 } } },
  });
  await Promise.all([
    getOpenRouterAccount({ ...deps, refresh: true }),
    getOpenRouterAccount(deps),
    getOpenRouterAccount(deps),
  ]);
  // One /credits request, not three: the composer poll, the settings drawer
  // and the ring must not each spend a request.
  assert.equal(stub.calls.filter((call) => call.url.includes("/credits")).length, 1);
});

test("a failed refresh serves the last good balance, flagged stale", async () => {
  // The user can still act on a slightly old balance; replacing it with an
  // error would remove the only number the section exists to show.
  invalidateOpenRouterAccount();
  const good = accountDeps({
    "/credits": { body: { data: { total_credits: 10, total_usage: 4 } } },
    "/key": { body: { data: { usage: 4 } } },
  });
  const first = await getOpenRouterAccount({ ...good.deps, refresh: true });
  assert.equal(first.stale, false);

  const broken = accountDeps({ "/credits": { status: 503, body: { error: { message: "down", code: 503 } } } });
  const second = await getOpenRouterAccount({ ...broken.deps, refresh: true });
  assert.equal(second.available, true);
  assert.equal(second.stale, true);
  assert.equal(second.credits.remaining, 6);
});

// ── The one write ───────────────────────────────────────────────────────────

test("clearing a spend cap sends an explicit null", async () => {
  // `{}` would leave the cap untouched and `0` would freeze the key; only a
  // literal null removes the limit.
  let sent = null;
  const result = await updateKeyLimit("sk-or-mgmt", "abc123", null, {
    fetcher: async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: { hash: "abc123", name: "cody", limit: null } }), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(sent.limit, null);
  assert.ok("limit" in sent);
});

test("a key hash is URL-encoded into the path", async () => {
  let seen = "";
  await updateKeyLimit("sk-or-mgmt", "a/b c", 5, {
    fetcher: async (url) => {
      seen = String(url);
      return new Response(JSON.stringify({ data: { hash: "a/b c", name: "k" } }), { status: 200 });
    },
  });
  assert.match(seen, /a%2Fb%20c$/);
});

// ── A removed key must stay removed ─────────────────────────────────────────

test("a key that was removed is not served as the balance, however recently it was good", async () => {
  // `no_key` is the ANSWER to "is there a key", not a failed refresh: serving
  // the last good balance "stale" after the user removed the key kept an
  // OpenRouter row alive in Usage for as long as the process lived.
  invalidateOpenRouterAccount();
  const good = accountDeps({
    "/credits": { body: { data: { total_credits: 10, total_usage: 4 } } },
    "/key": { body: { data: { usage: 4 } } },
  });
  assert.equal((await getOpenRouterAccount({ ...good.deps, refresh: true })).available, true);

  const gone = await getOpenRouterAccount({ fetcher: stubFetch({}).fetch, resolveKey: () => null, resolveManagementKey: () => null, refresh: true });
  assert.equal(gone.available, false);
  assert.equal(gone.error.code, "no_key");
  assert.equal(gone.credits, null);
  assert.equal(gone.stale, false);
});

test("a read already in flight when the key changes is not cached for the next caller", async () => {
  invalidateOpenRouterAccount();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = getOpenRouterAccount({
    fetcher: async (url) => {
      await gate;
      return new Response(JSON.stringify(String(url).includes("/credits") ? { data: { total_credits: 10, total_usage: 1 } } : { data: { usage: 1 } }), { status: 200 });
    },
    resolveKey: () => ({ key: "sk-or-old", source: "cody" }),
    resolveManagementKey: () => null,
    refresh: true,
  });
  invalidateOpenRouterAccount();
  release();
  await pending;

  const fresh = accountDeps({ "/credits": { body: { data: { total_credits: 3, total_usage: 1 } } }, "/key": { body: { data: { usage: 1 } } } });
  const next = await getOpenRouterAccount(fresh.deps);
  assert.equal(next.credits.remaining, 2, "the new key's balance, not the old key's");
  assert.ok(fresh.stub.calls.some((call) => call.url.includes("/credits")), "read upstream again instead of serving the abandoned read");
});

test("omp only soft-deletes a key: a removed one is never found again, a live one is", async () => {
  const { resolveOpenRouterKey } = await jiti.import("./key.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "cody-or-key-"));
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, key: process.env.OPENROUTER_API_KEY };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const db = new DatabaseSync(path.join(dir, "agent.db"));
    db.exec("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL)");
    db.prepare("INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES ('openrouter', 'api_key', ?, ?)").run(JSON.stringify({ type: "api_key", key: "sk-or-removed" }), "deleted by user");
    db.close();
    assert.equal(resolveOpenRouterKey(), null, "a 'deleted by user' tombstone still holds the key, and used to be read as if it were live");

    const again = new DatabaseSync(path.join(dir, "agent.db"));
    again.prepare("INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES ('openrouter', 'api_key', ?, NULL)").run(JSON.stringify({ type: "api_key", key: "sk-or-live" }));
    again.close();
    assert.deepEqual(resolveOpenRouterKey(), { key: "sk-or-live", source: "engine" });
  } finally {
    if (previous.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.dir;
    if (previous.key !== undefined) process.env.OPENROUTER_API_KEY = previous.key;
    rmSync(dir, { recursive: true, force: true });
  }
});
