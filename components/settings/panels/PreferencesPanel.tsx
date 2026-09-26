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
import { DISTILL_REPLY_MODES, saveDistillPreferences, type DistillReplyMode } from "@/lib/distill-preferences";
import { DISTILL_CONFIG_ROUTE, useDistillPreferences, type DistillConfigPayload } from "@/hooks/useDistill";
import { invalidateSettingsRoutes, setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { getSubmitDuringRunBehavior, setSubmitDuringRunBehavior, type SubmitDuringRunBehavior } from "@/lib/composer-prefs";
import { LOCALES, useI18n, type Locale } from "@/lib/i18n";
import { STORAGE_EVENTS, STORAGE_KEYS } from "@/lib/storage-keys";
import { readTerminalSoftKeyIds, TERMINAL_SOFT_KEYS, writeTerminalSoftKeyIds, type TerminalSoftKeyId } from "@/lib/terminal-preferences";
import { getPreferredToolPreset, setPreferredToolPreset } from "@/lib/tool-preset-preference";
import type { ToolPreset } from "@/lib/tool-presets";
import { THEMES, type ThemeId } from "@/lib/theme-catalog";
import { readChatFontSize, writeChatFontSize, type FontSize } from "@/lib/chat-font-size";
import { useTheme } from "@/hooks/useTheme";
import { Select, type SelectGroup, type SelectOption } from "@/components/ui/Select";
import type { EngineCapabilities } from "../../SettingsTabs";
import type { ActivityDisplayMode } from "@/lib/types";
import { NativeSetting, ToggleSwitch, slugify } from "../primitives";
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
  { id: "chat-font-size", label: "Chat text size", description: "Font size for transcript text, thinking blocks, and tool results. Applies only to chat content, not the interface.", scope: "Cody only", keywords: ["font", "size", "text", "zoom", "readable"] },
  { id: "activity", label: "Tool and background activity", description: "Choose whether tool calls, results and structured background work stay compact, open in full, or disappear from the transcript. User and assistant conversation and thinking are unchanged.", scope: "Cody only", keywords: ["tools", "results", "async", "background", "transcript", "compact", "full", "hidden"] },
  { id: "thinking", label: "Expand thinking blocks", description: "Show the model's reasoning open by default instead of behind a collapsed header.", scope: "Cody only" },
  { id: "sound", label: "Completion sound", description: "Play a tone when the agent completes a run.", scope: "Cody only", keywords: ["notification", "chime"] },
  { id: "submit", label: "Message during active run", description: "What composer does on submit while agent runs. Steer interrupts; Queue follow-up delivers after finish.", scope: "Cody only", needsCapability: "chatExtras", keywords: ["steer", "queue"] },
  { id: "agent-tools", label: "Agent tools", description: "Choose the built-in tools given to new sessions. Core keeps read, bash, edit and write; No tools starts with none. Changes affect new sessions only.", scope: "Cody only", needsCapability: "chatExtras", keywords: ["tools", "core", "subagents", "tasks", "github", "web search", "new sessions"] },
  { id: "soft-keys", label: "Terminal soft keys", description: "Choose the buttons shown below the terminal on touch devices. Shift Tab moves backward through terminal UI modes.", scope: "Cody only", keywords: ["touch", "keyboard"] },
  { id: "distill", label: "Distill", description: "Shorten finished assistant replies, and summarize the model's thinking while its box is collapsed. The full text is always one click away.", scope: "Cody only", keywords: ["summary", "summarize", "shorten", "condense", "verbosity", "thinking", "reply", "plain language", "jargon", "non-technical"] },
  { id: "plan-keeper", label: "Live plan keeper", description: "A small background model watches this session and checks off finished tasks and subtasks automatically, so the plan stays current without the agent pausing to update it.", scope: "Cody only", keywords: ["auto", "automatic", "subtasks", "todo", "keeper"] },
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

/** The stored mode is the wire dialect; these are the words for it. The
 *  card's own label and description are translated too — only the search
 *  table above stays English, because the index is built once at module
 *  load and its ids must not move with the locale. */
const REPLY_MODE_LABEL_KEYS: Record<DistillReplyMode, string> = {
  off: "preferences.distillOff",
  low: "preferences.distillLow",
  medium: "preferences.distillMedium",
  high: "preferences.distillHigh",
};

function card(id: string): PreferenceCard {
  const found = PREFERENCE_CARDS.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown preference card: ${id}`);
  return found;
}

function agentToolsDescription(hasSubagents: boolean): string {
  return hasSubagents
    ? "Core disables subagents, task lists, GitHub and web search; No tools starts with none. Changes affect new sessions only."
    : "Core disables task lists, GitHub and web search and keeps only read, bash, edit and write. No tools starts with none. Changes affect new sessions only.";
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

const PLAN_KEEPER_CONFIG_ROUTE = "/api/plan-keeper/config";

/** `cody-plan-keeper.json`, GET/PUT `/api/plan-keeper/config` (lib/plan-keeper/config.ts,
 * server-owned). Same shape family as DistillConfigPayload: hidden entirely
 * when unsupported, read-only for a non-admin on a shared instance. */
interface PlanKeeperConfigPayload {
  supported: boolean;
  enabled: boolean;
  canManage: boolean;
}

export function PreferencesPanel() {
  const { capabilities, isMobile, prefs } = useSettingsShell();
  const { t, locale, setLocale } = useI18n();
  const distillPrefs = useDistillPreferences();
  // The card hides outright where the active engine cannot distill (every
  // ACP engine answers `unsupported`): a verbosity picker that changes
  // nothing is worse than no picker at all.
  const distillConfig = useSettingsRoute<DistillConfigPayload>(DISTILL_CONFIG_ROUTE);
  const distillAvailable = distillConfig.data?.supported === true;
  // Same pattern as Distill above: a route-backed toggle Cody owns (not the
  // engine), hidden entirely when unsupported (an ACP engine, or security
  // disabled) and read-only for a non-admin on a shared instance.
  const planKeeperConfig = useSettingsRoute<PlanKeeperConfigPayload>(PLAN_KEEPER_CONFIG_ROUTE);
  const planKeeperSupported = planKeeperConfig.data?.supported === true;
  const planKeeperCanManage = planKeeperConfig.data?.canManage === true;
  const planKeeperEnabled = planKeeperConfig.data?.enabled === true;
  const [planKeeperSaving, setPlanKeeperSaving] = useState(false);
  const { themeId, setTheme } = useTheme();
  const [chatFontSize, setChatFontSize] = useState<FontSize>(() => readChatFontSize());
  const { track } = useSaveStatus(PREFERENCES_PANEL_ID);
  const [submitBehavior, setSubmitBehavior] = useState<SubmitDuringRunBehavior>(() => getSubmitDuringRunBehavior());
  const [toolPreset, setToolPreset] = useState<ToolPreset>(() => getPreferredToolPreset());
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

  const togglePlanKeeper = (next: boolean) => {
    setPlanKeeperSaving(true);
    void track(async () => {
      const response = await fetch(PLAN_KEEPER_CONFIG_ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) });
      const data = await response.json().catch(() => ({})) as Partial<PlanKeeperConfigPayload> & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setSettingsRouteData<PlanKeeperConfigPayload>(PLAN_KEEPER_CONFIG_ROUTE, {
        supported: data.supported !== false,
        enabled: data.enabled === true,
        canManage: data.canManage !== false,
      });
      invalidateSettingsRoutes("/api/plan-keeper");
    }).finally(() => setPlanKeeperSaving(false));
  };

  const light = THEMES.filter((theme) => theme.mode === "light");
  const dark = THEMES.filter((theme) => theme.mode === "dark");
  const themeOptions: SelectGroup<ThemeId>[] = [
    { label: "Light", options: light.map((theme) => ({ value: theme.id, label: theme.name })) },
    { label: "Dark", options: dark.map((theme) => ({ value: theme.id, label: theme.name })) },
  ];
  const localeOptions: SelectOption<Locale>[] = LOCALES.map((item) => ({ value: item.value, label: item.label }));
  const fontSizeOptions: SelectOption<FontSize>[] = [
    { value: "13", label: "Small (13px)" },
    { value: "14", label: "Default (14px)" },
    { value: "15", label: "Large (15px)" },
    { value: "16", label: "Extra large (16px)" },
  ];
  const activityOptions: SelectOption<ActivityDisplayMode>[] = [
    { value: "compact", label: "Compact" },
    { value: "full", label: "Full" },
    { value: "hidden", label: "Hidden" },
  ];
  const submitOptions: SelectOption<SubmitDuringRunBehavior>[] = [
    { value: "steer", label: "Steer current run" },
    { value: "queue", label: "Queue follow-up" },
  ];
  const toolPresetOptions: SelectOption<ToolPreset>[] = [
    { value: "full", label: "All built-in tools" },
    { value: "default", label: "Core" },
    { value: "none", label: "No tools" },
  ];
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
          <Select value={themeId} onChange={(next) => saved(() => setTheme(next))} options={themeOptions} aria-label="Theme" />
        </NativeSetting>
        <NativeSetting label={card("language").label} description={card("language").description} scope="Cody only">
          <Select value={locale} onChange={(next) => saved(() => setLocale(next))} options={localeOptions} aria-label="Language" />
        </NativeSetting>
        <NativeSetting label={card("chat-font-size").label} description={card("chat-font-size").description} scope="Cody only">
          <Select
            value={chatFontSize}
            onChange={(next) => {
              setChatFontSize(next);
              saved(() => writeChatFontSize(next));
            }}
            options={fontSizeOptions}
            aria-label="Chat text size"
          />
        </NativeSetting>
      </div>
      <div style={grid}>
        <NativeSetting label={card("activity").label} description={card("activity").description} scope="Cody only">
          <Select value={prefs.activityDisplayMode} onChange={(next) => saved(() => prefs.setActivityDisplayMode(next))} options={activityOptions} aria-label="Tool and background activity" />
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
            <Select
              value={submitBehavior}
              onChange={(next) => {
                setSubmitBehavior(next);
                saved(() => setSubmitDuringRunBehavior(next));
              }}
              options={submitOptions}
              aria-label="Message during active run"
            />
          </NativeSetting>
        )}
        {capabilities.chatExtras && (
          <NativeSetting label={card("agent-tools").label} description={agentToolsDescription(capabilities.subagents)} scope="Cody only">
            <Select
              value={toolPreset}
              onChange={(next) => {
                setToolPreset(next);
                saved(() => setPreferredToolPreset(next));
              }}
              options={toolPresetOptions}
              aria-label="Agent tools"
            />
          </NativeSetting>
        )}
      </div>
      {distillAvailable && (
        <NativeSetting
          label={t("preferences.distillLabel")}
          description={t("preferences.distillDescription")}
          scope="Cody only"
          searchId={slugify(card("distill").label)}
          control={(
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div role="radiogroup" aria-label={t("preferences.distillRepliesLabel")} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11.5, color: "var(--text-muted)", marginRight: 2 }}>{t("preferences.distillRepliesLabel")}</span>
                {DISTILL_REPLY_MODES.map((mode) => {
                  const selected = distillPrefs.replies === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => saved(() => saveDistillPreferences({ ...distillPrefs, replies: mode }))}
                      style={{
                        minHeight: 28,
                        padding: "3px 11px",
                        border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                        borderRadius: "var(--radius-control)",
                        background: selected ? "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))" : "var(--bg)",
                        color: selected ? "var(--text)" : "var(--text-muted)",
                        cursor: "pointer",
                        fontSize: 11.5,
                      }}
                    >
                      {t(REPLY_MODE_LABEL_KEYS[mode])}
                    </button>
                  );
                })}
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <ToggleSwitch checked={distillPrefs.thinking} onChange={(next) => saved(() => saveDistillPreferences({ ...distillPrefs, thinking: next }))} />
                <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{t("preferences.distillThinkingLabel")}</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <ToggleSwitch checked={distillPrefs.plainLanguage} onChange={(next) => saved(() => saveDistillPreferences({ ...distillPrefs, plainLanguage: next }))} />
                <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{t("preferences.distillPlainLanguageLabel")}</span>
              </label>
              <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{t("preferences.distillModelNote")}</span>
            </div>
          )}
        />
      )}
      {planKeeperSupported && (
        <NativeSetting
          label={t("preferences.planKeeperLabel")}
          description={t("preferences.planKeeperDescription")}
          scope="Cody only"
          searchId={slugify(card("plan-keeper").label)}
          unavailable={!planKeeperCanManage ? t("preferences.planKeeperAdminOnly") : undefined}
        >
          <ToggleSwitch checked={planKeeperEnabled} disabled={!planKeeperCanManage || planKeeperSaving} onChange={togglePlanKeeper} />
        </NativeSetting>
      )}
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
