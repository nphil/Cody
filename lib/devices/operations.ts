import type {
  Flasher,
  HardwareContext,
  HardwareProgress,
  HardwareRequest,
  HardwareResult,
  HardwareRisk,
  HardwareTransport,
} from "./flasher";
import { adbFlasher } from "./adb";
import { deviceArtifacts } from "./artifacts";
import { dfuFlasher } from "./dfu";
import { espFlasher } from "./esp";
import { fastbootFlasher } from "./fastboot";
import { geckoFlasher } from "./gecko";
import { stm32Flasher } from "./stm32";
import { stk500Flasher } from "./stk500";

/**
 * Browser-owned artifacts. A runner receives bytes only through this session
 * boundary; it never fetches a URL or opens a server path on an agent's behalf.
 */
export interface OperationArtifacts {
  getInput(sessionId: string, fileId: string): Promise<Blob | undefined>;
  save(sessionId: string, name: string, data: Blob): Promise<string>;
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
  reacquireHardwareTransport?(
    deviceId: string,
    identity: string,
    options: { interfaceNumber?: number; alternateSetting?: number; signal: AbortSignal },
  ): Promise<HardwareTransportLease>;
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
const textEncoder = new TextEncoder();
interface PendingConfirmation {
  confirmation: OperationConfirmation;
  resolve(): void;
  reject(reason: Error): void;
}

interface OperationRecord {
  id: string;
  sessionId: string;
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

function validateRequest(request: DeviceOperationRequest): void {
  if (!request.deviceId.trim()) throw new Error("A device id is required.");
  if (!request.protocol) throw new Error("A protocol is required.");
  if (!request.action) throw new Error("An action is required.");
  if (request.target !== undefined && request.target.length === 0) throw new Error("A target must not be empty.");
  if (request.fileId !== undefined && !request.fileId.trim()) throw new Error("A file id must not be empty.");
  if (request.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(request.sha256)) {
    throw new Error("sha256 must be a 64-character hexadecimal digest.");
  }
  if (Boolean(request.fileId) !== Boolean(request.sha256)) throw new Error("An input file and its SHA-256 digest must be supplied together.");
  if ((request.action === "flash" || request.action === "push") && !request.fileId) {
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

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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

  constructor(
    sessionId: string,
    transportProvider: HardwareTransportProvider,
    artifacts: OperationArtifacts,
    flashers: readonly Flasher[] = [],
  ) {
    this.sessionId = sessionId;
    this.transportProvider = transportProvider;
    this.artifacts = artifacts;
    for (const flasher of flashers) this.registerFlasher(flasher);
  }

  registerFlasher(flasher: Flasher): void {
    if (this.flashers.has(flasher.protocol)) throw new Error(`A ${flasher.protocol} flasher is already registered.`);
    this.flashers.set(flasher.protocol, flasher);
  }

  subscribe(listener: (snapshot: DeviceOperationSnapshot, event: OperationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(request: DeviceOperationRequest, operationId = randomId("device-operation")): OperationStartResult {
    if (this.authorityRevokedReason) throw new Error(this.authorityRevokedReason);
    validateRequest(request);
    if (!operationId.trim()) throw new Error("An operation id is required.");
    if (this.records.has(operationId)) throw new Error("That operation id already exists.");
    const now = Date.now();
    const record: OperationRecord = {
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
    void this.run(record);
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

  /**
   * Live monitor input only. There is deliberately no retry or stored queue:
   * a returned success means this exact write reached the borrowed transport.
   */
  async send(id: string, text: string): Promise<DeviceOperationSnapshot> {
    if (this.authorityRevokedReason) throw new Error(this.authorityRevokedReason);
    const record = this.requireRecord(id);
    if (record.request.action !== "monitor") throw new Error("Only monitor operations accept interactive input.");
    if (record.state !== "running" || record.controller.signal.aborted || !record.lease) {
      throw new Error("The monitor is not accepting input.");
    }
    if (!text.length) throw new Error("Monitor input must not be empty.");
    const generation = record.writeGeneration;
    const bytes = textEncoder.encode(text);
    record.writeChain = record.writeChain.catch(() => undefined).then(async () => {
      if (record.writeGeneration !== generation || record.state !== "running" || record.controller.signal.aborted || !record.lease) {
        throw new DOMException("Monitor input was cancelled before it was sent.", "AbortError");
      }
      await record.lease.transport.write(bytes, record.controller.signal);
      this.addOutput(record, `> sent ${bytes.byteLength} byte${bytes.byteLength === 1 ? "" : "s"}`);
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
  confirm(id: string, confirmationId: string, binding: OperationRiskBinding): DeviceOperationSnapshot {
    if (this.authorityRevokedReason) throw new Error(this.authorityRevokedReason);
    const record = this.requireRecord(id);
    const pending = record.pendingConfirmation;
    if (!pending || record.state !== "awaiting-confirmation") throw new Error("This operation is not awaiting confirmation.");
    if (pending.confirmation.id !== confirmationId || !sameBinding(pending.confirmation.binding, binding)) {
      throw new Error("This confirmation no longer matches the operation risk.");
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

  private addOutput(record: OperationRecord, line: string): void {
    const clipped = line.length > MAX_MONITOR_LINE_CHARS
      ? `${line.slice(0, MAX_MONITOR_LINE_CHARS)} …[line truncated]`
      : line;
    const output: OperationOutput = { at: Date.now(), line: clipped };
    record.output.push(output);
    record.outputChars += clipped.length;
    while (record.output.length > MAX_OPERATION_OUTPUT_LINES || record.outputChars > MAX_OPERATION_OUTPUT_CHARS) {
      const removed = record.output.shift();
      if (!removed) break;
      record.outputChars -= removed.line.length;
    }
    this.emit(record, { type: "output", output });
  }

  private async run(record: OperationRecord): Promise<void> {
    let completed = false;
    try {
      const input = await this.resolveInput(record);
      if (record.controller.signal.aborted) throw new DOMException("Operation cancelled.", "AbortError");
      this.reportProgress(record, { phase: "acquiring", message: "Acquiring exclusive hardware lease" });
      record.lease = await this.transportProvider.borrowHardwareTransport(record.request.deviceId, {
        interfaceNumber: record.request.interfaceNumber,
        alternateSetting: record.request.alternateSetting,
      });
      if (record.controller.signal.aborted) throw new DOMException("Operation cancelled.", "AbortError");
      record.state = "running";
      this.emit(record, { type: "state", state: record.state });
      const result = record.request.action === "monitor"
        ? await this.runSerialMonitor(record, record.lease.transport)
        : await this.runFlasher(record, record.lease.transport, input);
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
      input,
      save: (name, data) => this.artifacts.save(this.sessionId, name, data),
      confirm: (risk) => this.awaitHumanConfirmation(record, risk),
    };
    context.reacquireTransport = async (): Promise<HardwareTransport> => this.reacquireTransport(record, context);
    return flasher.run(record.request, context);
  }

  /**
   * A protocol may ask for a new lease only after it has established an exact
   * safe resume point. This releases the old lease first and never replays a
   * command or write whose acknowledgement was lost.
   */
  private async reacquireTransport(record: OperationRecord, context: HardwareContext): Promise<HardwareTransport> {
    if (record.state !== "running" || record.controller.signal.aborted) {
      throw new DOMException("Operation is not running.", "AbortError");
    }
   const previous = record.lease;
   if (!previous) throw new Error("The exclusive hardware lease is unavailable.");
  const reacquire = this.transportProvider.reacquireHardwareTransport;
  if (record.request.protocol === "adb" && (!previous.identity || !reacquire)) {
    throw new Error("ADB reconnect requires a stable granted-device identity.");
  }
   record.lease = undefined;
   await previous.release();
   this.reportProgress(record, { phase: "reacquiring", message: "Reacquiring exclusive hardware lease" });
  const options = {
     interfaceNumber: record.request.interfaceNumber,
     alternateSetting: record.request.alternateSetting,
  };
  const replacement = record.request.protocol === "adb"
    ? await reacquire!(record.request.deviceId, previous.identity!, { ...options, signal: record.controller.signal })
    : await this.transportProvider.borrowHardwareTransport(record.request.deviceId, options);
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

  private async runSerialMonitor(record: OperationRecord, transport: HardwareTransport): Promise<HardwareResult> {
    if (transport.kind !== "serial") throw new Error("Monitor requires a serial transport.");
    if (record.request.baudRate !== undefined) {
      if (!transport.setBaudRate) throw new Error("This serial transport cannot change its baud rate.");
      await transport.setBaudRate(record.request.baudRate);
    }
    this.reportProgress(record, { phase: "monitoring", message: "Serial monitor connected" });
    const decoder = new TextDecoder();
    let partial = "";
    while (!record.controller.signal.aborted) {
      const bytes = await transport.read(4096, 1_000, record.controller.signal);
      if (!bytes) continue;
      partial = this.consumeMonitorText(record, partial, decoder.decode(bytes, { stream: true }));
    }
    const finalText = partial + decoder.decode();
    if (finalText) this.addOutput(record, finalText);
    throw new DOMException("Operation cancelled.", "AbortError");
  }

  private consumeMonitorText(record: OperationRecord, partial: string, text: string): string {
    let pending = partial + text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) this.addOutput(record, line);
    if (pending.length > MAX_MONITOR_LINE_CHARS) {
      this.addOutput(record, pending.slice(0, MAX_MONITOR_LINE_CHARS));
      return pending.slice(MAX_MONITOR_LINE_CHARS);
    }
    return pending;
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
    espFlasher,
    adbFlasher,
    fastbootFlasher,
    geckoFlasher,
    stm32Flasher,
    stk500Flasher,
    dfuFlasher,
  ]);
}
