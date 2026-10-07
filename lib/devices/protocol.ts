/**
 * Hardware the BROWSER can reach, made usable by the agent.
 *
 * The device is plugged into whatever machine is running the browser — a
 * laptop, a phone, the tablet on the bench — not into the server Cody runs on.
 * So the browser is the device host and the server owns no handles at all: the
 * agent asks, the server relays the request down the page's socket, the page
 * performs it against the real `SerialPort` / `USBDevice` /
 * `BluetoothRemoteGATTCharacteristic`, and the answer comes back the same way.
 *
 * Three browser APIs, and the differences matter enough that Cody reports them
 * rather than pretending they are one thing:
 *
 * | API            | desktop Chrome/Edge | Chrome on Android | Safari / Firefox |
 * |----------------|---------------------|-------------------|------------------|
 * | Web Serial     | yes                 | NO                | no               |
 * | WebUSB         | yes                 | yes               | no               |
 * | Web Bluetooth  | yes                 | yes               | no               |
 *
 * Android has no Web Serial, which is exactly the case a USB-to-UART adapter
 * lands in, so a serial port there is reached through WebUSB with the
 * `web-serial-polyfill` CDC driver — the same route esptool-js documents for
 * Android. The polyfill only works where no kernel driver has already claimed
 * the interface (true on Android, false for CDC devices on desktop Linux),
 * which is why the real API is always preferred when it exists.
 *
 * All three need a SECURE CONTEXT and a user gesture. An instance reached over
 * plain http:// on a LAN address has no `navigator.serial` at all — nothing
 * Cody can do about it, so the panel says so instead of showing a button that
 * throws.
 *
 * The port object the client hands around is deliberately Web Serial-shaped
 * (open/close/readable/writable/setSignals), so the same handle can be passed
 * straight to esptool-js when real flashing lands.
 */

import type {
  PageOperationCommand,
  PageOperationProgressFrame,
  PageOperationResultFrame,
  PageOperationSnapshotFrame,
} from "./operations";
import { parseTunnelMessage, type TunnelFrame } from "./tunnel";
export type DeviceKind = "serial" | "usb" | "ble";

/** How a serial port is actually reached, which decides what can be expected
 * of it (the polyfill has no signal control on some adapters). */
export type SerialTransport = "web-serial" | "webusb-polyfill";
export interface DeviceProtocolCandidate {
  protocol: "adb" | "fastboot" | "dfu" | "edl" | "serial";
  interfaceNumber: number;
  alternateSetting: number;
}
/** Session-scoped browser file metadata. Blobs never cross the device socket. */
export interface DeviceArtifactInfo {
  id: string;
  name: string;
  size: number;
  sha256: string;
  kind: "input" | "output";
  source: "picker" | "drop" | "server-file" | "device";
  createdAt: number;
}

export interface BleDescriptorInfo { uuid: string; }
export interface BleCharacteristicInfo { uuid: string; properties: readonly string[]; descriptors?: readonly BleDescriptorInfo[]; }
export interface BleServiceInfo { uuid: string; primary: boolean; characteristics: readonly BleCharacteristicInfo[]; }

export interface BleTraceEvent {
  timestamp: number;
  type: "connect" | "disconnect" | "discover" | "read" | "write" | "notify" | "error";
  service?: string;
  characteristic?: string;
  base64?: string;
  detail?: string;
  writeMode?: "with-response" | "without-response";
}

export interface DeviceInfo {
  /** Stable for as long as the grant lives; minted by the page. */
  id: string;
  kind: DeviceKind;
  /** What the human sees: product string, or vendor/product ids. */
  label: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
  open: boolean;
  /** Serial only. */
  transport?: SerialTransport;
  baudRate?: number;
  /** BLE only: flat compatibility summary of accessible primary services. */
  services?: string[];
  /** Services requested in the browser picker; expanding this requires reselection. */
  requestedServices?: string[];
  /** Full GATT tree that this origin is permitted to discover. */
  gatt?: readonly BleServiceInfo[];
  /** USB descriptor candidates, not a successful protocol handshake. */
  protocolCandidates?: readonly DeviceProtocolCandidate[];
  /** Bytes buffered server-side and not yet read by the agent. */
  buffered?: number;
}

/** What this browser can actually do, reported once per attach. */
export interface DeviceCapabilities {
  /** `window.isSecureContext`. False means every API below is absent. */
  secureContext: boolean;
  serial: boolean;
  usb: boolean;
  /** Browser Web Bluetooth availability. */
  bluetooth: boolean;
  /** GATT client surface. It never means unrestricted Bluetooth scanning. */
  bluetoothGatt: boolean;
  /** Browser advertisement watching, where actually exposed. */
  bluetoothAdvertisements: boolean;
  /** Explicitly paired local companion with native BLE discovery/GATT. */
  nativeBluetooth: boolean;
  /** Native Bluetooth Classic support; separate from BLE GATT. */
  classicBluetooth: boolean;
  /** Local HCI capture/adapter access. */
  localHci: boolean;
  /** Established OTA sniffer integration. */
  bluetoothOta: boolean;
  /** Truthful reason for each unavailable Bluetooth surface. */
  bluetoothReasons?: Partial<Record<"bluetoothGatt" | "bluetoothAdvertisements" | "nativeBluetooth" | "classicBluetooth" | "localHci" | "bluetoothOta", string>>;
  /** No Web Serial but WebUSB present: serial goes through the polyfill. */
  serialViaUsb: boolean;
  /** UA platform hint, for the panel's explanation only. */
  platform: string;
}

export const NO_CAPABILITIES: DeviceCapabilities = {
  secureContext: false,
  serial: false,
  usb: false,
  bluetooth: false,
  bluetoothGatt: false,
  bluetoothAdvertisements: false,
  nativeBluetooth: false,
  classicBluetooth: false,
  localHci: false,
  bluetoothOta: false,
  bluetoothReasons: {
    bluetoothGatt: "No secure browser context is available.",
    bluetoothAdvertisements: "This browser does not expose Bluetooth advertisement watching.",
    nativeBluetooth: "No paired local companion is connected.",
    classicBluetooth: "No paired local companion is connected.",
    localHci: "No paired local companion is connected.",
    bluetoothOta: "No established OTA sniffer backend is connected.",
  },
  serialViaUsb: false,
  platform: "unknown",
};

// ============================================================================
// Operations the agent can ask the page to perform
// ============================================================================

export interface SerialOpenParams {
  baudRate?: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd";
  flowControl?: "none" | "hardware";
}

/** One endpoint of a claimed USB interface, in the terms `usb_transfer`
 * takes: a bare endpoint NUMBER plus a direction, never the 0x80-tagged
 * address a raw descriptor carries. Reporting it this way is the difference
 * between an agent that can talk to an unknown device immediately and one
 * that has to fetch and decode configuration descriptors first. */
export interface UsbEndpointInfo {
  endpointNumber: number;
  direction: "in" | "out";
  type: "bulk" | "interrupt" | "isochronous";
  packetSize: number;
}

/** An interface of the active configuration, and whether opening took it.
 * A failed claim is reported with its reason rather than dropped: on Windows
 * that is the ordinary outcome for an interface a vendor driver already owns
 * (see AGENTS.md), which is a host fact the agent can neither guess from a
 * later transfer error nor fix by retrying. */
export interface UsbInterfaceInfo {
  interfaceNumber: number;
  /** The alternate setting currently selected for this interface. */
  alternateSetting: number;
  claimed: boolean;
  /** Why the claim failed; absent when it succeeded. */
  error?: string;
  classCode: number;
  subclassCode: number;
  protocolCode: number;
  endpoints: UsbEndpointInfo[];
}

/** `usb.open`'s result: what the device turned out to be, not just "ok". */
export interface UsbOpenResult {
  configuration?: number;
  interfaces: UsbInterfaceInfo[];
}

export type DeviceOp =
  | { op: "serial.open"; deviceId: string; params: SerialOpenParams }
  | { op: "serial.write"; deviceId: string; params: { base64: string } }
  | { op: "serial.baud"; deviceId: string; params: { baudRate: number } }
  | { op: "serial.signals"; deviceId: string; params: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean } }
  | { op: "close"; deviceId: string; params: Record<string, never> }
  | { op: "ble.connect"; deviceId: string; params: Record<string, never> }
  | { op: "ble.services"; deviceId: string; params: Record<string, never> }
  | { op: "ble.gatt"; deviceId: string; params: Record<string, never> }
  | { op: "ble.trace"; deviceId: string; params: { action: "list" | "clear" | "export"; since?: number } }
  | { op: "ble.read"; deviceId: string; params: { service: string; characteristic: string } }
  | { op: "ble.write"; deviceId: string; params: { service: string; characteristic: string; base64: string; withoutResponse?: boolean } }
  | { op: "ble.subscribe"; deviceId: string; params: { service: string; characteristic: string; enable: boolean } }
  | { op: "usb.open"; deviceId: string; params: { configuration?: number; interface?: number; alternate?: { interfaceNumber: number; alternateSetting: number } } }
  | { op: "usb.control"; deviceId: string; params: { direction: "in" | "out"; requestType: "standard" | "class" | "vendor"; recipient: "device" | "interface" | "endpoint" | "other"; request: number; value: number; index: number; length?: number; base64?: string } }
  | { op: "usb.transfer"; deviceId: string; params: { direction: "in" | "out"; endpoint: number; length?: number; base64?: string } };

export type DeviceOpName = DeviceOp["op"];

/** Server -> page. */
export interface DeviceRequestFrame {
  type: "op";
  /** Correlates the result; unique per bridge. */
  id: string;
  op: DeviceOpName;
  deviceId: string;
  params: Record<string, unknown>;
  /** Quiet-read deadline implemented by the page; distinct from server liveness. */
  timeoutMs?: number;
}

/**
 * What is actually moving over one device's link, so a long transfer is
 * visible while it runs instead of only in its result.
 *
 * Counted SERVER-side, because the server is the one party that sees every
 * byte in both directions: an op's outbound payload on the way to the page,
 * the answer on the way back, and buffered inbound bytes. Counting in the
 * page instead would leave the agent's own view (`device_list`) and the
 * user's panel disagreeing about the same link.
 */
export interface DeviceActivity {
  deviceId: string;
  /** Cumulative since the device was granted, both directions. */
  bytesIn: number;
  bytesOut: number;
  /** Bytes/second over the recent window; 0 when the link has gone quiet. */
  rateIn: number;
  rateOut: number;
  /** Completed operations, and the one still running if any. */
  ops: number;
  inFlight: { op: DeviceOpName; startedAt: number } | null;
  /** Epoch ms of the last byte or op in either direction; null if never. */
  lastActivityAt: number | null;
  /** Unread bytes held for the agent, and bytes the ring buffer had to drop. */
  buffered: number;
  dropped: number;
  /** The last failure on this device, so a stalled link says why. */
  lastError: string | null;
}

/** Server -> page. Sent while a link is busy and once when it falls idle. */
export interface DeviceActivityFrame {
  type: "activity";
  devices: DeviceActivity[];
}

/** A durable high-level run, distinct from one raw packet request. */
export interface DeviceOperationRequestFrame {
  type: "operation";
  command: PageOperationCommand;
}

/**
 * Which of a chat's files an agent wants saved to the server: every file an operation made, explicit files, every file
 * filed under a backup name, or every output; `only` then keeps just some of those by name or partition. The page
 * resolves it against its own files; the server never names a file the page does not hold.
 */
export interface ArtifactSaveSelection {
  operationIds?: readonly string[];
  fileIds?: readonly string[];
  all?: boolean;
  /** Every output filed under this set name (the `set` the agent gave the operations that made them). */
  set?: string;
  /** Keep only files whose name, target or short partition name is one of these, on top of the selectors above. */
  only?: readonly string[];
}

/** Server -> page: an agent asked for files to be saved to the server. The page answers with a `result` frame carrying an `ArtifactSaveAck`. */
export interface DeviceArtifactSaveFrame {
  type: "artifacts.save";
  /** Correlates the result; unique per bridge. */
  id: string;
  selection: ArtifactSaveSelection;
  label?: string;
}

/** What the page tells the agent once the server has accepted the save, before the bytes have moved. */
export interface ArtifactSaveAck {
  saveId: string;
  /** The one .zip the save is, or will be once it completes. */
  archive: string;
  files: number;
  bytes: number;
  resumed: boolean;
  /** The same files were already there: nothing is uploaded. */
  alreadySaved: boolean;
}

export type DeviceServerFrame = DeviceRequestFrame | DeviceActivityFrame | DeviceOperationRequestFrame | DeviceArtifactSaveFrame | TunnelFrame;

/** How often the activity feed is pushed while a link is busy. Faster than a
 * person reads a changing number, slow enough to cost nothing next to the
 * traffic it describes. */
export const ACTIVITY_FEED_MS = 500;

/** Page -> server. */
export type DeviceClientFrame =
  | { type: "hello"; capabilities: DeviceCapabilities; devices: DeviceInfo[] }
  | { type: "devices"; devices: DeviceInfo[] }
  | { type: "artifacts"; artifacts: readonly DeviceArtifactInfo[] }
  /** Inbound bytes: serial RX, a BLE notification, or a USB IN transfer the
   * page is streaming. Buffered server-side until the agent reads it. */
  | { type: "data"; deviceId: string; base64: string; characteristic?: string }
  | { type: "result"; id: string; status: "ok"; value?: unknown }
  | { type: "result"; id: string; status: "no-data" }
  | { type: "result"; id: string; status: "cancelled"; reason?: string }
  | { type: "result"; id: string; status: "error"; error: string }
  | PageOperationProgressFrame
  | PageOperationSnapshotFrame
  | PageOperationResultFrame
  /** The page lost the device (unplugged, GATT disconnect, permission revoked). */
  | { type: "gone"; deviceId: string; reason?: string }
  /** A port-forward relay message (see ./tunnel.ts). */
  | TunnelFrame;

/** Bytes the server holds per device before the agent reads them. A serial
 * console left running produces output forever; keeping the newest window is
 * the honest bound, and the read result says how much was dropped. */
export const DEVICE_BUFFER_BYTES = 256 * 1024;
const OPERATION_STATES: Record<string, true> = {
  starting: true,
  running: true,
  "awaiting-trust": true,
  countdown: true,
  cancelling: true,
  succeeded: true,
  failed: true,
  cancelled: true,
};
const OPERATION_EVENT_TYPES: Record<string, true> = {
  started: true,
  progress: true,
  output: true,
  declared: true,
  state: true,
  completed: true,
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isArtifactList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 128) return false;
  const ids = new Set<string>();
  for (const entry of value) {
    const artifact = recordOf(entry);
    if (!artifact || typeof artifact.id !== "string" || artifact.id.length === 0 || artifact.id.length > 256 || ids.has(artifact.id)) return false;
    if (typeof artifact.name !== "string" || artifact.name.length === 0 || artifact.name.length > 256) return false;
    if (typeof artifact.size !== "number" || !Number.isSafeInteger(artifact.size) || artifact.size < 0) return false;
    if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) return false;
    if ((artifact.kind !== "input" && artifact.kind !== "output") || (artifact.source !== "picker" && artifact.source !== "drop" && artifact.source !== "server-file" && artifact.source !== "device")) return false;
    if (!Number.isFinite(artifact.createdAt)) return false;
    ids.add(artifact.id);
  }
  return true;
}

function isOperationSnapshot(value: unknown, operationId: string): boolean {
  const snapshot = recordOf(value);
  if (!snapshot || snapshot.id !== operationId || typeof snapshot.sessionId !== "string" || !OPERATION_STATES[String(snapshot.state)]) return false;
  if (!Number.isFinite(snapshot.createdAt) || !Number.isFinite(snapshot.updatedAt)) return false;
  const request = recordOf(snapshot.request);
  if (!request || typeof request.protocol !== "string" || typeof request.action !== "string" || typeof request.deviceId !== "string") return false;
  if (!Array.isArray(snapshot.output) || snapshot.output.length > 512 || !Array.isArray(snapshot.events) || snapshot.events.length > 256) return false;
  let outputChars = 0;
  for (const output of snapshot.output) {
    const line = recordOf(output);
    if (!line || !Number.isFinite(line.at) || typeof line.line !== "string" || line.line.length > 8 * 1024) return false;
    outputChars += line.line.length;
    if (outputChars > 64 * 1024) return false;
  }
  for (const event of snapshot.events) {
    const item = recordOf(event);
    if (!item || !Number.isSafeInteger(item.sequence) || !Number.isFinite(item.at) || !OPERATION_EVENT_TYPES[String(item.type)]) return false;
  }
  if (snapshot.error !== undefined && (typeof snapshot.error !== "string" || snapshot.error.length > 4096)) return false;
  return true;
}

function isOperationUpdate(record: Record<string, unknown>): boolean {
  if (typeof record.operationId !== "string" || record.operationId.length === 0 || record.operationId.length > 256) return false;
  if (!isOperationSnapshot(record.snapshot, record.operationId)) return false;
  if (record.type !== "operation.progress") return true;
  const event = recordOf(record.event);
  return !!event && Number.isSafeInteger(event.sequence) && Number.isFinite(event.at) && OPERATION_EVENT_TYPES[String(event.type)];
}

export function isDeviceClientFrame(value: unknown): value is DeviceClientFrame {
  const record = recordOf(value);
  if (!record || typeof record.type !== "string") return false;
  if (record.type === "operation.progress" || record.type === "operation.snapshot" || record.type === "operation.result") {
    return isOperationUpdate(record);
  }
  if (record.type === "artifacts") return isArtifactList(record.artifacts);
  if (record.type === "tunnel") return parseTunnelMessage(record.message) !== null;
  if (record.type !== "result") return record.type === "hello" || record.type === "devices" || record.type === "data" || record.type === "gone";
  if (typeof record.id !== "string") return false;
  return record.status === "ok" || record.status === "no-data" || record.status === "cancelled" || (record.status === "error" && typeof record.error === "string");
}

/** Bounded quiet-read deadline accepted from tools. */
export const MAX_DEVICE_TIMEOUT_MS = 60_000;

/** Independent browser liveness watchdog; it must outlast quiet reads. */
export const DEVICE_LIVENESS_TIMEOUT_MS = 65_000;

export const DEVICE_NO_DATA = { noData: true } as const;
export type DeviceNoData = typeof DEVICE_NO_DATA;
export function isDeviceNoData(value: unknown): value is DeviceNoData {
  return !!value && typeof value === "object" && (value as { noData?: unknown }).noData === true;
}

export class DeviceOperationCancelledError extends Error {
  constructor(reason?: string) {
    super(reason ? "Device operation was cancelled: " + reason : "Device operation was cancelled.");
    this.name = "DeviceOperationCancelledError";
  }
}

/**
 * The longest wait a request may ask for before its command is sent (`options.sendDelaySeconds`): a visible
 * countdown the person can cancel, so they can get their hands on the device's buttons first. Shared by the tool
 * layer (which refuses a bad value early) and the page's operation manager (which trusts nothing the server says).
 */
export const MAX_SEND_DELAY_SECONDS = 300;
