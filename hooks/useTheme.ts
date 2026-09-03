"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_THEME_ID,
  getAlternateTheme,
  getTheme,
  isThemeId,
  resolveInitialThemeId,
  THEME_STORAGE_KEY,
  type ThemeId,
} from "@/lib/theme-catalog";

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function storedThemeId(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  // The page already decided before first paint — the server rendered the
  // account's saved theme, or the bootstrap script chose from storage and the
  // device's colour scheme. The DOM is the truth; re-deriving it here from
  // storage alone is how a phone could show one theme and report another.
  const applied = document.documentElement.dataset.theme;
  if (isThemeId(applied ?? null)) return applied as ThemeId;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage is unavailable; the colour-scheme fallback below still applies.
  }
  return resolveInitialThemeId(stored, window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
}

/**
 * Save the choice to the account, so it follows the user to every other
 * browser and device on the next load. Fire-and-forget: a signed-out page (the
 * login screen has the picker too) answers 401, and a network blip loses
 * nothing that the next pick will not resave. Only ever called from a user's
 * own pick, never on boot, so a device merely applying the saved theme does
 * not write it straight back.
 */
function persistAccountTheme(themeId: string): void {
  if (typeof fetch !== "function") return;
  void fetch("/api/accounts/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme: themeId }),
    keepalive: true,
  }).catch(() => {});
}

function applyTheme(themeId: ThemeId): void {
  const theme = getTheme(themeId);
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.classList.toggle("dark", theme.mode === "dark");
  document.querySelectorAll('meta[name="theme-color"]').forEach((element) => {
    element.setAttribute("content", theme.preview.background);
  });
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme.id);
  } catch {
    // Theme selection remains usable when storage is unavailable.
  }
  persistAccountTheme(theme.id);
  listeners.forEach((cb) => cb());
}

function getServerSnapshot(): ThemeId {
  return DEFAULT_THEME_ID;
}

type ToggleOrigin = { x: number; y: number };

function motionDurationMs(variable: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (raw.endsWith("ms")) {
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
  }
  if (raw.endsWith("s")) {
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value * 1000 : fallback;
  }
  return fallback;
}

export function useTheme() {
  const themeId = useSyncExternalStore(subscribe, storedThemeId, getServerSnapshot);
  const theme = getTheme(themeId);

  const setTheme = useCallback((next: ThemeId, origin?: ToggleOrigin) => {
    const apply = () => applyTheme(next);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsVT = typeof document.startViewTransition === "function";
    if (!supportsVT || reduceMotion) {
      apply();
      return;
    }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(apply);
    transition.ready.then(() => {
      const styles = getComputedStyle(document.documentElement);
      document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] }, {
        duration: motionDurationMs("--dur-theme", 450),
        easing: styles.getPropertyValue("--ease-out-warm").trim() || "ease-out",
        pseudoElement: "::view-transition-new(root)",
      });
    }).catch(() => {});
    transition.finished?.catch(() => {});
  }, []);

  const toggleTheme = useCallback(
    (origin?: ToggleOrigin) => setTheme(getAlternateTheme(themeId).id, origin),
    [themeId, setTheme],
  );

  return { theme, themeId, isDark: theme.mode === "dark", setTheme, toggleTheme };
}
