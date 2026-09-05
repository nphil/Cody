"use client";

/**
 * Per-provider curation of omp's `enabledModels`: which of a provider's
 * models reach sessions, and whether models the provider releases LATER
 * are enabled without a revisit.
 *
 * One provider can dominate the registry (an OpenRouter key alone brought
 * 466 of 502 models on a real install), so the catalog keeps one summary
 * row per provider and the models themselves live behind this view:
 *   - the catalog is read once by the hub and sliced per provider here, so
 *     opening a provider costs no request;
 *   - rendered rows are capped, so the DOM stays a constant size no matter
 *     how many models match;
 *   - edits accumulate in a draft and save ONCE, through the config writer
 *     (`patchTop`), so a queued schema patch is never clobbered by a raw
 *     PUT of the whole settings object.
 *
 * "Include future models" is the fix for the original defect: exact entries
 * froze the list at curation time. It defaults ON while the draft equals the
 * whole provider (`provider/**` is written); with a strict subset the exact
 * ids are written whatever the switch says, and the copy says so.
 *
 * Save also records what was DISPLAYED as seen (`POST /api/models/seen`):
 * curation hides only what a human has looked at, so a model that arrives
 * next month still announces itself as new.
 *
 * Rendered through `Drawer`: a side drawer on desktop, a pushed level on a
 * phone — never a second Dialog inside the settings dialog.
 */
import { useMemo, useState } from "react";
import { Drawer } from "../Drawer";
import { ToggleSwitch } from "../primitives";

export interface CurationModel {
  id: string;
  name: string;
  provider: string;
}

/** Rows rendered at once; the bulk buttons still apply to every match. */
export const CURATION_VISIBLE_LIMIT = 60;

const buttonStyle = {
  padding: "5px 10px",
  minHeight: 30,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 11,
  cursor: "pointer",
} as const;

export function ModelCurationDialog({ open, provider, catalog, enabled, saving, onCancel, onConfirm }: {
  open: boolean;
  provider: string;
  /** This provider's models from the UNRESTRICTED catalog. */
  catalog: CurationModel[];
  /** `provider/id` keys reaching sessions now. */
  enabled: Set<string>;
  saving: boolean;
  onCancel: () => void;
  /** `displayed` is every key the dialog listed — what "seen" records. */
  onConfirm: (selected: Set<string>, options: { includeFuture: boolean; displayed: string[] }) => void;
}) {
  const [query, setQuery] = useState("");
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(enabled));
  const [includeFutureChoice, setIncludeFutureChoice] = useState<boolean | null>(null);
  const total = catalog.length;

  const keys = useMemo(() => catalog.map((model) => `${model.provider}/${model.id}`), [catalog]);
  const wholeProvider = total > 0 && keys.every((key) => draft.has(key));
  // Defaults ON exactly when the draft is the whole provider — that is the
  // case where the glob is what the user means.
  const includeFuture = includeFutureChoice ?? wholeProvider;

  const needle = query.trim().toLowerCase();
  const matches = catalog.filter((model) => {
    if (enabledOnly && !draft.has(`${model.provider}/${model.id}`)) return false;
    if (!needle) return true;
    return model.id.toLowerCase().includes(needle) || (model.name ?? "").toLowerCase().includes(needle);
  });
  const visible = matches.slice(0, CURATION_VISIBLE_LIMIT);
  const hiddenCount = matches.length - visible.length;
  const dirty = draft.size !== enabled.size || [...draft].some((key) => !enabled.has(key)) || (includeFutureChoice !== null && includeFutureChoice !== wholeProvider);

  const bulk = (bulkKeys: string[], on: boolean) => {
    setDraft((previous) => {
      const next = new Set(previous);
      for (const key of bulkKeys) if (on) next.add(key); else next.delete(key);
      return next;
    });
  };

  const footer = (
    <>
      <button type="button" onClick={onCancel} style={{ ...buttonStyle, fontSize: 12, padding: "7px 12px" }}>Cancel</button>
      <button
        type="button"
        disabled={!dirty || saving}
        onClick={() => onConfirm(draft, { includeFuture, displayed: keys })}
        style={{ padding: "7px 12px", minHeight: 30, border: "none", borderRadius: "var(--radius-control)", background: dirty ? "var(--accent)" : "var(--bg-hover)", color: dirty ? "var(--on-accent)" : "var(--text-dim)", fontSize: 12, fontWeight: 600, cursor: dirty && !saving ? "pointer" : "default" }}
      >
        {saving ? "Saving…" : "Save selection"}
      </button>
    </>
  );

  return (
    <Drawer open={open} title={`${provider} models`} presentation="side" onClose={onCancel} dirty={dirty} width={560} footer={footer} ariaLabel={`Choose ${provider} models`}>
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
        {draft.size} of {total} enabled. Only enabled models reach the composer, model roles and fallback chains.
      </p>

      <label style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", cursor: "pointer" }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>Include future {provider} models</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>
            {wholeProvider
              ? <>Writes <code>{`${provider}/**`}</code>, so a model {provider} adds later is enabled without a revisit.</>
              : includeFuture
                ? <>Only applies once every {provider} model is enabled — a partial list is saved as exact ids, and a new {provider} model stays hidden until re-curated.</>
                : <>A partial list is saved as exact ids: a new {provider} model stays hidden until re-curated.</>}
          </span>
        </span>
        <ToggleSwitch checked={includeFuture} onChange={setIncludeFutureChoice} />
      </label>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${total} models…`}
          aria-label={`Search ${provider} models`}
          data-drawer-autofocus
          style={{ flex: "1 1 200px", minWidth: 0, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: 12, minHeight: 30 }}>
          <input type="checkbox" checked={enabledOnly} onChange={(event) => setEnabledOnly(event.target.checked)} /> Enabled only
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={matches.length === 0} onClick={() => bulk(matches.map((model) => `${model.provider}/${model.id}`), true)} style={{ ...buttonStyle, cursor: matches.length === 0 ? "default" : "pointer" }}>
          Enable {needle || enabledOnly ? `these ${matches.length}` : "all"}
        </button>
        <button type="button" disabled={matches.length === 0} onClick={() => bulk(matches.map((model) => `${model.provider}/${model.id}`), false)} style={{ ...buttonStyle, cursor: matches.length === 0 ? "default" : "pointer" }}>
          Disable {needle || enabledOnly ? `these ${matches.length}` : "all"}
        </button>
      </div>

      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", minHeight: 120, display: "flex", flexDirection: "column" }}>
        {matches.length === 0
          ? <div style={{ padding: "16px 12px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
              {catalog.length === 0
                ? <>This provider currently offers no models. Check its credentials under Providers.</>
                : enabledOnly && !needle
                  ? <>No {provider} models are enabled yet. Search above and enable the ones you want.</>
                  : <>Nothing matches &ldquo;{query.trim()}&rdquo;.</>}
            </div>
          : visible.map((model) => {
            const key = `${model.provider}/${model.id}`;
            return (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", minHeight: 36, color: "var(--text-muted)", fontSize: 12, borderBottom: "1px solid var(--border)", cursor: "pointer" }}>
                <input type="checkbox" checked={draft.has(key)} onChange={(event) => bulk([key], event.target.checked)} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {model.name && model.name !== model.id ? <>{model.name} <code style={{ color: "var(--text-dim)" }}>{model.id}</code></> : <code>{model.id}</code>}
                </span>
              </label>
            );
          })}
        {hiddenCount > 0 && (
          <div style={{ padding: "8px 10px", color: "var(--text-dim)", fontSize: 11 }}>
            {hiddenCount} more match — refine the search to see them, or use the bulk buttons above (they apply to all {matches.length}).
          </div>
        )}
      </div>
    </Drawer>
  );
}
