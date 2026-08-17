#!/usr/bin/env node
"use strict";

async function main() {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("zod"),
  ]);
  const endpoint = process.env.CODY_DISPLAY_ENDPOINT;
  const capability = process.env.CODY_DISPLAY_CAPABILITY;
  if (!endpoint || !capability) throw new Error("Cody display capability is unavailable");

  const server = new McpServer({ name: "cody-display", version: "1.0.0" });
  server.registerTool("open_preview", {
    title: "Open Cody Preview",
    description: "Open or refresh a running local web UI in Cody's Preview panel. Call this after starting or restarting a dev server and whenever the URL changes. The URL must use localhost or 127.0.0.1.",
    inputSchema: {
      url: z.string().describe("Container-local http(s) URL, for example http://127.0.0.1:3000"),
      title: z.string().max(160).optional().describe("Short label for the preview"),
      mode: z.enum(["auto", "stream", "native"]).optional().describe("Prefer auto unless a specific transport is required"),
    },
  }, async (input) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      const accepted = { accepted: true, requestId: body.requestId };
      return { content: [{ type: "text", text: JSON.stringify(accepted) }], structuredContent: accepted };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to open preview" }] };
    }
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
