/**
 * The WebSocket side of the device bridge: one page, one session, one bridge.
 *
 * Kept out of bin/cody-server.js for the same reason the display socket's
 * handling is — the launcher is CommonJS plumbing, and the protocol belongs
 * with the protocol. The server does no interpretation beyond routing: bytes
 * the page reports are buffered for the agent to read, results settle pending
 * operations, and everything else updates the roster the tools list.
 */

import { getDeviceBridge } from "./bus";
import { ACTIVITY_FEED_MS, isDeviceClientFrame, type DeviceCapabilities, type DeviceInfo, type DeviceServerFrame } from "./protocol";
import { parseTunnelMessage } from "./tunnel";
/** The subset of a `ws` socket this module uses, so the launcher can hand one
 * over without this file importing `ws` (and Next bundling it). */
export interface DeviceSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: () => void): void;
  readyState: number;
}

const OPEN = 1;

function asCapabilities(value: unknown): DeviceCapabilities | null {
  if (!value || typeof value !== "object") return null;
  const read = (key: string): boolean => key in value && (value as Record<string, unknown>)[key] === true;
  const platform = "platform" in value && typeof value.platform === "string" ? value.platform : "unknown";
  return {
    secureContext: read("secureContext"),
    serial: read("serial"),
    usb: read("usb"),
    bluetooth: read("bluetooth"),
    bluetoothGatt: read("bluetoothGatt"),
    bluetoothAdvertisements: read("bluetoothAdvertisements"),
    nativeBluetooth: read("nativeBluetooth"),
    classicBluetooth: read("classicBluetooth"),
    localHci: read("localHci"),
    bluetoothOta: read("bluetoothOta"),
    serialViaUsb: read("serialViaUsb"),
    platform,
  };
}

/** Devices are page-reported, so every field is validated: a malformed roster
 * must narrow the list, never crash the bridge the agent is about to use. */
function asDevices(value: unknown): DeviceInfo[] {
  if (!Array.isArray(value)) return [];
  const devices: DeviceInfo[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record: Record<string, unknown> = { ...entry };
    const id = typeof record.id === "string" ? record.id : "";
    const kind = record.kind;
    if (!id || (kind !== "serial" && kind !== "usb" && kind !== "ble")) continue;
    devices.push({
      id,
      kind,
      label: typeof record.label === "string" && record.label ? record.label : id,
      open: record.open === true,
      ...(typeof record.vendorId === "number" ? { vendorId: record.vendorId } : {}),
      ...(typeof record.productId === "number" ? { productId: record.productId } : {}),
      ...(typeof record.serialNumber === "string" ? { serialNumber: record.serialNumber } : {}),
      ...(record.transport === "web-serial" || record.transport === "webusb-polyfill" ? { transport: record.transport } : {}),
      ...(typeof record.baudRate === "number" ? { baudRate: record.baudRate } : {}),
      ...(Array.isArray(record.services) ? { services: record.services.filter((s): s is string => typeof s === "string") } : {}),
      ...(Array.isArray(record.protocolCandidates) ? {
        protocolCandidates: record.protocolCandidates.flatMap((candidate) => {
          if (!candidate || typeof candidate !== "object") return [];
          const item = candidate as Record<string, unknown>;
          if ((item.protocol !== "adb" && item.protocol !== "fastboot" && item.protocol !== "dfu")
            || typeof item.interfaceNumber !== "number" || !Number.isInteger(item.interfaceNumber)
            || typeof item.alternateSetting !== "number" || !Number.isInteger(item.alternateSetting)) return [];
          return [{ protocol: item.protocol, interfaceNumber: item.interfaceNumber, alternateSetting: item.alternateSetting }];
        }),
      } : {}),
    });
  }
  return devices;
}

/**
 * Bind one page's socket to a session's bridge. Returns nothing: the caller
 * owns the socket, and the bridge's own detach runs on close.
 */
export function attachDeviceSocket(sessionId: string, socket: DeviceSocket): void {
  const bridge = getDeviceBridge(sessionId);
  const send = (frame: DeviceServerFrame): void => {
    if (socket.readyState !== OPEN) throw new Error("The device socket is closed.");
    socket.send(JSON.stringify(frame));
  };
  const detach = bridge.attach(send, () => {
    if (socket.readyState === OPEN) socket.close(4001, "Device host authority replaced.");
  });

  /**
   * The activity feed: what is moving on each link, pushed at a fixed cadence
   * while anything is happening and once more when it stops.
   *
   * Cadence rather than per-event, because a serial console or a bulk push
   * produces thousands of events a second and a frame each would be a second
   * flood beside the data itself. Two a second is faster than a person reads
   * a changing number and slow enough to be free. The trailing send matters
   * as much as the rest: without it the panel's last painted state is
   * mid-transfer, so a finished push looks identical to a stalled one.
   */
  let wasActive = false;
  const feed = setInterval(() => {
    if (socket.readyState !== OPEN || !detach.isCurrent()) return;
    const devices = bridge.activitySnapshot();
    const active = devices.some((device) => device.inFlight !== null || device.rateIn > 0 || device.rateOut > 0);
    if (!active && !wasActive) return;
    wasActive = active;
    socket.send(JSON.stringify({ type: "activity", devices }));
  }, ACTIVITY_FEED_MS);
  // An unref'd timer never holds the process open on its own; the socket's
  // close is what ends the feed.
  feed.unref?.();

  socket.on("message", (raw, isBinary) => {
    // Everything is JSON: device payloads ride as base64 inside a frame, so a
    // binary message is a client that does not speak this protocol.
    if (isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!detach.isCurrent()) return;
    if (!isDeviceClientFrame(parsed)) return;
    switch (parsed.type) {
      case "hello": {
        const capabilities = asCapabilities(parsed.capabilities);
        if (capabilities) bridge.setCapabilities(capabilities);
        bridge.setDevices(asDevices(parsed.devices));
        break;
      }
      case "devices":
        bridge.setDevices(asDevices(parsed.devices));
        break;
      case "data": {
        if (typeof parsed.deviceId !== "string" || typeof parsed.base64 !== "string") break;
        bridge.push(
          parsed.deviceId,
          Buffer.from(parsed.base64, "base64"),
          typeof parsed.characteristic === "string" ? parsed.characteristic : undefined,
        );
        break;
      }
      case "result":
        bridge.settle(parsed);
        break;
      case "operation.progress":
        if (parsed.snapshot.sessionId === sessionId) bridge.receiveOperationProgress(parsed);
        break;
      case "operation.snapshot":
        if (parsed.snapshot.sessionId === sessionId) bridge.receiveOperationSnapshot(parsed);
        break;
      case "operation.result":
        if (parsed.snapshot.sessionId === sessionId) bridge.receiveOperationResult(parsed);
        break;
      case "tunnel": {
        const message = parseTunnelMessage(parsed.message);
        if (message) bridge.tunnels.receive(message);
        break;
      }
      case "gone":
        if (typeof parsed.deviceId === "string") bridge.removeDevice(parsed.deviceId);
        break;
    }
  });

  const release = (): void => {
    clearInterval(feed);
    detach();
  };
  socket.on("close", release);
  socket.on("error", release);
}
