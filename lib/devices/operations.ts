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
import type { ArtifactProvenance } from "./artifact-model";
import { adbFlasher, adbWaitOptions } from "./adb";
import { pause } from "./pause";
import { MAX_SEND_DELAY_SECONDS } from "./protocol";
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
import {
  MemoryTrustBook,
  TRUST_WITHDRAWN_REASON,
  actionNeedsTrust,
  declinedMessage,
  type DeviceTrustAnswer,
  type DeviceTrustAnswerResult,
  type DeviceTrustBook,
  type DeviceTrustLevel,
  type DeviceTrustRequest,
  type DeviceTrustSubject,
  type TrustedDevice,
} from "./trust";
import { pageTrustBook } from "./trust-client";

/**
 * Browser-owned artifacts. A runner receives bytes only through this session
 * boundary; it never fetches a URL or opens a server path on an agent's behalf.
 */
export interface OperationArtifacts {
  getInput(sessionId: string, fileId: string): Promise<Blob | undefined>;
  /** `provenance` says which operation made the file, so the panel can group a backup's files into one set. */
  save(sessionId: string, name: string, data: Blob, provenance?: ArtifactProvenance): Promise<string>;
  saveStream?(sessionId: string, name: string, chunks: AsyncIterable<Uint8Array>, signal: AbortSignal, provenance?: ArtifactProvenance): Promise<StreamArtifact>;
  /** A file of this session by its SHA-256, for a job (a backup-set restore) that names its parts by digest. */
  findBySha256?(sessionId: string, sha256: string): Promise<Blob | undefined>;
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
  /**
   * The stable identity the granted device `deviceId` is attached under right now, or undefined when it is not
   * attached or has none. A countdown asks this at the moment of sending: a device that is not the one the person
   * was looking at receives nothing.
   */
  currentIdentity?(deviceId: string): string | undefined;
  /**
   * What the person calls the granted device `deviceId`, and the key its trust can be remembered under when it has
   * a stable USB identity (see ./trust.ts). Without it a device is called by its id and is trusted only until it
   * disconnects.
   */
  describeDevice?(deviceId: string): DeviceTrustSubject | undefined;
  /** Browser-to-server relay for ADB port forwarding, when this page has one. */
  readonly tunnels?: TunnelChannel;
 }

/** The request carries no authority: the agent's control of a device is the person's trust (./trust.ts), given in the chat. */
export interface DeviceOperationRequest extends HardwareRequest {
  deviceId: string;
  interfaceNumber?: number;
  alternateSetting?: number;
}

export type OperationState =
  | "starting"
  | "running"
  | "awaiting-trust"
  | "countdown"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface OperationProgress extends HardwareProgress {
  at: number;
}

/** What an operation declares it is about to send: the exact target, range and digest. Shown while it counts down and kept in its log. */
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
  backup: string;
}

/**
 * The wait the request asked for (`options.sendDelaySeconds`) between the operation being ready to send and sending,
 * counted down where the person can see it and cancel it. It is not an approval: the person's trust was given before
 * the operation began.
 */
export interface OperationCountdown {
  startedAt: number;
  /** When the command is sent. */
  releaseAt: number;
  /** What is about to be sent. */
  binding: OperationRiskBinding;
}

export interface OperationOutput {
  at: number;
  line: string;
  kind: "terminal" | "log";
}

export interface OperationEvent {
  sequence: number;
  at: number;
  type: "started" | "progress" | "output" | "declared" | "state" | "completed";
  progress?: OperationProgress;
  output?: OperationOutput;
  /** The risk an operation declared (type `declared`). */
  declared?: OperationRiskBinding;
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
  /** Set from the moment the operation starts counting down until the command is sent. */
  countdown?: OperationCountdown;
  /** True once this operation declared a risk to the device: it is not a routine, read-only operation. */
  riskDeclared?: boolean;
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
/**
 * How late a countdown may fire (a throttled background tab, a page that was busy) before it is considered stale and
 * nothing is sent. A page that slept through its countdown must not send a command the person was waiting to time.
 */
export const COUNTDOWN_SLACK_MS = 10_000;
const textEncoder = new TextEncoder();
/** What an agent hears when it types into a terminal whose device it is no longer trusted with. */
const AGENT_INPUT_REFUSED = "The agent's control of this device is no longer allowed, so it cannot type into this terminal.";

/** One operation waiting behind a trust question. */
interface TrustWaiter {
  resolve(): void;
  reject(reason: Error): void;
}

/** The one open trust question for a device, and the operations queued behind it. */
interface PendingTrust {
  request: DeviceTrustRequest;
  subject: DeviceTrustSubject;
  waiters: Set<TrustWaiter>;
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
  /** The wait the request asked for. It runs once, before the first command goes out. */
  sendDelaySeconds?: number;
  /** Set from the moment the operation starts counting down until the command is sent. */
  countdown?: OperationCountdown;
  /** True once this operation declared a risk to the device. */
  riskDeclared: boolean;
  /** True once the operation may touch the device: the person's trust covers it, or it needs none. */
  cleared: boolean;
  /** Why the system (not the person or the agent) cancelled this: shown instead of a bare "cancelled". */
  cancelReason?: string;
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

function cloneCountdown(countdown: OperationCountdown): OperationCountdown {
  return { ...countdown, binding: cloneRiskBinding(countdown.binding) };
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
    declared: event.declared ? cloneRiskBinding(event.declared) : undefined,
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
    countdown: record.countdown ? cloneCountdown(record.countdown) : undefined,
    riskDeclared: record.riskDeclared ? true : undefined,
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

/** A whole number of seconds a command may be held before it is sent: `minimum` up to the shared maximum. */
function validSendDelay(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= MAX_SEND_DELAY_SECONDS;
}

/**
 * The wait before sending belongs to the manager, never to a flasher: several flashers refuse option keys they do
 * not know, and a protocol must not be able to read or move the clock a countdown runs on.
 */
function splitScheduling(request: DeviceOperationRequest): { request: DeviceOperationRequest; sendDelaySeconds?: number } {
  const clone = cloneRequest(request);
  const options = clone.options;
  if (!options || !("sendDelaySeconds" in options)) return { request: clone };
  const { sendDelaySeconds, ...rest } = options;
  clone.options = Object.keys(rest).length > 0 ? rest : undefined;
  return { request: clone, sendDelaySeconds: sendDelaySeconds as number };
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
  const sendDelay = request.options?.sendDelaySeconds;
  if (sendDelay !== undefined && !validSendDelay(sendDelay, 1)) {
    throw new Error(`options.sendDelaySeconds must be a whole number of seconds from 1 to ${MAX_SEND_DELAY_SECONDS}.`);
  }
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
  /** Devices the person allowed for this connection only. The trust ends when the device disconnects. */
  private readonly sessionTrusted = new Set<string>();
  /** Devices the person said no to: the agent is refused, with no new question, until the device disconnects. */
  private readonly declined = new Set<string>();
  /** The one open question per device, and the operations queued behind it. */
  private readonly pendingTrust = new Map<string, PendingTrust>();
  private readonly trustListeners = new Set<() => void>();
  private readonly trustBook: DeviceTrustBook;
  private readonly unsubscribeTrustBook: () => void;
  /** The remembered keys as of the last change, to tell which one was just forgotten. */
  private knownTrustedKeys: Set<string>;

  /**
   * The browser reports that the device left the USB bus, or the user
   * disconnected it (`forgotten`). The connection's trust and a refusal both end
   * here (the person is asked afresh after a reconnect, unless they remembered
   * the device), and every operation on the device is cancelled - except one
   * for which the departure is part of what it is doing (see `departureExpected`):
   * an operation that announced it was restarting the device (expectDeviceRestart),
   * and a wait-for-device, which exists to ride out a device that leaves and returns.
   * A device the user disconnected on purpose is never expected back.
   */
  async deviceDisconnected(deviceId: string, cause: "left-bus" | "forgotten" = "left-bus"): Promise<void> {
    const expected = (record: OperationRecord): boolean => cause === "left-bus" && this.departureExpected(record);
    this.sessionTrusted.delete(deviceId);
    this.declined.delete(deviceId);
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
      if (!isTerminal(record.state)) this.cancel(record.id, this.departureReason(record, cause));
      if (record.settled) settling.push(record.settled);
    }
    this.notifyTrust();
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

  /** Why a device leaving cancelled this operation, in the words the person reads where the card used to just vanish. */
  private departureReason(record: OperationRecord, cause: "left-bus" | "forgotten"): string {
    const left = cause === "forgotten" ? "The device was disconnected" : "The device left the USB bus";
    switch (record.state) {
      case "awaiting-trust":
        return `${left} before the question about it was answered, so this was cancelled. Nothing was changed on the device.`;
      case "countdown":
        return `${left} during the countdown, so the command was not sent. Nothing was changed on the device.`;
      case "starting":
        return `${left} before this started, so it was cancelled.`;
      default:
        return `${left}, so this operation was cancelled. Anything already sent to the device cannot be undone.`;
    }
  }

  constructor(
    sessionId: string,
    transportProvider: HardwareTransportProvider,
    artifacts: OperationArtifacts,
    flashers: readonly Flasher[] = [serialFlasher],
    trust: DeviceTrustBook = new MemoryTrustBook(),
  ) {
    this.sessionId = sessionId;
    this.transportProvider = transportProvider;
    this.artifacts = artifacts;
    this.trustBook = trust;
    this.knownTrustedKeys = new Set(trust.list().map((device) => device.key));
    this.unsubscribeTrustBook = trust.subscribe(() => this.trustBookChanged());
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
    const scheduled = splitScheduling(request);
    const now = Date.now();
    const record: OperationRecord = {
      origin,
      id: operationId,
      sessionId: this.sessionId,
      request: scheduled.request,
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
      riskDeclared: false,
      cleared: false,
      ...(scheduled.sendDelaySeconds === undefined ? {} : { sendDelaySeconds: scheduled.sendDelaySeconds }),
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
    this.authorityRevokedReason = reason;
    this.sessionTrusted.clear();
    this.declined.clear();
    this.unsubscribeTrustBook();
    for (const record of this.records.values()) {
      if (!isTerminal(record.state)) this.cancel(record.id, reason);
    }
    this.notifyTrust();
  }

  /**
   * Cancellation never queues an additional device write. `reason` is for a cancellation the system makes (a
   * device left, authority moved): it is kept on the operation so the card says why instead of just "cancelled".
   */
  cancel(id: string, reason?: string): DeviceOperationSnapshot {
    const record = this.requireRecord(id);
    if (isTerminal(record.state)) return frozenSnapshot(record);
    if (record.state !== "cancelling") {
      if (reason) record.cancelReason ??= reason;
      record.state = "cancelling";
      record.updatedAt = Date.now();
      record.writeGeneration += 1;
      record.controller.abort();
      record.countdown = undefined;
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
    if (origin === "agent" && !this.isTrusted(record.request.deviceId)) throw new Error(AGENT_INPUT_REFUSED);
    if (!text.length) throw new Error("Monitor input must not be empty.");
    const generation = record.writeGeneration;
    const bytes = textEncoder.encode(text);
    record.writeChain = record.writeChain.catch(() => undefined).then(async () => {
      if (record.writeGeneration !== generation || record.state !== "running" || record.controller.signal.aborted || !record.lease) {
        throw new DOMException("Monitor input was cancelled before it was sent.", "AbortError");
      }
      if (origin === "agent" && !this.isTrusted(record.request.deviceId)) throw new Error(AGENT_INPUT_REFUSED);
      if (record.terminalInput) await record.terminalInput(bytes);
      else if (record.lease.transport.kind === "serial") await record.lease.transport.write(bytes, record.controller.signal);
      else throw new Error("The terminal is not ready for input.");
      this.addOutput(record, `> ${origin}: ${text}`);
    });
    await record.writeChain;
    return frozenSnapshot(record);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Trust: the one permission per device. The model is described in ./trust.ts.
  // ---------------------------------------------------------------------------------------------------------

  /** The open questions, oldest first: at most one per device, however many operations wait behind it. */
  trustRequests(): readonly DeviceTrustRequest[] {
    return [...this.pendingTrust.values()]
      .map((pending) => ({ ...pending.request }))
      .sort((left, right) => left.requestedAt - right.requestedAt);
  }

  /** How far the person has trusted `deviceId` right now. */
  trustLevel(deviceId: string): DeviceTrustLevel {
    if (this.declined.has(deviceId)) return "declined";
    const key = this.subjectOf(deviceId).key;
    if (key !== undefined && this.trustBook.has(key)) return "remembered";
    return this.sessionTrusted.has(deviceId) ? "session" : "none";
  }

  /** Called when a question opens or closes or a device's trust changes; read `trustRequests()` and `trustLevel()` again. */
  subscribeTrust(listener: () => void): () => void {
    this.trustListeners.add(listener);
    return () => { this.trustListeners.delete(listener); };
  }

  /**
   * The person's answer to one open question. Called only by the chat card's Allow and Deny buttons: neither
   * `start` nor any tool or frame the agent can reach names this method, and `PageOperationCommand` has no
   * variant that could.
   *
   * Allow runs every operation that queued behind the question, in the order they asked. Deny fails them all with
   * `declinedMessage` and refuses the agent, with no new question, until the device disconnects. `remember` is
   * honoured only for a device with a stable USB identity; if it cannot be saved the device stays trusted for this
   * connection and the result says why.
   */
  async answerTrust(requestId: string, answer: DeviceTrustAnswer): Promise<DeviceTrustAnswerResult> {
    if (this.authorityRevokedReason) throw new Error(this.authorityRevokedReason);
    const pending = [...this.pendingTrust.values()].find((candidate) => candidate.request.id === requestId);
    if (!pending) throw new Error("That question was already answered or is no longer waiting.");
    const { deviceId, label } = pending.request;
    const waiters = [...pending.waiters];
    pending.waiters.clear();
    this.pendingTrust.delete(deviceId);
    if (!answer.allow) {
      this.declined.add(deviceId);
      this.notifyTrust();
      const refusal = new Error(declinedMessage(label));
      for (const waiter of waiters) waiter.reject(refusal);
      return { remembered: false };
    }
    this.sessionTrusted.add(deviceId);
    this.notifyTrust();
    for (const waiter of waiters) waiter.resolve();
    const { subject } = pending;
    if (!answer.remember || subject.key === undefined || subject.vendorId === undefined || subject.serialNumber === undefined) return { remembered: false };
    const device: TrustedDevice = {
      key: subject.key,
      label: subject.label,
      vendorId: subject.vendorId,
      ...(subject.productId === undefined ? {} : { productId: subject.productId }),
      serialNumber: subject.serialNumber,
      grantedAt: Date.now(),
    };
    try {
      await this.trustBook.remember(device);
    } catch (error) {
      return { remembered: false, error: errorMessage(error) };
    }
    // The remembered list covers this device from now on; the connection's own grant would outlive a Forget.
    this.sessionTrusted.delete(deviceId);
    this.notifyTrust();
    return { remembered: true };
  }

  /**
   * Withdraws the agent's control of a device: the connection's trust ends, what was remembered for it is
   * forgotten, and what the agent has running on it is cancelled. The next operation asks again.
   */
  async withdrawTrust(deviceId: string): Promise<void> {
    const { key } = this.subjectOf(deviceId);
    this.sessionTrusted.delete(deviceId);
    this.cancelClearedAgentOperations(deviceId);
    this.notifyTrust();
    if (key !== undefined && this.trustBook.has(key)) await this.trustBook.forget(key);
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
      await this.requireTrust(record);
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
        this.setState(record, "cancelled", record.cancelReason);
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
    if (completed && record.controller.signal.aborted) this.setState(record, "cancelled", record.cancelReason);
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
    const provenance = this.provenanceFor(record);
    const context: HardwareContext = {
      transport,
      signal: record.controller.signal,
      progress: (progress) => this.reportProgress(record, progress),
      output: (text) => this.addOutput(record, text, record.request.action === "monitor" ? "terminal" : "log"),
      setTerminalInput: (send) => { record.terminalInput = send; },
      input,
      save: (name, data) => this.artifacts.save(this.sessionId, name, data, provenance),
      saveStream: (name, chunks) => {
        if (!this.artifacts.saveStream) throw new Error("Streaming artifact storage is unavailable.");
        return this.artifacts.saveStream(this.sessionId, name, chunks, record.controller.signal, provenance);
      },
      ...(this.artifacts.findBySha256 ? { findArtifact: (digest: string) => this.artifacts.findBySha256!(this.sessionId, digest) } : {}),
      confirm: (risk) => this.declareRisk(record, risk),
      operation: { id: record.id, deviceId: record.request.deviceId },
      tunnels: this.transportProvider.tunnels,
      ...(record.waitDeadline === undefined ? {} : { deadline: record.waitDeadline }),
      expectDeviceRestart: (windowMs) => this.expectDeviceRestart(record, windowMs),
    };
    context.reacquireTransport = async (options): Promise<HardwareTransport> => this.reacquireTransport(record, context, options);
    return flasher.run(record.request, context);
  }

  /** What every file this operation saves records about where it came from. */
  private provenanceFor(record: OperationRecord): ArtifactProvenance {
    const { request } = record;
    const command = request.command?.trim().split(/\s+/)[0];
    return {
      operationId: record.id,
      deviceId: request.deviceId,
      protocol: request.protocol,
      action: request.action,
      ...(request.target ? { target: request.target } : {}),
      ...(command ? { command } : {}),
      label: this.subjectOf(request.deviceId).label,
    };
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

  // ---------------------------------------------------------------------------------------------------------
  // The trust gate, and what the manager does when a protocol declares a risk.
  // ---------------------------------------------------------------------------------------------------------

  private subjectOf(deviceId: string): DeviceTrustSubject {
    return this.transportProvider.describeDevice?.(deviceId) ?? { label: deviceId };
  }

  private isTrusted(deviceId: string): boolean {
    const level = this.trustLevel(deviceId);
    return level === "remembered" || level === "session";
  }

  private notifyTrust(): void {
    for (const listener of [...this.trustListeners]) {
      try {
        listener();
      } catch {
        // A page subscriber must never break trust bookkeeping.
      }
    }
  }

  /** Cancels one agent operation because the person withdrew its device's trust. Once is enough: it may already be cancelling. */
  private withdrawFrom(record: OperationRecord): void {
    if (record.state === "cancelling") return;
    this.addOutput(record, `${TRUST_WITHDRAWN_REASON} Anything already sent to the device cannot be undone.`);
    this.cancel(record.id, TRUST_WITHDRAWN_REASON);
  }

  /** Cancels the agent's operations that were already allowed to touch `deviceId`; those still waiting for an answer keep waiting. */
  private cancelClearedAgentOperations(deviceId: string): void {
    for (const record of this.records.values()) {
      if (record.request.deviceId === deviceId && record.origin === "agent" && record.cleared && !isTerminal(record.state)) this.withdrawFrom(record);
    }
  }

  /**
   * The remembered list changed - this page forgot a device, or Settings did. What the agent has running on a
   * device the list no longer covers is cancelled; a device the person allowed for this connection keeps its grant.
   */
  private trustBookChanged(): void {
    const current = new Set(this.trustBook.list().map((device) => device.key));
    const forgotten = [...this.knownTrustedKeys].filter((key) => !current.has(key));
    this.knownTrustedKeys = current;
    if (forgotten.length > 0) {
      for (const record of this.records.values()) {
        if (record.origin !== "agent" || !record.cleared || isTerminal(record.state)) continue;
        const { key } = this.subjectOf(record.request.deviceId);
        if (key !== undefined && forgotten.includes(key) && !this.isTrusted(record.request.deviceId)) this.withdrawFrom(record);
      }
    }
    this.notifyTrust();
  }

  /**
   * The trust gate. An agent operation other than read-only detection waits here until the person has trusted the
   * device: no wait when they already have, a refusal when they declined, otherwise one question for the device
   * with this operation queued behind it. The person's own operations are not gated: they are the person.
   */
  private async requireTrust(record: OperationRecord): Promise<void> {
    const { deviceId, action } = record.request;
    if (record.origin === "agent" && actionNeedsTrust(action)) {
      // A device the page does not know has nothing to control: the operation fails on its own at the lease, and the
      // person is not asked about a device that is not there.
      const subject = this.transportProvider.describeDevice ? this.transportProvider.describeDevice(deviceId) : { label: deviceId };
      if (subject) {
        // The remembered list is read from the server when the page starts: never decide on half of it.
        if (subject.key !== undefined) await this.trustBook.ready;
        if (record.controller.signal.aborted) throw new DOMException("Operation cancelled.", "AbortError");
        if (this.declined.has(deviceId)) throw new Error(declinedMessage(subject.label));
        if (!this.isTrusted(deviceId)) await this.askForTrust(record, subject);
      }
    }
    record.cleared = true;
  }

  private async askForTrust(record: OperationRecord, subject: DeviceTrustSubject): Promise<void> {
    const { deviceId } = record.request;
    let queue = this.pendingTrust.get(deviceId);
    if (!queue) {
      queue = {
        request: {
          id: randomId("device-trust"),
          deviceId,
          label: subject.label,
          ...(subject.key === undefined ? {} : { key: subject.key }),
          requestedAt: Date.now(),
          waiting: 0,
        },
        subject,
        waiters: new Set(),
      };
      this.pendingTrust.set(deviceId, queue);
    }
    const open = queue;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter: TrustWaiter = { resolve, reject };
    const cancelled = (): void => {
      this.leaveTrustQueue(open, waiter);
      reject(new DOMException("Operation cancelled.", "AbortError"));
    };
    // Listening comes first: a subscriber that cancels this operation while the state change is announced must be heard.
    record.controller.signal.addEventListener("abort", cancelled, { once: true });
    open.waiters.add(waiter);
    open.request = { ...open.request, waiting: open.waiters.size };
    record.state = "awaiting-trust";
    record.updatedAt = Date.now();
    this.emit(record, { type: "state", state: record.state });
    this.notifyTrust();
    try {
      await promise;
    } finally {
      record.controller.signal.removeEventListener("abort", cancelled);
    }
    if (record.state === "awaiting-trust") {
      record.state = "starting";
      record.updatedAt = Date.now();
      this.emit(record, { type: "state", state: record.state });
    }
  }

  /** An operation stops waiting for the answer (it was cancelled); the question goes with the last one that was waiting. */
  private leaveTrustQueue(queue: PendingTrust, waiter: TrustWaiter): void {
    queue.waiters.delete(waiter);
    const { deviceId } = queue.request;
    if (this.pendingTrust.get(deviceId) === queue) {
      if (queue.waiters.size === 0) this.pendingTrust.delete(deviceId);
      else queue.request = { ...queue.request, waiting: queue.waiters.size };
    }
    this.notifyTrust();
  }

  /**
   * A protocol is about to send something to the device and says exactly what. The manager checks that it is what
   * was requested, writes it to the operation's log, and - once, before the first thing is sent - holds for the
   * countdown the request asked for. Nobody is asked anything here: the person's trust covered the operation before
   * it began.
   */
  private async declareRisk(record: OperationRecord, risk: HardwareRisk): Promise<void> {
    if (record.controller.signal.aborted) throw new DOMException("Operation cancelled.", "AbortError");
    const binding = this.bindRisk(record, risk);
    record.riskDeclared = true;
    this.addOutput(record, `Starting ${binding.action} on ${binding.target}. Backup: ${binding.backup}`);
    this.emit(record, { type: "declared", declared: binding });
    const seconds = record.sendDelaySeconds;
    if (seconds === undefined) return;
    record.sendDelaySeconds = undefined;
    await this.countDown(record, binding, seconds);
  }

  /**
   * The person (or the agent, for the person's benefit) asked for a wait before the command goes out - their hands
   * are on the device's buttons, say. Nothing is sent while this waits, and it can be cancelled at any moment. At
   * the moment of sending it is checked once more - not stale, still the same device, still connected - and a failed
   * check ends the operation with the reason instead of sending.
   */
  private async countDown(record: OperationRecord, binding: OperationRiskBinding, seconds: number): Promise<void> {
    const startedAt = Date.now();
    const countdown: OperationCountdown = { startedAt, releaseAt: startedAt + seconds * 1000, binding: cloneRiskBinding(binding) };
    record.countdown = countdown;
    record.state = "countdown";
    record.updatedAt = startedAt;
    this.emit(record, { type: "state", state: record.state });
    await pause(Math.max(0, countdown.releaseAt - Date.now()), record.controller.signal);
    if (record.controller.signal.aborted) throw new DOMException("Operation cancelled.", "AbortError");
    const refusal = this.refuseRelease(record, countdown);
    record.countdown = undefined;
    if (refusal) throw new Error(refusal);
    record.state = "running";
    record.updatedAt = Date.now();
    this.emit(record, { type: "state", state: record.state });
  }

  private refuseRelease(record: OperationRecord, countdown: OperationCountdown): string | undefined {
    if (Date.now() > countdown.releaseAt + COUNTDOWN_SLACK_MS) {
      return "Not sent: the countdown ran past its end before the command could go out (the page was probably asleep). Nothing was changed on the device; run it again to send it.";
    }
    const lease = record.lease;
    if (!lease) return "Not sent: Cody no longer holds the device connection this was counting down on. Nothing was changed on the device.";
    if (record.identity !== undefined && this.transportProvider.currentIdentity) {
      const current = this.transportProvider.currentIdentity(record.request.deviceId);
      if (current !== record.identity) {
        return `Not sent: this is no longer the device the countdown started on (it was ${record.identity}, now ${current ?? "not attached"}). Nothing was changed on the device.`;
      }
    }
    if (lease.transport.connected && !lease.transport.connected()) {
      return "Not sent: the device left the USB bus during the countdown. Nothing was changed on the device.";
    }
    return undefined;
  }

  private bindRisk(record: OperationRecord, risk: HardwareRisk): OperationRiskBinding {
    const request = record.request;
    if (!risk.action.trim() || !risk.target.trim() || !risk.backup.trim()) {
      throw new Error("A hardware risk needs an action, target, and backup status.");
    }
    if (risk.details !== undefined && risk.details.length > 8 * 1024) throw new Error("The declared risk's details are too large.");
    if (request.target !== undefined && risk.target !== request.target) throw new Error("The declared target differs from the requested target.");
    if (request.offset !== undefined && risk.offset !== request.offset) throw new Error("The declared payload offset differs from the requested offset.");
    if (request.length !== undefined && risk.length !== request.length) throw new Error("The declared payload length differs from the requested length.");
    const requestedSha256 = request.sha256?.toLowerCase();
    const payloadSha256 = risk.sha256?.toLowerCase() ?? requestedSha256;
    if (requestedSha256 && payloadSha256 !== requestedSha256) throw new Error("The declared payload digest differs from the verified artifact.");
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
      backup: risk.backup,
    };
  }
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
  trust?: DeviceTrustBook,
): PageOperationDelegate {
  const manager = new DeviceOperationManager(sessionId, transportProvider, artifacts, flashers, trust);
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
    if (event.type === "declared" || event.type === "state" || phaseChanged) {
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
  ], pageTrustBook());
}
