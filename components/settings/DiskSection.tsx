"use client";

/**
 * Settings › System › Disk: how full the temp and data disks are, which chats
 * hold the biggest scratch folders, how much the undo snapshots take, and the
 * janitor's last pass, with a button to run it now and the few numbers that
 * decide what it deletes.
 *
 * Builds against `GET/POST/PUT /api/disk`. The server answers "may this person
 * change things" in `canEdit`, so a member sees the numbers but no controls.
 * Browser-safe shapes come from lib/disk/types.ts (types only): the disk
 * modules themselves read the file system and must stay out of the bundle.
 * English-only, like the rest of the settings dialog.
 */
import { Check, HardDrive, Loader2, Trash2 } from "lucide-react";
import { useContext, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { toast } from "@/components/ui/toast";
import { setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { formatRelativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/format-bytes";
import type { DiskArea, DiskPayload, DiskSettings } from "@/lib/disk/types";
import { ApiError, ErrorNote, primaryButtonStyle, requestJson, smallButtonStyle } from "./account-controls";
import { cardStyle, cardTitleStyle, dimLineStyle, LoadingLine, mutedLineStyle } from "./EngineRoster";
import { nativeInputStyle, SettingsHighlightContext } from "./primitives";

export const DISK_ROUTE = "/api/disk";

const RING_STYLE = { boxShadow: "0 0 0 2px var(--accent)", borderColor: "var(--accent)" } as const;

const AREA_LABELS: Record<DiskArea["id"], string> = { tmp: "Temp space", data: "Data" };

const LEVEL_COLORS: Record<DiskArea["level"], string> = {
  ok: "var(--accent)",
  low: "var(--status-warning)",
  critical: "var(--status-error)",
};

const LEVEL_NOTES: Record<DiskArea["level"], string | null> = {
  ok: null,
  low: "Getting full. Cody will ask agents to clean up.",
  critical: "Almost full. New chat turns are refused until space is freed.",
};

interface SettingField {
  key: keyof DiskSettings;
  label: string;
  unit: string;
  hint: string;
}

/** The one setting most people care about, always shown. */
const MAIN_FIELD: SettingField = {
  key: "scratchIdleDays",
  label: "Delete a chat's scratch folder after it has been idle for",
  unit: "days",
  hint: "A chat that is open and running is never touched.",
};

const ADVANCED_FIELDS: readonly SettingField[] = [
  { key: "tmpIdleHours", label: "Clear other leftovers in the temp folder after", unit: "hours", hint: "Only things nothing is using and no recent chat mentions." },
  { key: "homeTmpIdleHours", label: "Clear leftover folders in the home temp folder after", unit: "hours", hint: "Loose files there are always kept." },
  { key: "budgetPercent", label: "Start clearing the oldest scratch folders when a disk is", unit: "% full", hint: "Applies to the temp disk and the data disk." },
  { key: "checkpointMaxGb", label: "Keep undo snapshots under", unit: "GB", hint: "The oldest snapshots go first; live chats keep their newest." },
  { key: "checkpointMaxAgeDays", label: "Delete undo snapshots nobody has used for", unit: "days", hint: "" },
];

const ALL_FIELDS: readonly SettingField[] = [MAIN_FIELD, ...ADVANCED_FIELDS];

function draftOf(settings: DiskSettings): Record<keyof DiskSettings, string> {
  const draft = {} as Record<keyof DiskSettings, string>;
  for (const field of ALL_FIELDS) draft[field.key] = String(settings[field.key]);
  return draft;
}

function wholeNumber(text: string): number | null {
  return /^\d{1,5}$/.test(text.trim()) ? Number(text.trim()) : null;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** What a manual clean did, in plain words. */
function cleanSummary(payload: DiskPayload): string {
  const removed = payload.lastRun?.removedCount ?? 0;
  if (removed === 0) return "Nothing needed cleaning up.";
  return `Removed ${removed} ${plural(removed, "item", "items")} and freed ${formatBytes(payload.freedBytes ?? 0)}.`;
}

function Meter({ label, area }: { label: string; area: DiskArea }) {
  const percent = area.totalBytes > 0 ? Math.min(100, Math.round((area.usedBytes / area.totalBytes) * 100)) : 0;
  const color = LEVEL_COLORS[area.level];
  const note = LEVEL_NOTES[area.level];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ color: area.level === "ok" ? "var(--text-muted)" : color, fontWeight: area.level === "ok" ? 400 : 600 }}>
          {formatBytes(area.usedBytes)} used of {formatBytes(area.totalBytes)} · {percent}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% used, ${formatBytes(area.availableBytes)} free`}
        style={{ height: 8, borderRadius: 4, background: "var(--bg-hover)", overflow: "hidden" }}
      >
        <div style={{ width: `${percent}%`, height: "100%", background: color, transition: "width var(--dur-fast)" }} />
      </div>
      {note && <span style={{ fontSize: 11, color }}>{note}</span>}
    </div>
  );
}

const numberInputStyle: CSSProperties = { ...nativeInputStyle, width: 72, boxSizing: "border-box" };

/** `initial` paints an answer the caller already has (server render, tests) until the route's own data arrives. */
export function DiskSection({ initial }: { initial?: DiskPayload } = {}) {
  const uid = useId();
  const route = useSettingsRoute<DiskPayload>(DISK_ROUTE);
  const payload = route.data ?? initial ?? null;

  const highlightId = useContext(SettingsHighlightContext);
  const cardRef = useRef<HTMLElement | null>(null);
  const highlighted = highlightId === "disk";
  useEffect(() => {
    if (highlighted) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  // "3 hours ago" labels are judged against this clock, which ticks once a minute and when a new answer arrives.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [payload]);

  const [cleaning, setCleaning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<keyof DiskSettings, string> | null>(() => (payload ? draftOf(payload.settings) : null));

  // The typed values restart from the saved ones only when the saved numbers themselves change, not on every refresh.
  const savedSettings = payload?.settings ?? null;
  const savedKey = savedSettings ? JSON.stringify(savedSettings) : "";
  useEffect(() => {
    if (savedKey) setDraft(draftOf(JSON.parse(savedKey) as DiskSettings));
  }, [savedKey]);

  // Never show a card for an API this server does not have.
  if (route.unsupported) return null;

  const canEdit = payload?.canEdit === true;
  const busy = cleaning || payload?.running === true;
  const sharedDisk = payload?.areas.some((area) => area.sameFilesystemAs !== undefined) === true;
  const areas = (payload?.areas ?? []).filter((area) => area.sameFilesystemAs === undefined);

  const changes: Partial<DiskSettings> = {};
  let draftValid = true;
  if (savedSettings && draft) {
    for (const field of ALL_FIELDS) {
      const value = wholeNumber(draft[field.key]);
      if (value === null) draftValid = false;
      else if (value !== savedSettings[field.key]) changes[field.key] = value;
    }
  }
  const dirty = Object.keys(changes).length > 0;

  const cleanNow = () => {
    setCleaning(true);
    setError(null);
    void requestJson<DiskPayload>(DISK_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clean" }),
    })
      .then((next) => {
        setSettingsRouteData<DiskPayload>(DISK_ROUTE, { ...next, freedBytes: undefined });
        const failures = next.lastRun?.errorCount ?? 0;
        toast.success(
          cleanSummary(next),
          failures > 0 ? `${failures} ${plural(failures, "item", "items")} could not be removed.` : undefined,
        );
      })
      .catch((failure: unknown) => {
        const message = failure instanceof Error ? failure.message : String(failure);
        setError(message);
        toast.error("Cleaning did not finish", message);
      })
      .finally(() => setCleaning(false));
  };

  const save = () => {
    if (!dirty || !draftValid) return;
    setSaving(true);
    setError(null);
    void requestJson<DiskPayload>(DISK_ROUTE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    })
      .then((next) => {
        setSettingsRouteData<DiskPayload>(DISK_ROUTE, next);
        toast.success("Disk settings saved");
      })
      .catch((failure: unknown) => {
        const refused = failure instanceof ApiError && failure.code === "invalid_disk_settings"
          ? ALL_FIELDS.find((item) => failure.message.startsWith(item.key))
          : undefined;
        setError(refused ? `That number is not allowed for "${refused.label}".` : failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => setSaving(false));
  };

  const renderField = (field: SettingField) => (
    <div key={field.key} style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
        <label htmlFor={`${uid}-${field.key}`} style={{ flex: "1 1 220px", minWidth: 0 }}>{field.label}</label>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input
            id={`${uid}-${field.key}`}
            type="text"
            inputMode="numeric"
            value={draft?.[field.key] ?? ""}
            onChange={(event) => setDraft((current) => (current ? { ...current, [field.key]: event.target.value } : current))}
            onKeyDown={(event) => { if (event.key === "Enter") save(); }}
            disabled={!canEdit || saving || !draft}
            autoComplete="off"
            aria-invalid={draft !== null && wholeNumber(draft[field.key]) === null}
            style={numberInputStyle}
          />
          <span style={{ color: "var(--text-muted)" }}>{field.unit}</span>
        </span>
      </div>
      {field.hint && <span style={dimLineStyle}>{field.hint}</span>}
    </div>
  );

  const lastRun = payload?.lastRun ?? null;

  return (
    <section
      ref={cardRef}
      data-search-id="disk"
      aria-label="Disk space"
      style={{ ...cardStyle, minWidth: 0, transition: "box-shadow var(--dur-fast), border-color var(--dur-fast)", ...(highlighted ? RING_STYLE : {}) }}
    >
      <div style={cardTitleStyle}>
        <HardDrive size={13} aria-hidden="true" />
        Disk space
      </div>
      <div style={mutedLineStyle}>
        How full the server&apos;s disks are. Each chat works in its own scratch folder, and Cody clears the ones nobody has used for a while so the disk never fills up.
      </div>

      {route.loading && !payload && <LoadingLine label="Reading disk space…" />}
      {route.error && !payload && <ErrorNote message={route.error} />}

      {payload && (
        <>
          {areas.length === 0 && <div style={dimLineStyle}>This server did not report its disk space.</div>}
          {areas.map((area) => (
            <Meter key={area.id} label={sharedDisk && area.id === "tmp" ? "Temp space and data (one shared disk)" : AREA_LABELS[area.id]} area={area} />
          ))}

          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>Largest scratch folders</div>
            {payload.largestScratch.length === 0
              ? <div style={dimLineStyle}>None measured yet. Sizes appear after the next clean-up pass.</div>
              : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                  {payload.largestScratch.map((folder, index) => (
                    <li key={index} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, minWidth: 0 }}>
                      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{folder.title}</span>
                      <span style={{ flexShrink: 0, color: "var(--text-muted)", textAlign: "right" }}>
                        {formatBytes(folder.bytes)} · {folder.live ? "in use" : (formatRelativeTime(new Date(folder.lastUsedAt).toISOString(), "en", now) ?? "unknown")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600 }}>Undo snapshots</span>
            <span style={{ color: "var(--text-muted)" }}>{formatBytes(payload.checkpointBytes)}</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
            <div style={mutedLineStyle} role="status">
              {busy
                ? "Cleaning up now…"
                : lastRun
                  ? `Last clean ${formatRelativeTime(new Date(lastRun.finishedAt).toISOString(), "en", now) ?? "a while ago"}: ${lastRun.removedCount === 0 ? "nothing to remove" : `freed ${formatBytes(lastRun.freedBytes)}`}.`
                  : "Cody has not cleaned up since it started."}
            </div>
            {canEdit && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="ui-focus-ring"
                  onClick={cleanNow}
                  disabled={busy}
                  aria-busy={busy}
                  style={{ ...smallButtonStyle, opacity: busy ? 0.6 : 1 }}
                >
                  {busy ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
                  Clean idle scratch now
                </button>
              </div>
            )}
          </div>

          {draft && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
              {renderField(MAIN_FIELD)}
              <details>
                <summary style={{ fontSize: 12, cursor: "pointer", color: "var(--text-muted)" }}>Advanced</summary>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>
                  {ADVANCED_FIELDS.map(renderField)}
                </div>
              </details>
              {canEdit
                ? (
                  <div>
                    <button
                      type="button"
                      className="ui-focus-ring"
                      onClick={save}
                      disabled={saving || !dirty || !draftValid}
                      style={{ ...primaryButtonStyle, opacity: saving || !dirty || !draftValid ? 0.6 : 1 }}
                    >
                      {saving ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                      Save
                    </button>
                  </div>
                )
                : <span style={dimLineStyle}>Only an administrator can change these.</span>}
            </div>
          )}

          <ErrorNote message={error} />
        </>
      )}
    </section>
  );
}
