import * as path from "node:path";
import { devicesInternalEndpoint, displayInternalEndpoint, issueDisplayCapability, sessionsInternalEndpoint } from "./capability";

export interface DisplayMcpLaunch {
  serverPath: string;
  endpoint: string;
  sessionsEndpoint: string;
  devicesEndpoint: string;
  capability: string;
  engineLabel: string;
}

export function createDisplayMcpLaunch(sessionId: string, engineLabel = "Cody"): DisplayMcpLaunch {
  const packageRoot = process.env.CODY_PACKAGE_DIR || process.cwd();
  return {
    serverPath: path.join(packageRoot, "bin", "cody-display-mcp.js"),
    endpoint: displayInternalEndpoint(),
    sessionsEndpoint: sessionsInternalEndpoint(),
    devicesEndpoint: devicesInternalEndpoint(),
    capability: issueDisplayCapability(sessionId),
    engineLabel,
  };
}

export function claudeDisplayMcpConfig(sessionId: string): string {
  const launch = createDisplayMcpLaunch(sessionId, "Claude Code");
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
          CODY_SESSIONS_ENDPOINT: launch.sessionsEndpoint,
          CODY_DEVICES_ENDPOINT: launch.devicesEndpoint,
          CODY_ENGINE_LABEL: launch.engineLabel,
        },
      },
    },
  });
}

/**
 * The same MCP bridge as an ACP McpServerStdio descriptor, for engines Cody
 * drives over ACP rather than by building a per-turn CLI argv.
 *
 * Environment is a LIST of {name, value} pairs, not an object. The protocol
 * requires that shape; an object reaches the server with no capability token.
 *
 * No type field: ACP discriminates a stdio server by its absence. Some
 * adapters silently drop a descriptor that carries type: "stdio".
 */
export function displayMcpAcpServer(sessionId: string, engineLabel = "Cody"): {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
} {
  const launch = createDisplayMcpLaunch(sessionId, engineLabel);
  return {
    name: "cody_display",
    command: process.execPath,
    args: [launch.serverPath],
    env: [
      { name: "CODY_DISPLAY_SESSION_ID", value: sessionId },
      { name: "CODY_DISPLAY_CAPABILITY", value: launch.capability },
      { name: "CODY_DISPLAY_ENDPOINT", value: launch.endpoint },
      { name: "CODY_SESSIONS_ENDPOINT", value: launch.sessionsEndpoint },
      { name: "CODY_DEVICES_ENDPOINT", value: launch.devicesEndpoint },
      { name: "CODY_ENGINE_LABEL", value: launch.engineLabel },
    ],
  };
}
