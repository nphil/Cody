"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Client state for engine installs, shared by the onboarding picker and the
 * Settings engine card. Each engine installs independently — starting one
 * neither disables nor clobbers another's progress. (The previous
 * single-string `installing` state disabled every button on screen, which is
 * why a second engine's Install did nothing while the first npm ran.)
 *
 * `start` POSTs /api/engines/install — the authoritative call whose response
 * settles the install — and follows GET /api/engines/install/events for live
 * npm output. `watch` only follows: it reattaches to an install already
 * running server-side (roster rows report `installing: true` after a reload).
 */

type InstallOutcome = { message: string; detail: string } | null;

type InstallStreamEvent =
  | { type: "snapshot"; status: "idle" | "running" | "succeeded" | "failed"; log: string; error: InstallOutcome }
  | { type: "log"; chunk: string }
  | { type: "done"; ok: boolean; error: InstallOutcome };

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line) return line;
  }
  return "";
}

function outcomeMessage(error: InstallOutcome): string {
  if (!error) return "Install failed";
  return [error.message, error.detail].filter(Boolean).join(": ");
}

export function useEngineInstalls(onSettled: (id: string, ok: boolean) => void) {
  const [installing, setInstalling] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Which ids are live, and whether we started the install or only attached
  // to one. Refs, not state: settle() must be idempotent across the two
  // completion signals (POST response and SSE done frame).
  const activeRef = useRef(new Map<string, "start" | "watch">());
  const sourcesRef = useRef(new Map<string, EventSource>());
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const setProgressLine = useCallback((id: string, line: string) => {
    if (!line) return;
    setProgress((previous) => ({ ...previous, [id]: line }));
  }, []);

  const settle = useCallback((id: string, ok: boolean, message?: string) => {
    if (!activeRef.current.delete(id)) return;
    sourcesRef.current.get(id)?.close();
    sourcesRef.current.delete(id);
    setInstalling((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    setProgress((previous) => {
      const rest = { ...previous };
      delete rest[id];
      return rest;
    });
    if (!ok) setErrors((previous) => ({ ...previous, [id]: message || "Install failed" }));
    onSettledRef.current(id, ok);
  }, []);

  const follow = useCallback((id: string) => {
    if (sourcesRef.current.has(id)) return;
    const source = new EventSource(`/api/engines/install/events?id=${encodeURIComponent(id)}`);
    sourcesRef.current.set(id, source);
    source.onmessage = (message: MessageEvent<string>) => {
      let event: InstallStreamEvent;
      try {
        event = JSON.parse(message.data) as InstallStreamEvent;
      } catch {
        return;
      }
      if (event.type === "log") {
        setProgressLine(id, lastLine(event.chunk));
      } else if (event.type === "snapshot") {
        if (event.status === "running") {
          setProgressLine(id, lastLine(event.log));
        } else if (activeRef.current.get(id) === "watch") {
          // The install we were asked to reattach to already ended (or never
          // reached this server process). The roster refetch tells the truth.
          settle(id, event.status !== "failed", outcomeMessage(event.error));
        }
        // In "start" mode a non-running snapshot is just the stream opening
        // before the POST landed; the POST response settles the install.
      } else if (event.type === "done") {
        settle(id, event.ok, outcomeMessage(event.error));
      }
    };
    // EventSource reconnects on its own; a transient error frame needs no
    // handling — completion always arrives via done/snapshot or the POST.
  }, [setProgressLine, settle]);

  const begin = useCallback((id: string, mode: "start" | "watch") => {
    if (activeRef.current.has(id)) return false;
    activeRef.current.set(id, mode);
    setErrors((previous) => {
      if (!(id in previous)) return previous;
      const rest = { ...previous };
      delete rest[id];
      return rest;
    });
    setInstalling((previous) => new Set(previous).add(id));
    follow(id);
    return true;
  }, [follow]);

  const start = useCallback((id: string, options?: { version?: string }) => {
    if (!begin(id, "start")) return;
    void fetch("/api/engines/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...(options?.version ? { version: options.version } : {}) }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { error?: string; detail?: string } | null;
        if (!response.ok) {
          throw new Error([body?.error, body?.detail].filter(Boolean).join(": ") || `HTTP ${response.status}`);
        }
      })
      .then(() => settle(id, true))
      .catch((failure: unknown) => {
        settle(id, false, failure instanceof Error ? failure.message : String(failure));
      });
  }, [begin, settle]);

  const watch = useCallback((id: string) => {
    begin(id, "watch");
  }, [begin]);

  useEffect(() => {
    const sources = sourcesRef.current;
    return () => {
      for (const source of sources.values()) source.close();
      sources.clear();
    };
  }, []);

  return { installing, progress, errors, start, watch };
}
