import { Adb, AdbCommand, AdbDaemonTransport, AdbPacket, AdbPacketSerializeStream, calculateChecksum, type AdbPacketData, type AdbPacketInit, type AdbSocket } from "@yume-chan/adb";
import type { StructDeserializer } from "@yume-chan/struct";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import {
  Consumable,
  ReadableStream as AdbReadableStream,
  StructDeserializeStream,
  TransformStream as AdbTransformStream,
  WritableStream as AdbWritableStream,
} from "@yume-chan/stream-extra";
import type { Flasher, HardwareContext, HardwareRequest, HardwareResult, HardwareTransport } from "./flasher";
import { parseDeviceSpec, parseHostSpec, type DeviceSpec, type ForwardLease, type HostSpec, type ReverseLease, type TunnelChannel, type TunnelConnection } from "./tunnel";
import { hashFirmware, normalizeSha256, sha256Blob } from "./hardware-safety";
import { sideloadAdb } from "./adb-sideload";
import { openZip } from "./zip-archive";
import { pause } from "./pause";

const ADB_PACKET_READ_BYTES = 64 * 1024;
const ADB_PROBE_READ_LIMIT_MS = 20_000;
const ADB_CHUNK_BYTES = 4 * 1024 * 1024;
const STAGING_NAME_PREFIX = ".cody-adb-stage-";
const SHELL_STATUS_PREFIX = "__CODY_ADB_STATUS__";
type WireAdbPacket = AdbPacketData & {
  checksum: number;
  magic: number;
};


export class AdbProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdbProtocolError";
  }
}

/** The packet checksum is supplied by ya-webadb and is intentionally kept here
 * for framing tests and diagnostics instead of maintaining a duplicate encoder. */
export function calculateAdbChecksum(payload: Uint8Array): number {
  return calculateChecksum(payload);
}

/**
 * Adapts Cody's already-exclusive HardwareTransport to ya-webadb's packet
 * streams. It never opens USB, claims an interface, or owns the transport.
 */
export function createAdbHardwareConnection(transport: HardwareTransport, signal: AbortSignal, onInitialProbeFailure?: () => void) { let outputFailure: unknown;
let receivedInboundPacket = false;
  let checksumOptional = false;
  const rawReadable = new AdbReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const chunk = await transport.read(ADB_PACKET_READ_BYTES, ADB_PROBE_READ_LIMIT_MS, signal);
        if (chunk !== null) {
          controller.enqueue(chunk);
          receivedInboundPacket = true;
          return;
        }
        if (!receivedInboundPacket) { onInitialProbeFailure?.(); controller.error(new AdbProtocolError("ADB daemon did not answer the bounded initial protocol probe.")); return; }
      }
    },
  });
const rawWritable = new AdbWritableStream<Uint8Array>({
  write(bytes) {
    return transport.write(bytes, signal);
  },
});
const serializer = new AdbPacketSerializeStream();
void serializer.readable
  .pipeTo(new Consumable.WrapWritableStream(rawWritable))
  .catch((error: unknown) => {
    outputFailure = error;
  });
const serializerWriter = serializer.writable.getWriter();
const writable = new AdbWritableStream<Consumable<AdbPacketInit>>({
  async write(packet) {
    // A failed write rejects both write() and consumed. Observe the duplicate
    // consumed rejection even when the upstream writer exits on write() first.
    void packet.consumed.catch(() => undefined);
    await packet.tryConsume(async (value) => {
      if (outputFailure !== undefined) throw outputFailure;
      const serialized = new Consumable(value);
      await Promise.all([serializerWriter.write(serialized), serialized.consumed]);
      if (outputFailure !== undefined) throw outputFailure;
    });
  },
  close() {
    return serializerWriter.close();
  },
  abort(reason) {
    return serializerWriter.abort(reason);
  },
});

return {
  readable: rawReadable
    .pipeThrough(new StructDeserializeStream<WireAdbPacket>(AdbPacket as unknown as StructDeserializer<WireAdbPacket>))
    .pipeThrough(
      new AdbTransformStream<WireAdbPacket, WireAdbPacket>({
        transform(packet, controller) {
          if (packet.magic !== (packet.command ^ -1)) {
            throw new AdbProtocolError("ADB packet magic does not match its command.");
          }
          if (packet.command === AdbCommand.Connect) {
            checksumOptional = packet.arg0 >= 0x01000001;
          }
          if (!checksumOptional && packet.checksum !== calculateChecksum(packet.payload)) {
            throw new AdbProtocolError("ADB packet checksum does not match its payload.");
          }
          controller.enqueue(packet);
        },
      }),
    ),
  writable,
}; }

let credentialStore: AdbWebCredentialStore | undefined;
const adbSessions = new WeakMap<HardwareTransport, Promise<Adb>>();

export function createCodyAdbCredentialStore(): AdbWebCredentialStore {
  return new AdbWebCredentialStore("Cody");
}

function credentials(): AdbWebCredentialStore {
  credentialStore ??= createCodyAdbCredentialStore();
  return credentialStore;
}

/**
 * The authenticated ADB connection for the context's transport. `deadline` (an
 * absolute time) bounds a bounded attempt end to end: authentication waiting for
 * a CNXN a device is still deciding on, the quiet reads that wait with it, and
 * the existing-daemon probe all end when it passes. A connection that comes out
 * of a bounded attempt lives only until that deadline.
 */
async function adbFor(context: HardwareContext, options?: { deadline?: number }): Promise<Adb> {
  const existing = adbSessions.get(context.transport);
  if (existing) return existing;
  // The connection outlives any single operation when several share it, so it
  // is bound to the hold's own signal, never to one operation's.
  const holdSignal = adbHolds.get(context.transport)?.controller.signal ?? context.signal;
  const sessionSignal = options?.deadline === undefined ? holdSignal : AbortSignal.any([holdSignal, AbortSignal.timeout(Math.max(1, options.deadline - Date.now()))]);

  let initialProbeFailed = false;
  const connection = createAdbHardwareConnection(context.transport, sessionSignal, () => { initialProbeFailed = true; });
  const pending = AdbDaemonTransport.authenticate({
    serial: "cody-browser",
    connection,
    credentialStore: credentials(),
  }).then((transport) => new Adb(transport));
  adbSessions.set(context.transport, pending);
  try {
    const adb = await pending;
    const forget = () => { adbSessions.delete(context.transport); };
    void adb.disconnected.then(forget, forget);
    return adb;
  } catch (error) {
    adbSessions.delete(context.transport);
    const message = error instanceof Error ? error.message : String(error);
    if (initialProbeFailed || message.includes("bounded initial protocol probe")) { const existing = await attachExistingDaemon(context, sessionSignal);
    if (existing) {
      const restored = Promise.resolve(existing);
      adbSessions.set(context.transport, restored);
      const forget = () => { adbSessions.delete(context.transport); };
      void existing.disconnected.then(forget, forget);
      return existing;
    } }
    throw new AdbProtocolError(
      `ADB connection was not established: ${message}. If the device displays a new Cody RSA authorization prompt, approve it and run a fresh operation; screenless devices do not auto-authorize a new key.`,
    );
  }
}

/** Close the cached ADB session for a transport. Callers go through `AdbHold`
 * so a connection shared by several operations is closed only by the last. */
async function closeCachedAdb(transport: HardwareTransport): Promise<void> {
  const pending = adbSessions.get(transport);
  adbSessions.delete(transport);
  if (!pending) return;
  try {
    await (await pending).close();
  } catch {
    // A disconnected transport cannot make protocol cleanup a second failure.
  }
}

/**
 * ADB multiplexes streams over one authenticated connection, so port rules,
 * shells and pulls on one device share it instead of queuing for the lease.
 * The connection is bound to the hold's own signal and closed by the last
 * operation to leave; it is torn down early only when EVERY remaining operation
 * has been cancelled, so cancelling one forward never drops another.
 */
interface AdbHold {
  /** Operations using the connection, and those among them not yet cancelled. */
  users: number;
  active: number;
  /** Operations that need the live connection to clean up after their own cancel. */
  retained: number;
  controller: AbortController;
  /** The last user left and the connection is being closed. */
  closing: boolean;
  /** Settles once the connection is fully closed and the hold is gone. */
  done: Promise<void>;
  finish(): void;
}

const adbHolds = new WeakMap<HardwareTransport, AdbHold>();

function abortIfAbandoned(hold: AdbHold): void {
  if (hold.users > 0 && hold.active === 0 && hold.retained === 0) hold.controller.abort();
}

async function enterAdbHold(context: HardwareContext): Promise<() => Promise<void>> {
  const { transport, signal } = context;
  let hold = adbHolds.get(transport);
  // A connection that is closing or already aborted must be fully gone before a
  // new operation authenticates its own: two live ADB sessions on one USB
  // transport would steal each other's packets, and the old session's abort
  // would cancel the new one's reads.
  // The wait is cancellable: a stalled teardown must not pin a cancelled operation.
  signal.throwIfAborted();
  while (hold && (hold.closing || hold.controller.signal.aborted)) {
    const { promise: cancelled, reject } = Promise.withResolvers<never>();
    const onAbort = (): void => reject(new DOMException("Operation cancelled.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([hold.done, cancelled]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    hold = adbHolds.get(transport);
  }
  if (!hold) {
    const { promise, resolve } = Promise.withResolvers<void>();
    hold = { users: 0, active: 0, retained: 0, controller: new AbortController(), closing: false, done: promise, finish: resolve };
    adbHolds.set(transport, hold);
  }
  const entered = hold;
  entered.users += 1;
  let counted = !signal.aborted;
  const onAbort = (): void => {
    if (!counted) return;
    counted = false;
    entered.active -= 1;
    abortIfAbandoned(entered);
  };
  if (counted) {
    entered.active += 1;
    signal.addEventListener("abort", onAbort, { once: true });
  } else abortIfAbandoned(entered);
  let left = false;
  return async () => {
    if (left) return;
    left = true;
    signal.removeEventListener("abort", onAbort);
    if (counted) {
      counted = false;
      entered.active -= 1;
    }
    entered.users -= 1;
    if (entered.users > 0) {
      abortIfAbandoned(entered);
      return;
    }
    entered.closing = true;
    try {
      await closeCachedAdb(transport);
      // A resumed push swaps context.transport for a reacquired one.
      if (context.transport !== transport) await closeCachedAdb(context.transport);
    } finally {
      entered.controller.abort();
      if (adbHolds.get(transport) === entered) adbHolds.delete(transport);
      entered.finish();
    }
  };
}

/** Keep the connection alive past this operation's own cancellation, so it can
 * undo what it set up on the device (a reverse rule). Returns the release. */
function retainAdbSession(context: HardwareContext): () => void {
  const hold = adbHolds.get(context.transport);
  if (!hold) return () => undefined;
  hold.retained += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hold.retained -= 1;
    abortIfAbandoned(hold);
  };
}
const EXISTING_DAEMON_PROBE_ID = 0x43504459;
const EXISTING_DAEMON_PROBE_MS = 5_000;

function adbPacket(command: number, arg0: number, arg1: number, payload: Uint8Array): AdbPacketInit {
  return { command, arg0, arg1, payload, checksum: calculateChecksum(payload), magic: command ^ -1 };
}

async function attachExistingDaemon(context: HardwareContext, signal: AbortSignal): Promise<Adb | undefined> { const controller = new AbortController();
const abortFromContext = () => controller.abort(signal.reason);
if (signal.aborted) abortFromContext();
else signal.addEventListener("abort", abortFromContext, { once: true });
const timer = setTimeout(() => controller.abort(new AdbProtocolError("ADB existing-stream probe timed out.")), EXISTING_DAEMON_PROBE_MS);
const connection = createAdbHardwareConnection(context.transport, controller.signal);
const reader = connection.readable.getReader();
const writer = connection.writable.getWriter();
let reusable = false;
try {
  const payload = new TextEncoder().encode("shell:printf cody-adb-probe\0");
  await writer.write(new Consumable(adbPacket(AdbCommand.Open, EXISTING_DAEMON_PROBE_ID, 0, payload)));
  let remoteId: number | undefined;
  for (;;) {
    const next = await reader.read();
    if (next.done) return undefined;
    const packet = next.value;
    if (packet.command === AdbCommand.Connect || packet.command === AdbCommand.Auth) return undefined;
    if (packet.command === AdbCommand.Okay) {
      if (packet.payload.length !== 0 || packet.arg1 !== EXISTING_DAEMON_PROBE_ID || remoteId !== undefined) return undefined;
      remoteId = packet.arg0;
      await writer.write(new Consumable(adbPacket(AdbCommand.Close, EXISTING_DAEMON_PROBE_ID, remoteId, new Uint8Array())));
      continue;
    }
    if (packet.command === AdbCommand.Write) {
      if (remoteId === undefined || packet.arg0 !== remoteId || packet.arg1 !== EXISTING_DAEMON_PROBE_ID) return undefined;
      await writer.write(new Consumable(adbPacket(AdbCommand.Okay, EXISTING_DAEMON_PROBE_ID, remoteId, new Uint8Array())));
      continue;
    }
    if (packet.command === AdbCommand.Close) {
      if (remoteId === undefined || packet.arg0 !== remoteId || packet.arg1 !== EXISTING_DAEMON_PROBE_ID) return undefined;
      reusable = true;
      break;
    }
    return undefined;
  }
} finally {
  clearTimeout(timer);
  signal.removeEventListener("abort", abortFromContext);
  reader.releaseLock();
  writer.releaseLock();
  if (!reusable) controller.abort();
}

if (!reusable) return undefined;
return new Adb(new AdbDaemonTransport({
  serial: "cody-browser-existing",
  connection,
  version: 0x01000000,
  maxPayloadSize: 4096,
  banner: "device::",
  features: [],
  initialDelayedAckBytes: 0,
})); }
function requireTarget(request: HardwareRequest): string {
  const target = request.target;
  if (!target || !target.startsWith("/") || target.includes("\0") || target.includes("\n") || target.includes("\r")) {
    throw new AdbProtocolError("ADB target must be an absolute, single-line path.");
  }
  if (target.split("/").some((part) => part === "..")) {
    throw new AdbProtocolError("ADB target path must not contain '..'.");
  }
  return target;
}

function rejectRawStorageTarget(target: string): void {
  const forbidden = ["/dev/", "/proc/", "/sys/", "/system/", "/vendor/", "/boot/", "/recovery/", "/firmware/", "/persist/"];
  if (forbidden.some((prefix) => target === prefix.slice(0, -1) || target.startsWith(prefix))) {
    throw new AdbProtocolError(`ADB refuses writes or dumps to protected raw storage target '${target}'.`);
  }
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function abbreviatedOutput(output: string): string {
  const normalized = output.trim().replaceAll(/\s+/g, " ");
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

interface ShellResult {
  output: string;
  status: number;
}

async function shellStatus(adb: Adb, command: string): Promise<ShellResult> {
  const wrapped = `(${command}); c=$?; printf '\\n${SHELL_STATUS_PREFIX}%s\\n' "$c"; exit "$c"`;
  const shell = adb.subprocess.shellProtocol;
  let stdout: string;
  let stderr = "";
  if (shell) {
    // ya-webadb joins argv literally; adbd already invokes the device shell.
    const result = await shell.spawnWaitText([wrapped]);
    stdout = result.stdout;
    stderr = result.stderr;
  } else {
    stdout = await adb.subprocess.noneProtocol.spawnWaitText([wrapped]);
  }
  const marker = new RegExp(`\\n${SHELL_STATUS_PREFIX}(\\d+)\\n`, "g");
  let match: RegExpExecArray | null = null;
  for (let candidate = marker.exec(stdout); candidate; candidate = marker.exec(stdout)) match = candidate;
  if (!match || match.index === undefined) {
    throw new AdbProtocolError("ADB shell did not return a trustworthy command status marker.");
  }
  return { output: `${stdout.slice(0, match.index)}${stderr}`, status: Number(match[1]) };
}

async function shell(adb: Adb, command: string, description: string): Promise<string> {
  const result = await shellStatus(adb, command);
  if (result.status !== 0) {
    const detail = abbreviatedOutput(result.output);
    throw new AdbProtocolError(`${description} failed with status ${result.status}${detail ? `: ${detail}` : "."}`);
  }
  return result.output;
}

type HashTool = "sha256sum" | "toybox" | "busybox";

interface ShellCapabilities {
  hashTool: HashTool;
}

async function shellCapabilities(adb: Adb): Promise<ShellCapabilities> {
  const result = await shellStatus(
    adb,
    "missing=''; for c in sh cat mv mkdir wc test; do command -v \"$c\" >/dev/null 2>&1 || missing=\"$missing $c\"; done; " +
      "if command -v sha256sum >/dev/null 2>&1 && sha256sum /dev/null >/dev/null 2>&1; then hash=sha256sum; " +
      "elif command -v toybox >/dev/null 2>&1 && toybox sha256sum /dev/null >/dev/null 2>&1; then hash=toybox; " +
      "elif command -v busybox >/dev/null 2>&1 && busybox sha256sum /dev/null >/dev/null 2>&1; then hash=busybox; " +
      "else missing=\"$missing sha256sum\"; fi; " +
      "if [ -n \"$missing\" ]; then printf 'MISSING:%s' \"$missing\"; exit 127; fi; printf 'HASH:%s' \"$hash\";",
  );
  const hash = /^HASH:(sha256sum|toybox|busybox)\s*$/.exec(result.output);
  if (result.status !== 0 || !hash) {
    const missing = /^MISSING:(.*)$/.exec(result.output.trim())?.[1]?.trim();
    throw new AdbProtocolError(
      missing
        ? `ADB target lacks required staging tools: ${missing}. Resumable verified push is unavailable.`
        : "ADB target shell capability probe failed; resumable verified push is unavailable.",
    );
  }
  return { hashTool: hash[1] as HashTool };
}

function hashCommand(tool: HashTool, path: string): string {
  const quoted = shQuote(path);
  switch (tool) {
    case "sha256sum":
      return `sha256sum ${quoted}`;
    case "toybox":
      return `toybox sha256sum ${quoted}`;
    case "busybox":
      return `busybox sha256sum ${quoted}`;
  }
}

async function remoteSha256(adb: Adb, capabilities: ShellCapabilities, path: string): Promise<string> {
  const output = await shell(adb, hashCommand(capabilities.hashTool, path), `Hashing '${path}'`);
  const hash = output.match(/\b[0-9a-f]{64}\b/i)?.[0];
  if (!hash) throw new AdbProtocolError(`ADB target did not return a SHA-256 for '${path}'.`);
  return normalizeSha256(hash, `SHA-256 for '${path}'`);
}

async function remoteLength(adb: Adb, path: string): Promise<number> {
  const output = await shell(adb, `wc -c < ${shQuote(path)}`, `Measuring '${path}'`);
  const text = output.trim();
  if (!/^\d+$/.test(text)) throw new AdbProtocolError(`ADB target returned an invalid byte length for '${path}'.`);
  const length = Number(text);
  if (!Number.isSafeInteger(length)) throw new AdbProtocolError(`ADB target length for '${path}' is too large.`);
  return length;
}

async function remoteExists(adb: Adb, path: string): Promise<boolean> {
  const result = await shellStatus(adb, `test -e ${shQuote(path)}`);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new AdbProtocolError(`Could not determine whether '${path}' exists on the ADB target.`);
}

async function rejectSymlinkDestination(adb: Adb, path: string): Promise<void> {
  const result = await shellStatus(adb, `test -L ${shQuote(path)}`);
  if (result.status === 0) {
    throw new AdbProtocolError(`ADB refuses symlink destination '${path}' because its final target is not explicit.`);
  }
  if (result.status !== 1) throw new AdbProtocolError(`Could not inspect destination '${path}' on the ADB target.`);
}

function bytesStream(bytes: Uint8Array): AdbReadableStream<Uint8Array> {
  return new AdbReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function* remoteChunks(adb: Adb, path: string, context: HardwareContext): AsyncGenerator<Uint8Array> {
  const sync = await adb.sync();
  const reader = sync.read(path).getReader();
  let completed = 0;
  try {
    for (;;) {
      context.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) return;
      completed += next.value.byteLength;
      yield next.value;
      context.progress({ phase: "adb.read", completed, message: "Streaming " + path });
    }
  } finally { reader.releaseLock(); await sync.dispose(); }
}

async function saveRemote(adb: Adb, path: string, name: string, context: HardwareContext) {
  if (!context.saveStream) throw new AdbProtocolError("Streaming artifact storage is required for ADB pulls and backups.");
  return context.saveStream(name, remoteChunks(adb, path, context));
}

async function pushRemote(adb: Adb, path: string, data: Uint8Array): Promise<void> {
  const sync = await adb.sync();
  try {
    await sync.write({ filename: path, file: bytesStream(data), permission: 0o600 });
  } finally {
    await sync.dispose();
  }
}

function safeDownloadName(path: string, fallback: string): string {
  const base = path.split("/").filter(Boolean).at(-1) ?? fallback;
  return base.replaceAll(/[^a-zA-Z0-9._-]/g, "_") || fallback;
}

async function escrowDestination(adb: Adb, target: string, context: HardwareContext): Promise<string> {
  if (!(await remoteExists(adb, target))) return "destination absent";
  await rejectSymlinkDestination(adb, target);
  const { fileId } = await saveRemote(adb, target, `adb-escrow-${safeDownloadName(target, "destination.bin")}`, context);
  return `saved destination escrow ${fileId}`;
}

function pathDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

interface StagedChunk {
  index: number;
  offset: number;
  length: number;
  sha256: string;
  path: string;
}

export interface AdbResumeState {
  target: string;
  sha256: string;
  length: number;
  stagingDirectory: string;
  assembledPath: string;
  chunks: readonly StagedChunk[];
  reconnects: number;
}

export interface AdbStagingIo {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  length(path: string): Promise<number>;
  sha256(path: string): Promise<string>;
  makeDirectory(path: string): Promise<void>;
  concatenate(parts: readonly string[], destination: string): Promise<void>;
  moveReplace(source: string, destination: string): Promise<void>;
}

interface StagedPushOptions {
  input: Blob;
  state: AdbResumeState;
  io: AdbStagingIo;
  progress: HardwareContext["progress"];
  /** Only used for a disconnected staged write. It must return a fresh lease
   * after the caller verifies the remote committed prefix. */
  reconnect?: () => Promise<AdbStagingIo>;
  isConnectionFailure?: (error: unknown) => boolean;
}

function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disconnect|closed|gone|network|transport|device lost|read failed/i.test(message);
}

async function committedPrefix(io: AdbStagingIo, chunks: readonly StagedChunk[]): Promise<number> {
  let prefix = 0;
  for (const chunk of chunks) {
    if (!(await io.exists(chunk.path))) break;
    if ((await io.length(chunk.path)) !== chunk.length) break;
    if ((await io.sha256(chunk.path)) !== chunk.sha256) break;
    prefix += 1;
  }
  return prefix;
}

/**
 * Standard adb sync has no byte-offset resume. Each chunk is therefore a
 * content-addressed staging file. Only fully validated contiguous chunks are
 * skipped after reconnect; the destination is touched exactly once by mv after
 * the staged aggregate has already been hashed.
 */
export async function resumeVerifiedStagedPush(options: StagedPushOptions): Promise<AdbResumeState> {
  const { input, state, progress } = options;
  let io = options.io;
  await io.makeDirectory(state.stagingDirectory);
  let prefix = await committedPrefix(io, state.chunks);
  let completed = 0;
  for (let index = 0; index < prefix; index += 1) completed += state.chunks[index]!.length;
  progress({ phase: "adb.push.resume", completed, total: state.length });

  for (let index = prefix; index < state.chunks.length; index += 1) {
    const chunk = state.chunks[index]!;
    const data = new Uint8Array(await input.slice(chunk.offset, chunk.offset + chunk.length).arrayBuffer());
    try {
      await io.writeFile(chunk.path, data);
      const actualLength = await io.length(chunk.path);
      const actualHash = await io.sha256(chunk.path);
      if (actualLength !== chunk.length || actualHash !== chunk.sha256) {
        throw new AdbProtocolError(`ADB staging verification failed for chunk ${chunk.index}; destination was not replaced.`);
      }
    } catch (error) {
      if (!options.reconnect || !options.isConnectionFailure?.(error)) throw error;
      state.reconnects += 1;
      progress({ phase: "adb.push.reconnecting", completed, total: state.length, message: "Verifying committed staged chunks after transport disconnect." });
      io = await options.reconnect();
      await io.makeDirectory(state.stagingDirectory);
      prefix = await committedPrefix(io, state.chunks);
      completed = 0;
      for (let committed = 0; committed < prefix; committed += 1) completed += state.chunks[committed]!.length;
      index = prefix - 1;
      continue;
    }
    prefix = index + 1;
    completed += chunk.length;
    progress({ phase: "adb.push", completed, total: state.length });
  }

  // The aggregate lives in the same directory as target, so replace is atomic
  // once this independent final hash has been checked.
  try {
    await io.concatenate(state.chunks.map((chunk) => chunk.path), state.assembledPath);
    if ((await io.length(state.assembledPath)) !== state.length || (await io.sha256(state.assembledPath)) !== state.sha256) {
      throw new AdbProtocolError("ADB assembled staging file failed final SHA-256 verification; destination was not replaced.");
    }
    await io.moveReplace(state.assembledPath, state.target);
    if ((await io.length(state.target)) !== state.length || (await io.sha256(state.target)) !== state.sha256) {
      throw new AdbProtocolError("ADB destination failed post-replace SHA-256 verification.");
    }
  } catch (error) {
    if (!options.reconnect || !options.isConnectionFailure?.(error)) throw error;
    state.reconnects += 1;
    progress({ phase: "adb.push.reconnecting", completed: state.length, total: state.length, message: "Reconciling target after staged finalization disconnect." });
    io = await options.reconnect();
    if ((await io.length(state.target)) === state.length && (await io.sha256(state.target)) === state.sha256) {
      progress({ phase: "adb.push.verified", completed: state.length, total: state.length });
      return state;
    }
    if ((await committedPrefix(io, state.chunks)) !== state.chunks.length) {
      throw new AdbProtocolError("ADB staged prefix changed after finalization disconnect; destination was not retried.");
    }
    await io.concatenate(state.chunks.map((chunk) => chunk.path), state.assembledPath);
    if ((await io.length(state.assembledPath)) !== state.length || (await io.sha256(state.assembledPath)) !== state.sha256) {
      throw new AdbProtocolError("ADB rebuilt staging file failed SHA-256 verification; destination was not retried.");
    }
    await io.moveReplace(state.assembledPath, state.target);
    if ((await io.length(state.target)) !== state.length || (await io.sha256(state.target)) !== state.sha256) {
      throw new AdbProtocolError("ADB destination failed post-recovery SHA-256 verification.");
    }
  }
  progress({ phase: "adb.push.verified", completed: state.length, total: state.length });
  return state;
}

async function stagingState(input: Blob, target: string, sha256: string): Promise<AdbResumeState> {
  const directory = pathDirectory(target);
  const stagingDirectory = `${directory}/${STAGING_NAME_PREFIX}${sha256.slice(0, 24)}`;
  const chunks: StagedChunk[] = [];
  for (let offset = 0, index = 0; offset < input.size; offset += ADB_CHUNK_BYTES, index += 1) {
    const length = Math.min(ADB_CHUNK_BYTES, input.size - offset);
    const chunkHash = await sha256Blob(input.slice(offset, offset + length));
    chunks.push({
      index,
      offset,
      length,
      sha256: chunkHash,
      path: `${stagingDirectory}/chunk-${String(index).padStart(8, "0")}-${chunkHash.slice(0, 16)}`,
    });
  }
  return {
    target,
    sha256,
    length: input.size,
    stagingDirectory,
    assembledPath: `${stagingDirectory}/assembled-${sha256}`,
    chunks,
    reconnects: 0,
  };
}

const resumeStates = new WeakMap<HardwareContext, Map<string, AdbResumeState>>();

async function stateFor(context: HardwareContext, input: Blob, target: string, sha256: string): Promise<AdbResumeState> {
  let states = resumeStates.get(context);
  if (!states) {
    states = new Map();
    resumeStates.set(context, states);
  }
  const key = `${target}\n${sha256}\n${input.size}`;
  const prior = states.get(key);
  if (prior) return prior;
  const state = await stagingState(input, target, sha256);
  states.set(key, state);
  return state;
}

/**
 * The shell and sync steps staging is made of. A caller that must stop at the
 * very next step when its operation is cancelled passes that signal: the
 * connection may be kept alive past the cancel (for the caller's own cleanup),
 * so it will not fail the step for it.
 */
function stagingIo(adb: Adb, capabilities: ShellCapabilities, signal?: AbortSignal): AdbStagingIo {
  const step = <Args extends unknown[], Result>(call: (...args: Args) => Promise<Result>) => (...args: Args): Promise<Result> => {
    signal?.throwIfAborted();
    return call(...args);
  };
  return {
    writeFile: step((path: string, data: Uint8Array) => pushRemote(adb, path, data)),
    exists: step((path: string) => remoteExists(adb, path)),
    length: step((path: string) => remoteLength(adb, path)),
    sha256: step((path: string) => remoteSha256(adb, capabilities, path)),
    makeDirectory: step((path: string) => shell(adb, `mkdir -p ${shQuote(path)}`, `Creating staging directory '${path}'`).then(() => undefined)),
    concatenate: step(async (parts: readonly string[], destination: string) => {
      await shell(adb, `: > ${shQuote(destination)}`, `Creating staged aggregate '${destination}'`);
      for (const part of parts) {
        signal?.throwIfAborted();
        await shell(adb, `cat ${shQuote(part)} >> ${shQuote(destination)}`, `Appending staged chunk '${part}'`);
      }
    }),
    moveReplace: step((source: string, destination: string) => shell(adb, `mv -f ${shQuote(source)} ${shQuote(destination)}`, `Atomically replacing '${destination}'`).then(() => undefined)),
  };
}

async function reconnectStaging(context: HardwareContext, signal?: AbortSignal): Promise<AdbStagingIo> {
  const reacquire = context.reacquireTransport;
  if (!reacquire) {
    throw new AdbProtocolError("ADB transport disconnected. This runner cannot reacquire the exclusive hardware lease; start a fresh operation to resume from verified chunks.");
  }
  const previousTransport = context.transport;
  await closeCachedAdb(previousTransport);
  await reacquire.call(context);

  const adb = await adbFor(context);
  return stagingIo(adb, await shellCapabilities(adb), signal);
}



function shellCommand(request: HardwareRequest, context: HardwareContext): string {
  const command = request.command;
  if (!command?.trim() || command.includes("\0")) throw new AdbProtocolError("ADB shell requires a non-empty command without NUL bytes.");
  if (!context.shellAccess?.() && !/^(?:id|uname -a|df -h|getprop(?: ro\.[A-Za-z0-9_.-]+)?)$/.test(command)) {
    throw new AdbProtocolError("Allow agent shell access in the Devices panel first. Without it, only literal read-only diagnostics are available: id, uname -a, df -h, or getprop [ro.*].");
  }
  return command;
}

async function streamShellOutput(stream: AdbReadableStream<Uint8Array>, context: HardwareContext): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  try {
    for (;;) {
      context.signal.throwIfAborted();
      const next = await reader.read();
      const text = next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      if (text) { context.output?.(text); tail = (tail + text).slice(-64 * 1024); }
      if (next.done) return tail;
    }
  } finally { reader.releaseLock(); }
}

async function runShellCommand(command: string, context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  context.signal.throwIfAborted();
  context.output?.("> adb shell: " + command);
  const protocol = adb.subprocess.shellProtocol;
  if (protocol) {
    const process = await protocol.spawn([command], context.signal);
    const [stdout, stderr, exitCode] = await Promise.all([streamShellOutput(process.stdout, context), streamShellOutput(process.stderr, context), process.exited]);
    if (exitCode !== 0) throw new AdbProtocolError("ADB shell exited with status " + exitCode + ".");
    return { summary: "ADB shell command completed.", details: { output: (stdout + stderr).slice(-64 * 1024), exitCode } };
  }
  const wrapped = `(${command}); c=$?; printf '\\n${SHELL_STATUS_PREFIX}%s\\n' "$c"; exit "$c"`;
  const process = await adb.subprocess.noneProtocol.spawn([wrapped], context.signal);
  const output = await streamShellOutput(process.output, context);
  const match = output.match(/\n__CODY_ADB_STATUS__(\d+)\r?\n?$/);
  if (!match) throw new AdbProtocolError("ADB shell ended without a command status; completion is unknown.");
  const exitCode = Number(match[1]);
  if (exitCode !== 0) throw new AdbProtocolError("ADB shell exited with status " + exitCode + ".");
  return { summary: "ADB shell command completed.", details: { output: output.slice(0, match.index), exitCode } };
}

async function terminal(context: HardwareContext): Promise<HardwareResult> {
  if (!context.shellAccess?.()) throw new AdbProtocolError("Allow agent shell access in the Devices panel before opening an ADB terminal.");
  const adb = await adbFor(context);
  context.signal.throwIfAborted();
  const process = adb.subprocess.shellProtocol
    ? await adb.subprocess.shellProtocol.pty({ terminalType: "dumb" })
    : await adb.subprocess.noneProtocol.pty();
  const writer = process.input.getWriter();
  const abort = () => { void Promise.resolve(process.kill()).catch(() => undefined); };
  context.signal.addEventListener("abort", abort, { once: true });
  context.setTerminalInput?.(async (bytes) => { context.signal.throwIfAborted(); await writer.write(bytes); });
  context.progress({ phase: "monitoring", message: "ADB terminal connected" });
  try {
    const [, exitCode] = await Promise.all([streamShellOutput(process.output, context), process.exited]);
    return { summary: "ADB terminal closed.", details: { exitCode } };
  } finally {
    context.setTerminalInput?.(undefined);
    context.signal.removeEventListener("abort", abort);
    writer.releaseLock();
    await Promise.resolve(process.kill()).catch(() => undefined);
  }
}

async function reboot(request: HardwareRequest, context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  const mode = request.options?.mode;
  if (mode !== undefined && typeof mode !== "string") throw new AdbProtocolError("ADB reboot mode must be a string.");
  
  const normalized = mode ?? "";
  if (normalized !== "" && normalized !== "recovery" && normalized !== "bootloader" && normalized !== "sideload" && normalized !== "fastboot") {
      throw new AdbProtocolError("ADB reboot supports only system, recovery, bootloader, sideload, or fastboot modes.");
    }
  await context.confirm({ action: "adb.reboot", target: normalized || "system", backup: "not applicable: reboot" });
  const result = await adb.power.reboot(normalized || undefined);
  return { summary: `ADB reboot requested for ${normalized || "system"}.`, details: { response: result } };
}

async function queueTwrpOpenRecoveryScript(request: HardwareRequest, context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  const target = requireTarget(request);
  if (target !== "/cache/recovery/openrecoveryscript") {
    throw new AdbProtocolError("TWRP OpenRecoveryScript queueing supports only /cache/recovery/openrecoveryscript.");
  }
  const script = request.command;
  if (!script?.trim()) throw new AdbProtocolError("TWRP OpenRecoveryScript queueing requires the exact non-empty script in command.");
  const lines = script.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0 || !lines.every((line) => /^(?:backup(?: [SDBEOA]+)?|print [A-Za-z0-9 .,:_'\-]+)$/.test(line))) {
    throw new AdbProtocolError("TWRP OpenRecoveryScript queueing permits only literal backup and print lines; install, flash, wipe, and update actions are refused.");
  }
  const input = new Blob([script], { type: "text/plain" });
  const sha256 = await sha256Blob(input);
  const capabilities = await shellCapabilities(adb);
  const backup = await escrowDestination(adb, target, context);
  await context.confirm({ action: "adb.twrp-openrecoveryscript", target, sha256, length: input.size, offset: 0, backup, details: script });
  const state = await stateFor(context, input, target, sha256);
  await resumeVerifiedStagedPush({ input, state, io: stagingIo(adb, capabilities), progress: context.progress, reconnect: () => reconnectStaging(context), isConnectionFailure });
  return { summary: "TWRP OpenRecoveryScript queued and SHA-256 verified; it was not executed.", verified: true, sha256, details: { target, stagingDirectory: state.stagingDirectory, reconnects: state.reconnects } };
}

async function pushDirect(request: HardwareRequest, context: HardwareContext, adb: Adb, target: string): Promise<HardwareResult> {
  if (!context.shellAccess?.()) throw new AdbProtocolError("Allow agent shell access before pushing to a device node or symlink.");
  const input = context.input!;
  const sha256 = await hashFirmware(input, request.sha256);
  let backup: string;
  try {
    // Character devices can be infinite streams, so do not attempt a backup.
    const character = await shellStatus(adb, "test -c " + shQuote(target));
    if (character.status === 0) backup = "backup unavailable: character device is not finite storage";
    else backup = "saved destination escrow " + (await saveRemote(adb, target, "adb-raw-backup-" + safeDownloadName(target, "storage.bin"), context)).fileId;
  } catch (error) {
    context.signal.throwIfAborted();
    backup = "backup unavailable: " + (error instanceof Error ? error.message : String(error));
  }
  await context.confirm({ action: "adb.push.raw", target, sha256, length: input.size, backup, protectedOverride: "write:" + target, details: "Direct write to the exact device node or symlink. No atomic replacement and no automatic retry. This can overwrite boot/storage metadata." });
  const reader = input.stream().getReader();
  let completed = 0;
  const file = new AdbReadableStream<Uint8Array>({
    async pull(controller) {
      context.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) { controller.close(); return; }
      completed += next.value.byteLength;
      controller.enqueue(next.value);
      context.progress({ phase: "adb.push.raw", completed, total: input.size });
    },
    cancel: (reason) => reader.cancel(reason),
  });
  const sync = await adb.sync();
  try { await sync.write({ filename: target, file, permission: 0o600 }); }
  finally { reader.releaseLock(); await sync.dispose(); }
  let readbackSha256: string | undefined;
  try {
    const capabilities = await shellCapabilities(adb);
    const output = await shell(adb, "head -c " + input.size + " " + shQuote(target) + " | " + hashCommand(capabilities.hashTool, "-"), "Hashing direct-write readback");
    readbackSha256 = output.match(/\b[0-9a-f]{64}\b/i)?.[0]?.toLowerCase();
  } catch (error) { context.signal.throwIfAborted(); context.output?.("Readback unavailable: " + String(error)); }
  if (readbackSha256 && readbackSha256 !== sha256) throw new AdbProtocolError("Direct-write readback SHA-256 does not match the input.");
  return { summary: readbackSha256 ? "Direct ADB write verified for the payload byte range." : "Direct ADB write acknowledged; readback is unavailable.", verified: Boolean(readbackSha256), sha256, details: { target, length: input.size, backup, readbackSha256 } };
}

async function push(request: HardwareRequest, context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  const target = requireTarget(request);
  if (!context.shellAccess?.()) rejectRawStorageTarget(target);
  if (!context.input?.size) throw new AdbProtocolError("ADB push requires a non-empty operation input file.");
  const direct = await shellStatus(adb, "test -L " + shQuote(target) + " || { test -e " + shQuote(target) + " && test ! -f " + shQuote(target) + "; }");
  if (direct.status === 0) return pushDirect(request, context, adb, target);
  if (direct.status !== 1) throw new AdbProtocolError("Could not inspect the ADB push destination.");
  context.progress({ phase: "adb.push.hashing", completed: 0, total: context.input.size });
    const sha256 = await hashFirmware(context.input, request.sha256);
    context.progress({ phase: "adb.push.prehashed", completed: context.input.size, total: context.input.size });
  const capabilities = await shellCapabilities(adb);
  const backup = await escrowDestination(adb, target, context);
  await context.confirm({ action: "adb.push", target, sha256, length: context.input.size, backup });
  const state = await stateFor(context, context.input, target, sha256);
  await resumeVerifiedStagedPush({
    input: context.input,
    state,
    io: stagingIo(adb, capabilities),
    progress: context.progress,
    reconnect: () => reconnectStaging(context),
    isConnectionFailure,
  });
  return {
    summary: "ADB push completed with verified atomic target replacement.",
    verified: true,
    sha256,
    details: { target, stagingDirectory: state.stagingDirectory, reconnects: state.reconnects },
  };
}

async function pull(request: HardwareRequest, context: HardwareContext, action: "pull" | "dump"): Promise<HardwareResult> {
  const target = requireTarget(request);
  if (!context.shellAccess?.()) rejectRawStorageTarget(target);
  const adb = await adbFor(context);
  const name = typeof request.options?.name === "string" ? request.options.name : safeDownloadName(target, action === "dump" ? "dump.bin" : "pull.bin");
  const result = await saveRemote(adb, target, name, context);
  context.output?.("SHA-256 " + result.sha256 + " (" + result.length + " bytes): " + target);
  return { summary: "ADB " + action + " completed; received bytes hashed and escrowed.", verified: true, ...result, details: { target, length: result.length } };
}

async function verifyWrittenRange(request:HardwareRequest,context:HardwareContext):Promise<HardwareResult> {
  if(!context.shellAccess?.()) throw new AdbProtocolError("Allow agent shell access before verifying device storage.");
  const target=requireTarget(request), length=request.length??context.input?.size;
  const expected=request.sha256?.toLowerCase();
  if(!expected || !/^[a-f0-9]{64}$/.test(expected) || !Number.isSafeInteger(length) || !length || length<1) throw new AdbProtocolError("ADB verify needs an expected SHA-256 and the exact byte length of the raw image.");
  if((request.offset??0)!==0) throw new AdbProtocolError("ADB verify currently verifies the prefix of the exact path; use a partition path rather than a whole-disk offset.");
  const adb=await adbFor(context), capabilities=await shellCapabilities(adb);
  const output=await shell(adb,"head -c "+length+" "+shQuote(target)+" | "+hashCommand(capabilities.hashTool,"-"),"ADB storage verification");
  const digest=output.match(/\b[0-9a-f]{64}\b/i)?.[0]?.toLowerCase();
  if(!digest) throw new AdbProtocolError("The device did not return a readback SHA-256.");
  context.output?.("Readback SHA-256 "+digest+" ("+length+" bytes): "+target);
  if(digest!==expected) throw new AdbProtocolError("ADB readback SHA-256 does not match the image. Do not boot it; restore the saved backup or write the correct image.");
  return {summary:"ADB readback matches the raw image SHA-256.",verified:true,sha256:digest,details:{target,length}};
}

async function detect(context: HardwareContext): Promise<HardwareResult> {
  const adb = await adbFor(context);
  const [model, device, release] = await Promise.all([
    adb.getProp("ro.product.model"),
    adb.getProp("ro.product.device"),
    adb.getProp("ro.build.version.release"),
  ]);
  return {
    summary: `ADB daemon detected for ${model || device || adb.serial}.`,
    details: {
      serial: adb.serial,
      banner: bannerText(adb.banner),
      model,
      device,
      androidRelease: release,
      shellProtocol: adb.subprocess.shellProtocol !== undefined,
      sync: true,
      resumablePush: "requires sh, cat, mv, mkdir, wc, test, and sha256sum/toybox/busybox on target",
    },
  };
}

const TUNNEL_CLEANUP_MS = 3_000;

/** Bound an orderly cleanup step: a device that stopped answering must not keep a cancelled rule alive. */
async function withinCleanupWindow(work: Promise<unknown>): Promise<void> {
  const timeout = Promise.withResolvers<void>();
  const timer = setTimeout(timeout.resolve, TUNNEL_CLEANUP_MS);
  try {
    await Promise.race([work.then(() => undefined, () => undefined), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** Host ports with an active reverse rule, per connection: a second rule to
 * the same host address would silently replace the first one's handler. */
const activeReverseHosts = new WeakMap<Adb, Set<string>>();
/** Device listening addresses held by Cody rules, per connection: adbd rebinds
 * silently, so a second rule would steal the first one's listener and then be
 * deleted by the first one's cleanup. `tcp:0` picks a fresh port each time. */
const activeReverseDevices = new WeakMap<Adb, Set<string>>();
const REVERSE_REGISTER_MS = 15_000;

/**
 * The library's `reverse.add` has no signal or timeout, so a daemon that takes
 * the request and never answers would pin the operation (and the shared
 * connection) forever. Give up on cancel or timeout, and undo the rule if it
 * turns out to have been installed after all.
 */
async function untilRegistered(
  registration: Promise<string>,
  adb: Adb,
  signal: AbortSignal,
  /** Called with the late registration's cleanup when this gives up on it. */
  abandoned: (settled: Promise<void>) => void,
): Promise<string> {
  const { promise: gaveUp, resolve: giveUp } = Promise.withResolvers<"aborted" | "timeout">();
  const onAbort = (): void => giveUp("aborted");
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => giveUp("timeout"), REVERSE_REGISTER_MS);
  try {
    const outcome = await Promise.race([registration.then((address) => ({ address })), gaveUp.then((reason) => ({ reason }))]);
    if ("address" in outcome) return outcome.address;
    abandoned(registration.then(async (address) => { await adb.reverse.remove(address).catch(() => undefined); }, () => undefined));
    if (outcome.reason === "aborted") throw new DOMException("Operation cancelled.", "AbortError");
    throw new AdbProtocolError("The device did not answer the reverse registration in time.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function requireTunnels(context: HardwareContext): { tunnels: TunnelChannel; operation: { id: string; deviceId: string } } {
  if (!context.tunnels || !context.operation) {
    throw new AdbProtocolError("Port forwarding needs Cody's browser-to-server relay, which is not attached to this page. Reload the Devices panel and retry.");
  }
  return { tunnels: context.tunnels, operation: context.operation };
}

function closeAdbSocket(socket: AdbSocket): void {
  void Promise.resolve(socket.close()).catch(() => undefined);
}

/**
 * Move bytes between one ADB stream and one relay connection until either
 * side ends. ADB has no half-close, exactly like `adb forward` on a PC: when
 * the host client finishes, the device stream is closed after what it already
 * sent; when the device finishes, the host client gets an orderly end.
 */
async function pumpTunnel(socket: AdbSocket, connection: TunnelConnection): Promise<void> {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const fail = (error: unknown): void => {
    connection.reset(error instanceof Error ? error.message : String(error));
    closeAdbSocket(socket);
  };
  void connection.closed.then(() => closeAdbSocket(socket));
  const toDevice = (async () => {
    for (;;) {
      const chunk = await connection.read();
      if (!chunk) break;
      await writer.write(chunk);
      connection.consumed(chunk.length);
    }
    closeAdbSocket(socket);
  })().catch(fail);
  const toHost = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      await connection.write(next.value);
    }
    connection.end();
  })().catch(fail);
  await Promise.all([toDevice, toHost]);
  // Wait for the CLOSE to be sent: the connection may be closed right after.
  await Promise.resolve(socket.close()).catch(() => undefined);
}

async function relayForwardConnection(adb: Adb, remote: DeviceSpec, connection: TunnelConnection): Promise<void> {
  let socket: AdbSocket;
  try {
    socket = await adb.createSocket(remote.text);
  } catch (error) {
    connection.reset(`The device refused ${remote.text}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  connection.opened();
  await pumpTunnel(socket, connection);
}

type TunnelEnd = { reason: "aborted" } | { reason: "relay"; detail: string } | { reason: "device" };

/** Wait for the first thing that ends a port rule, then turn it into the
 * operation's outcome: cancel, or a failure that says which side went away. */
async function untilTunnelEnds(adb: Adb, lost: Promise<string>, signal: AbortSignal, what: string): Promise<never> {
  const { promise: aborted, resolve: abort } = Promise.withResolvers<TunnelEnd>();
  const onAbort = (): void => abort({ reason: "aborted" });
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    const end = await Promise.race<TunnelEnd>([
      aborted,
      lost.then((detail) => ({ reason: "relay", detail })),
      adb.disconnected.then(() => ({ reason: "device" }), () => ({ reason: "device" })),
    ]);
    if (end.reason === "aborted") throw new DOMException("Operation cancelled.", "AbortError");
    if (end.reason === "device") throw new AdbProtocolError(`${what} ended because the ADB connection to the device was lost.`);
    throw new AdbProtocolError(`${what} ended: ${end.detail}`);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function forward(request: HardwareRequest, context: HardwareContext): Promise<HardwareResult> {
  const { tunnels, operation } = requireTunnels(context);
  let remote: DeviceSpec;
  let host: HostSpec;
  try {
    remote = parseDeviceSpec(request.target, "forward");
    host = parseHostSpec(request.options?.local, "forward");
  } catch (error) {
    throw new AdbProtocolError(error instanceof Error ? error.message : String(error));
  }
  const listening = host.port === 0 ? "a free port" : `port ${host.port}`;
  await context.confirm({
    action: "adb.forward",
    target: request.target as string,
    details: `Cody server loopback ${listening} -> device ${remote.text}. Every process on the Cody server can then connect to that device service until the forward is removed.`,
    backup: "not applicable: no device storage is written",
  });
  const adb = await adbFor(context);
  // Closing the device's streams needs the connection even after a cancel.
  const finishCleanup = retainAdbSession(context);
  let lease: ForwardLease | undefined;
  const relays = new Set<Promise<void>>();
  let served = 0;
  try {
    const rule = await tunnels.listen({ operationId: operation.id, deviceId: operation.deviceId, port: host.port }, context.signal);
    lease = rule;
    rule.onConnection((connection) => {
      served += 1;
      const relay = relayForwardConnection(adb, remote, connection).finally(() => relays.delete(relay));
      relays.add(relay);
    });
    context.output?.(`Forwarding 127.0.0.1:${rule.port} -> device ${remote.text}`);
    context.progress({ phase: "forwarding", message: `127.0.0.1:${rule.port} -> ${remote.text}` });
    return await untilTunnelEnds(adb, rule.lost, context.signal, `Forward 127.0.0.1:${rule.port} -> ${remote.text}`);
  } finally {
    lease?.release();
    await withinCleanupWindow(Promise.allSettled([...relays]));
    finishCleanup();
    if (lease) context.output?.(`Forward 127.0.0.1:${lease.port} -> ${remote.text} removed after ${served} connection(s).`);
  }
}

async function reverse(request: HardwareRequest, context: HardwareContext): Promise<HardwareResult> {
  const { tunnels, operation } = requireTunnels(context);
  let remote: DeviceSpec;
  let host: HostSpec;
  try {
    remote = parseDeviceSpec(request.target, "reverse");
    host = parseHostSpec(request.options?.local, "reverse");
  } catch (error) {
    throw new AdbProtocolError(error instanceof Error ? error.message : String(error));
  }
  await context.confirm({
    action: "adb.reverse",
    target: request.target as string,
    details: `Device ${remote.text} -> Cody server loopback port ${host.port}. Apps on the device can then reach whatever listens on that port on the Cody server until the rule is removed.`,
    backup: "not applicable: no device storage is written",
  });
  const adb = await adbFor(context);
  const hosts = activeReverseHosts.get(adb) ?? new Set<string>();
  activeReverseHosts.set(adb, hosts);
  if (hosts.has(host.text)) throw new AdbProtocolError(`A reverse rule to ${host.text} is already active on this device connection.`);
  const devices = activeReverseDevices.get(adb) ?? new Set<string>();
  activeReverseDevices.set(adb, devices);
  const claimsDevice = remote.text !== "tcp:0";
  if (claimsDevice && devices.has(remote.text)) {
    throw new AdbProtocolError(`A reverse rule listening on device ${remote.text} is already active on this device connection; remove it first.`);
  }
  hosts.add(host.text);
  if (claimsDevice) devices.add(remote.text);
  let finishCleanup: (() => void) | undefined;
  /** Set when registration was abandoned while the device might still install the rule. */
  let lateCleanup: Promise<void> | undefined;
  let lease: ReverseLease | undefined;
  let deviceAddress: string | undefined;
  let served = 0;
  const relays = new Set<Promise<void>>();
  try {
    lease = await tunnels.reverse({ operationId: operation.id, deviceId: operation.deviceId, port: host.port }, context.signal);
    const rule = lease;
    const registration = adb.reverse.add(remote.text, (socket) => {
      served += 1;
      const relay = (async () => {
        let connection: TunnelConnection;
        try {
          connection = await rule.connect();
        } catch {
          closeAdbSocket(socket);
          return;
        }
        await pumpTunnel(socket, connection);
      })().finally(() => relays.delete(relay));
      relays.add(relay);
    }, host.text);
    deviceAddress = await untilRegistered(registration, adb, context.signal, (settled) => { lateCleanup = settled; });
    // Only a live rule needs the connection kept past a cancel, to remove it.
    finishCleanup = retainAdbSession(context);
    context.output?.(`Reverse: device ${deviceAddress} -> Cody server 127.0.0.1:${host.port}`);
    context.progress({ phase: "reversing", message: `device ${deviceAddress} -> 127.0.0.1:${host.port}` });
    return await untilTunnelEnds(adb, rule.lost, context.signal, `Reverse device ${deviceAddress} -> 127.0.0.1:${host.port}`);
  } finally {
    // Undo the device-side rule while the connection is still alive, then
    // drop the server-side one. A dead connection takes the rule with it.
    if (deviceAddress) {
      const timeout = Promise.withResolvers<void>();
      const timer = setTimeout(timeout.resolve, TUNNEL_CLEANUP_MS);
      try {
        await Promise.race([adb.reverse.remove(deviceAddress), timeout.promise]);
      } catch {
        context.output?.(`Could not remove ${deviceAddress} on the device; it disappears when the ADB connection ends.`);
      } finally {
        clearTimeout(timer);
      }
    }
    lease?.release();
    await withinCleanupWindow(Promise.allSettled([...relays]));
    // An abandoned registration may still land on the device, and its cleanup
    // removes by address, so the addresses stay reserved until it has settled:
    // otherwise a replacement rule could claim them and be deleted by it.
    const release = (): void => {
      hosts.delete(host.text);
      if (claimsDevice) devices.delete(remote.text);
    };
    if (lateCleanup) void lateCleanup.then(release);
    else release();
    finishCleanup?.();
    if (deviceAddress) context.output?.(`Reverse ${deviceAddress} -> 127.0.0.1:${host.port} removed after ${served} connection(s).`);
  }
}

async function reverseList(context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  const rules = await adb.reverse.list();
  for (const rule of rules) context.output?.(`${rule.deviceSerial} ${rule.localName} ${rule.remoteName}`);
  if (rules.length === 0) context.output?.("No reverse rules are set on the device.");
  return { summary: `${rules.length} reverse rule(s) on the device.`, details: { rules } };
}

async function reverseRemove(request: HardwareRequest, context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  let spec: DeviceSpec;
  try {
    spec = parseDeviceSpec(request.target, "reverse");
  } catch (error) {
    throw new AdbProtocolError(error instanceof Error ? error.message : String(error));
  }
  await context.confirm({
    action: "adb.reverse-remove",
    target: request.target as string,
    details: `Remove the device's reverse rule for ${spec.text}, whoever created it.`,
    backup: "not applicable: no device storage is written",
  });
  await adb.reverse.remove(spec.text);
  return { summary: `Reverse rule ${spec.text} removed.` };
}

async function reverseRemoveAll(context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  await context.confirm({
    action: "adb.reverse-remove-all",
    target: "all reverse rules on the device",
    details: "Remove every reverse rule on the device, including rules other programs created.",
    backup: "not applicable: no device storage is written",
  });
  await adb.reverse.removeAll();
  return { summary: "All reverse rules removed from the device." };
}

// ============================================================================
// install, adbd restarts, wait-for-device
// ============================================================================

/** `adb install` flags in the order they are passed; each is a plain on/off choice. */
const INSTALL_FLAGS: Readonly<Record<string, string>> = { replace: "-r", downgrade: "-d", grantPermissions: "-g", testOnly: "-t" };

/**
 * Android 9 (API 28) made replacing an installed app the package manager's
 * default, ignores `-r`, and added `-R` to turn replacement off. Before it,
 * replacement needs `-r`, an absent flag already means "do not replace", and `-R`
 * is an unknown option that makes `pm install` fail.
 */
const PM_REPLACES_BY_DEFAULT_FROM_API = 28;

function installChoices(options: Record<string, unknown> | undefined): Record<string, boolean> {
  const unknown = Object.keys(options ?? {}).find((name) => name !== "kind" && !Object.hasOwn(INSTALL_FLAGS, name));
  if (unknown) throw new AdbProtocolError(`Unknown install option ${JSON.stringify(unknown)}. Supported: ${Object.keys(INSTALL_FLAGS).join(", ")}.`);
  const choices: Record<string, boolean> = {};
  for (const name of Object.keys(INSTALL_FLAGS)) {
    const value = options?.[name];
    if (value !== undefined && typeof value !== "boolean") throw new AdbProtocolError(`Install option ${name} must be true or false.`);
    choices[name] = value === true;
  }
  return choices;
}

/**
 * Replacement happens only when the user approved it. An API level that cannot
 * be read is treated as modern: `-R` is then an error on an old device (nothing
 * is installed) instead of a silent replacement on a new one.
 */
function installFlags(choices: Record<string, boolean>, apiLevel: number | undefined): string[] {
  const flags = Object.entries(INSTALL_FLAGS).filter(([name]) => choices[name]).map(([, flag]) => flag);
  if (!choices.replace && (apiLevel === undefined || apiLevel >= PM_REPLACES_BY_DEFAULT_FROM_API)) flags.push("-R");
  return flags;
}

async function androidApiLevel(adb: Adb, context: HardwareContext): Promise<number | undefined> {
  try {
    const value = (await adb.getProp("ro.build.version.sdk")).trim();
    return /^\d{1,3}$/.test(value) ? Number(value) : undefined;
  } catch {
    context.signal.throwIfAborted();
    return undefined;
  }
}

/**
 * `adb install`: the APK is copied to /data/local/tmp by the same hash-verified,
 * resumable staging a push uses, `pm install` runs on exactly that file, and the
 * copy and its staging files are removed whether or not the copy or the install
 * succeeded, and even when the user cancels. The command line is built only from
 * the validated flags and a path derived from the file's SHA-256, so no shell
 * grant is needed; the typed confirmation is the gate.
 */
async function install(request: HardwareRequest, context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  const input = context.input;
  if (!input?.size) throw new AdbProtocolError("ADB install requires a non-empty APK artifact.");
  const choices = installChoices(request.options);
  const apk = await openZip(input).catch(() => undefined);
  if (!apk?.find("AndroidManifest.xml")) throw new AdbProtocolError("This file is not an APK: it has no AndroidManifest.xml. App bundles and split APKs are not supported; select one .apk file.");
  const sha256 = await hashFirmware(input, request.sha256);
  const capabilities = await shellCapabilities(adb);
  const apiLevel = await androidApiLevel(adb, context);
  const flags = installFlags(choices, apiLevel);
  const staged = `/data/local/tmp/cody-install-${sha256.slice(0, 16)}.apk`;
  const command = ["pm", "install", ...flags, shQuote(staged)].join(" ");
  await context.confirm({
    action: "adb.install",
    target: command,
    sha256,
    length: input.size,
    protectedOverride: `install:${sha256.slice(0, 8)}`,
    backup: choices.replace ? "not applicable: -r replaces the installed app's code (its data is kept); Cody does not back up the old APK" : "not applicable: this install will not replace an app that is already installed",
    details: `Copy the APK to ${staged} (hash-checked on the device), run \`${command}\`, then delete the copy and its staging files. ${choices.replace ? "An installed copy of the app is replaced." : "An installed copy of the app is left alone and the install fails instead."} An installed app can request permissions and run code on the device.`,
  });
  const state = await stateFor(context, input, staged, sha256);
  // The staging files must be removable after a cancel too, which needs the live connection.
  const finishCleanup = retainAdbSession(context);
  try {
    await resumeVerifiedStagedPush({ input, state, io: stagingIo(adb, capabilities, context.signal), progress: context.progress, reconnect: () => reconnectStaging(context, context.signal), isConnectionFailure });
    const live = await adbFor(context);
    context.signal.throwIfAborted();
    context.progress({ phase: "adb.install", message: "Running pm install" });
    const installed = await shellStatus(live, command);
    const output = abbreviatedOutput(installed.output);
    if (installed.status !== 0 || !/^Success\b/m.test(installed.output)) throw new AdbProtocolError(`pm install failed: ${output || `status ${installed.status}`}. The staged copy was removed.`);
    context.output?.(output);
    return { summary: `Installed the APK (${input.size} bytes): the file matched its SHA-256 on the device and the package manager reported Success.`, verified: true, sha256, details: { command, flags, apiLevel, packageManager: output } };
  } finally {
    try {
      const live = await adbFor(context).catch(() => undefined);
      if (live) await live.rm([staged, state.stagingDirectory], { recursive: true, force: true }).catch(() => undefined);
    } finally {
      finishCleanup();
    }
  }
}

interface AdbdRestart {
  readonly service: string;
  readonly restarts: RegExp;
  /** The reply of an adbd that is already in the requested state. */
  readonly unchanged?: RegExp;
}

/** adbd's own replies (AOSP adb/daemon/services.cpp) to the services that restart it. */
const ADBD_RESTARTS: Readonly<Record<"root" | "unroot" | "tcpip" | "usb", AdbdRestart>> = {
  root: { service: "root:", restarts: /^restarting adbd as root$/, unchanged: /^adbd is already running as root$/ },
  unroot: { service: "unroot:", restarts: /^restarting adbd as non root$/, unchanged: /^adbd not running as root$/ },
  tcpip: { service: "tcpip:", restarts: /^restarting in TCP mode port: \d+$/ },
  usb: { service: "usb:", restarts: /^restarting in USB mode$/ },
};

/** How long Cody keeps trying to reach the device again after adbd restarted, unless the request says otherwise. */
const ADBD_RECONNECT_MS = 45_000;
const ADBD_RECONNECT_POLL_MS = 500;

function restartWindowMs(request: HardwareRequest): number {
  const seconds = request.options?.timeoutSeconds;
  if (seconds === undefined) return ADBD_RECONNECT_MS;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new AdbProtocolError("timeoutSeconds, how long to wait for the device to come back after adbd restarts, must be an integer from 1 to 300.");
  return seconds * 1000;
}

/** The properties that decide what adbd listens on: the legacy TCP listener (`adb tcpip`) and, independently, Wireless debugging's TLS listener. */
const ADBD_LISTENER_PROPERTIES = [
  "service.adb.listen_addrs",
  "service.adb.tcp.port",
  "persist.adb.tcp.port",
  "persist.adb.tls_server.enable",
  "service.adb.tls.port",
] as const;
export type AdbListenerProperties = Readonly<Record<(typeof ADBD_LISTENER_PROPERTIES)[number], string>>;

export interface AdbTcpListeners {
  /** The properties adbd's listeners follow, as the device reports them ("" when unset). */
  readonly properties: AdbListenerProperties;
  /** What the legacy listener (`adb tcpip`) will be on once adbd has started, and which property says so; undefined means there is none. */
  readonly effective?: { readonly source: "service.adb.listen_addrs" | "service.adb.tcp.port" | "persist.adb.tcp.port"; readonly addresses: readonly string[] };
  /**
   * Wireless debugging: a SEPARATE TLS listener, controlled from Developer options, that
   * `adb usb` does not touch and that computers paired with the device can reach over the
   * network. Present when the switch (`persist.adb.tls_server.enable`) is on or adbd
   * published the port it listens on (`service.adb.tls.port`); undefined when neither says so.
   */
  readonly wireless?: { readonly source: "persist.adb.tls_server.enable" | "service.adb.tls.port"; readonly port?: number };
}

/** A port counts when it parses (as sscanf %d does) to more than zero. */
function listenerPort(value: string): number | undefined {
  const port = Number.parseInt(value.trim(), 10);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * What adbd will listen on. The legacy listener follows adbd's own order (AOSP
 * adb/daemon/main.cpp): fixed `service.adb.listen_addrs` win outright; otherwise
 * `service.adb.tcp.port` when it is set at all - even to "0", which is how `adb usb`
 * overrides a persisted port - and `persist.adb.tcp.port` only when it is not. The
 * SDK's getListenAddresses() folds "" and "0" together and cannot tell those apart.
 * Wireless debugging is independent of all of that (AOSP docs/dev/adb_wifi.md):
 * `adb usb` leaves it running, so it is reported on its own.
 */
export function adbTcpListeners(properties: AdbListenerProperties): AdbTcpListeners {
  const tlsPort = listenerPort(properties["service.adb.tls.port"]);
  const wireless: AdbTcpListeners["wireless"] = tlsPort !== undefined
    ? { source: "service.adb.tls.port", port: tlsPort }
    : properties["persist.adb.tls_server.enable"].trim() === "1" ? { source: "persist.adb.tls_server.enable" } : undefined;
  const fixed = properties["service.adb.listen_addrs"].trim();
  if (fixed) return { properties, wireless, effective: { source: "service.adb.listen_addrs", addresses: fixed.split(",").map((address) => address.trim()).filter(Boolean) } };
  const service = properties["service.adb.tcp.port"].trim();
  const source = service ? "service.adb.tcp.port" : "persist.adb.tcp.port";
  const port = listenerPort(service || properties["persist.adb.tcp.port"]);
  return port !== undefined ? { properties, wireless, effective: { source, addresses: [`tcp:${port}`] } } : { properties, wireless };
}

async function readTcpListeners(adb: Adb): Promise<AdbTcpListeners> {
  const values: string[] = [];
  for (const name of ADBD_LISTENER_PROPERTIES) values.push(await adb.getProp(name));
  const [fixed, service, persisted, tlsEnabled, tlsPort] = values as [string, string, string, string, string];
  return adbTcpListeners({ "service.adb.listen_addrs": fixed, "service.adb.tcp.port": service, "persist.adb.tcp.port": persisted, "persist.adb.tls_server.enable": tlsEnabled, "service.adb.tls.port": tlsPort });
}

function describeListeners({ effective }: AdbTcpListeners): string {
  return effective ? `${effective.addresses.join(", ")} (from ${effective.source})` : "no TCP listener";
}

function describeWireless(wireless: NonNullable<AdbTcpListeners["wireless"]>): string {
  return wireless.port !== undefined ? `Wireless debugging is on (TLS port ${wireless.port})` : "Wireless debugging is on (persist.adb.tls_server.enable=1)";
}

/**
 * Why the device is not in the requested TCP/USB mode, from what adbd will really listen on;
 * undefined when it is. USB mode means no way in over the network: the legacy listener is
 * off AND Wireless debugging, which `adb usb` does not switch off, is not running.
 */
function listenerProblem(kind: "tcpip" | "usb", port: number | undefined, listeners: AdbTcpListeners): string | undefined {
  const { effective, wireless } = listeners;
  if (kind === "usb") {
    if (effective) return `the device still listens on TCP: ${describeListeners(listeners)}${wireless ? `, and ${describeWireless(wireless)}` : ""}`;
    return wireless
      ? `the legacy TCP/IP listener is off, but ${describeWireless(wireless)}, so computers paired with the device can still connect to it over the network and it is not USB-only. Cody cannot switch Wireless debugging off; it is the toggle in Developer options`
      : undefined;
  }
  if (effective?.addresses.includes(`tcp:${port}`)) return undefined;
  return effective?.source === "service.adb.listen_addrs"
    ? `its fixed listener addresses ${describeListeners(listeners)} override the port adb tcpip sets, and tcp:${port} is not among them`
    : `the device reports ${describeListeners(listeners)}, not tcp:${port}`;
}

/** What the approval for `adb usb` says about Wireless debugging, so nobody approves it believing it makes the device USB-only when it cannot. */
function usbApprovalNote(before: AdbTcpListeners | undefined): string {
  if (before?.wireless) return `${describeWireless(before.wireless)} and adb usb does not switch it off, so computers paired with this device can still connect over the network afterwards; turn it off in Developer options for a USB-only device.`;
  const separate = "Wireless debugging is a separate TLS listener that adb usb does not change";
  return before ? `${separate}, and it is off now.` : `${separate}, and it could not be read: if it is on, computers paired with this device can still connect over the network afterwards.`;
}

/** Fixed listener addresses beat every port adbd can be told, so no restart can reach the requested state. */
function fixedListenerConflict(kind: "tcpip" | "usb", port: number | undefined, listeners: AdbTcpListeners): string | undefined {
  if (listeners.effective?.source !== "service.adb.listen_addrs") return undefined;
  if (kind === "tcpip" && listeners.effective.addresses.includes(`tcp:${port}`)) return undefined;
  return `this device's adbd listens on the fixed addresses ${listeners.effective.addresses.join(", ")} (service.adb.listen_addrs), which override the TCP port that ${kind === "tcpip" ? `adb tcpip ${port}` : "adb usb"} sets`;
}

/**
 * After adbd restarted: take the SAME device again (the runner checks its granted
 * identity), authenticate again, and read - until the deadline. Every attempt
 * starts from nothing, so one that fails part-way (the device left the bus again,
 * or the old daemon's last breath answered) is simply tried again.
 */
async function reconnectAndRead<T>(context: HardwareContext, deadline: number, read: (adb: Adb) => Promise<T>): Promise<{ value: T } | { failure: string }> {
  const reacquire = context.reacquireTransport;
  if (!reacquire) return { failure: "this runner cannot reacquire the device" };
  let last = "the device did not come back";
  while (Date.now() < deadline) {
    context.signal.throwIfAborted();
    try {
      await closeCachedAdb(context.transport);
      await reacquire.call(context, { deadline });
      return { value: await read(await adbFor(context, { deadline })) };
    } catch (error) {
      context.signal.throwIfAborted();
      last = error instanceof Error ? error.message : String(error);
    }
    await pause(Math.min(ADBD_RECONNECT_POLL_MS, Math.max(0, deadline - Date.now())), context.signal);
  }
  return { failure: last };
}

/**
 * `adb root`, `unroot`, `tcpip PORT`, `usb`. adbd restarts and the device
 * usually leaves the USB bus and comes back, so the operation announces that
 * (the runner then keeps it alive through that one disconnect), takes the same
 * device again, reconnects, and checks the state the device itself reports.
 * For `tcpip` and `usb` that state is adbd's EFFECTIVE listener configuration,
 * not just the port `adb tcpip` sets: fixed listener addresses override it.
 */
async function restartAdbd(kind: "root" | "unroot" | "tcpip" | "usb", request: HardwareRequest, context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  const spec = ADBD_RESTARTS[kind];
  const windowMs = restartWindowMs(request);
  let service = spec.service;
  let port: number | undefined;
  if (kind === "tcpip") {
    const raw = request.options?.port;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1024 || raw > 65535) throw new AdbProtocolError("tcpip needs options.port, an integer from 1024 to 65535 (5555 is the usual choice).");
    port = raw;
    service = `tcpip:${port}`;
  }
  let before: AdbTcpListeners | undefined;
  if (kind === "tcpip" || kind === "usb") {
    // Refuse before asking for approval or touching the device when no restart can work.
    before = await readTcpListeners(adb).catch(() => { context.signal.throwIfAborted(); return undefined; });
    const conflict = before && fixedListenerConflict(kind, port, before);
    if (conflict) throw new AdbProtocolError(`adb ${kind === "tcpip" ? `tcpip ${port}` : "usb"} cannot do what it says on this device: ${conflict}. Nothing was changed.`);
  }
  const effects = {
    root: "Restart adbd with root privileges. The ADB connection drops and Cody reconnects. Only debuggable builds allow it.",
    unroot: "Restart adbd without root privileges. The ADB connection drops and Cody reconnects.",
    usb: `Restart adbd in USB mode, turning the legacy TCP/IP listener (adb tcpip) off. The ADB connection drops and Cody reconnects. ${usbApprovalNote(before)}`,
    tcpip: `Restart adbd listening for TCP/IP on port ${port}. The ADB connection drops and Cody reconnects. A browser cannot open raw TCP, so Cody keeps using USB: this is for a PC on the network that will run adb connect to the device.`,
  };
  await context.confirm({ action: `adb.${kind}`, target: service, backup: "not applicable: no device storage is written", details: effects[kind] });
  // The device is about to leave the USB bus on purpose. Say so, so the runner's
  // disconnect handling lets this operation live through it; the exception ends here.
  const endExpectation = context.expectDeviceRestart?.(windowMs);
  try {
    const deadline = Date.now() + windowMs;
    let answer = "";
    let lostReply = false;
    try {
      answer = (await adb.createSocketAndWait(service)).trim();
    } catch (error) {
      context.signal.throwIfAborted();
      // adbd can drop the connection before its reply gets through; the device's own properties settle what happened.
      if (!isConnectionFailure(error)) throw error;
      lostReply = true;
    }
    context.output?.(lostReply ? "(no reply: the connection dropped as adbd restarted)" : answer);
    const restarted = lostReply || spec.restarts.test(answer);
    if (!restarted && !spec.unchanged?.test(answer)) throw new AdbProtocolError(`adbd refused ${service}: ${answer || "no answer"}`);
    if (!restarted) return { summary: `adbd answered "${answer}"; nothing was restarted.`, verified: true, details: { answer, restarted: false } };
    await closeCachedAdb(context.transport);
    const unreachable = (failure: string): HardwareResult => ({
      summary: `${lostReply ? "adbd was asked to restart and its reply never arrived" : `adbd answered "${answer}" and is restarting`}, but Cody could not reconnect to check it (${failure}). If the device re-enumerated, select it again in Devices.`,
      verified: false,
      details: { answer, restarted: true },
    });

    if (kind === "root" || kind === "unroot") {
      const outcome = await reconnectAndRead(context, deadline, async (live) => (await live.getProp("service.adb.root")).trim());
      if ("failure" in outcome) return unreachable(outcome.failure);
      const verified = kind === "root" ? outcome.value === "1" : outcome.value !== "1";
      return {
        summary: verified ? `adbd restarted (${kind}) and the reconnected device confirms it.` : `adbd restarted (${kind}) but the reconnected device does not report the requested state.`,
        verified,
        details: { answer, restarted: true, observed: { "service.adb.root": outcome.value } },
      };
    }
    const outcome = await reconnectAndRead(context, deadline, readTcpListeners);
    if ("failure" in outcome) return unreachable(outcome.failure);
    const problem = listenerProblem(kind, port, outcome.value);
    const { effective, wireless } = outcome.value;
    return {
      summary: problem
        ? `adbd restarted (${kind}) but the reconnected device does not report the requested state: ${problem}.`
        : `adbd restarted (${kind}) and the reconnected device confirms it: ${kind === "usb" ? "no legacy TCP listener, and Wireless debugging is off" : describeListeners(outcome.value)}.`,
      verified: problem === undefined,
      details: { answer, restarted: true, observed: { ...outcome.value.properties, effective: effective ?? null, wireless: wireless ?? null } },
    };
  } finally {
    endExpectation?.();
  }
}

export interface AdbWaitOptions {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly state: "device" | "recovery" | "sideload";
}

/** The banner as adbd sent it: the state, then the properties Cody reads. yume's AdbBanner object has no string form of its own. */
function bannerText(banner: Adb["banner"]): string {
  const properties = [["ro.product.name", banner.product], ["ro.product.model", banner.model], ["ro.product.device", banner.device], ["features", banner.features.join(",")]]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
  return `${banner.state ?? ""}::${properties}`;
}

/** The wait window of an `adb wait-for-device` request; undefined for every other request. */
export function adbWaitOptions(request: HardwareRequest): AdbWaitOptions | undefined {
  if (request.protocol !== "adb" || request.action !== "exec" || request.options?.kind !== "wait-for-device") return undefined;
  const { timeoutSeconds = 60, pollMs = 1000, state = "device" } = request.options;
  if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new AdbProtocolError("wait-for-device timeoutSeconds must be an integer from 1 to 600.");
  if (typeof pollMs !== "number" || !Number.isInteger(pollMs) || pollMs < 100 || pollMs > 5000) throw new AdbProtocolError("wait-for-device pollMs must be an integer from 100 to 5000.");
  if (state !== "device" && state !== "recovery" && state !== "sideload") throw new AdbProtocolError('wait-for-device state must be "device", "recovery", or "sideload".');
  return { timeoutMs: timeoutSeconds * 1000, pollMs, state };
}


/**
 * `adb wait-for-device` (and `-recovery` / `-sideload`): authenticates until the
 * daemon answers in the wanted state or the window ends. ONE deadline covers the
 * whole wait: the runner's lease acquisition (it passes the deadline in
 * `context.deadline`), authentication - a device whose user has not approved the
 * RSA key says nothing until they do - the state queries, and every reacquisition.
 * A reacquisition that fails leaves the previous lease released, so nothing is
 * authenticated on it until a later reacquisition succeeds; the wait therefore
 * recovers whenever the same device is back inside the window.
 */
async function waitForDevice(request: HardwareRequest, context: HardwareContext): Promise<HardwareResult> {
  const wait = adbWaitOptions(request)!;
  const deadline = context.deadline ?? Date.now() + wait.timeoutMs;
  let last = "the device has not answered yet";
  let leased = true;
  for (;;) {
    context.signal.throwIfAborted();
    if (leased) {
      try {
        const adb = await adbFor(context, { deadline });
        const state = adb.banner.state;
        if (state === wait.state) {
          const [model, release] = await Promise.all([adb.getProp("ro.product.model"), adb.getProp("ro.build.version.release")]).catch(() => ["", ""]);
          return { summary: `The device is online (${state})${model ? `: ${model}` : ""}.`, verified: true, details: { state, banner: bannerText(adb.banner), model, androidRelease: release } };
        }
        last = `the device is in ${state ?? "an unknown"} state, waiting for ${wait.state}`;
      } catch (error) {
        context.signal.throwIfAborted();
        last = error instanceof Error ? error.message : String(error);
      }
      await closeCachedAdb(context.transport);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AdbProtocolError(`The device did not reach the ${wait.state} state within ${wait.timeoutMs / 1000} s (${last}).`);
    context.progress({ phase: "adb.wait", message: `Waiting for the device: ${last}` });
    await pause(Math.min(wait.pollMs, remaining), context.signal);
    try {
      await context.reacquireTransport?.({ deadline });
      leased = true;
    } catch (error) {
      context.signal.throwIfAborted();
      leased = false;
      last = error instanceof Error ? error.message : String(error);
    }
  }
}

function operationKind(request: HardwareRequest): string | undefined {
  const kind = request.options?.kind;
  if (kind === undefined) return undefined;
  if (typeof kind !== "string") throw new AdbProtocolError("ADB operation kind must be a string.");
  return kind;
}

export const adbFlasher: Flasher = {
  protocol: "adb",
  actions: ["detect", "exec", "push", "pull", "dump", "monitor", "sideload", "verify", "forward", "reverse", "install"],
  async run(request, context) {
    const leave = await enterAdbHold(context);
    try {
      switch (request.action) {
        case "verify":
          return await verifyWrittenRange(request, context);
        case "sideload":
          return await sideloadAdb(request, context, await adbFor(context));
        case "monitor":
          return await terminal(context);
        case "detect":
          return await detect(context);
        case "pull":
          return await pull(request, context, "pull");
        case "dump":
          return await pull(request, context, "dump");
        case "forward":
          return await forward(request, context);
        case "reverse":
          return await reverse(request, context);
        case "push": {
          const adb = await adbFor(context);
          return await push(request, context, adb);
        }
        case "install":
          return await install(request, context, await adbFor(context));
        case "exec": {
          switch (operationKind(request)) {
            case "reboot":
              return await reboot(request, context, await adbFor(context));
            case "twrp-openrecoveryscript":
              return await queueTwrpOpenRecoveryScript(request, context, await adbFor(context));
            case "reverse-list":
              return await reverseList(context, await adbFor(context));
            case "reverse-remove":
              return await reverseRemove(request, context, await adbFor(context));
            case "reverse-remove-all":
              return await reverseRemoveAll(context, await adbFor(context));
            case "root":
              return await restartAdbd("root", request, context, await adbFor(context));
            case "unroot":
              return await restartAdbd("unroot", request, context, await adbFor(context));
            case "tcpip":
              return await restartAdbd("tcpip", request, context, await adbFor(context));
            case "usb":
              return await restartAdbd("usb", request, context, await adbFor(context));
            case "wait-for-device":
              return await waitForDevice(request, context);
            case undefined:
            case "shell": {
              const command = shellCommand(request, context);
              return await runShellCommand(command, context, await adbFor(context));
            }
            default:
              throw new AdbProtocolError(`Unsupported ADB exec kind '${operationKind(request)}'.`);
          }
        }
        default:
          throw new AdbProtocolError(`ADB does not support '${request.action}'.`);
      }
    } finally {
      await leave();
    }
  },
};
