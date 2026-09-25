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
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Drawer } from "../Drawer";
import { chipStyle, ToggleSwitch } from "../primitives";
import { getModelPageWindow } from "@/lib/model-catalog-pagination";
import { MODEL_CATEGORY_OPTIONS, modelCategories, modelCategoryBucket, modelMatchesCategories, type ModelCategory } from "@/lib/model-categories";
import { formatModelDisplayName } from "@/lib/model-display";

export interface CurationModel {
  id: string;
  name: string;
  provider: string;
}

/** Rows shown on each page; the bulk buttons still apply to every match. */
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

export function ModelCurationDialog({ open, provider, catalog, enabled, hiddenForMe, saving, onCancel, onConfirm }: {
  open: boolean;
  provider: string;
  /** This provider's models from the UNRESTRICTED catalog. */
  catalog: CurationModel[];
  /** `provider/id` keys reaching sessions now. */
  enabled: Set<string>;
  /** Models this user has hidden in the composer. */
  hiddenForMe?: ReadonlySet<string>;
  saving: boolean;
  onCancel: () => void;
  /** `displayed` is every key the dialog listed — what "seen" records. */
  onConfirm: (selected: Set<string>, options: { includeFuture: boolean; displayed: string[] }) => void;
}) {
  const [query, setQuery] = useState("");
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<Set<ModelCategory>>(() => new Set());
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(enabled));
  const [includeFutureChoice, setIncludeFutureChoice] = useState<boolean | null>(null);
  const total = catalog.length;

  const keys = useMemo(() => catalog.map((model) => `${model.provider}/${model.id}`), [catalog]);
  const wholeProvider = total > 0 && keys.every((key) => draft.has(key));
  // Defaults ON exactly when the draft is the whole provider — that is the
  // case where the glob is what the user means.
  const includeFuture = includeFutureChoice ?? wholeProvider;

  const categoryOptions = useMemo(() => {
    const counts = new Map<ModelCategory, number>();
    for (const model of catalog) {
      const modelCategory = modelCategoryBucket(model);
      counts.set(modelCategory, (counts.get(modelCategory) ?? 0) + 1);
    }
    return MODEL_CATEGORY_OPTIONS
      .filter((modelCategory) => counts.has(modelCategory))
      .map((modelCategory) => ({ category: modelCategory, count: counts.get(modelCategory) ?? 0 }));
  }, [catalog]);

  const needle = query.trim().toLowerCase();
  const selectedCategoryKey = MODEL_CATEGORY_OPTIONS.filter((modelCategory) => selectedCategories.has(modelCategory)).join("|");
  const selectedCategoryLabel = selectedCategoryKey.replace(/\|/g, " + ");
  useEffect(() => {
    setPageIndex(0);
  }, [needle, enabledOnly, selectedCategoryKey]);

  const matches = catalog.filter((model) => {
    if (enabledOnly && !draft.has(`${model.provider}/${model.id}`)) return false;
    if (!modelMatchesCategories(model, selectedCategories)) return false;
    if (!needle) return true;
    return model.id.toLowerCase().includes(needle) || (model.name ?? "").toLowerCase().includes(needle);
  });
  const page = getModelPageWindow(matches.length, pageIndex, CURATION_VISIBLE_LIMIT);
  const visible = matches.slice(page.start, page.end);
  const hasCategoryFilter = selectedCategories.size > 0;
  const hasFilter = Boolean(needle || enabledOnly || hasCategoryFilter);
  const selectedHiddenCount = hiddenForMe ? [...draft].filter((key) => hiddenForMe.has(key)).length : 0;
  const dirty = draft.size !== enabled.size || [...draft].some((key) => !enabled.has(key)) || (includeFutureChoice !== null && includeFutureChoice !== wholeProvider) || selectedHiddenCount > 0;

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
      <p style={{ margin: "-6px 0 0", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45 }}>
        Saving also makes selected models visible in your composer if you had hidden them personally. It does not pin them.
      </p>
      {selectedHiddenCount > 0 && (
        <p style={{ margin: "-6px 0 0", color: "var(--accent)", fontSize: 11, lineHeight: 1.45 }}>
          {selectedHiddenCount} selected model{selectedHiddenCount === 1 ? " is" : "s are"} currently hidden for you and will be shown when you save.
        </p>
      )}

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
        {categoryOptions.length > 1 && (
          <details
            open={categoryMenuOpen}
            onToggle={(event) => setCategoryMenuOpen(event.currentTarget.open)}
            style={{ position: "relative", flex: "0 1 190px", minWidth: 160 }}
          >
            <summary
              aria-label="Model categories"
              className="ui-focus-ring"
              style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32, padding: "4px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12, cursor: "pointer", listStyle: "none" }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {hasCategoryFilter ? selectedCategoryLabel : "All categories"}
              </span>
              <ChevronDown
                aria-hidden="true"
                size={16}
                style={{ color: "var(--text-muted)", flexShrink: 0, transform: categoryMenuOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform var(--dur-fast)" }}
              />
            </summary>
            <div role="group" aria-label="Model categories" style={{ position: "absolute", zIndex: 4, top: "calc(100% + 4px)", left: 0, right: 0, padding: 4, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", boxShadow: "var(--shadow-modal)", maxHeight: 240, overflowY: "auto" }}>
              <div style={{ padding: "5px 8px 6px", color: "var(--text-dim)", fontSize: 10 }}>Select any categories</div>
              {categoryOptions.map(({ category: modelCategory, count }) => (
                <label key={modelCategory} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: "var(--radius-control)", color: "var(--text)", fontSize: 12, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={selectedCategories.has(modelCategory)}
                    onChange={() => setSelectedCategories((previous) => {
                      const next = new Set(previous);
                      if (next.has(modelCategory)) next.delete(modelCategory);
                      else next.add(modelCategory);
                      return next;
                    })}
                  />
                  <span style={{ flex: 1 }}>{modelCategory}</span>
                  <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{count}</span>
                </label>
              ))}
            </div>
          </details>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: 12, minHeight: 30 }}>
          <input type="checkbox" checked={enabledOnly} onChange={(event) => setEnabledOnly(event.target.checked)} /> Enabled only
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={matches.length === 0} onClick={() => bulk(matches.map((model) => `${model.provider}/${model.id}`), true)} style={{ ...buttonStyle, cursor: matches.length === 0 ? "default" : "pointer" }}>
          Enable {hasFilter ? `these ${matches.length}` : "all"}
        </button>
        <button type="button" disabled={matches.length === 0} onClick={() => bulk(matches.map((model) => `${model.provider}/${model.id}`), false)} style={{ ...buttonStyle, cursor: matches.length === 0 ? "default" : "pointer" }}>
          Disable {hasFilter ? `these ${matches.length}` : "all"}
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
            const displayName = formatModelDisplayName(model.id, model.name);
            const categories = modelCategories(model).filter((modelCategory) => modelCategory !== "Other");
            return (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", minHeight: 36, color: "var(--text-muted)", fontSize: 12, borderBottom: "1px solid var(--border)", cursor: "pointer" }}>
                <input type="checkbox" checked={draft.has(key)} onChange={(event) => bulk([key], event.target.checked)} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {displayName !== model.id ? <>{displayName} <code style={{ color: "var(--text-dim)" }}>{model.id}</code></> : <code>{model.id}</code>}
                </span>
                {categories.map((modelCategory) => <span key={modelCategory} style={{ ...chipStyle, flexShrink: 0, color: "var(--accent)" }}>{modelCategory}</span>)}
              </label>
            );
          })}
      </div>

      {page.pageCount > 1 && (
        <nav aria-label={`${provider} model pages`} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: "var(--text-dim)", fontSize: 11 }}>
          <span aria-live="polite">Showing {page.start + 1}–{page.end} of {matches.length}</span>
          <span style={{ flex: 1, minWidth: 12 }} />
          <button type="button" disabled={page.pageIndex === 0} onClick={() => setPageIndex((current) => Math.max(0, current - 1))} style={{ ...buttonStyle, opacity: page.pageIndex === 0 ? 0.45 : 1, cursor: page.pageIndex === 0 ? "default" : "pointer" }}>Previous</button>
          <span aria-label={`Page ${page.pageIndex + 1} of ${page.pageCount}`}>Page {page.pageIndex + 1} of {page.pageCount}</span>
          <button type="button" disabled={page.pageIndex === page.pageCount - 1} onClick={() => setPageIndex((current) => current + 1)} style={{ ...buttonStyle, opacity: page.pageIndex === page.pageCount - 1 ? 0.45 : 1, cursor: page.pageIndex === page.pageCount - 1 ? "default" : "pointer" }}>Next</button>
        </nav>
      )}
    </Drawer>
  );
}
