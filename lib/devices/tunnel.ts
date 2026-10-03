/**
 * `adb forward` / `adb reverse`, carried over the browser <-> server relay.
 *
 * A PC's adb server owns both ends of a port forward: it listens on a host
 * port and talks to the device. Cody splits that across the two machines it
 * actually has. The BROWSER owns the device (it holds the real WebUSB handle
 * and the authenticated ADB connection) and can never listen on a TCP port;
 * the SERVER can listen and dial, but cannot reach the device. So:
 *
 * - forward: the server listens on 127.0.0.1:PORT; each accepted TCP client
 *   is announced to the page, which opens an ADB stream to the device service
 *   and pumps bytes both ways through this relay.
 * - reverse: the page registers the rule on the device (`reverse:forward:`);
 *   when the device connects, the page asks the server to dial 127.0.0.1:PORT
 *   and pumps bytes both ways.
 *
 * Everything here is transport-agnostic and shared by both halves: the frame
 * vocabulary, the spec grammar, and the flow-control constants. Nothing in this
 * module touches `node:net` or a browser API.
 */

/** One relay message. The page and server exchange these inside a
 * `{ type: "tunnel", message }` socket frame. */
export type TunnelMessage =
  // page -> server: claim a server-side endpoint for a running operation
  | { kind: "listen"; requestId: string; operationId: string; deviceId: string; port: number }
  | { kind: "reverse"; requestId: string; operationId: string; deviceId: string; port: number }
  | { kind: "release"; tunnelId: string }
  // page -> server, reverse: the device opened a stream, dial the host port
  | { kind: "connect"; tunnelId: string; connectionId: string }
  // page -> server, forward: the device accepted the stream for an accepted client
  | { kind: "opened"; connectionId: string }
  // server -> page
  | { kind: "ready"; requestId: string; tunnelId: string; port: number }
  | { kind: "failed"; requestId: string; error: string }
  | { kind: "incoming"; tunnelId: string; connectionId: string }
  | { kind: "connected"; connectionId: string }
  | { kind: "released"; tunnelId: string; reason: string }
  // both directions
  | { kind: "data"; connectionId: string; base64: string }
  | { kind: "ack"; connectionId: string; bytes: number }
  | { kind: "end"; connectionId: string }
  | { kind: "reset"; connectionId: string; reason?: string };

export type TunnelMessageKind = TunnelMessage["kind"];

/** Raw bytes per `data` message. Base64 inflates it by a third, well inside the
 * socket's frame cap. */
export const TUNNEL_CHUNK_BYTES = 48 * 1024;

/** Unacknowledged bytes a sender may have in flight on one connection before it
 * must stop reading its source. The receiver acknowledges a chunk only after
 * its own sink accepted it, so a slow device or a slow TCP client slows the
 * other end instead of growing a queue. */
export const TUNNEL_WINDOW_BYTES = 512 * 1024;

/** Rules one session may hold, and clients one rule may serve at once. */
export const MAX_TUNNELS_PER_SESSION = 16;
export const MAX_TUNNEL_CONNECTIONS = 64;

/** How long the far side gets to accept a new connection before it is dropped. */
export const TUNNEL_OPEN_TIMEOUT_MS = 15_000;

/** The relay only ever reaches the Cody server's own loopback, as a PC's adb
 * reaches `localhost`. It is never configurable to a LAN address. */
export const TUNNEL_HOST = "127.0.0.1";

const MAX_ID_CHARS = 128;
const MAX_REASON_CHARS = 512;
const MAX_SPEC_CHARS = 256;
/** Largest base64 payload accepted for one chunk (chunk size, 4/3, padding). */
const MAX_DATA_BASE64_CHARS = Math.ceil(TUNNEL_CHUNK_BYTES / 3) * 4 + 8;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type DeviceSpecKind = "tcp" | "localabstract" | "localreserved" | "localfilesystem" | "dev" | "jdwp";

export interface DeviceSpec {
  kind: DeviceSpecKind;
  /** The spec exactly as it goes on the wire (`tcp:8080`). */
  text: string;
  /** Present for `tcp:` only. */
  port?: number;
}

export interface HostSpec {
  text: string;
  /** 0 asks the operating system for a free port (forward only). */
  port: number;
}

const FORWARD_DEVICE_KINDS: readonly DeviceSpecKind[] = ["tcp", "localabstract", "localreserved", "localfilesystem", "dev", "jdwp"];
const REVERSE_DEVICE_KINDS: readonly DeviceSpecKind[] = ["tcp", "localabstract", "localreserved", "localfilesystem"];

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parsePort(text: string, allowZero: boolean, what: string): number {
  if (!/^\d{1,5}$/.test(text)) throw new Error(`${what} needs a port number such as tcp:8080.`);
  const port = Number(text);
  if (port > 65535 || (port === 0 && !allowZero)) throw new Error(`${what} port must be 1-65535${allowZero ? " (or 0 for any free port)" : ""}.`);
  return port;
}

/**
 * The device side of a rule: the service string adbd understands. Forward takes
 * every kind `adb forward` does; reverse takes only the kinds a device can
 * LISTEN on. `;` is rejected because it separates the two halves of the wire
 * request `reverse:forward:DEVICE;HOST`.
 */
export function parseDeviceSpec(value: unknown, direction: "forward" | "reverse"): DeviceSpec {
  const what = direction === "forward" ? "The device service" : "The device listening address";
  if (typeof value !== "string" || !value) throw new Error(`${what} is required, for example tcp:8080.`);
  if (value.length > MAX_SPEC_CHARS || hasControlCharacters(value) || value.includes(";")) {
    throw new Error(`${what} must be a single line of at most ${MAX_SPEC_CHARS} characters without ';'.`);
  }
  const separator = value.indexOf(":");
  const kind = separator > 0 ? value.slice(0, separator) : "";
  const rest = separator > 0 ? value.slice(separator + 1) : "";
  const allowed = direction === "forward" ? FORWARD_DEVICE_KINDS : REVERSE_DEVICE_KINDS;
  if (!(allowed as readonly string[]).includes(kind)) {
    throw new Error(`${what} must start with ${allowed.map((entry) => entry + ":").join(", ")}.`);
  }
  if (!rest) throw new Error(`${what} ${kind}: needs a value.`);
  if (kind === "tcp") {
    const port = parsePort(rest, direction === "reverse", what);
    return { kind: "tcp", text: `tcp:${port}`, port };
  }
  if (kind === "jdwp" && !/^\d+$/.test(rest)) throw new Error("jdwp: needs a process id.");
  if ((kind === "localfilesystem" || kind === "dev") && !rest.startsWith("/")) throw new Error(`${kind}: needs an absolute path.`);
  return { kind: kind as DeviceSpecKind, text: value };
}

/**
 * The host side of a rule. Always loopback TCP on the machine running Cody,
 * the same machine an agent calls `localhost`. A forward may ask for port 0
 * (any free port) but never a privileged port; a reverse names the existing
 * host service the device will reach.
 */
export function parseHostSpec(value: unknown, direction: "forward" | "reverse"): HostSpec {
  const what = direction === "forward" ? "The host listening address" : "The host service address";
  if (typeof value !== "string" || !value) throw new Error(`${what} is required, for example tcp:9000.`);
  if (value.length > MAX_SPEC_CHARS || hasControlCharacters(value) || value.includes(";")) {
    throw new Error(`${what} must be a single line without ';'.`);
  }
  if (!value.startsWith("tcp:")) {
    throw new Error(`${what} must be tcp:PORT. Cody's relay only reaches loopback TCP on the machine running Cody; localabstract/localfilesystem host sockets are not available.`);
  }
  const port = parsePort(value.slice(4), direction === "forward", what);
  if (direction === "forward" && port !== 0 && port < 1024) throw new Error(`${what} must use a port of 1024 or above; Cody never binds privileged ports.`);
  return { text: `tcp:${port}`, port };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535;
}

/**
 * Structural validation for a message from the far side. Anything else is
 * dropped by the caller: a malformed or newer frame must never reach a socket.
 */
export function parseTunnelMessage(value: unknown): TunnelMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  switch (message.kind) {
    case "listen":
    case "reverse":
      return isId(message.requestId) && isId(message.operationId) && isId(message.deviceId) && isPort(message.port)
        ? { kind: message.kind, requestId: message.requestId, operationId: message.operationId, deviceId: message.deviceId, port: message.port }
        : null;
    case "release":
      return isId(message.tunnelId) ? { kind: "release", tunnelId: message.tunnelId } : null;
    case "connect":
      return isId(message.tunnelId) && isId(message.connectionId)
        ? { kind: "connect", tunnelId: message.tunnelId, connectionId: message.connectionId }
        : null;
    case "opened":
    case "connected":
    case "end":
      return isId(message.connectionId) ? { kind: message.kind, connectionId: message.connectionId } : null;
    case "ready":
      return isId(message.requestId) && isId(message.tunnelId) && isPort(message.port)
        ? { kind: "ready", requestId: message.requestId, tunnelId: message.tunnelId, port: message.port }
        : null;
    case "failed":
      return isId(message.requestId) && typeof message.error === "string"
        ? { kind: "failed", requestId: message.requestId, error: message.error.slice(0, MAX_REASON_CHARS) }
        : null;
    case "incoming":
      return isId(message.tunnelId) && isId(message.connectionId)
        ? { kind: "incoming", tunnelId: message.tunnelId, connectionId: message.connectionId }
        : null;
    case "released":
      return isId(message.tunnelId) && typeof message.reason === "string"
        ? { kind: "released", tunnelId: message.tunnelId, reason: message.reason.slice(0, MAX_REASON_CHARS) }
        : null;
    case "data":
      return isId(message.connectionId) && typeof message.base64 === "string"
        && message.base64.length > 0 && message.base64.length <= MAX_DATA_BASE64_CHARS && BASE64.test(message.base64)
        ? { kind: "data", connectionId: message.connectionId, base64: message.base64 }
        : null;
    case "ack":
      return isId(message.connectionId) && typeof message.bytes === "number" && Number.isInteger(message.bytes) && message.bytes > 0 && message.bytes <= TUNNEL_CHUNK_BYTES
        ? { kind: "ack", connectionId: message.connectionId, bytes: message.bytes }
        : null;
    case "reset":
      return isId(message.connectionId)
        ? {
            kind: "reset",
            connectionId: message.connectionId,
            ...(typeof message.reason === "string" ? { reason: message.reason.slice(0, MAX_REASON_CHARS) } : {}),
          }
        : null;
    default:
      return null;
  }
}

/** Frame wrapper used on the device socket in both directions. */
export interface TunnelFrame {
  type: "tunnel";
  message: TunnelMessage;
}

/** What the agent and the panel are told about one live rule. */
export interface TunnelInfo {
  tunnelId: string;
  kind: "forward" | "reverse";
  operationId: string;
  deviceId: string;
  /** The host port: the loopback port Cody listens on (forward) or dials (reverse). */
  port: number;
  connections: number;
  /** Bytes relayed toward the device and back, over all connections so far. */
  bytesToDevice: number;
  bytesFromDevice: number;
  createdAt: number;
}

/**
 * The page-side surface a flasher uses; implemented by the browser connection
 * (see tunnel-client.ts) and by test doubles.
 */
export interface TunnelConnection {
  readonly id: string;
  /** Resolves once the relay has dropped the connection, for any reason. */
  readonly closed: Promise<void>;
  /** Why the connection ended abnormally, once `closed` has resolved. */
  readonly failure: string | undefined;
  /** Forward only: the device accepted the stream, so the server may start moving bytes. */
  opened(): void;
  /** Next chunk from the host side; null once the host side ended or reset. */
  read(): Promise<Uint8Array | null>;
  /** Tell the host side a chunk from `read()` has been accepted by its sink. */
  consumed(bytes: number): void;
  /** Send bytes toward the host side, waiting while the window is full. */
  write(bytes: Uint8Array): Promise<void>;
  /** Graceful end of the device-to-host direction. */
  end(): void;
  /** Immediate teardown, telling the far side why. */
  reset(reason?: string): void;
}

interface TunnelLeaseBase {
  readonly tunnelId: string;
  /** Host port actually bound (forward) or dialed (reverse). */
  readonly port: number;
  /** Resolves when the relay or server dropped this rule; the reason says why. */
  readonly lost: Promise<string>;
  release(): void;
}

export interface ForwardLease extends TunnelLeaseBase {
  /** Called for each client the server accepts on the listening port. */
  onConnection(handler: (connection: TunnelConnection) => void): void;
}

export interface ReverseLease extends TunnelLeaseBase {
  /** Dial the host service for a stream the device initiated. */
  connect(): Promise<TunnelConnection>;
}

export interface TunnelRequest {
  operationId: string;
  deviceId: string;
  port: number;
}

export interface TunnelChannel {
  listen(request: TunnelRequest, signal: AbortSignal): Promise<ForwardLease>;
  reverse(request: TunnelRequest, signal: AbortSignal): Promise<ReverseLease>;
}
