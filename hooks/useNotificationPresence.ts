"use client";

import { useEffect } from "react";

const PRESENCE_ROUTE = "/api/notifications/presence";

/** The server treats a report as fresh for 75 s, so twice per window is enough. */
export const PRESENCE_HEARTBEAT_MS = 30_000;

function presenceBody(sessionId: string | null): string {
  return JSON.stringify({ sessionId });
}

/** Failures are silent on purpose: presence only ever suppresses a push, and
 * a missed report means at worst one notification for a chat you were reading. */
function postPresence(sessionId: string | null): void {
  void fetch(PRESENCE_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: presenceBody(sessionId),
    keepalive: true,
  }).catch(() => {});
}

/** Last word as the page goes away: a beacon survives unload where fetch may not. */
function beaconNobody(): void {
  try {
    const blob = new Blob([presenceBody(null)], { type: "application/json" });
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(PRESENCE_ROUTE, blob)) return;
  } catch {
    // Fall through to the keepalive request.
  }
  postPresence(null);
}

/**
 * Tells the server which chat this tab is looking at, so "skip the chat I'm
 * looking at" can hold back a push for it (`/api/notifications/presence`).
 *
 * - Reports the selected chat when it changes and when the tab becomes visible,
 *   then repeats every 30 s while the tab stays visible.
 * - Reports nobody (`null`) when the tab is hidden and, by beacon, on pagehide.
 * - Never sends while the document is hidden, except that hand-off to nobody.
 *
 * Mount it once inside the signed-in shell.
 */
export function useNotificationPresence(selectedSessionId: string | null): void {
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const report = () => {
      if (document.visibilityState === "visible") postPresence(selectedSessionId);
    };
    const start = () => {
      stop();
      if (document.visibilityState !== "visible") return;
      report();
      timer = window.setInterval(report, PRESENCE_HEARTBEAT_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        start();
        return;
      }
      stop();
      postPresence(null);
    };

    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", beaconNobody);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", beaconNobody);
    };
  }, [selectedSessionId]);
}
