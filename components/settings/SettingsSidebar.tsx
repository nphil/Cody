"use client";

/**
 * The desktop rail: a 230px vertical tablist grouped under three eyebrows
 * (You / {engine} / Server), each row a hub label over a one-line status
 * read from the shared route cache. Arrow keys move between rows; Home and
 * End jump. `SettingsSearch`'s results list is what replaces this column
 * while a query is typed, on desktop and on the phone root alike.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useI18n, LOCALES } from "@/lib/i18n";
import { STORAGE_EVENTS, STORAGE_KEYS } from "@/lib/storage-keys";
import { useTheme } from "@/hooks/useTheme";
import { useSettingsRoutes } from "@/hooks/useSettingsData";
import type { ActiveEngineInfo, EngineCapabilities } from "../SettingsTabs";
import { groupLabel, groupSections, type SettingsSection, type SettingsSectionId, type ShellData, type StatusLine } from "./registry";

function readSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const value = window.localStorage.getItem(STORAGE_KEYS.soundEnabled);
    return value === null ? true : value === "true";
  } catch {
    return true;
  }
}

/** The browser-local facts the Preferences row summarises, kept live. */
export function useLocalPrefsSummary(): ShellData["local"] {
  const { locale } = useI18n();
  const { theme } = useTheme();
  const [soundEnabled, setSoundEnabled] = useState(true);
  useEffect(() => {
    setSoundEnabled(readSoundEnabled());
    const onChange = () => setSoundEnabled(readSoundEnabled());
    window.addEventListener(STORAGE_EVENTS.soundPrefChange, onChange);
    return () => window.removeEventListener(STORAGE_EVENTS.soundPrefChange, onChange);
  }, []);
  const localeLabel = LOCALES.find((item) => item.value === locale)?.label ?? locale;
  return useMemo(() => ({ localeLabel, themeName: theme.name, soundEnabled }), [localeLabel, theme.name, soundEnabled]);
}

/** Status lines for a set of sections from cached reads only. */
export function useSectionStatuses(sections: readonly SettingsSection[], capabilities: EngineCapabilities, engine: ActiveEngineInfo | null, harnessLabel: string): Map<SettingsSectionId, StatusLine | null> {
  const routes = useMemo(() => [...new Set(sections.flatMap((section) => section.statusRoutes ?? []))], [sections]);
  const bodies = useSettingsRoutes(routes);
  const local = useLocalPrefsSummary();
  return useMemo(() => {
    const data: ShellData = { capabilities, engine, harnessLabel, routes: bodies, local };
    const statuses = new Map<SettingsSectionId, StatusLine | null>();
    for (const section of sections) {
      let line: StatusLine | null = null;
      try {
        line = section.statusLine?.(data) ?? null;
      } catch {
        line = null;
      }
      statuses.set(section.id, line);
    }
    return statuses;
  }, [sections, capabilities, engine, harnessLabel, bodies, local]);
}

const TONE_COLOR: Record<NonNullable<StatusLine["tone"]>, string> = {
  muted: "var(--text-dim)",
  accent: "var(--accent)",
  warn: "var(--status-warning)",
};

export function SettingsSidebar({ sections, active, onSelect, capabilities, engine, harnessLabel }: {
  sections: readonly SettingsSection[];
  active: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
  capabilities: EngineCapabilities;
  engine: ActiveEngineInfo | null;
  harnessLabel: string;
}) {
  const statuses = useSectionStatuses(sections, capabilities, engine, harnessLabel);
  const groups = groupSections(sections, "desktop");
  const flat = groups.flatMap((group) => group.sections);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = index + 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = index - 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = flat.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      const next = flat[nextIndex] ?? flat[index];
      if (next) {
        onSelect(next.id);
        document.getElementById(`settings-tab-${next.id}`)?.focus();
      }
    }
  };

  return (
    <nav
      aria-label="Settings sections"
      role="tablist"
      aria-orientation="vertical"
      className="settings-rail"
      style={{ display: "flex", flexDirection: "column", gap: 2, padding: "10px 8px 12px", width: 230, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--bg-panel)", overflowY: "auto" }}
    >
      {groups.map((group, groupIndex) => (
        <div key={group.group} role="presentation" style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: groupIndex === 0 ? 0 : 10 }}>
          <div aria-hidden="true" style={{ padding: "4px 10px 3px", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" }}>
            {groupLabel(group.group, harnessLabel)}
          </div>
          {group.sections.map((section) => {
            const { id, label, Icon } = section;
            const selected = id === active;
            const status = statuses.get(id) ?? null;
            const index = flat.indexOf(section);
            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={`settings-tab-${id}`}
                aria-selected={selected}
                aria-controls={`settings-panel-${id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelect(id)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className="settings-rail-row ui-focus-ring"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "8px 10px",
                  minHeight: 44,
                  border: "none",
                  borderRadius: "var(--radius-control)",
                  background: selected ? "var(--bg-selected)" : "transparent",
                  color: selected ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "background var(--dur-fast), color var(--dur-fast)",
                  width: "100%",
                }}
              >
                <Icon size={16} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0, color: selected ? "var(--accent)" : "currentColor" }} />
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ fontSize: 12.5, fontWeight: selected ? 600 : 500, lineHeight: 1.3, color: selected ? "var(--text)" : "inherit" }}>{label}</div>
                  {status && (
                    <div style={{ fontSize: 10.5, color: TONE_COLOR[status.tone ?? "muted"], lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={status.text}>
                      {status.text}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
