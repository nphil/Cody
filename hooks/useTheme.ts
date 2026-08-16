"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_THEME_ID,
  getAlternateTheme,
  getTheme,
  isThemeId,
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
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(value) ? value : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
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
