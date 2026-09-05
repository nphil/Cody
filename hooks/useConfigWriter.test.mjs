import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resetSettingsRouteCache, setSettingsRouteData, readSettingsRoute, readSettingsRouteEntry, fetchSettingsRoute } = await jiti.import("./useSettingsData.ts");
const {
  SCHEMA_COALESCE_MS,
  configWriterIdle,
  enqueueConfigWrite,
  patchSettingsSchema,
  patchSettingsSection,
  patchSettingsTop,
  resetConfigWriter,
} = await jiti.import("./useConfigWriter.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stub server for /api/omp-settings and its schema route: GET answers the
 * current file, PUT stores and echoes it, every call is recorded. */
function stubServer(initial) {
  let settings = structuredClone(initial);
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    if (url === "/api/omp-settings" && method === "GET") {
      return new Response(JSON.stringify({ settings }), { status: 200 });
    }
    if (url === "/api/omp-settings" && method === "PUT") {
      if (body.settings.__fail) return new Response(JSON.stringify({ error: "disk full" }), { status: 500 });
      settings = body.settings;
      return new Response(JSON.stringify({ success: true, settings }), { status: 200 });
    }
    if (url === "/api/omp-settings/schema" && method === "PUT") {
      return new Response(JSON.stringify({ success: true, written: Object.keys(body.patch), values: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: `no stub for ${method} ${url}` }), { status: 500 });
  };
  return { calls, get settings() { return settings; }, puts: () => calls.filter((call) => call.method === "PUT" && call.url === "/api/omp-settings") };
}

test.beforeEach(() => {
  resetSettingsRouteCache();
  resetConfigWriter();
});

test("a section patch spreads the SECTION, never the whole settings object", async () => {
  // The trap this writer exists to close: spreading the whole object into
  // `advisor` filled config.yml sections with every top-level key.
  const server = stubServer({ defaultThinkingLevel: "high", tools: { approvalMode: "yolo" }, advisor: { enabled: false, syncBacklog: "3" } });
  await patchSettingsSection("advisor", { enabled: true });
  const [put] = server.puts();
  assert.deepEqual(put.body.settings.advisor, { enabled: false, syncBacklog: "3", ...{ enabled: true } });
  assert.equal("defaultThinkingLevel" in put.body.settings.advisor, false, "no top-level key leaked into the section");
  assert.equal("tools" in put.body.settings.advisor, false);
  assert.equal(put.body.settings.defaultThinkingLevel, "high", "top-level keys survive untouched");
  assert.deepEqual(put.body.settings.tools, { approvalMode: "yolo" });
  // The cache shows the optimistic value, then the server's echo.
  assert.deepEqual(readSettingsRoute("/api/omp-settings").settings.advisor, { enabled: true, syncBacklog: "3" });
});

test("a section patch on a missing section starts from an empty object", async () => {
  const server = stubServer({ personality: "default" });
  await patchSettingsSection("mcp", { notifications: true });
  const [put] = server.puts();
  assert.deepEqual(put.body.settings, { personality: "default", mcp: { notifications: true } });
});

test("patchTop merges top-level keys and arrays whole", async () => {
  const server = stubServer({ enabledModels: ["anthropic/**"], advisor: { enabled: true } });
  await patchSettingsTop({ enabledModels: ["anthropic/**", "openai/gpt-5"], modelProviderOrder: ["anthropic", "openai"] });
  const [put] = server.puts();
  assert.deepEqual(put.body.settings.enabledModels, ["anthropic/**", "openai/gpt-5"]);
  assert.deepEqual(put.body.settings.modelProviderOrder, ["anthropic", "openai"]);
  assert.deepEqual(put.body.settings.advisor, { enabled: true }, "sections are untouched by a top-level merge");
});

test("the first patch reads the file when nothing has, and uses a cached body when it exists", async () => {
  const server = stubServer({ retry: { enabled: true } });
  await patchSettingsSection("retry", { maxRetries: 4 });
  assert.deepEqual(server.calls.map((call) => call.method), ["GET", "PUT"], "cold: read then write");

  resetConfigWriter();
  resetSettingsRouteCache();
  server.calls.length = 0;
  await fetchSettingsRoute("/api/omp-settings");
  await patchSettingsSection("retry", { maxRetries: 5 });
  assert.deepEqual(server.calls.map((call) => call.method), ["GET", "PUT"], "warm: the hook's read serves as the base, no second GET");
  assert.equal(server.settings.retry.maxRetries, 5);
});

test("settings writes are FIFO and later patches see earlier ones", async () => {
  const server = stubServer({ advisor: { enabled: false }, compaction: { enabled: true } });
  setSettingsRouteData("/api/omp-settings", { settings: server.settings });
  const first = patchSettingsSection("advisor", { enabled: true });
  const second = patchSettingsSection("compaction", { enabled: false });
  const third = patchSettingsTop({ personality: "friendly" });
  await Promise.all([first, second, third]);
  // Intermediate snapshots are superseded by the last one queued behind
  // them, so the file receives the cumulative state, in order, and at most
  // one PUT per snapshot that was still the newest when its turn came.
  const puts = server.puts();
  assert.ok(puts.length >= 1 && puts.length <= 3);
  assert.deepEqual(server.settings, { advisor: { enabled: true }, compaction: { enabled: false }, personality: "friendly" });
  assert.deepEqual(readSettingsRoute("/api/omp-settings").settings, server.settings);
});

test("families drain independently: a slow plan write does not hold a schema patch", async () => {
  stubServer({});
  const order = [];
  let releasePlan;
  const plan = enqueueConfigWrite("plan", () => new Promise((resolve) => { releasePlan = () => { order.push("plan"); resolve(); }; }));
  const schema = enqueueConfigWrite("schema", async () => { order.push("schema"); });
  await schema;
  assert.deepEqual(order, ["schema"], "schema ran while plan was still pending");
  releasePlan();
  await plan;
  assert.deepEqual(order, ["schema", "plan"]);
});

test("a delete waits for the settings and schema queues so it lands after pending patches", async () => {
  const server = stubServer({ retry: { enabled: true } });
  setSettingsRouteData("/api/omp-settings", { settings: server.settings });
  const order = [];
  let releaseSettings;
  const pending = enqueueConfigWrite("settings", () => new Promise((resolve) => { releaseSettings = () => { order.push("settings"); resolve(); }; }));
  const reset = enqueueConfigWrite("delete", async () => { order.push("delete"); });
  await sleep(10);
  assert.deepEqual(order, [], "delete has not run ahead of the queued patch");
  releaseSettings();
  await Promise.all([pending, reset]);
  assert.deepEqual(order, ["settings", "delete"]);
});

test("a rejected write reports to its caller and never blocks the next one", async () => {
  const server = stubServer({ advisor: { enabled: false } });
  setSettingsRouteData("/api/omp-settings", { settings: server.settings });
  await assert.rejects(patchSettingsTop({ __fail: true }), /disk full/);
  // The failed optimistic value is dropped and the route marked for re-read.
  assert.equal(readSettingsRouteEntry("/api/omp-settings").stale, true);
  await patchSettingsSection("advisor", { enabled: true });
  assert.equal(server.settings.advisor.enabled, true, "the queue kept moving");
  await configWriterIdle();
});

test("schema patches coalesce into one PUT within the window", async () => {
  const server = stubServer({});
  const a = patchSettingsSchema({ "ui.theme": "dark" });
  const b = patchSettingsSchema({ "tools.approvalMode": "write", "ui.theme": "light" });
  await Promise.all([a, b]);
  const schemaPuts = server.calls.filter((call) => call.url === "/api/omp-settings/schema");
  assert.equal(schemaPuts.length, 1, "two patches inside 350 ms travel together");
  assert.deepEqual(schemaPuts[0].body.patch, { "ui.theme": "light", "tools.approvalMode": "write" }, "the later value of a repeated key wins");
  assert.ok(SCHEMA_COALESCE_MS >= 300);
});

test("a delete clears the cached settings snapshot so a patch queued behind it re-reads the file instead of resurrecting the deleted key", async () => {
  // The server-side effect of a reset: a brand new object without the key,
  // never a mutation of the object already referenced by `latestSettings`
  // (a real DELETE goes over HTTP to a separate process, so it cannot
  // alias the client's in-memory snapshot the way mutating one object in
  // place would in this test).
  let settings = { advisor: { enabled: true, subagents: true } };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(method);
    if (url === "/api/omp-settings" && method === "GET") return new Response(JSON.stringify({ settings }), { status: 200 });
    if (url === "/api/omp-settings" && method === "PUT") {
      settings = JSON.parse(init.body).settings;
      return new Response(JSON.stringify({ success: true, settings }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: `no stub for ${method} ${url}` }), { status: 500 });
  };
  setSettingsRouteData("/api/omp-settings", { settings });

  const reset = enqueueConfigWrite("delete", async () => {
    settings = { advisor: { enabled: settings.advisor.enabled } };
  });
  // Queued in the same tick as the reset, before either has run.
  const patch = patchSettingsSection("advisor", { enabled: false });
  await Promise.all([reset, patch]);
  await configWriterIdle();

  assert.equal("subagents" in settings.advisor, false, "the reset key must not be resurrected by a patch built from the pre-delete snapshot");
  assert.deepEqual(settings.advisor, { enabled: false });
  assert.deepEqual(readSettingsRoute("/api/omp-settings").settings, settings);
});

test("a superseded settings PUT resolves with the outcome of the PUT that actually carried its change", async () => {
  let settings = { advisor: { enabled: false }, compaction: { enabled: true } };
  let releasePut;
  let putCalls = 0;
  let putBody = null;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (url === "/api/omp-settings" && method === "GET") return new Response(JSON.stringify({ settings }), { status: 200 });
    if (url === "/api/omp-settings" && method === "PUT") {
      putCalls += 1;
      putBody = JSON.parse(init.body);
      return new Promise((resolve) => {
        releasePut = () => resolve(new Response(JSON.stringify({ success: true, settings: putBody.settings }), { status: 200 }));
      });
    }
    return new Response(JSON.stringify({ error: `no stub for ${method} ${url}` }), { status: 500 });
  };
  setSettingsRouteData("/api/omp-settings", { settings });

  const a = patchSettingsSection("advisor", { enabled: true }); // superseded before its own turn
  const b = patchSettingsSection("compaction", { enabled: false }); // the snapshot that actually ships
  let aSettled = false;
  a.then(() => { aSettled = true; });
  await sleep(10);
  assert.equal(putCalls, 1, "only the snapshot still current when its turn came is PUT");
  assert.equal(aSettled, false, "the superseded write must not report success before the PUT carrying its change lands");

  releasePut();
  await Promise.all([a, b]);
  assert.equal(aSettled, true);
  assert.deepEqual(putBody.settings, { advisor: { enabled: true }, compaction: { enabled: false } }, "the winning PUT carried both changes");
});

test("when the PUT carrying a superseded write's change fails, the superseded write's promise rejects with the same error", async () => {
  const settings = { advisor: { enabled: false } };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (url === "/api/omp-settings" && method === "GET") return new Response(JSON.stringify({ settings }), { status: 200 });
    if (url === "/api/omp-settings" && method === "PUT") return new Response(JSON.stringify({ error: "disk full" }), { status: 500 });
    return new Response(JSON.stringify({ error: `no stub for ${method} ${url}` }), { status: 500 });
  };
  setSettingsRouteData("/api/omp-settings", { settings });

  const a = patchSettingsSection("advisor", { enabled: true });
  const b = patchSettingsSection("advisor", { enabled: false });
  await assert.rejects(a, /disk full/, "a write superseded before it ran must still see the real PUT's failure, not a phantom success");
  await assert.rejects(b, /disk full/);
});

test("every settled write invalidates the cached reads a config change can move", async () => {
  const server = stubServer({ advisor: { enabled: false } });
  setSettingsRouteData("/api/omp-settings", { settings: server.settings });
  setSettingsRouteData("/api/models", { models: [] });
  setSettingsRouteData("/api/model-roles", { roles: {} });
  setSettingsRouteData("/api/models/new", { newModels: [] });
  await patchSettingsSection("advisor", { enabled: true });
  await configWriterIdle();
  for (const route of ["/api/models", "/api/model-roles", "/api/models/new"]) {
    assert.equal(readSettingsRouteEntry(route).stale, true, `${route} is stale after a write`);
  }
});
