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
const { isLoopbackHost, orderDisplayCandidates } = await jiti.import("./display/ladder.ts");

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
    // Local-first: the origin we were handed leads the direct group, so a
    // browser on this machine frames the dev server itself.
    assert.ok(isLoopbackHost(request.candidates[0].host), "the loopback origin must lead the direct group");
    assert.equal(request.candidates.at(-1).kind, "stream");
    assert.equal(new Set(direct.map((candidate) => candidate.host)).size, direct.length, "one direct candidate per interface, deduped");
    for (const candidate of direct) {
      const url = new URL(candidate.url);
      assert.equal(url.port, String(port));
      assert.equal(`${url.pathname}${url.search}`, "/app?q=1");
      assert.equal(url.hostname, candidate.host);
      assert.ok(
        isLoopbackHost(candidate.host) || external.some((address) => address.address === candidate.host),
        `${candidate.host} is neither loopback nor a routable interface address`,
      );
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

test("a loopback-only dev server offers exactly one direct candidate: itself", async (t) => {
  const previous = process.env.CODY_PREVIEW_BASE_URL;
  delete process.env.CODY_PREVIEW_BASE_URL;
  resetDisplayBusForTests();
  const server = http.createServer((_request, response) => { response.writeHead(204); response.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    // The port is live but bound to loopback, so it serves only THIS machine:
    // one direct rung for a local browser, and no interface rung that a remote
    // client would try and fail to reach.
    const answered = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
    void answered.body?.cancel().catch(() => {});
    const request = await publishDisplayRequest("loopback-session", { url: `http://127.0.0.1:${port}/app` });
    t.diagnostic(`loopback-only ladder -> ${request.candidates.map((candidate) => `${candidate.kind}${candidate.url ? ` ${candidate.url}` : ""}`).join(" | ")}`);
    assert.deepEqual(request.candidates.map((candidate) => candidate.kind), ["direct", "stream"]);
    assert.equal(request.candidates[0].url, `http://127.0.0.1:${port}/app`);
    // rpc-manager's open_preview hint keys on the absence of a NON-loopback
    // direct rung to tell the model to rebind. Keep that property observable.
    assert.equal(request.candidates.filter((candidate) => candidate.kind === "direct" && !isLoopbackHost(candidate.host)).length, 0);
    assert.equal(request.candidates[0].host, "127.0.0.1");
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

test("a local browser frames the dev server itself; a remote one never frames loopback", () => {
  const local = { kind: "direct", url: "http://127.0.0.1:3000/", host: "127.0.0.1" };
  const lan = { kind: "direct", url: "http://192.168.0.2:3000/", host: "192.168.0.2" };
  const gateway = { kind: "native", url: "https://tok.preview.example.test/", host: "tok.preview.example.test" };
  const stream = { kind: "stream" };
  const ladder = [local, lan, gateway, stream];

  // Desktop shell / on-device Android / plain `npm run dev`: the real origin
  // wins with no gateway, no Chromium and nothing configured.
  assert.deepEqual(orderDisplayCandidates(ladder, "http:", "localhost"), ladder);
  assert.deepEqual(orderDisplayCandidates(ladder, "http:", "127.0.0.1"), ladder);

  // Remote browser: loopback names the USER's machine, where a probe could
  // succeed against an unrelated app, so it is dropped rather than ranked.
  assert.deepEqual(orderDisplayCandidates(ladder, "http:", "192.168.0.2"), [lan, gateway, stream]);
  // A CGNAT/tailnet address reaches Cody under a different name than the LAN
  // one, so the LAN rung is kept and probed — only loopback is dropped.
  assert.deepEqual(orderDisplayCandidates(ladder, "http:", "100.64.0.2"), [lan, gateway, stream]);

  // HTTPS page: every http: rung is hard-blocked as mixed content, so only the
  // gateway and the floor remain.
  assert.deepEqual(orderDisplayCandidates(ladder, "https:", "cody.example.test"), [gateway, stream]);

  // The floor survives an empty ladder and stays last.
  assert.deepEqual(orderDisplayCandidates([stream], "https:", "cody.example.test"), [stream]);
  assert.ok(isLoopbackHost("[::1]") && isLoopbackHost("LOCALHOST") && !isLoopbackHost("192.168.0.2"));
});
