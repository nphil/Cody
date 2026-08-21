"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Smooth progressive reveal for the live streaming message.
 *
 * SSE token batches land as sudden multi-word (sometimes multi-paragraph)
 * lumps; painting them directly reads as jarring jumps. The pacer sits
 * between the growing target text and what is painted: every animation frame
 * reveals a slice of the outstanding backlog proportional to elapsed time, so
 * a lump diffuses over roughly a quarter second while a fast stream can never
 * run away from the display. Committed transcripts bypass all of this — only
 * the actively growing block of the live message is ever paced.
 */

export interface StreamPacerOptions {
  /** Backlog decay time: each tick reveals backlog·dt/catchUpMs characters,
   *  so a burst is substantially on screen within ~2–3× this value. */
  catchUpMs?: number;
  /** Reveal floor per tick — finishes the exponential tail and guarantees
   *  progress even when the proportional share rounds to nothing. */
  minRevealChars?: number;
  /** Hard cap on how many characters the display may lag the target. A
   *  pathological burst snaps past this instantly instead of animating it. */
  maxBacklogChars?: number;
  /** How far past the proportional cut to search for whitespace so words pop
   *  whole. Longer tokens (URLs, identifiers) are cut mid-token rather than
   *  letting one token stall the reveal. */
  wordLookaheadChars?: number;
  /** Frame-delta clamp: a background-tab gap must not smear into one giant
   *  reveal step when the tab returns. */
  maxTickMs?: number;
  /** Tolerate non-append rewrites by retracting only past the common prefix.
   *  For targets that are *mostly* append-only but re-close a suffix each
   *  frame (streaming tool-call JSON: the closing braces shift while the
   *  interior grows). Off, any rewrite snaps — prose must never replay. */
  lenientPrefix?: boolean;
}

const DEFAULTS: Required<StreamPacerOptions> = {
  catchUpMs: 60,
  minRevealChars: 2,
  maxBacklogChars: 2000,
  wordLookaheadChars: 24,
  maxTickMs: 250,
  lenientPrefix: false,
};

/** Assumed frame length for the first tick after the loop (re)starts, when
 *  there is no previous timestamp to diff against. */
const ASSUMED_FRAME_MS = 17;

export interface StreamPacer {
  /** Adopt a new target. Prefix growth paces; anything else (first text after
   *  (re)arming, a new message, a rewrite, a shrink) snaps — stale text must
   *  never replay. */
  push(target: string): void;
  /** Advance the reveal; `now` is a monotonic millisecond clock. */
  tick(now: number): void;
  text(): string;
  caughtUp(): boolean;
  /** Snap to the full target (stream settled, block no longer active). */
  flush(): void;
  /** Re-tune mid-flight (live knob changes); reveal position is preserved. */
  configure(next: StreamPacerOptions): void;
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || code === 10 || code === 9 || code === 13;
}

export function createStreamPacer(options: StreamPacerOptions = {}): StreamPacer {
  let opts = { ...DEFAULTS, ...options };
  let target = "";
  let shown = 0;
  let armed = false;
  let lastTick: number | null = null;

  return {
    push(next: string) {
      if (armed && next === target) return;
      // The first push after construction snaps: a block mounting mid-stream
      // (tab reopen, thinking panel expanded late) must show what is already
      // there, not replay history.
      const prev = target;
      const wasArmed = armed;
      target = next;
      armed = true;
      if (!wasArmed) {
        shown = target.length;
        lastTick = null;
        return;
      }
      if (!next.startsWith(prev)) {
        if (!opts.lenientPrefix) {
          shown = target.length;
          lastTick = null;
          return;
        }
        // Retract only the already-shown chars that actually changed (the
        // re-closed JSON suffix — a handful of chars), then pace forward.
        const bound = Math.min(prev.length, next.length, shown);
        let cp = 0;
        while (cp < bound && prev.charCodeAt(cp) === next.charCodeAt(cp)) cp++;
        if (cp < shown) shown = cp;
      }
      if (target.length - shown > opts.maxBacklogChars) {
        shown = target.length - opts.maxBacklogChars;
      }
    },
    tick(now: number) {
      if (shown >= target.length) {
        lastTick = null;
        return;
      }
      const dt = lastTick === null ? ASSUMED_FRAME_MS : Math.min(Math.max(now - lastTick, 0), opts.maxTickMs);
      lastTick = now;
      const backlog = target.length - shown;
      const reveal = Math.max(opts.minRevealChars, Math.ceil((backlog * dt) / opts.catchUpMs));
      let cut = Math.min(target.length, shown + reveal);
      // Prefer cutting at whitespace so words pop whole. Only ever scan
      // forward: scanning back would re-cut the same word every frame.
      if (cut < target.length && !isWhitespaceCode(target.charCodeAt(cut))) {
        const limit = Math.min(target.length, cut + opts.wordLookaheadChars);
        for (let i = cut + 1; i <= limit; i++) {
          if (i === target.length || isWhitespaceCode(target.charCodeAt(i))) {
            cut = i;
            break;
          }
        }
      }
      shown = cut;
      if (shown >= target.length) lastTick = null;
    },
    text() {
      return shown >= target.length ? target : target.slice(0, shown);
    },
    caughtUp() {
      return shown >= target.length;
    },
    flush() {
      shown = target.length;
      lastTick = null;
    },
    configure(next: StreamPacerOptions) {
      opts = { ...opts, ...next };
    },
  };
}

/**
 * Whether the paced pipeline should engage for a block. Settled transcripts,
 * blocks that stopped being the growing tail of the live message (a tool call
 * started below them), and reduced-motion users all read the target directly:
 * instant, no animation classes, no per-frame work.
 */
export function shouldPaceStream(args: {
  isStreaming: boolean;
  isActiveBlock: boolean;
  prefersReducedMotion: boolean;
}): boolean {
  return args.isStreaming && args.isActiveBlock && !args.prefersReducedMotion;
}

/**
 * The three ways a block consumes the pacer:
 * - "pace"  — actively streaming tail: buffer and reveal per animation frame.
 * - "drain" — the block was superseded mid-stream (a tool call started below
 *   it) but still owes backlog: keep revealing until caught up, then drop the
 *   pacer. A block with no pacer (or no debt) reads instantly. The caller
 *   passes drain-rate options (a faster catchUpMs) alongside the mode.
 * - "snap"  — settled/off: return the target verbatim, drop any pacer.
 * Booleans are accepted as shorthand (true = "pace", false = "snap").
 */
export type StreamPaceMode = "pace" | "drain" | "snap";

/**
 * Paces `target` (which grows monotonically per SSE batch) into a displayed
 * string that advances a few words per animation frame. In "snap" mode the
 * target is returned verbatim — that is the completion flush: the moment a
 * block settles, any animation debt is paid instantly and the pacer dropped.
 *
 * The rAF loop only runs while there is backlog; a caught-up stream burns no
 * idle frames. Option changes apply live via pacer.configure().
 */
export function useSmoothStreamText(target: string, mode: StreamPaceMode | boolean, options?: StreamPacerOptions): string {
  const resolved: StreamPaceMode = mode === true ? "pace" : mode === false ? "snap" : mode;
  const pacerRef = useRef<StreamPacer | null>(null);
  const frameRef = useRef<number | null>(null);
  const [displayed, setDisplayed] = useState(target);

  useEffect(() => {
    // "drain" without an existing pacer has no debt to animate — instant.
    const engaged = resolved === "pace" || (resolved === "drain" && pacerRef.current !== null && !pacerRef.current.caughtUp());
    if (!engaged) {
      // Drop the pacer so re-enabling starts caught-up (the first push
      // snaps): stale text from a previous paced run must never replay.
      pacerRef.current = null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      return;
    }
    const pacer = (pacerRef.current ??= createStreamPacer(options));
    if (options) pacer.configure(options);
    pacer.push(target);
    const pushed = pacer.text();
    setDisplayed((prev) => (prev === pushed ? prev : pushed));
    if (pacer.caughtUp() || frameRef.current !== null) return;
    const step = (now: number) => {
      frameRef.current = null;
      const live = pacerRef.current;
      if (live === null) return;
      live.tick(now);
      const text = live.text();
      setDisplayed((prev) => (prev === text ? prev : text));
      if (!live.caughtUp()) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
    // `options` must be referentially stable per tuning state (callers memoize
    // via usePacerOptions); a per-render literal would re-run this every frame.
  }, [target, resolved, options]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  // Until the arming effect has run, `displayed` may hold text from a
  // previous paced run — returning it would flash stale content for a frame.
  // An unarmed pacer means "show the live target".
  return resolved !== "snap" && pacerRef.current !== null ? displayed : target;
}

export interface RevealSplit {
  /** Markdown-safe committed slice, rendered (and memoized) as markdown. */
  prefix: string;
  /** In-flight remainder rendered as fading word spans. Never contains a
   *  newline for the markdown splitter; may contain them for the plain one. */
  tail: string;
  /** Absolute character offset of `tail` in the full text. Span keys derive
   *  from it, so an already-shown word keeps its key (and never re-animates)
   *  while the boundary advances. */
  tailOffset: number;
  /** True when the tail starts a new paragraph (blank line before it) — the
   *  tail then owns a paragraph-sized top gap instead of a line-sized one. */
  paragraphGap: boolean;
}


/** ```/~~~ fence-opening or -closing line? Returns the fence character so an
 *  opener of one kind cannot be closed by the other. */
function fenceLineChar(text: string, start: number, end: number): "`" | "~" | null {
  let i = start;
  // CommonMark allows up to three leading spaces before a fence.
  while (i < end && text[i] === " " && i - start < 4) i++;
  if (i - start > 3) return null;
  const c = text[i];
  if (c !== "`" && c !== "~") return null;
  return text[i + 1] === c && text[i + 2] === c ? c : null;
}

/**
 * Split streamed markdown into a committed prefix and an animated tail.
 *
 * The boundary is the last newline outside any code fence, so the tail is
 * always the current line in flight (prose paragraph, list item, quote
 * line). Fenced code collapses to prefix-only — code as plain spans would
 * show literal backticks and lose the block styling — which is exactly the
 * whole-text streaming render this app has always used. This is a deliberate
 * simplification over wrapping the markdown AST's trailing text nodes in
 * spans: that requires mapping rendered text back to source offsets through
 * remark/rehype transforms, which shift retroactively while inline constructs
 * close. The cost of this trade is that a line shows literal inline markers
 * (`**`, backticks) until it completes and migrates into the prefix.
 */
export function splitMarkdownReveal(text: string): RevealSplit {
  let fence: "`" | "~" | null = null;
  let lastSafeNewline = -1;
  let i = 0;
  const n = text.length;
  while (i <= n) {
    const lineEnd = text.indexOf("\n", i);
    const end = lineEnd === -1 ? n : lineEnd;
    const f = fenceLineChar(text, i, end);
    if (f !== null) {
      if (fence === null) fence = f;
      else if (fence === f) fence = null;
    }
    if (lineEnd === -1) break;
    // The newline ending a fence-opening line is inside the fence; the one
    // ending the closing line is back outside.
    if (fence === null) lastSafeNewline = lineEnd;
    i = lineEnd + 1;
  }

  const allPrefix: RevealSplit = { prefix: text, tail: "", tailOffset: n, paragraphGap: false };
  if (fence !== null) return allPrefix;
  const tailOffset = lastSafeNewline + 1;
  const tail = text.slice(tailOffset);
  if (tail.length === 0) return allPrefix;
  // A fence opener still missing its newline must not render as plain spans.
  if (fenceLineChar(tail, 0, tail.length) !== null) return allPrefix;
  return {
    prefix: text.slice(0, tailOffset),
    tail,
    tailOffset,
    paragraphGap: tailOffset >= 2 && text.charCodeAt(tailOffset - 2) === 10,
  };
}

/** Plain-text tails (thinking) have no markdown-safety constraint, so the
 *  boundary just slides to keep the last ~window of characters animated,
 *  snapped forward to a word start so it never lands mid-word. Keys are
 *  absolute offsets, so a word sliding out of the window into the prefix
 *  text node was already visible and never re-animates. */
const PLAIN_TAIL_WINDOW_CHARS = 160;

export function splitPlainReveal(text: string, windowChars: number = PLAIN_TAIL_WINDOW_CHARS): RevealSplit {
  const n = text.length;
  let idx = n - windowChars;
  if (idx < 0) idx = 0;
  while (idx > 0 && idx < n) {
    const atWordStart = isWhitespaceCode(text.charCodeAt(idx - 1)) && !isWhitespaceCode(text.charCodeAt(idx));
    if (atWordStart) break;
    idx++;
  }
  return { prefix: text.slice(0, idx), tail: text.slice(idx), tailOffset: idx, paragraphGap: false };
}

export interface RevealChunk {
  /** Absolute character offset — the stable React key for this word. */
  key: number;
  text: string;
}

/** Word + trailing-space runs (or bare whitespace runs) with offset-stable
 *  keys. Append-only growth can extend the final chunk or add chunks, never
 *  re-key earlier ones — so shown words never re-animate. */
export function chunkRevealWords(tail: string, tailOffset: number): RevealChunk[] {
  const chunks: RevealChunk[] = [];
  const re = /\S+\s*|\s+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tail)) !== null) {
    chunks.push({ key: tailOffset + match.index, text: match[0] });
  }
  return chunks;
}
