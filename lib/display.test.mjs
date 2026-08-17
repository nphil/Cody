import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import test from "node:test";
import { createJiti } from "jiti";
process.env.CODY_INTERNAL_DISPLAY_SECRET ??= "display-test-secret";
process.env.CODY_INTERNAL_DISPLAY_ORIGIN ??= "http://127.0.0.1:30178";


const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  aliasDisplaySession,
  getLatestDisplayRequest,
  publishDisplayRequest,
  resetDisplayBusForTests,
  subscribeDisplayRequests,
} = await jiti.import("./display/bus.ts");
const { issueDisplayCapability, verifyDisplayCapability } = await jiti.import("./display/capability.ts");
const { claudeDisplayMcpConfig, codexDisplayMcpArgs, createDisplayMcpLaunch } = await jiti.import("./display/engine-tools.ts");
const { resolveDisplayCandidates } = await jiti.import("./display/native-gateway.ts");
const { parseDisplayRequestInput } = await jiti.import("./display/validation.ts");
const { canAccessDisplaySession } = await jiti.import("./display/access.ts");

test("display requests accept only normalized loopback web URLs", () => {
  assert.deepEqual(parseDisplayRequestInput({ url: "HTTP://LOCALHOST:3000/app?q=1#view", title: "  Demo  " }), {
    url: "http://localhost:3000/app?q=1#view",
    title: "Demo",
    mode: "auto",
  });
  assert.throws(() => parseDisplayRequestInput({ url: "https://example.com" }), /localhost/i);
  assert.throws(() => parseDisplayRequestInput({ url: "file:\/\/\/etc\/passwd" }), /http/i);
  assert.throws(() => parseDisplayRequestInput({ url: "http://user:secret@localhost:3000" }), /credentials/i);
});

/** A port that was bound and released, so nothing can answer on it. */
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function externalIPv4() {
  return Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal);
}

test("display candidate ladder is best-first and always ends with the streamed floor", async () => {
  const previous = process.env.CODY_PREVIEW_BASE_URL;
  const dead = await freePort();
  try {
    delete process.env.CODY_PREVIEW_BASE_URL;
    assert.deepEqual(await resolveDisplayCandidates(`http://127.0.0.1:${dead}/app`, "stream"), [{ kind: "stream" }]);
    assert.deepEqual(await resolveDisplayCandidates(`http://127.0.0.1:${dead}/app`, "auto"), [{ kind: "stream" }]);
    assert.deepEqual(await resolveDisplayCandidates(`http://127.0.0.1:${dead}/app`, "native"), [{ kind: "stream" }]);

    process.env.CODY_PREVIEW_BASE_URL = "https://preview.example.test/";
    // Explicit stream mode stays a one-rung ladder even with a gateway configured.
    assert.deepEqual(await resolveDisplayCandidates(`http://127.0.0.1:${dead}/app`, "stream"), [{ kind: "stream" }]);

    const ladder = await resolveDisplayCandidates(`http://localhost:${dead}/app?q=1`, "auto");
    assert.deepEqual(ladder.map((candidate) => candidate.kind), ["native", "stream"]);
    assert.match(ladder[0].url, /^https:\/\/[a-f0-9]{36}\.preview\.example\.test\/app\?q=1$/);
    assert.equal(ladder[0].host, new URL(ladder[0].url).hostname);
    assert.equal(ladder.at(-1).url, undefined);
  } finally {
    if (previous === undefined) delete process.env.CODY_PREVIEW_BASE_URL;
    else process.env.CODY_PREVIEW_BASE_URL = previous;
  }
});

test("direct candidates cover exactly the interfaces a port actually answers on", async (t) => {
  const external = externalIPv4();
  if (external.length === 0) return t.skip("host has no routable IPv4 interface to probe");
  const previous = process.env.CODY_PREVIEW_BASE_URL;
  delete process.env.CODY_PREVIEW_BASE_URL;
  resetDisplayBusForTests();
  const server = http.createServer((_request, response) => { response.writeHead(204); response.end(); });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = server.address().port;
  try {
    const request = await publishDisplayRequest("direct-session", { url: `http://127.0.0.1:${port}/app?q=1` });
    const direct = request.candidates.filter((candidate) => candidate.kind === "direct");
    t.diagnostic(`routable IPv4: ${external.map((address) => address.address).join(", ")}`);
    t.diagnostic(`ladder for 0.0.0.0:${port} -> ${request.candidates.map((candidate) => `${candidate.kind}${candidate.url ? ` ${candidate.url}` : ""}`).join(" | ")}`);
    assert.ok(direct.length > 0, "a server bound to 0.0.0.0 must produce at least one direct candidate");
    assert.equal(request.candidates[0].kind, "direct");
    assert.equal(request.candidates.at(-1).kind, "stream");
    assert.equal(new Set(direct.map((candidate) => candidate.host)).size, direct.length, "one direct candidate per interface, deduped");
    for (const candidate of direct) {
      const url = new URL(candidate.url);
      assert.equal(url.port, String(port));
      assert.equal(`${url.pathname}${url.search}`, "/app?q=1");
      assert.equal(url.hostname, candidate.host);
      assert.ok(external.some((address) => address.address === candidate.host), `${candidate.host} is not a routable interface address`);
    }
    // Full ranking with a gateway configured: every reachable direct rung
    // first, then native, then the floor.
    process.env.CODY_PREVIEW_BASE_URL = "https://preview.example.test/";
    const full = await publishDisplayRequest("direct-session", { url: `http://127.0.0.1:${port}/app?q=1` });
    delete process.env.CODY_PREVIEW_BASE_URL;
    t.diagnostic(`full ladder -> ${full.candidates.map((candidate) => candidate.kind).join(" | ")}`);
    assert.deepEqual(full.candidates.map((candidate) => candidate.kind), [...direct.map(() => "direct"), "native", "stream"]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  // Nothing listens there now, so the ladder collapses to the streamed floor.
  const collapsed = await publishDisplayRequest("direct-session", { url: `http://127.0.0.1:${port}/app` });
  t.diagnostic(`ladder after close -> ${collapsed.candidates.map((candidate) => candidate.kind).join(" | ")}`);
  assert.deepEqual(collapsed.candidates, [{ kind: "stream" }]);

  if (previous === undefined) delete process.env.CODY_PREVIEW_BASE_URL;
  else process.env.CODY_PREVIEW_BASE_URL = previous;
  resetDisplayBusForTests();
});

test("a loopback-only dev server offers no direct candidate even though its port answers", async (t) => {
  const previous = process.env.CODY_PREVIEW_BASE_URL;
  delete process.env.CODY_PREVIEW_BASE_URL;
  resetDisplayBusForTests();
  const server = http.createServer((_request, response) => { response.writeHead(204); response.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    // The port is genuinely live — the missing direct rung is about the bind
    // address, which is exactly what open_preview tells the model to change.
    const answered = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
    void answered.body?.cancel().catch(() => {});
    const request = await publishDisplayRequest("loopback-session", { url: `http://127.0.0.1:${port}/app` });
    t.diagnostic(`loopback-only ladder -> ${request.candidates.map((candidate) => candidate.kind).join(" | ")}`);
    assert.deepEqual(request.candidates, [{ kind: "stream" }]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.CODY_PREVIEW_BASE_URL;
    else process.env.CODY_PREVIEW_BASE_URL = previous;
    resetDisplayBusForTests();
  }
});

test("display capabilities are session-scoped and tamper-evident", () => {
  const token = issueDisplayCapability("session-a");
  assert.equal(verifyDisplayCapability(token)?.sid, "session-a");
  const [payload, signature] = token.split(".");
  const tampered = `${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assert.equal(verifyDisplayCapability(tampered), null);
  assert.equal(verifyDisplayCapability("not-a-token"), null);
});

test("display MCP launchers carry a scoped capability into Claude and Codex", () => {
  const launch = createDisplayMcpLaunch("session-a");
  assert.equal(verifyDisplayCapability(launch.capability)?.sid, "session-a");

  const claude = JSON.parse(claudeDisplayMcpConfig("session-a"));
  assert.equal(claude.mcpServers.cody_display.command, process.execPath);
  assert.deepEqual(claude.mcpServers.cody_display.args, [launch.serverPath]);
  assert.equal(verifyDisplayCapability(claude.mcpServers.cody_display.env.CODY_DISPLAY_CAPABILITY)?.sid, "session-a");

  const codex = codexDisplayMcpArgs("session-a");
  assert.deepEqual(codex.slice(0, 4), ["-c", `mcp_servers.cody_display.command=${JSON.stringify(process.execPath)}`, "-c", `mcp_servers.cody_display.args=[${JSON.stringify(launch.serverPath)}]`]);
  assert.ok(codex.includes("mcp_servers.cody_display.enabled=true"));
  const capabilityArg = codex.find((arg) => arg.startsWith("mcp_servers.cody_display.env.CODY_DISPLAY_CAPABILITY="));
  assert.equal(verifyDisplayCapability(JSON.parse(capabilityArg.split("=", 2)[1]))?.sid, "session-a");
});
test("display requests survive engine session rekey and notify existing listeners", async () => {
  resetDisplayBusForTests();
  const events = [];
  const unsubscribe = subscribeDisplayRequests("temporary", (event) => events.push(event));
  const first = await publishDisplayRequest("temporary", { url: "http://localhost:3000", title: "First", mode: "stream" });
  aliasDisplaySession("temporary", "real");
  const second = await publishDisplayRequest("temporary", { url: "http://127.0.0.1:3001", mode: "stream" });

  assert.equal(first.sessionId, "temporary");
  assert.equal(second.sessionId, "real");
  assert.equal(getLatestDisplayRequest("temporary")?.id, second.id);
  assert.equal(getLatestDisplayRequest("real")?.id, second.id);
  assert.deepEqual(events.map((event) => event.type), ["snapshot", "request", "request"]);
  unsubscribe();
  resetDisplayBusForTests();
});

test("display sockets are refused for sessions that do not exist", async () => {
  // canAccessSession answers "visible to everyone" for an unknown id (it cannot
  // tell it apart from a legitimately unowned session), so the display gate has
  // to prove existence as well — otherwise any authenticated client could open a
  // socket for an arbitrary string.
  assert.equal(await canAccessDisplaySession("", null), false);
  assert.equal(await canAccessDisplaySession("no-such-session-id", null), false);
  assert.equal(await canAccessDisplaySession("../../etc/passwd", null), false);
});
