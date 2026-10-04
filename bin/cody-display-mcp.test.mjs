import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DEVICE_OPERATION_TOOLS } = await jiti.import("../lib/devices/operation-tools.ts");

/**
 * Engines launched through displayMcpAcpServer() / claudeDisplayMcpConfig() do
 * not get the host tool definitions Cody's own engine gets: they get this
 * script's hard-coded list. The bridge is run for real over stdio against a
 * stand-in for Cody's device endpoint, so what an engine can discover and what
 * reaches the server is observed rather than read from source.
 */
async function withBridge(run) {
  const calls = [];
  const endpoint = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw);
      calls.push({ authorization: request.headers.authorization, body });
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
      CODY_DISPLAY_CAPABILITY: "capability-token",
      CODY_DISPLAY_SESSION_ID: "session-1",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    return await run({ client, calls });
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
    assert.match(bridge.get("device_install").description, /typed browser confirmation/);
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
