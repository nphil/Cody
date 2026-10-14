"use client";

import { useSyncExternalStore } from "react";
import type { MachineState, MachineStreamFrame } from "@/lib/machines/types";

const STREAM_URL = "/api/machines/stream";
/** The server sends a heartbeat every 10 s; this much silence means the
 * connection is dead even though the browser has not noticed yet. */
const SILENCE_LIMIT_MS = 30_000;
const WATCHDOG_MS = 10_000;
/** After a refusal (signed out, too many pages), try again slowly. */
const RETRY_MS = [2_000, 5_000, 15_000, 30_000];

export interface LiveMachines {
  machines: MachineState[];
  /** False while the stream is down or the page is hidden: what is shown is the
   * last thing heard, not the machine right now. */
  live: boolean;
}

/**
 * One store for the whole page, not state in a component. A frame arrives every
 * second or two for as long as the page is open; held in `AppShell` it would
 * re-render the entire shell (and a phone's battery) for a pair of tiny bars.
 * The two components that draw machines subscribe here instead, so only they
 * re-render, and they share ONE stream: it opens with the first of them and
 * closes with the last.
 */
let snapshot: LiveMachines | null = null;
const listeners = new Set<() => void>();
let disconnect: (() => void) | null = null;

function publish(next: LiveMachines | null): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function markStale(): void {
  if (snapshot?.live) publish({ ...snapshot, live: false });
}

/**
 * Hold `GET /api/machines/stream` open while the page is visible: the server
 * samples only while someone is subscribed (and stops a minute after the last
 * viewer), so a hidden tab is what lets every ssh connection to the person's
 * other machines close. Returns the function that tears it all down.
 */
function connect(): () => void {
  let source: EventSource | null = null;
  let retryTimer: number | undefined;
  let watchdog: number | undefined;
  let lastFrameAt = 0;
  let refusals = 0;
  let disposed = false;

  const close = () => {
    source?.close();
    source = null;
    window.clearTimeout(retryTimer);
    window.clearInterval(watchdog);
  };

  const open = () => {
    if (disposed || source || document.visibilityState !== "visible") return;
    const stream = new EventSource(STREAM_URL);
    source = stream;
    lastFrameAt = Date.now();
    stream.onmessage = (event) => {
      lastFrameAt = Date.now();
      let frame: MachineStreamFrame;
      try {
        frame = JSON.parse(event.data) as MachineStreamFrame;
      } catch {
        return;
      }
      if (frame.type !== "machines" || !Array.isArray(frame.machines)) return;
      refusals = 0;
      publish({ machines: frame.machines, live: true });
    };
    stream.onerror = () => {
      markStale();
      // The browser reconnects a dropped stream by itself. A refusal closes
      // it for good, and that is retried here, slowly.
      if (stream.readyState !== EventSource.CLOSED) return;
      close();
      retryTimer = window.setTimeout(open, RETRY_MS[Math.min(refusals, RETRY_MS.length - 1)]);
      refusals += 1;
    };
    watchdog = window.setInterval(() => {
      if (Date.now() - lastFrameAt <= SILENCE_LIMIT_MS) return;
      close();
      open();
    }, WATCHDOG_MS);
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      open();
    } else {
      close();
      markStale();
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  open();
  return () => {
    disposed = true;
    document.removeEventListener("visibilitychange", onVisibility);
    close();
    markStale();
  };
}

/** The store's two halves, exported so the connection rules can be tested
 * without a renderer; the hook below is `useSyncExternalStore` over them. */
export function subscribeMachineMeters(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) disconnect = connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    disconnect?.();
    disconnect = null;
  };
}

export function getMachineMetersSnapshot(): LiveMachines | null {
  return snapshot;
}

const getServerSnapshot = (): LiveMachines | null => null;

/** The live CPU and memory of every machine Cody shows; null until the first
 * frame arrives. */
export function useMachineMeters(): LiveMachines | null {
  return useSyncExternalStore(subscribeMachineMeters, getMachineMetersSnapshot, getServerSnapshot);
}
