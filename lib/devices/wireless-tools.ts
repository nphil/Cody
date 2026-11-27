import { createHash } from "node:crypto";
import type { HostToolDefinition } from "../pi-types";
import { validArtifactPath } from "./protocol";
import { wirelessService, WirelessServiceError, type WirelessService } from "./wireless-service";
import type { WirelessCommandResult, WirelessFailure } from "./wireless-types";
import { readWirelessWorkspaceFile, saveWirelessWorkspaceFile, WirelessWorkspaceError } from "./wireless-workspace";

const INSPECT_QUERIES = ["identity", "properties", "battery", "storage", "memory", "display", "uptime", "processes", "packages"] as const;
const LOG_BUFFERS = ["main", "system", "crash", "events"] as const;
const LOG_PRIORITIES = ["V", "D", "I", "W", "E", "F"] as const;
const FILE_ACTIONS = ["list", "stat", "pull", "push"] as const;
const MAX_OUTPUT_BYTES = 16 * 1024;

interface WirelessToolContext {
  sessionId?: string;
  cwd?: string;
  signal?: AbortSignal;
}

type WirelessToolArgs = Record<string, unknown>;
type WirelessToolDefinition = HostToolDefinition & { handler: (args: WirelessToolArgs, context: WirelessToolContext) => Promise<string> };
type WirelessToolService = Pick<WirelessService, "agentRun" | "agentPull" | "agentPush" | "requestApproval" | "approvalResult">;
type Run = (service: WirelessToolService, args: WirelessToolArgs, context: WirelessToolContext & { sessionId: string }) => string | Promise<string>;

function selectedSnapshot(sessionId: string) {
  try { return wirelessService().agentSnapshot(sessionId); }
  catch { return null; }
}

export function hasSelectedWirelessDevice(sessionId: string): boolean {
  const snapshot = selectedSnapshot(sessionId);
  return !!snapshot?.supported && !!snapshot.device;
}

/** Only the chat's own selection, without connection endpoints or paired devices elsewhere. */
export function wirelessDeviceListLine(sessionId: string): string | null {
  const snapshot = selectedSnapshot(sessionId);
  if (!snapshot?.supported) return null;
  if (!snapshot.device) return "Wireless Android: no tablet selected for this chat. Pair one in Cody's Devices panel.";
  // Before Android supplies its model, the page's fallback label is its address.
  const name = snapshot.device.label;
  const label = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(name) ? "Selected tablet" : JSON.stringify(name);
  return `Wireless Android: ${label} (${snapshot.status}). ${snapshot.status === "connected"
    ? "Use the wireless_* tools for this tablet; the browser does not need to stay open."
    : "Check the connection in Cody's Devices panel before running a command."}`;
}

function choice<T extends string>(options: readonly T[], value: unknown): T | undefined {
  return options.find((option) => option === value);
}

function failureText(failure: WirelessFailure): string {
  return failure.code === "completion_unknown"
    ? `${failure.message} Check what changed on the tablet before trying again; Cody did not replay the operation.`
    : failure.message;
}

function resultText({ exitCode, stdout, stderr }: WirelessCommandResult, showStdout = true): string {
  const lines = [`Exit code: ${exitCode}.`];
  if (showStdout && stdout.length) lines.push(stdout.toString("utf8", 0, MAX_OUTPUT_BYTES));
  if (stderr.length) lines.push(`Standard error:\n${stderr.toString("utf8", 0, MAX_OUTPUT_BYTES)}`);
  if ((showStdout && stdout.length > MAX_OUTPUT_BYTES) || stderr.length > MAX_OUTPUT_BYTES) lines.push("Output shortened to fit this tool result.");
  return lines.join("\n");
}

export function createWirelessTools(getService: () => WirelessToolService = wirelessService): WirelessToolDefinition[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], run: Run): WirelessToolDefinition => ({
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    async handler(args, { sessionId, cwd, signal }) {
      if (!sessionId) return "A wireless tool needs an authorized Cody chat.";
      try {
        signal?.throwIfAborted();
        return await run(getService(), args, { sessionId, cwd, signal });
      } catch (error) {
        if (error instanceof WirelessServiceError) return failureText(error);
        if (signal?.aborted) return "Wireless call cancelled. Check what changed before trying again.";
        if (error instanceof WirelessWorkspaceError) return error.message;
        return "Could not complete the wireless tool call. Check the tablet's state before retrying a change.";
      }
    },
  });

  return [
    tool("wireless_inspect", "Run a read-only diagnostic on this chat's selected wireless Android device. Runs without root or an approval.", {
      query: { type: "string", enum: INSPECT_QUERIES },
      filter: { type: "string", description: "Exact property name for properties, or package substring for packages." },
    }, ["query"], async (service, args, { sessionId, signal }) => {
      const query = choice(INSPECT_QUERIES, args.query);
      if (!query) return `Choose a diagnostic query: ${INSPECT_QUERIES.join(", ")}.`;
      if (args.filter !== undefined && typeof args.filter !== "string") return "filter must be text.";
      return resultText(await service.agentRun(sessionId, { kind: "inspect", query, filter: args.filter }, signal));
    }),
    tool("wireless_logcat", "Read a bounded snapshot of Android logs from this chat's selected wireless device. Does not clear logs or follow them indefinitely.", {
      buffer: { type: "string", enum: LOG_BUFFERS },
      lines: { type: "integer", minimum: 1, description: "Number of recent lines, subject to the server limit." },
      tag: { type: "string", description: "Only show this Android log tag." },
      priority: { type: "string", enum: LOG_PRIORITIES, description: "Minimum priority for the selected tag (or all tags if no tag is given)." },
    }, [], async (service, args, { sessionId, signal }) => {
      const buffer = choice(LOG_BUFFERS, args.buffer);
      const priority = choice(LOG_PRIORITIES, args.priority);
      if (args.buffer !== undefined && !buffer) return `Choose a log buffer: ${LOG_BUFFERS.join(", ")}.`;
      if (args.priority !== undefined && !priority) return `Choose a log priority: ${LOG_PRIORITIES.join(", ")}.`;
      const { lines, tag } = args;
      if (lines !== undefined && (typeof lines !== "number" || !Number.isSafeInteger(lines) || lines < 1)) return "lines must be a positive whole number.";
      if (tag !== undefined && typeof tag !== "string") return "tag must be text.";
      return resultText(await service.agentRun(sessionId, { kind: "logcat", buffer, lines, tag, priority }, signal));
    }),
    tool("wireless_files", "List, stat, pull or push a file in the selected tablet's Android shared storage. Transfers use this chat's workspace, not a server path, and never overwrite existing files.", {
      action: { type: "string", enum: FILE_ACTIONS },
      path: { type: "string", minLength: 1, description: "Absolute path on the tablet under /sdcard or /storage/emulated/<user>." },
      workspacePath: { type: "string", description: "Pull destination or push source, relative to this chat's workspace. Required for pull/push; no links or hidden paths." },
    }, ["action", "path"], async (service, args, { sessionId, cwd, signal }) => {
      const kind = choice(FILE_ACTIONS, args.action);
      const { path, workspacePath } = args;
      if (!kind) return `Choose a file action: ${FILE_ACTIONS.join(", ")}.`;
      if (typeof path !== "string" || !path) return "path must name a file or directory on the tablet.";
      if (kind === "list" || kind === "stat") return resultText(await service.agentRun(sessionId, { kind, path }, signal));
      if (!cwd) return "File transfers require this chat's authorized workspace.";
      if (!validArtifactPath(workspacePath)) return "Use a workspace-relative file path without links, hidden names, or '..'.";
      if (kind === "push") {
        let size = 0;
        const result = await service.agentPush(sessionId, path, async (pushSignal) => {
          // Only the service can begin this read, after reserving a slot on
          // the authorized connection. The reservation can cancel the read.
          const bytes = await readWirelessWorkspaceFile(cwd, workspacePath, pushSignal);
          size = bytes.length;
          return bytes;
        }, signal);
        if (result.exitCode !== 0) return resultText(result);
        return `Pushed ${size} bytes from ${JSON.stringify(workspacePath)}. This does not verify tablet readback.`;
      }
      const result = await service.agentPull(sessionId, path, (bytes, pullSignal) =>
        saveWirelessWorkspaceFile(cwd, workspacePath, bytes, pullSignal), signal);
      if (result.exitCode !== 0) return `Nothing was saved to the workspace. ${resultText(result, false)}`;
      const sha256 = createHash("sha256").update(result.stdout).digest("hex");
      return `Saved ${JSON.stringify(workspacePath)} (${result.stdout.length} bytes, SHA-256 ${sha256}).`;
    }),
    tool("wireless_request_command", "Ask the person to approve one exact command on this chat's selected tablet. Nothing runs without their decision in Cody's Devices panel. Use elevated only for a command that needs root. Magisk may also ask on the tablet: use one-time permission, not a standing allow. Check the request with wireless_command_status.", {
      command: { type: "string", minLength: 1, description: "One exact Android command for the person to approve." },
      elevated: { type: "boolean", description: "False for the normal Android shell, true to request root via Magisk." },
      reason: { type: "string", description: "Briefly explain why this command is needed." },
    }, ["command", "elevated"], (service, args, { sessionId }) => {
      const { command, elevated, reason } = args;
      if (typeof command !== "string" || !command.trim()) return "Provide the exact command for the person to approve.";
      if (typeof elevated !== "boolean") return "Set elevated to false for the normal Android shell or true to request root.";
      if (reason !== undefined && typeof reason !== "string") return "reason must be text.";
      const request = service.requestApproval(sessionId, { command, elevated, reason });
      return `Waiting for approval in Cody's Devices panel. Request ID: ${request.id}. Expires: ${new Date(request.expiresAt).toISOString()}. Use wireless_command_status with this requestId; do not submit it again while it is pending.`;
    }),
    tool("wireless_command_status", "Read the state and result of this chat's exact-command approval request. This only reports; it cannot approve, execute or retry a command.", {
      requestId: { type: "string", minLength: 1, description: "The ID returned by wireless_request_command." },
    }, ["requestId"], (service, args, { sessionId }) => {
      if (typeof args.requestId !== "string" || !args.requestId) return "Pass the requestId returned by wireless_request_command.";
      const approval = service.approvalResult(sessionId, args.requestId);
      if ("error" in approval && approval.error) return failureText(approval.error);
      if ("result" in approval && approval.result) return resultText(approval.result);
      return {
        pending: "Still waiting for the person's decision in Cody's Devices panel.",
        approved: "The person approved this command and Cody is waiting for its result. A root command may be waiting for Magisk on the tablet.",
        denied: "The person denied this request. Do not try to run it another way.",
        expired: "This request expired without approval.",
        cancelled: "This request was cancelled and cannot be used again.",
        finished: "This request finished without command output.",
      }[approval.state];
    }),
  ];
}

export const DEVICE_WIRELESS_TOOLS = createWirelessTools();
