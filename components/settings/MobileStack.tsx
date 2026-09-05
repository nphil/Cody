"use client";

/**
 * The phone shell (<=640px): a full-bleed stack of levels. Level 1 is the
 * root list: a sticky 48px search field over the same hubs and eyebrows the
 * desktop rail shows, ordered by `phoneOrder`, rows at least 52px with a
 * chevron; a query (or a chip) replaces the list with the results, and Back
 * from a hub returns to them. Level 2 is one hub: a 48px header with a 44x44
 * "‹ Settings", the hub's label and a 44x44 Close, over the panel. Level 3
 * and deeper are pushed by `Drawer` (which renders its own surface) or by
 * `openSub(node, title)`, which renders here.
 *
 * History (pushState per level, back gesture, Escape) and the busy check
 * live in `SettingsShell`; this component is the surface, and every Back it
 * renders goes through the shell's `onBack` / `onCloseLevel` so a gesture
 * and a tap take the same path.
 */
import { ArrowLeft, ChevronRight, Search, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import type { ActiveEngineInfo, EngineCapabilities } from "../SettingsTabs";
import { groupLabel, groupSections, type SettingsSection, type SettingsSectionId, type StatusLine } from "./registry";
import type { SearchEntry, SearchFilter, SearchResult } from "./search-index";
import { focusSearchResults, SearchResultsList } from "./SettingsSearch";
import { useSectionStatuses } from "./SettingsSidebar";

export interface MobileSubLevel {
  id: string;
  title: string;
  /** Null when the level's owner (a Drawer) renders its own surface. */
  node: ReactNode | null;
  onBack?: () => void;
}

const headerButton = {
  width: 44,
  height: 44,
  minWidth: 44,
  minHeight: 44,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  borderRadius: "var(--radius-control)",
  touchAction: "manipulation" as const,
  flexShrink: 0,
};

const TONE_COLOR: Record<NonNullable<StatusLine["tone"]>, string> = {
  muted: "var(--text-dim)",
  accent: "var(--accent)",
  warn: "var(--status-warning)",
};

export function MobileLevelHeader({ title, onBack, backLabel, backText, onClose }: { title: ReactNode; onBack?: () => void; backLabel?: string; backText?: string; onClose: () => void }) {
  return (
    <header style={{ display: "flex", alignItems: "center", gap: 2, height: 48, minHeight: 48, padding: "0 2px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
      {onBack ? (
        <button type="button" onClick={onBack} aria-label={backLabel ?? "Back"} className="ui-focus-ring settings-mobile-back" style={{ ...headerButton, width: "auto", padding: "0 10px 0 6px", gap: 2, fontSize: 13, color: "var(--accent)" }}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>{backText ?? "Settings"}</span>
        </button>
      ) : (
        <span style={{ width: 44, flexShrink: 0 }} aria-hidden="true" />
      )}
      <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
      <button type="button" onClick={onClose} aria-label="Close settings" className="ui-focus-ring" style={headerButton}>
        <X size={18} aria-hidden="true" />
      </button>
    </header>
  );
}

export function MobileStack({ sections, active, view, onSelect, onBack, onClose, onCloseLevel, capabilities, engine, harnessLabel, searchQuery, onSearchQueryChange, searchFilter, onSearchFilterChange, searchEntries, searchResults, onSearchResult, onSearchDismiss, levels, children }: {
  sections: readonly SettingsSection[];
  active: SettingsSectionId;
  view: "root" | "panel";
  onSelect: (id: SettingsSectionId) => void;
  /** Back from a hub to the root list (the same path a back gesture takes). */
  onBack: () => void;
  onClose: () => void;
  /** Back from an `openSub` level. */
  onCloseLevel: (id: string) => void;
  capabilities: EngineCapabilities;
  engine: ActiveEngineInfo | null;
  harnessLabel: string;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchFilter: SearchFilter | null;
  onSearchFilterChange: (filter: SearchFilter | null) => void;
  searchEntries: readonly SearchEntry[];
  searchResults: readonly SearchResult[];
  onSearchResult: (result: SearchResult) => void;
  /** Clear the query and the chip: the root list returns. */
  onSearchDismiss: () => void;
  levels: readonly MobileSubLevel[];
  /** The mounted panel hosts (every visited hub; the active one visible). */
  children: ReactNode;
}) {
  const statuses = useSectionStatuses(sections, capabilities, engine, harnessLabel);
  const groups = groupSections(sections, "phone");
  const activeSection = sections.find((section) => section.id === active) ?? null;
  const searching = searchQuery.trim().length > 0 || searchFilter !== null;

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && searching) {
      // One Escape clears the search; the next reaches the dialog.
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      onSearchDismiss();
    } else if (event.key === "ArrowDown" && searchResults.length > 0) {
      event.preventDefault();
      focusSearchResults();
    }
  };

  return (
    <div className="settings-mobile-stack" style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {/* Level 1: root list. Kept mounted under a panel so scroll position and
          the query survive a Back. */}
      <div style={{ display: view === "root" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <MobileLevelHeader title="Settings" onClose={onClose} />
        <div className="settings-mobile-search" style={{ position: "sticky", top: 0, zIndex: 1, height: 48, minHeight: 48, boxSizing: "border-box", padding: "4px 12px", background: "var(--bg)", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center" }}>
          <div style={{ position: "relative", width: "100%" }}>
            <Search size={15} aria-hidden="true" style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
            <input
              type="search"
              aria-label="Search settings"
              placeholder="Search settings"
              autoComplete="off"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              onKeyDown={onSearchKeyDown}
              style={{ width: "100%", height: 40, padding: "0 12px 0 34px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 16, outline: "none", boxSizing: "border-box" }}
            />
          </div>
        </div>
        {searching ? (
          <SearchResultsList
            results={searchResults}
            query={searchQuery.trim()}
            filter={searchFilter}
            onFilterChange={onSearchFilterChange}
            entries={searchEntries}
            onSelect={onSearchResult}
            onDismiss={onSearchDismiss}
          />
        ) : (
          <div className="settings-scroll-column" style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: "8px 12px", paddingBottom: "max(16px, env(safe-area-inset-bottom))", display: "flex", flexDirection: "column", gap: 14 }}>
            {groups.map((group) => (
              <div key={group.group} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ padding: "6px 6px 0", fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" }}>{groupLabel(group.group, harnessLabel)}</div>
                <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", overflow: "hidden" }}>
                  {group.sections.map((section, index) => {
                    const status = statuses.get(section.id) ?? null;
                    const { Icon } = section;
                    return (
                      <button
                        key={section.id}
                        type="button"
                        id={`settings-tab-${section.id}`}
                        onClick={() => onSelect(section.id)}
                        className="settings-mobile-row ui-focus-ring"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          minHeight: 52,
                          padding: "8px 12px 8px 14px",
                          border: "none",
                          borderTop: index > 0 ? "1px solid var(--border)" : "none",
                          background: "transparent",
                          color: "var(--text)",
                          textAlign: "left",
                          cursor: "pointer",
                          width: "100%",
                          touchAction: "manipulation",
                        }}
                      >
                        <Icon size={18} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />
                        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontSize: 14, fontWeight: 500 }}>{section.label}</span>
                          {status && <span style={{ fontSize: 11.5, color: TONE_COLOR[status.tone ?? "muted"], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{status.text}</span>}
                        </span>
                        <ChevronRight size={16} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Level 2: one hub. */}
      <div style={{ display: view === "panel" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <MobileLevelHeader title={activeSection?.label ?? "Settings"} onBack={onBack} backLabel="Back to Settings" onClose={onClose} />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {children}
        </div>
      </div>

      {/* Level 3+: content pushed through openSub(node, title). Levels whose
          owner renders its own surface (Drawer) have node === null. */}
      {levels.filter((level) => level.node !== null).map((level) => (
        <div key={level.id} className="settings-mobile-level" style={{ position: "absolute", inset: 0, zIndex: 20, background: "var(--bg)", display: "flex", flexDirection: "column" }}>
          <MobileLevelHeader title={level.title} onBack={level.onBack ?? (() => onCloseLevel(level.id))} backLabel="Back" backText={activeSection?.label ?? "Back"} onClose={onClose} />
          <div className="settings-scroll-column" style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: 16, paddingBottom: "max(16px, env(safe-area-inset-bottom))", display: "flex", flexDirection: "column", gap: 14 }}>
            {level.node}
          </div>
        </div>
      ))}
    </div>
  );
}
