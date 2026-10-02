"use client";

/**
 * Settings › Preferences › Time zone: which clock agents, terminals and logs
 * use for this account.
 *
 * "Automatic" (the first row, a real choice) follows the device: each message
 * carries the zone of the browser that sent it, so a tablet that crosses zones
 * keeps up by itself. Picking a zone pins it for every device on the account.
 * The server owns the value (GET/PUT `/api/time-zone`, lib/time-zone-prefs.ts);
 * this row reads and writes it through the settings route cache like every
 * other Cody-owned preference.
 */
import { useMemo } from "react";
import { Select } from "@/components/ui/Select";
import { invalidateSettingsRoutes, setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { useI18n } from "@/lib/i18n";
import { detectDeviceTimeZone, listTimeZones, type TimeZoneSource } from "@/lib/time-zone";
import { AUTOMATIC_TIME_ZONE, timeZoneOptions } from "@/lib/time-zone-options";
import { NativeSetting } from "./primitives";
import { useSaveStatus } from "./SaveStatus";

export const TIME_ZONE_ROUTE = "/api/time-zone";

/** The body of GET and PUT `/api/time-zone`. */
export interface TimeZoneState {
  /** What a message with no device zone of its own would use right now. */
  zone: string;
  source: TimeZoneSource;
  /** The zone the person pinned, or null for Automatic. */
  explicit: string | null;
  /** The last device zone the account reported. */
  deviceZone: string | null;
  serverZone: string;
}

const noteStyle = { fontSize: 11, lineHeight: 1.45 } as const;

export function TimeZoneSetting({ panelId, label, description, searchId, initial }: {
  /** The panel whose Saving… / Saved / Could not save corner reports this write. */
  panelId: string;
  label: string;
  description: string;
  searchId: string;
  /** Painted until the shared cache answers — the seam `ModelPresets` uses,
   *  since a static-markup render always sees the cache's empty server snapshot. */
  initial?: TimeZoneState | null;
}) {
  const { t } = useI18n();
  const { track } = useSaveStatus(panelId);
  const route = useSettingsRoute<TimeZoneState>(TIME_ZONE_ROUTE);
  const state = route.data ?? initial ?? null;
  const explicit = state?.explicit ?? null;
  const zones = useMemo(() => listTimeZones(), []);
  const deviceZone = detectDeviceTimeZone();
  const { options, value } = useMemo(() => timeZoneOptions({
    zones,
    explicit,
    automaticLabel: deviceZone ? t("preferences.timeZoneAutomatic", { zone: deviceZone }) : t("preferences.timeZoneAutomaticUnknown"),
  }), [zones, explicit, deviceZone, t]);

  // A failed write leaves the cache alone, so the picker keeps showing what
  // is actually saved; the panel's corner reports the failure with a Retry.
  const save = (next: string) => {
    void track(async () => {
      const response = await fetch(TIME_ZONE_ROUTE, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeZone: next === AUTOMATIC_TIME_ZONE ? null : next }),
      });
      const body = await response.json().catch(() => ({})) as Partial<TimeZoneState> & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error || `HTTP ${response.status}`);
      setSettingsRouteData<TimeZoneState>(TIME_ZONE_ROUTE, body as TimeZoneState);
      invalidateSettingsRoutes(TIME_ZONE_ROUTE, { exact: true });
    });
  };

  return (
    <NativeSetting
      label={label}
      description={description}
      scope="Cody only"
      searchId={searchId}
      control={(
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Select
            value={state === null ? null : value}
            onChange={save}
            options={options}
            disabled={state === null}
            aria-label={label}
            search={{ placeholder: t("preferences.timeZoneSearch"), empty: t("preferences.timeZoneNoMatch") }}
          />
          {state !== null && (
            <span style={{ ...noteStyle, color: "var(--text-muted)" }}>
              {explicit !== null
                ? t("preferences.timeZoneChosen", { zone: value })
                : t("preferences.timeZoneFollowing", { zone: deviceZone ?? state.zone })}
            </span>
          )}
          {state === null && route.error && (
            <span role="alert" style={{ ...noteStyle, color: "var(--status-error)" }}>{t("preferences.timeZoneLoadFailed", { message: route.error })}</span>
          )}
        </div>
      )}
    />
  );
}
