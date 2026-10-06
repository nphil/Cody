import type { HostToolDefinition } from "../pi-types";
import { numberArg, stringArg } from "../session-tools";
import { isRecord } from "../type-guards";
import { matchDevice, type DeviceBridge } from "./bus";
import type { HardwareAction, HardwareProtocol } from "./flasher";
import { MAX_SEND_DELAY_SECONDS } from "./protocol";
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
  edl: true,
};

const MAX_OPERATION_TEXT = 16 * 1024;

function operationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveDeviceId(args: DeviceOperationToolArgs, bridge: DeviceBridge, options: { allowDeparted?: boolean } = {}): { deviceId: string } | { error: string } {
  const query = stringArg(args, "device");
  const match = matchDevice(bridge.list(), query);
  if (match.kind === "one") return { deviceId: match.device.id };
  if (!bridge.attached) return { error: "No browser is attached to this session. Open Cody's Devices panel and connect a device." };
  // Only a wait-for-device may name a device that is absent right now (it is rebooting or
  // re-enumerating), and only by the exact id this session was granted it under.
  if (options.allowDeparted && query && bridge.departedDevice(query)) return { deviceId: query };
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
  const waitsForDevice = action === "exec" && stringArg(args, "protocol") === "adb" && isRecord(args.options) && args.options.kind === "wait-for-device";
  const device = resolveDeviceId(args, bridge, { allowDeparted: waitsForDevice });
  if ("error" in device) return device.error;
  const protocol = stringArg(args, "protocol") ?? (action === "forward" || action === "reverse" ? "adb" : undefined);
  if (!protocol || !PROTOCOLS[protocol as HardwareProtocol]) return "protocol must be one of esp, adb, fastboot, gecko, stm32, stk500, dfu, edl, or serial.";
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
  if ((action === "flash" || action === "push" || action === "sideload" || action === "install") && (!fileId || !sha256)) {
    return action + " requires a session artifact and its exact SHA-256 digest.";
  }
  if (action === "verify" && (!sha256 || !length || !target)) return "verify requires target, length, and the expected raw-image SHA-256.";
  const known = bridge.list().find((entry) => entry.id === device.deviceId) ?? bridge.departedDevice(device.deviceId);
  const descriptorCandidates = known?.protocolCandidates
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
  if (suppliedOptions && "sendDelaySeconds" in suppliedOptions) {
    const delay = suppliedOptions.sendDelaySeconds;
    if (typeof delay !== "number" || !Number.isInteger(delay) || delay < 1 || delay > MAX_SEND_DELAY_SECONDS) {
      return `options.sendDelaySeconds must be a whole number of seconds from 1 to ${MAX_SEND_DELAY_SECONDS}.`;
    }
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
  if (snapshot.state === "awaiting-trust") {
    lines.push("Waiting for the user to trust this device: Cody asked them once, in the chat (\"Let the agent control the device?\"), and every operation on it queues behind that one answer. It has no time limit: it ends when they answer, when you cancel it, or when the device leaves the USB bus. Nothing has been sent to the device.");
  }
  if (snapshot.countdown) {
    const { binding, startedAt, releaseAt } = snapshot.countdown;
    lines.push(`Counting down to ${binding.action} on ${binding.target}: it is sent ${Math.round((releaseAt - startedAt) / 1000)} s after the countdown started unless the user cancels it or the device changes. Nothing has been sent yet.`);
  }
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
      const delay = request.options?.sendDelaySeconds;
      const timing = typeof delay === "number"
        ? ` Cody counts down ${delay} s, visibly and with a Cancel button, before it sends the first command: tell the user so they can get ready.`
        : "";
      return `Operation ${id} was accepted by the browser and is running independently. Progress and output appear in the Devices panel; use device_operation_status with operationId ${id} to retrieve its current snapshot.${timing}`;
    } catch (error) {
      return `Could not start device operation: ${operationError(error)}`;
    }
  };
}

const OPERATION_PROPERTIES = {
  device: { type: "string", description: "Exact browser device id from device_list." },
  protocol: { type: "string", enum: ["esp", "adb", "fastboot", "gecko", "stm32", "stk500", "dfu", "edl", "serial"], description: "Protocol implementation to run. Use serial for an interactive CDC/UART console." },
  target: { type: "string", description: "Exact destination, partition, path, or address used by the protocol." },
  offset: { type: "number", description: "Exact byte offset, when supported." },
  length: { type: "number", description: "Exact byte length, when supported." },
  fileId: { type: "string", description: "Opaque session artifact id selected in the Devices panel." },
  sha256: { type: "string", description: "Exact SHA-256 displayed for fileId; required with fileId." },
  baudRate: { type: "number", description: "Serial monitor baud rate." },
   interfaceNumber: { type: "number", description: "USB interface number for an exclusive operation lease." },
  alternateSetting: { type: "number", description: "USB alternate setting paired with interfaceNumber from device_detect." },
  command: { type: "string", description: "Exact command for device_exec." },
  options: { type: "object", description: "Protocol-specific validated configuration (for example safety or DFU descriptor data). The one key every protocol shares is sendDelaySeconds (1-300): a visible countdown, with a Cancel button, before the first command is sent, so the user can get their hands on the device's buttons first. It is not an approval." },
} as const;

/**
 * Appended to every start tool that takes control of a device, so it is written once. The bridge for engines launched
 * over MCP (bin/cody-display-mcp.js) carries a copy; its test fails when the two differ.
 */
export const DEVICE_TRUST_NOTE = "Needs the user's one-time trust of the device: the first control operation (anything but device_detect) asks them once in the chat and the others queue behind that one question; nothing else asks for approval afterwards. If they decline, every queued operation fails with \"The user declined control of <device>; do not ask again until they reconnect it\" - stop using that device until they do. An unanswered question has no time limit.";
const DEVICE_TRUST_TOOLS: Record<string, true> = { device_flash: true, device_dump: true, device_exec: true, device_push: true, device_pull: true, device_sideload: true, device_install: true, device_verify: true, device_monitor: true, device_forward: true, device_reverse: true };

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

const DEVICE_SIDE_EXEC_KINDS = ["reverse-list", "reverse-remove", "reverse-remove-all", "root", "unroot", "tcpip", "usb", "wait-for-device"];

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
        ? `${text} Once it is running, device_operation_status shows the bound host port and device_tunnels lists every rule.`
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
        : `not established yet (${snapshot.state === "awaiting-trust" ? "waiting for the user to trust the device" : snapshot.state})`;
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
  startDefinition("device_detect", "detect", "Start a browser-hosted protocol detection operation (read-only: it needs no trust). Protocol edl reads a Qualcomm 9008 device's boot-ROM identity (chip serial number, hardware id, public-key hash) and needs no loader."),
  startDefinition("device_flash", "flash", "Start browser-hosted flashing. Fastboot without fetch can write after an UNVERIFIED warning; verify in ADB recovery afterwards. ESP, DFU, STM32 and STK500 refuse a protected destination unless options.protectedOverride names the exact override (the refusal says which); nothing else is asked. Protocol edl (Qualcomm 9008): target is the exact GPT partition name, fileId + sha256 the image, which must be exactly the partition's size or smaller with options.pad set to zero or ff (the partition is always written whole). The partition is saved first, boot0 / boot1 / rpmb are refused, a cancel lands between blocks, and the read-back SHA-256 decides verified (a mismatch says POSSIBLY MODIFIED and where the saved copy is; no read-back means UNVERIFIED). A programmer must already be running: run device_exec connect first; flash never sends a loader."),
  startDefinition("device_dump", "dump", "Start a device dump or backup operation; resulting bytes remain a session-owned browser artifact. Protocol edl: target is the exact GPT partition name (optional offset/length in bytes, sector-aligned), or user-area with options.sectors set to the sector count that device_exec check verified; while the device is still in the boot ROM, fileId + sha256 name the loader file to send."),
  startDefinition("device_exec", "exec", "Run a protocol command with streamed output. ADB runs arbitrary shell commands. ADB also takes options.kind: reverse-list (adb reverse --list), reverse-remove with target tcp:PORT, or reverse-remove-all; these need no command. ADB options.kind root, unroot, tcpip (with options.port), and usb restart adbd; the device usually leaves the USB bus and the operation keeps running through that one disconnect, takes the SAME device (same USB identity) again, and checks what the device itself reports (tcpip and usb check adbd's effective listeners, which fixed service.adb.listen_addrs can override, and say so when they do; usb also reads Wireless debugging, a separate TLS listener it cannot switch off, and reports the device as not USB-only, with verified false, while that is on); options.timeoutSeconds 1-300 bounds how long it waits for the device to come back. That disconnect ends trust the user gave only for this connection, so the next operation may ask again (a remembered device is not asked again). options.kind wait-for-device waits for the device to be online (options.timeoutSeconds 1-600 covers connecting, approval of the RSA prompt on the device and every reconnect; options.state device, recovery, or sideload); it can be started while the device is absent (rebooting) by the exact id it had before, and it only ever waits for that same device. ESP takes esptool-style commands: chip_id, read_mac, flash_id, get_security_info, efuse_summary, efuse_dump (read-only), and erase_flash / erase_region ADDRESS SIZE (backs the range up first). Fastboot also takes stage and get_staged, and update / flashall with a package ZIP as the artifact. DFU takes abort, clear_status, reset, and leave ADDRESS (DfuSe). EDL (Qualcomm 9008) takes connect (sends the loader given as fileId + sha256 when the device is still in the boot ROM, then configures the programmer and reports its eMMC storage), printgpt (the primary and the real backup partition table, saved as artifacts), check (whether the partition table, the measured capacity and the last sector agree), reset (leaves EDL), erase (target = the exact GPT partition name: the partition is saved first, then the programmer's own erase, then a read-back that reports what the partition reads as - boot0/boot1/rpmb are refused), backup (no target; saves every partition and both partition tables as artifacts plus a manifest, whose SHA-256 is in the result; the loader goes as fileId + sha256 while the device is still in the boot ROM, and only a set taken that way carries the boot ROM's identity and can be restored - one taken from a running programmer says NOT RESTORABLE) restore (fileId + sha256 = the loader, options.manifestSha256 = the manifest's SHA-256; the device must have been freshly put into EDL mode; chip serial and public-key hash are compared before the loader is sent, eMMC serial and disk GUID before anything is saved; what it will overwrite is saved first; partitions are written first, the backup partition table next and the primary table last, and each region is read back before the next) and setbootablestoragedrive (target = the drive number 0-7; always UNVERIFIED because nothing can read the setting back). Flash, erase and setbootablestoragedrive never send a loader: run connect first.", ["device", "protocol"]),
  startDefinition("device_push", "push", "Start a resumable protocol file push using a session artifact."),
  startDefinition("device_pull", "pull", "Start a protocol file pull; output remains a session-owned browser artifact."),
  startDefinition("device_sideload", "sideload", "Serve a session artifact to ADB recovery sideload; transfer completion does not verify installation."),
  startDefinition("device_install", "install", "adb install: copy an APK (a session artifact) to the device, hash-check it there, and run pm install on it. options may set replace, downgrade, grantPermissions, testOnly (true/false). Split APKs and app bundles are not supported. device_operation_cancel ends it at once, also while pm is running, and removes the staged copy; pm itself may still finish installing the app."),
  startDefinition("device_verify", "verify", "After a Fastboot write without fetch support, compare an exact raw-image byte range in ADB recovery with the expected SHA-256. Needs target, length and sha256.", ["device", "protocol", "target", "length", "sha256"]),
  startDefinition("device_monitor", "monitor", "Start a serial or ADB terminal; an ADB terminal shares the device's ADB connection with port rules, shells and pulls. Use device_monitor_send for interactive input."),
  tunnelDefinition("device_forward", "forward", "adb forward: make a device service reachable on the Cody server. Starts a long-running operation that listens on 127.0.0.1:PORT of the machine running Cody (NOT the tablet or PC holding the device) and relays each connection to the device service through the browser's ADB connection. The rule lives until device_operation_cancel, device_tunnels remove, or a disconnect. target is the device service (tcp:PORT, localabstract:NAME, localreserved:NAME, localfilesystem:PATH, dev:PATH, jdwp:PID); local is tcp:PORT or tcp:0 for any free port, 1024 or above."),
  tunnelDefinition("device_reverse", "reverse", "adb reverse: let apps on the device reach a service on the Cody server. Starts a long-running operation; the device listens on target (tcp:PORT, tcp:0, localabstract:NAME, localreserved:NAME, localfilesystem:PATH) and each connection is relayed through the browser to 127.0.0.1:PORT of the machine running Cody, given as local (tcp:PORT). It never reaches Cody's own port. The rule lives until device_operation_cancel, device_tunnels remove, or a disconnect."),
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
    description: "Send immediate UTF-8 input to a running serial or ADB terminal. Input is never replayed after cancel/reconnect.",
    parameters: { type: "object", properties: { operationId: { type: "string" }, text: { type: "string" } }, required: ["operationId", "text"] },
    handler: monitorSend,
  },
];

for (const tool of DEVICE_OPERATION_TOOLS) {
  if (DEVICE_TRUST_TOOLS[tool.name]) tool.description = `${tool.description} ${DEVICE_TRUST_NOTE}`;
}

export const DEVICE_OPERATION_TOOL_NAMES: readonly string[] = DEVICE_OPERATION_TOOLS.map((tool) => tool.name);
