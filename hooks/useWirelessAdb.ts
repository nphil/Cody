"use client";

import { useEffect, useRef, useState } from "react";
import { pollDelay, readWireless, scrub, sendWireless, WirelessRequestError } from "@/lib/devices/wireless-browser";
import type { WirelessAction, WirelessSnapshot } from "@/lib/devices/wireless-types";

export type WirelessActionKind = WirelessAction["action"];

export interface WirelessController {
  /** What the server says about THIS chat's tablet; null until the first answer. Never another chat's. */
  snapshot: WirelessSnapshot | null;
  /** Why the last read failed; the snapshot (if any) is the last good one. */
  loadError: string | null;
  /** The action in flight for this chat, if any. */
  busy: WirelessActionKind | null;
  /** Why the last action was refused or failed; the pairing code is never in it. */
  actionError: WirelessActionError | null;
  retry: () => void;
  /** Resolves true when the server accepted it. The code is used for this one request and is not kept. */
  pair: (fields: { host: string; pairingPort: number; connectPort: number; code: string }) => Promise<boolean>;
  connect: (endpoint?: { host: string; connectPort: number }) => Promise<boolean>;
  disconnect: () => Promise<boolean>;
  forget: () => Promise<boolean>;
  answerRoot: (requestId: string, decision: "approve" | "deny") => Promise<boolean>;
}

interface WirelessActionError { action: WirelessActionKind; message: string; code?: string }

interface View {
  sessionId: string;
  snapshot: WirelessSnapshot | null;
  loadError: string | null;
  busy: WirelessActionKind | null;
  actionError: WirelessActionError | null;
}

interface SessionRequests {
  sessionId: string;
  run: (action: WirelessAction) => Promise<boolean>;
  retry: () => void;
}

function emptyView(sessionId: string): View {
  return { sessionId, snapshot: null, loadError: null, busy: null, actionError: null };
}

export function useWirelessAdb(sessionId: string): WirelessController {
  const [held, setView] = useState(() => emptyView(sessionId));
  const requests = useRef<SessionRequests | null>(null);

  // Reset before children render, even when switching A → B → A while B's first request is pending.
  const view = held.sessionId === sessionId ? held : emptyView(sessionId);
  if (view !== held) setView(view);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let poll: AbortController | undefined;
    let last: WirelessSnapshot | null = null;
    let busy = false;

    const update = (fields: Partial<Omit<View, "sessionId">>): void => {
      if (alive) setView((current) => current.sessionId === sessionId ? { ...current, ...fields } : current);
    };
    const schedule = (): void => {
      window.clearTimeout(timer);
      const delay = pollDelay(last, document.hidden);
      if (alive && delay !== null) timer = window.setTimeout(() => void look(), delay);
    };
    const apply = (snapshot: WirelessSnapshot): void => {
      last = snapshot;
      update({ snapshot, loadError: null });
      schedule();
    };
    const look = async (): Promise<void> => {
      window.clearTimeout(timer);
      poll?.abort();
      if (!alive || document.hidden) return;
      const mine = new AbortController();
      poll = mine;
      try {
        const snapshot = await readWireless(sessionId, mine.signal);
        if (!mine.signal.aborted) apply(snapshot);
      } catch (error) {
        if (mine.signal.aborted) return;
        update({ loadError: error instanceof Error ? error.message : String(error) });
        schedule();
      }
    };
    const wake = (): void => { void look(); };

    requests.current = {
      sessionId,
      retry: wake,
      async run(action) {
        if (!alive || busy) return false;
        busy = true;
        update({ busy: action.action, actionError: null });
        try {
          const snapshot = await sendWireless(action);
          if (!alive) return false;
          // An older GET can still be on the wire when a POST finishes. Never let it replace the new state.
          poll?.abort();
          apply(snapshot);
          return true;
        } catch (error) {
          if (!alive) return false;
          const text = error instanceof Error ? error.message : String(error);
          update({ actionError: { action: action.action, message: scrub(text, action.action === "pair" ? action.code : undefined), code: error instanceof WirelessRequestError ? error.code : undefined } });
          wake();
          return false;
        } finally {
          busy = false;
          update({ busy: null });
        }
      },
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    wake();
    return () => {
      alive = false;
      requests.current = null;
      window.clearTimeout(timer);
      poll?.abort();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [sessionId]);

  const run = (action: WirelessAction): Promise<boolean> => {
    const current = requests.current;
    return current?.sessionId === sessionId ? current.run(action) : Promise.resolve(false);
  };

  // Bind each click to the selection this render displayed, not a later poll or tab action.
  const selectionId = view.snapshot?.device?.selectionId;

  return {
    snapshot: view.snapshot,
    loadError: view.loadError,
    busy: view.busy,
    actionError: view.actionError,
    retry: () => { if (requests.current?.sessionId === sessionId) requests.current.retry(); },
    pair: (fields) => run({ action: "pair", sessionId, ...fields }),
    connect: async (endpoint) => !!selectionId && run({ action: "connect", sessionId, selectionId, ...endpoint }),
    disconnect: async () => !!selectionId && run({ action: "disconnect", sessionId, selectionId }),
    forget: async () => !!selectionId && run({ action: "forget", sessionId, selectionId }),
    answerRoot: async (requestId, decision) => !!selectionId && run({ action: "root", sessionId, selectionId, requestId, decision }),
  };
}
