"use client";

/**
 * The Behavior hub's Recommended layer: the cards in `RECOMMENDED_CARDS`,
 * each bound at render time to its source of truth.
 *
 *   - A key the engine's schema declares gets its label, description,
 *     choices, default and `condition` FROM the schema (through
 *     `useSchemaIndex`) and writes through the coalesced schema patch. It
 *     hides exactly when its schema row hides, because both ask the same
 *     hook the same question.
 *   - A key the engine keeps config-file only (the eight in `CURATED_ONLY`)
 *     takes its copy from that table, reads `/api/omp-settings` and writes
 *     through the section-spread writer.
 *
 * Nothing here carries a label of its own beyond that table, so an upstream
 * rename shows up here the moment the engine ships it. The "Enable Advisor
 * for new sessions" default this browser keeps (`cody:advisor-enabled`)
 * follows the `advisor.enabled` card through the shell's callback.
 */
import { AlertCircle, ArrowDown, ArrowUp, RotateCcw, Sparkles, X } from "lucide-react";
import { useCallback, type CSSProperties, type ReactNode } from "react";
import { useConfigWriter, useNativeSettings, type CompactionMethod, type NativeSettings, type NativeSettingsHandle } from "@/hooks/useConfigWriter";
import { useSchemaIndex, type SchemaIndex, type SchemaRow, type SchemaValue } from "@/hooks/useSchemaIndex";
import { NativeSetting, TERMINAL_ONLY_BADGE, ToggleSwitch, chipStyle, nativeOptionStyle, nativeSelectStyle } from "../primitives";
import { useSaveStatus } from "../SaveStatus";
import { useSettingsShell } from "../shell-context";
import { ENGINE_PANEL_ID, RECOMMENDED_CARDS, RECOMMENDED_GROUPS, curatedOnly, searchIdForKey, type CuratedOnlySetting, type RecommendedCard, type RecommendedGroup } from "./recommended-cards";
import { NumberField, SchemaControl } from "./SchemaSettingsList";

const COMPACTION_METHOD_LABELS: Record<CompactionMethod, string> = {
  remote: "Server compaction",
  snapcompact: "Snapcompact",
  handoff: "Handoff",
  shake: "Shake",
  soft: "Soft summary",
};
export const DEFAULT_COMPACTION_METHOD_ORDER: readonly CompactionMethod[] = ["remote", "snapcompact", "handoff", "shake", "soft"];

/** Ordered editor for compaction.methodOrder: enabled methods in preference
 * order with move/remove, remaining methods addable, and a one-click return
 * to the engine's default order. An empty list is valid: it turns automatic
 * context maintenance off, which is what the legacy "Off" strategy mapped
 * to. The schema declares the key as a plain array (its default is computed
 * upstream and does not survive the read), so the order lives here. */
export function CompactionMethodOrderEditor({ value, onChange }: {
  value: CompactionMethod[] | undefined;
  onChange: (methodOrder: CompactionMethod[]) => void;
}) {
  const order = value ?? [...DEFAULT_COMPACTION_METHOD_ORDER];
  const remaining = DEFAULT_COMPACTION_METHOD_ORDER.filter((method) => !order.includes(method));
  const isDefault = order.length === DEFAULT_COMPACTION_METHOD_ORDER.length
    && order.every((method, index) => method === DEFAULT_COMPACTION_METHOD_ORDER[index]);
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const rowButton: CSSProperties = {
    padding: 2, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer",
    display: "inline-flex", alignItems: "center", minWidth: 28, minHeight: 28, justifyContent: "center",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      {order.length === 0 && (
        <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>No methods — automatic context maintenance is off.</div>
      )}
      {order.map((method, index) => (
        <div key={method} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text)" }}>
          <span style={{ width: 14, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{index + 1}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{COMPACTION_METHOD_LABELS[method] ?? method}</span>
          <button type="button" aria-label={`Move ${COMPACTION_METHOD_LABELS[method] ?? method} up`} disabled={index === 0} onClick={() => move(index, -1)} style={{ ...rowButton, opacity: index === 0 ? 0.4 : 1, cursor: index === 0 ? "default" : "pointer" }}><ArrowUp size={13} /></button>
          <button type="button" aria-label={`Move ${COMPACTION_METHOD_LABELS[method] ?? method} down`} disabled={index === order.length - 1} onClick={() => move(index, 1)} style={{ ...rowButton, opacity: index === order.length - 1 ? 0.4 : 1, cursor: index === order.length - 1 ? "default" : "pointer" }}><ArrowDown size={13} /></button>
          <button type="button" aria-label={`Remove ${COMPACTION_METHOD_LABELS[method] ?? method}`} onClick={() => onChange(order.filter((entry) => entry !== method))} style={rowButton}><X size={13} /></button>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {remaining.length > 0 && (
          <select
            style={{ ...nativeSelectStyle, minHeight: 28, fontSize: 11.5 }}
            value=""
            aria-label="Add compaction method"
            onChange={(event) => { if (event.target.value) onChange([...order, event.target.value as CompactionMethod]); }}
          >
            <option value="" style={nativeOptionStyle}>Add method…</option>
            {remaining.map((method) => <option key={method} value={method} style={nativeOptionStyle}>{COMPACTION_METHOD_LABELS[method]}</option>)}
          </select>
        )}
        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange([...DEFAULT_COMPACTION_METHOD_ORDER])}
            style={{ padding: "3px 8px", minHeight: 28, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}
          >
            Default order
          </button>
        )}
      </div>
    </div>
  );
}

const resetButton = {
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

/** The footer every card shares: key, Changed chip, the Cody-side hint and,
 * where the server can honour it, Reset. */
function CardFooter({ settingKey, modified, hint, onReset }: { settingKey: string; modified: boolean; hint?: string; onReset?: () => void }) {
  return (
    <>
      {hint && <span style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.4 }}>{hint}</span>}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
          <code style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono, monospace)", overflowWrap: "anywhere" }}>{settingKey}</code>
          {modified && <span style={{ ...chipStyle, color: "var(--accent)" }}>Changed</span>}
        </span>
        {modified && onReset && (
          <button type="button" className="ui-focus-ring" onClick={onReset} title="Reset to the engine's default" style={resetButton}>
            <RotateCcw size={11} aria-hidden="true" /> Reset
          </button>
        )}
      </div>
    </>
  );
}

/** A card whose key the engine's schema declares. */
function SchemaCard({ card, row, index, onAfterChange }: { card: RecommendedCard; row: SchemaRow; index: SchemaIndex; onAfterChange?: (value: SchemaValue) => void }) {
  const { track } = useSaveStatus(ENGINE_PANEL_ID);
  const write = (value: SchemaValue | null) => { void track(() => index.setValue(row.key, value)); };
  const change = (value: SchemaValue) => {
    onAfterChange?.(value);
    write(value);
  };
  const description = [row.description, index.describeCondition(row.condition)].filter(Boolean).join(" ");
  const inline = card.control !== "methodOrder" && (row.type === "boolean" || (row.type !== "string" && row.type !== "array" && (row.options ?? row.values ?? []).every((choice) => (typeof choice === "string" ? choice : choice.label).length <= 18)));
  const control = card.control === "methodOrder"
    ? (
      <CompactionMethodOrderEditor
        value={Array.isArray(index.values[row.key]) ? (index.values[row.key] as CompactionMethod[]) : undefined}
        onChange={(order) => change(order)}
      />
    )
    : <SchemaControl setting={row} value={row.value} onChange={change} />;
  return (
    <NativeSetting
      label={row.label}
      description={description || undefined}
      badge={row.terminalOnly ? TERMINAL_ONLY_BADGE : undefined}
      searchId={searchIdForKey(row.key)}
      control={(
        <>
          {!inline && control}
          <CardFooter settingKey={row.key} modified={row.modified} hint={card.hint} onReset={() => write(null)} />
        </>
      )}
    >
      {inline ? control : undefined}
    </NativeSetting>
  );
}

function readCurated(settings: NativeSettings | null, meta: CuratedOnlySetting): boolean | number | string | undefined {
  if (!settings) return undefined;
  let node: unknown = settings;
  for (const segment of meta.section ? [...meta.section.split("."), meta.field] : [meta.field]) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "boolean" || typeof node === "number" || typeof node === "string" ? node : undefined;
}

function writeCurated(native: NativeSettingsHandle, meta: CuratedOnlySetting, value: boolean | number | string): Promise<void> {
  if (meta.section === "tools.approval") return native.patchApproval({ [meta.field]: value });
  if (meta.section === null) return native.patchTop({ [meta.field]: value });
  return native.patchSection(meta.section, { [meta.field]: value });
}

/** Drop one curated-only override so omp's own default applies again. The
 * section PUT can only set keys, so this goes through the DELETE route's
 * per-path form; queued in the "delete" family so it lands after any write
 * to the same file that is still in flight. */
async function resetCurated(key: string): Promise<void> {
  const response = await fetch("/api/omp-settings", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [key] }),
  });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
}

/** A card whose key the engine keeps config-file only: copy from the table,
 * value from /api/omp-settings, written through the section writer, reset
 * through the DELETE route's per-path form. */
function CuratedCard({ card, meta, native, onAfterChange }: { card: RecommendedCard; meta: CuratedOnlySetting; native: NativeSettingsHandle; onAfterChange?: (value: boolean | number | string) => void }) {
  const { track } = useSaveStatus(ENGINE_PANEL_ID);
  const { enqueue } = useConfigWriter();
  const stored = readCurated(native.settings, meta);
  const effective = stored ?? meta.default;
  const change = (value: boolean | number | string) => {
    onAfterChange?.(value);
    void track(() => writeCurated(native, meta, value));
  };
  const reset = () => {
    if (typeof meta.default === "boolean") onAfterChange?.(meta.default);
    void track(() => enqueue("delete", () => resetCurated(meta.key)));
  };
  let control: ReactNode;
  if (meta.type === "boolean") {
    control = <ToggleSwitch checked={effective === true} onChange={change} />;
  } else if (meta.type === "enum") {
    control = (
      <select aria-label={meta.label} value={String(effective)} onChange={(event) => change(event.target.value)} style={nativeSelectStyle}>
        {(meta.options ?? []).map((option) => <option key={option.value} value={option.value} style={nativeOptionStyle}>{option.label}</option>)}
      </select>
    );
  } else {
    control = <NumberField label={meta.label} value={typeof effective === "number" ? effective : undefined} onCommit={change} min={meta.min} max={meta.max} step={meta.step} />;
  }
  return (
    <NativeSetting
      label={meta.label}
      description={meta.description}
      searchId={searchIdForKey(meta.key)}
      control={<CardFooter settingKey={meta.key} modified={stored !== undefined} hint={card.hint} onReset={reset} />}
    >
      {control}
    </NativeSetting>
  );
}

function RecommendedCardView({ card, index, native }: { card: RecommendedCard; index: SchemaIndex; native: NativeSettingsHandle }) {
  const { callbacks } = useSettingsShell();
  // The browser-side default for new sessions follows the file's value.
  const onAdvisor = useCallback((value: unknown) => { if (typeof value === "boolean") callbacks.onAdvisorChange(value); }, [callbacks]);
  const afterChange = card.key === "advisor.enabled" ? onAdvisor : undefined;

  const row = index.byKey.get(card.key);
  if (row) {
    if (!row.visible) return null;
    return <SchemaCard card={card} row={row} index={index} onAfterChange={afterChange} />;
  }
  const meta = curatedOnly(card.key);
  if (!meta || !native.enabled) return null;
  // A curated-only key shares its neighbours' predicate; while the schema is
  // unreadable there is nothing to evaluate it against, and an inert card
  // beats a silently missing one.
  if (index.status === "ready" && !index.conditionMet(meta.condition)) return null;
  return <CuratedCard card={card} meta={meta} native={native} onAfterChange={afterChange} />;
}

function GroupHeading({ group, first }: { group: RecommendedGroup; first: boolean }) {
  return (
    <div style={first ? undefined : { borderTop: "1px solid var(--border)", paddingTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
        {group.id === "advisor" && <Sparkles size={14} aria-hidden="true" style={{ color: "var(--accent)" }} />}
        {group.label}
      </div>
      <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 12 }}>{group.description}</p>
    </div>
  );
}

export function RecommendedSettings() {
  const { capabilities, isMobile, harnessLabel } = useSettingsShell();
  const index = useSchemaIndex({ enabled: capabilities.nativeSettings });
  const native = useNativeSettings(capabilities.configEditor);
  const shortName = index.shortName ?? harnessLabel;
  const grid = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 } as const;
  const waiting = index.status === "loading" && !native.settings;

  return (
    <div style={{ padding: isMobile ? 16 : 20, display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Recommended</h3>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
          The settings most worth knowing about, bound to {shortName}&apos;s own schema so their names, choices and defaults are {shortName}&apos;s. Everything else is under All settings below.
        </p>
      </div>
      {native.error && (
        <div role="alert" style={{ padding: "10px 14px", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", border: "1px solid var(--status-error)", color: "var(--status-error)", fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle size={14} aria-hidden="true" /> {native.error}
        </div>
      )}
      {index.status === "unavailable" && (
        <div role="alert" style={{ padding: "10px 14px", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 12, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <AlertCircle size={14} aria-hidden="true" style={{ marginTop: 1, flexShrink: 0 }} />
          <span>{shortName}&apos;s schema could not be read, so only the settings Cody describes itself are shown. {index.reason}</span>
        </div>
      )}
      {waiting ? (
        <div role="status" style={{ fontSize: 12, color: "var(--text-muted)" }}>Reading {shortName}&apos;s settings…</div>
      ) : RECOMMENDED_GROUPS.map((group, position) => (
        <section key={group.id} aria-label={group.label} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <GroupHeading group={group} first={position === 0} />
          <div style={grid}>
            {RECOMMENDED_CARDS.filter((card) => card.group === group.id).map((card) => (
              <RecommendedCardView key={card.key} card={card} index={index} native={native} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
