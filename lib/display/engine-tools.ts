import * as path from "node:path";
import { displayInternalEndpoint, issueDisplayCapability } from "./capability";

export interface DisplayMcpLaunch {
  serverPath: string;
  endpoint: string;
  capability: string;
}

export function createDisplayMcpLaunch(sessionId: string): DisplayMcpLaunch {
  const packageRoot = process.env.CODY_PACKAGE_DIR || process.cwd();
  return {
    serverPath: path.join(packageRoot, "bin", "cody-display-mcp.js"),
    endpoint: displayInternalEndpoint(),
    capability: issueDisplayCapability(sessionId),
  };
}

export function claudeDisplayMcpConfig(sessionId: string): string {
  const launch = createDisplayMcpLaunch(sessionId);
  return JSON.stringify({
    mcpServers: {
      cody_display: {
        type: "stdio",
        command: process.execPath,
        args: [launch.serverPath],
        env: {
          CODY_DISPLAY_SESSION_ID: sessionId,
          CODY_DISPLAY_CAPABILITY: launch.capability,
          CODY_DISPLAY_ENDPOINT: launch.endpoint,
        },
      },
    },
  });
}

/**
 * The same display bridge as an ACP `McpServerStdio` descriptor, for engines
 * Cody drives over ACP rather than by building a per-turn CLI argv.
 *
 * Environment is a LIST of `{name, value}` pairs, not an object — that is the
 * protocol's shape, and an agent handed the object form connects a server with
 * no capability token, which then fails every call.
 *
 * No `type` field: ACP discriminates a stdio server by the ABSENCE of one, and
 * at least one adapter tests `!("type" in server)` before connecting it. A
 * well-meaning `type: "stdio"` is therefore not a no-op — it silently drops
 * the server, leaving an agent with no display tools and no error to show.
 */
export function displayMcpAcpServer(sessionId: string): {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
} {
  const launch = createDisplayMcpLaunch(sessionId);
  return {
    name: "cody_display",
    command: process.execPath,
    args: [launch.serverPath],
    env: [
      { name: "CODY_DISPLAY_SESSION_ID", value: sessionId },
      { name: "CODY_DISPLAY_CAPABILITY", value: launch.capability },
      { name: "CODY_DISPLAY_ENDPOINT", value: launch.endpoint },
    ],
  };
}
