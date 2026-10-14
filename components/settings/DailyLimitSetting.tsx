"use client";

/**
 * Settings › Preferences › Daily time limit: a personal cap on ACTIVE time in
 * Cody, shared across the account's devices. The server owns the value and the
 * counting (hooks/useDailyLimit.ts); this card only switches it on or off and
 * picks the length. Off by default.
 */
import { useState } from "react";
import {
  setDailyLimitEnabled,
  setDailyLimitMinutes,
  useDailyLimit,
} from "@/hooks/useDailyLimit";
import { useI18n } from "@/lib/i18n";
import {
  LIMIT_PRESET_MINUTES,
  MAX_LIMIT_MINUTES,
  MIN_LIMIT_MINUTES,
  parseLimitMinutes,
  type DailyLimitState,
} from "@/lib/daily-limit/state";
import { formatDuration } from "@/lib/daily-limit/view";
import { NativeSetting, ToggleSwitch } from "./primitives";
import { useSaveStatus } from "./SaveStatus";
import { useSettingsShell } from "./shell-context";

const noteStyle = { fontSize: 11, lineHeight: 1.45 } as const;

export function DailyLimitSetting({ panelId, label, description, searchId, initial }: {
  /** The panel whose Saving… / Saved / Could not save corner reports these writes. */
  panelId: string;
  label: string;
  description: string;
  searchId: string;
  /** Painted until the shared store answers (the static-render seam). */
  initial?: DailyLimitState | null;
}) {
  const { t } = useI18n();
  const { isMobile } = useSettingsShell();
  const { track } = useSaveStatus(panelId);
  const live = useDailyLimit();
  const state = live.state ?? initial ?? null;
  const loaded = state !== null;
  const enabled = state?.enabled === true;
  const limitMinutes = state?.limitMinutes ?? null;
  const isPreset = limitMinutes !== null && LIMIT_PRESET_MINUTES.includes(limitMinutes);
  const lengthDisabled = !loaded || !enabled;

  // null = show the saved value; a string = the person is typing.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const shown = draft ?? (limitMinutes !== null && !isPreset ? String(limitMinutes) : "");

  const revert = () => { setDraft(null); setInvalid(false); };

  const choosePreset = (minutes: number) => {
    revert();
    void track(async () => { await setDailyLimitMinutes(minutes); });
  };

  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    if (text === "") { revert(); return; }
    const minutes = parseLimitMinutes(/^\d+$/.test(text) ? Number(text) : NaN);
    if (minutes === null) { setInvalid(true); return; }
    setInvalid(false);
    setDraft(null);
    if (minutes === limitMinutes) return;
    void track(async () => { await setDailyLimitMinutes(minutes); });
  };

  const tall = isMobile ? 44 : 28;
  const unit = (seconds: number) => formatDuration(seconds, "floor", t);

  let status: string;
  if (!loaded) status = "";
  else if (!enabled) status = t("dailyLimit.settingsOff");
  else if (state.remainingSeconds < 0) {
    status = t("dailyLimit.usedSummaryOver", {
      used: unit(state.usedSeconds),
      limit: unit(state.limitSeconds),
      over: unit(-state.remainingSeconds),
    });
  } else {
    status = t("dailyLimit.usedSummary", { used: unit(state.usedSeconds), limit: unit(state.limitSeconds) });
  }

  return (
    <NativeSetting
      label={label}
      description={description}
      scope="Cody only"
      searchId={searchId}
      switchControl={false}
      control={(
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div
            role="radiogroup"
            aria-label={t("dailyLimit.settingsLength")}
            style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", opacity: lengthDisabled ? 0.5 : 1 }}
          >
            {LIMIT_PRESET_MINUTES.map((minutes) => {
              const selected = limitMinutes === minutes;
              return (
                <button
                  key={minutes}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={lengthDisabled}
                  onClick={() => choosePreset(minutes)}
                  style={{
                    minHeight: tall,
                    padding: "3px 11px",
                    border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                    borderRadius: "var(--radius-control)",
                    background: selected ? "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))" : "var(--bg)",
                    color: selected ? "var(--text)" : "var(--text-muted)",
                    cursor: lengthDisabled ? "not-allowed" : "pointer",
                    fontSize: 11.5,
                  }}
                >
                  {t("dailyLimit.presetHours", { hours: minutes / 60 })}
                </button>
              );
            })}
            {/* The box and its unit wrap as one piece, never leaving "minutes" alone on a line. */}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
              <input
                type="number"
                inputMode="numeric"
                min={MIN_LIMIT_MINUTES}
                max={MAX_LIMIT_MINUTES}
                aria-label={t("dailyLimit.customAria")}
                placeholder={t("dailyLimit.customLabel")}
                value={shown}
                disabled={lengthDisabled}
                aria-invalid={invalid || undefined}
                onChange={(event) => { setDraft(event.target.value); setInvalid(false); }}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); commit(); }
                  else if (event.key === "Escape") { event.preventDefault(); revert(); }
                }}
                style={{
                  width: 84,
                  minHeight: tall,
                  padding: "3px 8px",
                  border: `1px solid ${invalid ? "var(--status-error)" : "var(--border)"}`,
                  borderRadius: "var(--radius-control)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontSize: isMobile ? 16 : 11.5,
                  cursor: lengthDisabled ? "not-allowed" : undefined,
                }}
              />
              <span style={{ fontSize: 11.5, color: "var(--text-muted)", opacity: lengthDisabled ? 0.5 : 1 }}>{t("dailyLimit.customMinutes")}</span>
            </span>
          </div>
          {invalid && (
            <span role="alert" style={{ ...noteStyle, color: "var(--status-error)" }}>
              {t("dailyLimit.customInvalid", { min: MIN_LIMIT_MINUTES, max: MAX_LIMIT_MINUTES })}
            </span>
          )}
          {loaded && <span style={{ ...noteStyle, color: "var(--text-muted)" }}>{status}</span>}
          {!loaded && live.error && (
            <span role="alert" style={{ ...noteStyle, color: "var(--status-error)" }}>
              {t("preferences.timeZoneLoadFailed", { message: live.error })}
            </span>
          )}
        </div>
      )}
    >
      <ToggleSwitch
        checked={enabled}
        label={label}
        disabled={!loaded}
        onChange={(next) => { void track(async () => { await setDailyLimitEnabled(next); }); }}
      />
    </NativeSetting>
  );
}
