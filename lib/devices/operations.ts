import type {
  Flasher,
  HardwareContext,
  HardwareProgress,
  HardwareRequest,
  HardwareResult,
  HardwareRisk,
  HardwareTransport,
} from "./flasher";
import { hashBlob } from "./blob-stream";
import type { StreamArtifact } from "./flasher";
import { adbFlasher, adbWaitOptions } from "./adb";
import { pause } from "./pause";
import type { TunnelChannel } from "./tunnel";
import { deviceArtifacts } from "./artifacts";
import { dfuFlasher } from "./dfu";
import { edlFlasher } from "./edl";
import { espFlasher } from "./esp";
import { fastbootFlasher } from "./fastboot";
import { geckoFlasher } from "./gecko";
import { stm32Flasher } from "./stm32";
import { stk500Flasher } from "./stk500";
import { serialFlasher, serialSignals, type SerialSignals } from "./serial-monitor";

/**
 * Browser-owned artifacts. A runner receives bytes only through this session
 * boundary; it never fetches a URL or opens a server path on an agent's behalf.
 */
export interface OperationArtifacts {
  getInput(sessionId: string, fileId: string): Promise<Blob | undefined>;
  save(sessionId: string, name: string, data: Blob): Promise<string>;
  saveStream?(sessionId: string, name: string, chunks: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<StreamArtifact>;
}

/** The bridge owns this lease. No raw tool or RX pump may use it while a run is active. */
 export interface HardwareTransportLease {
   transport: HardwareTransport;
  /** Stable grant identity captured before an ADB transport reconnect. */
  identity?: string;
   release(): Promise<void>;
 }
 
 export interface HardwareTransportProvider {
   borrowHardwareTransport(
     deviceId: string,
     options?: { interfaceNumber?: number; alternateSetting?: number },
   ): Promise<HardwareTransportLease>;
  /**
   * The SAME granted device again after it left the bus and came back. Rejects
   * unless `identity` is the stable identity the session was granted, and waits
   * at most `timeoutMs` (the provider's own limit when absent) or until `signal`
   * aborts.
   */
  reacquireHardwareTransport?(
    deviceId: string,
    identity: string,
    options: { interfaceNumber?: number; alternateSetting?: number; signal: AbortSignal; timeoutMs?: number },
  ): Promise<HardwareTransportLease>;
  /** Browser-to-server relay for ADB port forwarding, when this page has one. */
  readonly tunnels?: TunnelChannel;
 }

/** The request is intentionally unable to carry an approval. Approval is a separate UI-only action. */
export interface DeviceOperationRequest extends HardwareRequest {
  deviceId: string;
  interfaceNumber?: number;
  alternateSetting?: number;
}

export type OperationState =
  | "starting"
  | "running"
  | "awaiting-confirmation"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface OperationProgress extends HardwareProgress {
  at: number;
}

export interface OperationRiskBinding {
  action: string;
  target: string;
  sha256?: string;
  offset?: number;
  length?: number;
  programSha256?: string;
  programOffset?: number;
  programLength?: number;
  details?: string;
  protectedOverride?: string;
  backup: string;
}

export interface OperationConfirmation {
  id: string;
  binding: OperationRiskBinding;
  requestedAt: number;
}

export interface OperationOutput {
  at: number;
  line: string;
  kind: "terminal" | "log";
}

export interface OperationEvent {
  sequence: number;
  at: number;
  type: "started" | "progress" | "output" | "confirmation" | "state" | "completed";
  progress?: OperationProgress;
  output?: OperationOutput;
  confirmation?: OperationConfirmation;
  state?: OperationState;
  error?: string;
}

export interface DeviceOperationSnapshot {
  id: string;
  sessionId: string;
  request: Readonly<DeviceOperationRequest>;
  origin: "user" | "agent";
  state: OperationState;
  createdAt: number;
  updatedAt: number;
  progress?: OperationProgress;
  confirmation?: OperationConfirmation;
  result?: HardwareResult;
  error?: string;
  output: readonly OperationOutput[];
  events: readonly OperationEvent[];
}

export interface OperationStartResult {
  id: string;
  snapshot: DeviceOperationSnapshot;
}
const MAX_OPERATION_EVENTS = 256;
const MAX_OPERATION_OUTPUT_CHARS = 64 * 1024;
const MAX_OPERATION_OUTPUT_LINES = 512;
const MAX_OPERATION_RECORDS = 128;
const MAX_MONITOR_LINE_CHARS = 8 * 1024;
const PROGRESS_PUBLISH_MS = 200;
/** How long a reacquisition after an announced adbd restart waits to SEE the device leave the bus before it assumes this device restarts without re-enumerating. */
const RESTART_DISCONNECT_GRACE_MS = 4_000;
/**
 * A reacquisition tells the provider how long it has (`timeoutMs`), and a provider that
 * honours that reports its own, more specific, timeout. The runner's cut-off for one that
 * does not (opening the device is not covered by it) comes this much later, so it never
 * pre-empts the provider's message in a photo finish.
 */
const PROVIDER_TIMEOUT_GRACE_MS = 250;
const textEncoder = new TextEncoder();
interface PendingConfirmation {
  confirmation: OperationConfirmation;
  resolve(): void;
  reject(reason: Error): void;
}

/** An adbd restart the operation itself asked for: its device is expected to leave the bus and come back. */
interface RestartWindow {
  expiresAt: number;
  /** The browser reported the device leaving the bus. */
  disconnected: boolean;
}

interface OperationRecord {
  id: string;
  sessionId: string;
  origin: "user" | "agent";
  terminalInput?: (bytes: Uint8Array) => Promise<void>;
  request: DeviceOperationRequest;
  state: OperationState;
  createdAt: number;
  updatedAt: number;
  controller: AbortController;
  progress?: OperationProgress;
  confirmation?: OperationConfirmation;
  pendingConfirmation?: PendingConfirmation;
  result?: HardwareResult;
  error?: string;
  output: OperationOutput[];
  outputChars: number;
  events: OperationEvent[];
  sequence: number;
  lease?: HardwareTransportLease;
  writeChain: Promise<void>;
  writeGeneration: number;
  settled?: Promise<void>;
  /** The stable granted-device identity captured with the first lease. It outlives any one lease: a reacquisition after a failed one still knows which device it is for. */
  identity?: string;
  /** Set while the operation is knowingly restarting the device's own daemon. */
  restart?: RestartWindow;
  /** When a wait-for-device gives up, counted from when it began waiting; the flasher receives it as context.deadline. */
  waitDeadline?: number;
}

function cloneRequest(request: DeviceOperationRequest): DeviceOperationRequest {
  return {
    ...request,
    options: request.options ? { ...request.options } : undefined,
  };
}

function cloneResult(result: HardwareResult): HardwareResult {
  return {
    ...result,
    details: result.details ? { ...result.details } : undefined,
  };
}

function cloneRiskBinding(binding: OperationRiskBinding): OperationRiskBinding {
  return { ...binding };
}

function cloneConfirmation(confirmation: OperationConfirmation): OperationConfirmation {
  return {
    id: confirmation.id,
    binding: cloneRiskBinding(confirmation.binding),
    requestedAt: confirmation.requestedAt,
  };
}

function cloneProgress(progress: OperationProgress): OperationProgress {
  return { ...progress };
}

function cloneOutput(output: OperationOutput): OperationOutput {
  return { ...output };
}

function cloneEvent(event: OperationEvent): OperationEvent {
  return {
    ...event,
    progress: event.progress ? cloneProgress(event.progress) : undefined,
    output: event.output ? cloneOutput(event.output) : undefined,
    confirmation: event.confirmation ? cloneConfirmation(event.confirmation) : undefined,
  };
}

function frozenSnapshot(record: OperationRecord): DeviceOperationSnapshot {
  const request = cloneRequest(record.request);
  const snapshot: DeviceOperationSnapshot = {
    id: record.id,
    sessionId: record.sessionId,
    origin: record.origin,
    request: Object.freeze(request),
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    progress: record.progress ? cloneProgress(record.progress) : undefined,
    confirmation: record.confirmation ? cloneConfirmation(record.confirmation) : undefined,
    result: record.result ? cloneResult(record.result) : undefined,
    error: record.error,
    output: Object.freeze(record.output.map(cloneOutput)),
    events: Object.freeze(record.events.map(cloneEvent)),
  };
  return Object.freeze(snapshot);
}

function isTerminal(state: OperationState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function validFiniteInteger(value: number | undefined, name: string, minimum = 0): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer at least ${minimum}.`);
}

interface SharedAdbLease {
  users: number;
  options: { interfaceNumber?: number; alternateSetting?: number };
  pending: Promise<HardwareTransportLease>;
  closing?: Promise<void>;
}

/** ADB work that only opens more streams on the already authenticated connection. */
function sharesAdbConnection(request: DeviceOperationRequest): boolean {
  if (request.protocol !== "adb") return false;
  switch (request.action) {
    case "detect":
    case "pull":
    case "dump":
    case "verify":
    case "monitor":
    case "forward":
    case "reverse":
      return true;
    case "exec": {
      const kind = request.options?.kind;
      return kind === undefined || kind === "shell" || kind === "reverse-list" || kind === "reverse-remove" || kind === "reverse-remove-all";
    }
    default:
      return false;
  }
}

function validateRequest(request: DeviceOperationRequest): void {
  if (!request.deviceId.trim()) throw new Error("A device id is required.");
  if (!request.protocol) throw new Error("A protocol is required.");
  if (!request.action) throw new Error("An action is required.");
  if (request.target !== undefined && request.target.length === 0) throw new Error("A target must not be empty.");
  if (request.fileId !== undefined && !request.fileId.trim()) throw new Error("A file id must not be empty.");
  if (request.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(request.sha256)) {
    throw new Error("sha256 must be a 64-character hexadecimal digest.");
  }
  if (Boolean(request.fileId) !== Boolean(request.sha256) && !(request.action === "verify" && request.sha256 && !request.fileId)) throw new Error("An input file and its SHA-256 digest must be supplied together.");
  if ((request.action === "forward" || request.action === "reverse") && !request.target?.trim()) {
    throw new Error(`${request.action} requires the device-side address as target, for example tcp:8080.`);
  }
  if ((request.action === "flash" || request.action === "push" || request.action === "sideload" || request.action === "install") && !request.fileId) {
    throw new Error(request.action + " requires a session artifact and its SHA-256 digest.");
  }
  validFiniteInteger(request.interfaceNumber, "interfaceNumber");
  validFiniteInteger(request.alternateSetting, "alternateSetting");
  validFiniteInteger(request.offset, "offset");
  validFiniteInteger(request.length, "length", 1);
  if (request.baudRate !== undefined) validFiniteInteger(request.baudRate, "baudRate", 1);
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function sha256(blob: Blob): Promise<string> { return hashBlob(blob); }

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A lease acquisition that was still pending when its deadline passed. */
class LeaseDeadlineError extends Error {}

/**
 * Waits for a lease acquisition, but not past `deadline` (an absolute time, when there is
 * one) and not past a cancel: a provider that is slow to open the device (WebUSB open,
 * configure, claim) must not keep a bounded wait, or a Cancel, waiting. An acquisition left
 * behind this way does not leak: should it ever produce a lease, that lease is released at once.
 */
function awaitLease(acquisition: Promise<HardwareTransportLease>, signal: AbortSignal, deadline: number | undefined, whenLate: string): Promise<HardwareTransportLease> {
  const { promise, resolve, reject } = Promise.withResolvers<HardwareTransportLease>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (done: () => void): boolean => {
    if (settled) return false;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    done();
    return true;
  };
  const onAbort = (): void => { finish(() => reject(new DOMException("Operation cancelled.", "AbortError"))); };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  if (!settled && deadline !== undefined) timer = setTimeout(() => { finish(() => reject(new LeaseDeadlineError(whenLate))); }, Math.max(0, deadline - Date.now()));
  acquisition.then(
    (lease) => { if (!finish(() => resolve(lease))) void lease.release().catch(() => undefined); },
    (error: unknown) => { finish(() => reject(error)); },
  );
  return promise;
}

/**
 * Browser page runner for a session. The page keeps this object alive across
 * host-tool/eval lifetimes, so a start response can return immediately while
 * progress and terminal state continue through the bridge transcript path.
 */
export class DeviceOperationManager {
  private readonly flashers = new Map<DeviceOperationRequest["protocol"], Flasher>();
  private readonly records = new Map<string, OperationRecord>();
  private readonly listeners = new Set<(snapshot: DeviceOperationSnapshot, event: OperationEvent) => void>();
  private readonly sessionId: string;
  private readonly transportProvider: HardwareTransportProvider;
  private readonly artifacts: OperationArtifacts;
  private authorityRevokedReason: string | undefined;
  private readonly shellGrants = new Set<string>();
  private readonly shellListeners = new Set<() => void>();

  hasShellAccess(deviceId: string): boolean { return this.shellGrants.has(deviceId); }

  subscribeShellAccess(listener: () => void): () => void {
    this.shellListeners.add(listener);
    return () => this.shellListeners.delete(listener);
  }

  /** Panel-only action. No server command can grant shell authority. */
  setShellAccess(deviceId: string, allowed: boolean): void {
    if (this.authorityRevokedReason) throw new Error(this.authorityRevokedReason);
    if (allowed) this.shellGrants.add(deviceId);
    else this.revokeShellAccess(deviceId);
    for (const listener of this.shellListeners) listener();
  }

  /** Withdraws the grant and cancels the agent's ADB operations on the device, except those `spare` names. */
  private revokeShellAccess(deviceId: string, spare: (record: OperationRecord) => boolean = () => false): void {
    this.shellGrants.delete(deviceId);
    for (const record of this.records.values()) {
      if (record.request.deviceId === deviceId && record.request.protocol === "adb" && record.origin === "agent" && !isTerminal(record.state) && !spare(record)) {
        this.addOutput(record, "Agent shell access revoked. Cancelling this operation; already executed commands cannot be undone.");
        this.cancel(record.id);
      }
    }
  }

  /**
   * The browser reports that the device left the USB bus, or the user
   * disconnected it (`forgotten`). Shell access is always revoked and every
   * operation on the device is cancelled - except one for which the departure is
   * part of what it is doing (see `departureExpected`): an operation that
   * announced it was restarting the device (expectDeviceRestart), and a
   * wait-for-device, which exists to ride out a device that leaves and returns.
   * A device the user disconnected on purpose is never expected back.
   */
  async deviceDisconnected(deviceId: string, cause: "left-bus" | "forgotten" = "left-bus"): Promise<void> {
    const expected = (record: OperationRecord): boolean => cause === "left-bus" && this.departureExpected(record);
    this.revokeShellAccess(deviceId, expected);
    for (const listener of this.shellListeners) listener();
    const settling: Promise<void>[] = [];
    for (const record of this.records.values()) {
      if (record.request.deviceId !== deviceId) continue;
      if (!isTerminal(record.state) && expected(record)) {
        if (record.restart) {
          record.restart.disconnected = true;
          this.addOutput(record, "The device left the USB bus, as expected after what this operation just did. The operation goes on.");
        } else {
          this.addOutput(record, "The device left the USB bus. This wait goes on until the same device is back or its time is up.");
        }
        continue;
      }
      if (!isTerminal(record.state)) this.cancel(record.id);
      if (record.settled) settling.push(record.settled);
    }
    await Promise.all(settling);
  }

  /**
   * Whether the record's device leaving the bus is part of what the operation is doing:
   * it announced a departure (an adbd restart, a DFU manifestation, leave or reset) and
   * that window is still open, or it is a wait-for-device inside its own deadline. A
   * wait is for a device that may be rebooting, re-enumerating, or in the wrong mode
   * until it changes; only the same granted identity is ever taken again, and the deadline
   * is the only thing that ends the wait besides the user.
   */
  private departureExpected(record: OperationRecord): boolean {
    const now = Date.now();
    if (record.restart !== undefined && now < record.restart.expiresAt) return true;
    return record.waitDeadline !== undefined && now < record.waitDeadline;
  }

  constructor(
    sessionId: string,
    transportProvider: HardwareTransportProvider,
    artifacts: OperationArtifacts,
    flashers: readonly Flasher[] = [serialFlasher],
  ) {
    this.sessionId = sessionId;
    this.transportProvider = transportProvider;
    this.artifacts = artifacts;
    for (const flasher of flashers) this.registerFlasher(flasher);
  }

  /** Browser-hosted connections that several ADB operations on one device share. */
  private readonly sharedAdb = new Map<string, SharedAdbLease>();

  /**
   * One exclusive lease per device, except that ADB operations which only open
   * more streams on the same authenticated connection (port rules, shells,
   * pulls, terminals) join the lease already held for that device, as several
   * `adb` commands share one connection on a PC. The device is released only
   * when the last of them finishes; anything that rewrites the connection or
   * the device (push staging, sideload, reboot) still needs the lease alone.
   */
  private async acquireLease(record: OperationRecord): Promise<HardwareTransportLease> {
    const { request } = record;
    const options = { interfaceNumber: request.interfaceNumber, alternateSetting: request.alternateSetting };
    if (!sharesAdbConnection(request)) return this.transportProvider.borrowHardwareTransport(request.deviceId, options);
    const deviceId = request.deviceId;
    let shared = this.sharedAdb.get(deviceId);
    while (shared?.closing) {
      await shared.closing.catch(() => undefined);
      shared = this.sharedAdb.get(deviceId);
    }
    if (shared && (shared.options.interfaceNumber !== options.interfaceNumber || shared.options.alternateSetting !== options.alternateSetting)) {
      return this.transportProvider.borrowHardwareTransport(deviceId, options);
    }
    if (!shared) {
      const created: SharedAdbLease = { users: 0, options, pending: this.transportProvider.borrowHardwareTransport(deviceId, options) };
      shared = created;
      this.sharedAdb.set(deviceId, created);
      created.pending.catch(() => {
        if (this.sharedAdb.get(deviceId) === created && created.users === 0) this.sharedAdb.delete(deviceId);
      });
    }
    const entry = shared;
    entry.users += 1;
    let base: HardwareTransportLease;
    try {
      base = await entry.pending;
    } catch (error) {
      entry.users -= 1;
      if (entry.users === 0 && this.sharedAdb.get(deviceId) === entry) this.sharedAdb.delete(deviceId);
      throw error;
    }
    let released = false;
    return {
      transport: base.transport,
      identity: base.identity,
      release: async () => {
        if (released) return;
        released = true;
        entry.users -= 1;
        if (entry.users > 0) return;
        entry.closing = base.release();
        try {
          await entry.closing;
        } finally {
          if (this.sharedAdb.get(deviceId) === entry) this.sharedAdb.delete(deviceId);
        }
      },
    };
  }

  registerFlasher(flasher: Flasher): void {
    if (this.flashers.has(flasher.protocol)) throw new Error(`A ${flasher.protocol} flasher is already registered.`);
    this.flashers.set(flasher.protocol, flasher);
  }

  subscribe(listener: (snapshot: DeviceOperationSnapshot, event: OperationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startUser(request: DeviceOperationRequest): OperationStartResult {
    return this.begin(request, randomId("device-operation"), "user");
  }

  start(request: DeviceOperationRequest, operationId = randomId("device-operation")): OperationStartResult {
    return this.begin(request, operationId, "agent");
  }

  private begin(request: DeviceOperationRequest, operationId: string, origin: "user" | "agent"): OperationStartResult {
    if (this.authorityRevokedReason) throw new Error(this.authorityRevokedReason);
    validateRequest(request);
    if (!operationId.trim()) throw new Error("An operation id is required.");
    if (this.records.has(operationId)) throw new Error("That operation id already exists.");
    const now = Date.now();
    const record: OperationRecord = {
      origin,
      id: operationId,
      sessionId: this.sessionId,
      request: cloneRequest(request),
      state: "starting",
      createdAt: now,
      updatedAt: now,
      controller: new AbortController(),
      output: [],
      outputChars: 0,
      events: [],
      sequence: 0,
      writeChain: Promise.resolve(),
      writeGeneration: 0,
    };
    this.records.set(record.id, record);
    this.emit(record, { type: "started", state: record.state });
    record.settled = this.run(record);
    return { id: record.id, snapshot: frozenSnapshot(record) };
  }

  status(id: string): DeviceOperationSnapshot | undefined {
    const record = this.records.get(id);
    return record ? frozenSnapshot(record) : undefined;
  }

  snapshots(): readonly DeviceOperationSnapshot[] {
    return Object.freeze([...this.records.values()].map(frozenSnapshot));
  }

  /** A replacement browser page took this session's hardware authority. */
  revokeAuthority(reason = "This browser page no longer owns the session hardware authority."): void {
    if (this.authorityRevokedReason) return;
    this.shellGrants.clear();
    for (const listener of this.shellListeners) listener();
    this.authorityRevokedReason = reason;
    for (const record of this.records.values()) {
      if (!isTerminal(record.state)) this.cancel(record.id);
    }
  }

  /** Cancellation never queues an additional device write. */
  cancel(id: string): DeviceOperationSnapshot {
    const record = this.requireRecord(id);
    if (isTerminal(record.state)) return frozenSnapshot(record);
    if (record.state !== "cancelling") {
      record.state = "cancelling";
      record.updatedAt = Date.now();
      record.writeGeneration += 1;
      record.controller.abort();
      record.pendingConfirmation?.reject(new DOMException("Operation cancelled.", "AbortError"));
      record.pendingConfirmation = undefined;
      record.confirmation = undefined;
      this.emit(record, { type: "state", state: record.state });
    }
    return frozenSnapshot(record);
  }

  async setSignalsUser(id:string,value:SerialSignals):Promise<void> {
    const signals=serialSignals(value), record=this.requireRecord(id);
    if(record.request.action!=="monitor" || record.request.protocol!=="serial") throw new Error("Line controls require a serial terminal.");
    const pending=record.writeChain.then(async()=>{
      if(record.state!=="running" || record.controller.signal.aborted || !record.lease) throw new Error("The terminal is closed.");
      const transport=record.lease.transport;
      if(!transport.setSignals) throw new Error("This adapter does not expose DTR/RTS/break control.");
      await transport.setSignals(signals, record.controller.signal);
      this.addOutput(record,"User changed serial signals: "+JSON.stringify(signals));
    });
    record.writeChain=pending.catch(()=>undefined); await pending;
  }

  /**
   * Live monitor input only. There is deliberately no retry or stored queue:
   * a returned success means this exact write reached the borrowed transport.
   */
  async sendUser(id: string, text: string): Promise<DeviceOperationSnapshot> {
    return this.sendInput(id, text, "user");
  }

  async send(id: string, text: string): Promise<DeviceOperationSnapshot> {
    return this.sendInput(id, text, "agent");
  }

  private async sendInput(id: string, text: string, origin: "user" | "agent"): Promise<DeviceOperationSnapshot> {
    if (this.authorityRevokedReason) throw new Error(this.authorityRevokedReason);
    const record = this.requireRecord(id);
    if (record.request.action !== "monitor") throw new Error("Only monitor operations accept interactive input.");
    if (record.state !== "running" || record.controller.signal.aborted || !record.lease) {
      throw new Error("The monitor is not accepting input.");
    }
    if (origin === "agent" && record.request.protocol === "adb" && !this.hasShellAccess(record.request.deviceId)) throw new Error("Allow agent shell access in the Devices panel first.");
    if (!text.length) throw new Error("Monitor input must not be empty.");
    const generation = record.writeGeneration;
    const bytes = textEncoder.encode(text);
    record.writeChain = record.writeChain.catch(() => undefined).then(async () => {
      if (record.writeGeneration !== generation || record.state !== "running" || record.controller.signal.aborted || !record.lease) {
        throw new DOMException("Monitor input was cancelled before it was sent.", "AbortError");
      }
      if (origin === "agent" && record.request.protocol === "adb" && !this.hasShellAccess(record.request.deviceId)) throw new Error("Agent shell access was revoked.");
      if (record.terminalInput) await record.terminalInput(bytes);
      else if (record.lease.transport.kind === "serial") await record.lease.transport.write(bytes, record.controller.signal);
      else throw new Error("The terminal is not ready for input.");
      this.addOutput(record, `> ${origin}: ${text}`);
    });
    await record.writeChain;
    return frozenSnapshot(record);
  }

  /**
   * Called only by the page's direct risk UI after the server has delivered an
   * approval command. Neither `start` nor any high-level agent tool accepts an
   * approval bit. Matching the one-use id and complete binding rejects stale
   * cards after a changed target, offset, or artifact digest.
   */
  confirm(id: string, confirmationId: string, binding: OperationRiskBinding, typedOverride?: string): DeviceOperationSnapshot {
    if (this.authorityRevokedReason) throw new Error(this.authorityRevokedReason);
    const record = this.requireRecord(id);
    const pending = record.pendingConfirmation;
    if (!pending || record.state !== "awaiting-confirmation") throw new Error("This operation is not awaiting confirmation.");
    if (pending.confirmation.id !== confirmationId || !sameBinding(pending.confirmation.binding, binding)) {
      throw new Error("This confirmation no longer matches the operation risk.");
    }
    if (pending.confirmation.binding.protectedOverride && typedOverride !== pending.confirmation.binding.protectedOverride) {
      throw new Error("Type the exact protected-target override shown in the panel.");
    }
    record.pendingConfirmation = undefined;
    record.confirmation = undefined;
    record.state = "running";
    record.updatedAt = Date.now();
    this.emit(record, { type: "state", state: record.state });
    pending.resolve();
    return frozenSnapshot(record);
  }

  private requireRecord(id: string): OperationRecord {
    const record = this.records.get(id);
    if (!record || record.sessionId !== this.sessionId) throw new Error("Unknown device operation.");
    return record;
  }

  private emit(record: OperationRecord, event: Omit<OperationEvent, "sequence" | "at">): void {
    const emitted: OperationEvent = { ...event, sequence: ++record.sequence, at: Date.now() };
    record.events.push(emitted);
    if (record.events.length > MAX_OPERATION_EVENTS) record.events.splice(0, record.events.length - MAX_OPERATION_EVENTS);
    record.updatedAt = emitted.at;
    const snapshot = frozenSnapshot(record);
    for (const listener of this.listeners) {
      try {
        listener(snapshot, cloneEvent(emitted));
      } catch {
        // A page subscriber must never terminate a flashing operation.
      }
    }
  }

   private setState(record: OperationRecord, state: OperationState, error?: string): void {
     if (isTerminal(record.state)) return;
     record.state = state;
     record.error = error;
     record.updatedAt = Date.now();
     this.emit(record, { type: state === "succeeded" || state === "failed" || state === "cancelled" ? "completed" : "state", state, error });
    if (isTerminal(state)) this.pruneRecords();
   }

  private pruneRecords(): void {
    while (this.records.size > MAX_OPERATION_RECORDS) {
      const terminal = [...this.records.values()].find((record) => isTerminal(record.state));
      if (!terminal) return;
      this.records.delete(terminal.id);
    }
  }

  private reportProgress(record: OperationRecord, progress: HardwareProgress): void {
    if (isTerminal(record.state) || record.controller.signal.aborted) return;
    if (!progress.phase.trim()) throw new Error("Hardware progress needs a phase.");
    validFiniteInteger(progress.completed, "progress.completed");
    validFiniteInteger(progress.total, "progress.total", 1);
    if (progress.completed !== undefined && progress.total !== undefined && progress.completed > progress.total) {
      throw new Error("progress.completed cannot exceed progress.total.");
    }
    record.progress = { ...progress, at: Date.now() };
    this.emit(record, { type: "progress", progress: record.progress });
  }

  private addOutput(record: OperationRecord, line: string, kind: "terminal" | "log" = "log"): void {
    const clipped = line.length > MAX_MONITOR_LINE_CHARS
      ? `${line.slice(0, MAX_MONITOR_LINE_CHARS)} …[line truncated]`
      : line;
    const output: OperationOutput = { at: Date.now(), line: clipped, kind };
    record.output.push(output);
    record.outputChars += clipped.length;
    while (record.output.length > MAX_OPERATION_OUTPUT_LINES || record.outputChars > MAX_OPERATION_OUTPUT_CHARS) {
      const removed = record.output.shift();
      if (!removed) break;
      record.outputChars -= removed.line.length;
    }
    this.emit(record, { type: "output", output });
  }

  /**
   * `adb wait-for-device`: the device may not be attached yet (it is rebooting or
   * re-enumerating), so acquiring its lease is retried until the wait window
   * ends. The window starts here and is handed to the flasher as its deadline, so
   * one deadline covers acquisition, authentication and every reacquisition. Each
   * acquisition is itself bounded by that deadline and by Cancel (a provider can take
   * as long as it likes to open a device), and a lease that arrives after the wait gave
   * up is released. Cancelling ends a poll at once and no new acquisition begins afterwards.
   * Every other operation fails at once when the device is missing.
   */
  private async acquireLeaseForRun(record: OperationRecord): Promise<HardwareTransportLease> {
    const wait = adbWaitOptions(record.request);
    if (!wait) return this.acquireLease(record);
    const deadline = Date.now() + wait.timeoutMs;
    record.waitDeadline = deadline;
    let announced = false;
    for (;;) {
      if (record.controller.signal.aborted) throw new DOMException("Operation cancelled.", "AbortError");
      try {
        return await awaitLease(this.acquireLease(record), record.controller.signal, deadline, "its USB connection was still being opened when the wait ended");
      } catch (error) {
        if (record.controller.signal.aborted) throw new DOMException("Operation cancelled.", "AbortError");
        const remaining = deadline - Date.now();
        if (error instanceof LeaseDeadlineError || remaining <= 0) throw new Error(`The device did not become available within ${wait.timeoutMs / 1000} s: ${errorMessage(error)}`);
        if (!announced) {
          announced = true;
          this.reportProgress(record, { phase: "waiting", message: "Waiting for the device to appear." });
        }
        await pause(Math.min(wait.pollMs, remaining), record.controller.signal);
      }
    }
  }

  private async run(record: OperationRecord): Promise<void> {
    let completed = false;
    try {
      const input = await this.resolveInput(record);
      if (record.controller.signal.aborted) throw new DOMException("Operation cancelled.", "AbortError");
      this.reportProgress(record, { phase: "acquiring", message: "Acquiring exclusive hardware lease" });
      record.lease = await this.acquireLeaseForRun(record);
      record.identity = record.lease.identity;
      if (record.controller.signal.aborted) throw new DOMException("Operation cancelled.", "AbortError");
      record.state = "running";
      this.emit(record, { type: "state", state: record.state });
      const result = await this.runFlasher(record, record.lease.transport, input);
      if (record.controller.signal.aborted) throw new DOMException("Operation cancelled.", "AbortError");
      record.result = cloneResult(result);
      completed = true;
    } catch (error) {
      if (record.controller.signal.aborted || isAbort(error)) {
        this.setState(record, "cancelled");
      } else {
        this.setState(record, "failed", errorMessage(error));
      }
    } finally {
      await record.writeChain.catch(() => undefined);
      const lease = record.lease;
      record.lease = undefined;
      if (lease) {
        try {
          await lease.release();
        } catch (error) {
          if (!isTerminal(record.state)) {
            record.result = undefined;
            this.setState(record, "failed", `Could not release exclusive hardware lease: ${errorMessage(error)}`);
          }
        }
      }
    }
    if (completed && record.controller.signal.aborted) this.setState(record, "cancelled");
    else if (completed && record.state === "running") this.setState(record, "succeeded");
  }

  private async resolveInput(record: OperationRecord): Promise<Blob | undefined> {
    const { fileId, sha256: expectedSha256 } = record.request;
    if (!fileId) return undefined;
    this.reportProgress(record, { phase: "verifying-input", message: "Verifying session artifact digest" });
    const input = await this.artifacts.getInput(this.sessionId, fileId);
    if (!input) throw new Error("The selected session artifact is no longer available.");
    const actualSha256 = await sha256(input);
    if (actualSha256 !== expectedSha256?.toLowerCase()) {
      throw new Error("The selected artifact changed after this operation was requested.");
    }
    return input;
  }

  private async runFlasher(record: OperationRecord, transport: HardwareTransport, input: Blob | undefined): Promise<HardwareResult> {
    const flasher = this.flashers.get(record.request.protocol);
    if (!flasher) throw new Error(`No ${record.request.protocol} flasher is available in this browser.`);
    if (!flasher.actions.includes(record.request.action)) {
      throw new Error(`${record.request.protocol} does not support ${record.request.action}.`);
    }
    const context: HardwareContext = {
      transport,
      signal: record.controller.signal,
      progress: (progress) => this.reportProgress(record, progress),
      shellAccess: () => !record.controller.signal.aborted && (record.origin === "user" || this.hasShellAccess(record.request.deviceId)),
      output: (text) => this.addOutput(record, text, record.request.action === "monitor" ? "terminal" : "log"),
      setTerminalInput: (send) => { record.terminalInput = send; },
      input,
      save: (name, data) => this.artifacts.save(this.sessionId, name, data),
      saveStream: (name, chunks) => {
        if (!this.artifacts.saveStream) throw new Error("Streaming artifact storage is unavailable.");
        return this.artifacts.saveStream(this.sessionId, name, chunks, record.controller.signal);
      },
      confirm: (risk) => this.awaitHumanConfirmation(record, risk),
      operation: { id: record.id, deviceId: record.request.deviceId },
      tunnels: this.transportProvider.tunnels,
      ...(record.waitDeadline === undefined ? {} : { deadline: record.waitDeadline }),
      expectDeviceRestart: (windowMs) => this.expectDeviceRestart(record, windowMs),
    };
    context.reacquireTransport = async (options): Promise<HardwareTransport> => this.reacquireTransport(record, context, options);
    return flasher.run(record.request, context);
  }

  /** Opens, and returns the closer of, the window in which this operation's device leaving the bus is expected. */
  private expectDeviceRestart(record: OperationRecord, windowMs: number): () => void {
    const window: RestartWindow = { expiresAt: Date.now() + windowMs, disconnected: false };
    record.restart = window;
    return () => {
      if (record.restart === window) record.restart = undefined;
    };
  }

  /**
   * A protocol may ask for a new lease only after it has established an exact
   * safe resume point. This releases the old lease first and never replays a
   * command or write whose acknowledgement was lost. It does not need a current
   * lease: a reacquisition that failed leaves none, and the identity captured
   * with the first lease says which device the next attempt is for.
   */
  private async reacquireTransport(record: OperationRecord, context: HardwareContext, options: { deadline?: number } = {}): Promise<HardwareTransport> {
    if (record.state !== "running" || record.controller.signal.aborted) {
      throw new DOMException("Operation is not running.", "AbortError");
    }
    const identity = record.identity;
    const reacquire = this.transportProvider.reacquireHardwareTransport;
    if (record.request.protocol === "adb" && (!identity || !reacquire)) {
      throw new Error("ADB reconnect requires a stable granted-device identity.");
    }
    // A device restarting its own daemon leaves the bus a moment after it is told to.
    // Taking the handle that is still attached would authenticate against the dying
    // daemon, so wait to see it leave - for a bounded time, since some devices restart
    // adbd without re-enumerating.
    const restart = record.restart;
    if (restart && !restart.disconnected) {
      const until = Math.min(restart.expiresAt, Date.now() + RESTART_DISCONNECT_GRACE_MS);
      while (!restart.disconnected && Date.now() < until) await pause(25, record.controller.signal);
    }
    const previous = record.lease;
    record.lease = undefined;
    await previous?.release();
    this.reportProgress(record, { phase: "reacquiring", message: "Reacquiring exclusive hardware lease" });
    const requested = {
      interfaceNumber: record.request.interfaceNumber,
      alternateSetting: record.request.alternateSetting,
    };
    const acquisition = record.request.protocol === "adb"
      ? reacquire!.call(this.transportProvider, record.request.deviceId, identity!, {
        ...requested,
        signal: record.controller.signal,
        ...(options.deadline === undefined ? {} : { timeoutMs: Math.max(1, options.deadline - Date.now()) }),
      })
      : this.transportProvider.borrowHardwareTransport(record.request.deviceId, requested);
    // A provider's own limit does not cover opening the device, so the caller's deadline (and Cancel) is enforced here as a backstop.
    const replacement = await awaitLease(acquisition, record.controller.signal, options.deadline === undefined ? undefined : options.deadline + PROVIDER_TIMEOUT_GRACE_MS, "the device was still being opened when the deadline passed");
    if (record.controller.signal.aborted) {
      await replacement.release();
      throw new DOMException("Operation cancelled.", "AbortError");
    }
    record.lease = replacement;
    context.transport = replacement.transport;
    return replacement.transport;
  }

  private async awaitHumanConfirmation(record: OperationRecord, risk: HardwareRisk): Promise<void> {
    if (record.controller.signal.aborted) throw new DOMException("Operation cancelled.", "AbortError");
    const binding = this.bindRisk(record, risk);
    if (record.pendingConfirmation) throw new Error("A confirmation is already pending for this operation.");
    const confirmation: OperationConfirmation = {
      id: randomId("device-confirmation"),
      binding,
      requestedAt: Date.now(),
    };
    record.confirmation = confirmation;
    record.state = "awaiting-confirmation";
    record.updatedAt = confirmation.requestedAt;
    const approved = new Promise<void>((resolve, reject) => {
      record.pendingConfirmation = { confirmation, resolve, reject };
    });
    this.emit(record, { type: "confirmation", confirmation });
    await approved;
  }

  private bindRisk(record: OperationRecord, risk: HardwareRisk): OperationRiskBinding {
    const request = record.request;
    if (!risk.action.trim() || !risk.target.trim() || !risk.backup.trim()) {
      throw new Error("A hardware risk needs an action, target, and backup status.");
    }
    if (risk.details !== undefined && risk.details.length > 8 * 1024) throw new Error("Confirmation details are too large.");
    if (request.target !== undefined && risk.target !== request.target) throw new Error("The confirmation target differs from the requested target.");
    if (request.offset !== undefined && risk.offset !== request.offset) throw new Error("The confirmation payload offset differs from the requested offset.");
    if (request.length !== undefined && risk.length !== request.length) throw new Error("The confirmation payload length differs from the requested length.");
    const requestedSha256 = request.sha256?.toLowerCase();
    const payloadSha256 = risk.sha256?.toLowerCase() ?? requestedSha256;
    if (requestedSha256 && payloadSha256 !== requestedSha256) throw new Error("The confirmation payload digest differs from the verified artifact.");
    const footprint = [risk.programSha256, risk.programOffset, risk.programLength];
    if (footprint.some((value) => value !== undefined) && footprint.some((value) => value === undefined)) {
      throw new Error("A widened program footprint requires its image digest, offset, and length.");
    }
    if (risk.programSha256 && !/^[a-f0-9]{64}$/i.test(risk.programSha256)) throw new Error("Program image digest must be SHA-256.");
    validFiniteInteger(risk.programOffset, "programOffset");
    validFiniteInteger(risk.programLength, "programLength", 1);
    if (risk.programOffset !== undefined && risk.offset !== undefined && risk.length !== undefined) {
      if (risk.programOffset > risk.offset || risk.programOffset + risk.programLength! < risk.offset + risk.length) {
        throw new Error("The program footprint must contain the exact requested payload range.");
      }
    }
    return {
      action: risk.action,
      target: risk.target,
      sha256: payloadSha256,
      offset: risk.offset,
      length: risk.length,
      programSha256: risk.programSha256?.toLowerCase(),
      programOffset: risk.programOffset,
      programLength: risk.programLength,
      details: risk.details,
      protectedOverride: risk.protectedOverride,
      backup: risk.backup,
    };
  }


}

function sameBinding(left: OperationRiskBinding, right: OperationRiskBinding): boolean {
  return left.action === right.action
    && left.target === right.target
    && left.sha256 === right.sha256
    && left.offset === right.offset
    && left.length === right.length
    && left.programSha256 === right.programSha256
    && left.programOffset === right.programOffset
    && left.programLength === right.programLength
    && left.details === right.details
    && left.protectedOverride === right.protectedOverride
    && left.backup === right.backup;
}

/** Server-to-page commands. id settles the command; operationId owns the durable run. */
export type PageOperationCommand =
  | { type: "operation.start"; id: string; operationId: string; request: DeviceOperationRequest }
  | { type: "operation.cancel"; id: string; operationId: string }
  | { type: "operation.send"; id: string; operationId: string; text: string }
  | { type: "operation.status"; id: string; operationId?: string };

export interface PageOperationProgressFrame {
  type: "operation.progress";
  operationId: string;
  snapshot: DeviceOperationSnapshot;
  event: OperationEvent;
}

export interface PageOperationSnapshotFrame {
  type: "operation.snapshot";
  operationId: string;
  snapshot: DeviceOperationSnapshot;
}

export interface PageOperationResultFrame {
  type: "operation.result";
  operationId: string;
  snapshot: DeviceOperationSnapshot;
}

/** Connection methods the page runner needs; the bridge retains ownership of browser handles. */
export interface PageOperationBridge extends HardwareTransportProvider {
  sendOperationProgress(frame: PageOperationProgressFrame): void;
  sendOperationSnapshot(frame: PageOperationSnapshotFrame): void;
  sendOperationResult(frame: PageOperationResultFrame): void;
}

export interface PageOperationDelegate {
  readonly manager: DeviceOperationManager;
  start(frame: Extract<PageOperationCommand, { type: "operation.start" }>, bridge: PageOperationBridge): Promise<void>;
  cancel(frame: Extract<PageOperationCommand, { type: "operation.cancel" }>, bridge: PageOperationBridge): Promise<void>;
  send(frame: Extract<PageOperationCommand, { type: "operation.send" }>, bridge: PageOperationBridge): Promise<void>;
  status(frame: Extract<PageOperationCommand, { type: "operation.status" }>, bridge: PageOperationBridge): Promise<void>;
  snapshot(bridge: PageOperationBridge): void;
}

/**
 * Connects the durable page runner to a persistent browser bridge. An event is
 * emitted only when it happens; reconnect is explicit snapshot, so device
 * writes are never replayed merely because a websocket reattached.
 */
export function createPageOperationDelegate(
  sessionId: string,
  transportProvider: HardwareTransportProvider,
  artifacts: OperationArtifacts,
  flashers: readonly Flasher[] = [],
): PageOperationDelegate {
  const manager = new DeviceOperationManager(sessionId, transportProvider, artifacts, flashers);
  let activeBridge: PageOperationBridge | undefined;
  const pending = new Map<string, { snapshot: DeviceOperationSnapshot; event: OperationEvent }>();
  const phases = new Map<string, string>();
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = (snapshot: DeviceOperationSnapshot, event: OperationEvent): void => {
    activeBridge?.sendOperationProgress({ type: "operation.progress", operationId: snapshot.id, snapshot, event });
  };
  const flush = (): void => {
    publishTimer = undefined;
    for (const { snapshot, event } of pending.values()) publish(snapshot, event);
    pending.clear();
  };
  manager.subscribe((snapshot, event) => {
    if (!activeBridge) return;
    if (event.type === "completed") {
      flush();
      activeBridge.sendOperationResult({ type: "operation.result", operationId: snapshot.id, snapshot });
      return;
    }
    if (event.type === "started") {
      activeBridge.sendOperationSnapshot({ type: "operation.snapshot", operationId: snapshot.id, snapshot });
      return;
    }
    const phaseChanged = event.type === "progress" && event.progress && phases.get(snapshot.id) !== event.progress.phase;
    if (event.progress) phases.set(snapshot.id, event.progress.phase);
    if (event.type === "confirmation" || event.type === "state" || phaseChanged) {
      pending.delete(snapshot.id);
      publish(snapshot, event);
      return;
    }
    pending.set(snapshot.id, { snapshot, event });
    if (!publishTimer) publishTimer = setTimeout(flush, PROGRESS_PUBLISH_MS);
  });
  return {
    manager,
    async start(frame, bridge): Promise<void> {
      activeBridge = bridge;
      manager.start(frame.request, frame.operationId);
    },
    async cancel(frame, bridge): Promise<void> {
      activeBridge = bridge;
      manager.cancel(frame.operationId);
    },
    async send(frame, bridge): Promise<void> {
      activeBridge = bridge;
      await manager.send(frame.operationId, frame.text);
    },
    async status(frame, bridge): Promise<void> {
      activeBridge = bridge;
      if (frame.operationId) {
        const snapshot = manager.status(frame.operationId);
        if (!snapshot) throw new Error("Unknown device operation.");
        bridge.sendOperationSnapshot({ type: "operation.snapshot", operationId: snapshot.id, snapshot });
        return;
      }
      for (const snapshot of manager.snapshots()) {
        bridge.sendOperationSnapshot({ type: "operation.snapshot", operationId: snapshot.id, snapshot });
      }
    },
    snapshot(bridge): void {
      activeBridge = bridge;
      for (const snapshot of manager.snapshots()) {
        if (isTerminal(snapshot.state)) {
          bridge.sendOperationResult({ type: "operation.result", operationId: snapshot.id, snapshot });
        } else {
          bridge.sendOperationSnapshot({ type: "operation.snapshot", operationId: snapshot.id, snapshot });
        }
      }
    },
  };
}

/** The one page registry: every shipped protocol implementation is available to a device operation. */
export function createDefaultPageOperationDelegate(
  sessionId: string,
  transportProvider: HardwareTransportProvider,
): PageOperationDelegate {
  return createPageOperationDelegate(sessionId, transportProvider, deviceArtifacts, [
    serialFlasher,
    espFlasher,
    adbFlasher,
    fastbootFlasher,
    geckoFlasher,
    stm32Flasher,
    stk500Flasher,
    dfuFlasher,
    edlFlasher,
  ]);
}
