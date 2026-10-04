import type { HardwareTransport } from "./flasher";
import { throwIfAborted } from "./serial";

/**
 * How much a single bulk-IN request asks for. It is the SAME number for the whole
 * lease on purpose: the browser transport remembers the largest length ever
 * requested on an endpoint and keeps asking for that much, so a later, smaller
 * request can be answered with MORE bytes than it named (a bulk transfer ends at
 * a short packet or at its length, whichever comes first, and a message whose
 * size is a multiple of the packet size has no short packet unless the sender
 * adds a zero-length one). `EdlLink` therefore never trusts "the read returned
 * what I asked for": it owns a buffer, hands out exactly what the protocol needs,
 * and keeps the rest for the next message.
 */
export const EDL_READ_REQUEST_BYTES = 64 * 1024;
/** Bulk-OUT pieces. A multiple of every USB bulk packet size (512, 1024), so no piece but the last ends in a short packet. */
export const EDL_WRITE_CHUNK_BYTES = 64 * 1024;
/** The most unconsumed input the link will hold. Protocol layers consume as they go; hitting this is a device that talks without being listened to. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Consecutive empty reads (zero-length packets) tolerated before the device is called unresponsive. */
const MAX_CONSECUTIVE_EMPTY_READS = 5_000;
const MAX_TRANSPORT_TIMEOUT_MS = 60_000;

/**
 * Every wait in the EDL layer, in milliseconds. A mutable object only so tests
 * can shorten the waits of the failure paths; nothing else writes to it.
 */
export const edlTimeouts = {
  /** A Sahara packet from the boot ROM, which answers in milliseconds. */
  packet: 5_000,
  /** The boot ROM's verdict on a loader: it authenticates before it answers. */
  authentication: 20_000,
  /** A Firehose command that only reads or reports. */
  command: 15_000,
  /** `configure` initializes the storage. */
  configure: 30_000,
  /** The first answer to a `read`. */
  firstAnswer: 30_000,
  /** The longest quiet stretch in the middle of raw sector data. */
  dataInactivity: 20_000,
  /** How long to listen to a programmer's startup text. */
  greeting: 3_000,
  /** How long a `nop` is given to produce any answer at all. */
  nop: 5_000,
  /** The first look at a device that may already have something to say. */
  firstContact: 1_000,
  /** How long a device probed with a Firehose `nop` or a Sahara reset gets to react. */
  probe: 2_500,
  /** Silence that ends a programmer's startup text. */
  greetingQuiet: 500,
  /** Silence that ends its answer to a `nop` (which has no closing marker). */
  nopQuiet: 600,
  /** The longest a device may keep sending while its in-flight data is being cleared away, however quietly it dribbles. */
  drain: 15_000,
  /** The programmer's verdict on a block it was sent: it programs flash before it answers. */
  writeAck: 60_000,
  /** One `erase` command (at most 32 MiB of sectors): flash erases are slow. */
  erase: 120_000,
  /** After a cancel, how long the block in flight may take to finish before the transfer is cut. */
  cancelGrace: 10_000,
};

export type EdlErrorKind =
  /** The device did not answer in time. */
  | "timeout"
  /** The device said something the protocol does not allow. */
  | "protocol"
  /** The device (or its boot ROM / programmer) refused something, with its own reason. */
  | "rejected"
  /** Cody refused to do it, before anything was sent. */
  | "refused";

export class EdlError extends Error {
  constructor(message: string, readonly kind: EdlErrorKind = "protocol") {
    super(message);
    this.name = "EdlError";
  }
}

/**
 * A buffered duplex byte pipe over one lease's bulk endpoints. It also remembers
 * where each USB transfer ended: a protocol that frames its messages by transfer
 * (Firehose does: an XML answer is one transfer, raw sector data follows in the
 * next) can ask how many bytes of the SAME transfer follow a given point.
 */
export class EdlLink {
  private buffer = new Uint8Array(2 * EDL_READ_REQUEST_BYTES);
  private start = 0;
  private end = 0;
  /** Absolute stream offset of `buffer[start]`. */
  private position = 0;
  /** Absolute stream offsets at which a read completed, ascending. */
  private transferEnds: number[] = [];
  private received = 0;
  private sent = 0;

  private activeSignal: AbortSignal;

  constructor(readonly transport: HardwareTransport, signal: AbortSignal) {
    this.activeSignal = signal;
  }

  /** The signal that ends this link's transfers right now. */
  get signal(): AbortSignal { return this.activeSignal; }

  /**
   * Runs `body` with `signal` ending the link's transfers instead of the operation's
   * own, and puts the operation's back afterwards. A write phase uses it so that a
   * cancel waits for the block in flight to finish instead of cutting a raw transfer
   * in two (a programmer left waiting for the rest of a block takes the next command
   * it is sent for sector data).
   */
  async using<T>(signal: AbortSignal, body: () => Promise<T>): Promise<T> {
    const outer = this.activeSignal;
    this.activeSignal = signal;
    try {
      return await body();
    } finally {
      this.activeSignal = outer;
    }
  }

  /** Bytes received from the device so far, whether or not they were consumed. */
  get bytesReceived(): number { return this.received; }
  /** Bytes handed to the device so far. */
  get bytesSent(): number { return this.sent; }
  /** Unconsumed input. */
  get buffered(): number { return this.end - this.start; }

  /** The unconsumed input as a view. It is valid only until the next `pull`, `read`, `consume` or `drain`. */
  view(): Uint8Array { return this.buffer.subarray(this.start, this.end); }

  consume(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.buffered) throw new EdlError(`Cannot consume ${count} of ${this.buffered} buffered bytes.`);
    this.start += count;
    this.position += count;
    if (this.start === this.end) { this.start = 0; this.end = 0; }
    let dropped = 0;
    while (dropped < this.transferEnds.length && this.transferEnds[dropped]! <= this.position) dropped += 1;
    if (dropped > 0) this.transferEnds.splice(0, dropped);
  }

  /**
   * How many bytes follow buffered offset `offset` within the transfer that
   * delivered the byte just before it (0 when that transfer ended exactly there).
   */
  restOfTransferAfter(offset: number): number {
    const at = this.position + offset;
    const ends = this.transferEnds.find((value) => value >= at);
    return ends === undefined ? 0 : ends - at;
  }

  /**
   * One read from the device. Returns how many bytes it added (0 for a
   * zero-length packet) or `null` when nothing arrived in `timeoutMs`.
   */
  async pull(timeoutMs: number): Promise<number | null> {
    throwIfAborted(this.activeSignal);
    const wait = Math.max(1, Math.min(MAX_TRANSPORT_TIMEOUT_MS, Math.ceil(timeoutMs)));
    const chunk = await this.transport.read(EDL_READ_REQUEST_BYTES, wait, this.activeSignal);
    throwIfAborted(this.activeSignal);
    if (!chunk) return null;
    if (chunk.byteLength === 0) return 0;
    if (this.buffered + chunk.byteLength > MAX_BUFFERED_BYTES) throw new EdlError("The device sent far more data than the protocol allows at this point.");
    this.append(chunk);
    this.received += chunk.byteLength;
    this.transferEnds.push(this.position + this.buffered);
    return chunk.byteLength;
  }

  /** Waits until at least `count` bytes are buffered. */
  async fill(count: number, timeoutMs: number, label: string): Promise<void> {
    const until = Date.now() + timeoutMs;
    let empty = 0;
    while (this.buffered < count) {
      const remaining = until - Date.now();
      if (remaining <= 0) throw new EdlError(`${label} timed out with ${this.buffered} of ${count} byte(s) received.`, "timeout");
      const added = await this.pull(remaining);
      if (added === 0) {
        empty += 1;
        if (empty > MAX_CONSECUTIVE_EMPTY_READS) throw new EdlError(`${label}: the device sent nothing but empty packets.`, "protocol");
      } else if (added !== null) empty = 0;
    }
  }

  /** Exactly `count` bytes, as a copy the caller may keep. */
  async read(count: number, timeoutMs: number, label: string): Promise<Uint8Array> {
    if (!Number.isSafeInteger(count) || count < 0) throw new EdlError(`${label}: a read of ${count} byte(s) is not possible.`);
    await this.fill(count, timeoutMs, label);
    const out = this.buffer.slice(this.start, this.start + count);
    this.consume(count);
    return out;
  }

  /** Up to `max` bytes, as soon as any are available (raw sector data). */
  async readSome(max: number, timeoutMs: number, label: string): Promise<Uint8Array> {
    if (!Number.isSafeInteger(max) || max <= 0) throw new EdlError(`${label}: a read of ${max} byte(s) is not possible.`);
    await this.fill(1, timeoutMs, label);
    const count = Math.min(max, this.buffered);
    const out = this.buffer.slice(this.start, this.start + count);
    this.consume(count);
    return out;
  }

  /** Writes to the device in bulk-sized pieces; stops at once when the operation is cancelled. */
  async write(bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.byteLength; offset += EDL_WRITE_CHUNK_BYTES) {
      throwIfAborted(this.activeSignal);
      const piece = bytes.subarray(offset, Math.min(bytes.byteLength, offset + EDL_WRITE_CHUNK_BYTES));
      await this.transport.write(piece, this.activeSignal);
      this.sent += piece.byteLength;
    }
  }

  /** A zero-length packet: the end of a bulk transfer whose length is a multiple of the packet size. */
  async writeZlp(): Promise<void> {
    throwIfAborted(this.activeSignal);
    await this.transport.write(new Uint8Array(0), this.activeSignal);
  }

  /**
   * Throws away whatever the device had in flight (the unread end of a cancelled
   * transfer) until it has been quiet for `quietMs`. A device that never stops is
   * reported instead of drained for ever, whether it sends data (the byte limit),
   * a stream of empty packets (the empty-packet limit, as for `fill`), or a trickle
   * that stays under both (the absolute deadline, `edlTimeouts.drain`).
   */
  async drain(quietMs: number, maxBytes: number): Promise<number> {
    const deadline = Date.now() + edlTimeouts.drain;
    let discarded = this.buffered;
    this.consume(this.buffered);
    let empty = 0;
    for (;;) {
      const added = await this.pull(quietMs);
      if (added === null) return discarded;
      if (added === 0) {
        empty += 1;
        if (empty > MAX_CONSECUTIVE_EMPTY_READS) throw new EdlError("The device keeps sending empty packets and never goes quiet, so what it had in flight cannot be cleared. Unplug it and put it into EDL mode again.", "protocol");
      } else {
        empty = 0;
      }
      discarded += added;
      this.consume(this.buffered);
      if (discarded > maxBytes) throw new EdlError(`The device keeps sending data nobody asked for (${discarded} bytes discarded). Unplug it and put it into EDL mode again.`, "protocol");
      if (Date.now() > deadline) throw new EdlError(`The device is still sending after ${edlTimeouts.drain} ms (${discarded} bytes discarded) and never goes quiet, so what it had in flight cannot be cleared. Unplug it and put it into EDL mode again.`, "timeout");
    }
  }

  private append(chunk: Uint8Array): void {
    if (this.end + chunk.byteLength > this.buffer.byteLength) {
      const live = this.end - this.start;
      if (live + chunk.byteLength > this.buffer.byteLength) {
        let size = this.buffer.byteLength;
        while (size < live + chunk.byteLength) size *= 2;
        const grown = new Uint8Array(size);
        grown.set(this.buffer.subarray(this.start, this.end));
        this.buffer = grown;
      } else {
        this.buffer.copyWithin(0, this.start, this.end);
      }
      this.start = 0;
      this.end = live;
    }
    this.buffer.set(chunk, this.end);
    this.end += chunk.byteLength;
  }
}
