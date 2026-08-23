"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, RefreshCw, RotateCcw } from "lucide-react";
import { HOST_CONDITIONS, SETTING_CONDITIONS, isConditionSatisfied, type HostFacts } from "@/lib/omp/settings-conditions";
import type { OmpSetting, OmpSettingOption, OmpSettingsSchema } from "@/lib/omp/settings-schema";
import { NativeSetting, READ_ONLY_BADGE, SettingsHighlightContext, TERMINAL_ONLY_BADGE, ToggleSwitch, nativeInputStyle, nativeOptionStyle, nativeSelectStyle } from "./primitives";

/**
 * Renders OMP's settings from OMP's own schema: its tabs, its section order,
 * its labels and descriptions. Nothing here enumerates setting names, so a
 * setting added upstream appears the moment the installed OMP ships it.
 *
 * Cody's curated panels still own the settings that deserve a bespoke control
 * (model registry, approval matrix, provider keys). Those keys also appear
 * here, because this panel is the complete view; both write the same file, and
 * the dialog re-reads after each save so the two stay in step.
 */

export type OmpSettingValue = boolean | number | string | string[];

interface SchemaResponse {
  path?: string;
  harness?: { id?: string; shortName?: string };
  host?: { platform?: string };
  schema?: OmpSettingsSchema | null;
  values?: Record<string, OmpSettingValue>;
  reason?: string;
  error?: string;
}

const SAVE_DEBOUNCE_MS = 350;

/** Beyond this, an option label will not fit a select sitting beside the
 * setting's name, so the control moves to its own full-width row. */
const INLINE_OPTION_LABEL_LIMIT = 18;

/** Toggles and short selects read best beside the label. Free text, list
 * editors and long choice lists need the card's full width. */
function isInlineControl(setting: OmpSetting): boolean {
  if (setting.type === "boolean") return true;
  if (setting.type === "string" || setting.type === "array") return false;
  const labels = setting.options?.map((option) => option.label) ?? setting.values ?? [];
  if (labels.length === 0) return true; // A bare number input is compact.
  return labels.every((label) => label.length <= INLINE_OPTION_LABEL_LIMIT);
}

/** A condition Cody can evaluate is honoured by hiding the row, so saying so
 * again would be noise. One it cannot evaluate is worth naming, because the
 * row is shown unconditionally and may have no effect. Camel-case splits at
 * lowercase→uppercase boundaries only, so an acronym run ("macOS",
 * "hasSIXELSupport") survives instead of shattering into letters. */
function describeCondition(condition: string): string | null {
  if (SETTING_CONDITIONS[condition] || HOST_CONDITIONS[condition]) return null;
  const words = condition
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .map((word) => (word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase()))
    .join(" ");
  return `Only takes effect when OMP reports ${words}.`;
}

/** A setting's current value, falling back to the schema default so a control
 * shows what OMP would actually use rather than an empty box. */
function effectiveValue(setting: OmpSetting, values: Record<string, OmpSettingValue>): OmpSettingValue | undefined {
  const stored = values[setting.key];
  if (stored !== undefined) return stored;
  if (setting.default !== undefined) return setting.default;
  if (setting.type === "array") return [];
  if (setting.type === "enum") return setting.options?.[0]?.value ?? setting.values?.[0];
  return undefined;
}

export function OmpSchemaSettings({ isMobile, harnessLabel = "OMP", onSaved, reloadToken }: {
  isMobile: boolean;
  /** Brand of the active harness, used in this panel's own copy. */
  harnessLabel?: string;
  /** Fires after a successful save so the curated panels can re-read the file. */
  onSaved?: () => void;
  /** Bumped by the dialog when another panel writes the settings file. */
  reloadToken?: number;
}) {
  const [schema, setSchema] = useState<OmpSettingsSchema | null>(null);
  const [host, setHost] = useState<HostFacts | undefined>(undefined);
  const [values, setValues] = useState<Record<string, OmpSettingValue>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/omp-settings/schema", { signal });
      const data = (await response.json()) as SchemaResponse;
      if (signal?.aborted) return;
      if (data.error) throw new Error(data.error);
      if (!data.schema) {
        setStatus("unavailable");
        setReason(data.reason ?? "OMP's settings schema is unavailable");
        return;
      }
      setSchema(data.schema);
      setHost(typeof data.host?.platform === "string" ? { platform: data.host.platform } : undefined);
      setValues(data.values ?? {});
      setStatus("ready");
    } catch (cause) {
      if (signal?.aborted) return;
      setStatus("unavailable");
      setReason(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadToken]);

  // Pending edits coalesce into one request: a slider or a run of toggles must
  // not queue a write per keystroke against a single YAML file.
  const pendingRef = useRef<Record<string, OmpSettingValue | null>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);

  const flush = useCallback(async () => {
    if (inFlightRef.current) return;
    const patch = pendingRef.current;
    pendingRef.current = {};
    if (Object.keys(patch).length === 0) return;
    inFlightRef.current = true;
    setSaving(true);
    try {
      const response = await fetch("/api/omp-settings/schema", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      });
      const data = (await response.json()) as SchemaResponse;
      if (data.error) throw new Error(data.error);
      // Only adopt the server's view once nothing newer is queued, so the
      // control the user is still touching does not snap backwards.
      if (Object.keys(pendingRef.current).length === 0 && data.values) setValues(data.values);
      setError(null);
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlightRef.current = false;
      setSaving(false);
      if (Object.keys(pendingRef.current).length > 0) void flush();
    }
  }, [onSaved]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const update = useCallback((key: string, value: OmpSettingValue | null) => {
    setValues((current) => {
      const next = { ...current };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
    pendingRef.current[key] = value;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void flush(); }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  // Arriving from the dialog-wide search: jump to the tab that owns the match
  // so NativeSetting has something to scroll to.
  const highlightId = useContext(SettingsHighlightContext);
  useEffect(() => {
    if (!schema || !highlightId?.startsWith("omp-")) return;
    const key = highlightId.slice("omp-".length);
    const match = schema.settings.find((setting) => setting.key === key);
    if (!match) return;
    setActiveTab(match.tab);
    setFilter("");
  }, [schema, highlightId]);

  const tabs = schema?.tabs ?? [];
  const currentTab = activeTab && tabs.some((tab) => tab.id === activeTab) ? activeTab : tabs[0]?.id ?? null;

  const query = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!schema) return [];
    const resolve = (key: string) => {
      const setting = schema.settings.find((candidate) => candidate.key === key);
      return setting ? effectiveValue(setting, values) : undefined;
    };
    return schema.settings.filter((setting) => {
      if (!isConditionSatisfied(setting.condition, resolve, host)) return false;
      if (!query) return setting.tab === currentTab;
      // A search spans every tab; the tab strip stops applying while it runs.
      return `${setting.label} ${setting.description ?? ""} ${setting.key} ${setting.group ?? ""}`.toLowerCase().includes(query);
    });
  }, [schema, values, currentTab, query, host]);

  const sections = useMemo(() => {
    if (!schema) return [];
    const order = query ? [...new Set(visible.map((setting) => setting.group ?? ""))] : ["", ...(schema.groups[currentTab ?? ""] ?? [])];
    return order
      .map((group) => ({ group, settings: visible.filter((setting) => (setting.group ?? "") === group) }))
      .filter((section) => section.settings.length > 0);
  }, [schema, visible, currentTab, query]);

  if (status === "loading") {
    return <div role="status" style={{ padding: 20, fontSize: 12, color: "var(--text-muted)" }}>Reading OMP&apos;s settings schema…</div>;
  }

  if (status === "unavailable") {
    return (
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>All {harnessLabel} Settings</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
            This panel mirrors {harnessLabel}&apos;s own settings schema, so it lists every setting the installed {harnessLabel} declares.
          </p>
        </div>
        <div role="alert" style={{ padding: "10px 14px", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 12, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <AlertCircle size={14} aria-hidden="true" style={{ marginTop: 1, flexShrink: 0 }} />
          <span>{harnessLabel}&apos;s schema could not be read, so only Cody&apos;s curated settings are available. {reason}</span>
        </div>
      </div>
    );
  }

  return (
    <div role="tabpanel" id="settings-panel-omp" aria-labelledby="settings-tab-omp" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>All {harnessLabel} Settings</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
            Read from {harnessLabel}{schema?.source.version ? ` ${schema.source.version}` : ""}&apos;s own schema — every setting it declares, in its tabs and sections.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {saving && (
            <span style={{ fontSize: 11, color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <RefreshCw size={11} className="spin" aria-hidden="true" /> Saving…
            </span>
          )}
          <input
            type="text"
            aria-label={`Filter ${harnessLabel} settings`}
            placeholder="Filter…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            style={{ ...nativeInputStyle, width: isMobile ? "100%" : 180 }}
          />
        </div>
      </div>

      {error && (
        <div role="alert" style={{ padding: "10px 14px", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", border: "1px solid var(--status-error)", color: "var(--status-error)", fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle size={14} aria-hidden="true" /> {error}
        </div>
      )}

      {!query && (
        <nav aria-label="OMP settings sections" role="tablist" style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {tabs.map((tab) => {
            const selected = tab.id === currentTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: "5px 10px",
                  border: "1px solid " + (selected ? "var(--accent)" : "var(--border)"),
                  borderRadius: "var(--radius-control)",
                  background: selected ? "var(--bg-selected)" : "transparent",
                  color: selected ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 12,
                  whiteSpace: "nowrap",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      )}

      {sections.length === 0 && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>No settings match this filter.</p>
      )}

      {sections.map(({ group, settings }) => (
        <section key={group || "__ungrouped"} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {group && <h4 style={{ fontSize: 12, fontWeight: 600, margin: 0, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{group}</h4>}
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
            {settings.map((setting) => (
              <SchemaSettingRow
                key={setting.key}
                setting={setting}
                value={effectiveValue(setting, values)}
                overridden={values[setting.key] !== undefined}
                onChange={(next) => update(setting.key, next)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SchemaSettingRow({ setting, value, overridden, onChange }: {
  setting: OmpSetting;
  value: OmpSettingValue | undefined;
  overridden: boolean;
  onChange: (value: OmpSettingValue | null) => void;
}) {
  const description = [
    setting.description,
    setting.condition ? describeCondition(setting.condition) : null,
    setting.readOnly ? setting.readOnlyReason : null,
  ]
    .filter(Boolean)
    .join(" ");
  const control = <SchemaControl setting={setting} value={value} onChange={onChange} />;
  const inline = isInlineControl(setting);

  return (
    <NativeSetting
      label={setting.label}
      // No fallback to the key: the row already prints it in mono below the
      // control, so falling back duplicates it. Harmless while every setting
      // carried a description (omp's do); Hermes declares none, which made it
      // every row.
      description={description || undefined}
      badge={setting.readOnly ? READ_ONLY_BADGE : (setting.terminalOnly ? TERMINAL_ONLY_BADGE : undefined)}
      searchId={`omp-${setting.key}`}
      control={
        <>
          {!inline && control}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <code style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono, monospace)", minWidth: 0, overflowWrap: "anywhere" }}>{setting.key}</code>
            {overridden && !setting.readOnly && (
              <button
                type="button"
                onClick={() => onChange(null)}
                title="Reset to the engine's default"
                style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 10, padding: 0, flexShrink: 0 }}
              >
                <RotateCcw size={11} aria-hidden="true" /> Reset
              </button>
            )}
          </div>
        </>
      }
    >
      {inline ? control : undefined}
    </NativeSetting>
  );
}

function SchemaControl({ setting, value, onChange }: {
  setting: OmpSetting;
  value: OmpSettingValue | undefined;
  onChange: (value: OmpSettingValue) => void;
}) {
  if (setting.readOnly) return <ReadOnlyValue setting={setting} value={value} />;

  if (setting.type === "boolean") {
    return <ToggleSwitch checked={value === true} onChange={onChange} />;
  }

  if (setting.type === "enum" || (setting.type === "number" && setting.options)) {
    const choices: OmpSettingOption[] = setting.options ?? (setting.values ?? []).map((entry) => ({ value: entry, label: entry }));
    const current = value === undefined ? "" : String(value);
    // A hand-edited file can hold a value OMP no longer offers; keep it listed
    // rather than silently showing a different setting than what is in effect.
    const options = choices.some((choice) => choice.value === current) || current === ""
      ? choices
      : [...choices, { value: current, label: `${current} (not in schema)` }];
    const inline = isInlineControl(setting);
    const selected = options.find((choice) => choice.value === current);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0, width: inline ? undefined : "100%" }}>
        <select
          aria-label={setting.label}
          value={current}
          onChange={(event) => onChange(setting.type === "number" ? Number(event.target.value) : event.target.value)}
          // A select never grows past its card: long option labels ellipsize in
          // the closed state instead of pushing the layout open.
          style={{ ...nativeSelectStyle, width: inline ? undefined : "100%", maxWidth: "100%", minWidth: 0, textOverflow: "ellipsis" }}
        >
          {options.map((choice) => (
            <option key={choice.value} value={choice.value} style={nativeOptionStyle}>{choice.label}</option>
          ))}
        </select>
        {!inline && selected?.description && (
          // The closed select can only show so much of a long label; the
          // schema's own note for the chosen value says what it actually does.
          <span style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.4 }}>{selected.description}</span>
        )}
      </div>
    );
  }

  if (setting.type === "number") {
    return (
      <input
        type="number"
        aria-label={setting.label}
        value={typeof value === "number" ? value : ""}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (event.target.value !== "" && Number.isFinite(parsed)) onChange(parsed);
        }}
        style={{ ...nativeInputStyle, width: 110, textAlign: "right" }}
      />
    );
  }

  if (setting.type === "array") {
    return <ArrayControl setting={setting} value={Array.isArray(value) ? value : []} onChange={onChange} />;
  }

  return (
    <input
      type="text"
      aria-label={setting.label}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
      style={{ ...nativeInputStyle, width: "100%" }}
    />
  );
}

/** A setting the engine will not let Cody write. The value is still worth
 * showing — the user needs to know what the engine is actually configured
 * with — but the control is static, since a save that always fails is a
 * worse answer than an honest read-only row. */
function ReadOnlyValue({ setting, value }: { setting: OmpSetting; value: OmpSettingValue | undefined }) {
  const text = Array.isArray(value)
    ? (value.length > 0 ? value.join("\n") : "(empty)")
    : (value === undefined || value === "" ? "(unset)" : String(value));
  return (
    <pre
      aria-label={setting.label}
      aria-readonly="true"
      style={{ ...nativeInputStyle, width: "100%", margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono, monospace)", color: "var(--text-muted)", background: "var(--bg-subtle, transparent)" }}
    >
      {text}
    </pre>
  );
}

/** Arrays are free-form string lists upstream (no membership choices), so they
 * edit as one entry per line and commit on blur rather than per keystroke. */
function ArrayControl({ setting, value, onChange }: {
  setting: OmpSetting;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [draft, setDraft] = useState(value.join("\n"));
  const committed = useRef(value.join("\n"));

  useEffect(() => {
    const joined = value.join("\n");
    if (joined !== committed.current) {
      committed.current = joined;
      setDraft(joined);
    }
  }, [value]);

  const commit = () => {
    const entries = draft.split("\n").map((entry) => entry.trim()).filter(Boolean);
    committed.current = entries.join("\n");
    onChange(entries);
  };

  return (
    <textarea
      aria-label={`${setting.label} (one per line)`}
      value={draft}
      rows={Math.min(6, Math.max(2, draft.split("\n").length))}
      placeholder="One entry per line"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      style={{ ...nativeInputStyle, width: "100%", fontFamily: "var(--font-mono, monospace)", resize: "vertical" }}
    />
  );
}
