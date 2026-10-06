"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelScheduled as cancelScheduledRequest,
  createScheduled as createScheduledRequest,
  ScheduledRequestError,
  sendScheduledNow as sendScheduledNowRequest,
  updateScheduled as updateScheduledRequest,
} from "@/lib/scheduled/client";
import { createScheduledSync, type ScheduledSync, type ScheduledSyncState } from "@/lib/scheduled/sync";
import { SCHEDULED_LIMITS } from "@/lib/scheduled/types";
import type { CreateScheduledBody, ScheduledItemView, ScheduledSendNowResponse, UpdateScheduledBody } from "@/lib/scheduled/types";

const NO_ITEMS: readonly ScheduledItemView[] = [];
const NO_BUSY: ReadonlySet<string> = new Set();

export interface UseScheduledMessages {
  /** This chat's scheduled messages, soonest first. Empty until the first read lands, and for a chat that does not exist yet. */
  items: readonly ScheduledItemView[];
  limits: typeof SCHEDULED_LIMITS;
  /** The server has answered for this chat at least once. */
  loaded: boolean;
  /** Ids with a request of the person's own in flight (Edit, Send now, Cancel pressed). */
  busy: ReadonlySet<string>;
  /** Read now. */
  refresh: () => void;
  /** Rejects with `ScheduledRequestError`; on success the new row is already in `items`. */
  create: (body: CreateScheduledBody) => Promise<ScheduledItemView>;
  update: (itemId: string, body: UpdateScheduledBody) => Promise<ScheduledItemView>;
  /** Cancel. Rejects with `already_sending` once the message is on its way. */
  cancel: (itemId: string) => Promise<void>;
  /** Send one now (a failed message's Retry). `delivered` true means it is in the chat and its row is gone. */
  sendNow: (itemId: string) => Promise<ScheduledSendNowResponse>;
}

/**
 * The composer's scheduled messages for one chat.
 *
 * The list is read when the chat opens, when the tab comes back, when the
 * network returns, when a run ends (the agent may have scheduled something
 * during it) and at the moment the next pending message is due — never on a
 * fixed cadence (lib/scheduled/sync.ts holds the rules and their tests). A
 * chat that has no id yet reads nothing and shows nothing.
 */
export function useScheduledMessages(sessionId: string | null | undefined, options: { isStreaming?: boolean } = {}): UseScheduledMessages {
  const [state, setState] = useState<ScheduledSyncState | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(NO_BUSY);
  const syncRef = useRef<ScheduledSync | null>(null);
  const sessionRef = useRef<string | null>(sessionId ?? null);
  sessionRef.current = sessionId ?? null;

  useEffect(() => {
    const sync = createScheduledSync({
      onChange: setState,
      isVisible: () => document.visibilityState === "visible",
    });
    syncRef.current = sync;
    const onVisibility = () => sync.visibilityChanged();
    const onWake = () => {
      if (document.visibilityState === "visible") sync.refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    sync.setSession(sessionRef.current);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      sync.dispose();
      syncRef.current = null;
    };
  }, []);

  useEffect(() => {
    syncRef.current?.setSession(sessionId ?? null);
  }, [sessionId]);

  // A run ending is the one moment an agent's own `schedule_message` call is known to be over.
  const wasStreamingRef = useRef(false);
  const streaming = options.isStreaming === true;
  useEffect(() => {
    const was = wasStreamingRef.current;
    wasStreamingRef.current = streaming;
    if (was && !streaming) syncRef.current?.refresh();
  }, [streaming]);

  const refresh = useCallback(() => syncRef.current?.refresh(), []);

  /** Run one of the person's own requests against one row, remembering which row is busy until it settles. */
  const track = useCallback(async <T,>(itemId: string, request: () => Promise<T>): Promise<T> => {
    setBusy((current) => new Set(current).add(itemId));
    try {
      return await request();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next.size === 0 ? NO_BUSY : next;
      });
    }
  }, []);

  const requireSession = useCallback((): string => {
    const id = sessionRef.current;
    if (!id) throw new ScheduledRequestError("There is no chat to schedule into yet.", 404, "session_not_found");
    return id;
  }, []);

  const create = useCallback(async (body: CreateScheduledBody) => {
    const item = await createScheduledRequest(requireSession(), body);
    syncRef.current?.upsert(item);
    return item;
  }, [requireSession]);

  const update = useCallback((itemId: string, body: UpdateScheduledBody) => track(itemId, async () => {
    const item = await updateScheduledRequest(requireSession(), itemId, body);
    syncRef.current?.upsert(item);
    return item;
  }), [requireSession, track]);

  const cancel = useCallback((itemId: string) => track(itemId, async () => {
    await cancelScheduledRequest(requireSession(), itemId);
    syncRef.current?.remove(itemId);
  }), [requireSession, track]);

  const sendNow = useCallback((itemId: string) => track(itemId, async () => {
    const answer = await sendScheduledNowRequest(requireSession(), itemId);
    if (answer.item) syncRef.current?.upsert(answer.item);
    else syncRef.current?.remove(itemId);
    return answer;
  }), [requireSession, track]);

  // The render in which the chat changed still holds the previous chat's rows until the effect above runs.
  const current = state !== null && state.sessionId === (sessionId ?? null) ? state : null;
  return {
    items: current?.items ?? NO_ITEMS,
    limits: current?.limits ?? SCHEDULED_LIMITS,
    loaded: current?.loaded ?? false,
    busy,
    refresh,
    create,
    update,
    cancel,
    sendNow,
  };
}
