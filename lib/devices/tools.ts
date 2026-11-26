/**
 * The seven agent-facing tools over the browser-hosted device bridge
 * (./bus.ts, ./protocol.ts). Structurally the same shape as
 * lib/session-tools.ts: a HostToolDefinition per tool, plus a handler that
 * always resolves to plain text — success or a short human-readable failure
 * — so a caller's dispatch never needs its own try/catch around a call here.
 *
 * The bridge already does the hard part (buffering, request/response
 * correlation, "is a browser even attached") and matchDevice already does
 * name resolution (exact id, then a case-insensitive label substring, with
 * ambiguity reported rather than guessed, and no query resolving to the sole
 * device when exactly one is attached). These handlers are thin: resolve the
 * `device` argument, translate the rest of the arguments into one DeviceOp,
 * and render the result.
 *
 * device_read is deliberately NOT branched by device kind: DeviceBridge
 * buffers bytes per device id regardless of where they came from — serial
 * RX, a BLE notification once ble_gatt subscribes, or a streamed USB IN
 * transfer (see the `data` frame in ./protocol.ts) — so one drain path reads
 * all three. device_write IS branched: the wire protocol only has a plain
 * base64 write for serial (`serial.write`); a BLE write needs a
 * service/characteristic (ble_gatt), and a raw USB OUT transfer needs an
 * endpoint number this tool never collects, so both other kinds get a clear
 * "use X instead" / "not exposed" answer rather than a guess.
 */

import type { HostToolDefinition } from "../pi-types";
import { numberArg, stringArg } from "../session-tools";
import { formatBytes } from "../format-bytes";
import { isRecord } from "../type-guards";
import { isDeviceNoData, MAX_DEVICE_TIMEOUT_MS } from "./protocol";
import { matchDevice, type DeviceBridge } from "./bus";
import type {
  DeviceActivity,
  DeviceCapabilities,
  DeviceInfo,
  UsbEndpointInfo,
  UsbInterfaceInfo,
  UsbOpenResult,
} from "./protocol";

/** What a caller's host-tool dispatch supplies to every handler here. */
export interface DeviceToolContext {
  bridge: DeviceBridge;
  /** Bound by the session dispatcher, never supplied in agent arguments. */
  cwd?: string;
  sessionId?: string;
}

export type DeviceToolArgs = Record<string, unknown>;

/** Always resolves to plain text — success or a short human-readable failure
 * — so a caller's dispatch needs no try/catch of its own. */
export type DeviceToolHandler = (args: DeviceToolArgs, ctx: DeviceToolContext) => Promise<string>;

/** Structurally a HostToolDefinition, plus the handler. */
export type DeviceToolDefinition = HostToolDefinition & { handler: DeviceToolHandler };

const MAX_CANDIDATES_SHOWN = 10;
const DEFAULT_READ_MAX_BYTES = 4096;
const HARD_MAX_READ_BYTES = 65536;
const MAX_WAIT_MS = 10_000;

/** The one fix for "nothing is attached" is always the same, so every tool
 * that hits it says it the same way bus.ts's own request() rejection does. */
const NO_BROWSER_TEXT = "No browser is attached to this session. Open Cody's Devices panel and connect a device.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byteCount(n: number): string {
  return `${n} byte${n === 1 ? "" : "s"}`;
}

type PayloadResult = { base64: string } | { error: string };

/** Validates the text/base64 XOR shared by device_write and ble_gatt's write
 * op, and re-encodes UTF-8 text so every write speaks base64 on the wire
 * regardless of which the caller supplied. */
function buildWritePayload(args: DeviceToolArgs): PayloadResult {
  const text = stringArg(args, "text");
  const base64 = stringArg(args, "base64");
  if (text !== undefined && base64 !== undefined) return { error: "Pass exactly one of text or base64, not both." };
  if (text === undefined && base64 === undefined) return { error: "Pass either text or base64 to write." };
  if (base64 !== undefined) {
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      // Buffer.from(str, "base64") silently drops invalid characters
      // instead of throwing, so a malformed payload must be rejected here.
      return { error: "base64 is not valid base64." };
    }
    return { base64 };
  }
  return { base64: Buffer.from(text as string, "utf8").toString("base64") };
}

function formatDeviceLine(device: DeviceInfo): string {
  const state = device.open ? "open" : "closed";
  return `${device.id} | ${device.label} | ${device.kind} | ${state} | ${byteCount(device.buffered ?? 0)} buffered`;
}

function formatCapabilities(caps: DeviceCapabilities): string {
  const serial = caps.serial ? "yes" : caps.serialViaUsb ? "via WebUSB polyfill" : "no";
  const surfaces = [["browser GATT", caps.bluetoothGatt, caps.bluetoothReasons?.bluetoothGatt], ["advertisement watching", caps.bluetoothAdvertisements, caps.bluetoothReasons?.bluetoothAdvertisements], ["native BLE companion", caps.nativeBluetooth, caps.bluetoothReasons?.nativeBluetooth], ["Bluetooth Classic", caps.classicBluetooth, caps.bluetoothReasons?.classicBluetooth], ["local HCI", caps.localHci, caps.bluetoothReasons?.localHci], ["OTA sniffer", caps.bluetoothOta, caps.bluetoothReasons?.bluetoothOta]].map(([name, available, reason]) => String(name) + " " + (available ? "available" : "unavailable" + (reason ? " (" + reason + ")" : "")));
  return "capabilities: secure context " + (caps.secureContext ? "yes" : "no") + ", serial " + serial + ", usb " + (caps.usb ? "yes" : "no") + ", Web Bluetooth " + (caps.bluetooth ? "yes" : "no") + ", platform " + caps.platform + "\nBluetooth surfaces: " + surfaces.join("; ");
}

function formatCandidates(query: string | undefined, candidates: DeviceInfo[]): string {
  const shown = candidates.slice(0, MAX_CANDIDATES_SHOWN);
  const lines = [
    query ? `Multiple devices match "${query}"; pass the exact id:` : "Multiple devices are attached; pass device to pick one:",
    ...shown.map(formatDeviceLine),
  ];
  if (candidates.length > MAX_CANDIDATES_SHOWN) {
    lines.push(`\u2026 ${candidates.length - MAX_CANDIDATES_SHOWN} more matches not shown.`);
  }
  return lines.join("\n");
}

function noMatchText(query: string | undefined, ctx: DeviceToolContext): string {
  if (!ctx.bridge.attached) return NO_BROWSER_TEXT;
  return query
    ? `No device matches "${query}". Run device_list to see what is attached.`
    : "No device is attached. Open Cody's Devices panel and grant access to one.";
}

type DeviceResolution = { device: DeviceInfo } | { text: string };

/**
 * A `device` argument to one DeviceInfo, through matchDevice: exact id
 * first, then a case-insensitive label substring, with no query resolving to
 * the sole attached device when there is exactly one. More than one match
 * returns the candidate list instead of picking — writing to the wrong
 * serial port is not something the next tool call can undo.
 */
function resolveDevice(query: string | undefined, ctx: DeviceToolContext): DeviceResolution {
  const match = matchDevice(ctx.bridge.list(), query);
  if (match.kind === "one") return { device: match.device };
  if (match.kind === "many") return { text: formatCandidates(query, match.candidates) };
  return { text: noMatchText(query, ctx) };
}

// ============================================================================
// device_list
// ============================================================================

/**
 * One device's traffic in words. An agent driving a long push is in exactly
 * the position the user is — it cannot tell a slow link from a dead one from
 * the return value of a call that has not come back yet — so the same
 * accounting the panel renders is readable here.
 */
function formatActivity(activity: DeviceActivity, now: number): string | null {
  const parts: string[] = [];
  const moving = activity.rateOut > 0 || activity.rateIn > 0;
  if (activity.inFlight) {
    parts.push(`${activity.inFlight.op} running for ${Math.round((now - activity.inFlight.startedAt) / 100) / 10}s`);
  }
  if (moving) parts.push(`${formatBytes(activity.rateOut)}/s out, ${formatBytes(activity.rateIn)}/s in`);
  if (activity.bytesOut > 0 || activity.bytesIn > 0) {
    parts.push(`${formatBytes(activity.bytesOut)} sent, ${formatBytes(activity.bytesIn)} received over ${activity.ops} ops`);
  }
  // Stated whenever the link is quiet, not only when nothing ever happened:
  // "is anything happening?" is exactly the question this answers, and a
  // cumulative total alone cannot distinguish a finished transfer from a
  // stalled one.
  if (!moving && !activity.inFlight && activity.lastActivityAt !== null) {
    parts.push(`idle for ${Math.round((now - activity.lastActivityAt) / 1000)}s`);
  }
  if (activity.dropped > 0) parts.push(`${formatBytes(activity.dropped)} dropped`);
  if (activity.lastError) parts.push(`last error: ${activity.lastError}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

async function deviceList(_args: DeviceToolArgs, ctx: DeviceToolContext): Promise<string> {
  if (!ctx.bridge.attached) return NO_BROWSER_TEXT;
  const devices = ctx.bridge.list();
  const lines = [formatCapabilities(ctx.bridge.capabilities), "browser attached: yes"];
  if (devices.length === 0) {
    lines.push("No devices are attached. Open Cody's Devices panel and grant access to one.");
  } else {
    const now = Date.now();
    const activity = new Map(ctx.bridge.activitySnapshot().map((entry) => [entry.deviceId, entry]));
    for (const device of devices) {
      lines.push(formatDeviceLine(device));
      const found = activity.get(device.id);
      const summary = found ? formatActivity(found, now) : null;
      if (summary) lines.push(`  ${summary}`);
    }
  }
  return lines.join("\n");
}

// ============================================================================
// device_open
// ============================================================================

const SERIAL_PARITY: Record<string, true> = { none: true, even: true, odd: true };
const SERIAL_FLOW_CONTROL: Record<string, true> = { none: true, hardware: true };

type SerialOpenResult = { params: Record<string, unknown>; baudRate: number } | { error: string };

function buildSerialOpenParams(args: DeviceToolArgs): SerialOpenResult {
  const baudRate = numberArg(args, "baudRate") ?? 115200;
  if (!Number.isInteger(baudRate) || baudRate <= 0) return { error: "baudRate must be a positive integer." };
  const params: Record<string, unknown> = { baudRate };

  const dataBits = numberArg(args, "dataBits");
  if (dataBits !== undefined) {
    if (dataBits !== 7 && dataBits !== 8) return { error: "dataBits must be 7 or 8." };
    params.dataBits = dataBits;
  }
  const stopBits = numberArg(args, "stopBits");
  if (stopBits !== undefined) {
    if (stopBits !== 1 && stopBits !== 2) return { error: "stopBits must be 1 or 2." };
    params.stopBits = stopBits;
  }
  const parity = stringArg(args, "parity");
  if (parity !== undefined) {
    if (!SERIAL_PARITY[parity]) return { error: 'parity must be "none", "even", or "odd".' };
    params.parity = parity;
  }
  const flowControl = stringArg(args, "flowControl");
  if (flowControl !== undefined) {
    if (!SERIAL_FLOW_CONTROL[flowControl]) return { error: 'flowControl must be "none" or "hardware".' };
    params.flowControl = flowControl;
  }
  return { params, baudRate };
}

/** Android's interface triplets. Naming one turns an open into an ANSWER —
 * "this device is sitting in fastboot" — rather than three numbers the agent
 * must go and look up before it knows which protocol to speak. */
function usbProtocolName(info: UsbInterfaceInfo): string | undefined {
  if (info.classCode !== 0xff || info.subclassCode !== 0x42) return undefined;
  if (info.protocolCode === 0x01) return "adb";
  if (info.protocolCode === 0x03) return "fastboot";
  return undefined;
}

/** A refusal does not identify its owner. Competing browser tabs and native
 * processes are the first thing to rule out; Windows driver ownership is a
 * second, uncertain host condition rather than a Cody diagnosis. */
const WINUSB_HINT =
  "Every USB interface claim was refused. First close any other tab or application using this device, then run device_open again. On Windows, the installed driver may prevent Chrome from claiming an interface; this error cannot identify that driver, so verify the device's driver requirements with its vendor before changing it.";

function formatUsbInterface(info: UsbInterfaceInfo): string {
  const codes = [info.classCode, info.subclassCode, info.protocolCode]
    .map((code) => code.toString(16).padStart(2, "0"))
    .join("/");
  const named = usbProtocolName(info);
  const head = `interface ${info.interfaceNumber} ${info.claimed ? "claimed" : "NOT claimed"} — ${codes}${named ? ` (${named})` : ""}`;
  if (!info.claimed) return `${head}: ${info.error ?? "the claim was refused"}`;
  const endpoints = info.endpoints.length > 0
    ? info.endpoints
      .map((endpoint) => `${endpoint.type} ${endpoint.direction.toUpperCase()} ep${endpoint.endpointNumber} (${endpoint.packetSize} B)`)
      .join(", ")
    : "no endpoints — control transfers only";
  return `${head}: ${endpoints}`;
}

/** The wire carries `unknown`; narrow it rather than cast, so an older page
 * that still answers `undefined` degrades to the plain "Opened X." line
 * instead of throwing on a missing field. */
function parseUsbOpenResult(value: unknown): UsbOpenResult | null {
  if (!isRecord(value) || !Array.isArray(value.interfaces)) return null;
  const interfaces: UsbInterfaceInfo[] = [];
  for (const raw of value.interfaces) {
    if (!isRecord(raw) || typeof raw.interfaceNumber !== "number") return null;
    const endpoints: UsbEndpointInfo[] = [];
    for (const rawEndpoint of Array.isArray(raw.endpoints) ? raw.endpoints : []) {
      if (!isRecord(rawEndpoint) || typeof rawEndpoint.endpointNumber !== "number") continue;
      endpoints.push({
        endpointNumber: rawEndpoint.endpointNumber,
        direction: rawEndpoint.direction === "in" ? "in" : "out",
        type: rawEndpoint.type === "interrupt" || rawEndpoint.type === "isochronous" ? rawEndpoint.type : "bulk",
        packetSize: typeof rawEndpoint.packetSize === "number" ? rawEndpoint.packetSize : 0,
      });
    }
    interfaces.push({
      interfaceNumber: raw.interfaceNumber,
      alternateSetting: typeof raw.alternateSetting === "number" ? raw.alternateSetting : 0,
      claimed: raw.claimed === true,
      error: typeof raw.error === "string" ? raw.error : undefined,
      classCode: typeof raw.classCode === "number" ? raw.classCode : 0,
      subclassCode: typeof raw.subclassCode === "number" ? raw.subclassCode : 0,
      protocolCode: typeof raw.protocolCode === "number" ? raw.protocolCode : 0,
      endpoints,
    });
  }
  return { configuration: typeof value.configuration === "number" ? value.configuration : undefined, interfaces };
}

function formatUsbOpen(device: DeviceInfo, value: unknown, ctx: DeviceToolContext): string {
  const result = parseUsbOpenResult(value);
  if (!result) return `Opened ${device.label}.`;
  const head = `Opened ${device.label}${result.configuration === undefined ? "" : ` (configuration ${result.configuration})`}.`;
  if (result.interfaces.length === 0) return `${head} It exposes no interface to claim, so only control transfers are possible.`;
  const lines = [head, ...result.interfaces.map((info) => `  ${formatUsbInterface(info)}`)];
  const windows = /win/i.test(ctx.bridge.capabilities.platform);
  if (windows && result.interfaces.every((info) => !info.claimed)) lines.push(WINUSB_HINT);
  return lines.join("\n");
}

/** USB-only open arguments. Omitting both is the normal path: every
 * interface of the sole configuration gets claimed. */
function buildUsbOpenParams(args: DeviceToolArgs): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const configuration = numberArg(args, "configuration");
  if (configuration !== undefined) params.configuration = Math.floor(configuration);
  const iface = numberArg(args, "interface");
  if (iface !== undefined) params.interface = Math.floor(iface);
  const alternateInterface = numberArg(args, "alternateInterface");
  const alternateSetting = numberArg(args, "alternateSetting");
  if (alternateInterface !== undefined || alternateSetting !== undefined) {
    if (alternateInterface === undefined || alternateSetting === undefined) return {};
    params.alternate = { interfaceNumber: Math.floor(alternateInterface), alternateSetting: Math.floor(alternateSetting) };
  }
  return params;
}

async function deviceOpen(args: DeviceToolArgs, ctx: DeviceToolContext): Promise<string> {
  const resolved = resolveDevice(stringArg(args, "device"), ctx);
  if ("text" in resolved) return resolved.text;
  const { device } = resolved;

  try {
    if (device.kind === "serial") {
      const built = buildSerialOpenParams(args);
      if ("error" in built) return built.error;
      await ctx.bridge.request("serial.open", device.id, built.params);
      return `Opened ${device.label} at ${built.baudRate} baud.`;
    }
    if (device.kind === "ble") {
      await ctx.bridge.request("ble.connect", device.id, {});
      return `Connected to ${device.label}.`;
    }
    return formatUsbOpen(device, await ctx.bridge.request("usb.open", device.id, buildUsbOpenParams(args)), ctx);
  } catch (error) {
    return errorText(error);
  }
}

// ============================================================================
// device_write — serial only; BLE and raw USB need more addressing than this
// tool takes (see the module doc comment).
// ============================================================================

async function deviceWrite(args: DeviceToolArgs, ctx: DeviceToolContext): Promise<string> {
  const resolved = resolveDevice(stringArg(args, "device"), ctx);
  if ("text" in resolved) return resolved.text;
  const { device } = resolved;

  if (device.kind === "ble") return `${device.label} is a BLE device; use ble_gatt with a service and characteristic to write to it.`;
  if (device.kind === "usb") return `${device.label} is a raw USB device; byte transfers to it are not yet exposed as a tool.`;

  const payload = buildWritePayload(args);
  if ("error" in payload) return payload.error;

  try {
    await ctx.bridge.request("serial.write", device.id, { base64: payload.base64 });
    return `Wrote ${byteCount(Buffer.from(payload.base64, "base64").length)} to ${device.label}.`;
  } catch (error) {
    return errorText(error);
  }
}

// ============================================================================
// device_read — kind-agnostic; drains whatever the bridge has buffered.
// ============================================================================

/** Drains up to maxBytes, waiting for the page to deliver at least one byte
 * (or a drop) until waitMs elapses. waitMs = 0 drains once, immediately.
 * The wait is event-driven: the bridge wakes readers the moment data lands,
 * so a long `waitMs` costs nothing while the line is quiet. */
async function drainWithWait(
  bridge: DeviceBridge,
  deviceId: string,
  maxBytes: number,
  waitMs: number,
  characteristic?: string,
): Promise<{ data: Buffer; dropped: number }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = bridge.read(deviceId, maxBytes, characteristic);
    if (result.data.length > 0 || result.dropped > 0) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return result;
    await bridge.waitForData(deviceId, remaining);
    // A wake means SOME source of this device moved; loop and re-read the one
    // actually asked for rather than assuming it was this characteristic.
  }
}

async function deviceRead(args: DeviceToolArgs, ctx: DeviceToolContext): Promise<string> {
  const resolved = resolveDevice(stringArg(args, "device"), ctx);
  if ("text" in resolved) return resolved.text;
  const { device } = resolved;

  const encodingArg = stringArg(args, "encoding");
  if (encodingArg !== undefined && encodingArg !== "text" && encodingArg !== "base64") {
    return 'encoding must be "text" or "base64".';
  }
  const encoding = encodingArg === "base64" ? "base64" : "text";

  const maxBytesArg = numberArg(args, "maxBytes");
  const maxBytes = maxBytesArg === undefined ? DEFAULT_READ_MAX_BYTES : Math.max(1, Math.min(Math.floor(maxBytesArg), HARD_MAX_READ_BYTES));
  const waitMsArg = numberArg(args, "waitMs");
  const waitMs = waitMsArg === undefined ? 0 : Math.max(0, Math.min(Math.floor(waitMsArg), MAX_WAIT_MS));

  // A BLE device can notify on several characteristics at once, and their
  // bytes are buffered apart: merging them would hand back interleaved binary
  // with no way to tell what produced what.
  const characteristic = stringArg(args, "characteristic");
  const { data, dropped } = await drainWithWait(ctx.bridge, device.id, maxBytes, waitMs, characteristic);

  const lines: string[] = [];
  if (data.length === 0) {
    lines.push(`No data from ${device.label}.`);
  } else {
    const body = encoding === "base64" ? data.toString("base64") : data.toString("utf8");
    lines.push(`${byteCount(data.length)} from ${device.label} (${encoding}):`);
    lines.push(body);
  }
  // Always surfaced, on top of whatever else this call reports: a console
  // that overflowed and one that merely paused must not look identical.
  if (dropped > 0) {
    lines.push(`${byteCount(dropped)} were dropped by the ring buffer before this read \u2014 read more often to keep up.`);
  }
  return lines.join("\n");
}

// ============================================================================
// device_close — one wire op regardless of kind.
// ============================================================================

async function deviceClose(args: DeviceToolArgs, ctx: DeviceToolContext): Promise<string> {
  const resolved = resolveDevice(stringArg(args, "device"), ctx);
  if ("text" in resolved) return resolved.text;
  const { device } = resolved;
  try {
    await ctx.bridge.request("close", device.id, {});
    return `Closed ${device.label}.`;
  } catch (error) {
    return errorText(error);
  }
}

// ============================================================================
// ble_gatt
// ============================================================================

const BLE_OPS: Record<string, true> = { services: true, discover: true, trace: true, read: true, write: true, subscribe: true, unsubscribe: true };

function formatBleValue(value: unknown): string {
  if (value === undefined || value === null) return "(no data)";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value.join("\n");
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A read result's value is typed `unknown` on the wire (protocol.ts); the
 * page is expected to answer with either a base64 string directly or an
 * object carrying one, so both are accepted rather than assuming one. */
function extractBase64(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.base64 === "string") return value.base64;
  return null;
}

async function bleGatt(args: DeviceToolArgs, ctx: DeviceToolContext): Promise<string> {
  const resolved = resolveDevice(stringArg(args, "device"), ctx);
  if ("text" in resolved) return resolved.text;
  const { device } = resolved;
  if (device.kind !== "ble") return `${device.label} is a ${device.kind} device, not BLE.`;

  const op = stringArg(args, "op");
  if (op === undefined || !BLE_OPS[op]) return 'op must be one of "services", "discover", "trace", "read", "write", "subscribe", "unsubscribe".';
  if (op === "services" || op === "discover") {
    try {
      const value = await ctx.bridge.request(op === "discover" ? "ble.gatt" : "ble.services", device.id, {});
      return (op === "discover" ? "Accessible GATT on " : "Services on ") + device.label + ":\n" + formatBleValue(value);
    } catch (error) { return errorText(error); }
  }
  if (op === "trace") {
    try { return "Controlled GATT trace for " + device.label + ":\n" + formatBleValue(await ctx.bridge.request("ble.trace", device.id, { action: "export" })); }
    catch (error) { return errorText(error); }
  }
  const service = stringArg(args, "service");
  const characteristic = stringArg(args, "characteristic");
  if (!service || !characteristic) return op + " requires both service and characteristic.";
  if (op === "read") {
    try {
      const value = await ctx.bridge.request("ble.read", device.id, { service, characteristic });
      const base64 = extractBase64(value);
      return base64 === null ? "Read from " + service + "/" + characteristic + ": " + formatBleValue(value) : "Read " + byteCount(Buffer.from(base64, "base64").length) + " from " + service + "/" + characteristic + ": " + base64;
    } catch (error) { return errorText(error); }
  }
  if (op === "write") {
    const payload = buildWritePayload(args);
    if ("error" in payload) return payload.error;
    const withoutResponse = args.withoutResponse === true;
    try {
      await ctx.bridge.request("ble.write", device.id, { service, characteristic, base64: payload.base64, withoutResponse });
      return "Wrote " + byteCount(Buffer.from(payload.base64, "base64").length) + " to " + service + "/" + characteristic + (withoutResponse ? " (without response)." : ".");
    } catch (error) { return errorText(error); }
  }
  const enable = op === "subscribe";
  try {
    await ctx.bridge.request("ble.subscribe", device.id, { service, characteristic, enable });
    return enable ? "Subscribed to " + service + "/" + characteristic + " on " + device.label + ". Notifications arrive as bytes via device_read." : "Unsubscribed from " + service + "/" + characteristic + " on " + device.label + ".";
  } catch (error) { return errorText(error); }
}

// ============================================================================
// usb_transfer — raw USB. Control transfers are how a device is interrogated
// before anything else is known about it (descriptors, vendor requests), and
// bulk/interrupt endpoints are how it then talks. Without this, an attached
// USB device could only be opened and looked at.
// ============================================================================

const USB_REQUEST_TYPES = new Set(["standard", "class", "vendor"]);
const USB_RECIPIENTS = new Set(["device", "interface", "endpoint", "other"]);
function quietReadTimeout(args: DeviceToolArgs): number | { error: string } | undefined {
  const timeoutMs = numberArg(args, "timeoutMs");
  if (timeoutMs === undefined) return undefined;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DEVICE_TIMEOUT_MS) {
    return { error: "timeoutMs must be an integer from 1 to " + MAX_DEVICE_TIMEOUT_MS + "." };
  }
  return timeoutMs;
}

async function usbTransfer(args: DeviceToolArgs, ctx: DeviceToolContext): Promise<string> {
  const resolved = resolveDevice(stringArg(args, "device"), ctx);
  if ("text" in resolved) return resolved.text;
  const { device } = resolved;
  if (device.kind !== "usb") return `${device.label} is a ${device.kind} device, not raw USB.`;

  const direction = stringArg(args, "direction");
  if (direction !== "in" && direction !== "out") return 'direction must be "in" or "out".';

  const encodingArg = stringArg(args, "encoding");
  if (encodingArg !== undefined && encodingArg !== "text" && encodingArg !== "base64") {
    return 'encoding must be "text" or "base64".';
  }
  const encoding = encodingArg === "base64" ? "base64" : "text";

  // An IN transfer is sized by `length`; an OUT transfer carries bytes. Asking
  // for the wrong one is the common mistake, so it is named rather than
  // silently defaulted.
  let base64: string | undefined;
  if (direction === "out") {
    const payload = buildWritePayload(args);
    if ("error" in payload) return payload.error;
    base64 = payload.base64;
  }
  const lengthArg = numberArg(args, "length");
  if (direction === "in" && lengthArg === undefined) return "An IN transfer needs length: how many bytes to request.";
  const length = lengthArg === undefined ? undefined : Math.max(0, Math.min(Math.floor(lengthArg), HARD_MAX_READ_BYTES));
  const timeoutMs = quietReadTimeout(args);
  if (timeoutMs && typeof timeoutMs === "object") return timeoutMs.error;

  const requestArg = numberArg(args, "request");
  const isControl = requestArg !== undefined;
  let value: unknown;
  try {
    if (isControl) {
      const requestType = stringArg(args, "requestType") ?? "vendor";
      const recipient = stringArg(args, "recipient") ?? "device";
      if (!USB_REQUEST_TYPES.has(requestType)) return 'requestType must be "standard", "class" or "vendor".';
      if (!USB_RECIPIENTS.has(recipient)) return 'recipient must be "device", "interface", "endpoint" or "other".';
      value = await ctx.bridge.request("usb.control", device.id, {
        direction,
        requestType,
        recipient,
        request: Math.floor(requestArg),
        value: Math.floor(numberArg(args, "value") ?? 0),
        index: Math.floor(numberArg(args, "index") ?? 0),
        length,
        base64,
      }, timeoutMs);
    } else {
      const endpoint = numberArg(args, "endpoint");
      if (endpoint === undefined) return "A bulk/interrupt transfer needs endpoint (its number); a control transfer needs request instead.";
      value = await ctx.bridge.request("usb.transfer", device.id, {
        direction,
        endpoint: Math.floor(endpoint),
        length,
        base64,
      }, timeoutMs);
    }
  } catch (error) {
    const text = errorText(error);
    // The browser's own wording for this names neither the interface nor the
    // remedy, and it is the single most likely failure against a device that
    // was opened by an older page or re-enumerated into a new identity.
    if (/claimed/i.test(text)) {
      return `${text}\nThe interface owning that endpoint is not claimed. Run device_open on ${device.label} again (it claims every interface of the active configuration and lists their endpoints); if the device rebooted into a different USB identity, it needs a fresh grant in Cody's Devices panel.`;
    }
    return text;
  }

  const kind = isControl ? "control" : "transfer";
  if (direction === "out") {
    const sent = base64 ? Buffer.from(base64, "base64").length : 0;
    return `Sent ${byteCount(sent)} to ${device.label} (${kind} OUT).`;
  }
  if (isDeviceNoData(value)) return kind + " IN from " + device.label + " timed out quietly with no data.";
  const received = extractBase64(value);
  if (received === null) return `${kind} IN from ${device.label}: ${formatBleValue(value)}`;
  const bytes = Buffer.from(received, "base64");
  if (bytes.length === 0) return `${kind} IN from ${device.label} returned no data.`;
  const body = encoding === "base64" ? received : bytes.toString("utf8");
  return `${byteCount(bytes.length)} from ${device.label} (${kind} IN, ${encoding}):\n${body}`;
}

// ============================================================================
// Registry — schemas mirror lib/session-tools.ts: no `required` array for a
// `device` that can be omitted whenever exactly one is attached, matching
// matchDevice's own `string | undefined` contract.
// ============================================================================

const DEVICE_ARG = {
  device: { type: "string", description: "Device id or a case-insensitive substring of its label; omit when exactly one device is attached." },
};

export const DEVICE_TOOLS: DeviceToolDefinition[] = [
  {
    name: "device_list",
    description: "List what this session's browser can reach: its Web Serial/WebUSB/Web Bluetooth capabilities, whether a browser is attached, and one line per device (id, label, kind, open/closed, buffered bytes).",
    parameters: { type: "object", properties: {} },
    handler: deviceList,
  },
  {
    name: "device_open",
    description: "Open a device: serial.open (baud default 115200) for a serial port, ble.connect for BLE, or usb.open for a raw USB device — dispatched from the device's kind. Opening a USB device also claims its interfaces and reports each one's class/subclass/protocol and endpoints, which is what makes usb_transfer usable without decoding descriptors first.",
    parameters: {
      type: "object",
      properties: {
        ...DEVICE_ARG,
        baudRate: { type: "number", description: "Serial only. Baud rate; defaults to 115200." },
        dataBits: { type: "number", description: "Serial only. 7 or 8." },
        stopBits: { type: "number", description: "Serial only. 1 or 2." },
        parity: { type: "string", enum: ["none", "even", "odd"], description: "Serial only." },
        flowControl: { type: "string", enum: ["none", "hardware"], description: "Serial only." },
        configuration: { type: "number", description: "USB only. Configuration value to select; defaults to the device's sole configuration." },
        interface: { type: "number", description: "USB only. Claim just this interface instead of every interface of the configuration — use it to leave a sibling interface to the OS. A named interface that cannot be claimed fails the open." },
      },
    },
    handler: deviceOpen,
  },
  {
    name: "device_write",
    description: "Write bytes to an open serial device. Exactly one of text (UTF-8) or base64 is required. For BLE use ble_gatt; raw USB writes are not exposed by a tool.",
    parameters: {
      type: "object",
      properties: {
        ...DEVICE_ARG,
        text: { type: "string", description: "UTF-8 text to write." },
        base64: { type: "string", description: "Base64-encoded bytes to write." },
      },
    },
    handler: deviceWrite,
  },
  {
    name: "device_read",
    description: "Drain buffered bytes from an open device: serial RX, a BLE notification after ble_gatt subscribes, or a streamed USB IN transfer.",
    parameters: {
      type: "object",
      properties: {
        ...DEVICE_ARG,
        waitMs: { type: "number", description: "Milliseconds to wait for at least one byte; default 0 (read whatever is already buffered), capped at 10000." },
        maxBytes: { type: "number", description: "Maximum bytes to drain in one call." },
        encoding: { type: "string", enum: ["text", "base64"], description: '"text" (default, lossy UTF-8) or "base64".' },
        characteristic: { type: "string", description: "BLE only: read notifications from this characteristic. Each subscribed characteristic buffers separately; omit for a serial or USB device." },
      },
    },
    handler: deviceRead,
  },
  {
    name: "device_close",
    description: "Close an open device.",
    parameters: { type: "object", properties: { ...DEVICE_ARG } },
    handler: deviceClose,
  },
  {
    name: "ble_gatt",
    description: 'Browser BLE GATT workbench: "discover" returns the accessible service/characteristic/descriptor tree, "trace" exports controlled GATT traffic, "read" is non-mutating, "write" needs service/characteristic plus text or base64, and subscription operations control notifications.',
    parameters: {
      type: "object",
      properties: {
        ...DEVICE_ARG,
        op: { type: "string", enum: ["services", "discover", "trace", "read", "write", "subscribe", "unsubscribe"], description: "GATT operation to perform." },
        service: { type: "string", description: "GATT service UUID. Required for read, write, subscribe, unsubscribe." },
        characteristic: { type: "string", description: "GATT characteristic UUID. Required for read, write, subscribe, unsubscribe." },
        text: { type: "string", description: 'UTF-8 text to write. For op "write", exactly one of text or base64 is required.' },
        base64: { type: "string", description: 'Base64-encoded bytes to write. For op "write", exactly one of text or base64 is required.' },
        withoutResponse: { type: "boolean", description: 'For op "write": true sends without waiting for a peripheral response.' },
      },
      required: ["op"],
    },
    handler: bleGatt,
  },
  {
    name: "usb_transfer",
    description: "Raw USB on an opened device. A control transfer (pass request) interrogates or commands the device; a bulk/interrupt transfer (pass endpoint) moves data on one endpoint. direction \"in\" reads length bytes, \"out\" sends text or base64.",
    parameters: {
      type: "object",
      properties: {
        ...DEVICE_ARG,
        direction: { type: "string", enum: ["in", "out"], description: '"in" reads from the device, "out" sends to it.' },
        request: { type: "number", description: "Control transfer: the bRequest value. Presence of this field selects a control transfer." },
        requestType: { type: "string", enum: ["standard", "class", "vendor"], description: 'Control transfer type; default "vendor".' },
        recipient: { type: "string", enum: ["device", "interface", "endpoint", "other"], description: 'Control transfer recipient; default "device".' },
        value: { type: "number", description: "Control transfer wValue; default 0." },
        index: { type: "number", description: "Control transfer wIndex; default 0." },
        endpoint: { type: "number", description: "Bulk/interrupt transfer: the endpoint number (without the direction bit)." },
        length: { type: "number", description: 'IN transfers: how many bytes to request. Required for direction "in".' },
        text: { type: "string", description: 'OUT transfers: UTF-8 text to send. Exactly one of text or base64.' },
        base64: { type: "string", description: "OUT transfers: base64-encoded bytes to send. Exactly one of text or base64." },
        encoding: { type: "string", enum: ["text", "base64"], description: 'How to render an IN result: "text" (default, lossy UTF-8) or "base64".' },
        timeoutMs: { type: "number", description: "IN transfers only: bounded quiet-read deadline in milliseconds (1-60000). A quiet deadline reports no data; it is distinct from a disconnected browser." },
      },
      required: ["direction"],
    },
    handler: usbTransfer,
  },
];

export const DEVICE_TOOL_NAMES: readonly string[] = DEVICE_TOOLS.map((tool) => tool.name);
