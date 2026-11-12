import * as path from "node:path";
import { devicesInternalEndpoint, displayInternalEndpoint, issueDisplayCapability, messagingInternalEndpoint, modelSwitchInternalEndpoint, scheduledInternalEndpoint, sessionsInternalEndpoint, workersInternalEndpoint } from "./capability";

export interface DisplayMcpLaunch {
  serverPath: string;
  endpoint: string;
  sessionsEndpoint: string;
  devicesEndpoint: string;
  scheduledEndpoint: string;
  messagingEndpoint: string;
  modelSwitchEndpoint: string;
  workersEndpoint: string;
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
    scheduledEndpoint: scheduledInternalEndpoint(),
    messagingEndpoint: messagingInternalEndpoint(),
    modelSwitchEndpoint: modelSwitchInternalEndpoint(),
    workersEndpoint: workersInternalEndpoint(),
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
          CODY_SCHEDULED_ENDPOINT: launch.scheduledEndpoint,
          CODY_MESSAGING_ENDPOINT: launch.messagingEndpoint,
          CODY_MODEL_SWITCH_ENDPOINT: launch.modelSwitchEndpoint,
          CODY_WORKERS_ENDPOINT: launch.workersEndpoint,
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
      { name: "CODY_SCHEDULED_ENDPOINT", value: launch.scheduledEndpoint },
      { name: "CODY_MESSAGING_ENDPOINT", value: launch.messagingEndpoint },
      { name: "CODY_MODEL_SWITCH_ENDPOINT", value: launch.modelSwitchEndpoint },
      { name: "CODY_WORKERS_ENDPOINT", value: launch.workersEndpoint },
      { name: "CODY_ENGINE_LABEL", value: launch.engineLabel },
    ],
  };
}
