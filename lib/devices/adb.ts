import { Adb, AdbCommand, AdbDaemonTransport, AdbPacket, AdbPacketSerializeStream, calculateChecksum, type AdbPacketData, type AdbPacketInit } from "@yume-chan/adb";
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
import { hashFirmware, normalizeSha256, sha256Blob } from "./hardware-safety";

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
const writable = new Consumable.WritableStream<AdbPacketInit>({
  async write(packet) {
    if (outputFailure !== undefined) throw outputFailure;
    await serializerWriter.write(new Consumable(packet));
    if (outputFailure !== undefined) throw outputFailure;
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
async function adbFor(context: HardwareContext): Promise<Adb> {
  const existing = adbSessions.get(context.transport);
  if (existing) return existing;

  let initialProbeFailed = false;
    const connection = createAdbHardwareConnection(context.transport, context.signal, () => { initialProbeFailed = true; });
  const pending = AdbDaemonTransport.authenticate({
    serial: "cody-browser",
    connection,
    credentialStore: credentials(),
  }).then((transport) => new Adb(transport));
  adbSessions.set(context.transport, pending);
  try {
    const adb = await pending;
    void adb.disconnected.then(() => {
      adbSessions.delete(context.transport);
    });
    return adb;
  } catch (error) {
    adbSessions.delete(context.transport);
    const message = error instanceof Error ? error.message : String(error);
    if (initialProbeFailed || message.includes("bounded initial protocol probe")) { const existing = await attachExistingDaemon(context);
    if (existing) {
      const restored = Promise.resolve(existing);
      adbSessions.set(context.transport, restored);
      void existing.disconnected.then(() => adbSessions.delete(context.transport));
      return existing;
    } }
    throw new AdbProtocolError(
      `ADB connection was not established: ${message}. If the device displays a new Cody RSA authorization prompt, approve it and run a fresh operation; screenless devices do not auto-authorize a new key.`,
    );
  }
}

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
const EXISTING_DAEMON_PROBE_ID = 0x43504459;
const EXISTING_DAEMON_PROBE_MS = 5_000;

function adbPacket(command: number, arg0: number, arg1: number, payload: Uint8Array): AdbPacketInit {
  return { command, arg0, arg1, payload, checksum: calculateChecksum(payload), magic: command ^ -1 };
}

async function attachExistingDaemon(context: HardwareContext): Promise<Adb | undefined> { const controller = new AbortController();
const abortFromContext = () => controller.abort(context.signal.reason);
if (context.signal.aborted) abortFromContext();
else context.signal.addEventListener("abort", abortFromContext, { once: true });
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
  context.signal.removeEventListener("abort", abortFromContext);
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
    const result = await shell.spawnWaitText(["sh", "-c", wrapped]);
    stdout = result.stdout;
    stderr = result.stderr;
  } else {
    stdout = await adb.subprocess.noneProtocol.spawnWaitText(["sh", "-c", wrapped]);
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

async function readBlob(stream: AdbReadableStream<Uint8Array>): Promise<Blob> {
  const reader = stream.getReader();
  const chunks: BlobPart[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const copy = new Uint8Array(next.value.byteLength);
      copy.set(next.value);
      chunks.push(copy);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks);
}

async function pullRemote(adb: Adb, path: string): Promise<Blob> {
  const sync = await adb.sync();
  try {
    return await readBlob(sync.read(path));
  } finally {
    await sync.dispose();
  }
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
  const fileId = await context.save(`adb-escrow-${safeDownloadName(target, "destination.bin")}`, await pullRemote(adb, target));
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

function stagingIo(adb: Adb, capabilities: ShellCapabilities): AdbStagingIo {
  return {
    writeFile: (path, data) => pushRemote(adb, path, data),
    exists: (path) => remoteExists(adb, path),
    length: (path) => remoteLength(adb, path),
    sha256: (path) => remoteSha256(adb, capabilities, path),
    makeDirectory: (path) => shell(adb, `mkdir -p ${shQuote(path)}`, `Creating staging directory '${path}'`).then(() => undefined),
    async concatenate(parts, destination) {
      await shell(adb, `: > ${shQuote(destination)}`, `Creating staged aggregate '${destination}'`);
      for (const part of parts) {
        await shell(adb, `cat ${shQuote(part)} >> ${shQuote(destination)}`, `Appending staged chunk '${part}'`);
      }
    },
    moveReplace: (source, destination) => shell(adb, `mv -f ${shQuote(source)} ${shQuote(destination)}`, `Atomically replacing '${destination}'`).then(() => undefined),
  };
}



async function reconnectStaging(context: HardwareContext): Promise<AdbStagingIo> {
  const reacquire = context.reacquireTransport;
  if (!reacquire) {
    throw new AdbProtocolError("ADB transport disconnected. This runner cannot reacquire the exclusive hardware lease; start a fresh operation to resume from verified chunks.");
  }
  const previousTransport = context.transport;
  await closeCachedAdb(previousTransport);
  await reacquire.call(context);
  const adb = await adbFor(context);
  return stagingIo(adb, await shellCapabilities(adb));
}



function literalReadOnlyShellCommand(request: HardwareRequest): string {
  const command = request.command;
  if (!command?.trim()) throw new AdbProtocolError("ADB shell requires a non-empty command.");
  if (!/^(?:id|uname -a|df -h|getprop(?: ro\.[A-Za-z0-9_.-]+)?)$/.test(command)) {
    throw new AdbProtocolError("ADB shell supports only literal read-only diagnostics: id, uname -a, df -h, or getprop [ro.*].");
  }
  return command;
}

async function runShellCommand(command: string, context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  await context.confirm({ action: "adb.shell", target: command, backup: "not applicable: shell command" });
  const output = await shell(adb, command, "ADB shell command");
  return { summary: "ADB shell command completed.", details: { output } };
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

async function push(request: HardwareRequest, context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  const target = requireTarget(request);
  rejectRawStorageTarget(target);
  if (!context.input) throw new AdbProtocolError("ADB push requires an operation input file.");
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
  rejectRawStorageTarget(target);
  const adb = await adbFor(context);
  const data = await pullRemote(adb, target);
  const sha256 = await sha256Blob(data);
  const name = typeof request.options?.name === "string" ? request.options.name : safeDownloadName(target, action === "dump" ? "dump.bin" : "pull.bin");
  const fileId = await context.save(name, data);
  context.progress({ phase: `adb.${action}.verified`, completed: data.size, total: data.size });
  return { summary: `ADB ${action} completed.`, verified: true, sha256, fileId, details: { target, length: data.size } };
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
      banner: String(adb.banner),
      model,
      device,
      androidRelease: release,
      shellProtocol: adb.subprocess.shellProtocol !== undefined,
      sync: true,
      resumablePush: "requires sh, cat, mv, mkdir, wc, test, and sha256sum/toybox/busybox on target",
    },
  };
}

function operationKind(request: HardwareRequest): string | undefined {
  const kind = request.options?.kind;
  if (kind === undefined) return undefined;
  if (typeof kind !== "string") throw new AdbProtocolError("ADB operation kind must be a string.");
  return kind;
}

export const adbFlasher: Flasher = {
  protocol: "adb",
  actions: ["detect", "exec", "push", "pull", "dump"],
  async run(request, context) {
    try {
      switch (request.action) {
        case "detect":
          return detect(context);
        case "pull":
          return pull(request, context, "pull");
        case "dump":
          return pull(request, context, "dump");
        case "push": {
          const adb = await adbFor(context);
          return push(request, context, adb);
        }
        case "exec": {
          switch (operationKind(request)) {
            case "reboot":
              return reboot(request, context, await adbFor(context));
            case "twrp-openrecoveryscript":
              return queueTwrpOpenRecoveryScript(request, context, await adbFor(context));
            case undefined:
            case "shell": {
              const command = literalReadOnlyShellCommand(request);
              return runShellCommand(command, context, await adbFor(context));
            }
            default:
              throw new AdbProtocolError(`Unsupported ADB exec kind '${operationKind(request)}'.`);
          }
        }
        default:
          throw new AdbProtocolError(`ADB does not support '${request.action}'.`);
      }
    } finally {
      await closeCachedAdb(context.transport);
    }
  },
};
