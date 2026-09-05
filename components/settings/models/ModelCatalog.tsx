"use client";

/**
 * Settings › Models › Catalog: every model the engine can reach, with who
 * hid or pinned it, filterable by provider and a handful of chips, and the
 * three actions in their three scopes:
 *
 *   - Hide (administrator, whole instance): on omp this edits
 *     `enabledModels` through the config writer; elsewhere the visibility
 *     file. Hiding a model of a provider that is currently open as a whole
 *     (`provider/**`, or an unrestricted list) pins that provider to an
 *     exact list, which is a bigger step than the click suggests, so it
 *     asks first and offers "Hide for me instead".
 *   - Hide for me (any user): the account's own list, mirrored to the
 *     browser so the composer repaints at once.
 *   - Pin (any user): to the top of the composer picker.
 *
 * Every hide gets an 8 s undo toast. Rows sort New → Pinned → name and are
 * windowed above `WINDOW_ABOVE` rows — a registry can carry 500+ models and
 * one `<div>` per model per keystroke of search is what made the old panel
 * crawl. The hub's data (rows, lists, writes) comes from
 * `hooks/useModelCatalog`; this file is the view.
 */
import { AlertCircle, Eye, EyeOff, KeyRound, Pin, PinOff, RefreshCw, UserRoundX, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ModelIcon, ProviderIcon } from "@/components/ProviderIcon";
import { toast } from "@/components/ui/toast";
import type { CatalogRow, ModelCatalogHandle } from "@/hooks/useModelCatalog";
import { curationModeFor, allowListActive } from "@/lib/model-allow-list";
import { Drawer } from "../Drawer";
import { chipStyle, nativeOptionStyle, nativeSelectStyle, READ_ONLY_BADGE } from "../primitives";
import { useSaveStatus } from "../SaveStatus";
import { useSettingsShell } from "../shell-context";
import { ModelCurationDialog } from "./ModelCurationDialog";
import { NewModelsNotice } from "./NewModelsNotice";

/** Above this many rows the list renders only what is on screen. */
export const WINDOW_ABOVE = 200;
const ROW_HEIGHT = 58;
const WINDOW_HEIGHT = 520;
const OVERSCAN = 8;
const UNDO_MS = 8_000;

type Chip = "connected" | "reasoning" | "local" | "hidden" | "pinned" | "new";

const CHIP_LABELS: Record<Chip, string> = {
  connected: "Connected only",
  reasoning: "Reasoning",
  local: "Local",
  hidden: "Hidden",
  pinned: "Pinned",
  new: "New",
};

function formatContext(tokens: number | undefined): string | null {
  if (!tokens) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

const toolbarButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "5px 10px",
  minHeight: 30,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 11.5,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function ChipButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="ui-focus-ring"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        minHeight: 28,
        padding: "3px 10px",
        // Longhands, not the `border` shorthand: the colour flips with the
        // active state, and React warns when a longhand and its shorthand
        // fight across renders.
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: active ? "var(--accent)" : "var(--border)",
        borderRadius: 14,
        background: active ? "color-mix(in srgb, var(--accent) 14%, var(--bg-panel))" : "var(--bg-panel)",
        color: active ? "var(--text)" : "var(--text-muted)",
        fontSize: 11.5,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function RowAction({ label, icon, onClick, disabled, danger, compact }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; compact: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="ui-focus-ring"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        minWidth: compact ? 44 : undefined,
        minHeight: compact ? 44 : 28,
        padding: compact ? 0 : "3px 8px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: "transparent",
        color: danger ? "var(--status-warning)" : "var(--text-muted)",
        fontSize: 11,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        touchAction: "manipulation",
      }}
    >
      {icon}
      {!compact && <span>{label}</span>}
    </button>
  );
}

function StateChip({ row }: { row: CatalogRow }) {
  if (row.state === "instanceHidden") return <span style={{ ...chipStyle, color: "var(--status-warning)" }}>Hidden by an administrator</span>;
  if (row.state === "myHidden") return <span style={{ ...chipStyle }}>Hidden for me</span>;
  if (row.state === "needsKey") return <span style={{ ...chipStyle, color: "var(--status-warning)" }}>Needs a key</span>;
  return null;
}

export function ModelCatalog({ catalog, panelId }: { catalog: ModelCatalogHandle; panelId: string }) {
  const { capabilities, harnessLabel, isMobile, callbacks, sessionModels } = useSettingsShell();
  const { track } = useSaveStatus(panelId);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<string>("");
  const [chips, setChips] = useState<Set<Chip>>(() => new Set<Chip>(["connected"]));
  const [curating, setCurating] = useState<string | null>(null);
  const [curationSaving, setCurationSaving] = useState(false);
  const [pending, setPending] = useState<{ keys: string[]; providers: string[]; names: string[] } | null>(null);
  const [seenBusy, setSeenBusy] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Stable on purpose: on a phone the curation drawer registers itself as a
  // pushed level keyed on its close handler, and a fresh function per render
  // would re-register it on every render.
  const closeCuration = useCallback(() => setCurating(null), []);

  const toggleChip = (chip: Chip) => setChips((current) => {
    const next = new Set(current);
    if (next.has(chip)) next.delete(chip); else next.add(chip);
    return next;
  });

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => catalog.rows.filter((row) => {
    if (provider && row.provider !== provider) return false;
    if (chips.has("connected") && !row.connected) return false;
    if (chips.has("reasoning") && !row.reasoning) return false;
    if (chips.has("local") && !row.local) return false;
    if (chips.has("hidden") && row.state !== "instanceHidden" && row.state !== "myHidden") return false;
    if (chips.has("pinned") && !row.pinned) return false;
    if (chips.has("new") && !row.isNew) return false;
    if (!needle) return true;
    return row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle) || row.provider.toLowerCase().includes(needle) || row.key.toLowerCase().includes(needle);
  }), [catalog.rows, provider, chips, needle]);

  const windowed = filtered.length > WINDOW_ABOVE;
  useEffect(() => {
    if (!windowed) setScrollTop(0);
  }, [windowed, filtered.length]);
  const firstIndex = windowed ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const lastIndex = windowed ? Math.min(filtered.length, Math.ceil((scrollTop + WINDOW_HEIGHT) / ROW_HEIGHT) + OVERSCAN) : filtered.length;
  const slice = filtered.slice(firstIndex, lastIndex);

  const hiddenCount = catalog.rows.filter((row) => row.state === "instanceHidden" || row.state === "myHidden").length;
  const canHideInstance = catalog.isAdmin && !catalog.readOnly;

  const undoToast = useCallback((title: string, description: string, undo: () => Promise<void>) => {
    toast.info(title, description, {
      durationMs: UNDO_MS,
      action: { label: "Undo", onClick: () => { void track(undo); } },
    });
  }, [track]);

  const describe = (keys: readonly string[]) => {
    const names = keys.map((key) => catalog.rows.find((row) => row.key === key)?.name ?? key);
    return names.length === 1 ? names[0] : `${names.length} models`;
  };

  const hideForMe = useCallback((keys: string[]) => {
    void track(() => catalog.setMyHidden(keys, true)).then((ok) => {
      if (ok) undoToast(`Hidden ${describe(keys)} for you`, catalog.savedIn === "browser" ? "Saved in this browser." : "Only your composer is affected.", () => catalog.setMyHidden(keys, false));
    });
    // `describe` reads the current rows; it is not a stable dependency and
    // the closure is only used within this click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, track, undoToast]);

  const hideForInstance = useCallback((keys: string[]) => {
    void track(() => catalog.setInstanceHidden(keys, true)).then((ok) => {
      if (ok) undoToast(`Hidden ${describe(keys)} for everyone`, capabilities.models ? `Written to ${harnessLabel}'s enabledModels.` : "Hidden for every account on this instance.", () => catalog.setInstanceHidden(keys, false));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, track, undoToast, capabilities.models, harnessLabel]);

  const requestInstanceHide = (keys: string[]) => {
    const providers = catalog.providersPinnedByHiding(keys);
    if (providers.length > 0) {
      setPending({ keys, providers, names: keys.map((key) => catalog.rows.find((row) => row.key === key)?.name ?? key) });
      return;
    }
    hideForInstance(keys);
  };

  const showForInstance = (keys: string[]) => { void track(() => catalog.setInstanceHidden(keys, false)); };
  const showForMe = (keys: string[]) => { void track(() => catalog.setMyHidden(keys, false)); };
  const togglePin = (row: CatalogRow) => { void track(() => catalog.setPinned([row.key], !row.pinned)); };

  const markSeen = () => {
    setSeenBusy(true);
    void track(() => catalog.markSeen()).finally(() => setSeenBusy(false));
  };

  const bulkKeys = filtered.filter((row) => row.source !== "placeholder").map((row) => row.key);
  const bulkAllHidden = bulkKeys.length > 0 && filtered.every((row) => row.source === "placeholder" || row.state === "instanceHidden");

  const curatingCatalog = useMemo(() => (curating ? catalog.rows.filter((row) => row.provider === curating && row.source === "catalog") : []), [catalog.rows, curating]);
  const curatingEnabled = useMemo(() => new Set(curatingCatalog.filter((row) => row.state !== "instanceHidden").map((row) => row.key)), [curatingCatalog]);

  const sessionEmpty = catalog.catalogSource === "session" && (!sessionModels || sessionModels.length === 0);

  // Longhands only: the shorthand `overflow` plus a conditional `overflowY`
  // makes React warn when windowing flips with the filter.
  const listStyle: CSSProperties = windowed
    ? { height: WINDOW_HEIGHT, overflowX: "hidden", overflowY: "auto", position: "relative" }
    : { overflowX: "hidden", overflowY: "hidden" };

  const pinnedProviderCount = (name: string) => catalog.rows.filter((row) => row.provider === name && row.source === "catalog" && row.state !== "instanceHidden" && !pending?.keys.includes(row.key)).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      {catalog.error && (
        <div role="alert" style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", border: "1px solid var(--status-error)", color: "var(--status-error)", fontSize: 12 }}>
          <AlertCircle size={14} aria-hidden="true" /> {catalog.error}
        </div>
      )}

      <NewModelsNotice
        count={catalog.newCount}
        seenAt={catalog.seenAt}
        isAdmin={catalog.isAdmin}
        showingNew={chips.has("new")}
        busy={seenBusy}
        onShowNew={() => setChips(new Set<Chip>(["new"]))}
        onMarkSeen={markSeen}
      />

      {capabilities.models && catalog.curation.length > 0 && (
        <section aria-label="Curation" data-search-id="model-curation" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)", flex: 1 }}>Curation</span>
            {catalog.readOnly && <span style={{ ...chipStyle, color: "var(--status-warning)" }} title={`${harnessLabel}'s config holds path-scoped registry entries. Edit it by hand to keep their rules.`}>{READ_ONLY_BADGE}</span>}
            {!allowListActive(catalog.enabledModels) && <span style={chipStyle}>Unrestricted</span>}
          </div>
          {catalog.curation.map((entry) => {
            const mode = entry.mode;
            const summary = mode === "unrestricted" || mode === "all"
              ? `all current & future (${entry.total})`
              : mode === "exact"
                ? `${entry.enabled} of ${entry.total} · exact list`
                : `none of ${entry.total}`;
            return (
              <div key={entry.provider} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", minHeight: 40, fontSize: 12, borderTop: "1px solid var(--border)" }}>
                <ProviderIcon provider={entry.provider} size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                <code style={{ color: "var(--text)", flexShrink: 0 }}>{entry.provider}</code>
                <span style={{ flex: 1, minWidth: 0, color: mode === "exact" || mode === "none" ? "var(--status-warning)" : "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>
                {catalog.isAdmin && (
                  <button type="button" disabled={catalog.readOnly} onClick={() => setCurating(entry.provider)} style={{ ...toolbarButton, minHeight: isMobile ? 44 : 28, opacity: catalog.readOnly ? 0.5 : 1 }}>
                    {mode === "none" ? "Choose models…" : "Edit…"}
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}

      {!catalog.isAdmin && catalog.myHidden.size > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-muted)" }}>
          <span>You hide {catalog.myHidden.size} model{catalog.myHidden.size === 1 ? "" : "s"}</span>
          <button type="button" onClick={() => showForMe([...catalog.myHidden])} style={{ ...toolbarButton, minHeight: 28 }}>Clear</button>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${catalog.rows.length} models…`}
            aria-label="Search models"
            data-search-id="model-search"
            style={{ flex: "1 1 220px", minWidth: 0, padding: "7px 10px", minHeight: 32, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
          />
          {catalog.providers.length > 1 && (
            <select value={provider} onChange={(event) => setProvider(event.target.value)} aria-label="Provider" style={{ ...nativeSelectStyle, minHeight: 32, maxWidth: 200 }}>
              <option value="" style={nativeOptionStyle}>All providers</option>
              {catalog.providers.map((name) => <option key={name} value={name} style={nativeOptionStyle}>{name}</option>)}
            </select>
          )}
          {catalog.catalogSource === "global" && (
            <button type="button" onClick={() => { void catalog.refresh(); }} disabled={catalog.refreshing} aria-label="Refresh the catalog" title="Re-read the catalog from the engine" style={{ ...toolbarButton, minHeight: 32, opacity: catalog.refreshing ? 0.6 : 1 }}>
              <RefreshCw size={13} className={catalog.refreshing ? "icon-spin" : undefined} aria-hidden="true" />
              {!isMobile && "Refresh"}
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {(Object.keys(CHIP_LABELS) as Chip[]).map((chip) => (
            <ChipButton key={chip} active={chips.has(chip)} onClick={() => toggleChip(chip)}>
              {CHIP_LABELS[chip]}
              {chip === "new" && catalog.newCount > 0 && <span style={{ color: "var(--accent)", fontWeight: 600 }}>{catalog.newCount}</span>}
              {chip === "hidden" && hiddenCount > 0 && <span style={{ color: "var(--text-dim)" }}>{hiddenCount}</span>}
            </ChipButton>
          ))}
          <span style={{ flex: 1 }} />
          {catalog.savedIn === "browser" && <span style={chipStyle} title="No account is signed in, so pins and hides live in this browser only.">Saved in this browser</span>}
          {canHideInstance && bulkKeys.length > 0 && (
            bulkAllHidden
              ? <button type="button" onClick={() => showForInstance(bulkKeys)} style={{ ...toolbarButton, minHeight: 28 }}><Eye size={12} aria-hidden="true" /> Show all in view</button>
              : <button type="button" onClick={() => requestInstanceHide(bulkKeys.filter((key) => catalog.rows.find((row) => row.key === key)?.state !== "instanceHidden"))} style={{ ...toolbarButton, minHeight: 28 }}><EyeOff size={12} aria-hidden="true" /> Hide all in view</button>
          )}
        </div>
      </div>

      {sessionEmpty ? (
        <div style={{ padding: "14px 16px", border: "1px dashed var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Models come from the session. Start one to see what {harnessLabel} offers.
        </div>
      ) : catalog.loading && catalog.rows.length === 0 ? (
        <div role="status" style={{ padding: "14px 16px", fontSize: 12, color: "var(--text-muted)" }}>Reading the catalog…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: "14px 16px", border: "1px dashed var(--border)", borderRadius: "var(--radius-card)", fontSize: 12, color: "var(--text-muted)" }}>
          {catalog.rows.length === 0 ? "No models yet. Connect a provider to see its models here." : "No models match these filters."}
        </div>
      ) : (
        <div
          ref={listRef}
          role="list"
          aria-label="Models"
          onScroll={windowed ? (event) => setScrollTop((event.currentTarget as HTMLDivElement).scrollTop) : undefined}
          style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", ...listStyle }}
        >
          {windowed && <div aria-hidden="true" style={{ height: firstIndex * ROW_HEIGHT }} />}
          {slice.map((row, index) => {
            const compact = isMobile;
            const context = formatContext(row.contextWindow);
            return (
              <div
                key={row.key}
                role="listitem"
                data-model-key={row.key}
                data-model-state={row.state}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", minHeight: windowed ? ROW_HEIGHT : 52, height: windowed ? ROW_HEIGHT : undefined, boxSizing: "border-box", borderTop: index + firstIndex > 0 ? "1px solid var(--border)" : undefined, opacity: row.state === "instanceHidden" || row.state === "myHidden" ? 0.62 : 1 }}
              >
                <span aria-hidden="true" style={{ display: "inline-flex", width: 22, justifyContent: "center", flexShrink: 0, color: "var(--text-muted)" }}>
                  {row.source === "placeholder" ? <KeyRound size={14} /> : <ModelIcon provider={row.provider} modelId={row.id} size={14} />}
                </span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{row.name}</span>
                    {row.isNew && <span style={{ ...chipStyle, color: "var(--accent)" }}>New</span>}
                    {row.pinned && <span style={chipStyle}>Pinned</span>}
                    <StateChip row={row} />
                    {row.reasoning && <span style={chipStyle}>Reasoning</span>}
                    {row.supportsFastMode && <span style={chipStyle} title="Supports fast mode"><Zap size={9} aria-hidden="true" style={{ verticalAlign: -1 }} /> Fast</span>}
                    {context && <span style={chipStyle}>{context}</span>}
                    {row.local && <span style={chipStyle}>Local</span>}
                  </span>
                  <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.source === "placeholder" ? `${row.provider} · no credentials` : row.key}
                  </span>
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                  {row.source === "placeholder" ? (
                    <RowAction label="Add a key" icon={<KeyRound size={13} aria-hidden="true" />} onClick={() => callbacks.selectSection("providers")} compact={compact} />
                  ) : (
                    <>
                      {row.state === "visible" || row.state === "new" ? (
                        <RowAction label={row.pinned ? "Unpin" : "Pin"} icon={row.pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />} onClick={() => togglePin(row)} compact={compact} />
                      ) : null}
                      {row.state === "myHidden" ? (
                        <RowAction label="Show for me" icon={<Eye size={13} aria-hidden="true" />} onClick={() => showForMe([row.key])} compact={compact} />
                      ) : row.state !== "instanceHidden" ? (
                        <RowAction label="Hide for me" icon={<UserRoundX size={13} aria-hidden="true" />} onClick={() => hideForMe([row.key])} compact={compact} />
                      ) : null}
                      {catalog.isAdmin && (
                        row.state === "instanceHidden"
                          ? <RowAction label="Show for everyone" icon={<Eye size={13} aria-hidden="true" />} onClick={() => showForInstance([row.key])} disabled={catalog.readOnly} compact={compact} />
                          : <RowAction label="Hide for everyone" icon={<EyeOff size={13} aria-hidden="true" />} onClick={() => requestInstanceHide([row.key])} disabled={catalog.readOnly} danger compact={compact} />
                      )}
                    </>
                  )}
                </span>
              </div>
            );
          })}
          {windowed && <div aria-hidden="true" style={{ height: Math.max(0, (filtered.length - lastIndex) * ROW_HEIGHT) }} />}
        </div>
      )}
      {filtered.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {filtered.length === catalog.rows.length ? `${filtered.length} models` : `${filtered.length} of ${catalog.rows.length} models`}
          {hiddenCount > 0 && !chips.has("hidden") ? ` · ${hiddenCount} hidden` : ""}
        </div>
      )}

      {curating && (
        <ModelCurationDialog
          open
          provider={curating}
          catalog={curatingCatalog.map((row) => ({ id: row.id, name: row.name, provider: row.provider }))}
          enabled={curatingEnabled}
          saving={curationSaving}
          onCancel={closeCuration}
          onConfirm={(selected, options) => {
            setCurationSaving(true);
            let nothingEnabled = false;
            void track(async () => {
              const result = await catalog.writeProviderCuration(curating, [...selected], { includeFuture: options.includeFuture });
              nothingEnabled = result.nothingEnabled;
              // Curation hides only what a human has looked at: mark exactly
              // the keys the dialog listed, merged into the ledger's
              // existing seen keys — never the whole catalog, which would
              // also silence "new" for every other provider's models this
              // dialog never showed.
              await catalog.markSeen(options.displayed, { merge: true }).catch(() => undefined);
            }).then((ok) => {
              setCurationSaving(false);
              if (ok) {
                setCurating(null);
                if (nothingEnabled) {
                  toast.info(
                    "Nothing is enabled",
                    `${harnessLabel}'s allow-list now matches no model anywhere — every provider is hidden until one is re-enabled.`,
                  );
                }
              }
            });
          }}
        />
      )}

      <Drawer
        open={pending !== null}
        presentation="dialog"
        title={pending ? `Hiding ${pending.names.length === 1 ? pending.names[0] : `${pending.names.length} models`} pins ${pending.providers.join(", ")} to an exact list` : ""}
        onClose={() => setPending(null)}
        ariaLabel="Confirm hiding a model"
        footer={pending && (
          <>
            <button type="button" onClick={() => setPending(null)} style={{ ...toolbarButton, minHeight: 32, fontSize: 12 }}>Cancel</button>
            <button type="button" onClick={() => { const keys = pending.keys; setPending(null); hideForMe(keys); }} style={{ ...toolbarButton, minHeight: 32, fontSize: 12 }}>Hide for me instead</button>
            <button type="button" onClick={() => { const keys = pending.keys; setPending(null); hideForInstance(keys); }} style={{ ...toolbarButton, minHeight: 32, fontSize: 12, fontWeight: 600, background: "var(--accent-strong)", color: "var(--on-accent)", border: "none" }}>Pin to exact list</button>
          </>
        )}
      >
        {pending && (
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--text-muted)" }}>
            {pending.providers.map((name) => {
              const count = pinnedProviderCount(name);
              const mode = curationModeFor(catalog.enabledModels, name);
              return (
                <span key={name} style={{ display: "block", marginBottom: 6 }}>
                  <code style={{ color: "var(--text)" }}>{name}</code> is {mode === "all" ? <>open as <code>{`${name}/**`}</code></> : "unrestricted"} today. Hiding this pins it to an exact list of {count} id{count === 1 ? "" : "s"} — new {name} models stay hidden until re-curated.
                </span>
              );
            })}
            <span style={{ display: "block", marginTop: 4 }}>Hiding for yourself alone leaves {harnessLabel}&apos;s list as it is.</span>
          </p>
        )}
      </Drawer>
    </div>
  );
}
