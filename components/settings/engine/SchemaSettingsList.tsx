"use client";

/**
 * "All <engine> settings": every setting the engine declares, from its own
 * schema, in its tabs and sections — the complete layer under the Behavior
 * hub's Recommended cards. Nothing here enumerates setting names, so a
 * setting added upstream appears the moment the installed engine ships it.
 *
 * Keys a Recommended (or Extensions › MCP, or retry) card owns are NOT
 * omitted: this list stays complete, and those rows wear an "Also under …"
 * chip that leads to the card. Both layers read one cached body and write
 * through one writer (`useSchemaIndex`), so they cannot disagree.
 *
 * Layout: a sticky table of contents (the engine's tabs; a single-tab engine
 * lists its groups in a jump menu), collapsible groups titled
 * `Group · N settings · M changed` (open on desktop unless the tab is very
 * long, closed on a phone), ungrouped rows after the groups under a
 * key-prefix heading. On a phone the contents are a Directory and each
 * tab (or group) is a pushed level. Secret leaves render write-only:
 * "Set" / "Not set" plus a masked input, never the value.
 */
import { AlertCircle, Check, ChevronDown, ChevronRight, Copy, RotateCcw } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SecretInput } from "@/components/ui/field";
import { useSchemaIndex, type SchemaGroup, type SchemaIndex, type SchemaRow, type SchemaSetting, type SchemaTab, type SchemaValue } from "@/hooks/useSchemaIndex";
import { Directory } from "../Directory";
import { NativeSetting, READ_ONLY_BADGE, SettingsHighlightContext, TERMINAL_ONLY_BADGE, ToggleSwitch, chipStyle, nativeInputStyle, nativeOptionStyle, nativeSelectStyle } from "../primitives";
import { useSaveStatus } from "../SaveStatus";
import { useSettingsShell } from "../shell-context";
import { ALSO_UNDER, ENGINE_PANEL_ID, cardOwner, cardSurfaceAvailable, rowSearchIdBesideCard, searchIdForKey, type CardSurface } from "./recommended-cards";

/** Beyond this many rows a tab's groups start collapsed on desktop too:
 * Hermes declares ~550 settings in one tab, and an open wall of them is not
 * a page anyone reads top to bottom. */
export const COLLAPSE_ABOVE_ROWS = 120;

/** Beyond this, an option label will not fit a select sitting beside the
 * setting's name, so the control moves to its own full-width row. */
const INLINE_OPTION_LABEL_LIMIT = 18;

/** Toggles and short selects read best beside the label. Free text, list
 * editors and long choice lists need the card's full width. */
export function isInlineControl(setting: SchemaSetting): boolean {
  if (setting.type === "boolean") return true;
  if (setting.type === "string" || setting.type === "array") return false;
  const labels = setting.options?.map((option) => option.label) ?? setting.values ?? [];
  if (labels.length === 0) return true; // A bare number input is compact.
  return labels.every((label) => label.length <= INLINE_OPTION_LABEL_LIMIT);
}

const smallButton = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "none",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 10.5,
  padding: "2px 4px",
  borderRadius: "var(--radius-control)",
  flexShrink: 0,
} as const;

const chipButton = {
  ...chipStyle,
  border: "1px solid transparent",
  cursor: "pointer",
  minHeight: 0,
  lineHeight: 1.5,
} as const;

/** The setting id, copyable. A brief "Copied" replaces the icon rather than
 * a toast: the id is what the user is looking at, and it already says so. */
export function CopyIdButton({ settingKey }: { settingKey: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      className="ui-focus-ring"
      aria-label={`Copy setting id ${settingKey}`}
      title="Copy setting id"
      onClick={() => {
        void navigator.clipboard?.writeText(settingKey).then(() => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        }).catch(() => undefined);
      }}
      style={{ ...smallButton, color: copied ? "var(--status-success)" : "var(--text-dim)" }}
    >
      {copied ? <><Check size={11} aria-hidden="true" /> Copied</> : <Copy size={11} aria-hidden="true" />}
    </button>
  );
}

/** A number input that commits on blur or Enter, never per keystroke: each
 * commit is a write to the engine's file, and "20000" typed digit by digit
 * would otherwise land as five writes, three of them out of range. */
export function NumberField({ label, value, onCommit, min, max, step, width = 110 }: {
  label: string;
  value: number | undefined;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number | string;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setDraft(value === undefined ? "" : String(value));
    }
  }, [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft === "" || !Number.isFinite(parsed) || parsed === value) {
      setDraft(value === undefined ? "" : String(value));
      return;
    }
    last.current = parsed;
    onCommit(parsed);
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); (event.target as HTMLInputElement).blur(); } }}
      style={{ ...nativeInputStyle, width, textAlign: "right" }}
    />
  );
}

/** The control for one schema setting, by its declared type. Shared by the
 * list rows and the Recommended cards so a setting looks the same in both. */
export function SchemaControl({ setting, value, onChange }: {
  setting: SchemaSetting;
  value: SchemaValue | undefined;
  onChange: (value: SchemaValue) => void;
}) {
  if (setting.readOnly) return <ReadOnlyValue setting={setting} value={value} />;

  if (setting.type === "boolean") {
    return <ToggleSwitch checked={value === true} onChange={onChange} />;
  }

  if (setting.type === "enum" || (setting.type === "number" && setting.options)) {
    const choices: Array<{ value: string; label: string; description?: string }> = setting.options ?? (setting.values ?? []).map((entry) => ({ value: entry, label: entry }));
    const current = value === undefined ? "" : String(value);
    // A hand-edited file can hold a value the engine no longer offers; keep
    // it listed rather than silently showing a different setting than what
    // is in effect.
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
          // A select never grows past its card: long option labels ellipsize
          // in the closed state instead of pushing the layout open.
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
    return <NumberField label={setting.label} value={typeof value === "number" ? value : undefined} onCommit={onChange} />;
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
function ReadOnlyValue({ setting, value }: { setting: SchemaSetting; value: SchemaValue | undefined }) {
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
  setting: SchemaSetting;
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
    if (entries.join("\n") === committed.current) return;
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

/** A credential-shaped leaf: write-only. The route never sends the value,
 * only whether one is set, so this shows "Set" / "Not set", takes a new
 * value masked, and can clear it — and never echoes what is stored. */
function SecretControl({ row, onSave, onClear }: { row: SchemaRow; onSave: (value: string) => Promise<boolean>; onClear: () => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...chipStyle, color: row.secretSet ? "var(--status-success)" : "var(--text-muted)" }}>{row.secretSet ? "Set" : "Not set"}</span>
        <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>Stored values are never shown here.</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <SecretInput
            value={draft}
            onChange={setDraft}
            placeholder={row.secretSet ? "Enter a new value to replace it" : "Enter a value"}
            showLabel="Show what you typed"
            hideLabel="Hide what you typed"
            id={`secret-${row.key}`}
          />
        </div>
        <button
          type="button"
          className="ui-focus-ring"
          disabled={draft.length === 0}
          onClick={() => { void onSave(draft).then((ok) => { if (ok) setDraft(""); }); }}
          style={{ padding: "5px 12px", minHeight: 32, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, cursor: draft.length === 0 ? "default" : "pointer", opacity: draft.length === 0 ? 0.5 : 1 }}
        >
          Save
        </button>
        {row.secretSet && (
          <button type="button" className="ui-focus-ring" onClick={onClear} style={{ padding: "5px 12px", minHeight: 32, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/** One row of the complete list: the control, the key with Copy, the
 * Changed / Also-under chips and Reset. The index comes from the parent —
 * one hook call per list, not one per row, or Hermes' 553 rows would each
 * rebuild the whole tab index on every cache change. */
export function SchemaSettingRow({ row, index }: { row: SchemaRow; index: SchemaIndex }) {
  const { capabilities, callbacks } = useSettingsShell();
  const { track } = useSaveStatus(ENGINE_PANEL_ID);
  const owner = cardOwner(row.key);
  const cardRendered = owner !== null && cardSurfaceAvailable(owner.surface, capabilities);

  const description = [
    row.description,
    index.describeCondition(row.condition),
    row.readOnly ? row.readOnlyReason : null,
  ].filter(Boolean).join(" ");

  const write = (value: SchemaValue | null) => track(() => index.setValue(row.key, value));
  const goToCard = (surface: CardSurface) => {
    if (surface === "recommended") {
      const card = document.querySelector<HTMLElement>(`[data-search-id="${searchIdForKey(row.key)}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (surface === "mcp") callbacks.selectSection("extensions", "mcp");
    else callbacks.selectSection("models");
  };

  const control = row.secret
    ? <SecretControl row={row} onSave={(value) => write(value)} onClear={() => { void write(null); }} />
    : <SchemaControl setting={row} value={row.value} onChange={(value) => { void write(value); }} />;
  const inline = !row.secret && isInlineControl(row);

  return (
    <NativeSetting
      label={row.label}
      // No fallback to the key: the row already prints it in mono below the
      // control, so falling back duplicates it. Hermes declares no descriptions.
      description={description || undefined}
      badge={row.readOnly ? READ_ONLY_BADGE : (row.terminalOnly ? TERMINAL_ONLY_BADGE : undefined)}
      searchId={cardRendered ? rowSearchIdBesideCard(row.key) : searchIdForKey(row.key)}
      control={(
        <>
          {!inline && control}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0, flexWrap: "wrap" }}>
              <code style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono, monospace)", minWidth: 0, overflowWrap: "anywhere" }}>{row.key}</code>
              <CopyIdButton settingKey={row.key} />
              {row.modified && <span style={{ ...chipStyle, color: "var(--accent)" }}>Changed</span>}
              {cardRendered && owner && (
                <button type="button" className="ui-focus-ring" onClick={() => goToCard(owner.surface)} style={chipButton} title="This key also has a card">
                  {ALSO_UNDER[owner.surface]}
                </button>
              )}
            </span>
            {row.modified && !row.readOnly && !row.secret && (
              <button type="button" className="ui-focus-ring" onClick={() => { void write(null); }} title="Reset to the engine's default" style={smallButton}>
                <RotateCcw size={11} aria-hidden="true" /> Reset
              </button>
            )}
          </div>
        </>
      )}
    >
      {inline ? control : undefined}
    </NativeSetting>
  );
}

function groupKey(tabId: string, groupId: string): string {
  return `${tabId} ${groupId}`;
}

/** A collapsible section: `Group · N settings · M changed`. */
function GroupSection({ tabId, group, open, onToggle, columns, index }: { tabId: string; group: SchemaGroup; open: boolean; onToggle: () => void; columns: number; index: SchemaIndex }) {
  const visible = group.rows.filter((row) => row.visible);
  if (visible.length === 0) return null;
  const changed = visible.filter((row) => row.modified).length;
  const id = `schema-group-${tabId}-${group.id}`.replace(/[^a-z0-9-]+/gi, "-");
  return (
    <section id={id} aria-labelledby={`${id}-heading`} style={{ display: "flex", flexDirection: "column", gap: 10, scrollMarginTop: 56 }}>
      <button
        type="button"
        id={`${id}-heading`}
        aria-expanded={open}
        onClick={onToggle}
        className="ui-focus-ring"
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 0", border: "none", borderBottom: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", minHeight: 32 }}
      >
        {open ? <ChevronDown size={14} aria-hidden="true" style={{ color: "var(--text-muted)", flexShrink: 0 }} /> : <ChevronRight size={14} aria-hidden="true" style={{ color: "var(--text-muted)", flexShrink: 0 }} />}
        <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-muted)" }}>{group.label}</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          · {visible.length} setting{visible.length === 1 ? "" : "s"}{changed > 0 ? ` · ${changed} changed` : ""}
        </span>
      </button>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 10 }}>
          {visible.map((row) => <SchemaSettingRow key={row.key} row={row} index={index} />)}
        </div>
      )}
    </section>
  );
}

type OpenState = Readonly<Record<string, boolean>>;

/** The groups of one tab as collapsible sections, declared groups first and
 * ungrouped rows after them under their key-prefix headings. */
function TabSections({ tab, openState, setOpenState, defaultOpen, columns, index }: {
  tab: SchemaTab;
  openState: OpenState;
  setOpenState: (next: (current: OpenState) => OpenState) => void;
  defaultOpen: boolean;
  columns: number;
  index: SchemaIndex;
}) {
  const sections = [...tab.groups, ...tab.ungrouped];
  return (
    <>
      {sections.map((group) => {
        const key = groupKey(tab.id, group.id);
        return (
          <GroupSection
            key={key}
            tabId={tab.id}
            group={group}
            open={openState[key] ?? defaultOpen}
            onToggle={() => setOpenState((current) => ({ ...current, [key]: !(current[key] ?? defaultOpen) }))}
            columns={columns}
            index={index}
          />
        );
      })}
    </>
  );
}

/** One tab (or one group of a single-tab engine) pushed as a phone level.
 * Self-contained on purpose: a pushed level is an element captured at push
 * time, so everything it shows must come from hooks it calls itself. */
function SchemaLevel({ tabId, groupId }: { tabId: string; groupId?: string }) {
  const { capabilities } = useSettingsShell();
  const index = useSchemaIndex({ enabled: capabilities.nativeSettings });
  const [openState, setOpenState] = useState<OpenState>({});
  const tab = index.tabs.find((entry) => entry.id === tabId);
  if (!tab) return null;
  if (groupId !== undefined) {
    const group = [...tab.groups, ...tab.ungrouped].find((entry) => entry.id === groupId);
    if (!group) return null;
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
        {group.rows.filter((row) => row.visible).map((row) => <SchemaSettingRow key={row.key} row={row} index={index} />)}
      </div>
    );
  }
  // A whole tab on a phone: groups closed until tapped, one column.
  return <TabSections tab={tab} openState={openState} setOpenState={setOpenState} defaultOpen={false} columns={1} index={index} />;
}

function rowMatches(row: SchemaRow, query: string): boolean {
  return `${row.label} ${row.description ?? ""} ${row.key} ${row.group ?? ""}`.toLowerCase().includes(query);
}

export function SchemaSettingsList() {
  const { capabilities, isMobile, harnessLabel, openSub } = useSettingsShell();
  const index = useSchemaIndex({ enabled: capabilities.nativeSettings });
  const shortName = index.shortName ?? harnessLabel;
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [openState, setOpenState] = useState<OpenState>({});
  const columns = isMobile ? 1 : 2;

  const tabs = index.tabs;
  const currentTab = useMemo(() => (activeTab && tabs.some((tab) => tab.id === activeTab) ? activeTab : tabs[0]?.id ?? null), [activeTab, tabs]);
  const tab = tabs.find((entry) => entry.id === currentTab) ?? null;
  const singleTab = tabs.length === 1;
  const query = filter.trim().toLowerCase();

  // Arriving from the dialog-wide search: land on the tab (and open the
  // group) that owns the match so NativeSetting has something to scroll to.
  // On a phone the row lives in a pushed level, so push it.
  const highlightId = useContext(SettingsHighlightContext);
  const pushedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightId?.startsWith("schema-") || index.rows.length === 0) return;
    const key = highlightId.replace(/^schema-/, "").replace(/-row$/, "");
    const row = index.byKey.get(key);
    if (!row) return;
    setActiveTab(row.tab);
    setFilter("");
    const groupId = row.group ?? (row.key.includes(".") ? row.key.slice(0, row.key.indexOf(".")) : "General");
    setOpenState((current) => ({ ...current, [groupKey(row.tab, groupId)]: true }));
    if (isMobile && pushedFor.current !== highlightId) {
      pushedFor.current = highlightId;
      const tabLabel = index.tabs.find((entry) => entry.id === row.tab)?.label ?? row.tab;
      openSub(<SchemaLevel tabId={row.tab} groupId={singleTab ? groupId : undefined} />, singleTab ? groupId : tabLabel);
    }
  }, [highlightId, index.rows.length, index.byKey, index.tabs, isMobile, openSub, singleTab]);

  const jumpToGroup = useCallback((groupId: string) => {
    if (!tab) return;
    setOpenState((current) => ({ ...current, [groupKey(tab.id, groupId)]: true }));
    const id = `schema-group-${tab.id}-${groupId}`.replace(/[^a-z0-9-]+/gi, "-");
    // The section mounts open on the next paint; scroll once it is there.
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [tab]);

  if (index.status === "disabled" || index.status === "unsupported") return null;

  const heading = (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>All {shortName} settings</h3>
      <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
        {index.status === "ready"
          ? <>{[index.version, `${index.modifiedCount} changed`, `${index.settingsCount} settings`].filter(Boolean).join(" · ")} — every setting {shortName} declares, in its own tabs and sections{index.path ? <>, saved to <code style={{ fontSize: 11 }}>{index.path}</code></> : null}.</>
          : <>This list mirrors {shortName}&apos;s own settings schema, so it shows every setting the installed {shortName} declares.</>}
      </p>
    </div>
  );

  if (index.status === "loading") {
    return (
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        {heading}
        <div role="status" style={{ fontSize: 12, color: "var(--text-muted)" }}>Reading {shortName}&apos;s settings schema…</div>
      </div>
    );
  }

  if (index.status !== "ready") {
    return (
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        {heading}
        <div role="alert" style={{ padding: "10px 14px", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 12, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <AlertCircle size={14} aria-hidden="true" style={{ marginTop: 1, flexShrink: 0 }} />
          <span>{shortName}&apos;s schema could not be read, so only the Recommended cards are available. {index.reason}</span>
        </div>
      </div>
    );
  }

  const filterInput = (
    <input
      type="search"
      aria-label={`Filter ${shortName} settings`}
      placeholder="Filter by name or key…"
      value={filter}
      onChange={(event) => setFilter(event.target.value)}
      style={{ ...nativeInputStyle, width: isMobile ? "100%" : 200, boxSizing: "border-box" }}
    />
  );

  // A filter spans every tab: the contents stop applying while it runs.
  const matches = query ? index.rows.filter((row) => row.visible && rowMatches(row, query)) : [];
  const matchGroups: SchemaGroup[] = [];
  for (const row of matches) {
    const label = `${tabs.find((entry) => entry.id === row.tab)?.label ?? row.tab}${row.group ? ` › ${row.group}` : ""}`;
    let bucket = matchGroups.find((entry) => entry.id === label);
    if (!bucket) {
      bucket = { id: label, label, rows: [], changed: 0 };
      matchGroups.push(bucket);
    }
    bucket.rows.push(row);
    if (row.modified) bucket.changed += 1;
  }

  const filtered = query ? (
    matchGroups.length === 0
      ? <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>No settings match this filter.</p>
      : matchGroups.map((group) => (
        <GroupSection key={group.id} tabId="filter" group={group} open onToggle={() => undefined} columns={columns} index={index} />
      ))
  ) : null;

  const tocRows = (source: Array<{ id: string; label: string; rows: SchemaRow[]; changed: number }>, open: (id: string) => void) => source.map((entry) => {
    const visible = entry.rows.filter((row) => row.visible).length;
    return {
      id: entry.id,
      title: entry.label,
      subtitle: `${visible} setting${visible === 1 ? "" : "s"}${entry.changed > 0 ? ` · ${entry.changed} changed` : ""}`,
      onOpen: () => open(entry.id),
    };
  });

  if (isMobile) {
    const rows = singleTab && tab
      ? tocRows([...tab.groups, ...tab.ungrouped], (groupId) => openSub(<SchemaLevel tabId={tab.id} groupId={groupId} />, groupId))
      : tocRows(tabs, (tabId) => openSub(<SchemaLevel tabId={tabId} />, tabs.find((entry) => entry.id === tabId)?.label ?? tabId));
    return (
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        {heading}
        {filterInput}
        {query ? filtered : <Directory sections={[{ id: "schema-toc", rows }]} ariaLabel={`${shortName} settings sections`} />}
      </div>
    );
  }

  const defaultOpen = (tab?.rows.length ?? 0) <= COLLAPSE_ABOVE_ROWS;

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      {heading}
      <div style={{ position: "sticky", top: 0, zIndex: 2, background: "var(--bg)", padding: "6px 0", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        {query ? (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{matches.length} matching setting{matches.length === 1 ? "" : "s"} across every tab</span>
        ) : singleTab && tab ? (
          <select
            aria-label={`Jump to a ${shortName} settings section`}
            value=""
            onChange={(event) => { if (event.target.value) jumpToGroup(event.target.value); }}
            style={{ ...nativeSelectStyle, maxWidth: 320 }}
          >
            <option value="" style={nativeOptionStyle}>Jump to section… ({tab.groups.length + tab.ungrouped.length})</option>
            {[...tab.groups, ...tab.ungrouped].map((group) => (
              <option key={group.id} value={group.id} style={nativeOptionStyle}>{group.label}{group.changed > 0 ? ` · ${group.changed} changed` : ""}</option>
            ))}
          </select>
        ) : (
          <nav aria-label={`${shortName} settings tabs`} role="tablist" style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
            {tabs.map((entry) => {
              const selected = entry.id === currentTab;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveTab(entry.id)}
                  className="ui-focus-ring"
                  style={{ padding: "5px 10px", border: "1px solid " + (selected ? "var(--accent)" : "var(--border)"), borderRadius: "var(--radius-control)", background: selected ? "var(--bg-selected)" : "transparent", color: selected ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap", minHeight: 28 }}
                >
                  {entry.label}{entry.changed > 0 ? <span style={{ marginLeft: 5, color: "var(--accent)", fontSize: 10.5 }}>{entry.changed}</span> : null}
                </button>
              );
            })}
          </nav>
        )}
        {filterInput}
      </div>
      {query ? filtered : tab && <TabSections tab={tab} openState={openState} setOpenState={setOpenState} defaultOpen={defaultOpen} columns={columns} index={index} />}
    </div>
  );
}
