"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  appendPage,
  hasEarlier,
  prependPage,
  reachesEnd,
  renderableRows,
  toolResultsById,
  trimWindow,
  windowFromPage,
  windowMessages,
  type TranscriptRow,
  type TranscriptWindow,
} from "@/lib/subagent-transcript";
import type { SubagentTranscriptPage } from "@/lib/subagent-types";
import type { ToolResultMessage } from "@/lib/types";

/** Phases of the first load. `missing`: the child has no transcript file (yet). */
export type TranscriptPhase = "loading" | "ready" | "missing" | "error";

type Source = "disk" | "rpc";

interface Core {
  phase: TranscriptPhase;
  win: TranscriptWindow | null;
  source: Source;
  /** The first load failed (phase "error"). */
  error: string | null;
  loadingEarlier: boolean;
  earlierError: string | null;
  /** The disk reader had nothing earlier after all (a page came back empty). */
  noEarlier: boolean;
  loadingLater: boolean;
  /** A forward fetch (live refresh, or walking down a trimmed window) failed; the rows stay. */
  laterError: string | null;
}

const INITIAL: Core = {
  phase: "loading",
  win: null,
  source: "disk",
  error: null,
  loadingEarlier: false,
  earlierError: null,
  noEarlier: false,
  loadingLater: false,
  laterError: null,
};

const NO_ROWS: TranscriptRow[] = [];

/** Pages one refresh may pull before it stops. A child that wrote megabytes
 *  between two frames is caught up over a few ticks, never in one tight loop. */
const FORWARD_PAGE_BUDGET = 12;

/** Once a child settles, its last lines may land just after the final frame. */
const SETTLE_REFRESH_MS = 900;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One page from the disk reader. Null: the child has no transcript file. */
async function fetchDiskPage(
  sessionId: string,
  subagentId: string,
  query: Record<string, string>,
  signal: AbortSignal,
): Promise<SubagentTranscriptPage | null> {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(subagentId)}?${new URLSearchParams(query)}`;
  const response = await fetch(url, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as SubagentTranscriptPage;
}

/** For a running child whose file the disk reader cannot see: omp's own
 *  registry-gated reader. Forward only, and it starts at the OLDEST page. */
function fetchRpcPage(sessionId: string, subagentId: string, sessionFile: string | undefined, fromByte: number): Promise<SubagentTranscriptPage> {
  return sendAgentCommand<SubagentTranscriptPage>(sessionId, {
    type: "get_subagent_messages",
    subagentId,
    sessionFile,
    fromByte,
  });
}

/** How a (re)load of the newest page treats what is already on screen. */
type TailMode =
  /** First open, or Retry: placeholder until the page lands. */
  | "initial"
  /** Jump to latest: keep the rows until the newest page replaces them. */
  | "jump"
  /** Looking again for a file that did not exist a moment ago: no flicker. */
  | "poll";

export interface SubagentTranscriptState {
  phase: TranscriptPhase;
  error: string | null;
  /** Rows to draw (a tool result is drawn inside its call's card, not as a row). */
  rows: TranscriptRow[];
  toolResults: Map<string, ToolResultMessage>;
  /** Byte marks of the window, so the scroll layer can tell a prepend from an append. */
  startMark: number;
  endMark: number;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  earlierError: string | null;
  /** The newest mounted row is the newest line the file has. */
  attached: boolean;
  loadingLater: boolean;
  laterError: string | null;
  /** Both return whether a request actually started. */
  loadEarlier: () => boolean;
  loadLater: () => boolean;
  /** Replace the window with the newest page (the reader asked to jump to the end). */
  jumpToLatest: () => void;
  /** Re-run the first load. */
  retry: () => void;
  /** Re-run a failed forward fetch. */
  refresh: () => void;
}

/**
 * The open transcript of one subagent: the newest page first, earlier pages on
 * request, new lines appended while the child runs — all from the disk reader,
 * which reads only the bytes asked for, so a 20 MB transcript costs what a
 * small one does. The window it keeps is bounded (MAX_WINDOW_MESSAGES);
 * anything trimmed away is fetched again on demand. Mount it only while the
 * dialog is open: it fetches on mount and does nothing after unmount.
 */
export function useSubagentTranscript({ sessionId, subagentId, sessionFile, rpcFallback, active, refreshKey, viewportKeyRef }: {
  sessionId: string;
  subagentId: string;
  sessionFile?: string;
  /** Allow omp's `get_subagent_messages` when the disk reader finds no file. */
  rpcFallback: boolean;
  /** The child is still running. */
  active: boolean;
  /** Bumps whenever the child may have written more (already throttled). */
  refreshKey: number;
  /** The row at the top of the viewport; trimming never drops its page. */
  viewportKeyRef: RefObject<string | null>;
}): SubagentTranscriptState {
  const [core, setCore] = useState<Core>(INITIAL);
  // The ref is what async continuations read; state only schedules the render.
  const coreRef = useRef(core);
  // Bumped whenever whatever is in flight must be abandoned.
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Generation of the forward loop that is running (-1: none), and whether a
  // refresh was asked for while it ran.
  const forwardGenRef = useRef(-1);
  const forwardPendingRef = useRef(false);
  const optionsRef = useRef({ sessionFile, rpcFallback });
  optionsRef.current = { sessionFile, rpcFallback };
  const latestKeyRef = useRef(refreshKey);
  latestKeyRef.current = refreshKey;
  const handledKeyRef = useRef(refreshKey);
  const loadTailRef = useRef<(mode: TailMode) => Promise<void>>(async () => {});

  const apply = useCallback((update: (prev: Core) => Core) => {
    const next = update(coreRef.current);
    if (next === coreRef.current) return;
    coreRef.current = next;
    setCore(next);
  }, []);

  // Appends what the file gained past the window's end, a page at a time.
  const pullForward = useCallback(async (budget: number) => {
    const gen = genRef.current;
    const signal = abortRef.current?.signal;
    if (!signal) return;
    for (let i = 0; i < budget; i += 1) {
      const current = coreRef.current;
      if (current.phase !== "ready" || !current.win) return;
      const from = current.win.pages[current.win.pages.length - 1].nextByte;
      let page: SubagentTranscriptPage | null;
      try {
        page = current.source === "disk"
          ? await fetchDiskPage(sessionId, subagentId, { fromByte: String(from) }, signal)
          : await fetchRpcPage(sessionId, subagentId, optionsRef.current.sessionFile, from);
      } catch (error) {
        if (gen !== genRef.current) return;
        apply((c) => ({ ...c, laterError: messageOf(error) }));
        return;
      }
      if (gen !== genRef.current || page === null) return;
      // The file shrank or was replaced: what we hold no longer describes it.
      if (page.reset) {
        void loadTailRef.current("jump");
        return;
      }
      const arrived = page;
      let grew = false;
      apply((c) => {
        const merged = c.win ? appendPage(c.win, arrived) : null;
        if (merged === null) return c;
        grew = arrived.nextByte > arrived.fromByte;
        return { ...c, win: trimWindow(merged, viewportKeyRef.current), laterError: null };
      });
      const more = arrived.endByte !== undefined ? arrived.nextByte < arrived.endByte : arrived.messages.length > 0;
      if (!grew || !more) return;
      // Let the browser paint and take input between pages.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    }
  }, [apply, sessionId, subagentId, viewportKeyRef]);

  // One forward loop at a time. A request that arrives while it runs makes it
  // go round again once, so the newest frame is never left unfetched.
  const runForward = useCallback(async (budget: number, visible: boolean): Promise<void> => {
    const gen = genRef.current;
    if (forwardGenRef.current === gen) {
      forwardPendingRef.current = true;
      return;
    }
    forwardGenRef.current = gen;
    if (visible) apply((c) => ({ ...c, loadingLater: true }));
    try {
      do {
        forwardPendingRef.current = false;
        await pullForward(budget);
      } while (forwardPendingRef.current && gen === genRef.current);
    } finally {
      if (forwardGenRef.current === gen) forwardGenRef.current = -1;
      if (visible && gen === genRef.current) apply((c) => ({ ...c, loadingLater: false }));
    }
  }, [apply, pullForward]);

  const loadTail = useCallback(async (mode: TailMode) => {
    genRef.current += 1;
    const gen = genRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    forwardPendingRef.current = false;
    if (mode === "initial") apply(() => INITIAL);
    else if (mode === "jump") apply((c) => ({ ...INITIAL, phase: "ready", win: c.win, source: c.source }));
    const keyAtStart = latestKeyRef.current;
    try {
      let page = await fetchDiskPage(sessionId, subagentId, { tail: "1" }, controller.signal);
      let source: Source = "disk";
      if (page === null && optionsRef.current.rpcFallback) {
        try {
          page = await fetchRpcPage(sessionId, subagentId, optionsRef.current.sessionFile, 0);
          source = "rpc";
        } catch {
          page = null;
        }
      }
      if (gen !== genRef.current) return;
      if (page === null) {
        apply((c) => (c.phase === "missing" ? c : { ...INITIAL, phase: "missing" }));
        return;
      }
      const win = windowFromPage(page);
      apply(() => ({ ...INITIAL, phase: "ready", win, source }));
      // The RPC path starts at the OLDEST page and must walk to the newest;
      // frames that arrived while the disk page was in flight need fetching too.
      if (source === "rpc" || latestKeyRef.current !== keyAtStart) void runForward(FORWARD_PAGE_BUDGET, false);
    } catch (error) {
      if (gen !== genRef.current) return;
      // Whatever was on screen (a jump that lost the network) stays.
      apply((c) => (c.win
        ? { ...c, laterError: messageOf(error) }
        : { ...INITIAL, phase: "error", error: messageOf(error) }));
    }
  }, [apply, runForward, sessionId, subagentId]);
  loadTailRef.current = loadTail;

  // Follow the child: fetch what it wrote since the last page. A reader parked
  // above the end is not followed (the Jump control is already showing).
  const refresh = useCallback(() => {
    const current = coreRef.current;
    if (current.phase === "missing") { void loadTail("poll"); return; }
    if (current.phase !== "ready" || !current.win) return;
    if (current.source === "disk" && !reachesEnd(current.win) && !current.laterError) return;
    apply((c) => (c.laterError ? { ...c, laterError: null } : c));
    void runForward(FORWARD_PAGE_BUDGET, false);
  }, [apply, loadTail, runForward]);

  // Returns whether a request started, so a caller can tell "asked" from "nothing to ask".
  const loadEarlier = useCallback((): boolean => {
    const current = coreRef.current;
    if (current.phase !== "ready" || !current.win || current.source !== "disk" || current.loadingEarlier || current.noEarlier || !hasEarlier(current.win)) return false;
    const gen = genRef.current;
    const signal = abortRef.current?.signal;
    if (!signal) return false;
    const beforeByte = current.win.pages[0].fromByte;
    apply((c) => ({ ...c, loadingEarlier: true, earlierError: null }));
    void (async () => {
      try {
        const page = await fetchDiskPage(sessionId, subagentId, { beforeByte: String(beforeByte) }, signal);
        if (gen !== genRef.current) return;
        if (page === null) throw new Error("Transcript not found");
        apply((c) => {
          const merged = c.win ? prependPage(c.win, page) : null;
          if (merged === null) return { ...c, loadingEarlier: false };
          // An empty page means nothing earlier exists; remember it so the reader is not offered it again.
          if (merged === c.win) return { ...c, loadingEarlier: false, noEarlier: true };
          return { ...c, win: trimWindow(merged, viewportKeyRef.current), loadingEarlier: false };
        });
      } catch (error) {
        if (gen !== genRef.current) return;
        apply((c) => ({ ...c, loadingEarlier: false, earlierError: messageOf(error) }));
      }
    })();
    return true;
  }, [apply, sessionId, subagentId, viewportKeyRef]);

  // Walking down out of a trimmed window: one page per request.
  const loadLater = useCallback((): boolean => {
    const current = coreRef.current;
    if (current.phase !== "ready" || !current.win || current.loadingLater || current.laterError || reachesEnd(current.win)) return false;
    void runForward(1, true);
    return true;
  }, [runForward]);

  const jumpToLatest = useCallback(() => { void loadTail("jump"); }, [loadTail]);
  const retry = useCallback(() => { void loadTail("initial"); }, [loadTail]);

  // Open (and re-open for another child): load the newest page; abandon
  // everything on the way out.
  useEffect(() => {
    void loadTail("initial");
    return () => {
      genRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [loadTail]);

  useEffect(() => {
    if (refreshKey === handledKeyRef.current) return;
    handledKeyRef.current = refreshKey;
    refresh();
  }, [refreshKey, refresh]);

  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (!wasActive || active) return;
    const timer = setTimeout(refresh, SETTLE_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [active, refresh]);

  const win = core.win;
  const messages = useMemo(() => (win ? windowMessages(win) : NO_ROWS), [win]);
  const rows = useMemo(() => renderableRows(messages), [messages]);
  const toolResults = useMemo(() => toolResultsById(messages), [messages]);

  return {
    phase: core.phase,
    error: core.error,
    rows,
    toolResults,
    startMark: win ? win.pages[0].fromByte : 0,
    endMark: win ? win.pages[win.pages.length - 1].nextByte : 0,
    hasEarlier: win !== null && core.source === "disk" && !core.noEarlier && hasEarlier(win),
    loadingEarlier: core.loadingEarlier,
    earlierError: core.earlierError,
    attached: win === null || reachesEnd(win),
    loadingLater: core.loadingLater,
    laterError: core.laterError,
    loadEarlier,
    loadLater,
    jumpToLatest,
    retry,
    refresh,
  };
}
