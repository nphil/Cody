// Live output of a running tool call (a build, a test run, a worker job): the
// last few lines a command prints, kept OUTSIDE the transcript.
//
// omp streams `tool_execution_update` frames while a call runs. For `bash` each
// frame carries the output so far (up to 50 KB, head and tail with the middle
// elided), about 1 frame/s for a quiet build and ~13/s for a chatty one. This
// module turns that into a bounded tail:
//   - `slimToolUpdateFrame` + `ToolUpdateThrottle` run on the server, so a phone
//     is sent ~8 KB at most 4 times a second instead of 50 KB 13 times a second;
//   - `LiveToolOutputStore` runs in the browser: a few entries, each at most
//     `LIVE_TAIL_LINES` short lines, notifying its listeners at most 4 times a
//     second. It is never written to the transcript cache and the model never
//     sees it.

import { isRecord } from "./type-guards";

/** Lines kept per running call (the card shows fewer until expanded). */
export const LIVE_TAIL_LINES = 24;
/** One line is cut here, so a progress bar or minified bundle cannot widen a card. */
export const LIVE_LINE_CHARS = 240;
/** The longest text the server forwards for one update (the tail of omp's preview). */
export const LIVE_SLIM_TEXT_CHARS = 8192;
/** A call that finishes sooner than this never shows a tail: a quick `ls` must not flash a box. */
export const LIVE_SHOW_AFTER_MS = 1200;
/** Listeners hear about changes at most this often, on both sides of the wire. */
export const LIVE_NOTIFY_MS = 250;
/** Entries kept at once; the oldest finished one goes first. */
export const LIVE_MAX_ENTRIES = 12;
/** A finished background job keeps its last lines this long, then its tail goes (its result is in the transcript). */
export const LIVE_FINISHED_LINGER_MS = 8000;
const ENDED_MEMORY = 64;

/** `1m 05s` style clock for a running call (shared by the status line, the tail and helper chips). */
export function formatToolElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${totalSeconds}s`;
}

// CSI sequences (colors, cursor moves), OSC strings (titles, hyperlinks) and any
// other control byte except tab: a build's colored output must read as text.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** The text of a partial tool result (its first text block), or "" when it has none. */
export function partialResultText(partialResult: unknown): string {
  if (!isRecord(partialResult) || !Array.isArray(partialResult.content)) return "";
  for (const block of partialResult.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

/** The newest lines of a command's output: colors stripped, a `\r`-redrawn line
 * reduced to its last draw, blank lines dropped, each line clamped. */
export function tailLines(text: string, max: number = LIVE_TAIL_LINES): string[] {
  if (!text) return [];
  // Only the end matters, and omp's own text can be 50 KB: never scan more than needed.
  const window = text.length > LIVE_SLIM_TEXT_CHARS * 2 ? text.slice(-LIVE_SLIM_TEXT_CHARS * 2) : text;
  const out: string[] = [];
  const rows = window.replace(ANSI, "").split("\n");
  for (let index = rows.length - 1; index >= 0 && out.length < max; index -= 1) {
    let row = rows[index];
    const redraw = row.lastIndexOf("\r");
    if (redraw !== -1) {
      const last = row.slice(redraw + 1);
      row = last.trim() ? last : row.slice(0, redraw).split("\r").filter((part) => part.trim()).pop() ?? "";
    }
    row = row.replace(CONTROL, "").replace(/\t/g, "  ").trimEnd();
    if (!row.trim()) continue;
    out.push(row.length > LIVE_LINE_CHARS ? `${row.slice(0, LIVE_LINE_CHARS - 1)}…` : row);
  }
  return out.reverse();
}

/** `details.async` of a backgrounded call's frame: the job keeps streaming after the call itself returned. */
export interface LiveAsyncState {
  state: string;
  jobId?: string;
}

export function asyncStateOf(partialResult: unknown): LiveAsyncState | undefined {
  if (!isRecord(partialResult) || !isRecord(partialResult.details)) return undefined;
  const raw = partialResult.details.async;
  if (!isRecord(raw) || typeof raw.state !== "string") return undefined;
  return { state: raw.state, ...(typeof raw.jobId === "string" ? { jobId: raw.jobId } : {}) };
}

/** True once a backgrounded job has stopped (completed, failed, cancelled...). */
export function asyncFinished(state: LiveAsyncState | undefined): boolean {
  return state !== undefined && state.state !== "running" && state.state !== "pending" && state.state !== "started";
}

// ---------------------------------------------------------------- server side

/** The tail of `text` no longer than `max` chars, starting on a line boundary. */
export function capTextTail(text: string, max: number = LIVE_SLIM_TEXT_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const newline = cut.indexOf("\n");
  return newline === -1 || newline > cut.length - 2 ? cut : cut.slice(newline + 1);
}

/** What the browser needs from a `tool_execution_update`: the call, the newest
 * output text and a backgrounded job's state. The command, omp's trace and the
 * rest of the details stay behind. */
export function slimToolUpdateFrame<T extends Record<string, unknown>>(frame: T): T {
  const text = capTextTail(partialResultText(frame.partialResult));
  const async = asyncStateOf(frame.partialResult);
  const { args: _args, partialResult: _partial, ...rest } = frame;
  void _args;
  void _partial;
  return {
    ...rest,
    partialResult: { content: [{ type: "text", text }], ...(async ? { details: { async } } : {}) },
  } as unknown as T;
}

/** Per call, at most one frame every `intervalMs`: the first goes at once, newer
 * ones replace the waiting one and go when the interval is up. A finished
 * background job's frame goes immediately (the state change must not wait), and
 * `settle` drops what is waiting for a call that ended (its result says it all). */
export class ToolUpdateThrottle {
  private readonly lastSent = new Map<string, number>();
  private readonly waiting = new Map<string, { frame: Record<string, unknown>; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly send: (frame: Record<string, unknown>) => void,
    private readonly intervalMs: number = LIVE_NOTIFY_MS,
    private readonly now: () => number = Date.now,
  ) {}

  push(frame: Record<string, unknown>): void {
    const id = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
    if (!id) {
      this.send(slimToolUpdateFrame(frame));
      return;
    }
    const at = this.now();
    const due = (this.lastSent.get(id) ?? Number.NEGATIVE_INFINITY) + this.intervalMs;
    const pending = this.waiting.get(id);
    if (asyncFinished(asyncStateOf(frame.partialResult)) || at >= due) {
      clearTimeout(pending?.timer);
      this.waiting.delete(id);
      this.emit(id, frame, at);
      return;
    }
    if (pending) {
      pending.frame = frame;
      return;
    }
    const timer = setTimeout(() => {
      const held = this.waiting.get(id);
      this.waiting.delete(id);
      if (held) this.emit(id, held.frame, this.now());
    }, Math.max(0, due - at));
    timer.unref?.();
    this.waiting.set(id, { frame, timer });
  }

  /** The call ended: nothing more is sent for it, and its bookkeeping goes. */
  settle(toolCallId: string): void {
    clearTimeout(this.waiting.get(toolCallId)?.timer);
    this.waiting.delete(toolCallId);
    this.lastSent.delete(toolCallId);
  }

  dispose(): void {
    for (const { timer } of this.waiting.values()) clearTimeout(timer);
    this.waiting.clear();
    this.lastSent.clear();
  }

  private emit(id: string, frame: Record<string, unknown>, at: number): void {
    // A background job's frames outlive its call; the map must still stay small.
    if (this.lastSent.size > 256) this.lastSent.clear();
    this.lastSent.set(id, at);
    this.send(slimToolUpdateFrame(frame));
  }
}

// ---------------------------------------------------------------- browser side

export interface LiveToolEntry {
  id: string;
  name: string;
  startedAt: number;
  /** Set once the call stopped (a finished background job keeps its last lines). */
  endedAt?: number;
  /** Newest output lines, oldest first. */
  lines: string[];
  /** A non-bash call's own status line (omp's gh watch, Cody's worker job). */
  headline?: string;
  async?: LiveAsyncState;
  /** Past the "quick call" threshold: the card may draw the tail. */
  shown: boolean;
}

type Listener = () => void;

/** The tail of every running call of ONE chat. A plain external store: a card
 * subscribes to its own id only, so a frame re-renders that card and nothing else. */
export class LiveToolOutputStore {
  private readonly entries = new Map<string, LiveToolEntry>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly revealTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ended: string[] = [];
  private readonly dirty = new Set<string>();
  private cooldown: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly notifyMs: number = LIVE_NOTIFY_MS,
    private readonly showAfterMs: number = LIVE_SHOW_AFTER_MS,
    private readonly lingerMs: number = LIVE_FINISHED_LINGER_MS,
  ) {}

  get(id: string): LiveToolEntry | undefined {
    return this.entries.get(id);
  }

  get size(): number {
    return this.entries.size;
  }

  subscribe(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => {
      const current = this.listeners.get(id);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(id);
    };
  }

  /** A call started. Nothing is drawn until it has run `showAfterMs`. */
  begin(id: string, name: string, startedAt: number = this.now()): void {
    if (this.entries.has(id)) return;
    this.put({ id, name, startedAt, lines: [], shown: false });
    const timer = setTimeout(() => {
      this.revealTimers.delete(id);
      const entry = this.entries.get(id);
      if (!entry || entry.shown) return;
      this.entries.set(id, { ...entry, shown: true });
      if (entry.lines.length > 0 || entry.headline) this.notifyNow(id);
    }, Math.max(0, startedAt + this.showAfterMs - this.now()));
    timer.unref?.();
    this.revealTimers.set(id, timer);
  }

  /** An update frame for a call. A frame for a call that already ended counts only
   * when it is a background job's (those keep streaming after the call returned). */
  update(id: string, name: string, partialResult: unknown): void {
    const async = asyncStateOf(partialResult);
    let entry = this.entries.get(id);
    if (!entry) {
      if (!async && this.ended.includes(id)) return;
      entry = { id, name, startedAt: this.now(), lines: [], shown: true };
    }
    const text = partialResultText(partialResult);
    const rows = tailLines(text);
    const isBash = name === "bash";
    // bash prints raw output; every other tool leads with its own status line.
    const headline = isBash ? undefined : firstLine(text);
    const lines = isBash ? rows : rows.filter((row, index) => !(index === 0 && headline !== undefined && row === headline)).slice(-LIVE_TAIL_LINES);
    const finished = asyncFinished(async);
    const next: LiveToolEntry = {
      ...entry,
      name,
      lines: lines.length > 0 || finished ? lines : entry.lines,
      ...(headline !== undefined ? { headline } : {}),
      ...(async ? { async } : {}),
      ...(finished && entry.endedAt === undefined ? { endedAt: this.now(), shown: true } : {}),
    };
    if (sameEntry(entry, next) && this.entries.has(id)) return;
    this.put(next);
    if (finished && entry.endedAt === undefined) {
      clearTimeout(this.revealTimers.get(id));
      const timer = setTimeout(() => this.end(id), this.lingerMs);
      timer.unref?.();
      this.revealTimers.set(id, timer);
    }
    if (finished) this.notifyNow(id);
    else this.touch(id);
  }

  /** The call returned. A foreground call's tail goes with it; a background job's stays while it streams. */
  end(id: string): void {
    clearTimeout(this.revealTimers.get(id));
    this.revealTimers.delete(id);
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.async && !asyncFinished(entry.async)) return;
    this.entries.delete(id);
    this.dirty.delete(id);
    this.ended.push(id);
    if (this.ended.length > ENDED_MEMORY) this.ended.shift();
    this.notifyNow(id);
  }

  /** The turn is over: every foreground call is gone, background jobs keep their entry. */
  endRun(): void {
    for (const [id, entry] of [...this.entries]) {
      if (!entry.async) this.end(id);
    }
  }

  clear(): void {
    for (const timer of this.revealTimers.values()) clearTimeout(timer);
    this.revealTimers.clear();
    clearTimeout(this.cooldown);
    this.cooldown = undefined;
    const ids = [...this.entries.keys()];
    this.entries.clear();
    this.dirty.clear();
    this.ended.length = 0;
    for (const id of ids) this.fire(id);
  }

  private put(entry: LiveToolEntry): void {
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
    while (this.entries.size > LIVE_MAX_ENTRIES) {
      const victim = [...this.entries.values()].find((candidate) => candidate.endedAt !== undefined && candidate.id !== entry.id)
        ?? [...this.entries.values()].find((candidate) => candidate.id !== entry.id);
      if (!victim) break;
      this.entries.delete(victim.id);
      this.fire(victim.id);
    }
  }

  /** Leading edge at once, then at most one batch per `notifyMs`. */
  private touch(id: string): void {
    this.dirty.add(id);
    if (this.cooldown) return;
    this.flush();
  }

  private flush(): void {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) this.fire(id);
    if (ids.length === 0) return;
    this.cooldown = setTimeout(() => {
      this.cooldown = undefined;
      if (this.dirty.size > 0) this.flush();
    }, this.notifyMs);
    this.cooldown.unref?.();
  }

  private notifyNow(id: string): void {
    this.dirty.delete(id);
    this.fire(id);
  }

  private fire(id: string): void {
    const set = this.listeners.get(id);
    if (!set) return;
    for (const listener of [...set]) listener();
  }
}

function firstLine(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").replace(ANSI, "").trim();
    if (line) return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  }
  return undefined;
}

function sameEntry(a: LiveToolEntry, b: LiveToolEntry): boolean {
  return a.headline === b.headline
    && a.shown === b.shown
    && a.endedAt === b.endedAt
    && a.async?.state === b.async?.state
    && a.lines.length === b.lines.length
    && a.lines.every((line, index) => line === b.lines[index]);
}

/**
 * When a helper's current command started, as a time on THIS device's clock.
 * The engine stamps the start with its own host clock; a phone's clock can
 * differ, so the stamp counts only while it is plausible (the command started
 * at most a day ago and not in the future) and otherwise the command counts
 * from when this page first saw it.
 */
export function helperToolStart(startMs: number | undefined, firstSeenAt: number): number {
  const lead = startMs === undefined ? Number.NaN : firstSeenAt - startMs;
  return startMs !== undefined && lead >= -1500 && lead <= 86_400_000 ? Math.min(startMs, firstSeenAt) : firstSeenAt;
}

/** Milliseconds a helper's current command has run (see `helperToolStart`). */
export function helperToolElapsedMs(startMs: number | undefined, firstSeenAt: number, now: number): number {
  return Math.max(0, now - helperToolStart(startMs, firstSeenAt));
}
