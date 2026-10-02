import type { HostToolDefinition } from "../pi-types";
import { numberArg, stringArg } from "../session-tools";
import { isRecord } from "../type-guards";
import { matchDevice, type DeviceBridge } from "./bus";
import type { HardwareAction, HardwareProtocol } from "./flasher";
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
  const protocol = stringArg(args, "protocol");
  if (!protocol || !PROTOCOLS[protocol as HardwareProtocol]) return "protocol must be one of esp, adb, fastboot, gecko, stm32, stk500, or dfu.";
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
  if ((action === "flash" || action === "push") && (!fileId || !sha256)) {
    return action + " requires a session artifact and its exact SHA-256 digest.";
  }
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
  if (action === "exec" && !command?.trim()) return "device_exec requires command.";
  const suppliedOptions = args.options;
  if (suppliedOptions !== undefined && !isRecord(suppliedOptions)) return "options must be an object.";
  if (suppliedOptions && ("approval" in suppliedOptions || "approved" in suppliedOptions || "confirm" in suppliedOptions)) {
    return "Operation options cannot carry an approval; destructive actions require direct browser UI confirmation.";
  }
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
    ...(suppliedOptions ? { options: { ...suppliedOptions } } : {}),
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
  protocol: { type: "string", enum: ["esp", "adb", "fastboot", "gecko", "stm32", "stk500", "dfu"], description: "Protocol implementation to run." },
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

export const DEVICE_OPERATION_TOOLS: DeviceOperationToolDefinition[] = [
  startDefinition("device_detect", "detect", "Start a browser-hosted protocol detection operation."),
  startDefinition("device_flash", "flash", "Start a verified flashing operation. Destructive writes pause for direct browser UI approval bound to the exact target, digest, and offset."),
  startDefinition("device_dump", "dump", "Start a device dump or backup operation; resulting bytes remain a session-owned browser artifact."),
  startDefinition("device_exec", "exec", "Run a protocol command with streamed output. ADB arbitrary shell requires the user's connection-scoped shell grant in Devices; without it only id, uname -a, df -h, getprop [ro.*] work. Other state-changing commands require exact browser confirmation.", ["device", "protocol", "command"]),
  startDefinition("device_push", "push", "Start a resumable protocol file push using a session artifact."),
  startDefinition("device_pull", "pull", "Start a protocol file pull; output remains a session-owned browser artifact."),
  startDefinition("device_monitor", "monitor", "Start an exclusive serial or ADB terminal. ADB needs the user's shell grant. Use device_monitor_send for interactive input."),
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
