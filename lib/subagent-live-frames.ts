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

const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);
// Bounds a wrapper whose children vanish without a terminal frame (a crash
// mid-run); a restart or close clears everything anyway.
const MAX_LIVE_SUBAGENTS = 64;

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

  /** Feed every frame the engine emits; frames of other types are ignored. */
  note(frame: F): void {
    if (frame.type === "subagent_lifecycle") {
      const info = lifecycleOf(frame);
      if (!info) return;
      this.lifecycle.delete(info.id);
      if (TERMINAL_STATUSES.has(info.status)) {
        this.progress.delete(info.id);
        return;
      }
      this.lifecycle.set(info.id, frame);
      if (this.lifecycle.size > MAX_LIVE_SUBAGENTS) {
        const oldest = this.lifecycle.keys().next().value;
        if (oldest !== undefined) {
          this.lifecycle.delete(oldest);
          this.progress.delete(oldest);
        }
      }
      return;
    }
    if (frame.type === "subagent_progress") {
      const id = progressIdOf(frame);
      // Progress for a subagent this wrapper never saw start (or saw finish)
      // is left to get_subagents: replaying it could resurrect a chip.
      if (id && this.lifecycle.has(id)) this.progress.set(id, frame);
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
  }
}
