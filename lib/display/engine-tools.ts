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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexDisplayMcpArgs(sessionId: string): string[] {
  const launch = createDisplayMcpLaunch(sessionId);
  return [
    "-c", `mcp_servers.cody_display.command=${tomlString(process.execPath)}`,
    "-c", `mcp_servers.cody_display.args=[${tomlString(launch.serverPath)}]`,
    "-c", `mcp_servers.cody_display.env.CODY_DISPLAY_SESSION_ID=${tomlString(sessionId)}`,
    "-c", `mcp_servers.cody_display.env.CODY_DISPLAY_CAPABILITY=${tomlString(launch.capability)}`,
    "-c", `mcp_servers.cody_display.env.CODY_DISPLAY_ENDPOINT=${tomlString(launch.endpoint)}`,
    "-c", "mcp_servers.cody_display.enabled=true",
  ];
}
