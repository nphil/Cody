"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, Palette } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { THEMES, type ThemeDefinition, type ThemeId } from "@/lib/theme-catalog";
import { useI18n } from "@/lib/i18n";

const lightThemes = THEMES.filter((item) => item.mode === "light");
const darkThemes = THEMES.filter((item) => item.mode === "dark");

function ThemePreview({ theme }: { theme: ThemeDefinition }) {
  return (
    <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0, gap: 2, padding: 2, border: "1px solid var(--border)", borderRadius: 999, background: theme.preview.background }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: theme.preview.surface }} />
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: theme.preview.accent }} />
    </span>
  );
}

/** A direct, keyboard-operable choice of Cody's paired light and dark themes. */
export function ThemePicker() {
  const { theme, themeId, setTheme } = useTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [selectedMode, setSelectedMode] = useState<ThemeDefinition["mode"]>(theme.mode);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();
  const pickerId = `${baseId}-picker`;
  const visibleThemes = selectedMode === "light" ? lightThemes : darkThemes;
  const selectedVisibleIndex = Math.max(0, visibleThemes.findIndex((item) => item.id === themeId));

  useEffect(() => {
    if (!open) {
      setSelectedMode(theme.mode);
      setActiveIndex(selectedVisibleIndex);
    }
  }, [open, selectedVisibleIndex, theme.mode]);

  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [activeIndex, open, selectedMode]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => document.removeEventListener("pointerdown", closeOnPointerDown);
  }, [open]);

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const choose = (nextTheme: ThemeId, button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    setTheme(nextTheme, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    close(true);
  };

  const openPicker = (focusLast = false) => {
    const themes = theme.mode === "light" ? lightThemes : darkThemes;
    setSelectedMode(theme.mode);
    setActiveIndex(focusLast ? themes.length - 1 : Math.max(0, themes.findIndex((item) => item.id === themeId)));
    setOpen(true);
  };

  const selectMode = (mode: ThemeDefinition["mode"]) => {
    const themes = mode === "light" ? lightThemes : darkThemes;
    setSelectedMode(mode);
    setActiveIndex(Math.max(0, themes.findIndex((item) => item.family === theme.family)));
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " " || event.key === "ArrowUp") {
      event.preventDefault();
      openPicker(event.key === "ArrowUp");
    }
  };

  const onItemKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, nextTheme: ThemeId) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault();
        setActiveIndex((index + 1) % visibleThemes.length);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault();
        setActiveIndex((index - 1 + visibleThemes.length) % visibleThemes.length);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(visibleThemes.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(nextTheme, event.currentTarget);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", flexShrink: 0 }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => open ? close(false) : openPicker()}
        onKeyDown={onTriggerKeyDown}
        title={t("themePicker.currentTheme", { theme: theme.name })}
        aria-label={t("themePicker.currentTheme", { theme: theme.name })}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        className="shell-toolbar-btn ui-focus-ring"
        style={{ background: open ? "var(--bg-selected)" : undefined, color: open ? "var(--text)" : undefined }}
      >
        <Palette size={16} strokeWidth={1.8} aria-hidden="true" />
      </button>

      {open && (
        <div
          id={pickerId}
          role="dialog"
          aria-label={t("themePicker.chooseTheme")}
          className="dropdown-surface animate-slide-down"
          style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 250, width: "min(344px, calc(100vw - 16px))", padding: 6, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", boxShadow: "var(--shadow-pop)" }}
        >
          <div aria-label={t("themePicker.mode")} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, padding: 3, marginBottom: 6, borderRadius: 7, background: "var(--bg-hover)" }}>
            {(["light", "dark"] as const).map((mode) => {
              const selected = selectedMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => selectMode(mode)}
                  className="ui-focus-ring"
                  style={{ minHeight: 30, padding: "4px 10px", border: 0, borderRadius: 5, background: selected ? "var(--bg-panel)" : "transparent", boxShadow: selected ? "var(--shadow-card)" : "none", color: selected ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12, fontWeight: selected ? 650 : 500 }}
                >
                  {t(mode === "light" ? "themePicker.lightMode" : "themePicker.darkMode")}
                </button>
              );
            })}
          </div>
          <ul aria-label={t(selectedMode === "light" ? "themePicker.lightThemes" : "themePicker.darkThemes")} style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 4, margin: 0, padding: 0, listStyle: "none" }}>
            {visibleThemes.map((item, index) => {
              const selected = item.id === themeId;
              return (
                <li key={item.id}>
                  <button
                    ref={(element) => { itemRefs.current[index] = element; }}
                    type="button"
                    aria-pressed={selected}
                    tabIndex={-1}
                    onClick={(event) => choose(item.id, event.currentTarget)}
                    onKeyDown={(event) => onItemKeyDown(event, index, item.id)}
                    className="dropdown-item ui-focus-ring"
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 34, padding: "6px 8px", border: 0, borderRadius: 6, background: selected ? "var(--bg-selected)" : "transparent", color: selected ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
                  >
                    <ThemePreview theme={item} />
                    <span style={{ flex: 1 }}>{item.name}</span>
                    {selected && <Check size={14} strokeWidth={2} aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
