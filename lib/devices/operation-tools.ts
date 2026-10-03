import type { HostToolDefinition } from "../pi-types";
import { numberArg, stringArg } from "../session-tools";
import { isRecord } from "../type-guards";
import { matchDevice, type DeviceBridge } from "./bus";
import type { HardwareAction, HardwareProtocol } from "./flasher";
import { parseDeviceSpec, parseHostSpec } from "./tunnel";
import type { DeviceOperationRequest, DeviceOperationSnapshot } from "./operations";

export interface DeviceOperationToolContext {
  bridge: DeviceBridge;
}

export type DeviceOperationToolArgs = Record<string, unknown>;
export type DeviceOperationToolHandler = (
  args: DeviceOperationToolArgs,
  context: DeviceOperationToolContext,
) => Promise<string>;
export type DeviceOperationToolDefinition = HostToolDefinition & { handler: DeviceOperationToolHandler };

const PROTOCOLS: Record<HardwareProtocol, true> = {
  serial: true,
  esp: true,
  adb: true,
  fastboot: true,
  gecko: true,
  stm32: true,
  stk500: true,
  dfu: true,
};

const MAX_OPERATION_TEXT = 16 * 1024;

function operationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveDeviceId(args: DeviceOperationToolArgs, bridge: DeviceBridge): { deviceId: string } | { error: string } {
  const query = stringArg(args, "device");
  const match = matchDevice(bridge.list(), query);
  if (match.kind === "one") return { deviceId: match.device.id };
  if (!bridge.attached) return { error: "No browser is attached to this session. Open Cody's Devices panel and connect a device." };
  if (match.kind === "many") return { error: `Multiple devices match ${query ? `"${query}"` : "this request"}; pass an exact device id.` };
  return { error: query ? `No device matches "${query}".` : "Pass the exact device id from device_list." };
}

function operationId(args: DeviceOperationToolArgs): string | undefined {
  const value = stringArg(args, "operationId");
  if (!value?.trim()) return undefined;
  return value;
}

function optionalInteger(args: DeviceOperationToolArgs, key: "offset" | "length" | "baudRate" | "interfaceNumber" | "alternateSetting"): number | undefined | string {
  const value = numberArg(args, key);
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < (key === "length" || key === "baudRate" ? 1 : 0)) {
    return `${key} must be a safe integer${key === "length" || key === "baudRate" ? " greater than zero" : " at least zero"}.`;
  }
  return value;
}

function requestFor(
  action: HardwareAction,
  args: DeviceOperationToolArgs,
  bridge: DeviceBridge,
): DeviceOperationRequest | string {
  const device = resolveDeviceId(args, bridge);
  if ("error" in device) return device.error;
  const protocol = stringArg(args, "protocol") ?? (action === "forward" || action === "reverse" ? "adb" : undefined);
  if (!protocol || !PROTOCOLS[protocol as HardwareProtocol]) return "protocol must be one of esp, adb, fastboot, gecko, stm32, stk500, dfu, or serial.";
  const offset = optionalInteger(args, "offset");
  if (typeof offset === "string") return offset;
  const length = optionalInteger(args, "length");
  if (typeof length === "string") return length;
  const baudRate = optionalInteger(args, "baudRate");
  if (typeof baudRate === "string") return baudRate;
  let interfaceNumber = optionalInteger(args, "interfaceNumber");
   if (typeof interfaceNumber === "string") return interfaceNumber;
  let alternateSetting = optionalInteger(args, "alternateSetting");
  if (typeof alternateSetting === "string") return alternateSetting;
  const target = stringArg(args, "target");
  const command = stringArg(args, "command");
  const fileId = stringArg(args, "fileId");
  const sha256 = stringArg(args, "sha256")?.toLowerCase();
  if (fileId && !sha256) return "fileId requires the exact SHA-256 shown for that session artifact.";
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) return "sha256 must be a 64-character hexadecimal digest.";
  if ((action === "flash" || action === "push" || action === "sideload") && (!fileId || !sha256)) {
    return action + " requires a session artifact and its exact SHA-256 digest.";
  }
  if (action === "verify" && (!sha256 || !length || !target)) return "verify requires target, length, and the expected raw-image SHA-256.";
  const descriptorCandidates = bridge.list().find((entry) => entry.id === device.deviceId)?.protocolCandidates
    ?.filter((candidate) => candidate.protocol === protocol) ?? [];
  if (interfaceNumber === undefined && descriptorCandidates.length === 1) {
    interfaceNumber = descriptorCandidates[0].interfaceNumber;
    alternateSetting = descriptorCandidates[0].alternateSetting;
  }
  if (interfaceNumber === undefined && descriptorCandidates.length > 1) {
    return "Multiple USB interfaces advertise " + protocol + "; pass the exact interfaceNumber reported by device_detect.";
  }
  if (interfaceNumber !== undefined && alternateSetting === undefined) {
    const interfaceCandidates = descriptorCandidates.filter((candidate) => candidate.interfaceNumber === interfaceNumber);
    if (interfaceCandidates.length === 1) alternateSetting = interfaceCandidates[0].alternateSetting;
  }
  if (interfaceNumber !== undefined && descriptorCandidates.length > 0 && !descriptorCandidates.some((candidate) => candidate.interfaceNumber === interfaceNumber && candidate.alternateSetting === alternateSetting)) {
    return "USB interface " + interfaceNumber + " alternate setting " + (alternateSetting ?? "(required)") + " does not advertise " + protocol + " on this device.";
  }
  if (command && command.length > MAX_OPERATION_TEXT) return "command is too large.";
  const suppliedOptions = args.options;
  if (suppliedOptions !== undefined && !isRecord(suppliedOptions)) return "options must be an object.";
  if (suppliedOptions && ("approval" in suppliedOptions || "approved" in suppliedOptions || "confirm" in suppliedOptions)) {
    return "Operation options cannot carry an approval; destructive actions require direct browser UI confirmation.";
  }
  const deviceSideKind = DEVICE_SIDE_EXEC_KINDS.includes(String(suppliedOptions?.kind));
  if (action === "exec" && !command?.trim() && !deviceSideKind) return "device_exec requires command.";
  const local = stringArg(args, "local");
  const tunnel = action === "forward" || action === "reverse";
  if (tunnel) {
    if (protocol !== "adb") return action + " is an ADB feature: use protocol adb.";
    try {
      parseDeviceSpec(target, action);
      parseHostSpec(local, action);
    } catch (error) {
      return operationError(error);
    }
  }
  const options = tunnel ? { ...suppliedOptions, local } : suppliedOptions ? { ...suppliedOptions } : undefined;
  return {
    protocol: protocol as HardwareProtocol,
    action,
    deviceId: device.deviceId,
    ...(target ? { target } : {}),
    ...(command ? { command } : {}),
    ...(fileId ? { fileId } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(offset === undefined ? {} : { offset }),
    ...(length === undefined ? {} : { length }),
    ...(baudRate === undefined ? {} : { baudRate }),
     ...(interfaceNumber === undefined ? {} : { interfaceNumber }),
    ...(alternateSetting === undefined ? {} : { alternateSetting }),
    ...(options ? { options } : {}),
  };
}

function describeSnapshot(snapshot: DeviceOperationSnapshot): string {
  const progress = snapshot.progress
    ? `${snapshot.progress.phase}${snapshot.progress.completed !== undefined && snapshot.progress.total !== undefined ? ` ${snapshot.progress.completed}/${snapshot.progress.total}` : ""}${snapshot.progress.message ? ` — ${snapshot.progress.message}` : ""}`
    : "no progress reported";
  const lines = [
    `Operation ${snapshot.id}: ${snapshot.state}.`,
    `Protocol/action: ${snapshot.request.protocol}/${snapshot.request.action}; device: ${snapshot.request.deviceId}.`,
    `Progress: ${progress}.`,
  ];
  if (snapshot.confirmation) lines.push(`Awaiting direct UI confirmation for ${snapshot.confirmation.binding.action} on ${snapshot.confirmation.binding.target}.`);
  if (snapshot.error) lines.push(`Error: ${snapshot.error}`);
  if (snapshot.result) lines.push(`Result: ${snapshot.result.summary}`);
  for (const output of snapshot.output.slice(-20)) lines.push(output.line);
  return lines.join("\n");
}

function startingHandler(action: HardwareAction): DeviceOperationToolHandler {
  return async (args, context) => {
    const request = requestFor(action, args, context.bridge);
    if (typeof request === "string") return request;
    try {
      const id = await context.bridge.startOperation(request);
      return `Operation ${id} was accepted by the browser and is running independently. Progress will arrive in the live transcript; use device_operation_status with operationId ${id} to retrieve its current snapshot.`;
    } catch (error) {
      return `Could not start device operation: ${operationError(error)}`;
    }
  };
}

const OPERATION_PROPERTIES = {
  device: { type: "string", description: "Exact browser device id from device_list." },
  protocol: { type: "string", enum: ["esp", "adb", "fastboot", "gecko", "stm32", "stk500", "dfu", "serial"], description: "Protocol implementation to run. Use serial for an interactive CDC/UART console." },
  target: { type: "string", description: "Exact destination, partition, path, or address used by the protocol." },
  offset: { type: "number", description: "Exact byte offset, when supported." },
  length: { type: "number", description: "Exact byte length, when supported." },
  fileId: { type: "string", description: "Opaque session artifact id selected in the Devices panel." },
  sha256: { type: "string", description: "Exact SHA-256 displayed for fileId; required with fileId." },
  baudRate: { type: "number", description: "Serial monitor baud rate." },
   interfaceNumber: { type: "number", description: "USB interface number for an exclusive operation lease." },
  alternateSetting: { type: "number", description: "USB alternate setting paired with interfaceNumber from device_detect." },
  command: { type: "string", description: "Exact command for device_exec." },
  options: { type: "object", description: "Protocol-specific validated configuration (for example safety or DFU descriptor data). It cannot approve a risk." },
} as const;

function startDefinition(name: string, action: HardwareAction, description: string, required: readonly string[] = ["device", "protocol"]): DeviceOperationToolDefinition {
  return {
    name,
    description,
    parameters: { type: "object", properties: OPERATION_PROPERTIES, required: [...required] },
    handler: startingHandler(action),
  };
}

const operationStatus: DeviceOperationToolHandler = async (args, context) => {
  const id = operationId(args);
  if (!id) return "operationId is required.";
  const snapshot = context.bridge.operationStatus(id);
  if (!snapshot) return "Unknown device operation in this session.";
  return describeSnapshot(snapshot);
};

const operationCancel: DeviceOperationToolHandler = async (args, context) => {
  const id = operationId(args);
  if (!id) return "operationId is required.";
  try {
    await context.bridge.cancelOperation(id);
    return `Cancellation was sent for operation ${id}. It remains active until the browser reports its terminal snapshot.`;
  } catch (error) {
    return `Could not cancel device operation: ${operationError(error)}`;
  }
};

const monitorSend: DeviceOperationToolHandler = async (args, context) => {
  const id = operationId(args);
  const text = stringArg(args, "text");
  if (!id || !text) return "operationId and non-empty text are required.";
  if (text.length > MAX_OPERATION_TEXT) return "Monitor input is too large.";
  try {
    await context.bridge.sendOperation(id, text);
    return `Sent monitor input to operation ${id}.`;
  } catch (error) {
    return `Could not send monitor input: ${operationError(error)}`;
  }
};

const DEVICE_SIDE_EXEC_KINDS = ["reverse-list", "reverse-remove", "reverse-remove-all"];

const TUNNEL_PROPERTIES = {
  device: OPERATION_PROPERTIES.device,
  target: { type: "string", description: "Device-side address, for example tcp:8080." },
  local: { type: "string", description: "Host address on the Cody server, tcp:PORT." },
} as const;

function tunnelDefinition(name: string, action: "forward" | "reverse", description: string): DeviceOperationToolDefinition {
  const start = startingHandler(action);
  return {
    name,
    description,
    parameters: { type: "object", properties: TUNNEL_PROPERTIES, required: ["device", "target", "local"] },
    handler: async (args, context) => {
      const text = await start(args, context);
      return text.startsWith("Operation ")
        ? `${text} A port rule waits for the user's confirmation in the Devices panel first; once it is running, device_operation_status shows the bound host port and device_tunnels lists every rule.`
        : text;
    },
  };
}

function isTunnelOperation(snapshot: DeviceOperationSnapshot): boolean {
  return snapshot.request.protocol === "adb" && (snapshot.request.action === "forward" || snapshot.request.action === "reverse");
}

function isFinished(snapshot: DeviceOperationSnapshot): boolean {
  return snapshot.state === "succeeded" || snapshot.state === "failed" || snapshot.state === "cancelled";
}

function describeRule(snapshot: DeviceOperationSnapshot, port: number | undefined): string {
  const local = typeof snapshot.request.options?.local === "string" ? snapshot.request.options.local : "?";
  const host = port === undefined ? local : `tcp:${port} (127.0.0.1)`;
  return snapshot.request.action === "forward"
    ? `forward ${host} -> device ${snapshot.request.target}`
    : `reverse device ${snapshot.request.target} -> ${host}`;
}

const tunnelsHandler: DeviceOperationToolHandler = async (args, context) => {
  const action = stringArg(args, "action") ?? "list";
  const { bridge } = context;
  const live = bridge.tunnels.list();
  const open = bridge.operationSnapshots().filter((snapshot) => isTunnelOperation(snapshot) && !isFinished(snapshot));
  if (action === "list") {
    if (open.length === 0) return "No adb forward or reverse rules are active in this session.";
    const lines = open.map((snapshot) => {
      const rule = live.find((entry) => entry.operationId === snapshot.id);
      const traffic = rule
        ? `${rule.connections} open connection(s), ${rule.bytesToDevice} B to the device, ${rule.bytesFromDevice} B from it`
        : `not established yet (${snapshot.confirmation ? "waiting for the user's confirmation" : snapshot.state})`;
      return `- operation ${snapshot.id}: ${describeRule(snapshot, rule?.port)}; device ${snapshot.request.deviceId}; ${traffic}.`;
    });
    return ["Active port rules:", ...lines].join("\n");
  }
  if (action === "remove") {
    const id = operationId(args);
    if (!id) return "operationId is required.";
    const snapshot = bridge.operationStatus(id);
    if (!snapshot || !isTunnelOperation(snapshot)) return "That operation is not a forward/reverse rule in this session.";
    if (isFinished(snapshot)) return "That rule has already ended.";
    try {
      await bridge.cancelOperation(id);
      return `Removal was sent for ${describeRule(snapshot, live.find((entry) => entry.operationId === id)?.port)}. It stays listed until the browser reports it ended.`;
    } catch (error) {
      return `Could not remove the rule: ${operationError(error)}`;
    }
  }
  if (action === "remove_all") {
    if (open.length === 0) return "No adb forward or reverse rules are active in this session.";
    const failures: string[] = [];
    for (const snapshot of open) {
      try {
        await bridge.cancelOperation(snapshot.id);
      } catch (error) {
        failures.push(`${snapshot.id}: ${operationError(error)}`);
      }
    }
    return failures.length === 0
      ? `Removal was sent for ${open.length} rule(s).`
      : `Removal was sent for ${open.length - failures.length} of ${open.length} rule(s). Failed: ${failures.join("; ")}`;
  }
  return "action must be list, remove, or remove_all.";
};

export const DEVICE_OPERATION_TOOLS: DeviceOperationToolDefinition[] = [
  startDefinition("device_detect", "detect", "Start a browser-hosted protocol detection operation."),
  startDefinition("device_flash", "flash", "Start browser-hosted flashing. Writes pause for direct confirmation with exact target, hash and backup status. Fastboot without fetch can write after an UNVERIFIED warning; verify in ADB recovery afterwards. Protected destinations require an exact typed override."),
  startDefinition("device_dump", "dump", "Start a device dump or backup operation; resulting bytes remain a session-owned browser artifact."),
  startDefinition("device_exec", "exec", "Run a protocol command with streamed output. ADB arbitrary shell requires the user's connection-scoped shell grant in Devices; without it only id, uname -a, df -h, getprop [ro.*] work. Other state-changing commands require exact browser confirmation. ADB also takes options.kind: reverse-list (adb reverse --list), reverse-remove with target tcp:PORT, or reverse-remove-all; these need no command.", ["device", "protocol"]),
  startDefinition("device_push", "push", "Start a resumable protocol file push using a session artifact."),
  startDefinition("device_pull", "pull", "Start a protocol file pull; output remains a session-owned browser artifact."),
  startDefinition("device_sideload", "sideload", "Serve a session artifact to ADB recovery sideload. Requires direct approval; transfer completion does not verify installation."),
  startDefinition("device_verify", "verify", "After a Fastboot write without fetch support, compare an exact raw-image byte range in ADB recovery with the expected SHA-256. Needs target, length, sha256 and the shell grant.", ["device", "protocol", "target", "length", "sha256"]),
  startDefinition("device_monitor", "monitor", "Start a serial or ADB terminal. ADB needs the user's shell grant; it shares the device's ADB connection with port rules, shells and pulls. Use device_monitor_send for interactive input."),
  tunnelDefinition("device_forward", "forward", "adb forward: make a device service reachable on the Cody server. Starts a long-running operation that listens on 127.0.0.1:PORT of the machine running Cody (NOT the tablet or PC holding the device) and relays each connection to the device service through the browser's ADB connection. Requires the user's direct confirmation; the rule lives until device_operation_cancel, device_tunnels remove, or a disconnect. target is the device service (tcp:PORT, localabstract:NAME, localreserved:NAME, localfilesystem:PATH, dev:PATH, jdwp:PID); local is tcp:PORT or tcp:0 for any free port, 1024 or above."),
  tunnelDefinition("device_reverse", "reverse", "adb reverse: let apps on the device reach a service on the Cody server. Starts a long-running operation; the device listens on target (tcp:PORT, tcp:0, localabstract:NAME, localreserved:NAME, localfilesystem:PATH) and each connection is relayed through the browser to 127.0.0.1:PORT of the machine running Cody, given as local (tcp:PORT). Requires the user's direct confirmation and never reaches Cody's own port. The rule lives until device_operation_cancel, device_tunnels remove, or a disconnect."),
  {
    name: "device_tunnels",
    description: "adb forward/reverse --list, --remove and --remove-all for this session: list the live port rules (host port, device address, connections, bytes), remove one by its operationId, or remove them all. Rules created by other programs on the device are reached with device_exec options.kind reverse-list, reverse-remove, or reverse-remove-all.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "remove", "remove_all"], description: "Defaults to list." },
        operationId: { type: "string", description: "The forward/reverse operation to remove; required for remove." },
      },
      required: [],
    },
    handler: tunnelsHandler,
  },
  {
    name: "device_operation_status",
    description: "Read the bounded current snapshot and recent output for a device operation id.",
    parameters: { type: "object", properties: { operationId: { type: "string" } }, required: ["operationId"] },
    handler: operationStatus,
  },
  {
    name: "device_operation_cancel",
    description: "Cancel a running device operation by operation id. No write is replayed after cancellation.",
    parameters: { type: "object", properties: { operationId: { type: "string" } }, required: ["operationId"] },
    handler: operationCancel,
  },
  {
    name: "device_monitor_send",
    description: "Send immediate UTF-8 input to a running serial or ADB terminal. ADB requires the current shell grant. Input is never replayed after cancel/reconnect.",
    parameters: { type: "object", properties: { operationId: { type: "string" }, text: { type: "string" } }, required: ["operationId", "text"] },
    handler: monitorSend,
  },
];

export const DEVICE_OPERATION_TOOL_NAMES: readonly string[] = DEVICE_OPERATION_TOOLS.map((tool) => tool.name);
