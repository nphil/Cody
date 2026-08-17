"use client";

import { useSyncExternalStore } from "react";

// Touch capability is orthogonal to viewport width: a 1024px iPad is a
// desktop to every width-based media query. Shared with the
// `@media (hover: none), (pointer: coarse)` block in app/globals.css.
const COARSE_QUERY = "(hover: none), (pointer: coarse)";

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(COARSE_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(COARSE_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * True on touch-first devices (phones AND tablets), independent of viewport
 * width. SSR-safe: false on the server and first paint, then syncs.
 */
export function useIsCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
