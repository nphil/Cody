import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DEVICE_TRUST_NOTE, DEVICE_OPERATION_TOOLS } = await jiti.import("../lib/devices/operation-tools.ts");
const { SCHEDULE_TOOLS } = await jiti.import("../lib/scheduled/tools.ts");

/**
 * Engines launched through displayMcpAcpServer() / claudeDisplayMcpConfig() do
 * not get the host tool definitions Cody's own engine gets: they get this
 * script's hard-coded list. The bridge is run for real over stdio against a
 * stand-in for Cody's device endpoint, so what an engine can discover and what
 * reaches the server is observed rather than read from source.
 */
async function withBridge(run, { scheduled = true } = {}) {
  const calls = [];
  const paths = [];
  const endpoint = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw);
      calls.push({ authorization: request.headers.authorization, body });
      paths.push(request.url);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: `server accepted ${body.tool}` }));
    });
  });
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const { port } = endpoint.address();
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./cody-display-mcp.js", import.meta.url))],
    env: {
      PATH: process.env.PATH ?? "",
      CODY_DISPLAY_ENDPOINT: `http://127.0.0.1:${port}/display`,
      CODY_DEVICES_ENDPOINT: `http://127.0.0.1:${port}/devices`,
      ...(scheduled ? { CODY_SCHEDULED_ENDPOINT: `http://127.0.0.1:${port}/scheduled` } : {}),
      CODY_DISPLAY_CAPABILITY: "capability-token",
      CODY_DISPLAY_SESSION_ID: "session-1",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    return await run({ client, calls, paths });
  } finally {
    await client.close().catch(() => undefined);
    await new Promise((resolve) => endpoint.close(resolve));
  }
}

test("every device operation tool the host defines can be discovered through the MCP bridge with the same arguments", async () => {
  await withBridge(async ({ client }) => {
    const { tools } = await client.listTools();
    const bridge = new Map(tools.map((tool) => [tool.name, tool]));
    for (const hosted of DEVICE_OPERATION_TOOLS) {
      const exposed = bridge.get(hosted.name);
      assert.ok(exposed, `${hosted.name} is defined for the host but missing from the MCP bridge`);
      assert.deepEqual(
        Object.keys(exposed.inputSchema.properties ?? {}).sort(),
        Object.keys(hosted.parameters.properties).sort(),
        `${hosted.name} takes different arguments through the bridge`,
      );
      if (hosted.parameters.properties.protocol?.enum) {
        assert.deepEqual(exposed.inputSchema.properties.protocol.enum, hosted.parameters.properties.protocol.enum, `${hosted.name} offers different protocols through the bridge`);
      }
    }
    // An engine is never told to expect an approval, a typed override or a shell grant: the user's one trust answer replaced them.
    for (const hosted of DEVICE_OPERATION_TOOLS) {
      assert.doesNotMatch(bridge.get(hosted.name).description, /typed|confirmation|shell grant|shell access|Devices panel to approve/i, `${hosted.name} still describes an approval step through the bridge`);
    }
  });
});

test("the device-trust note is the same words through the bridge as for the host, on the same tools", async () => {
  await withBridge(async ({ client }) => {
    const { tools } = await client.listTools();
    const bridge = new Map(tools.map((tool) => [tool.name, tool]));
    for (const hosted of DEVICE_OPERATION_TOOLS) {
      const exposed = bridge.get(hosted.name);
      assert.equal(
        exposed.description.includes(DEVICE_TRUST_NOTE),
        hosted.description.includes(DEVICE_TRUST_NOTE),
        `${hosted.name}: the bridge and the host disagree about whether the tool documents the trust the user gives`,
      );
    }
    assert.ok(bridge.get("device_exec").description.includes(DEVICE_TRUST_NOTE), "an engine reached over MCP is told about the one-time trust");
    assert.ok(!bridge.get("device_detect").description.includes(DEVICE_TRUST_NOTE), "read-only detection is not gated, so it is not described as gated");
    assert.match(bridge.get("device_exec").inputSchema.properties.options.description, /sendDelaySeconds/);
  });
});

test("device_install called through the MCP bridge reaches the device endpoint with the session capability and every argument intact", async () => {
  await withBridge(async ({ client, calls }) => {
    const args = { device: "usb-1", protocol: "adb", fileId: "apk-1", sha256: "a".repeat(64), interfaceNumber: 2, alternateSetting: 1, options: { replace: true, grantPermissions: true } };
    const result = await client.callTool({ name: "device_install", arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "server accepted device_install" }]);
    assert.deepEqual(calls, [{ authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "device_install", arguments: args } }]);

    // A malformed digest never leaves the bridge.
    const refused = await client.callTool({ name: "device_install", arguments: { ...args, sha256: "not-a-digest" } }).then((value) => value, (error) => error);
    assert.ok(refused instanceof Error || refused.isError === true, "the schema refuses a bad digest");
    assert.equal(calls.length, 1);
  });
});

test("every scheduling tool the host defines is offered through the MCP bridge with the same arguments and the same words", async () => {
  await withBridge(async ({ client }) => {
    const { tools } = await client.listTools();
    const bridge = new Map(tools.map((tool) => [tool.name, tool]));
    for (const hosted of SCHEDULE_TOOLS) {
      const exposed = bridge.get(hosted.name);
      assert.ok(exposed, `${hosted.name} is defined for the host but missing from the MCP bridge`);
      const hostedProperties = hosted.parameters.properties ?? {};
      assert.deepEqual(Object.keys(exposed.inputSchema.properties ?? {}).sort(), Object.keys(hostedProperties).sort(), `${hosted.name} takes different arguments through the bridge`);
      assert.deepEqual([...(exposed.inputSchema.required ?? [])].sort(), [...(hosted.parameters.required ?? [])].sort(), `${hosted.name} requires different arguments through the bridge`);
      assert.equal(exposed.description, hosted.description, `${hosted.name} teaches a different purpose through the bridge`);
      for (const [name, spec] of Object.entries(hostedProperties)) {
        assert.equal(exposed.inputSchema.properties[name].type, spec.type, `${hosted.name}.${name} has a different type through the bridge`);
        assert.equal(exposed.inputSchema.properties[name].description, spec.description, `${hosted.name}.${name} is described differently through the bridge`);
      }
    }
  });
});

test("a scheduling call through the MCP bridge reaches the scheduling endpoint with the session capability, and the server's words come back", async () => {
  await withBridge(async ({ client, calls, paths }) => {
    const args = { message: "carry on with the migration", at: "2026-10-07T09:00", session: "Release work" };
    const result = await client.callTool({ name: "schedule_message", arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "server accepted schedule_message" }]);
    await client.callTool({ name: "list_scheduled", arguments: {} });
    await client.callTool({ name: "cancel_scheduled", arguments: { id: "sch_abc" } });
    assert.deepEqual(paths, ["/scheduled", "/scheduled", "/scheduled"], "scheduling never goes to the display or device endpoints");
    assert.deepEqual(calls, [
      { authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "schedule_message", arguments: args } },
      { authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "list_scheduled", arguments: {} } },
      { authorization: "Bearer capability-token", body: { sessionId: "session-1", tool: "cancel_scheduled", arguments: { id: "sch_abc" } } },
    ]);

    // A call missing its required argument never leaves the bridge.
    const refused = await client.callTool({ name: "cancel_scheduled", arguments: {} }).then((value) => value, (error) => error);
    assert.ok(refused instanceof Error || refused.isError === true, "the schema refuses a cancel without an id");
    assert.equal(calls.length, 3);
  });
});

test("an engine started without a scheduling endpoint is told so plainly instead of hanging", async () => {
  await withBridge(async ({ client, calls }) => {
    const result = await client.callTool({ name: "schedule_message", arguments: { message: "later", whenQuotaResets: true } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /scheduling capability is unavailable/);
    assert.equal(calls.length, 0);
  }, { scheduled: false });
});
