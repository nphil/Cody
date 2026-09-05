"use client";

/**
 * The dialog-wide search's result surface. On desktop it replaces the rail
 * column while a query (or a chip) is active and stays until cleared; on
 * the phone it replaces the root list, and Back from a hub returns to it.
 *
 * Keyboard contract (critique d3): the results are ONE `role="listbox"`
 * tab stop with a roving active option (`aria-activedescendant`). ArrowDown
 * from the search field moves into the list (`focusSearchResults`); arrows
 * move, Home/End jump, Enter opens, Escape clears the query — which brings
 * the rail back. Every option is also a plain tap target.
 *
 * The chips (Changed · Cody only · Terminal only · Unavailable) narrow the
 * union; with an empty query a chip lists everything it matches.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { chipStyle } from "./primitives";
import { SEARCH_FILTERS, matchesSearchFilter, type SearchEntry, type SearchFilter, type SearchResult } from "./search-index";

export const SEARCH_RESULTS_ID = "settings-search-results";

/** Hand keyboard focus to the results list (the search field's ArrowDown). */
export function focusSearchResults(): boolean {
  const list = typeof document === "undefined" ? null : document.getElementById(SEARCH_RESULTS_ID);
  if (!list) return false;
  list.focus({ preventScroll: true });
  return true;
}

export function SearchFilterChips({ value, onChange, entries }: {
  value: SearchFilter | null;
  onChange: (filter: SearchFilter | null) => void;
  /** The union, to hide a chip that would match nothing. */
  entries: readonly SearchEntry[];
}) {
  const counts = useMemo(() => {
    const map = new Map<SearchFilter, number>();
    for (const chip of SEARCH_FILTERS) map.set(chip.id, entries.filter((entry) => matchesSearchFilter(entry, chip.id)).length);
    return map;
  }, [entries]);
  const chips = SEARCH_FILTERS.filter((chip) => (counts.get(chip.id) ?? 0) > 0 || chip.id === value);
  if (chips.length === 0) return null;
  return (
    <div role="group" aria-label="Filter results" className="settings-search-chips" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {chips.map((chip) => {
        const pressed = chip.id === value;
        return (
          <button
            key={chip.id}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(pressed ? null : chip.id)}
            className="settings-search-chip ui-focus-ring"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              minHeight: 28,
              border: `1px solid ${pressed ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 999,
              background: pressed ? "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))" : "var(--bg)",
              color: pressed ? "var(--text)" : "var(--text-muted)",
              fontSize: 11.5,
              fontWeight: pressed ? 600 : 500,
              cursor: "pointer",
              touchAction: "manipulation",
              whiteSpace: "nowrap",
            }}
          >
            {chip.label}
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{counts.get(chip.id) ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SearchResultsList({ results, query, filter, onFilterChange, entries, onSelect, onDismiss, width }: {
  results: readonly SearchResult[];
  query: string;
  filter: SearchFilter | null;
  onFilterChange: (filter: SearchFilter | null) => void;
  entries: readonly SearchEntry[];
  onSelect: (result: SearchResult) => void;
  /** Escape in the list: clear the search so the rail (or root list) returns. */
  onDismiss: () => void;
  /** Desktop column width; undefined fills the container (phone). */
  width?: number;
}) {
  const optionPrefix = useId();
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // A new result set starts at the top, and the active row follows a
  // keyboard move into view without yanking the pane around.
  useEffect(() => setActive(0), [results]);
  useEffect(() => {
    const element = document.getElementById(`${optionPrefix}-${active}`);
    if (element && listRef.current && document.activeElement === listRef.current) element.scrollIntoView({ block: "nearest" });
  }, [active, optionPrefix]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      onDismiss();
      return;
    }
    if (results.length === 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(results.length - 1, active + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, active - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = results.length - 1;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(results[active]);
      return;
    }
    if (next !== null) {
      event.preventDefault();
      setActive(next);
    }
  };

  const heading = query
    ? results.length === 0 ? `No settings match “${query}”.` : `${results.length} result${results.length === 1 ? "" : "s"} for “${query}”.`
    : results.length === 0 ? "Nothing matches this filter." : `${results.length} setting${results.length === 1 ? "" : "s"}.`;

  return (
    <div
      className="settings-search-column settings-scroll-column"
      style={{ width, flexShrink: width === undefined ? 1 : 0, flex: width === undefined ? 1 : undefined, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 10, padding: 12, background: "var(--bg-panel)", borderRight: width === undefined ? undefined : "1px solid var(--border)", overflowY: "auto" }}
    >
      <SearchFilterChips value={filter} onChange={onFilterChange} entries={entries} />
      <div aria-live="polite" style={{ fontSize: 12, color: "var(--text-muted)", padding: "0 2px" }}>{heading}</div>
      <div
        ref={listRef}
        id={SEARCH_RESULTS_ID}
        role="listbox"
        aria-label={query ? `Settings matching ${query}` : "Filtered settings"}
        aria-activedescendant={results.length > 0 ? `${optionPrefix}-${active}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="ui-focus-ring"
        style={{ display: "flex", flexDirection: "column", gap: 8, outline: "none", borderRadius: "var(--radius-card)" }}
      >
        {results.map((result, index) => {
          const isActive = index === active;
          return (
            <div
              key={`${result.tab}:${result.id}`}
              id={`${optionPrefix}-${index}`}
              role="option"
              aria-selected={isActive}
              data-active={isActive ? "true" : undefined}
              onClick={() => { setActive(index); onSelect(result); }}
              className="settings-search-result"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 3,
                padding: "9px 11px",
                minHeight: 44,
                boxSizing: "border-box",
                border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
                borderRadius: "var(--radius-card)",
                background: "var(--bg)",
                color: "var(--text)",
                cursor: "pointer",
                transition: "border-color var(--dur-fast), background var(--dur-fast)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{result.label}</span>
                {result.id.startsWith("tab-") && <span style={chipStyle}>Section</span>}
                {result.scope && <span style={chipStyle}>{result.scope}</span>}
                {result.badge && <span style={chipStyle}>{result.badge}</span>}
                {result.modified && <span style={{ ...chipStyle, color: "var(--accent)" }}>Changed</span>}
              </div>
              {result.description && <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{result.description}</div>}
              <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{result.breadcrumb.join(" › ")}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
