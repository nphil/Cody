/**
 * The BROWSER half of the device bridge (see ./protocol.ts and ./bus.ts).
 *
 * This module is the only place that touches `navigator.serial` /
 * `navigator.usb` / `navigator.bluetooth` directly. Three responsibilities,
 * kept apart on purpose:
 *
 *  1. Capability detection (`detectDeviceCapabilities`) — pure, SSR-safe.
 *  2. Acquisition (`requestSerialPort` / `requestUsbDevice` /
 *     `requestBluetoothDevice`) — each spends a real user gesture on a
 *     browser permission prompt and files the resulting live handle in a
 *     page-global registry, keyed by a minted device id. The registry
 *     outlives any one `DeviceBridgeConnection`: a hardware grant is a
 *     property of the PAGE, not of whichever chat session happens to be
 *     focused when the user clicks "Connect".
 *  3. Transport (`DeviceBridgeConnection`) — one per active session id, owns
 *     the WebSocket to `/api/devices/socket`, executes incoming ops against
 *     the registry, and pumps RX bytes back up as `data` frames.
 *
 * `SerialPort` here can mean the native Web Serial object OR
 * web-serial-polyfill's WebUSB-backed stand-in. protocol.ts's own doc block
 * explains why: they are deliberately shaped alike (open/close/readable/
 * writable/setSignals) so a future esptool-js integration can take either
 * without reshaping anything.
 */

import { SerialPort as PolyfillSerialPort } from "web-serial-polyfill";
import type { HardwareTransport } from "./flasher";
import type { DeviceOperationManager, HardwareTransportLease, PageOperationBridge, PageOperationCommand, PageOperationDelegate, PageOperationProgressFrame, PageOperationResultFrame, PageOperationSnapshotFrame } from "./operations";
import { DeviceLeaseBook, type DeviceBorrowLease, type DeviceRawLease } from "./device-leases";
import { QuietReadGate, assertQuietReadTimeout, isAbortError } from "./quiet-read";
import { stableUsbIdentity, USB_REGRANT_MESSAGE } from "./usb-identity";
import { pause } from "./pause";
import { SessionConnectionPool, type RetainedSessionConnection } from "./session-connections";
import { reconnectDelayMs } from "@/lib/stream-recovery";
import { NO_CAPABILITIES, type BleServiceInfo, type BleTraceEvent, type DeviceActivity, type DeviceCapabilities, type DeviceClientFrame, type DeviceInfo, type DeviceKind, type DeviceOpName, type DeviceProtocolCandidate, type DeviceServerFrame, type UsbOpenResult } from "./protocol";
import { cdcControlInterface, cdcSerialTransport } from "./cdc";
import { TunnelClient } from "./tunnel-client";
import { parseTunnelMessage } from "./tunnel";
import { deviceTrustKey, type DeviceTrustSubject } from "./trust";
import { deviceTrustHub } from "./trust-hub";
import { parseArtifactSaveFrame, runArtifactSave } from "./artifact-agent";
import { deviceArtifacts } from "./artifacts";
import type { DeviceArtifactSaveFrame } from "./protocol";

/**
 * TypeScript's bundled DOM lib does not yet ship the User-Agent Client Hints
 * API. This is the minimal shape `detectDeviceCapabilities` needs — a typed
 * boundary instead of an `any`/cast at the call site.
 */
declare global {
  interface NavigatorUAData {
    readonly platform: string;
  }
  interface Navigator {
    readonly userAgentData?: NavigatorUAData;
  }
}

// ============================================================================
// Capability detection
// ============================================================================

/**
 * Pure feature detection. Safe to call during SSR (returns `NO_CAPABILITIES`,
 * same as an instance with no browser support at all) and safe to call
 * outside a user gesture — unlike the `requestX` functions below, this never
 * prompts.
 */
export function detectDeviceCapabilities(): DeviceCapabilities {
  if (typeof window === "undefined" || typeof navigator === "undefined") return NO_CAPABILITIES;
  const serial = "serial" in navigator;
  const usb = "usb" in navigator;
  const bluetooth = "bluetooth" in navigator;
  const bluetoothAdvertisements = false;
  return {
    secureContext: window.isSecureContext,
    serial,
    usb,
    bluetooth,
    bluetoothGatt: bluetooth,
    bluetoothAdvertisements,
    nativeBluetooth: false,
    classicBluetooth: false,
    localHci: false,
    bluetoothOta: false,
    bluetoothReasons: {
      ...(bluetooth ? {} : { bluetoothGatt: window.isSecureContext ? "This browser does not implement Web Bluetooth." : "Web Bluetooth requires a secure context." }),
      ...(bluetoothAdvertisements ? {} : { bluetoothAdvertisements: "Browser advertisement watching is unavailable; Web Bluetooth does not provide general BLE scanning." }),
      nativeBluetooth: "No explicitly paired local Bluetooth companion is connected.",
      classicBluetooth: "Browser Web Bluetooth is BLE GATT only; no paired Classic companion is connected.",
      localHci: "A browser does not expose local HCI access.",
      bluetoothOta: "No established OTA sniffer backend is connected.",
    },
    serialViaUsb: !serial && usb,
    platform: navigator.userAgentData?.platform ?? navigator.platform,
  };
}

// ============================================================================
// Registry — the live handles behind each minted device id
// ============================================================================

interface RegistryEntryBase {
  label: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
}

interface NativeSerialEntry extends RegistryEntryBase { kind: "serial"; transport: "web-serial"; port: SerialPort; reader: ReadableStreamDefaultReader<Uint8Array> | null; baudRate?: number; openOptions: SerialOptions | null; }

interface PolyfillSerialEntry extends RegistryEntryBase {
  kind: "serial";
  transport: "webusb-polyfill";
  port: PolyfillSerialPort;
  /** The raw device backing the polyfill port — needed for the shared
   * `navigator.usb` "disconnect" event, which the polyfill's port does not
   * re-expose (it is a plain class, not an EventTarget). */
  usbDevice: USBDevice;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  baudRate?: number;
  openOptions: SerialOptions | null;
  stableIdentity: string | null;
}

type SerialEntry = NativeSerialEntry | PolyfillSerialEntry;

interface UsbQuietRead {
  length: number;
  gate: QuietReadGate<USBInTransferResult>;
}

interface UsbEntry extends RegistryEntryBase {
  kind: "usb";
  device: USBDevice;
  stableIdentity: string | null;
  invalidatedReason: string | null;
  needsNewGrant: boolean;
  quietReads: Map<number, UsbQuietRead>;
}

interface BleEntry extends RegistryEntryBase {
  kind: "ble";
  device: BluetoothDevice;
  server: BluetoothRemoteGATTServer | null;
  /** The picker allow-list. It is an audit trail, not a claim of device support. */
  requestedServices: string[];
  services: Map<string, BluetoothRemoteGATTService>;
  characteristics: Map<string, BluetoothRemoteGATTCharacteristic>;
  notifying: Map<string, (this: BluetoothRemoteGATTCharacteristic, ev: Event) => void>;
  gatt: BleServiceInfo[];
  trace: BleTraceEvent[];
}

type RegistryEntry = SerialEntry | UsbEntry | BleEntry;

/** Page-global on purpose: a hardware grant belongs to the tab, not to
 * whichever session is currently attached through it (see module doc). */
const registry = new Map<string, RegistryEntry>();
const deviceLeases = new DeviceLeaseBook();
const USB_OWNER_STORAGE_KEY = "cody.usb.owner-sessions";

function usbOwnerFor(identity: string): string | undefined {
  try {
    const raw = sessionStorage.getItem(USB_OWNER_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const owner = (parsed as Record<string, unknown>)[identity];
    return typeof owner === "string" ? owner : undefined;
  } catch {
    return undefined;
  }
}

function rememberUsbOwner(identity: string, sessionId: string): void {
  try {
    const raw = sessionStorage.getItem(USB_OWNER_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const owners = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    owners[identity] = sessionId;
    sessionStorage.setItem(USB_OWNER_STORAGE_KEY, JSON.stringify(owners));
  } catch {
    // Session storage can be disabled; failing closed means no automatic adoption.
  }
}

function mintDeviceId(kind: DeviceKind): string {
  return `${kind}-${crypto.randomUUID()}`;
}

/** Native Web Serial exposes only vendor/product ids, never a product
 * string (a deliberate privacy restriction in the spec) — the polyfill path
 * additionally has one, since it is really a WebUSB device underneath. */
function usbLikeLabel(kind: "Serial" | "USB", vendorId?: number, productId?: number, productName?: string | null): string {
  if (productName) return productName;
  if (vendorId !== undefined && productId !== undefined) {
    return `${kind} ${vendorId.toString(16).padStart(4, "0")}:${productId.toString(16).padStart(4, "0")}`;
  }
  return `${kind} device`;
}

/** Qualcomm's emergency download mode ("QDLoader 9008"). Its interface is the generic vendor class 0xff/0xff/0xff that a great many
 * unrelated devices also use, so for this one protocol the vendor/product pair is what names it. */
const QUALCOMM_VENDOR_ID = 0x05c6;
const QUALCOMM_EDL_PRODUCT_ID = 0x9008;

function hasBulkPair(alternate: USBAlternateInterface): boolean {
  return alternate.endpoints.some((endpoint) => endpoint.type === "bulk" && endpoint.direction === "in")
    && alternate.endpoints.some((endpoint) => endpoint.type === "bulk" && endpoint.direction === "out");
}

/** Descriptor hints only: a protocol still validates its own handshake before
 * any operation. USB class/subclass/protocol triplets are considered, plus the
 * Qualcomm EDL vendor/product pair above; labels and serial numbers are
 * deliberately never guessed. */
function usbProtocolCandidates(device: USBDevice): readonly DeviceProtocolCandidate[] | undefined {
  const candidates: DeviceProtocolCandidate[] = [];
  for (const configuration of device.configurations) {
    for (const iface of configuration.interfaces) {
      for (const alternate of iface.alternates) {
        let protocol: DeviceProtocolCandidate["protocol"] | undefined;
        if (alternate.interfaceClass === 0xff && alternate.interfaceSubclass === 0x42) {
          if (alternate.interfaceProtocol === 0x01) protocol = "adb";
          if (alternate.interfaceProtocol === 0x03) protocol = "fastboot";
        }
        if (alternate.interfaceClass === 0xfe && alternate.interfaceSubclass === 0x01 && alternate.interfaceProtocol === 0x02) protocol = "dfu";
        if (alternate.interfaceClass === 0x0a && alternate.endpoints.some(endpoint => endpoint.type === "bulk" && endpoint.direction === "in") && alternate.endpoints.some(endpoint => endpoint.type === "bulk" && endpoint.direction === "out")) protocol = "serial";
        if (!protocol && device.vendorId === QUALCOMM_VENDOR_ID && device.productId === QUALCOMM_EDL_PRODUCT_ID && alternate.interfaceClass === 0xff && hasBulkPair(alternate)) protocol = "edl";
        if (protocol) candidates.push({ protocol, interfaceNumber: iface.interfaceNumber, alternateSetting: alternate.alternateSetting });
      }
    }
  }
  return candidates.length === 0 ? undefined : candidates;
}

function deriveDeviceInfo(id: string, entry: RegistryEntry): DeviceInfo {
  const base = { id, label: entry.label, vendorId: entry.vendorId, productId: entry.productId, serialNumber: entry.serialNumber };
  if (entry.kind === "serial") {
    const protocolCandidates = entry.transport === "webusb-polyfill" ? usbProtocolCandidates(entry.usbDevice) : undefined;
    return { ...base, kind: "serial", transport: entry.transport, baudRate: entry.baudRate, open: entry.reader !== null, ...(protocolCandidates ? { protocolCandidates } : {}) };
  }
  if (entry.kind === "usb") {
    const protocolCandidates = usbProtocolCandidates(entry.device);
    return { ...base, kind: "usb", open: entry.device.opened, ...(protocolCandidates ? { protocolCandidates } : {}) };
  }
  return { ...base, kind: "ble", open: entry.server?.connected ?? false, services: [...entry.services.keys()], requestedServices: entry.requestedServices, ...(entry.gatt.length > 0 ? { gatt: entry.gatt } : {}) };
}

function listDeviceInfos(sessionId?: string): DeviceInfo[] {
  return [...registry.entries()]
    .filter(([id]) => sessionId === undefined || deviceLeases.owns(sessionId, id))
    .map(([id, entry]) => deriveDeviceInfo(id, entry));
}

function getSerialEntry(id: string): SerialEntry {
  const entry = registry.get(id);
  if (!entry) throw new Error(`No such device: ${id}. It may have been unplugged or disconnected.`);
  if (entry.kind !== "serial") throw new Error(`Device ${id} is a ${entry.kind} device, not serial.`);
  return entry;
}

function getUsbEntry(id: string, allowRecovery = false): UsbEntry {
  const entry = registry.get(id);
  if (!entry) throw new Error(`No such device: ${id}. It may have been unplugged or disconnected.`);
  if (entry.kind !== "usb") throw new Error(`Device ${id} is a ${entry.kind} device, not usb.`);
  if (entry.invalidatedReason && (!allowRecovery || entry.needsNewGrant)) throw new Error(entry.invalidatedReason);
  return entry;
}

function getBleEntry(id: string): BleEntry {
  const entry = registry.get(id);
  if (!entry) throw new Error(`No such device: ${id}. It may have been unplugged or disconnected.`);
  if (entry.kind !== "ble") throw new Error(`Device ${id} is a ${entry.kind} device, not ble.`);
  return entry;
}

// ============================================================================
// Acquisition — each of these MUST be invoked synchronously from within a
// real user-gesture event handler (a click). The browser ties the resulting
// permission prompt to "transient activation"; any `await` between the
// click and this call burns the gesture and the prompt throws instead of
// showing.
// ============================================================================

/** CDC-ACM control-interface class code — mirrors web-serial-polyfill's own
 * default (`kDefaultPolyfillOptions.usbControlInterfaceClass`), so the
 * WebUSB picker shows the same devices `serial.requestPort()` would find. */
const USB_CDC_CONTROL_CLASS = 2;

export async function requestSerialPort(): Promise<DeviceInfo> {
  const capabilities = detectDeviceCapabilities();
  if (capabilities.serial) {
    const port = await navigator.serial.requestPort();
    for (const [id, entry] of registry) {
      if (entry.kind === "serial" && entry.transport === "web-serial" && entry.port === port) return deriveDeviceInfo(id, entry);
    }
    const info = port.getInfo();
    const id = mintDeviceId("serial");
    const entry: NativeSerialEntry = {
      kind: "serial",
      transport: "web-serial",
      port,
      reader: null,
      openOptions: null,
      label: usbLikeLabel("Serial", info.usbVendorId, info.usbProductId),
      vendorId: info.usbVendorId,
      productId: info.usbProductId,
    };
    registry.set(id, entry);
    return deriveDeviceInfo(id, entry);
  }
  if (!capabilities.usb) throw new Error("This browser has no Web Serial or WebUSB support.");
  const device = await navigator.usb.requestDevice({ filters: [{ classCode: USB_CDC_CONTROL_CLASS }] });
  const knownId = findUsbDeviceId(device);
  if (knownId) {
    const existing = registry.get(knownId);
    if (existing?.kind === "serial") return deriveDeviceInfo(knownId, existing);
  }
  const port = new PolyfillSerialPort(device);
  const id = mintDeviceId("serial");
  const entry: PolyfillSerialEntry = {
    kind: "serial",
    transport: "webusb-polyfill",
    port,
    usbDevice: device,
    reader: null,
    openOptions: null,
    stableIdentity: stableUsbIdentity(device),
    label: usbLikeLabel("Serial", device.vendorId, device.productId, device.productName),
    vendorId: device.vendorId,
    productId: device.productId,
    serialNumber: device.serialNumber ?? undefined,
  };
  registry.set(id, entry);
  return deriveDeviceInfo(id, entry);
}

function registerUsbDevice(device: USBDevice): DeviceInfo {
  const exactId = findUsbDeviceId(device);
  const identity = stableUsbIdentity(device);
  const replacementId = exactId ?? findStableUsbEntryId(identity);
  if (replacementId) {
    const existing = registry.get(replacementId);
    if (existing?.kind === "usb") {
      existing.device = device;
      existing.invalidatedReason = null;
            existing.needsNewGrant = false;
      existing.quietReads.clear();
      return deriveDeviceInfo(replacementId, existing);
    }
  }
  const id = mintDeviceId("usb");
  const entry: UsbEntry = {
      kind: "usb",
      device,
      stableIdentity: identity,
      invalidatedReason: null,
      needsNewGrant: false,
      quietReads: new Map(),
      label: usbLikeLabel("USB", device.vendorId, device.productId, device.productName),
      vendorId: device.vendorId,
      productId: device.productId,
      serialNumber: device.serialNumber ?? undefined,
    };
  registry.set(id, entry);
  return deriveDeviceInfo(id, entry);
}

function findStableUsbEntryId(identity: string | null): string | undefined {
  if (!identity) return undefined;
  for (const [id, entry] of registry) {
    if (entry.kind === "usb" && entry.stableIdentity === identity) return id;
  }
  return undefined;
}

export async function requestUsbDevice(): Promise<DeviceInfo> {
  if (!detectDeviceCapabilities().usb) throw new Error("This browser has no WebUSB support.");
  // A single empty filter matches every device; an empty filters ARRAY
  // matches none (WebUSB spec §5: a device is kept only if it matches a
  // filter in the list, so an empty list keeps nothing).
  return registerUsbDevice(await navigator.usb.requestDevice({ filters: [{}] }));
}

/** The browser hands back the SAME `USBDevice` object for a device the origin
 * already knows, so identity is exact here rather than a vendor/product
 * heuristic — and the polyfill's backing device counts, or a granted serial
 * port would be adopted a second time as raw USB. */
function findUsbDeviceId(device: USBDevice): string | undefined {
  for (const [id, entry] of registry) {
    if (entry.kind === "usb" && entry.device === device) return id;
    if (entry.kind === "serial" && entry.transport === "webusb-polyfill" && entry.usbDevice === device) return id;
  }
  return undefined;
}

/** A device exposing a CDC control interface is a serial port in this
 * codebase's own terms — `USB_CDC_CONTROL_CLASS` is exactly what the serial
 * picker filters on. Left for the panel's Serial button rather than adopted
 * as raw USB: on Android, where a serial port IS a WebUSB device underneath,
 * adopting it would silently downgrade a granted port into something
 * `device_write` refuses. */
function looksLikeSerialPort(device: USBDevice): boolean {
  return device.configurations.some((configuration) =>
    configuration.interfaces.some((iface) =>
      (iface.alternate ?? iface.alternates[0])?.interfaceClass === USB_CDC_CONTROL_CLASS));
}

/**
 * Re-register every USB device this origin already has permission for, with
 * no picker and no user gesture.
 *
 * A WebUSB grant is persistent and keyed by (vendor, product, serial), so a
 * device that is unplugged and replugged — or that REBOOTS back into the same
 * USB identity, which is every step of a flashing loop — is still ours the
 * moment it re-enumerates. Without this the grant survived in the browser
 * while Cody's list went empty, stranding the agent behind a chooser only a
 * human can click, on every reboot and every page reload.
 *
 * A device that comes back with a DIFFERENT identity (a bootloader at
 * 0bb4:0c01 that boots into an adb interface at another id) is a different
 * device to the browser and genuinely does need a new grant. That is the
 * permission model, not something to paper over.
 */
export async function adoptPermittedUsbDevices(sessionId: string): Promise<DeviceInfo[]> {
  if (!detectDeviceCapabilities().usb) return [];
  const devices = await navigator.usb.getDevices().catch(() => [] as USBDevice[]);
  const adopted: DeviceInfo[] = [];
  for (const device of devices) {
    const identity = stableUsbIdentity(device);
    if (!identity || usbOwnerFor(identity) !== sessionId) continue;
    if (looksLikeSerialPort(device) && !findUsbDeviceId(device)) continue;
    const info = registerUsbDevice(device);
    deviceLeases.claim(sessionId, info.id);
    adopted.push(info);
  }
  return adopted;
}

/**
 * Services this origin asks the browser to reveal. Web Bluetooth deliberately
 * has no wildcard: a service that was not named here remains inaccessible even
 * after a device connected. The Vlink compatibility entries are only picker
 * hints, not an OBD protocol assumption.
 */
export const DEFAULT_BLE_OPTIONAL_SERVICES = [
  "generic_access",
  "generic_attribute",
  "device_information",
  "battery_service",
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART Service
  "0x18f0",
  "0xfff0",
  "0xffe0",
] as const;

const BLUETOOTH_BASE_UUID_SUFFIX = "-0000-1000-8000-00805f9b34fb";

/**
 * One UUID in the only string forms Web Bluetooth accepts. A 16/32-bit alias
 * is valid only as a NUMBER; the STRING "0x18f0" is rejected outright by
 * `BluetoothUUID.getService` (Android Chrome fails the whole picker on it).
 * So every hex alias is expanded onto the Bluetooth base UUID here, while
 * assigned names ("battery_service") pass through untouched.
 */
export function canonicalBleUuid(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (/^[a-z][a-z0-9_.]*$/.test(value) && !/^[0-9a-f]+$/.test(value)) return value;
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (/^[0-9a-f]{4}$/.test(hex)) return "0000" + hex + BLUETOOTH_BASE_UUID_SUFFIX;
  if (/^[0-9a-f]{8}$/.test(hex)) return hex + BLUETOOTH_BASE_UUID_SUFFIX;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(hex)) return hex;
  throw new Error("Invalid BLE UUID: " + raw + ". Use a 16-bit, 32-bit, or canonical 128-bit UUID, or an assigned name.");
}

function normalizedOptionalServices(extra: readonly string[]): string[] {
  const values = new Set<string>(DEFAULT_BLE_OPTIONAL_SERVICES.map(canonicalBleUuid));
  for (const raw of extra) {
    if (!raw.trim()) continue;
    values.add(canonicalBleUuid(raw));
  }
  return [...values];
}

/**
 * Must be called from a click. Expanding optional services always reopens the
 * browser picker: a previous grant cannot be broadened in place.
 */
export async function requestBluetoothDevice(extraOptionalServices: readonly string[] = []): Promise<DeviceInfo> {
  if (!detectDeviceCapabilities().bluetooth) throw new Error("This browser has no Web Bluetooth support.");
  const requestedServices = normalizedOptionalServices(extraOptionalServices);
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: requestedServices,
  });
  const id = mintDeviceId("ble");
  const entry: BleEntry = {
    kind: "ble",
    device,
    server: null,
    requestedServices,
    services: new Map(),
    characteristics: new Map(),
    notifying: new Map(),
    gatt: [],
    trace: [],
    label: device.name || "Bluetooth device",
  };
  registry.set(id, entry);
  return deriveDeviceInfo(id, entry);
}

/** The panel's explicit "Disconnect" action: closes if open, then revokes the
 * browser's persistent permission grant. Distinct from the agent-driven
 * `close` op, which only ends the current session and leaves the grant (and
 * the device's row in the panel) alone so the agent can reopen it later. */
export async function forgetDevice(id: string): Promise<void> {
  const entry = registry.get(id);
  if (!entry) return;
  registry.delete(id);
  if (entry.kind === "serial") {
    if (entry.reader) await entry.reader.cancel().catch(() => {});
    await entry.port.close().catch(() => {});
    await entry.port.forget().catch(() => {});
  } else if (entry.kind === "usb") {
    await entry.device.close().catch(() => {});
    await entry.device.forget().catch(() => {});
  } else {
    entry.server?.disconnect();
    await entry.device.forget().catch(() => {});
  }
}

/**
 * Wires the browser event that means "this handle just died" (unplug, GATT
 * drop, revoked permission). A BLE GATT disconnect is treated differently
 * from the other two: it is often transient (out of range, the peripheral
 * slept) and the `BluetoothDevice` handle survives it, so the device stays
 * listed and reconnectable via `ble.connect` — only `onChanged` fires, never
 * `onGone`. Returns the unsubscribe function.
 */
export function watchDeviceLifecycle(id: string, callbacks: { onGone: (reason?: string) => void; onChanged: () => void }): () => void {
  const entry = registry.get(id);
  if (!entry) return () => {};

  // Each branch below evicts the dead handle from the registry directly —
  // the browser's permission grant survives an unplug; only the explicit
  // "Disconnect" button (forgetDevice, above) revokes it.

  if (entry.kind === "serial" && entry.transport === "web-serial") {
    const port = entry.port;
    const listener = () => { registry.delete(id); callbacks.onGone("The port was unplugged."); };
    port.addEventListener("disconnect", listener);
    return () => port.removeEventListener("disconnect", listener);
  }

  if (entry.kind === "usb" || (entry.kind === "serial" && entry.transport === "webusb-polyfill")) {
    const usbDevice = entry.kind === "usb" ? entry.device : entry.usbDevice;
    const listener = (event: USBConnectionEvent) => {
          if (event.device !== usbDevice) return;
          if (entry.kind === "usb") {
            entry.invalidatedReason = USB_REGRANT_MESSAGE;
                    entry.needsNewGrant = true;
            entry.quietReads.clear();
          } else {
            registry.delete(id);
          }
          callbacks.onGone("The device was unplugged.");
        };
    navigator.usb.addEventListener("disconnect", listener);
    return () => navigator.usb.removeEventListener("disconnect", listener);
  }

  const device = entry.device;
  const listener = () => callbacks.onChanged();
  device.addEventListener("gattserverdisconnected", listener);
  return () => device.removeEventListener("gattserverdisconnected", listener);
}

// ============================================================================
// base64 <-> bytes (no Buffer in the browser)
// ============================================================================

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `view.buffer` is only ever typed `ArrayBufferLike` (a `DataView` could in
 * principle wrap a SharedArrayBuffer), but `BufferSource`-typed WebUSB/Web
 * Bluetooth write methods require the narrower `ArrayBuffer` form. Copying
 * into a fresh length-constructed Uint8Array (always `ArrayBuffer`-backed
 * per lib.es5's own constructor overloads) gets there without a cast.
 */
function viewToBytes(view: DataView): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return bytes;
}

// ============================================================================
// Op params — narrowed field-by-field from the untyped wire payload rather
// than cast, so a malformed frame fails with a clear message instead of
// silently reading `undefined` through a false type guarantee.
// ============================================================================

function str(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" ? value : undefined;
}

function bool(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireStr(params: Record<string, unknown>, key: string): string {
  const value = str(params, key);
  if (value === undefined) throw new Error(`Missing required "${key}" parameter.`);
  return value;
}

function requireNum(params: Record<string, unknown>, key: string): number {
  const value = num(params, key);
  if (value === undefined) throw new Error(`Missing required "${key}" parameter.`);
  return value;
}

const DEFAULT_BAUD_RATE = 115_200;
/** Default IN transfer length when the agent does not specify one — a
 * generous, universally-supported full-speed packet size. */
const DEFAULT_USB_IN_LENGTH = 64;
/** Raw bridge reads must never wait indefinitely or outlive their exclusive reservation. */
const DEFAULT_RAW_USB_IN_TIMEOUT_MS = 5_000;
/** How long a reacquisition waits for the same USB device to appear again unless its caller sets a deadline. */
const USB_REACQUIRE_WINDOW_MS = 30_000;

function baudRateOf(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error("baudRate must be a positive integer.");
  return value;
}

function serialOpenOptions(params: Record<string, unknown>): SerialOptions {
  const dataBitsValue = num(params, "dataBits");
  const stopBitsValue = num(params, "stopBits");
  const parityValue = str(params, "parity");
  const flowControlValue = str(params, "flowControl");
  return {
    baudRate: baudRateOf(num(params, "baudRate") ?? DEFAULT_BAUD_RATE),
    dataBits: dataBitsValue === 7 || dataBitsValue === 8 ? dataBitsValue : undefined,
    stopBits: stopBitsValue === 1 || stopBitsValue === 2 ? stopBitsValue : undefined,
    parity: parityValue === "none" || parityValue === "even" || parityValue === "odd" ? parityValue : undefined,
    flowControl: flowControlValue === "none" || flowControlValue === "hardware" ? flowControlValue : undefined,
  };
}

function usbDirectionOf(params: Record<string, unknown>): "in" | "out" {
  const value = str(params, "direction");
  if (value === "in" || value === "out") return value;
  throw new Error('The "direction" parameter must be "in" or "out".');
}

function usbRequestTypeOf(params: Record<string, unknown>): USBRequestType {
  const value = str(params, "requestType");
  if (value === "standard" || value === "class" || value === "vendor") return value;
  throw new Error('The "requestType" parameter must be "standard", "class", or "vendor".');
}

function usbRecipientOf(params: Record<string, unknown>): USBRecipient {
  const value = str(params, "recipient");
  if (value === "device" || value === "interface" || value === "endpoint" || value === "other") return value;
  throw new Error('The "recipient" parameter must be "device", "interface", "endpoint", or "other".');
}

function usbAlternateOf(params: Record<string, unknown>): { interfaceNumber: number; alternateSetting: number } | undefined {
  const value = params.alternate;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("alternate must be an object.");
  const alternate = value as Record<string, unknown>;
  const interfaceNumber = num(alternate, "interfaceNumber");
  const alternateSetting = num(alternate, "alternateSetting");
  if (interfaceNumber === undefined || alternateSetting === undefined || !Number.isInteger(interfaceNumber) || interfaceNumber < 0 || !Number.isInteger(alternateSetting) || alternateSetting < 0) {
    throw new Error("alternate.interfaceNumber and alternate.alternateSetting must be non-negative integers.");
  }
  return { interfaceNumber, alternateSetting };
}

// ============================================================================
// Reading the wire frame
// ============================================================================

/** `Record<DeviceOpName, true>` doubles as documentation (every literal in
 * the union must be listed, so a new op here is a compile error until this
 * is updated too) and as the runtime membership check below. */
const DEVICE_OP_NAMES: Record<DeviceOpName, true> = {
  "serial.open": true,
  "serial.write": true,
  "serial.baud": true,
  "serial.signals": true,
  "close": true,
  "ble.connect": true,
  "ble.services": true,
  "ble.gatt": true,
  "ble.trace": true,
  "ble.read": true,
  "ble.write": true,
  "ble.subscribe": true,
  "usb.open": true,
  "usb.control": true,
  "usb.transfer": true,
};

const NO_DATA = Symbol("device-quiet-read");

function isDeviceOpName(value: string): value is DeviceOpName {
  return value in DEVICE_OP_NAMES;
}

/** The browser validates every server frame before executing an operation or
 * exposing its activity, keeping malformed or newer frames harmless. */
function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDeviceActivity(value: unknown): value is DeviceActivity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as DeviceActivity;
  if (typeof candidate.deviceId !== "string") return false;
  if (![candidate.bytesIn, candidate.bytesOut, candidate.rateIn, candidate.rateOut, candidate.ops, candidate.buffered, candidate.dropped].every(isNonNegativeFiniteNumber)) return false;
  if (candidate.lastActivityAt !== null && !isNonNegativeFiniteNumber(candidate.lastActivityAt)) return false;
  if (candidate.lastError !== null && typeof candidate.lastError !== "string") return false;
  if (candidate.inFlight === null) return true;
  return typeof candidate.inFlight === "object"
    && candidate.inFlight !== null
    && isDeviceOpName(candidate.inFlight.op)
    && isNonNegativeFiniteNumber(candidate.inFlight.startedAt);
}

function parseServerFrame(raw: unknown): Exclude<DeviceServerFrame, DeviceArtifactSaveFrame> | null {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as DeviceServerFrame;
  if (candidate.type === "op") {
    if (typeof candidate.id !== "string") return null;
    if (typeof candidate.op !== "string") return null;
    if (typeof candidate.deviceId !== "string") return null;
    if (typeof candidate.params !== "object" || candidate.params === null || Array.isArray(candidate.params)) return null;
    if (candidate.timeoutMs !== undefined) {
      try {
        assertQuietReadTimeout(candidate.timeoutMs);
      } catch {
        return null;
      }
    }
    return { type: "op", id: candidate.id, op: candidate.op, deviceId: candidate.deviceId, params: candidate.params, timeoutMs: candidate.timeoutMs };
  }
  if (candidate.type === "tunnel") {
    const message = parseTunnelMessage(candidate.message);
    return message ? { type: "tunnel", message } : null;
  }
  if (candidate.type !== "activity" || !Array.isArray(candidate.devices) || !candidate.devices.every(isDeviceActivity)) return null;
  return { type: "activity", devices: candidate.devices };
}

// ============================================================================
// Op execution
// ============================================================================

interface DeviceOpHooks {
  onSerialData: (deviceId: string, bytes: Uint8Array) => void;
  onBleNotify: (deviceId: string, characteristic: string, bytes: Uint8Array) => void;
}

/**
 * Claim what the agent is about to transfer on.
 *
 * WebUSB refuses EVERY endpoint transfer until the interface owning that
 * endpoint is claimed, and the DOMException it throws names neither the
 * interface nor the remedy — so an unclaimed open looks exactly like a device
 * that will not talk. Opening therefore claims, and by default claims every
 * interface of the active configuration: a raw USB device reached this way is
 * being driven wholesale, and a device speaking one protocol (fastboot, a
 * BROM loader, a DFU target) exposes exactly one interface anyway.
 *
 * Claims are attempted independently. On Windows an interface bound to a
 * vendor driver cannot be taken at all (see AGENTS.md), and abandoning the
 * whole open over one of those would strand every composite device whose
 * OTHER interface is the interesting one. A caller that named a single
 * interface gets the failure thrown instead — there is no partial success to
 * report when only one thing was asked for.
 */
async function claimUsbInterfaces(
  device: USBDevice,
  only: number | undefined,
  requestedAlternate: { interfaceNumber: number; alternateSetting: number } | undefined,
): Promise<UsbOpenResult> {
  if (requestedAlternate && only !== undefined && only !== requestedAlternate.interfaceNumber) {
    throw new Error("The requested USB interface and alternate interface must be the same.");
  }
  const configuration = device.configuration;
  const result: UsbOpenResult = { configuration: configuration?.configurationValue, interfaces: [] };
  if (!configuration) return result;
  let selectedRequestedAlternate = false;

  for (const iface of configuration.interfaces) {
    if (only !== undefined && iface.interfaceNumber !== only) continue;
    const alternateRequest = requestedAlternate?.interfaceNumber === iface.interfaceNumber ? requestedAlternate : undefined;
    if (alternateRequest && !iface.alternates.some((alternate) => alternate.alternateSetting === alternateRequest.alternateSetting)) {
      throw new Error(`USB interface ${iface.interfaceNumber} has no alternate setting ${alternateRequest.alternateSetting}.`);
    }
    if (!iface.claimed) {
      try {
        await device.claimInterface(iface.interfaceNumber);
      } catch (error) {
        if (only !== undefined || alternateRequest) throw error;
        const alternate = iface.alternate;
        if (!alternate) throw error;
        result.interfaces.push({
          interfaceNumber: iface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          claimed: false,
          classCode: alternate.interfaceClass,
          subclassCode: alternate.interfaceSubclass,
          protocolCode: alternate.interfaceProtocol,
          endpoints: alternate.endpoints.map((endpoint) => ({
            endpointNumber: endpoint.endpointNumber,
            direction: endpoint.direction,
            type: endpoint.type,
            packetSize: endpoint.packetSize,
          })),
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    if (alternateRequest && iface.alternate?.alternateSetting !== alternateRequest.alternateSetting) {
      await device.selectAlternateInterface(iface.interfaceNumber, alternateRequest.alternateSetting);
    }
    const alternate = iface.alternate;
    if (!alternate) throw new Error(`USB interface ${iface.interfaceNumber} has no selected alternate setting.`);
    result.interfaces.push({
      interfaceNumber: iface.interfaceNumber,
      alternateSetting: alternate.alternateSetting,
      claimed: iface.claimed,
      classCode: alternate.interfaceClass,
      subclassCode: alternate.interfaceSubclass,
      protocolCode: alternate.interfaceProtocol,
      endpoints: alternate.endpoints.map((endpoint) => ({
        endpointNumber: endpoint.endpointNumber,
        direction: endpoint.direction,
        type: endpoint.type,
        packetSize: endpoint.packetSize,
      })),
    });
    if (alternateRequest) selectedRequestedAlternate = true;
  }
  if (requestedAlternate && !selectedRequestedAlternate) {
    throw new Error(`USB interface ${requestedAlternate.interfaceNumber} was not available to select its alternate.`);
  }
  return result;
}

function startSerialPump(deviceId: string, entry: SerialEntry, onChunk: (deviceId: string, bytes: Uint8Array) => void): void {
  const readable = entry.port.readable;
  if (!readable || readable.locked) return;
  const reader = readable.getReader();
  entry.reader = reader;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) onChunk(deviceId, value);
      }
    } catch {
      // The port closed or the device vanished out from under the loop —
      // the disconnect/gattserverdisconnected listener already covers the
      // user-facing side of this; the loop just needs to stop quietly.
    } finally {
      reader.releaseLock();
      if (entry.reader === reader) entry.reader = null;
    }
  })();
}

async function stopSerialPump(entry: SerialEntry): Promise<void> {
  if (!entry.reader) return;
  await entry.reader.cancel().catch(() => {});
  entry.reader = null;
}

async function invalidateUsbEntry(entry: UsbEntry, reason: string): Promise<void> {
  entry.invalidatedReason = reason;
  entry.needsNewGrant = false;
  entry.quietReads.clear();
  await entry.device.close().catch(() => {});
}

async function readUsbQuietly(
  entry: UsbEntry,
  endpoint: number,
  length: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ value: USBInTransferResult | null; noData: boolean }> {
  assertQuietReadTimeout(timeoutMs);
  let quietRead = entry.quietReads.get(endpoint);
  if (!quietRead) {
    const state: UsbQuietRead = {
      length,
      gate: new QuietReadGate(
        () => entry.device.transferIn(endpoint, state.length),
        async (reason) => invalidateUsbEntry(entry, reason),
      ),
    };
    quietRead = state;
    entry.quietReads.set(endpoint, quietRead);
  } else {
    quietRead.length = Math.max(quietRead.length, length);
  }
  return quietRead.gate.read(timeoutMs, signal);
}

function recordBleTrace(entry: BleEntry, event: Omit<BleTraceEvent, "timestamp">): void {
  entry.trace.push({ ...event, timestamp: Date.now() });
  if (entry.trace.length > 2_048) entry.trace.splice(0, entry.trace.length - 2_048);
}

function characteristicProperties(characteristic: BluetoothRemoteGATTCharacteristic): string[] {
  const properties = characteristic.properties;
  return ["broadcast", "read", "writeWithoutResponse", "write", "notify", "indicate", "authenticatedSignedWrites", "reliableWrite", "writableAuxiliaries"]
    .filter((name) => properties[name as keyof BluetoothCharacteristicProperties]);
}

async function discoverGatt(entry: BleEntry): Promise<BleServiceInfo[]> {
  if (!entry.server) throw new Error("Not connected. Call ble.connect first.");
  const services = await entry.server.getPrimaryServices();
  entry.services.clear();
  entry.characteristics.clear();
  const gatt: BleServiceInfo[] = [];
  for (const service of services) {
    entry.services.set(service.uuid, service);
    const characteristics = await service.getCharacteristics();
    const described = await Promise.all(characteristics.map(async (characteristic) => {
      entry.characteristics.set(service.uuid + ":" + characteristic.uuid, characteristic);
      let descriptors: readonly { uuid: string }[] | undefined;
      try {
        descriptors = (await characteristic.getDescriptors()).map((descriptor) => ({ uuid: descriptor.uuid }));
      } catch (error) {
        // Descriptor enumeration is optional in browser implementations. The
        // service/characteristic remains real and must not disappear with it.
        recordBleTrace(entry, { type: "error", service: service.uuid, characteristic: characteristic.uuid, detail: error instanceof Error ? error.message : String(error) });
      }
      return { uuid: characteristic.uuid, properties: characteristicProperties(characteristic), ...(descriptors ? { descriptors } : {}) };
    }));
    gatt.push({ uuid: service.uuid, primary: true, characteristics: described });
  }
  entry.gatt = gatt;
  recordBleTrace(entry, { type: "discover", detail: "Discovered " + services.length + " accessible primary service(s)." });
  return gatt;
}

async function resolveCharacteristic(entry: BleEntry, rawServiceUuid: string, rawCharacteristicUuid: string): Promise<BluetoothRemoteGATTCharacteristic> {
  if (!entry.server) throw new Error("Not connected. Call ble.connect first.");
  // The agent writes "fff1" / "0xFFF1" as often as the full form; the browser
  // takes neither string, so both are canonicalized before any GATT call.
  const serviceUuid = canonicalBleUuid(rawServiceUuid);
  const characteristicUuid = canonicalBleUuid(rawCharacteristicUuid);
  const cacheKey = serviceUuid + ":" + characteristicUuid;
  const cached = entry.characteristics.get(cacheKey);
  if (cached) return cached;
  let service = entry.services.get(serviceUuid);
  if (!service) {
    service = await entry.server.getPrimaryService(serviceUuid);
    entry.services.set(serviceUuid, service);
  }
  const characteristic = await service.getCharacteristic(characteristicUuid);
  entry.characteristics.set(cacheKey, characteristic);
  return characteristic;
}

/** Executes exactly one `DeviceOp` against the registry. Thrown errors become
 * the WS `result`'s `error` string; nothing here needs to know about the
 * WebSocket at all. */
async function performDeviceOp(
  rawOp: string,
  deviceId: string,
  params: Record<string, unknown>,
  hooks: DeviceOpHooks,
  timeoutMs: number | undefined,
): Promise<unknown | typeof NO_DATA> {
  if (!isDeviceOpName(rawOp)) throw new Error(`Unknown device operation "${rawOp}".`);
  const op = rawOp;
  switch (op) {
    case "serial.open": {
      const entry = getSerialEntry(deviceId);
      await stopSerialPump(entry);
      await entry.port.close().catch(() => {});
      const options = serialOpenOptions(params);
      await entry.port.open(options);
      entry.baudRate = options.baudRate;
      entry.openOptions = options;
      startSerialPump(deviceId, entry, hooks.onSerialData);
      return { baudRate: options.baudRate };
    }
    case "serial.write": {
      const entry = getSerialEntry(deviceId);
      const writable = entry.port.writable;
      if (!writable) throw new Error("The port is not open for writing.");
      const writer = writable.getWriter();
      try {
        await writer.write(fromBase64(requireStr(params, "base64")));
      } finally {
        writer.releaseLock();
      }
      return undefined;
    }
    case "serial.baud": {
      const entry = getSerialEntry(deviceId);
      const baudRate = baudRateOf(requireNum(params, "baudRate"));
      const options: SerialOptions = { ...(entry.openOptions ?? { baudRate: entry.baudRate ?? DEFAULT_BAUD_RATE }), baudRate };
      await stopSerialPump(entry);
      await entry.port.close().catch(() => {});
      await entry.port.open(options);
      entry.baudRate = baudRate;
      entry.openOptions = options;
      startSerialPump(deviceId, entry, hooks.onSerialData);
      return { baudRate };
    }
    case "serial.signals": {
      const entry = getSerialEntry(deviceId);
      await entry.port.setSignals({
        dataTerminalReady: bool(params, "dataTerminalReady"),
        requestToSend: bool(params, "requestToSend"),
        break: bool(params, "break"),
      });
      return undefined;
    }
    case "close": {
      const entry = registry.get(deviceId);
      if (!entry) throw new Error(`No such device: ${deviceId}. It may have been unplugged or disconnected.`);
      if (entry.kind === "serial") {
        await stopSerialPump(entry);
        await entry.port.close().catch(() => {});
      } else if (entry.kind === "usb") {
        await invalidateUsbEntry(entry, "The USB device was closed.");
      } else {
        entry.server?.disconnect();
        recordBleTrace(entry, { type: "disconnect", detail: "Disconnected by Cody." });
        entry.server = null;
        entry.services.clear();
        entry.characteristics.clear();
        entry.notifying.clear();
      }
      return undefined;
    }
    case "ble.connect": {
      const entry = getBleEntry(deviceId);
      if (!entry.device.gatt) throw new Error("This device has no GATT server.");
      entry.server = await entry.device.gatt.connect();
      recordBleTrace(entry, { type: "connect", detail: "Connected to GATT server." });
      return undefined;
    }
    case "ble.services": {
      const entry = getBleEntry(deviceId);
      const gatt = await discoverGatt(entry);
      return { services: gatt.map((service) => service.uuid) };
    }
    case "ble.gatt": {
      const entry = getBleEntry(deviceId);
      return { services: await discoverGatt(entry) };
    }
    case "ble.trace": {
      const entry = getBleEntry(deviceId);
      const action = requireStr(params, "action");
      if (action === "clear") {
        entry.trace = [];
        return { events: [] };
      }
      const since = num(params, "since");
      const events = since === undefined ? entry.trace : entry.trace.filter((event) => event.timestamp >= since);
      return action === "export"
        ? { format: "cody-ble-trace/v1", device: entry.label, requestedServices: entry.requestedServices, events }
        : { events };
    }
    case "ble.read": {
      const entry = getBleEntry(deviceId);
      const service = requireStr(params, "service");
      const characteristicUuid = requireStr(params, "characteristic");
      const characteristic = await resolveCharacteristic(entry, service, characteristicUuid);
      const base64 = toBase64(viewToBytes(await characteristic.readValue()));
      recordBleTrace(entry, { type: "read", service, characteristic: characteristicUuid, base64 });
      return { base64 };
    }
    case "ble.write": {
      const entry = getBleEntry(deviceId);
      const service = requireStr(params, "service");
      const characteristicUuid = requireStr(params, "characteristic");
      const bytes = fromBase64(requireStr(params, "base64"));
      const withoutResponse = bool(params, "withoutResponse");
      const characteristic = await resolveCharacteristic(entry, service, characteristicUuid);
      if (withoutResponse) await characteristic.writeValueWithoutResponse(bytes);
      else await characteristic.writeValueWithResponse(bytes);
      recordBleTrace(entry, { type: "write", service, characteristic: characteristicUuid, base64: toBase64(bytes), writeMode: withoutResponse ? "without-response" : "with-response" });
      return undefined;
    }
    case "ble.subscribe": {
      const entry = getBleEntry(deviceId);
      const serviceUuid = requireStr(params, "service");
      const characteristicUuid = requireStr(params, "characteristic");
      const characteristic = await resolveCharacteristic(entry, serviceUuid, characteristicUuid);
      const key = serviceUuid + ":" + characteristicUuid;
      if (bool(params, "enable")) {
        if (!entry.notifying.has(key)) {
          const listener = () => {
            const view = characteristic.value;
            if (view) {
              const bytes = viewToBytes(view);
              recordBleTrace(entry, { type: "notify", service: serviceUuid, characteristic: characteristicUuid, base64: toBase64(bytes) });
              hooks.onBleNotify(deviceId, characteristicUuid, bytes);
            }
          };
          characteristic.addEventListener("characteristicvaluechanged", listener);
          entry.notifying.set(key, listener);
          await characteristic.startNotifications();
        }
      } else {
        const listener = entry.notifying.get(key);
        if (listener) {
          await characteristic.stopNotifications().catch(() => {});
          characteristic.removeEventListener("characteristicvaluechanged", listener);
          entry.notifying.delete(key);
        }
      }
      return undefined;
    }
    case "usb.open": {
      const entry = getUsbEntry(deviceId, true);
      await entry.device.open();
      entry.invalidatedReason = null;
      entry.needsNewGrant = false;
      entry.quietReads.clear();
      const configuration = num(params, "configuration");
      if (configuration !== undefined) {
        await entry.device.selectConfiguration(configuration);
      } else if (entry.device.configuration === null && entry.device.configurations.length > 0) {
        await entry.device.selectConfiguration(entry.device.configurations[0].configurationValue);
      }
      return claimUsbInterfaces(entry.device, num(params, "interface"), usbAlternateOf(params));
    }
    case "usb.control": {
      const entry = getUsbEntry(deviceId);
      const setup: USBControlTransferParameters = {
        requestType: usbRequestTypeOf(params),
        recipient: usbRecipientOf(params),
        request: requireNum(params, "request"),
        value: requireNum(params, "value"),
        index: requireNum(params, "index"),
      };
      if (usbDirectionOf(params) === "in") {
        const result = await readRawUsbWithDeadline(entry, timeoutMs ?? DEFAULT_RAW_USB_IN_TIMEOUT_MS, () => entry.device.controlTransferIn(setup, num(params, "length") ?? DEFAULT_USB_IN_LENGTH));
        if (result === NO_DATA) return NO_DATA;
        return { base64: result.data ? toBase64(viewToBytes(result.data)) : "" };
      }
      const outBytes = str(params, "base64");
      const result = await entry.device.controlTransferOut(setup, outBytes ? fromBase64(outBytes) : undefined);
      return { bytesWritten: result.bytesWritten };
    }
    case "usb.transfer": {
      const entry = getUsbEntry(deviceId);
      const endpoint = requireNum(params, "endpoint");
      if (usbDirectionOf(params) === "in") {
        const result = await readRawUsbWithDeadline(entry, timeoutMs ?? DEFAULT_RAW_USB_IN_TIMEOUT_MS, () => entry.device.transferIn(endpoint, num(params, "length") ?? DEFAULT_USB_IN_LENGTH));
        if (result === NO_DATA) return NO_DATA;
        return { base64: result.data ? toBase64(viewToBytes(result.data)) : "" };
      }
      const outBytes = str(params, "base64");
      const result = await entry.device.transferOut(endpoint, outBytes ? fromBase64(outBytes) : new Uint8Array(0));
      return { bytesWritten: result.bytesWritten };
    }
    default: {
      const exhaustive: never = op;
      throw new Error(`Unhandled device operation: ${String(exhaustive)}`);
    }
  }
}

// ============================================================================
// RX coalescing — serial RX and BLE notifications both funnel through this so
// a chatty console cannot flood the socket with one frame per byte.
// ============================================================================

/** 20 Hz: fast enough that a live console feels immediate, slow enough that
 * an interrupt-driven serial device streaming continuously sends at most one
 * frame per stream per tick instead of one frame per chunk. */
const COALESCE_INTERVAL_MS = 50;

/** BLE notifications share the RX coalescer with serial reads, keyed by
 * `deviceId` alone for serial or `deviceId\u0000characteristic` for BLE (a
 * device id can never contain a NUL byte) — this splits that key back apart
 * when flushing. */
function parseStreamKey(key: string): { deviceId: string; characteristic?: string } {
  const sep = key.indexOf("\u0000");
  return sep === -1 ? { deviceId: key } : { deviceId: key.slice(0, sep), characteristic: key.slice(sep + 1) };
}

class DataCoalescer {
  private readonly queues = new Map<string, Uint8Array[]>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly onFlush: (key: string, bytes: Uint8Array) => void) {}

  push(key: string, chunk: Uint8Array): void {
    const queue = this.queues.get(key);
    if (queue) queue.push(chunk);
    else this.queues.set(key, [chunk]);
    if (!this.timer) this.timer = setInterval(() => this.drain(), COALESCE_INTERVAL_MS);
  }

  private drain(): void {
    if (this.queues.size === 0) return;
    for (const [key, chunks] of this.queues) {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this.onFlush(key, merged);
    }
    this.queues.clear();
  }

  destroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.queues.clear();
  }
}

// ============================================================================
// Transport — one DeviceBridgeConnection per active session id
// ============================================================================

export interface DeviceBridgeSnapshot {
  capabilities: DeviceCapabilities;
  devices: DeviceInfo[];
  /** Is our WebSocket to `/api/devices/socket` currently open? The server
   * treats a fresh attach (and its `hello`) as authoritative, so this is
   * really "is this browser tab the device host for this session right now". */
  attached: boolean;
  error: string | null;
}

/**
 * Owns the WebSocket for one session id: sends `hello`/`devices`/`data`/
 * `result`/`gone`, executes incoming `op` frames against the registry, and
 * reconnects with backoff. Acquiring/forgetting devices also goes through
 * here so the panel's UI has one object to talk to, but the registry itself
 * — and any hardware already granted before this connection existed — is
 * page-global and outlives it (see module doc).
 */
function operationCommandFrom(raw: unknown): PageOperationCommand | null {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const envelope = payload as Record<string, unknown>;
  if (envelope.type !== "operation") return null;
  payload = envelope.command;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.type !== "string") return null;
  if (candidate.type === "operation.start") {
    if (typeof candidate.operationId !== "string" || typeof candidate.request !== "object" || candidate.request === null || Array.isArray(candidate.request)) return null;
    return { type: "operation.start", id: candidate.id, operationId: candidate.operationId, request: candidate.request as Extract<PageOperationCommand, { type: "operation.start" }>["request"] };
  }
  const operationId = candidate.operationId;
  if (candidate.type === "operation.cancel") {
    return typeof operationId === "string" ? { type: "operation.cancel", id: candidate.id, operationId } : null;
  }
  if (candidate.type === "operation.send") {
    return typeof operationId === "string" && typeof candidate.text === "string" ? { type: "operation.send", id: candidate.id, operationId, text: candidate.text } : null;
  }
  if (candidate.type === "operation.status") {
    if (operationId === undefined) return { type: "operation.status", id: candidate.id };
    return typeof operationId === "string" ? { type: "operation.status", id: candidate.id, operationId } : null;
  }
  return null;
}

function cancelledError(): Error {
  const error = new Error("The device operation was cancelled.");
  error.name = "AbortError";
  return error;
}

async function runUsbAbortable<T>(entry: UsbEntry, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) {
    await invalidateUsbEntry(entry, "The USB transfer was cancelled.");
    throw cancelledError();
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      done();
    };
    const abort = () => {
      finish(() => {
        void invalidateUsbEntry(entry, "The USB transfer was cancelled.").finally(() => reject(cancelledError()));
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

function selectBorrowInterface(device: USBDevice, requested: number | undefined): number | undefined {
  const configuration = device.configuration;
  if (!configuration) throw new Error("USB device has no active configuration.");
  if (requested !== undefined) {
    const iface = configuration.interfaces.find((candidate) => candidate.interfaceNumber === requested);
    if (!iface?.alternate) throw new Error(`USB interface ${requested} has no selected alternate setting.`);
    return requested;
  }
  const candidates = configuration.interfaces.filter((iface) => {
    const alternate = iface.alternate;
    return alternate !== null && alternate.endpoints.some((endpoint) => endpoint.direction === "in" && endpoint.type === "bulk") && alternate.endpoints.some((endpoint) => endpoint.direction === "out" && endpoint.type === "bulk");
  });
  if (candidates.length === 0) return undefined;
  if (candidates.length !== 1) throw new Error("The USB device has multiple transfer interfaces; choose an interfaceNumber explicitly.");
  return candidates[0].interfaceNumber;
}

function borrowEndpoint(device: USBDevice, interfaceNumber: number, direction: "in" | "out"): number {
  const iface = device.configuration?.interfaces.find((candidate) => candidate.interfaceNumber === interfaceNumber);
  const endpoints = iface?.alternate?.endpoints.filter((endpoint) => endpoint.direction === direction && endpoint.type === "bulk") ?? [];
  if (endpoints.length !== 1) {
    throw new Error(`USB interface ${interfaceNumber} needs exactly one bulk ${direction} endpoint for this protocol transport.`);
  }
  return endpoints[0].endpointNumber;
}

function webUsbBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint8Array.from(bytes);
}

async function readRawUsbWithDeadline<T>(entry: UsbEntry, timeoutMs: number, operation: () => Promise<T>): Promise<T | typeof NO_DATA> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await runUsbAbortable(entry, controller.signal, operation);
  } catch (error) {
    if (isAbortError(error) && controller.signal.aborted) return NO_DATA;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
export class DeviceBridgeConnection implements PageOperationBridge {
  readonly sessionId: string;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private destroyed = false;
  private authorityRevoked = false;
  private readonly capabilities: DeviceCapabilities;
  private snapshot: DeviceBridgeSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly activityListeners = new Set<(activity: Record<string, DeviceActivity>) => void>();
  private activityDeviceCount = 0;
  private readonly lifecycleUnsubs = new Map<string, () => void>();
  private readonly coalescer: DataCoalescer;
  private operationDelegate: PageOperationDelegate | null = null;
  private operationUnsubscribe: (() => void) | null = null;
  private trustRegistration: (() => void) | null = null;
  private usbConnectListener: ((event: USBConnectionEvent) => void) | null = null;
  /** adb forward/reverse relay to the Cody server for this session. */
  readonly tunnels = new TunnelClient((message) => this.send({ type: "tunnel", message }));

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.capabilities = detectDeviceCapabilities();
    this.snapshot = { capabilities: this.capabilities, devices: listDeviceInfos(this.sessionId), attached: false, error: null };
    this.coalescer = new DataCoalescer((key, bytes) => this.sendData(key, bytes));
  }

  get operationManager(): DeviceOperationManager | null {
    return this.operationDelegate?.manager ?? null;
  }

  setOperationDelegate(delegate: PageOperationDelegate): void {
    this.operationUnsubscribe?.();
    this.trustRegistration?.();
    this.operationDelegate = delegate;
    this.operationUnsubscribe = delegate.manager.subscribe(() => evictIdleDeviceConnection(this.sessionId));
    // The chat that owns this session finds the device's trust questions through the hub, never through this connection.
    this.trustRegistration = deviceTrustHub.register(this.sessionId, delegate.manager);
    if (this.snapshot.attached) delegate.snapshot(this);
  }

  getSnapshot(): DeviceBridgeSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onActivity(listener: (activity: Record<string, DeviceActivity>) => void): () => void {
    this.activityListeners.add(listener);
    return () => { this.activityListeners.delete(listener); };
  }

  isIdle(): boolean {
    if (deviceLeases.sessionOwnsDevices(this.sessionId)) return false;
    return !(this.operationManager?.snapshots().some((snapshot) => snapshot.state !== "succeeded" && snapshot.state !== "failed" && snapshot.state !== "cancelled"));
  }

  private publishActivity(devices: DeviceActivity[]): void {
    const activity = Object.fromEntries(devices.map((device) => [device.deviceId, device]));
    this.activityDeviceCount = devices.length;
    for (const listener of this.activityListeners) listener(activity);
  }

  private clearActivity(): void {
    if (this.activityDeviceCount === 0) return;
    this.activityDeviceCount = 0;
    for (const listener of this.activityListeners) listener({});
  }

  private setSnapshot(patch: Partial<DeviceBridgeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private refresh(): void {
    this.setSnapshot({ devices: listDeviceInfos(this.sessionId) });
    this.sendDevices();
  }

  start(): void {
    if (this.destroyed || this.authorityRevoked) return;
    if (this.socket) return;
    for (const info of listDeviceInfos(this.sessionId)) this.watchLifecycle(info.id);
    this.watchUsbArrivals();
    void this.adoptPermitted();
    this.openSocket();
  }

  private watchUsbArrivals(): void {
    if (!this.capabilities.usb || this.usbConnectListener) return;
    this.usbConnectListener = () => { void this.adoptPermitted(); };
    navigator.usb.addEventListener("connect", this.usbConnectListener);
  }

  private async adoptPermitted(): Promise<void> {
    const adopted = await adoptPermittedUsbDevices(this.sessionId);
    if (this.destroyed || adopted.length === 0) return;
    for (const info of adopted) this.watchLifecycle(info.id);
    this.refresh();
  }

  destroy(): void {
    this.destroyed = true;
    this.operationManager?.revokeAuthority("Device connection closed.");
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.coalescer.destroy();
    this.operationUnsubscribe?.();
    this.operationUnsubscribe = null;
    this.trustRegistration?.();
    this.trustRegistration = null;
    if (this.usbConnectListener) {
      navigator.usb.removeEventListener("connect", this.usbConnectListener);
      this.usbConnectListener = null;
    }
    for (const unsubscribe of this.lifecycleUnsubs.values()) unsubscribe();
    this.lifecycleUnsubs.clear();
    this.clearActivity();
    this.listeners.clear();
    this.activityListeners.clear();
    this.tunnels.dropAll("Device connection closed.");
    this.socket?.close();
    this.socket = null;
  }

  private openSocket(): void {
    if (this.destroyed || this.authorityRevoked || this.socket) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/devices/socket?sessionId=${encodeURIComponent(this.sessionId)}`);
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.setSnapshot({ attached: true, error: null });
      this.send({ type: "hello", capabilities: this.capabilities, devices: listDeviceInfos(this.sessionId) });
      this.operationDelegate?.snapshot(this);
    };
    socket.onmessage = (event) => { void this.handleMessage(event); };
    socket.onclose = (event) => {
          if (this.socket !== socket) return;
          this.socket = null;
          this.clearActivity();
          this.tunnels.dropAll("The connection to the Cody server closed.");
          const replaced = event.code === 4001 && event.reason === "Device host authority replaced.";
          if (replaced) {
            this.authorityRevoked = true;
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
            this.operationManager?.revokeAuthority(event.reason);
            this.setSnapshot({ attached: false, error: event.reason });
            return;
          }
          this.setSnapshot({ attached: false });
          if (!this.destroyed) this.scheduleReconnect();
        };
    socket.onerror = () => {};
  }

  private scheduleReconnect(): void {
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delay);
  }

  private send(frame: DeviceClientFrame | PageOperationProgressFrame | PageOperationSnapshotFrame | PageOperationResultFrame): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private sendDevices(): void {
    this.send({ type: "devices", devices: listDeviceInfos(this.sessionId) });
  }

  private sendData(key: string, bytes: Uint8Array): void {
    const { deviceId, characteristic } = parseStreamKey(key);
    this.send(characteristic
      ? { type: "data", deviceId, base64: toBase64(bytes), characteristic }
      : { type: "data", deviceId, base64: toBase64(bytes) });
  }

  sendOperationProgress(frame: PageOperationProgressFrame): void {
    this.send(frame);
  }

  sendOperationSnapshot(frame: PageOperationSnapshotFrame): void {
    this.send(frame);
  }

  sendOperationResult(frame: PageOperationResultFrame): void {
    this.send(frame);
  }

  /** An agent asked for files to be saved to the server: start the same save the button starts, and answer once the server accepted it. */
  private async handleArtifactSave(frame: DeviceArtifactSaveFrame): Promise<void> {
    if (this.authorityRevoked) {
      this.send({ type: "result", id: frame.id, status: "error", error: "Device host authority was replaced." });
      return;
    }
    try {
      this.send({ type: "result", id: frame.id, status: "ok", value: await runArtifactSave(deviceArtifacts, this.sessionId, frame) });
    } catch (error) {
      this.send({ type: "result", id: frame.id, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handleOperationCommand(command: PageOperationCommand): Promise<void> {
    if (this.authorityRevoked) {
      this.send({ type: "result", id: command.id, status: "error", error: "Device host authority was replaced." });
      return;
    }
    const delegate = this.operationDelegate;
    if (!delegate) {
      this.send({ type: "result", id: command.id, status: "error", error: "The page has no hardware operation runner." });
      return;
    }
    try {
      if (command.type === "operation.start") await delegate.start(command, this);
      else if (command.type === "operation.cancel") await delegate.cancel(command, this);
      else if (command.type === "operation.send") await delegate.send(command, this);
      else await delegate.status(command, this);
      this.send({ type: "result", id: command.id, status: "ok" });
    } catch (error) {
      if (isAbortError(error)) {
        this.send({ type: "result", id: command.id, status: "cancelled", reason: error instanceof Error ? error.message : "The device operation was cancelled." });
      } else {
        this.send({ type: "result", id: command.id, status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const artifactSave = parseArtifactSaveFrame(event.data);
    if (artifactSave) {
      if ("refused" in artifactSave) this.send({ type: "result", id: artifactSave.id, status: "error", error: artifactSave.refused });
      else await this.handleArtifactSave(artifactSave);
      return;
    }
    const operation = operationCommandFrom(event.data);
    if (operation) {
      await this.handleOperationCommand(operation);
      return;
    }
    const frame = parseServerFrame(event.data);
    if (!frame) return;
    if (frame.type === "activity") {
      this.publishActivity(frame.devices);
      return;
    }
    if (frame.type === "tunnel") {
      this.tunnels.receive(frame.message);
      return;
    }
    if (frame.type === "operation") {
      await this.handleOperationCommand(frame.command);
      return;
    }
    let rawLease: DeviceRawLease | undefined;
    try {
      rawLease = deviceLeases.claimForRawOperation(this.sessionId, frame.deviceId);
      const value = await performDeviceOp(frame.op, frame.deviceId, frame.params, {
        onSerialData: (deviceId, bytes) => this.coalescer.push(deviceId, bytes),
        onBleNotify: (deviceId, characteristic, bytes) => this.coalescer.push(`${deviceId}\u0000${characteristic}`, bytes),
      }, frame.timeoutMs);
      if (frame.op === "close") {
        rawLease.release();
        rawLease = undefined;
        deviceLeases.release(this.sessionId, frame.deviceId);
      }
      this.send(value === NO_DATA
        ? { type: "result", id: frame.id, status: "no-data" }
        : { type: "result", id: frame.id, status: "ok", value });
    } catch (error) {
      this.send(isAbortError(error)
        ? { type: "result", id: frame.id, status: "cancelled", reason: error instanceof Error ? error.message : "The device operation was cancelled." }
        : { type: "result", id: frame.id, status: "error", error: error instanceof Error ? error.message : String(error) });
    } finally {
      rawLease?.release();
    }
    this.refresh();
  }

  private watchLifecycle(id: string): void {
    if (this.lifecycleUnsubs.has(id)) return;
    const unsubscribe = watchDeviceLifecycle(id, {
      onGone: (reason) => {
        this.operationManager?.deviceDisconnected(id);
        // The listener on the old handle is done: adoption registers a fresh one for the device that returns.
        this.lifecycleUnsubs.get(id)?.();
        this.lifecycleUnsubs.delete(id);
        if (!deviceLeases.isBorrowed(id)) deviceLeases.releaseGoneDevice(id);
        this.send({ type: "gone", deviceId: id, reason });
        this.setSnapshot({ devices: listDeviceInfos(this.sessionId) });
      },
      onChanged: () => this.refresh(),
    });
    this.lifecycleUnsubs.set(id, unsubscribe);
  }

  async borrowHardwareTransport(deviceId: string, options: { interfaceNumber?: number; alternateSetting?: number } = {}): Promise<HardwareTransportLease> {
    const ownership = deviceLeases.borrow(this.sessionId, deviceId);
    try {
      const entry = registry.get(deviceId);
      if (!entry) throw new Error(`No such device: ${deviceId}. It may have been unplugged or disconnected.`);
      // A granted USB device that left the bus and is back may not be adopted again yet (its
      // connect event can be missed, or arrive after this call): look for it before giving up.
      if (entry.kind === "usb" && entry.needsNewGrant) await this.adoptPermitted();
      if (entry.kind === "serial") return await this.borrowSerialTransport(entry, ownership);
      if (entry.kind === "usb") return await this.borrowUsbTransport(entry, ownership, options);
      throw new Error("Bluetooth devices cannot be borrowed as a byte transport.");
    } catch (error) {
      ownership.release();
      throw error;
    }
  }

  async reacquireHardwareTransport(deviceId: string, identity: string, options: { interfaceNumber?: number; alternateSetting?: number; signal: AbortSignal; timeoutMs?: number }): Promise<HardwareTransportLease> {
    const initial = registry.get(deviceId);
    if (initial?.kind !== "usb" || initial.stableIdentity !== identity) throw new Error("USB recovery identity does not match the originally leased device.");
    const windowMs = options.timeoutMs ?? USB_REACQUIRE_WINDOW_MS;
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      if (options.signal.aborted) throw cancelledError();
      await this.adoptPermitted();
      const current = registry.get(deviceId);
      if (current?.kind === "usb" && current.stableIdentity === identity && !current.invalidatedReason && !current.needsNewGrant) {
        return this.borrowHardwareTransport(deviceId, options);
      }
      await pause(Math.min(100, Math.max(0, deadline - Date.now())), options.signal);
    }
    throw new Error(`The same USB device did not reappear within ${Math.max(1, Math.round(windowMs / 1000))} seconds. Reconnect it and grant it again if its USB identity changed.`);
  }

  /**
   * The stable identity this granted USB device is attached under right now. Undefined when it is gone, was
   * invalidated, waits for a new grant, or never had one (no serial number): in each case a countdown that is
   * about to send must not assume it is still talking to the device it started on.
   */
  currentIdentity(deviceId: string): string | undefined {
    const entry = registry.get(deviceId);
    if (entry?.kind !== "usb" || entry.invalidatedReason || entry.needsNewGrant) return undefined;
    return entry.stableIdentity ?? undefined;
  }

  /**
   * What the person calls this granted device, and the key its trust can be remembered under: USB vendor id and
   * serial number, which stay the same as the unit changes mode. A device with no serial number has no key.
   */
  describeDevice(deviceId: string): DeviceTrustSubject | undefined {
    const entry = registry.get(deviceId);
    if (!entry) return undefined;
    const { label, vendorId, productId, serialNumber } = entry;
    const hasUsbIdentity = entry.kind === "usb" || (entry.kind === "serial" && entry.transport === "webusb-polyfill");
    const key = hasUsbIdentity ? deviceTrustKey({ vendorId, serialNumber }) : null;
    return {
      label,
      ...(key === null ? {} : { key }),
      ...(vendorId === undefined ? {} : { vendorId }),
      ...(productId === undefined ? {} : { productId }),
      ...(serialNumber === undefined ? {} : { serialNumber }),
    };
  }

  private async borrowSerialTransport(entry: SerialEntry, ownership: DeviceBorrowLease): Promise<HardwareTransportLease> {
    await stopSerialPump(entry);
    if (!entry.port.readable) {
      const openOptions = entry.openOptions ?? { baudRate: entry.baudRate ?? DEFAULT_BAUD_RATE };
      await entry.port.open(openOptions);
      entry.openOptions = openOptions;
      entry.baudRate = openOptions.baudRate;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const releaseReader = async (cancel: boolean) => {
      if (!reader) return;
      if (cancel) await reader.cancel().catch(() => {});
      reader.releaseLock();
      reader = null;
    };
    const directRead = new QuietReadGate(
      async () => {
        const readable = entry.port.readable;
        if (!readable) throw new Error("The serial port is not open for reading.");
        reader ??= readable.getReader();
        const result = await reader.read();
        if (result.done) throw new Error("The serial port closed while reading.");
        return result.value ?? new Uint8Array(0);
      },
      async () => {
        await releaseReader(true);
        await entry.port.close().catch(() => {});
      },
    );
    let released = false;
    const transport: HardwareTransport = {
      kind: "serial",
      read: async (length, timeoutMs, signal) => {
        if (!Number.isInteger(length) || length <= 0) throw new Error("Serial read length must be a positive integer.");
        const result = await directRead.read(timeoutMs, signal);
        return result.noData ? null : result.value;
      },
      write: async (bytes, signal) => {
        if (signal.aborted) throw cancelledError();
        const writable = entry.port.writable;
        if (!writable) throw new Error("The serial port is not open for writing.");
        const writer = writable.getWriter();
        const abort = () => { void entry.port.close().catch(() => {}); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          await writer.write(bytes);
          if (signal.aborted) throw cancelledError();
        } finally {
          signal.removeEventListener("abort", abort);
          writer.releaseLock();
        }
      },
      setBaudRate: async (baudRate) => {
        if (entry.port.readable?.locked && !reader) throw new Error("The serial protocol owns a reader; release it before changing baud rate.");
        await releaseReader(true);
        const updated = { ...(entry.openOptions ?? { baudRate: entry.baudRate ?? DEFAULT_BAUD_RATE }), baudRate: baudRateOf(baudRate) };
        await entry.port.close().catch(() => {});
        await entry.port.open(updated);
        entry.openOptions = updated;
        entry.baudRate = updated.baudRate;
      },
      setSignals: async (signals) => {
        await entry.port.setSignals({ dataTerminalReady: signals.dtr, requestToSend: signals.rts, break: signals.brk });
      },
      ...(entry.transport === "web-serial" ? { serialPort: entry.port } : {}),
    };
    return {
      transport,
      release: async () => {
        if (released) return;
        released = true;
        await releaseReader(true);
        ownership.release();
        startSerialPump([...registry.entries()].find(([, candidate]) => candidate === entry)?.[0] ?? "", entry, (deviceId, bytes) => this.coalescer.push(deviceId, bytes));
      },
    };
  }

  private async borrowUsbTransport(entry: UsbEntry, ownership: DeviceBorrowLease, options: { interfaceNumber?: number; alternateSetting?: number }): Promise<HardwareTransportLease> {
    const requestedInterface = options.interfaceNumber;
    if (options.alternateSetting !== undefined && requestedInterface === undefined) throw new Error("alternateSetting requires interfaceNumber.");
    const requestedAlternate = options.alternateSetting === undefined || requestedInterface === undefined ? undefined : { interfaceNumber: requestedInterface, alternateSetting: options.alternateSetting };
    const ready = getUsbEntry([...registry.entries()].find(([, candidate]) => candidate === entry)?.[0] ?? "", true);
    let released = false;
    const ensureReady = async (): Promise<void> => {
      if (released) throw new Error("The hardware operation lease ended.");
      if (ready.needsNewGrant) throw new Error(USB_REGRANT_MESSAGE);
      if (!ready.device.opened) {
        await ready.device.open();
        ready.invalidatedReason = null;
        if (ready.device.configuration === null && ready.device.configurations.length > 0) {
          await ready.device.selectConfiguration(ready.device.configurations[0].configurationValue);
        }
      }
      await claimUsbInterfaces(ready.device, requestedInterface, requestedAlternate);
    };
    await ensureReady();
    const interfaceNumber = selectBorrowInterface(ready.device, requestedInterface);
    const requireEndpoint = (direction: "in" | "out"): number => {
      if (interfaceNumber === undefined) throw new Error("This USB protocol needs an explicitly selected transfer interface.");
      return borrowEndpoint(ready.device, interfaceNumber, direction);
    };
    const selectedAlternate = interfaceNumber === undefined ? undefined : ready.device.configuration?.interfaces.find((candidate) => candidate.interfaceNumber === interfaceNumber)?.alternate ?? undefined;
    const dfu = selectedAlternate?.interfaceClass === 0xfe && selectedAlternate.interfaceSubclass === 0x01 && selectedAlternate.interfaceProtocol === 0x02 && interfaceNumber !== undefined
      ? { interfaceNumber, alternateSetting: selectedAlternate.alternateSetting, ...(selectedAlternate.interfaceName ? { alternateName: selectedAlternate.interfaceName } : {}) }
      : undefined;
    const transport: HardwareTransport = {
      kind: "usb",
      interfaceNumber,
      alternateSetting: selectedAlternate?.alternateSetting,
      ...(dfu ? { dfu } : {}),
      read: async (length, timeoutMs, signal) => {
        if (!Number.isInteger(length) || length <= 0) throw new Error("USB read length must be a positive integer.");
        await ensureReady();
        const result = await readUsbQuietly(ready, requireEndpoint("in"), length, timeoutMs, signal);
        return result.noData ? null : result.value?.data ? viewToBytes(result.value.data) : new Uint8Array(0);
      },
      write: async (bytes, signal) => {
        await ensureReady();
        await runUsbAbortable(ready, signal, async () => {
          const result = await ready.device.transferOut(requireEndpoint("out"), webUsbBytes(bytes));
          if (result.status !== "ok") throw new Error(`USB bulk write failed: ${result.status}.`);
          if (result.bytesWritten !== bytes.byteLength) throw new Error(`USB bulk write was incomplete (${result.bytesWritten}/${bytes.byteLength} bytes).`);
        });
      },
      controlIn: async (setup, length, signal) => {
        await ensureReady();
        const result = await runUsbAbortable(ready, signal, () => ready.device.controlTransferIn(setup, length));
        return result.data ? viewToBytes(result.data) : new Uint8Array(0);
      },
      controlOut: async (setup, bytes, signal) => {
        await ensureReady();
        await runUsbAbortable(ready, signal, async () => {
          const result = await ready.device.controlTransferOut(setup, webUsbBytes(bytes));
          if (result.status !== "ok") throw new Error(`USB control write failed: ${result.status}.`);
          if (result.bytesWritten !== bytes.byteLength) throw new Error(`USB control write was incomplete (${result.bytesWritten}/${bytes.byteLength} bytes).`);
        });
      },
      reset: async (signal) => {
        await ensureReady();
        await runUsbAbortable(ready, signal, () => ready.device.reset());
      },
      connected: () => ready.device.opened,
    };
    let protocolTransport = transport;
    if (selectedAlternate?.interfaceClass === 0x0a && interfaceNumber !== undefined) {
      const control = await cdcControlInterface(ready.device, interfaceNumber);
      if (!ready.device.configuration?.interfaces.find(iface => iface.interfaceNumber === control)?.claimed) await ready.device.claimInterface(control);
      protocolTransport = cdcSerialTransport(transport, control);
    }
    return {
      transport: protocolTransport,
      identity: ready.stableIdentity ?? undefined,
      release: async () => {
        if (released) return;
        released = true;
        await invalidateUsbEntry(ready, "The hardware operation lease ended.");
        ownership.release();
      },
    };
  }

  async requestDevice(kind: DeviceKind, bleOptionalServices: readonly string[] = []): Promise<DeviceInfo> {
    const info = kind === "serial" ? await requestSerialPort()
      : kind === "usb" ? await requestUsbDevice()
        : await requestBluetoothDevice(bleOptionalServices);
    deviceLeases.claim(this.sessionId, info.id);
    const entry = registry.get(info.id);
    if (entry?.kind === "usb" && entry.stableIdentity) rememberUsbOwner(entry.stableIdentity, this.sessionId);
    this.watchLifecycle(info.id);
    this.refresh();
    return info;
  }

  async disconnectDevice(id: string): Promise<void> {
    await this.operationManager?.deviceDisconnected(id, "forgotten");
    const rawLease = deviceLeases.claimForRawOperation(this.sessionId, id);
    try {
      this.lifecycleUnsubs.get(id)?.();
      this.lifecycleUnsubs.delete(id);
      await forgetDevice(id);
    } finally {
      rawLease.release();
    }
    deviceLeases.release(this.sessionId, id);
    this.refresh();
  }
}





const sessionConnections = new SessionConnectionPool((sessionId: string) => new DeviceBridgeConnection(sessionId));

function evictIdleDeviceConnection(sessionId: string): void {
  sessionConnections.evictIdle(sessionId);
}

export type DeviceBridgeConnectionLease = RetainedSessionConnection<DeviceBridgeConnection>;

export function retainDeviceBridgeConnection(sessionId: string): DeviceBridgeConnectionLease {
  return sessionConnections.retain(sessionId);
}
