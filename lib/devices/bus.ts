/**
 * The server half of the browser-hosted device bridge (see ./protocol.ts).
 *
 * One bridge per session, held in a `globalThis` map for the same reason the
 * display bus is: a plain module-level Map does not survive Next's hot reload,
 * and losing the bridge would mean losing the page's device grants with it.
 *
 * The server owns no handles. It holds three things: what the page said it can
 * do, what it currently has open, and the bytes that arrived while the agent
 * was not looking. Everything else is a request relayed to the page and a
 * result relayed back.
 *
 * A device is addressed the way a session is (lib/session-tools.ts): exact id
 * first, then a case-insensitive substring of the label, and more than one
 * match returns the candidates rather than guessing. Picking the wrong serial
 * port and writing to it is not a recoverable mistake.
 */

import {
  DEVICE_BUFFER_BYTES,
  DEVICE_LIVENESS_TIMEOUT_MS,
  DEVICE_NO_DATA,
  MAX_DEVICE_TIMEOUT_MS,
  NO_CAPABILITIES,
  DeviceOperationCancelledError,
  type DeviceActivity,
  type DeviceCapabilities,
  type DeviceClientFrame,
  type DeviceInfo,
  type DeviceOpName,
  type DeviceServerFrame,
} from "./protocol";
import type {
  DeviceOperationRequest,
  DeviceOperationSnapshot,
  OperationEvent,
  PageOperationCommand,
} from "./operations";

import { TunnelHost } from "./tunnel-host";

/** How long, and how many, devices that left the page stay addressable for a wait-for-device. */
const DEPARTED_RETENTION_MS = 15 * 60_000;
const DEPARTED_MAX = 16;

/**
 * Told about every stored operation update. `previous` is what the bridge held for that operation before this
 * update (undefined the first time it hears of it): a finished snapshot is news only when `previous` was still
 * running, because a page that reconnects replays every finished operation it remembers.
 */
export type OperationListener = (snapshot: DeviceOperationSnapshot, event?: OperationEvent, previous?: DeviceOperationSnapshot) => void;

type Sender = (frame: DeviceServerFrame) => void;

/** Cody's own listener: a reverse rule must never let a device reach it. */
function reservedLoopbackPorts(): number[] {
  const origin = /:(\d{1,5})(?:\/|$)/.exec(process.env.CODY_INTERNAL_DISPLAY_ORIGIN ?? "");
  return [process.env.PORT, origin?.[1]]
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Which device the answer belongs to, so its bytes are attributed. */
  deviceId: string;
}

/** Bytes a frame's `base64` payload carries, wherever it sits: an op's own
 * params, or an answer given either as a bare string or wrapped in an object.
 * Base64 is 4 chars per 3 bytes, minus padding — computed rather than
 * decoded, since this runs on every frame and the buffer would be thrown
 * away immediately. */
function base64Bytes(value: unknown): number {
  const encoded = typeof value === "string"
    ? value
    : value && typeof value === "object" && typeof (value as { base64?: unknown }).base64 === "string"
      ? (value as { base64: string }).base64
      : null;
  if (encoded === null) return 0;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

/** Newest-window byte buffer for one device, with an honest drop count. */
class DeviceBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private dropped = 0;

  /** Lifetime drops, never reset by a drain — `dropped` below is the
   * per-read gap, which a reader consumes; this is what the activity feed
   * reports, where a total that went backwards would be nonsense. */
  droppedTotal = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > DEVICE_BUFFER_BYTES && this.chunks.length > 0) {
      const oldest = this.chunks.shift()!;
      this.bytes -= oldest.length;
      this.dropped += oldest.length;
      this.droppedTotal += oldest.length;
    }
  }

  get length(): number {
    return this.bytes;
  }

  /** Take up to `maxBytes` of the OLDEST data, with however much was dropped
   * before it. Reporting the gap matters: a console that overflowed and one
   * that merely paused look identical otherwise. */
  drain(maxBytes: number): { data: Buffer; dropped: number } {
    const dropped = this.dropped;
    this.dropped = 0;
    if (this.chunks.length === 0) return { data: Buffer.alloc(0), dropped };
    const joined = Buffer.concat(this.chunks);
    const take = Math.max(0, Math.min(maxBytes, joined.length));
    const data = joined.subarray(0, take);
    const rest = joined.subarray(take);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.bytes = rest.length;
    return { data, dropped };
  }
}

/** Buffer key for one stream of inbound bytes. A NUL separator cannot occur
 * in a device id or a GATT UUID, so the two halves are always recoverable. */
function sourceKey(deviceId: string, characteristic?: string): string {
  return characteristic ? `${deviceId}\u0000${characteristic}` : deviceId;
}

function sourceDevice(key: string): string {
  const separator = key.indexOf("\u0000");
  return separator < 0 ? key : key.slice(0, separator);
}

function sourceCharacteristic(key: string): string | null {
  const separator = key.indexOf("\u0000");
  return separator < 0 ? null : key.slice(separator + 1);
}

/** How far back a rate is measured. Short enough to track a transfer that
 * starts and stops, long enough that one 64 KB chunk does not read as a
 * megabyte per second. */
const RATE_WINDOW_MS = 3_000;

/** Per-device byte and operation accounting behind `DeviceActivity`. */
class ActivityRecord {
  bytesIn = 0;
  bytesOut = 0;
  ops = 0;
  dropped = 0;
  lastActivityAt: number | null = null;
  lastError: string | null = null;
  inFlight: { op: DeviceOpName; startedAt: number } | null = null;
  /** (timestamp, in, out) samples inside the rate window. */
  private samples: Array<{ at: number; in: number; out: number }> = [];

  record(direction: "in" | "out", bytes: number, now = Date.now()): void {
    if (bytes <= 0) return;
    if (direction === "in") this.bytesIn += bytes;
    else this.bytesOut += bytes;
    this.lastActivityAt = now;
    this.samples.push({ at: now, in: direction === "in" ? bytes : 0, out: direction === "out" ? bytes : 0 });
    this.prune(now);
  }

  touch(now = Date.now()): void {
    this.lastActivityAt = now;
  }

  private prune(now: number): void {
    const cutoff = now - RATE_WINDOW_MS;
    while (this.samples.length > 0 && this.samples[0].at < cutoff) this.samples.shift();
  }

  /** Bytes/second over the window. Divided by the WINDOW, not by the span
   * between the samples held: a burst that ended two seconds ago must decay
   * toward zero rather than keep reporting its peak forever. */
  rates(now = Date.now()): { rateIn: number; rateOut: number } {
    this.prune(now);
    let inBytes = 0;
    let outBytes = 0;
    for (const sample of this.samples) {
      inBytes += sample.in;
      outBytes += sample.out;
    }
    const seconds = RATE_WINDOW_MS / 1000;
    return { rateIn: Math.round(inBytes / seconds), rateOut: Math.round(outBytes / seconds) };
  }
}

export class DeviceBridge {
  capabilities: DeviceCapabilities = NO_CAPABILITIES;
  private devices = new Map<string, DeviceInfo>();
  private buffers = new Map<string, DeviceBuffer>();
  /** Readers parked on `waitForData`, keyed by device. */
  private waiters = new Map<string, Set<() => void>>();
  private pending = new Map<string, Pending>();
  private send: Sender | null = null;
  private hostGeneration = 0;
  private revokeHost: (() => void) | null = null;
  private nextOpId = 1;
  private listeners = new Set<() => void>();
  /** Byte/op accounting per device, kept across a device's whole grant. */
  private activity = new Map<string, ActivityRecord>();

  /**
   * Devices that left the page (unplugged, rebooting, re-enumerating) and may
   * come back, by id. The page reported a granted device in its roster and then
   * said it was gone; that is the only way an id gets here, so `wait-for-device`
   * can address a device that is absent right now without any other unlisted id
   * becoming valid. A device the user disconnects on purpose never enters, and
   * one that reappears in the roster leaves. The page still validates the id
   * against its own grants when the wait reaches it.
   */
  private departed = new Map<string, { info: DeviceInfo; at: number }>();

  /** Bounded replayable summaries from the page operation manager. */
  private operations = new Map<string, DeviceOperationSnapshot>();
  private operationListeners = new Set<OperationListener>();

  /** adb forward/reverse rules served by this session's relay. */
  readonly tunnels = new TunnelHost({
    send: (message) => {
      if (!this.send) throw new Error("No browser is attached to this session.");
      this.send({ type: "tunnel", message });
    },
    operationActive: (operationId, deviceId) => {
      const snapshot = this.operations.get(operationId);
      if (!snapshot || snapshot.request.deviceId !== deviceId || snapshot.request.protocol !== "adb") return false;
      if (snapshot.request.action !== "forward" && snapshot.request.action !== "reverse") return false;
      // Only after the page recorded the user's confirmation, and only while the run is live.
      return snapshot.state === "running" && snapshot.events.some((entry) => entry.type === "confirmation");
    },
    traffic: (deviceId, direction, bytes) => {
      const record = this.activityFor(deviceId);
      record.record(direction === "toDevice" ? "out" : "in", bytes);
      record.touch();
    },
    reservedPorts: reservedLoopbackPorts,
    changed: () => this.notify(),
  });
  private hostLossTimer: ReturnType<typeof setTimeout> | null = null;

  get attached(): boolean {
    return this.send !== null;
  }

  /** A page took over as device host. Only one at a time: two tabs each
   * holding their own grants would make "device 2" mean different hardware
   * depending on which answered, so the newest attach wins and the previous
   * socket is dropped by its own caller. */
  attach(send: Sender, revoke: () => void = () => {}): (() => void) & { isCurrent(): boolean } {
    const generation = ++this.hostGeneration;
    const previousRevoke = this.revokeHost;
    this.clearHostLossTimer();
    this.send = send;
    this.revokeHost = revoke;
    // Revoke first: a former page must not finish a confirmation or write after
    // its successor becomes authoritative.
    if (previousRevoke) {
      this.failAllPending("Device host authority was replaced by another browser page.");
      this.tunnels.closeAll("Device host authority was replaced by another browser page.");
      this.markOperationsCompletionUnknown("Device host authority was replaced before operation completion.");
      // Another page has its own grants: ids remembered from the old one mean nothing there.
      this.departed.clear();
      previousRevoke();
    }
    this.notify();
    const detach = (() => {
      if (this.hostGeneration !== generation || this.send !== send) return;
      this.send = null;
      this.revokeHost = null;
      this.devices.clear();
      this.activity.clear();
      this.failAllPending("The browser holding this device disconnected.");
      this.tunnels.closeAll("The browser holding this device disconnected.");
      this.scheduleHostLoss();
      this.notify();
    }) as (() => void) & { isCurrent(): boolean };
    detach.isCurrent = () => this.hostGeneration === generation && this.send === send;
    return detach;
  }
  private clearHostLossTimer(): void {
    if (this.hostLossTimer !== null) clearTimeout(this.hostLossTimer);
    this.hostLossTimer = null;
  }

  private scheduleHostLoss(): void {
    this.clearHostLossTimer();
    this.hostLossTimer = setTimeout(() => {
      this.hostLossTimer = null;
      this.markOperationsCompletionUnknown("The browser disconnected before operation completion; completion is unknown.");
    }, DEVICE_LIVENESS_TIMEOUT_MS);
    this.hostLossTimer.unref?.();
  }

  private markOperationsCompletionUnknown(error: string): void {
    const now = Date.now();
    for (const snapshot of this.operations.values()) {
      if (snapshot.state === "succeeded" || snapshot.state === "failed" || snapshot.state === "cancelled") continue;
      this.storeOperation({ ...snapshot, state: "failed", updatedAt: now, error }, undefined, true);
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener must never break the bridge.
      }
    }
  }

  setCapabilities(capabilities: DeviceCapabilities): void {
    this.capabilities = capabilities;
    this.notify();
  }

  setDevices(devices: DeviceInfo[]): void {
    const next = new Map<string, DeviceInfo>();
    for (const device of devices) {
      next.set(device.id, device);
      this.departed.delete(device.id);
    }
    this.devices = next;
    for (const id of [...this.buffers.keys()]) {
      if (!next.has(sourceDevice(id))) this.buffers.delete(id);
    }
    for (const id of [...this.activity.keys()]) {
      if (!next.has(id)) this.activity.delete(id);
    }
    this.notify();
  }

  /** The last roster entry of a device that left the page and may return, by exact id; undefined for any other id. */
  departedDevice(deviceId: string): DeviceInfo | undefined {
    const entry = this.departed.get(deviceId);
    if (!entry) return undefined;
    if (Date.now() - entry.at > DEPARTED_RETENTION_MS) {
      this.departed.delete(deviceId);
      return undefined;
    }
    return { ...entry.info };
  }

  removeDevice(deviceId: string): void {
    const known = this.devices.get(deviceId);
    if (known) {
      this.departed.delete(deviceId);
      this.departed.set(deviceId, { info: known, at: Date.now() });
      while (this.departed.size > DEPARTED_MAX) this.departed.delete(this.departed.keys().next().value!);
    }
    this.devices.delete(deviceId);
    for (const key of [...this.buffers.keys()]) {
      if (sourceDevice(key) === deviceId) this.buffers.delete(key);
    }
    this.activity.delete(deviceId);
    this.tunnels.closeDevice(deviceId, "The device was disconnected.");
    this.wake(deviceId);
    this.notify();
  }

  private activityFor(deviceId: string): ActivityRecord {
    let record = this.activity.get(deviceId);
    if (!record) {
      record = new ActivityRecord();
      this.activity.set(deviceId, record);
    }
    return record;
  }

  /** What is moving on each granted device right now. Devices with no
   * traffic yet are included with zeroes: "nothing has happened on this
   * link" is an answer, and omitting the row would read as "no such link". */
  activitySnapshot(): DeviceActivity[] {
    const now = Date.now();
    return [...this.devices.keys()].map((deviceId) => {
      const record = this.activityFor(deviceId);
      const { rateIn, rateOut } = record.rates(now);
      return {
        deviceId,
        bytesIn: record.bytesIn,
        bytesOut: record.bytesOut,
        rateIn,
        rateOut,
        ops: record.ops,
        inFlight: record.inFlight,
        lastActivityAt: record.lastActivityAt,
        buffered: this.buffered(deviceId),
        dropped: record.dropped,
        lastError: record.lastError,
      };
    });
  }

  list(): DeviceInfo[] {
    return [...this.devices.values()].map((device) => ({
      ...device,
      buffered: this.buffered(device.id),
    }));
  }

  /**
   * Inbound bytes from the page, buffered per SOURCE.
   *
   * A BLE device can notify on several characteristics at once, and merging
   * those into one stream would hand the agent interleaved bytes with no way
   * to tell which characteristic produced them — for binary GATT payloads
   * that is not a formatting problem, it is corruption. Serial and USB have
   * exactly one source, so their key is the device itself.
   */
  push(deviceId: string, data: Buffer, characteristic?: string): void {
    const key = sourceKey(deviceId, characteristic);
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = new DeviceBuffer();
      this.buffers.set(key, buffer);
    }
    const droppedBefore = buffer.droppedTotal;
    buffer.push(data);
    const record = this.activityFor(deviceId);
    record.record("in", data.length);
    record.dropped += buffer.droppedTotal - droppedBefore;
    this.wake(deviceId);
  }

  read(deviceId: string, maxBytes: number, characteristic?: string): { data: Buffer; dropped: number } {
    return this.buffers.get(sourceKey(deviceId, characteristic))?.drain(maxBytes) ?? { data: Buffer.alloc(0), dropped: 0 };
  }

  /** Bytes waiting for one source, or across every source of a device. */
  buffered(deviceId: string, characteristic?: string): number {
    if (characteristic !== undefined) return this.buffers.get(sourceKey(deviceId, characteristic))?.length ?? 0;
    let total = 0;
    for (const [key, buffer] of this.buffers) {
      if (sourceDevice(key) === deviceId) total += buffer.length;
    }
    return total;
  }

  /** Which characteristics of a BLE device have unread bytes, so a reader can
   * be told what it is choosing between instead of guessing. */
  sources(deviceId: string): string[] {
    const found: string[] = [];
    for (const [key, buffer] of this.buffers) {
      if (sourceDevice(key) !== deviceId || buffer.length === 0) continue;
      const characteristic = sourceCharacteristic(key);
      if (characteristic) found.push(characteristic);
    }
    return found;
  }

  /**
   * Resolve as soon as bytes arrive for this device, or when the wait runs
   * out. A reader that polled instead would trade either latency or wasted
   * wakeups for nothing: the page tells us the moment data lands.
   */
  waitForData(deviceId: string, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0 || this.buffered(deviceId) > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.waiters.get(deviceId) ?? new Set<() => void>();
      this.waiters.set(deviceId, waiters);
      const done = (): void => {
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0) this.waiters.delete(deviceId);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      waiters.add(done);
    });
  }

  private wake(deviceId: string): void {
    const waiters = this.waiters.get(deviceId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter();
  }

  settle(result: Extract<DeviceClientFrame, { type: "result" }>): void {
    const { id } = result;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const record = this.activityFor(pending.deviceId);
    record.ops += 1;
    record.inFlight = null;
    record.record("in", result.status === "ok" ? base64Bytes(result.value) : 0);
    record.lastError = result.status === "error"
      ? result.error
      : result.status === "cancelled"
        ? new DeviceOperationCancelledError(result.reason).message
        : null;
    record.touch();
    this.notify();
    if (result.status === "ok") pending.resolve(result.value);
    else if (result.status === "no-data") pending.resolve(DEVICE_NO_DATA);
    else if (result.status === "cancelled") pending.reject(new DeviceOperationCancelledError(result.reason));
    else pending.reject(new Error(result.error));
  }

  private failAllPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  /**
   * Ask the page to do one thing. Rejects rather than hanging when no page is
   * attached or the page does not answer: the device host being absent is an
   * ordinary state (the tab was closed, the phone locked), and a tool call
   * that waits forever on it is the worst possible reading of that.
   */
  request(op: DeviceOpName, deviceId: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const send = this.send;
    if (!send) {
      return Promise.reject(new Error("No browser is attached to this session, so its hardware is unreachable. Open the Devices panel in Cody and connect the device."));
    }
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DEVICE_TIMEOUT_MS)) {
      return Promise.reject(new Error("timeoutMs must be an integer from 1 to " + MAX_DEVICE_TIMEOUT_MS + "."));
    }
    const id = String(this.nextOpId++);
    const record = this.activityFor(deviceId);
    record.inFlight = { op, startedAt: Date.now() };
    record.record("out", base64Bytes(params));
    record.touch();
    this.notify();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        record.inFlight = null;
        record.lastError = "The browser did not answer " + op + " within " + Math.round(DEVICE_LIVENESS_TIMEOUT_MS / 1000) + "s.";
        this.notify();
        reject(new Error(record.lastError));
      }, DEVICE_LIVENESS_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, deviceId });
      try {
        send({ type: "op", id, op, deviceId, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        record.inFlight = null;
        record.lastError = error instanceof Error ? error.message : String(error);
        this.notify();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Starts a durable page-side run and waits only for page acceptance, not completion. */
  async startOperation(request: DeviceOperationRequest): Promise<string> {
    const operationId = globalThis.crypto.randomUUID();
    const command: Extract<PageOperationCommand, { type: "operation.start" }> = {
      type: "operation.start",
      id: String(this.nextOpId++),
      operationId,
      request,
    };
    await this.dispatchOperation(command, request.deviceId);
    return operationId;
  }

  async cancelOperation(operationId: string): Promise<void> {
    const deviceId = this.operations.get(operationId)?.request.deviceId;
    if (!deviceId) throw new Error("Unknown device operation.");
    const command: Extract<PageOperationCommand, { type: "operation.cancel" }> = {
      type: "operation.cancel",
      id: String(this.nextOpId++),
      operationId,
    };
    await this.dispatchOperation(command, deviceId);
  }

  async sendOperation(operationId: string, text: string): Promise<void> {
    const deviceId = this.operations.get(operationId)?.request.deviceId;
    if (!deviceId) throw new Error("Unknown device operation.");
    const command: Extract<PageOperationCommand, { type: "operation.send" }> = {
      type: "operation.send",
      id: String(this.nextOpId++),
      operationId,
      text,
    };
    await this.dispatchOperation(command, deviceId);
  }

  async requestOperationStatus(operationId?: string): Promise<void> {
    const deviceId = operationId ? this.operations.get(operationId)?.request.deviceId : "operation-status";
    if (!deviceId) throw new Error("Unknown device operation.");
    const command: Extract<PageOperationCommand, { type: "operation.status" }> = {
      type: "operation.status",
      id: String(this.nextOpId++),
      ...(operationId ? { operationId } : {}),
    };
    await this.dispatchOperation(command, deviceId);
  }

  operationStatus(operationId: string): DeviceOperationSnapshot | undefined {
    return this.operations.get(operationId);
  }

  operationSnapshots(): readonly DeviceOperationSnapshot[] {
    return [...this.operations.values()];
  }

  onOperation(listener: OperationListener): () => void {
    this.operationListeners.add(listener);
    return () => this.operationListeners.delete(listener);
  }

  receiveOperationProgress(frame: Extract<DeviceClientFrame, { type: "operation.progress" }>): void {
    this.storeOperation(frame.snapshot, frame.event);
  }

  receiveOperationSnapshot(frame: Extract<DeviceClientFrame, { type: "operation.snapshot" }>): void {
    this.storeOperation(frame.snapshot);
  }

  receiveOperationResult(frame: Extract<DeviceClientFrame, { type: "operation.result" }>): void {
    this.storeOperation(frame.snapshot, undefined, true);
  }

  private async dispatchOperation(command: PageOperationCommand, deviceId: string): Promise<void> {
    const send = this.send;
    if (!send) {
      throw new Error("No browser is attached to this session, so its hardware is unreachable. Open the Devices panel in Cody and connect a device.");
    }
    await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error("The browser did not acknowledge the device operation within " + Math.round(DEVICE_LIVENESS_TIMEOUT_MS / 1000) + "s; its completion is unknown."));
      }, DEVICE_LIVENESS_TIMEOUT_MS);
      this.pending.set(command.id, { resolve, reject, timer, deviceId });
      try {
        send({ type: "operation", command });
      } catch (error) {
        this.pending.delete(command.id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private storeOperation(snapshot: DeviceOperationSnapshot, event?: OperationEvent, terminal = false): void {
    const previous = this.operations.get(snapshot.id);
    const previousSequence = previous?.events.at(-1)?.sequence ?? 0;
    if (event && event.sequence <= previousSequence) return;
    if (!event && previous && snapshot.updatedAt <= previous.updatedAt && snapshot.state === previous.state) return;
    this.operations.set(snapshot.id, snapshot);
    if (snapshot.state === "succeeded" || snapshot.state === "failed" || snapshot.state === "cancelled") {
      this.tunnels.closeOperation(snapshot.id, "The operation behind this port rule ended.");
    }
    this.pruneOperations();
    if (event || terminal) {
      for (const listener of this.operationListeners) {
        try {
          listener(snapshot, event, previous);
        } catch {
          // Transcript observers cannot break an active hardware operation.
        }
      }
    }
    this.notify();
  }

  private pruneOperations(): void {
    while (this.operations.size > 128) {
      const oldestTerminal = [...this.operations.entries()].find(([, snapshot]) => {
        return snapshot.state === "succeeded" || snapshot.state === "failed" || snapshot.state === "cancelled";
      });
      if (!oldestTerminal) return;
      this.operations.delete(oldestTerminal[0]);
    }
  }
}

type BridgeStore = Map<string, DeviceBridge>;

function store(): BridgeStore {
  const globalScope = globalThis as typeof globalThis & { __codyDeviceBridges?: BridgeStore };
  if (!globalScope.__codyDeviceBridges) globalScope.__codyDeviceBridges = new Map();
  return globalScope.__codyDeviceBridges;
}

export function getDeviceBridge(sessionId: string): DeviceBridge {
  const bridges = store();
  let bridge = bridges.get(sessionId);
  if (!bridge) {
    bridge = new DeviceBridge();
    bridges.set(sessionId, bridge);
  }
  return bridge;
}

/** The bridge for a session, only if one was ever created — the read every
 * "is there hardware here?" caller wants, with no side effect. */
export function peekDeviceBridge(sessionId: string): DeviceBridge | null {
  return store().get(sessionId) ?? null;
}

/** Follow a session that was re-keyed mid-run, exactly as the display bus
 * aliases its requests. */
export function aliasDeviceBridge(oldId: string, newId: string): void {
  const bridges = store();
  const existing = bridges.get(oldId);
  if (!existing || oldId === newId) return;
  bridges.set(newId, existing);
  bridges.delete(oldId);
}

export type DeviceMatch =
  | { kind: "one"; device: DeviceInfo }
  | { kind: "none" }
  | { kind: "many"; candidates: DeviceInfo[] };

/** Exact id, then a case-insensitive substring of the label. Ambiguity is
 * reported, never resolved by guessing: writing to the wrong serial port is
 * not something the next tool call can undo. */
export function matchDevice(devices: DeviceInfo[], query: string | undefined): DeviceMatch {
  if (!query) return devices.length === 1 ? { kind: "one", device: devices[0] } : devices.length === 0 ? { kind: "none" } : { kind: "many", candidates: devices };
  const exact = devices.find((device) => device.id === query);
  if (exact) return { kind: "one", device: exact };
  const needle = query.trim().toLowerCase();
  const matches = devices.filter((device) => device.label.toLowerCase().includes(needle));
  if (matches.length === 1) return { kind: "one", device: matches[0] };
  return matches.length === 0 ? { kind: "none" } : { kind: "many", candidates: matches };
}
