/**
 * The live helper roster as the engine's own frames last described it: the
 * newest `subagent_lifecycle` and `subagent_progress` frame of every subagent
 * that has started and not reached a terminal status yet.
 *
 * The events route replays these to a page that attaches mid-run, so its
 * helper panel paints the moment the stream opens. The `get_subagents` read
 * the page also makes still runs and reconciles; it just no longer gates the
 * panel, because a busy engine answers it seconds late.
 */

import { estimateFrameBytes } from "./live-message-frames";

const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);
// Bounds a wrapper whose children vanish without a terminal frame (a crash
// mid-run); a restart or close clears everything anyway.
const MAX_LIVE_SUBAGENTS = 64;
/** One replayed frame, and the whole roster, in characters (see estimateFrameBytes). */
export const LIVE_SUBAGENT_FRAME_BYTES = 64 * 1024;
export const LIVE_SUBAGENT_TOTAL_BYTES = 1024 * 1024;

interface SubagentFrame {
  type?: unknown;
  payload?: unknown;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function lifecycleOf(frame: SubagentFrame): { id: string; status: string } | null {
  const payload = recordOf(frame.payload);
  const id = payload?.id;
  const status = payload?.status;
  return typeof id === "string" && id && typeof status === "string" ? { id, status } : null;
}

function progressIdOf(frame: SubagentFrame): string | null {
  const id = recordOf(recordOf(frame.payload)?.progress)?.id;
  return typeof id === "string" && id ? id : null;
}

export class LiveSubagentFrames<F extends SubagentFrame> {
  private readonly lifecycle = new Map<string, F>();
  private readonly progress = new Map<string, F>();
  private readonly sizes = new Map<F, number>();
  private bytes = 0;

  /** Feed every frame the engine emits; frames of other types are ignored. */
  note(frame: F): void {
    if (frame.type === "subagent_lifecycle") {
      const info = lifecycleOf(frame);
      if (!info) return;
      this.forget(this.lifecycle, info.id);
      if (TERMINAL_STATUSES.has(info.status)) {
        this.forget(this.progress, info.id);
        return;
      }
      this.keep(this.lifecycle, info.id, frame);
      return;
    }
    if (frame.type === "subagent_progress") {
      const id = progressIdOf(frame);
      // Progress for a subagent this wrapper never saw start (or saw finish)
      // is left to get_subagents: replaying it could resurrect a chip.
      if (id && this.lifecycle.has(id)) {
        this.forget(this.progress, id);
        this.keep(this.progress, id, frame);
      }
    }
  }

  /** The frames to replay to a newly attached page: every live subagent's
   * lifecycle frame, then its latest progress frame. */
  snapshot(): F[] {
    const frames = [...this.lifecycle.values()];
    for (const id of this.lifecycle.keys()) {
      const latest = this.progress.get(id);
      if (latest) frames.push(latest);
    }
    return frames;
  }

  clear(): void {
    this.lifecycle.clear();
    this.progress.clear();
    this.sizes.clear();
    this.bytes = 0;
  }

  /** Hold `frame` unless it alone is over the per-frame budget (get_subagents
   * covers a helper whose frame is not here), then bring the roster back under
   * its count and byte budgets by dropping the longest-running helper first. */
  private keep(into: Map<string, F>, id: string, frame: F): void {
    const size = estimateFrameBytes(frame);
    if (size > LIVE_SUBAGENT_FRAME_BYTES) {
      // A helper without its lifecycle frame is not replayed at all.
      if (into === this.lifecycle) this.forget(this.progress, id);
      return;
    }
    into.set(id, frame);
    this.sizes.set(frame, size);
    this.bytes += size;
    while (this.lifecycle.size > MAX_LIVE_SUBAGENTS || this.bytes > LIVE_SUBAGENT_TOTAL_BYTES) {
      const oldest = this.lifecycle.keys().next().value;
      if (oldest === undefined) break;
      this.forget(this.lifecycle, oldest);
      this.forget(this.progress, oldest);
    }
  }

  private forget(from: Map<string, F>, id: string): void {
    const frame = from.get(id);
    if (frame === undefined) return;
    from.delete(id);
    this.bytes -= this.sizes.get(frame) ?? 0;
    this.sizes.delete(frame);
  }
}
