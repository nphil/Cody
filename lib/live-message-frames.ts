import type { PersistedMessageRef } from "./session-reader";
import { isRecord } from "./type-guards";

/**
 * The finished replies and tool results of a chat's current run, replayed by
 * the events route to a page that attaches mid-run (see lib/attach-replay.ts):
 * they fill the gap between the page's transcript read and its subscription.
 *
 * A finished message can be megabytes (a tool result, an image) and the engine
 * has already written it to the session file by the time it matters, so the
 * file, not this memory, is the authority. A frame is held whole only while it
 * is small, or while the file does not have it yet. Over the budget the
 * largest frames the file already holds are reduced to a few bytes naming the
 * message, and the replay reads that message back from the file (through the
 * append-aware parse cache). A frame the file does not hold is never dropped:
 * replaying it is the only way the page can get it.
 *
 * Budgets: LIVE_RUN_RAW_BYTES per run, LIVE_GLOBAL_RAW_BYTES across every
 * running chat. Sizes are counted in characters of the frame's strings and
 * keys, which tracks its serialized size to within a small factor.
 */

/** Finished messages kept per run. */
export const LIVE_FRAME_SLOTS = 8;
/** Whole frames kept per run once they are in the session file. */
export const LIVE_RUN_RAW_BYTES = 256 * 1024;
/** Whole frames kept across all runs together once they are in the session file. */
export const LIVE_GLOBAL_RAW_BYTES = 4 * 1024 * 1024;
/** When to look again at a frame the file did not hold yet (it is written right around the frame). */
const SETTLE_DELAYS_MS = [500, 2_000, 8_000, 30_000];
const MAX_WALK_DEPTH = 64;

export interface PersistedMessages {
  /** Whether the file holds the message. `frameBytes` is the frame's size, for the lookup to size its search by. */
  has(ref: PersistedMessageRef, frameBytes: number): boolean;
  /** The message from the file, ready to send; null when the file does not hold it. */
  read(ref: PersistedMessageRef, frameBytes: number): unknown | null;
}

/** Characters held by a value's strings and keys, plus a small charge per node. */
export function estimateFrameBytes(value: unknown, depth = 0): number {
  if (typeof value === "string") return value.length;
  if (value === null || typeof value !== "object") return 8;
  if (depth >= MAX_WALK_DEPTH) return 8;
  let bytes = 16;
  if (Array.isArray(value)) {
    for (const item of value) bytes += estimateFrameBytes(item, depth + 1);
    return bytes;
  }
  for (const key in value) {
    bytes += key.length + estimateFrameBytes((value as Record<string, unknown>)[key], depth + 1);
  }
  return bytes;
}

function refOf(frame: Record<string, unknown>): PersistedMessageRef | null {
  const message = frame.message;
  if (!isRecord(message)) return null;
  const { role, timestamp, toolCallId } = message;
  if (typeof role !== "string" || typeof timestamp !== "number") return null;
  if (role !== "toolResult") return { role, timestamp };
  return typeof toolCallId === "string" ? { role, timestamp, toolCallId } : null;
}

interface Slot<F> {
  /** The whole frame; null once it was reduced to `shell` + `ref`. */
  frame: F | null;
  /** The frame without its message, kept when it is reduced. */
  shell: F | null;
  /** How the file names the message; null for a frame it can never be matched with (such a frame is always kept whole). */
  ref: PersistedMessageRef | null;
  bytes: number;
}

interface Sheddable {
  readonly rawBytes: number;
  shed(limit: number): void;
  armSettle(): void;
}

const running = new Set<Sheddable>();
let globalRawBytes = 0;

/** Bring the whole server under the global budget: largest holder first. */
function shedGlobally(): void {
  if (globalRawBytes <= LIVE_GLOBAL_RAW_BYTES) return;
  for (const holder of [...running].sort((a, b) => b.rawBytes - a.rawBytes)) {
    if (globalRawBytes <= LIVE_GLOBAL_RAW_BYTES) return;
    holder.shed(Math.max(0, holder.rawBytes - (globalRawBytes - LIVE_GLOBAL_RAW_BYTES)));
  }
  if (globalRawBytes <= LIVE_GLOBAL_RAW_BYTES) return;
  // What is left is not in a session file yet: each holder looks again shortly.
  for (const holder of running) holder.armSettle();
}

/** Counts every live holder's whole frames in `globalRawBytes`; test-only view of it. */
export function __liveRawBytesForTests(): number {
  return globalRawBytes;
}

export class RecentMessageFrames<F extends Record<string, unknown>> implements Sheddable {
  private slots: Slot<F>[] = [];
  private raw = 0;
  private timer: NodeJS.Timeout | undefined;
  private attempt = 0;

  constructor(private readonly persisted: PersistedMessages) {}

  get rawBytes(): number {
    return this.raw;
  }

  /** Note a finished message; only the newest LIVE_FRAME_SLOTS are kept. */
  push(frame: F): void {
    const bytes = estimateFrameBytes(frame);
    this.slots.push({ frame, shell: null, ref: refOf(frame), bytes });
    this.account(bytes);
    running.add(this);
    if (this.slots.length > LIVE_FRAME_SLOTS) {
      const dropped = this.slots.shift();
      if (dropped?.frame) this.account(-dropped.bytes);
    }
    this.attempt = 0;
    this.shed(LIVE_RUN_RAW_BYTES);
    shedGlobally();
  }

  /** The frames to replay, oldest first. A frame reduced earlier is read back from the session file; one the file no longer holds is skipped. */
  snapshot(): F[] {
    const frames: F[] = [];
    for (const slot of this.slots) {
      if (slot.frame) {
        frames.push(slot.frame);
        continue;
      }
      const message = slot.ref && slot.shell ? this.readPersisted(slot.ref, slot.bytes) : null;
      if (message !== null && slot.shell) frames.push({ ...slot.shell, message });
    }
    return frames;
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.attempt = 0;
    this.account(-this.raw);
    this.slots = [];
    running.delete(this);
  }

  /** Reduce the largest frames the session file already holds until the whole ones fit `limit`. */
  shed(limit: number): void {
    if (this.raw <= limit) return;
    const candidates = this.slots.filter((slot) => slot.frame !== null && slot.ref !== null).sort((a, b) => b.bytes - a.bytes);
    for (const slot of candidates) {
      if (this.raw <= limit) break;
      if (slot.ref === null || slot.frame === null || !this.isPersisted(slot.ref, slot.bytes)) continue;
      slot.shell = { ...slot.frame, message: undefined };
      slot.frame = null;
      this.account(-slot.bytes);
    }
    if (this.raw > limit) this.armSettle();
  }

  /** Look again at the frames the file did not hold yet, a few times, so a run that goes quiet does not keep a large one for good. */
  armSettle(): void {
    if (this.timer || this.attempt >= SETTLE_DELAYS_MS.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.attempt += 1;
      this.shed(LIVE_RUN_RAW_BYTES);
      shedGlobally();
    }, SETTLE_DELAYS_MS[this.attempt]);
    this.timer.unref?.();
  }

  private account(delta: number): void {
    this.raw += delta;
    globalRawBytes += delta;
  }

  private isPersisted(ref: PersistedMessageRef, frameBytes: number): boolean {
    try {
      return this.persisted.has(ref, frameBytes);
    } catch {
      return false;
    }
  }

  private readPersisted(ref: PersistedMessageRef, frameBytes: number): unknown | null {
    try {
      return this.persisted.read(ref, frameBytes);
    } catch {
      return null;
    }
  }
}
