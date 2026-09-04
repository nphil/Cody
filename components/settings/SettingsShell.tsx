"use client";

/**
 * The Settings dialog. Owns the open hub (and segment), the search query, the
 * highlight, the visited set (a hub stays mounted once opened so a login SSE
 * in Providers survives a look at System), the phone stack's levels and the
 * busy register, and provides all of it through `ShellContext`.
 *
 * Desktop: header (title, search, close) over a 230px rail and a pane.
 * Phone (`useIsMobile`): a full-bleed `MobileStack`. Both render the same
 * hubs from `registry.ts` under the same ids, so `settings-tab-<id>` and
 * `settings-panel-<id>` hold on every width.
 *
 * Opening is driven by a `request`: AppShell bumps its `seq` with a target
 * hub (or none, meaning the last-open hub from `cody:settings-last-section`).
 */
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSettingsRoute } from "@/hooks/useSettingsData";
import { ConfirmDialog } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { ALL_CAPABILITIES, DEFAULT_HARNESS_LABEL, type ActiveEngineInfo, type EngineCapabilities, type PlatformInfo, type SettingsTab } from "../SettingsTabs";
import { MobileStack, type MobileSubLevel } from "./MobileStack";
import { SettingsHighlightContext } from "./primitives";
import { getVisibleSections, getVisibleSubViews, groupLabel, isSectionId, normalizeSectionId, resolveSection, type SettingsSection, type SettingsSectionId } from "./registry";
import { buildSchemaSearchEntries, SEARCH_ENTRIES, searchSettings, type SchemaRouteBody, type SearchEntry, type SearchResult } from "./search-index";
import { SearchResultsList, SettingsSidebar } from "./SettingsSidebar";
import { createSettingsBusy, ShellContext, type SessionModel, type SettingsShellCallbacks, type SettingsShellPrefs, type SettingsShellValue } from "./shell-context";

export interface SettingsRequest {
  /** Hub or legacy id to open; null means the last-open hub. */
  section: SettingsTab | null;
  sub?: string;
  highlight?: string;
  /** Bumped on every `openSettings` call so a repeat target re-applies. */
  seq: number;
}

export interface SettingsShellProps {
  request: SettingsRequest;
  cwd: string | null;
  sessionId: string | null;
  capabilities?: EngineCapabilities;
  engine?: ActiveEngineInfo | null;
  platform?: PlatformInfo;
  sessionModels?: SessionModel[] | null;
  prefs: SettingsShellPrefs;
  callbacks: Omit<SettingsShellCallbacks, "selectSection">;
}

function readLastSection(): SettingsSectionId | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEYS.settingsLastSection);
    return stored && isSectionId(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeLastSection(id: SettingsSectionId): void {
  try {
    window.localStorage.setItem(STORAGE_KEYS.settingsLastSection, id);
  } catch {
    // Section memory is a convenience; a blocked store costs one extra click.
  }
}

function PanelHost({ section, active, children }: { section: SettingsSection; active: boolean; children: ReactNode }) {
  const style = { display: active ? "flex" : "none", flexDirection: "column" as const, flex: 1, minHeight: 0, overflowY: "auto" as const, background: "var(--bg)" };
  if (section.ownsTabpanel) {
    return <div className="settings-scroll-column" data-settings-host={section.id} style={style}>{children}</div>;
  }
  return (
    <div role="tabpanel" id={`settings-panel-${section.id}`} aria-labelledby={`settings-tab-${section.id}`} className="settings-scroll-column" data-settings-host={section.id} style={style}>
      {children}
    </div>
  );
}

let levelSeq = 0;

export function SettingsShell({ request, cwd, sessionId, capabilities = ALL_CAPABILITIES, engine = null, platform, sessionModels = null, prefs, callbacks }: SettingsShellProps) {
  const isMobile = useIsMobile();
  const [section, setSection] = useState<SettingsSectionId>(() => {
    const initial = request.section ? resolveSection(request.section, request.sub).id : readLastSection() ?? "general";
    return initial;
  });
  const [sub, setSub] = useState<string | null>(() => (request.section ? resolveSection(request.section, request.sub).sub ?? null : request.sub ?? null));
  const [highlight, setHighlight] = useState<string | null>(request.highlight ?? null);
  const [mobileView, setMobileView] = useState<"root" | "panel">(request.section ? "panel" : "root");
  const [visited, setVisited] = useState<Set<SettingsSectionId>>(() => new Set<SettingsSectionId>(["general"]));
  const [searchQuery, setSearchQuery] = useState("");
  const [levels, setLevels] = useState<MobileSubLevel[]>([]);
  const [confirmClose, setConfirmClose] = useState(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const busy = useMemo(createSettingsBusy, []);
  const appliedSeq = useRef(request.seq);

  const visibleSections = useMemo(() => getVisibleSections(capabilities), [capabilities]);
  const visibleIds = useMemo(() => new Set<SettingsSectionId>(visibleSections.map((entry) => entry.id)), [visibleSections]);

  // The engine's schema backs the dialog-wide search AND the harness label.
  // Gate on the SAME flag that decides whether the Behavior hub renders the
  // schema list; never configEditor, which means "omp, hand-built editors".
  const schema = useSettingsRoute<SchemaRouteBody>("/api/omp-settings/schema", { enabled: capabilities.nativeSettings, ttlMs: 60_000 });
  const harnessLabel = schema.data?.harness?.shortName ?? engine?.shortName ?? DEFAULT_HARNESS_LABEL;

  const applyTarget = useCallback((target: { id: SettingsSectionId; sub?: string }, opts?: { highlight?: string | null; toPanel?: boolean }) => {
    const id = visibleIds.has(target.id) ? target.id : "general";
    setSection(id);
    setSub(target.sub ?? null);
    setHighlight(opts?.highlight ?? null);
    if (opts?.toPanel !== false) setMobileView("panel");
  }, [visibleIds]);

  // A new request (AppShell's openSettings) while the dialog is open.
  useEffect(() => {
    if (appliedSeq.current === request.seq) return;
    appliedSeq.current = request.seq;
    const target = request.section ? resolveSection(request.section, request.sub) : { id: readLastSection() ?? "general", sub: request.sub };
    applyTarget(target, { highlight: request.highlight ?? null, toPanel: Boolean(request.section) });
    if (!request.section) setMobileView("root");
    setSearchQuery("");
  }, [request, applyTarget]);

  // A hub can go out of reach while it is open: the engine switched, or the
  // capability payload landed after the dialog did. Fall back to the one hub
  // every engine has instead of rendering an empty pane.
  useEffect(() => {
    if (!visibleIds.has(section)) setSection("general");
  }, [visibleIds, section]);

  useEffect(() => {
    setVisited((current) => (current.has(section) ? current : new Set([...current, section])));
    writeLastSection(section);
  }, [section]);

  // A highlight is a one-shot scroll target; a later hub change clears it
  // so the outline does not reappear on the way back.
  const selectSection = useCallback((id: SettingsTab, nextSub?: string) => {
    applyTarget(resolveSection(id, nextSub));
  }, [applyTarget]);

  const openSub = useCallback((node: ReactNode, title: string, opts?: { onBack?: () => void }) => {
    const id = `level-${++levelSeq}`;
    setLevels((current) => [...current, { id, title, node, onBack: opts?.onBack }]);
    return id;
  }, []);
  const closeSub = useCallback((id?: string) => {
    setLevels((current) => (id ? current.filter((level) => level.id !== id) : current.slice(0, -1)));
  }, []);

  const requestClose = useCallback(() => {
    if (busy.isBusy()) setConfirmClose(true);
    else callbacks.onClose();
  }, [busy, callbacks]);

  const entries = useMemo<SearchEntry[]>(() => {
    const hubs: SearchEntry[] = visibleSections.map((entry) => ({
      id: `tab-${entry.id}`,
      tab: entry.id,
      label: entry.label,
      description: `${groupLabel(entry.group, harnessLabel)} › ${entry.label}`,
      breadcrumb: [groupLabel(entry.group, harnessLabel)],
      action: "jump",
    }));
    return [...hubs, ...SEARCH_ENTRIES, ...buildSchemaSearchEntries(schema.data, harnessLabel)];
  }, [visibleSections, harnessLabel, schema.data]);
  const trimmedQuery = searchQuery.trim();
  const searchResults = useMemo(() => searchSettings(trimmedQuery, entries, visibleIds, capabilities, harnessLabel), [trimmedQuery, entries, visibleIds, capabilities, harnessLabel]);

  const openSearchResult = useCallback((result: SearchResult) => {
    applyTarget({ id: normalizeSectionId(result.tab), sub: result.sub }, { highlight: result.id.startsWith("tab-") ? null : result.id });
    // Desktop clears the query (the rail comes back); the phone keeps it so
    // Back returns to the same results.
    if (!isMobile) setSearchQuery("");
  }, [applyTarget, isMobile]);

  const shellValue = useMemo<SettingsShellValue>(() => ({
    cwd,
    sessionId,
    engine,
    capabilities,
    platform,
    harnessLabel,
    sessionModels,
    callbacks: { ...callbacks, onClose: requestClose, selectSection },
    prefs,
    isMobile,
    section,
    sub,
    openSub,
    closeSub,
    highlight,
    busy,
    portalTarget,
  }), [cwd, sessionId, engine, capabilities, platform, harnessLabel, sessionModels, callbacks, requestClose, selectSection, prefs, isMobile, section, sub, openSub, closeSub, highlight, busy, portalTarget]);

  const activeSection = visibleSections.find((entry) => entry.id === section) ?? visibleSections[0];
  const activeSubViews = useMemo(() => (activeSection ? getVisibleSubViews(activeSection, capabilities) : []), [activeSection, capabilities]);
  useEffect(() => {
    // A segment the engine cannot serve (pi opened on "mcp") lands on the
    // first one it can.
    if (activeSubViews.length > 0 && !activeSubViews.some((view) => view.id === sub)) setSub(activeSubViews[0].id);
  }, [activeSubViews, sub]);

  const panels = (
    <SettingsHighlightContext.Provider value={highlight}>
      {visibleSections.filter((entry) => visited.has(entry.id)).map((entry) => {
        const Panel = entry.panel;
        return (
          <PanelHost key={entry.id} section={entry} active={entry.id === section}>
            <Panel />
          </PanelHost>
        );
      })}
    </SettingsHighlightContext.Provider>
  );

  const busyGuard = (
    <ConfirmDialog
      open={confirmClose}
      onOpenChange={setConfirmClose}
      title="Leave while work is in progress?"
      description={`${busy.reasons().join(", ") || "Something"} is still running. Closing Settings now interrupts it.`}
      confirmLabel="Leave"
      cancelLabel="Stay"
      danger
      onConfirm={() => {
        setConfirmClose(false);
        callbacks.onClose();
      }}
    />
  );

  if (isMobile) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) requestClose(); }}>
        <DialogContent
          ariaLabel="Settings"
          className="settings-mobile-sheet"
          style={{ top: 0, left: 0, transform: "none", width: "100vw", maxWidth: "100vw", height: "100dvh", maxHeight: "100dvh", borderRadius: 0, border: "none", padding: 0, display: "flex", flexDirection: "column", overflow: "hidden", animation: "settings-sheet-in var(--dur-med) var(--ease-out-warm) both" }}
        >
          <ShellContext.Provider value={shellValue}>
            <div ref={setPortalTarget} className="settings-shell settings-shell-mobile" style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <DialogTitle style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", margin: 0 }}>Settings</DialogTitle>
              <MobileStack
                sections={visibleSections}
                active={activeSection?.id ?? "general"}
                view={mobileView}
                onSelect={(id) => applyTarget({ id })}
                onBack={() => { setMobileView("root"); setHighlight(null); }}
                onClose={requestClose}
                capabilities={capabilities}
                engine={engine}
                harnessLabel={harnessLabel}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                searchResults={searchResults}
                onSearchResult={openSearchResult}
                levels={levels}
              >
                {panels}
              </MobileStack>
            </div>
          </ShellContext.Provider>
          {busyGuard}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) requestClose(); }}>
      <DialogContent ariaLabel="Settings" style={{ width: 940, maxWidth: "calc(100vw - 16px)", height: "82vh", maxHeight: "calc(100dvh - 16px)", padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <ShellContext.Provider value={shellValue}>
          <div ref={setPortalTarget} className="settings-shell" style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "12px 18px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
              <DialogTitle style={{ fontSize: 16, margin: 0, fontWeight: 600 }}>Settings</DialogTitle>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, maxWidth: 360, justifyContent: "flex-end" }}>
                <div style={{ position: "relative", width: "100%", maxWidth: 260 }}>
                  <Search size={13} aria-hidden="true" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
                  <input
                    type="text"
                    aria-label="Search settings"
                    placeholder="Search settings..."
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      // Escape clears a query first (and stops there); with
                      // nothing typed it falls through to the dialog, which
                      // closes on it as before.
                      if (event.key === "Escape" && searchQuery) {
                        event.stopPropagation();
                        setSearchQuery("");
                        setHighlight(null);
                      }
                    }}
                    style={{ width: "100%", height: 28, padding: "0 8px 0 28px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none" }}
                  />
                </div>
                <button type="button" onClick={requestClose} aria-label="Close settings" className="ui-focus-ring" style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, width: 32, height: 32, minWidth: 32, minHeight: 32, display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation" }}>×</button>
              </div>
            </header>
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row", overflow: "hidden" }}>
              {trimmedQuery ? (
                <SearchResultsList results={searchResults} query={trimmedQuery} onSelect={openSearchResult} width={300} />
              ) : (
                <SettingsSidebar sections={visibleSections} active={activeSection?.id ?? "general"} onSelect={(id) => applyTarget({ id })} capabilities={capabilities} engine={engine} harnessLabel={harnessLabel} />
              )}
              <div className="settings-pane" style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
                {panels}
              </div>
            </div>
          </div>
        </ShellContext.Provider>
        {busyGuard}
      </DialogContent>
    </Dialog>
  );
}
