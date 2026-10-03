/**
 * The page half of `adb forward` / `adb reverse` (see ./tunnel.ts).
 *
 * Runs in the browser that owns the ADB connection. It speaks the relay
 * vocabulary to the server, turns it into small promise-based objects a
 * protocol flasher can use, and keeps the byte-credit window honest so a slow
 * device never makes the browser queue an unbounded backlog.
 */

import {
  TUNNEL_CHUNK_BYTES,
  TUNNEL_OPEN_TIMEOUT_MS,
  TUNNEL_WINDOW_BYTES,
  type ForwardLease,
  type ReverseLease,
  type TunnelChannel,
  type TunnelConnection,
  type TunnelMessage,
  type TunnelRequest,
} from "./tunnel";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function abortError(): Error {
  const error = new Error("The device operation was cancelled.");
  error.name = "AbortError";
  return error;
}

class PageConnection implements TunnelConnection {
  readonly closed: Promise<void>;
  failure: string | undefined;
  private readonly resolveClosed: () => void;
  private readonly queue: Uint8Array[] = [];
  private readonly readers: Array<(chunk: Uint8Array | null) => void> = [];
  private readonly windowWaiters: Array<() => void> = [];
  private hostEnded = false;
  private localEnded = false;
  private finished = false;
  private sent = 0;
  private acked = 0;

  constructor(
    readonly id: string,
    private readonly post: (message: TunnelMessage) => void,
    private readonly onFinished: (connection: PageConnection) => void,
  ) {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.closed = promise;
    this.resolveClosed = resolve;
  }

  opened(): void {
    if (!this.finished) this.post({ kind: "opened", connectionId: this.id });
  }

  deliver(bytes: Uint8Array): void {
    if (this.finished || this.hostEnded) return;
    const reader = this.readers.shift();
    if (reader) reader(bytes);
    else this.queue.push(bytes);
  }

  hostEnd(): void {
    if (this.finished) return;
    this.hostEnded = true;
    while (this.readers.length > 0 && this.queue.length === 0) this.readers.shift()?.(null);
    this.maybeFinish();
  }

  acknowledge(bytes: number): void {
    this.acked = Math.min(this.sent, this.acked + bytes);
    for (const waiter of this.windowWaiters.splice(0)) waiter();
  }

  read(): Promise<Uint8Array | null> {
    const next = this.queue.shift();
    if (next) return Promise.resolve(next);
    if (this.finished || this.hostEnded) {
      this.maybeFinish();
      return Promise.resolve(null);
    }
    const { promise, resolve } = Promise.withResolvers<Uint8Array | null>();
    this.readers.push(resolve);
    return promise;
  }

  consumed(bytes: number): void {
    if (!this.finished && bytes > 0) this.post({ kind: "ack", connectionId: this.id, bytes });
  }

  async write(bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.length; offset += TUNNEL_CHUNK_BYTES) {
      while (!this.finished && this.sent - this.acked >= TUNNEL_WINDOW_BYTES) {
        const { promise, resolve } = Promise.withResolvers<void>();
        this.windowWaiters.push(resolve);
        await promise;
      }
      if (this.finished || this.localEnded) throw new Error(this.failure ?? "The relay connection is closed.");
      const part = bytes.subarray(offset, offset + TUNNEL_CHUNK_BYTES);
      this.sent += part.length;
      this.post({ kind: "data", connectionId: this.id, base64: toBase64(part) });
    }
  }

  end(): void {
    if (this.finished || this.localEnded) return;
    this.localEnded = true;
    this.post({ kind: "end", connectionId: this.id });
    this.maybeFinish();
  }

  reset(reason?: string): void {
    if (this.finished) return;
    this.post({ kind: "reset", connectionId: this.id, ...(reason ? { reason } : {}) });
    this.finish(reason);
  }

  /** Called with the far side's reset, or when the relay itself is lost. */
  finish(failure?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.failure = failure;
    this.queue.length = 0;
    for (const reader of this.readers.splice(0)) reader(null);
    for (const waiter of this.windowWaiters.splice(0)) waiter();
    this.resolveClosed();
    this.onFinished(this);
  }

  private maybeFinish(): void {
    if (this.hostEnded && this.localEnded && this.queue.length === 0) this.finish();
  }
}

interface PendingRequest {
  resolve(value: { tunnelId: string; port: number }): void;
  reject(error: Error): void;
  cleanup(): void;
  /** The operation gave up waiting; a late `ready` must be released at once. */
  abandoned: boolean;
}

interface PendingConnect {
  connection: PageConnection;
  resolve(connection: TunnelConnection): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface LeaseState {
  tunnelId: string;
  lostPromise: Promise<string>;
  handler?: (connection: TunnelConnection) => void;
  backlog: PageConnection[];
  connections: Set<PageConnection>;
  lost(reason: string): void;
}

/** One per browser <-> server socket. */
export class TunnelClient implements TunnelChannel {
  private nextId = 1;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly leases = new Map<string, LeaseState>();
  private readonly connections = new Map<string, PageConnection>();
  private readonly connects = new Map<string, PendingConnect>();

  constructor(private readonly post: (message: TunnelMessage) => void) {}

  listen(request: TunnelRequest, signal: AbortSignal): Promise<ForwardLease> {
    return this.claim("listen", request, signal).then(({ tunnelId, port }) => {
      const state = this.track(tunnelId);
      return {
        tunnelId,
        port,
        lost: state.lostPromise,
        onConnection: (handler) => {
          state.handler = handler;
          for (const connection of state.backlog.splice(0)) this.hand(state, connection);
        },
        release: () => this.releaseLease(state, "The port forward was removed."),
      };
    });
  }

  reverse(request: TunnelRequest, signal: AbortSignal): Promise<ReverseLease> {
    return this.claim("reverse", request, signal).then(({ tunnelId, port }) => {
      const state = this.track(tunnelId);
      return {
        tunnelId,
        port,
        lost: state.lostPromise,
        connect: () => this.connectHost(state),
        release: () => this.releaseLease(state, "The reverse rule was removed."),
      };
    });
  }

  /** The socket to the server closed: nothing in flight can complete. */
  dropAll(reason: string): void {
    for (const [id, request] of this.requests) {
      this.requests.delete(id);
      request.cleanup();
      request.reject(new Error(reason));
    }
    for (const state of [...this.leases.values()]) {
      this.leases.delete(state.tunnelId);
      state.lost(reason);
    }
    for (const pending of [...this.connects.values()]) {
      this.connects.delete(pending.connection.id);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    for (const connection of [...this.connections.values()]) connection.finish(reason);
  }

  receive(message: TunnelMessage): void {
    switch (message.kind) {
      case "ready": {
        const request = this.requests.get(message.requestId);
        if (!request) break;
        this.requests.delete(message.requestId);
        request.cleanup();
        if (request.abandoned) this.post({ kind: "release", tunnelId: message.tunnelId });
        else request.resolve({ tunnelId: message.tunnelId, port: message.port });
        break;
      }
      case "failed": {
        const request = this.requests.get(message.requestId);
        if (!request) break;
        this.requests.delete(message.requestId);
        request.cleanup();
        request.reject(new Error(message.error));
        break;
      }
      case "incoming": {
        const state = this.leases.get(message.tunnelId);
        if (!state) {
          this.post({ kind: "reset", connectionId: message.connectionId, reason: "No forward is listening for this connection." });
          break;
        }
        const connection = this.register(message.connectionId, state);
        if (state.handler) this.hand(state, connection);
        else state.backlog.push(connection);
        break;
      }
      case "connected": {
        const pending = this.connects.get(message.connectionId);
        if (!pending) break;
        this.connects.delete(message.connectionId);
        clearTimeout(pending.timer);
        pending.resolve(pending.connection);
        break;
      }
      case "data": {
        const connection = this.connections.get(message.connectionId);
        if (connection) connection.deliver(fromBase64(message.base64));
        break;
      }
      case "ack":
        this.connections.get(message.connectionId)?.acknowledge(message.bytes);
        break;
      case "end":
        this.connections.get(message.connectionId)?.hostEnd();
        break;
      case "reset": {
        const pending = this.connects.get(message.connectionId);
        if (pending) {
          this.connects.delete(message.connectionId);
          clearTimeout(pending.timer);
          pending.connection.finish(message.reason);
          pending.reject(new Error(message.reason ?? "The host refused the connection."));
          break;
        }
        this.connections.get(message.connectionId)?.finish(message.reason ?? "The host side reset the connection.");
        break;
      }
      case "released": {
        const state = this.leases.get(message.tunnelId);
        if (!state) break;
        this.leases.delete(state.tunnelId);
        state.lost(message.reason);
        break;
      }
      default:
        break; // page -> server kinds are never valid inbound
    }
  }

  private claim(kind: "listen" | "reverse", request: TunnelRequest, signal: AbortSignal): Promise<{ tunnelId: string; port: number }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const requestId = `req-${this.nextId++}`;
      const entry: PendingRequest = {
        resolve,
        reject,
        abandoned: false,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        },
      };
      const onAbort = (): void => {
        entry.abandoned = true;
        entry.cleanup();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        entry.abandoned = true;
        entry.cleanup();
        reject(new Error("The Cody server did not answer the port request."));
      }, TUNNEL_OPEN_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      this.requests.set(requestId, entry);
      this.post({ kind, requestId, operationId: request.operationId, deviceId: request.deviceId, port: request.port });
    });
  }

  private track(tunnelId: string): LeaseState {
    const { promise, resolve } = Promise.withResolvers<string>();
    const state: LeaseState = {
      tunnelId,
      lostPromise: promise,
      backlog: [],
      connections: new Set(),
      lost: (reason) => {
        for (const connection of [...state.connections]) connection.finish(reason);
        resolve(reason);
      },
    };
    this.leases.set(tunnelId, state);
    return state;
  }

  private releaseLease(state: LeaseState, reason: string): void {
    if (!this.leases.delete(state.tunnelId)) return;
    this.post({ kind: "release", tunnelId: state.tunnelId });
    state.lost(reason);
  }

  private register(connectionId: string, state: LeaseState): PageConnection {
    const connection = new PageConnection(connectionId, (message) => this.post(message), (finished) => {
      this.connections.delete(finished.id);
      state.connections.delete(finished);
    });
    this.connections.set(connectionId, connection);
    state.connections.add(connection);
    return connection;
  }

  private hand(state: LeaseState, connection: PageConnection): void {
    try {
      state.handler?.(connection);
    } catch (error) {
      connection.reset(error instanceof Error ? error.message : String(error));
    }
  }

  private connectHost(state: LeaseState): Promise<TunnelConnection> {
    return new Promise((resolve, reject) => {
      if (!this.leases.has(state.tunnelId)) {
        reject(new Error("The reverse rule is no longer active."));
        return;
      }
      const connection = this.register(`p-${this.nextId++}`, state);
      const timer = setTimeout(() => {
        this.connects.delete(connection.id);
        connection.reset("The Cody server did not connect to the host service in time.");
        reject(new Error("The Cody server did not connect to the host service in time."));
      }, TUNNEL_OPEN_TIMEOUT_MS);
      this.connects.set(connection.id, { connection, resolve, reject, timer });
      this.post({ kind: "connect", tunnelId: state.tunnelId, connectionId: connection.id });
    });
  }
}
