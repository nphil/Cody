"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  EDGE_LOAD_DISTANCE_PX,
  USER_INTENT_WINDOW_MS,
  captureRowAnchor,
  distanceFromBottom,
  pinnedAfterScroll,
  restoreRowAnchor,
  type RowAnchor,
} from "@/lib/transcript-scroll";

/** Keys that scroll a focused scroller UP. */
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/** A "Jump to latest" request stays valid this long: the newest page has to be fetched first. */
const BOTTOM_REQUEST_MS = 15_000;

/** Minimum spacing of automatic page loads, and of a load in the opposite direction. */
const AUTO_LOAD_SPACING_MS = 250;
const AUTO_LOAD_FLIP_MS = 2_000;

export interface TranscriptScroll {
  /** The viewport is pinned to the bottom: new rows are followed. */
  pinned: boolean;
  /** Rows arrived below while the reader was reading elsewhere. */
  unseen: boolean;
  /** Scroll to the bottom now and pin there. */
  toBottom: () => void;
  /** The next window change lands at the bottom (the newest page replaces the window). */
  requestBottom: () => void;
}

/**
 * Scrolling for a transcript that is read, followed and grown at both ends,
 * inside one scroller owned by the caller (`scroller`; `content` is the
 * single element wrapping everything in it, observed for size changes).
 *
 * Two states. PINNED (at the bottom): every commit and every content resize
 * puts the bottom back with an INSTANT scroll. READING: nothing scrolls the
 * reader; the row at the top edge is held where it is (lib/transcript-scroll
 * `RowAnchor`) through a prepended page, a trimmed page, a row expanding
 * above them. Pinned/reading is decided by what the reader does, never by a
 * time window: our own writes are told apart by their VALUE, so scrolling
 * during a stream is never swallowed.
 */
export function useTranscriptScroll({ scroller, content, rowsRef, ready, startMark, endMark, viewportKeyRef, onNearTop, onNearBottom }: {
  scroller: HTMLElement | null;
  content: HTMLElement | null;
  /** The element whose children are the rows (each carries `data-row-key`). */
  rowsRef: RefObject<HTMLElement | null>;
  /** The rows exist; before that there is nothing to hold or follow. */
  ready: boolean;
  /** Byte marks of the window's two ends; a change tells the layer what grew. */
  startMark: number;
  endMark: number;
  /** Written with the key of the row at the top edge, for the data layer's trimming. */
  viewportKeyRef: RefObject<string | null>;
  /** Called when the reader is near an edge. Return whether a page load started. */
  onNearTop: () => boolean;
  onNearBottom: () => boolean;
}): TranscriptScroll {
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const pinnedRef = useRef(true);
  const anchorRef = useRef<RowAnchor | null>(null);
  const expectedTopRef = useRef<number | null>(null);
  const prevTopRef = useRef(0);
  const intentUntilRef = useRef(0);
  const bottomUntilRef = useRef(0);
  const marksRef = useRef<{ start: number; end: number } | null>(null);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const edgesRef = useRef({ onNearTop, onNearBottom });
  edgesRef.current = { onNearTop, onNearBottom };
  const lastAutoRef = useRef<{ at: number; direction: "up" | "down" | null }>({ at: 0, direction: null });
  const retryTimerRef = useRef<number | null>(null);
  const evaluateRef = useRef<() => void>(() => {});

  const setPinnedBoth = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setPinned(next);
    if (next) setUnseen(false);
  }, []);

  const capture = useCallback(() => {
    const rows = rowsRef.current;
    if (!scroller || !rows) return;
    const anchor = captureRowAnchor(scroller, rows);
    anchorRef.current = anchor;
    viewportKeyRef.current = anchor?.key ?? null;
  }, [scroller, rowsRef, viewportKeyRef]);

  // After a write of ours: remember the position so its scroll event is recognised as ours.
  const noteOwnWrite = useCallback(() => {
    if (!scroller) return;
    expectedTopRef.current = scroller.scrollTop;
    prevTopRef.current = scroller.scrollTop;
  }, [scroller]);

  const scrollToBottomNow = useCallback(() => {
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    noteOwnWrite();
    capture();
  }, [scroller, noteOwnWrite, capture]);

  const holdAnchor = useCallback(() => {
    const rows = rowsRef.current;
    const anchor = anchorRef.current;
    if (scroller && rows && anchor && restoreRowAnchor(scroller, rows, anchor) !== 0) noteOwnWrite();
    capture();
  }, [scroller, rowsRef, noteOwnWrite, capture]);

  // Automatic page loads are rate-limited, and a load in the OPPOSITE direction
  // right after one waits longer: with a window that renders almost nothing both
  // ends are "near" at once, and trimming one end to load the other must never
  // become a loop. A deferred load is retried by a timer, because nothing else
  // would re-evaluate a reader who has stopped scrolling.
  const evaluateEdges = useCallback(() => {
    const rows = rowsRef.current;
    if (!scroller || !rows || !readyRef.current) return;
    const view = scroller.getBoundingClientRect();
    const list = rows.getBoundingClientRect();
    const wanted: Array<"up" | "down"> = [];
    if (list.top - view.top > -EDGE_LOAD_DISTANCE_PX) wanted.push("up");
    if (list.bottom - view.bottom < EDGE_LOAD_DISTANCE_PX) wanted.push("down");
    for (const direction of wanted) {
      const now = performance.now();
      const last = lastAutoRef.current;
      const spacing = last.direction !== null && last.direction !== direction ? AUTO_LOAD_FLIP_MS : AUTO_LOAD_SPACING_MS;
      const wait = last.at + spacing - now;
      if (wait > 0) {
        if (retryTimerRef.current === null) {
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            evaluateRef.current();
          }, wait + 20);
        }
        continue;
      }
      const started = direction === "up" ? edgesRef.current.onNearTop() : edgesRef.current.onNearBottom();
      if (started) {
        lastAutoRef.current = { at: now, direction };
        break;
      }
    }
  }, [scroller, rowsRef]);
  evaluateRef.current = evaluateEdges;
  useEffect(() => () => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
  }, []);

  const toBottom = useCallback(() => {
    setPinnedBoth(true);
    scrollToBottomNow();
  }, [setPinnedBoth, scrollToBottomNow]);

  const requestBottom = useCallback(() => {
    bottomUntilRef.current = performance.now() + BOTTOM_REQUEST_MS;
  }, []);

  // The reader's input. Native listeners: passive, and one place for all of them.
  useEffect(() => {
    if (!scroller) return;
    let touchY = 0;
    let draggingBar = false;
    const markIntent = () => { intentUntilRef.current = performance.now() + USER_INTENT_WINDOW_MS; };

    const onScroll = () => {
      const top = scroller.scrollTop;
      const own = expectedTopRef.current !== null && Math.abs(top - expectedTopRef.current) < 1;
      const next = pinnedAfterScroll({
        pinned: pinnedRef.current,
        top,
        prevTop: prevTopRef.current,
        expectedTop: expectedTopRef.current,
        distance: distanceFromBottom(scroller),
        driven: performance.now() < intentUntilRef.current,
      });
      prevTopRef.current = top;
      if (!own) {
        expectedTopRef.current = null;
        capture();
      }
      setPinnedBoth(next);
      evaluateEdges();
    };
    const onWheel = (event: WheelEvent) => {
      markIntent();
      if (event.deltaY < 0) setPinnedBoth(false);
    };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; };
    const onTouchMove = (event: TouchEvent) => {
      markIntent();
      const y = event.touches[0]?.clientY ?? touchY;
      // A finger moving down drags the content down: the reader is going up.
      if (y > touchY + 2) setPinnedBoth(false);
      touchY = y;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      markIntent();
      if (UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) setPinnedBoth(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      // A press on the scrollbar itself: the pointer is on the scroller, right of its content box.
      if (event.target === scroller && event.clientX >= scroller.getBoundingClientRect().left + scroller.clientWidth) {
        draggingBar = true;
        intentUntilRef.current = Number.POSITIVE_INFINITY;
      }
    };
    const onPointerUp = () => {
      if (!draggingBar) return;
      draggingBar = false;
      markIntent();
    };
    // Using the content (opening a card, "Show earlier") is reading, not
    // following: whatever grows must not drag the viewport to the bottom.
    const onClick = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.("button, a, summary, [role='button']")) setPinnedBoth(false);
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("keydown", onKeyDown);
    scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
    scroller.addEventListener("pointerup", onPointerUp, { passive: true });
    scroller.addEventListener("pointercancel", onPointerUp, { passive: true });
    scroller.addEventListener("click", onClick, true);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("keydown", onKeyDown);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("pointerup", onPointerUp);
      scroller.removeEventListener("pointercancel", onPointerUp);
      scroller.removeEventListener("click", onClick, true);
    };
  }, [scroller, capture, evaluateEdges, setPinnedBoth]);

  // Content growing or shrinking without a window change (a card expanding, an
  // image decoding, the Result block arriving above, the viewport resizing).
  // Runs between layout and paint, so there is never a frame in the wrong place.
  useEffect(() => {
    if (!scroller || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!readyRef.current) return;
      if (pinnedRef.current) scrollToBottomNow();
      else holdAnchor();
      evaluateEdges();
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller, content, scrollToBottomNow, holdAnchor, evaluateEdges]);

  // A window change: land at the bottom the first time (and on request), follow
  // what was appended while pinned, otherwise hold the reader's row.
  useLayoutEffect(() => {
    if (!scroller || !ready) return;
    const prev = marksRef.current;
    marksRef.current = { start: startMark, end: endMark };
    if (prev === null || performance.now() < bottomUntilRef.current) {
      bottomUntilRef.current = 0;
      toBottom();
      return;
    }
    if (endMark > prev.end) {
      if (pinnedRef.current) scrollToBottomNow();
      else {
        holdAnchor();
        setUnseen(true);
      }
    } else if (startMark !== prev.start || endMark !== prev.end) {
      holdAnchor();
    }
  }, [scroller, ready, startMark, endMark, toBottom, scrollToBottomNow, holdAnchor]);

  // After every window change the reader may be at an edge: bring the next page.
  useEffect(() => { evaluateEdges(); }, [evaluateEdges, ready, startMark, endMark]);

  return { pinned, unseen, toBottom, requestBottom };
}
