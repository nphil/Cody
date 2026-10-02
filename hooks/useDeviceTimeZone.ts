"use client";

import { useEffect } from "react";
import { detectDeviceTimeZone } from "@/lib/time-zone";

/**
 * Whether this tab should tell the server its zone now: it can name one, that
 * zone is not the one the server last accepted from this tab, and no report is
 * already on its way (two at once can land out of order and leave the older
 * zone saved).
 */
export function shouldReportDeviceZone(current: string | null, reported: string | null, inFlight: boolean): current is string {
  return current !== null && current !== reported && !inFlight;
}

/**
 * The reporter behind the hook, with the browser and the network passed in so
 * its sequencing is testable. The returned `check` reads the zone fresh every
 * time it is called and reports it only when `shouldReportDeviceZone` says so.
 *  - A failed report is not retried in a loop: the next `check` (a focus, a
 *    reconnect) tries again, so a server that is down is not hammered.
 *  - A zone that changed while a report was in flight is reported straight
 *    after it settles, not at the next focus.
 */
export function createDeviceZoneReporter(
  detect: () => string | null,
  send: (zone: string) => Promise<boolean>,
): () => void {
  let reported: string | null = null;
  let inFlight = false;
  const check = (): void => {
    const zone = detect();
    if (!shouldReportDeviceZone(zone, reported, inFlight)) return;
    inFlight = true;
    void send(zone).then(
      (accepted) => {
        inFlight = false;
        if (!accepted) return;
        reported = zone;
        check();
      },
      () => { inFlight = false; },
    );
  };
  return check;
}

async function putDeviceZone(zone: string): Promise<boolean> {
  try {
    const response = await fetch("/api/time-zone", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceTimeZone: zone }),
    });
    return response.ok;
  } catch {
    // Silent on purpose: this is reported unasked, and a failure here is not
    // something the person did or can fix. The next focus tries again.
    return false;
  }
}

/**
 * Tells the server which time zone this browser is in, so work that nobody is
 * typing for (a scheduled job, an API call, a child started in the
 * background) still uses the zone of the device the person last used.
 *
 * Reports once on mount and again whenever the zone differs from what this
 * tab last reported, checked when the tab regains focus, becomes visible or
 * comes back online: a tablet that flew to Tokyo with the tab still open
 * reports Tokyo the next time it is picked up. Mount it only inside the
 * signed-in shell; the login screen has nobody to report for.
 */
export function useDeviceTimeZone(): void {
  useEffect(() => {
    const check = createDeviceZoneReporter(detectDeviceTimeZone, putDeviceZone);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
