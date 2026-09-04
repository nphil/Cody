import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  fetchSettingsRoute,
  invalidateSettingsRoutes,
  readSettingsRoute,
  readSettingsRouteEntry,
  resetSettingsRouteCache,
  setSettingsRouteData,
  subscribeSettingsRoutes,
} = await jiti.import("./useSettingsData.ts");

/** A fetch stub that answers per route and counts calls. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const answer = routes[url];
    if (!answer) return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 500, headers: { "Content-Type": "application/json" } });
    if (typeof answer === "function") return answer();
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

test.beforeEach(() => resetSettingsRouteCache());

test("concurrent readers share one in-flight request and both get the body", async () => {
  const calls = stubFetch({ "/api/memory": { body: { documents: [1, 2] } } });
  const [a, b] = await Promise.all([fetchSettingsRoute("/api/memory"), fetchSettingsRoute("/api/memory")]);
  assert.equal(calls.length, 1, "one network request for two callers");
  assert.deepEqual(a.data, { documents: [1, 2] });
  assert.equal(a, b);
  assert.deepEqual(readSettingsRoute("/api/memory"), { documents: [1, 2] });
  assert.equal(readSettingsRouteEntry("/api/memory").loading, false);
});

test("an unsupported answer is cached as a value, not an error", async () => {
  stubFetch({ "/api/memory": { status: 400, body: { error: "omp does not expose its memory", code: "unsupported" } } });
  const entry = await fetchSettingsRoute("/api/memory");
  assert.equal(entry.unsupported, true);
  assert.equal(entry.error, null, "the section hides; nothing paints an error banner");
  assert.equal(entry.data, null);
});

test("401/403 and network failures surface as the entry's error", async () => {
  stubFetch({
    "/api/engines/updates": { status: 403, body: { error: "Administrators only", code: "forbidden" } },
    "/api/boom": () => { throw new TypeError("Failed to fetch"); },
  });
  const forbidden = await fetchSettingsRoute("/api/engines/updates");
  assert.equal(forbidden.error, "Administrators only");
  assert.equal(forbidden.unsupported, false);
  const boom = await fetchSettingsRoute("/api/boom");
  assert.equal(boom.error, "Failed to fetch");
  assert.equal(boom.loading, false);
});

test("invalidation keeps the stale body readable, bumps the version and notifies subscribers", async () => {
  stubFetch({ "/api/omp-settings": { body: { settings: { advisor: { enabled: true } } } }, "/api/omp-settings/schema": { body: { schema: { settings: [] } } } });
  await fetchSettingsRoute("/api/omp-settings");
  await fetchSettingsRoute("/api/omp-settings/schema");
  let notified = 0;
  const unsubscribe = subscribeSettingsRoutes(() => { notified += 1; });
  const before = readSettingsRouteEntry("/api/omp-settings");

  invalidateSettingsRoutes("/api/omp-settings", { exact: true });
  const after = readSettingsRouteEntry("/api/omp-settings");
  assert.equal(after.stale, true);
  assert.equal(after.version, before.version + 1);
  assert.deepEqual(after.data, before.data, "the body stays readable while the refetch runs");
  assert.equal(readSettingsRouteEntry("/api/omp-settings/schema").stale, false, "exact invalidation leaves the schema route alone");
  assert.equal(notified, 1);

  invalidateSettingsRoutes("/api/omp-settings");
  assert.equal(readSettingsRouteEntry("/api/omp-settings/schema").stale, true, "prefix invalidation covers the schema route");
  assert.equal(notified, 2);

  invalidateSettingsRoutes("/api/nothing-cached");
  assert.equal(notified, 2, "an invalidation that touches nothing is silent");
  unsubscribe();
});

test("an optimistic write replaces the body without a fetch and clears staleness", async () => {
  const calls = stubFetch({ "/api/omp-settings": { body: { settings: { a: 1 } } } });
  await fetchSettingsRoute("/api/omp-settings");
  invalidateSettingsRoutes("/api/omp-settings");
  setSettingsRouteData("/api/omp-settings", { settings: { a: 2 } });
  const entry = readSettingsRouteEntry("/api/omp-settings");
  assert.deepEqual(entry.data, { settings: { a: 2 } });
  assert.equal(entry.stale, false);
  assert.equal(calls.length, 1);
});

test("force re-fetches even while a request is in flight", async () => {
  let resolveFirst;
  const calls = stubFetch({
    "/api/models": () => new Promise((resolve) => { resolveFirst = () => resolve(new Response(JSON.stringify({ n: 1 }), { status: 200 })); }),
  });
  const first = fetchSettingsRoute("/api/models");
  stubFetch({ "/api/models": { body: { n: 2 } } });
  const second = fetchSettingsRoute("/api/models", { force: true });
  resolveFirst();
  await Promise.all([first, second]);
  assert.equal(calls.length, 1, "the first stub saw one call; the forced one went to the second stub");
  assert.equal(readSettingsRoute("/api/models").n, 2, "the forced fetch is the last write");
});
