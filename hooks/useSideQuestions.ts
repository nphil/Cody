"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AgentCommandError, sendAgentCommand } from "@/lib/agent-client";
import {
  applyBtwFrame,
  describeBtwError,
  hasRunningBtw,
  mergeBtwSnapshot,
  ompVersionHasBtw,
  parseBtwRecord,
  parseBtwRecords,
  type BtwRecord,
} from "@/lib/btw";
import { loadEngineInfo } from "@/lib/engine-capabilities";
import { translate } from "@/lib/i18n";

/** The page stops waiting for the engine to take a question after this long.
 *  The server answers within ~30 s (its own bound on a busy engine) plus an
 *  engine start for a chat that has none; this is only the backstop for a
 *  request that never comes back at all, which would otherwise leave the box
 *  disabled until a reload. The answer, if it ever lands, is merged as usual. */
const ASK_BACKSTOP_MS = 120_000;

/** While a topic shows as answering, history is re-read this often. The live
 *  frames normally end it; this heals a stream that dropped mid-answer, so the
 *  panel never shows "Answering…" for something that finished. A history read
 *  can finish a topic but never grow one that is still running (lib/btw.ts). */
const ANSWER_RECONCILE_MS = 4_000;

// An omp that predates /btw (`Unknown command: btw`) will not learn it mid-page:
// one refusal turns the surface off until the page reloads.
let unsupportedForPage = false;

export type SideQuestionOutcome = { ok: true } | { ok: false; message: string };

export interface SideQuestionsOptions {
  /** The chat's id, or null while there is none. */
  sessionId: string | null;
  /** The caller's own gate: omp, a chat that already exists, not the sidebar chat. */
  capable: boolean;
  /** Opens the chat's event stream if it is not open (which also starts a cold
   *  chat's engine) and resolves once it is. Side-question frames only reach a
   *  page that is listening, so an ask waits for this. */
  ensureStream: (sessionId: string) => Promise<void>;
}

export interface SideQuestions {
  /** The surface exists here: omp, a real chat, an engine that has /btw. */
  available: boolean;
  /** Newest topic first. */
  records: readonly BtwRecord[];
  /** Some topic is being answered. */
  answering: boolean;
  /** A question was sent and the engine has not taken it yet. */
  asking: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The last failure in plain words, until dismissed or the next ask. */
  error: string | null;
  dismissError: () => void;
  /** Bumps when the new-question box should take focus. */
  focusRequest: number;
  /** The panel's own boxes. Resolves true when the engine took the question. */
  askFromPanel: (question: string, recordId?: string) => Promise<boolean>;
  /** `/btw <question>` typed in the composer; an empty question opens the panel. */
  askFromComposer: (question: string) => Promise<SideQuestionOutcome>;
  cancel: (recordId: string) => void;
  /** A `btw_delta` / `btw_record` frame off the event stream. */
  applyFrame: (frame: { type?: unknown; [key: string]: unknown }) => void;
  /** The event stream (re)connected: frames in between were missed, so read history. */
  noteStreamConnected: () => void;
  /** omp could not save a topic to its history sidecar. */
  noteHistoryNotice: (message: string) => void;
}

function scheduleFlush(flush: () => void): () => void {
  if (typeof document !== "undefined" && !document.hidden && typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(flush, 50);
  return () => clearTimeout(id);
}

/** `promise`, or a failure once the backstop passes. If `promise` settles later, the caller has moved on and nothing leaks. */
function withBackstop<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentCommandError(translate("btw.errorTimeout"), "btw_ack_timeout")), ASK_BACKSTOP_MS);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Side questions (omp's `/btw`) for one chat: the topics, their live answers,
 * and asking, following up and cancelling. Rules for combining what the engine
 * says live with what it says when asked live in lib/btw.ts; this hook owns
 * the timing around them.
 *
 * - History is read through GET /api/sessions/<id>/btw — never through a
 *   command, because opening a chat that has no engine running must not start
 *   one. It is read on open and every time the event stream (re)connects.
 * - Deltas arrive at token rate and are applied once per animation frame.
 * - Nothing here touches the chat's own transcript, run state or outbox: a
 *   side question runs beside the turn and never enters it.
 */
export function useSideQuestions({ sessionId, capable, ensureStream }: SideQuestionsOptions): SideQuestions {
  const [records, setRecords] = useState<readonly BtwRecord[]>([]);
  const [supported, setSupported] = useState<boolean | null>(unsupportedForPage ? false : null);
  // Null until /api/info has said which engine version is installed.
  const [engineOk, setEngineOk] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const capableRef = useRef(capable);
  capableRef.current = capable;
  const engineOkRef = useRef(engineOk);
  engineOkRef.current = engineOk;
  const ensureStreamRef = useRef(ensureStream);
  ensureStreamRef.current = ensureStream;
  const aliveRef = useRef(true);
  const askingRef = useRef(false);
  const loadRef = useRef<{ sessionId: string; promise: Promise<void> } | null>(null);
  const pendingDeltasRef = useRef<Map<string, string>>(new Map());
  const cancelFlushRef = useRef<(() => void) | null>(null);

  // Strict Mode runs effects twice: arm on mount, not only disarm on unmount.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelFlushRef.current?.();
      cancelFlushRef.current = null;
      pendingDeltasRef.current.clear();
    };
  }, []);

  // The installed engine's version (one shared /api/info read per page): an
  // omp older than 18.7 has no /btw, and is told so before anything is offered.
  useEffect(() => {
    if (!capable) return;
    let cancelled = false;
    void loadEngineInfo().then((info) => {
      if (!cancelled) setEngineOk(ompVersionHasBtw(info.version));
    });
    return () => { cancelled = true; };
  }, [capable]);

  /** Read the history. Joins a read already in flight for this chat. */
  const load = useCallback((sid: string): Promise<void> => {
    const current = loadRef.current;
    if (current?.sessionId === sid) return current.promise;
    const promise = (async () => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/btw`, { cache: "no-store" });
        // 404 (a chat with no file yet) and 400 (another engine) have nothing to show.
        if (!response.ok) return;
        const body = await response.json() as { records?: unknown; supported?: unknown };
        if (!aliveRef.current || sessionIdRef.current !== sid) return;
        if (body.supported === false) {
          unsupportedForPage = true;
          setSupported(false);
          return;
        }
        if (body.supported === true) setSupported(true);
        const incoming = parseBtwRecords(body.records);
        if (incoming.length > 0) setRecords((previous) => mergeBtwSnapshot(previous, incoming));
      } catch {
        // Best effort: the live frames and the next read carry on from here.
      } finally {
        if (loadRef.current?.sessionId === sid) loadRef.current = null;
      }
    })();
    loadRef.current = { sessionId: sid, promise };
    return promise;
  }, []);

  // Another chat starts from nothing: topics, a half-typed state and any error belong to the one left.
  const lastSessionRef = useRef(sessionId);
  useEffect(() => {
    const previous = lastSessionRef.current;
    lastSessionRef.current = sessionId;
    if (previous === null || previous === sessionId) return;
    pendingDeltasRef.current.clear();
    setRecords([]);
    setOpen(false);
    setError(null);
    setSupported(unsupportedForPage ? false : null);
  }, [sessionId]);

  useEffect(() => {
    if (!capable || engineOk !== true || unsupportedForPage || !sessionId) return;
    void load(sessionId);
  }, [capable, engineOk, sessionId, load]);

  const answering = hasRunningBtw(records);
  useEffect(() => {
    if (!answering || !sessionId) return;
    const timer = setInterval(() => void load(sessionId), ANSWER_RECONCILE_MS);
    return () => clearInterval(timer);
  }, [answering, sessionId, load]);

  const flushDeltas = useCallback(() => {
    cancelFlushRef.current?.();
    cancelFlushRef.current = null;
    const pending = pendingDeltasRef.current;
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    setRecords((previous) => {
      let next = previous;
      for (const [recordId, delta] of batch) next = applyBtwFrame(next, { type: "btw_delta", recordId, delta });
      return next;
    });
  }, []);

  const applyFrame = useCallback((frame: { type?: unknown; [key: string]: unknown }) => {
    if (frame.type === "btw_delta") {
      const recordId = typeof frame.recordId === "string" ? frame.recordId : "";
      const delta = typeof frame.delta === "string" ? frame.delta : "";
      if (!recordId || !delta) return;
      const pending = pendingDeltasRef.current;
      pending.set(recordId, (pending.get(recordId) ?? "") + delta);
      cancelFlushRef.current ??= scheduleFlush(flushDeltas);
      return;
    }
    if (frame.type === "btw_record") {
      // Anything queued is older than this record and is applied first, so order holds.
      flushDeltas();
      setRecords((previous) => applyBtwFrame(previous, frame));
    }
  }, [flushDeltas]);

  const ask = useCallback(async (question: string, recordId?: string): Promise<SideQuestionOutcome> => {
    const refuse = (key: string): SideQuestionOutcome => ({ ok: false, message: translate(key) });
    const text = question.trim();
    const sid = sessionIdRef.current;
    if (!text) return refuse("btw.errorEmpty");
    if (unsupportedForPage || engineOkRef.current === false) return refuse("btw.errorUnsupported");
    if (!sid || !capableRef.current) return refuse("btw.noSession");
    if (askingRef.current) return refuse("btw.errorBusy");
    askingRef.current = true;
    setAsking(true);
    try {
      await ensureStreamRef.current(sid);
      const result = await withBackstop(sendAgentCommand<{ record?: unknown } | null>(sid, {
        type: "btw",
        question: text,
        ...(recordId ? { recordId } : {}),
      }));
      const record = parseBtwRecord(result?.record);
      if (aliveRef.current) {
        setSupported(true);
        if (record) setRecords((previous) => mergeBtwSnapshot(previous, [record]));
      }
      return { ok: true };
    } catch (cause) {
      const described = describeBtwError(cause);
      if (described.kind === "unsupported") {
        unsupportedForPage = true;
        if (aliveRef.current) setSupported(false);
      }
      // Our view of what is running disagreed with the engine's: read it again.
      if (described.kind === "busy" || described.kind === "unknown_topic") void load(sid);
      return { ok: false, message: translate(described.key, { message: described.detail }) };
    } finally {
      askingRef.current = false;
      if (aliveRef.current) setAsking(false);
    }
  }, [load]);

  const openAsk = useCallback(() => {
    setOpen(true);
    setFocusRequest((value) => value + 1);
  }, []);

  const askFromPanel = useCallback(async (question: string, recordId?: string): Promise<boolean> => {
    setError(null);
    const outcome = await ask(question, recordId);
    if (!outcome.ok && aliveRef.current) setError(outcome.message);
    return outcome.ok;
  }, [ask]);

  const askFromComposer = useCallback(async (question: string): Promise<SideQuestionOutcome> => {
    if (!question) {
      if (unsupportedForPage || engineOkRef.current === false) return { ok: false, message: translate("btw.errorUnsupported") };
      if (!sessionIdRef.current || !capableRef.current) return { ok: false, message: translate("btw.noSession") };
      openAsk();
      return { ok: true };
    }
    setError(null);
    const outcome = await ask(question);
    // Success shows the answer arriving; a refusal goes back to the composer as a toast, not into the panel.
    if (outcome.ok && aliveRef.current) setOpen(true);
    return outcome;
  }, [ask, openAsk]);

  const cancel = useCallback((recordId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    void (async () => {
      try {
        await sendAgentCommand(sid, { type: "btw_cancel", recordId });
      } catch (cause) {
        const described = describeBtwError(cause);
        if (aliveRef.current) setError(translate(described.key, { message: described.detail }));
      }
      // The cancelled record normally arrives as a frame; this covers a stream that is not attached.
      void load(sid);
    })();
  }, [load]);

  const noteStreamConnected = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid && capableRef.current && !unsupportedForPage) void load(sid);
  }, [load]);

  const noteHistoryNotice = useCallback((message: string) => {
    const described = describeBtwError(message);
    setError(translate(described.key, { message: described.detail }));
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return {
    available: capable && engineOk === true && supported !== false && !unsupportedForPage,
    records,
    answering,
    asking,
    open,
    setOpen,
    error,
    dismissError,
    focusRequest,
    askFromPanel,
    askFromComposer,
    cancel,
    applyFrame,
    noteStreamConnected,
    noteHistoryNotice,
  };
}
