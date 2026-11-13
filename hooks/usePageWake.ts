"use client";

import { useEffect, useRef } from "react";
import { subscribePageWake, type WakeEvent } from "@/lib/page-wake";

/**
 * Run `onWake` when the page wakes up: the tab came back after being hidden,
 * the device slept with it open, the network returned, or the page was
 * restored from the back/forward cache (lib/page-wake holds the rules). Every
 * burst of those signals arrives as ONE call, a moment after the first.
 *
 * The callback is read through a ref, so a surface can pass a fresh closure on
 * every render without re-subscribing. `enabled: false` unsubscribes.
 */
export function usePageWake(onWake: (event: WakeEvent) => void, enabled = true): void {
  const latest = useRef(onWake);
  latest.current = onWake;
  useEffect(() => {
    if (!enabled) return;
    return subscribePageWake((event) => latest.current(event));
  }, [enabled]);
}
