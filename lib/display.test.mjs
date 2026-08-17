import assert from "node:assert/strict";
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
const { resolveDisplayTransport } = await jiti.import("./display/native-gateway.ts");
const { parseDisplayRequestInput } = await jiti.import("./display/validation.ts");

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

test("display transport selects streamed fallback and configured native routes", () => {
  const previous = process.env.CODY_PREVIEW_BASE_URL;
  delete process.env.CODY_PREVIEW_BASE_URL;
  assert.deepEqual(resolveDisplayTransport("http://127.0.0.1:4173/app", "auto"), { transport: "stream" });
  assert.deepEqual(resolveDisplayTransport("http://127.0.0.1:4173/app", "native"), { transport: "stream" });

  process.env.CODY_PREVIEW_BASE_URL = "https://preview.example.test/";
  const native = resolveDisplayTransport("http://localhost:5173/app?q=1", "auto");
  assert.equal(native.transport, "native");
  assert.match(native.nativeUrl ?? "", /^https:\/\/[a-f0-9]+\.preview\.example\.test\/app\?q=1$/);

  if (previous === undefined) delete process.env.CODY_PREVIEW_BASE_URL;
  else process.env.CODY_PREVIEW_BASE_URL = previous;
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
test("display requests survive engine session rekey and notify existing listeners", () => {
  resetDisplayBusForTests();
  const events = [];
  const unsubscribe = subscribeDisplayRequests("temporary", (event) => events.push(event));
  const first = publishDisplayRequest("temporary", { url: "http://localhost:3000", title: "First" });
  aliasDisplaySession("temporary", "real");
  const second = publishDisplayRequest("temporary", { url: "http://127.0.0.1:3001", mode: "stream" });

  assert.equal(first.sessionId, "temporary");
  assert.equal(second.sessionId, "real");
  assert.equal(getLatestDisplayRequest("temporary")?.id, second.id);
  assert.equal(getLatestDisplayRequest("real")?.id, second.id);
  assert.deepEqual(events.map((event) => event.type), ["snapshot", "request", "request"]);
  unsubscribe();
  resetDisplayBusForTests();
});
