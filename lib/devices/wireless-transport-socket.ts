import { createConnection, type Socket } from "node:net";

// ADB host protocol on our private Unix socket; Android LAN traffic is handled
// by the foreground native adb, not by this module.
export class WirelessTransportError extends Error {
  constructor(readonly code: WirelessTransportErrorCode) {
    super(errorText[code]);
    this.name = "WirelessTransportError";
  }
}

const errorText = {
  invalid_address: "Enter the private IPv4 address and port shown on Android's Wireless debugging screen. Legacy port 5555 and ADB server port 5037 are not supported.",
  invalid_code: "Enter the six-digit pairing code shown on Android.",
  unavailable: "Cody's private Wireless ADB program is not available on this server.",
  pairing_failed: "Android did not complete pairing. Open a fresh pairing code and check the pairing address.",
  not_found: "This chat does not have that pairing.",
  busy: "Wireless ADB is already working on this pairing.",
  limit: "The Wireless ADB limit was reached. Disconnect or forget an unused pairing and try again.",
  connection_failed: "Android did not accept an encrypted connection. Check the current connection address on the main Wireless debugging screen.",
  identity_mismatch: "The connected Android device did not report the identity it supplied during pairing. No requested command was run.",
  connection_lost: "The encrypted Android connection ended before Cody could confirm completion.",
  cancelled: "The Wireless ADB request was cancelled.",
  timeout: "The Wireless ADB request timed out.",
  output_limit: "The Wireless ADB output exceeded the requested limit.",
} as const;
export type WirelessTransportErrorCode = keyof typeof errorText;

export function deadline(ms: number, source?: AbortSignal, connection?: AbortSignal): AbortSignal {
  const timer = AbortSignal.timeout(ms);
  return AbortSignal.any([timer, ...(source ? [source] : []), ...(connection ? [connection] : [])]);
}

export function checkAbort(signal: AbortSignal, source?: AbortSignal, connection?: AbortSignal): void {
  if (!signal.aborted) return;
  if (connection?.aborted) throw new WirelessTransportError("connection_lost");
  throw new WirelessTransportError(source?.aborted ? "cancelled" : "timeout");
}

export function openAdbSocket(path: string, signal: AbortSignal): AdbSocket {
  const socket = createConnection({ path });
  const abort = () => socket.destroy();
  socket.on("error", abort);
  socket.once("close", () => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return new AdbSocket(socket);
}

const EMPTY = Buffer.alloc(0);

class AdbSocket {
  private readonly stream: AsyncIterator<Buffer>;
  private unread: Buffer = EMPTY;

  constructor(readonly socket: Socket) {
    this.stream = socket[Symbol.asyncIterator]();
  }

  private async nextChunk(): Promise<Buffer> {
    const { value, done } = await this.stream.next();
    if (done) throw new WirelessTransportError("connection_lost");
    return value;
  }

  async bytes(size: number): Promise<Buffer> {
    if (!size) return EMPTY;
    const first = this.unread.length ? this.unread : await this.nextChunk();
    this.unread = first.length > size ? first.subarray(size) : EMPTY;
    if (first.length >= size) return first.length === size ? first : first.subarray(0, size);

    // Consume the partial frame before waiting for more; a readable event can
    // otherwise keep waking us for the same buffered bytes, starving timers.
    const frame = Buffer.allocUnsafe(size);
    let copied = first.copy(frame);
    while (copied < size) {
      const chunk = await this.nextChunk();
      const used = chunk.copy(frame, copied);
      copied += used;
      if (used < chunk.length) this.unread = chunk.subarray(used);
    }
    return frame;
  }

  destroy(): void {
    this.socket.destroy();
    void this.stream.return?.().catch(() => { /* socket has already closed */ });
  }
}

export async function request(peer: AdbSocket, service: string): Promise<void> {
  const { socket } = peer;
  const data = Buffer.from(service, "utf8");
  if (data.length > 0xffff) throw new WirelessTransportError("limit");
  socket.cork();
  socket.write(data.length.toString(16).padStart(4, "0"));
  socket.write(data);
  socket.uncork();
  if ((await peer.bytes(4)).toString("ascii") !== "OKAY") throw new WirelessTransportError("connection_lost");
}

export async function response(peer: AdbSocket): Promise<string> {
  const hex = (await peer.bytes(4)).toString("latin1");
  if (!/^[a-fA-F0-9]{4}$/.test(hex)) throw new WirelessTransportError("connection_lost");
  const length = Number.parseInt(hex, 16);
  if (length > 8_192) throw new WirelessTransportError("output_limit");
  return (await peer.bytes(length)).toString("utf8");
}

export async function query(path: string, service: string, signal: AbortSignal): Promise<string> {
  const socket = openAdbSocket(path, signal);
  try {
    await request(socket, service);
    return await response(socket);
  } finally {
    socket.destroy();
  }
}

export interface WirelessRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdin?: Buffer;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface WirelessRunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

async function writeStdin(socket: Socket, input?: Buffer): Promise<void> {
  const write = (kind: number, data?: Buffer) => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const header = Buffer.alloc(5);
    header[0] = kind;
    header.writeUInt32LE(data?.length ?? 0, 1);
    const flushed = (error?: Error | null) => error ? reject(error) : resolve();
    if (data) {
      socket.cork();
      socket.write(header);
      socket.write(data, flushed);
      socket.uncork();
    } else socket.write(header, flushed);
    return promise;
  };
  if (input) {
    for (let offset = 0; offset < input.length; offset += 65_536) {
      await write(0, input.subarray(offset, offset + 65_536));
    }
  }
  await write(4); // ADB shell-v2 close stdin, not a transport half-close.
}

const MAX_FRAME = 1024 * 1024; // AOSP MAX_PAYLOAD; don't enlarge the Unix receive buffer further.
const MAX_OUTPUT_FRAMES = 16_384; // Bound overhead even for hostile one-byte frames.

export async function shell(path: string, transportId: string, command: string, options: WirelessRunOptions & { maxOutputBytes: number }, signal: AbortSignal): Promise<WirelessRunResult> {
  const socket = openAdbSocket(path, signal);
  let writing: Promise<void> | undefined;
  try {
    await request(socket, `host:transport-id:${transportId}`);
    await request(socket, `shell,v2,raw:${command}`);
    writing = writeStdin(socket.socket, options.stdin).catch(() => { /* the read side reports link loss */ });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0, stdoutSize = 0, stderrSize = 0, frames = 0;
    for (;;) {
      const header = await socket.bytes(5);
      const kind = header[0];
      const length = header.readUInt32LE(1);
      // ADB CLI conflates exit status 1 with a dropped link. Only an actual
      // shell-v2 exit packet proves the remote command finished.
      if (kind === 3 && length === 1) {
        const status = await socket.bytes(length);
        return {
          stdout: stdout.length === 1 ? stdout[0] : Buffer.concat(stdout, stdoutSize),
          stderr: stderr.length === 1 ? stderr[0] : Buffer.concat(stderr, stderrSize),
          exitCode: status[0],
        };
      }
      if (kind !== 1 && kind !== 2) throw new WirelessTransportError("connection_lost");
      if (!length || length > MAX_FRAME || length > options.maxOutputBytes - size || ++frames > MAX_OUTPUT_FRAMES) {
        throw new WirelessTransportError("output_limit");
      }
      const data = await socket.bytes(length);
      size += length;
      if (kind === 1) {
        stdout.push(data);
        stdoutSize += length;
        options.onStdout?.(data);
      } else {
        stderr.push(data);
        stderrSize += length;
        options.onStderr?.(data);
      }
    }
  } finally {
    socket.destroy();
    await writing;
  }
}
