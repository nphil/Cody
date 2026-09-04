"use client";

/**
 * Settings › Preferences: everything that is a property of the human in this
 * browser (and, for the theme, of the account). Nothing here touches an
 * engine's file, so every card writes instantly and reports to the corner.
 *
 * `PREFERENCE_CARDS` is the table the cards AND the search index render from
 * (`SEARCH_ENTRIES` below is derived from it), so a label cannot be
 * searchable and unrendered, or the reverse.
 */
import { useEffect, useState } from "react";
import { getSubmitDuringRunBehavior, setSubmitDuringRunBehavior, type SubmitDuringRunBehavior } from "@/lib/composer-prefs";
import { LOCALES, useI18n, type Locale } from "@/lib/i18n";
import { STORAGE_EVENTS, STORAGE_KEYS } from "@/lib/storage-keys";
import { readTerminalSoftKeyIds, TERMINAL_SOFT_KEYS, writeTerminalSoftKeyIds, type TerminalSoftKeyId } from "@/lib/terminal-preferences";
import { THEMES, type ThemeId } from "@/lib/theme-catalog";
import { useTheme } from "@/hooks/useTheme";
import type { EngineCapabilities } from "../../SettingsTabs";
import { NativeSetting, ToggleSwitch, nativeOptionStyle, nativeSelectStyle, slugify } from "../primitives";
import { SaveStatusCorner, useSaveStatus } from "../SaveStatus";
import type { SearchEntry } from "../search-index";
import { useSettingsShell } from "../shell-context";

export const PREFERENCES_PANEL_ID = "general";

export interface PreferenceCard {
  id: string;
  label: string;
  description: string;
  scope: "Cody only";
  needsCapability?: keyof EngineCapabilities;
  /** Search keywords beyond the label and description. */
  keywords?: readonly string[];
}

export const PREFERENCE_CARDS: readonly PreferenceCard[] = [
  { id: "theme", label: "Theme", description: "Colour theme for this account, applied on every device you sign in from. The title-bar picker changes the same setting.", scope: "Cody only", keywords: ["dark", "light", "colour", "color"] },
  { id: "language", label: "Language", description: "Interface language. Auto-detected from the browser until chosen here.", scope: "Cody only", keywords: ["locale", "english", "japanese", "chinese"] },
  { id: "tool-calls", label: "Keep tool calls collapsed", description: "Show only compact headers while tools execute.", scope: "Cody only" },
  { id: "thinking", label: "Expand thinking blocks", description: "Show the model's reasoning open by default instead of behind a collapsed header.", scope: "Cody only" },
  { id: "sound", label: "Completion sound", description: "Play a tone when the agent completes a run.", scope: "Cody only", keywords: ["notification", "chime"] },
  { id: "submit", label: "Message during active run", description: "What composer does on submit while agent runs. Steer interrupts; Queue follow-up delivers after finish.", scope: "Cody only", needsCapability: "chatExtras", keywords: ["steer", "queue"] },
  { id: "soft-keys", label: "Terminal soft keys", description: "Choose the buttons shown below the terminal on touch devices. Shift Tab moves backward through terminal UI modes.", scope: "Cody only", keywords: ["touch", "keyboard"] },
];

export const SEARCH_ENTRIES: readonly SearchEntry[] = PREFERENCE_CARDS.map((card) => ({
  id: slugify(card.label),
  tab: "general",
  label: card.label,
  description: card.description,
  keywords: card.keywords,
  breadcrumb: ["Cody", "Preferences"],
  scope: card.scope,
  ...(card.needsCapability ? { needsCapability: card.needsCapability } : {}),
  action: "jump",
}));

function card(id: string): PreferenceCard {
  const found = PREFERENCE_CARDS.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown preference card: ${id}`);
  return found;
}

function readSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const value = window.localStorage.getItem(STORAGE_KEYS.soundEnabled);
    return value === null ? true : value === "true";
  } catch {
    return true;
  }
}

export function PreferencesPanel() {
  const { capabilities, isMobile, prefs } = useSettingsShell();
  const { locale, setLocale } = useI18n();
  const { themeId, setTheme } = useTheme();
  const { track } = useSaveStatus(PREFERENCES_PANEL_ID);
  const [submitBehavior, setSubmitBehavior] = useState<SubmitDuringRunBehavior>(() => getSubmitDuringRunBehavior());
  const [terminalSoftKeyIds, setTerminalSoftKeyIds] = useState<TerminalSoftKeyId[]>(() => readTerminalSoftKeyIds());
  const [soundEnabled, setSoundEnabled] = useState<boolean>(readSoundEnabled);

  useEffect(() => {
    setTerminalSoftKeyIds(readTerminalSoftKeyIds());
  }, []);

  // Local writes are synchronous; the corner still acknowledges them so a
  // change here reads the same as one that went to the server.
  const saved = (write: () => void) => { void track(async () => { write(); }); };

  const toggleTerminalSoftKey = (id: TerminalSoftKeyId) => {
    const selected = new Set(terminalSoftKeyIds);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    const next = TERMINAL_SOFT_KEYS.map((key) => key.id).filter((keyId) => selected.has(keyId));
    setTerminalSoftKeyIds(next);
    saved(() => {
      try {
        writeTerminalSoftKeyIds(next);
      } catch {
        // The preference remains live for this page even if storage is blocked.
      }
      window.dispatchEvent(new CustomEvent(STORAGE_EVENTS.terminalSoftKeysChange));
    });
  };

  const light = THEMES.filter((theme) => theme.mode === "light");
  const dark = THEMES.filter((theme) => theme.mode === "dark");
  const grid = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 } as const;

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      <SaveStatusCorner panelId={PREFERENCES_PANEL_ID} />
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Preferences</h3>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>How Cody looks and behaves for you: theme, language, transcript defaults, sounds and the composer&apos;s submit mode.</p>
      </div>
      <div style={grid}>
        <NativeSetting label={card("theme").label} description={card("theme").description} scope="Cody only">
          <select
            style={nativeSelectStyle}
            value={themeId}
            aria-label="Theme"
            onChange={(event) => saved(() => setTheme(event.target.value as ThemeId))}
          >
            <optgroup label="Light">
              {light.map((theme) => <option key={theme.id} value={theme.id} style={nativeOptionStyle}>{theme.name}</option>)}
            </optgroup>
            <optgroup label="Dark">
              {dark.map((theme) => <option key={theme.id} value={theme.id} style={nativeOptionStyle}>{theme.name}</option>)}
            </optgroup>
          </select>
        </NativeSetting>
        <NativeSetting label={card("language").label} description={card("language").description} scope="Cody only">
          <select
            style={nativeSelectStyle}
            value={locale}
            aria-label="Language"
            onChange={(event) => saved(() => setLocale(event.target.value as Locale))}
          >
            {LOCALES.map((item) => (
              <option key={item.value} value={item.value} style={nativeOptionStyle}>{item.label}</option>
            ))}
          </select>
        </NativeSetting>
      </div>
      <div style={grid}>
        <NativeSetting label={card("tool-calls").label} description={card("tool-calls").description} scope="Cody only">
          <ToggleSwitch checked={prefs.toolCallsDefaultCollapsed} onChange={(next) => saved(() => prefs.setToolCallsDefaultCollapsed(next))} />
        </NativeSetting>
        <NativeSetting label={card("thinking").label} description={card("thinking").description} scope="Cody only">
          <ToggleSwitch checked={prefs.thinkingDefaultExpanded} onChange={(next) => saved(() => prefs.setThinkingDefaultExpanded(next))} />
        </NativeSetting>
        <NativeSetting label={card("sound").label} description={card("sound").description} scope="Cody only">
          <ToggleSwitch
            checked={soundEnabled}
            onChange={(next) => {
              setSoundEnabled(next);
              saved(() => {
                try { localStorage.setItem(STORAGE_KEYS.soundEnabled, String(next)); } catch { /* storage fallback */ }
                window.dispatchEvent(new CustomEvent(STORAGE_EVENTS.soundPrefChange, { detail: next }));
              });
            }}
          />
        </NativeSetting>
        {/* Steering and the follow-up queue are rpc-dialect commands. On an
            engine without chatExtras nothing can be submitted mid-turn at
            all, so this choice governs nothing and is hidden rather than
            left as a setting that does nothing. */}
        {capabilities.chatExtras && (
          <NativeSetting label={card("submit").label} description={card("submit").description} scope="Cody only">
            <select
              style={nativeSelectStyle}
              value={submitBehavior}
              aria-label="Message during active run"
              onChange={(event) => {
                const next = event.target.value as SubmitDuringRunBehavior;
                setSubmitBehavior(next);
                saved(() => setSubmitDuringRunBehavior(next));
              }}
            >
              <option value="steer" style={nativeOptionStyle}>Steer current run</option>
              <option value="queue" style={nativeOptionStyle}>Queue follow-up</option>
            </select>
          </NativeSetting>
        )}
      </div>
      <NativeSetting
        label={card("soft-keys").label}
        description={card("soft-keys").description}
        scope="Cody only"
        control={(
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(74px, 1fr))", gap: 6 }}>
            {TERMINAL_SOFT_KEYS.map((key) => {
              const selected = terminalSoftKeyIds.includes(key.id);
              return (
                <button
                  key={key.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleTerminalSoftKey(key.id)}
                  style={{
                    minHeight: 28,
                    padding: "3px 7px",
                    border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                    borderRadius: "var(--radius-control)",
                    background: selected ? "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))" : "var(--bg)",
                    color: selected ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                  }}
                >
                  {key.label}
                </button>
              );
            })}
          </div>
        )}
      />
    </div>
  );
}
