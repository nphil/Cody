/**
 * The server half of `adb forward` / `adb reverse` (see ./tunnel.ts).
 *
 * One TunnelHost belongs to one session's DeviceBridge, so a rule can never
 * outlive or cross its session: the bridge tears every rule down when the page
 * that owns the device detaches or is replaced, and when the operation that
 * requested the rule finishes. The page may only claim an endpoint for an
 * operation the bridge has already seen running in this same session (which is
 * past the user's confirmation), only on loopback, never a privileged port and
 * never Cody's own port.
 *
 * Byte flow is credit based. A sender stops reading its source once
 * TUNNEL_WINDOW_BYTES are unacknowledged, and the receiver acknowledges a chunk
 * only after its sink accepted it, so neither a slow TCP client nor a slow
 * device can make this process buffer an unbounded amount.
 */

import net from "node:net";
import {
  MAX_TUNNEL_CONNECTIONS,
  MAX_TUNNELS_PER_SESSION,
  TUNNEL_CHUNK_BYTES,
  TUNNEL_HOST,
  TUNNEL_OPEN_TIMEOUT_MS,
  TUNNEL_WINDOW_BYTES,
  type TunnelInfo,
  type TunnelMessage,
} from "./tunnel";

export interface TunnelHostDeps {
  /** Deliver a message to the attached page. May throw when the socket is gone. */
  send(message: TunnelMessage): void;
  /** True only for an operation in this session that is past confirmation and not finished. */
  operationActive(operationId: string, deviceId: string): boolean;
  /** Activity accounting for the device the rule belongs to. */
  traffic(deviceId: string, direction: "toDevice" | "fromDevice", bytes: number): void;
  /** Loopback ports the relay must never touch (Cody's own listener). */
  reservedPorts(): readonly number[];
  /** Something a UI/agent may want to re-read changed. */
  changed(): void;
}

interface Rule {
  id: string;
  kind: "forward" | "reverse";
  operationId: string;
  deviceId: string;
  port: number;
  server?: net.Server;
  connections: Set<string>;
  bytesToDevice: number;
  bytesFromDevice: number;
  createdAt: number;
}

interface Connection {
  id: string;
  ruleId: string;
  socket: net.Socket;
  state: "opening" | "open";
  /** Bytes sent to the page / acknowledged by it. */
  sent: number;
  acked: number;
  /** Bytes the page sent that this process has not yet acknowledged. */
  pending: number;
  chain: Promise<void>;
  openTimer?: ReturnType<typeof setTimeout>;
  /** We already told the page this connection ended, or it told us. */
  peerDone: boolean;
  forgotten: boolean;
}

const ERROR_TEXT: Record<string, string> = {
  EADDRINUSE: "that port is already in use on the Cody server",
  EACCES: "the Cody server may not bind that port",
  ECONNREFUSED: "nothing is listening on that port on the Cody server",
};

function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  return error instanceof Error ? error.message : String(error);
}

export class TunnelHost {
  private readonly rules = new Map<string, Rule>();
  private readonly connections = new Map<string, Connection>();
  private nextRule = 1;
  private nextConnection = 1;

  constructor(private readonly deps: TunnelHostDeps) {}

  list(): TunnelInfo[] {
    return [...this.rules.values()].map((rule) => ({
      tunnelId: rule.id,
      kind: rule.kind,
      operationId: rule.operationId,
      deviceId: rule.deviceId,
      port: rule.port,
      connections: rule.connections.size,
      bytesToDevice: rule.bytesToDevice,
      bytesFromDevice: rule.bytesFromDevice,
      createdAt: rule.createdAt,
    }));
  }

  /** A message from the page that owns this session's device authority. */
  receive(message: TunnelMessage): void {
    switch (message.kind) {
      case "listen":
        void this.claim(message, "forward");
        break;
      case "reverse":
        void this.claim(message, "reverse");
        break;
      case "release": {
        const rule = this.rules.get(message.tunnelId);
        if (rule) this.closeRule(rule, "The page released this rule.", false);
        break;
      }
      case "connect":
        this.dial(message.tunnelId, message.connectionId);
        break;
      case "opened":
        this.opened(message.connectionId);
        break;
      case "data":
        this.fromPage(message.connectionId, message.base64);
        break;
      case "ack":
        this.acknowledged(message.connectionId, message.bytes);
        break;
      case "end":
        this.peerEnded(message.connectionId);
        break;
      case "reset":
        this.peerReset(message.connectionId);
        break;
      default:
        break; // server -> page kinds are never valid inbound
    }
  }

  /** The page is gone or replaced: nothing can be told, so just tear down. */
  closeAll(reason: string): void {
    for (const rule of [...this.rules.values()]) this.closeRule(rule, reason, false);
  }

  /** The device left (unplugged, revoked): its rules cannot work any more. */
  closeDevice(deviceId: string, reason: string): void {
    for (const rule of [...this.rules.values()]) {
      if (rule.deviceId === deviceId) this.closeRule(rule, reason, true);
    }
  }

  /** The operation behind a rule finished; tell the page in case it is still listening. */
  closeOperation(operationId: string, reason: string): void {
    for (const rule of [...this.rules.values()]) {
      if (rule.operationId === operationId) this.closeRule(rule, reason, true);
    }
  }

  private post(message: TunnelMessage): void {
    try {
      this.deps.send(message);
    } catch {
      this.closeAll("The browser holding this device disconnected.");
    }
  }

  private async claim(message: Extract<TunnelMessage, { kind: "listen" | "reverse" }>, kind: "forward" | "reverse"): Promise<void> {
    const fail = (error: string): void => this.post({ kind: "failed", requestId: message.requestId, error });
    if (!this.deps.operationActive(message.operationId, message.deviceId)) {
      fail("No running confirmed operation in this session owns that rule.");
      return;
    }
    if ([...this.rules.values()].some((rule) => rule.operationId === message.operationId)) {
      fail("This operation already holds a port rule.");
      return;
    }
    if (this.rules.size >= MAX_TUNNELS_PER_SESSION) {
      fail(`A session may hold at most ${MAX_TUNNELS_PER_SESSION} port rules.`);
      return;
    }
    if (message.port !== 0 && this.deps.reservedPorts().includes(message.port)) {
      fail("That is Cody's own port; the relay never connects there.");
      return;
    }
    if (kind === "forward") {
      if (message.port !== 0 && message.port < 1024) {
        fail("Cody never binds privileged ports (below 1024).");
        return;
      }
    } else if (message.port < 1) {
      fail("A reverse rule needs the host port of an existing service.");
      return;
    }
    const rule: Rule = {
      id: `tunnel-${this.nextRule++}`,
      kind,
      operationId: message.operationId,
      deviceId: message.deviceId,
      port: message.port,
      connections: new Set(),
      bytesToDevice: 0,
      bytesFromDevice: 0,
      createdAt: Date.now(),
    };
    if (kind === "forward") {
      const server = net.createServer({ pauseOnConnect: true });
      rule.server = server;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host: TUNNEL_HOST, port: message.port, exclusive: true }, () => {
            server.off("error", reject);
            resolve();
          });
        });
      } catch (error) {
        server.close();
        fail(`Could not listen: ${describeError(error)}.`);
        return;
      }
      const address = server.address();
      rule.port = typeof address === "object" && address ? address.port : message.port;
      server.on("error", (error) => this.closeRule(rule, `The listener failed: ${describeError(error)}.`, true));
      server.on("connection", (socket) => this.accept(rule, socket));
    }
    // The operation could have finished while the bind was in flight.
    if (!this.deps.operationActive(message.operationId, message.deviceId)) {
      rule.server?.close();
      fail("The operation finished before its port rule was ready.");
      return;
    }
    this.rules.set(rule.id, rule);
    this.deps.changed();
    this.post({ kind: "ready", requestId: message.requestId, tunnelId: rule.id, port: rule.port });
  }

  private newConnection(rule: Rule, socket: net.Socket, id: string): Connection {
    const connection: Connection = {
      id,
      ruleId: rule.id,
      socket,
      state: "opening",
      sent: 0,
      acked: 0,
      pending: 0,
      chain: Promise.resolve(),
      peerDone: false,
      forgotten: false,
    };
    this.connections.set(id, connection);
    rule.connections.add(id);
    socket.setNoDelay(true);
    socket.on("error", () => {}); // 'close' follows and carries the cleanup
    socket.on("close", () => this.forget(connection));
    connection.openTimer = setTimeout(() => {
      this.finish(connection, "The other side did not accept the connection in time.");
    }, TUNNEL_OPEN_TIMEOUT_MS);
    connection.openTimer.unref?.();
    this.deps.changed();
    return connection;
  }

  /** Forward: a TCP client reached the listener. */
  private accept(rule: Rule, socket: net.Socket): void {
    if (!this.rules.has(rule.id) || rule.connections.size >= MAX_TUNNEL_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const connection = this.newConnection(rule, socket, `s-${this.nextConnection++}`);
    this.post({ kind: "incoming", tunnelId: rule.id, connectionId: connection.id });
  }

  /** Forward: the device accepted the stream, so start moving the client's bytes. */
  private opened(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.state !== "opening" || !connectionId.startsWith("s-")) return;
    this.start(connection);
  }

  /** Reverse: the device connected to a registered port, so dial the host service. */
  private dial(tunnelId: string, connectionId: string): void {
    const rule = this.rules.get(tunnelId);
    const refuse = (reason: string): void => this.post({ kind: "reset", connectionId, reason });
    if (!rule || rule.kind !== "reverse") {
      refuse("That reverse rule is no longer active.");
      return;
    }
    if (!connectionId.startsWith("p-") || this.connections.has(connectionId)) {
      refuse("Invalid connection id.");
      return;
    }
    if (rule.connections.size >= MAX_TUNNEL_CONNECTIONS) {
      refuse("Too many open connections for this rule.");
      return;
    }
    const socket = net.connect({ host: TUNNEL_HOST, port: rule.port });
    const connection = this.newConnection(rule, socket, connectionId);
    // A failed dial surfaces as 'error' then 'close'; say why before forgetting.
    socket.once("error", (error) => {
      if (connection.state === "opening") this.finish(connection, `Could not reach the host service: ${describeError(error)}.`);
    });
    socket.once("connect", () => {
      if (connection.forgotten) return;
      this.start(connection);
      this.post({ kind: "connected", connectionId });
    });
  }

  private start(connection: Connection): void {
    const { socket } = connection;
    clearTimeout(connection.openTimer);
    connection.state = "open";
    socket.on("data", (chunk: Buffer) => {
      if (connection.peerDone) return;
      const rule = this.rules.get(connection.ruleId);
      for (let offset = 0; offset < chunk.length; offset += TUNNEL_CHUNK_BYTES) {
        const part = chunk.subarray(offset, offset + TUNNEL_CHUNK_BYTES);
        connection.sent += part.length;
        if (rule) {
          rule.bytesToDevice += part.length;
          this.deps.traffic(rule.deviceId, "toDevice", part.length);
        }
        this.post({ kind: "data", connectionId: connection.id, base64: part.toString("base64") });
      }
      if (connection.sent - connection.acked >= TUNNEL_WINDOW_BYTES) socket.pause();
    });
    socket.on("end", () => {
      if (connection.peerDone) return;
      connection.peerDone = true; // nothing more goes to the page after our end
      this.post({ kind: "end", connectionId: connection.id });
    });
    socket.resume();
  }

  private fromPage(connectionId: string, base64: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.state !== "open") return;
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0 || bytes.length > TUNNEL_CHUNK_BYTES) return;
    connection.pending += bytes.length;
    if (connection.pending > TUNNEL_WINDOW_BYTES * 2) {
      this.finish(connection, "The page exceeded the relay window.");
      return;
    }
    const rule = this.rules.get(connection.ruleId);
    if (rule) {
      rule.bytesFromDevice += bytes.length;
      this.deps.traffic(rule.deviceId, "fromDevice", bytes.length);
    }
    connection.chain = connection.chain.then(async () => {
      if (connection.forgotten || connection.socket.destroyed) return;
      const accepted = connection.socket.write(bytes);
      if (!accepted) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            connection.socket.off("drain", done);
            connection.socket.off("close", done);
            resolve();
          };
          connection.socket.once("drain", done);
          connection.socket.once("close", done);
        });
      }
      connection.pending -= bytes.length;
      if (!connection.forgotten) this.post({ kind: "ack", connectionId, bytes: bytes.length });
    });
  }

  private acknowledged(connectionId: string, bytes: number): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.acked = Math.min(connection.sent, connection.acked + bytes);
    if (connection.state === "open" && connection.sent - connection.acked < TUNNEL_WINDOW_BYTES / 2 && connection.socket.isPaused()) {
      connection.socket.resume();
    }
  }

  /** The page's source ended: flush what it sent, then close our side. */
  private peerEnded(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.peerDone = true;
    connection.chain = connection.chain.then(() => {
      if (!connection.socket.destroyed) connection.socket.end();
    });
  }

  private peerReset(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.peerDone = true;
    connection.socket.destroy();
  }

  /** Tear one connection down and tell the page, unless it already knows. */
  private finish(connection: Connection, reason: string): void {
    if (!connection.peerDone) {
      connection.peerDone = true;
      this.post({ kind: "reset", connectionId: connection.id, reason });
    }
    connection.socket.destroy();
  }

  private forget(connection: Connection): void {
    if (connection.forgotten) return;
    connection.forgotten = true;
    clearTimeout(connection.openTimer);
    this.connections.delete(connection.id);
    this.rules.get(connection.ruleId)?.connections.delete(connection.id);
    // A socket that closed without a protocol-level end must not leave the
    // page's side open forever.
    if (!connection.peerDone) {
      connection.peerDone = true;
      this.post({ kind: "reset", connectionId: connection.id, reason: "The host connection closed." });
    }
    this.deps.changed();
  }

  private closeRule(rule: Rule, reason: string, notifyPage: boolean): void {
    if (!this.rules.delete(rule.id)) return;
    rule.server?.close();
    for (const id of [...rule.connections]) {
      const connection = this.connections.get(id);
      if (!connection) continue;
      connection.peerDone = true; // the rule's own `released` covers the page
      connection.socket.destroy();
    }
    if (notifyPage) this.post({ kind: "released", tunnelId: rule.id, reason });
    this.deps.changed();
  }
}
