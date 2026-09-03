"use client";

import { useEffect } from "react";

/**
 * A viewport shrink smaller than this is browser chrome (iOS Safari's toolbar
 * collapsing, a URL bar animating) and is already tracked by `100dvh`; only a
 * larger one is a soft keyboard.
 */
export const KEYBOARD_MIN_INSET = 100;

/**
 * How tall the app should be while a soft keyboard is up, or null when
 * nothing is covering the layout viewport.
 *
 * On iOS the keyboard does not resize the layout viewport — `100dvh` and
 * `window.innerHeight` stay the same — it covers the bottom of it and Safari
 * scrolls the page to keep the focused field in view. For an app that is
 * exactly one screen tall that means the top bar slides off the top while the
 * bottom-docked composer disappears under the keyboard. The visual viewport
 * is the part actually visible, so sizing the app to it keeps both on screen.
 * Android's Chrome shrinks the layout viewport itself, so the difference there
 * is ~0 and this correctly stays out of the way.
 */
export function keyboardAwareHeight(visualHeight: number, layoutHeight: number): number | null {
  if (!Number.isFinite(visualHeight) || !Number.isFinite(layoutHeight)) return null;
  return layoutHeight - visualHeight >= KEYBOARD_MIN_INSET ? Math.round(visualHeight) : null;
}

/** Sets `--app-height` on <html> while a soft keyboard is up, on phones only. */
export function useVisualViewportHeight(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const apply = () => {
      const height = keyboardAwareHeight(viewport.height, window.innerHeight);
      if (height === null) {
        root.style.removeProperty("--app-height");
        return;
      }
      root.style.setProperty("--app-height", `${height}px`);
      // Safari has already scrolled the layout viewport to chase the focused
      // field; with the app now sized to the visible part that scroll only
      // hides the top bar.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    apply();
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      root.style.removeProperty("--app-height");
    };
  }, [enabled]);
}
