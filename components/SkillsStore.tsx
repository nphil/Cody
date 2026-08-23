"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  ArrowLeft,
  ExternalLink,
  Search,
  Sparkles,
  Store,
} from "lucide-react";
import type { RegistrySkill, SkillStoreDetail } from "@/lib/skills-registry";
import type { SkillInstallScope } from "@/lib/api-types";

/**
 * The skill store: browse/search the skills.sh registry (the directory
 * `npx skills` installs from) and install into the same global/project scopes
 * as the rest of the Skills settings surface.
 *
 * List data comes from GET /api/skills/store (category browse or registry
 * search — multi-word queries run semantic search over skill descriptions
 * upstream). Card descriptions are enriched lazily via POST for the visible
 * page only, and a card's detail pane reuses the same server-side cache.
 */

const BROWSE_CATEGORY_IDS = [
  "popular",
  "frontend",
  "backend",
  "database",
  "testing",
  "devops",
  "review",
  "docs",
  "mobile",
] as const;

const SEARCH_DEBOUNCE_MS = 250;
const DESCRIPTION_PAGE = 24;

interface StoreListResponse {
  items?: RegistrySkill[];
  searchType?: string;
  error?: string;
  code?: string;
}

function installsBadge(skill: RegistrySkill, label: string): string {
  return skill.installsLabel ? `${skill.installsLabel} ${label}` : "";
}

export function SkillsStore({
  cwd,
  scopes,
  installedPackages,
  onInstalled,
  onClose,
}: {
  cwd: string;
  /** Scopes the ACTIVE engine can actually install into, from GET /api/skills.
   * Hermes has one skills root per home and no project-scoped dir at all, so
   * offering "project" there would install globally under a project label. */
  scopes: readonly SkillInstallScope[];
  installedPackages: Record<SkillInstallScope, ReadonlySet<string>>;
  onInstalled: () => void;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();

  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [category, setCategory] = useState<string>("popular");
  const [items, setItems] = useState<RegistrySkill[]>([]);
  const [searchType, setSearchType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillStoreDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedScope, setScope] = useState<SkillInstallScope>(scopes[0] ?? "global");
  // The scope list can narrow after mount — the System card opens the store
  // and refreshes the scan in parallel — so a selection the engine no longer
  // offers must never reach an install request.
  const scope = scopes.includes(selectedScope) ? selectedScope : (scopes[0] ?? "global");
  const [installing, setInstalling] = useState<string | null>(null);
  const [installedNow, setInstalledNow] = useState<Set<string>>(new Set());
  const [reloadNonce, setReloadNonce] = useState(0);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = items.find((skill) => skill.id === selectedId) ?? null;

  // ── data: list ─────────────────────────────────────────────────────────
  useEffect(() => {
    const handle = setTimeout(() => setActiveQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (activeQuery.length >= 2) params.set("q", activeQuery);
    else if (category !== "popular") params.set("category", category);

    setLoading(true);
    setListError(null);
    (async () => {
      try {
        const res = await fetch(`/api/skills/store?${params}`, { signal: controller.signal });
        const data = (await res.json()) as StoreListResponse;
        if (!res.ok || data.error) {
          setListError(formatApiError(data.error ? data : `HTTP ${res.status}`));
          setItems([]);
          return;
        }
        setItems(data.items ?? []);
        setSearchType(activeQuery.length >= 2 ? (data.searchType ?? null) : null);
        listRef.current?.scrollTo({ top: 0 });
      } catch (e) {
        if (!controller.signal.aborted) {
          setListError(String(e));
          setItems([]);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [activeQuery, category, reloadNonce]);

  // ── data: card descriptions (visible page only, server-bounded) ────────
  useEffect(() => {
    const missing = items
      .slice(0, DESCRIPTION_PAGE)
      .map((skill) => skill.id)
      .filter((id) => descriptions[id] === undefined);
    if (missing.length === 0) return;

    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/skills/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: missing }),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { descriptions?: Record<string, string> };
        const found = data.descriptions ?? {};
        setDescriptions((prev) => {
          const next = { ...prev };
          // Cache misses as "" so a skill with no description is not re-asked.
          for (const id of missing) next[id] = found[id] ?? "";
          return next;
        });
      } catch {
        // Enrichment is cosmetic; cards stay description-less on failure.
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // ── data: detail pane ──────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setDetailLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/skills/store?detail=${encodeURIComponent(selectedId)}`,
          { signal: controller.signal },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { detail?: SkillStoreDetail | null };
        setDetail(data.detail ?? null);
      } catch {
        // The detail pane falls back to list-level facts.
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selectedId]);

  // ── install ────────────────────────────────────────────────────────────
  const install = useCallback(
    async (skill: RegistrySkill) => {
      setInstalling(skill.id);
      try {
        const res = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: skill.package, scope, cwd }),
        });
        const data = (await res.json()) as { success?: boolean; error?: string; code?: string };
        if (!res.ok || data.error) {
          toast.error(t("skillsConfig.store.installFailed"), formatApiError(data.error ? data : `HTTP ${res.status}`));
          return;
        }
        setInstalledNow((prev) => new Set(prev).add(`${scope}:${skill.package}`));
        toast.success(t("skillsConfig.store.installSuccess"), skill.name);
        onInstalled();
      } catch (e) {
        toast.error(t("skillsConfig.store.installFailed"), String(e));
      } finally {
        setInstalling(null);
      }
    },
    [cwd, onInstalled, scope, t],
  );

  const isInstalled = useCallback(
    (skill: RegistrySkill) =>
      installedPackages[scope].has(skill.package) ||
      installedNow.has(`${scope}:${skill.package}`),
    [installedPackages, installedNow, scope],
  );

  // ── keyboard: "/" focuses search, arrows move selection ────────────────
  const onDialogKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const inSearch = e.target === searchRef.current;
      if (e.key === "/" && !inSearch) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (items.length === 0) return;
      e.preventDefault();
      const index = items.findIndex((skill) => skill.id === selectedId);
      const next = e.key === "ArrowDown"
        ? Math.min(items.length - 1, index + 1)
        : Math.max(0, index <= 0 ? 0 : index - 1);
      setSelectedId(items[next].id);
    },
    [items, selectedId],
  );

  const showDetailPane = !isMobile || selectedId !== null;
  const showListPane = !isMobile || selectedId === null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        ariaLabel={t("skillsConfig.store.title")}
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 1040,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "84vh",
          maxHeight: "calc(100dvh - 16px)",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{ display: "flex", flexDirection: "column", height: "100%" }}
          onKeyDown={onDialogKeyDown}
        >
          {/* ── Header ── */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 18px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <Store size={17} aria-hidden="true" style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              {t("skillsConfig.store.title")}
            </span>
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 11, color: "var(--text-dim)", textDecoration: "none" }}
            >
              {t("skillsConfig.store.poweredBy")}
            </a>
            <div style={{ flex: 1 }} />
            <button
              onClick={onClose}
              aria-label={t("skillsConfig.close")}
              className="ui-focus-ring"
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                width: 32,
                height: 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ×
            </button>
          </div>

          {/* ── Search + categories ── */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: "12px 18px 10px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <Search
                size={14}
                aria-hidden="true"
                style={{ position: "absolute", left: 11, color: "var(--text-dim)", pointerEvents: "none" }}
              />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("skillsConfig.store.searchPlaceholder")}
                aria-label={t("skillsConfig.store.searchPlaceholder")}
                style={{
                  flex: 1,
                  padding: "8px 12px 8px 32px",
                  fontSize: 13,
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: "var(--text)",
                  outline: "none",
                }}
              />
              {searchType === "semantic" && (
                <span
                  style={{
                    position: "absolute",
                    right: 10,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--accent)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    pointerEvents: "none",
                  }}
                >
                  <Sparkles size={11} aria-hidden="true" />
                  {t("skillsConfig.store.semanticBadge")}
                </span>
              )}
            </div>

            <div
              style={{
                display: "flex",
                gap: 6,
                overflowX: "auto",
                paddingBottom: 2,
                scrollbarWidth: "none",
              }}
            >
              {BROWSE_CATEGORY_IDS.map((id) => {
                const active = activeQuery.length < 2 && category === id;
                return (
                  <button
                    key={id}
                    onClick={() => {
                      setQuery("");
                      setActiveQuery("");
                      setCategory(id);
                    }}
                    style={{
                      flexShrink: 0,
                      padding: "4px 12px",
                      fontSize: 12,
                      fontWeight: active ? 600 : 400,
                      borderRadius: 999,
                      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                      background: active
                        ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                        : "none",
                      color: active ? "var(--accent-strong)" : "var(--text-muted)",
                      cursor: "pointer",
                      transition: "color var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)",
                    }}
                  >
                    {t(`skillsConfig.store.category.${id}`)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Body ── */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            {/* Results list */}
            {showListPane && (
              <div
                ref={listRef}
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "10px 12px",
                  minWidth: 0,
                }}
              >
                {loading ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 6 }}>
                    {Array.from({ length: 8 }, (_, i) => (
                      <div key={i} className="skeleton" style={{ height: 64, borderRadius: "var(--radius-card)" }} />
                    ))}
                  </div>
                ) : listError ? (
                  <div style={{ padding: 24, textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "var(--status-error)", marginBottom: 12 }}>
                      {t("skillsConfig.store.error")}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 14, wordBreak: "break-word" }}>
                      {listError}
                    </div>
                    <button
                      onClick={() => setReloadNonce((n) => n + 1)}
                      style={{
                        padding: "6px 16px",
                        fontSize: 12,
                        borderRadius: "var(--radius-control)",
                        border: "1px solid var(--border)",
                        background: "none",
                        color: "var(--text)",
                        cursor: "pointer",
                      }}
                    >
                      {t("skillsConfig.store.retry")}
                    </button>
                  </div>
                ) : items.length === 0 ? (
                  <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "var(--text-dim)" }}>
                    {activeQuery
                      ? t("skillsConfig.store.emptySearch", { query: activeQuery })
                      : t("skillsConfig.store.emptyBrowse")}
                  </div>
                ) : (
                  items.map((skill) => {
                    const active = skill.id === selectedId;
                    const installed = isInstalled(skill);
                    const description = descriptions[skill.id];
                    return (
                      <div
                        key={skill.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedId(skill.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(skill.id);
                          }
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "10px 12px",
                          marginBottom: 4,
                          borderRadius: "var(--radius-card)",
                          border: `1px solid ${active ? "var(--accent)" : "transparent"}`,
                          background: active ? "var(--bg-selected)" : "none",
                          cursor: "pointer",
                          transition: "background var(--dur-fast) var(--ease-out-warm)",
                        }}
                        onMouseEnter={(e) => {
                          if (!active) e.currentTarget.style.background = "var(--bg-hover)";
                        }}
                        onMouseLeave={(e) => {
                          if (!active) e.currentTarget.style.background = "none";
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "var(--text)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {skill.name}
                            </span>
                            {installsBadge(skill, t("skillsConfig.store.installs")) && (
                              <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 500, color: "var(--accent-strong)" }}>
                                {installsBadge(skill, t("skillsConfig.store.installs"))}
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 11,
                              color: "var(--text-dim)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {skill.source}
                          </div>
                          {description === undefined ? (
                            <div className="skeleton" style={{ height: 10, width: "70%", marginTop: 5, borderRadius: 4 }} />
                          ) : description ? (
                            <div
                              style={{
                                fontSize: 12,
                                color: "var(--text-muted)",
                                marginTop: 3,
                                display: "-webkit-box",
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical",
                                overflow: "hidden",
                              }}
                            >
                              {description}
                            </div>
                          ) : null}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!installed && installing === null) void install(skill);
                          }}
                          disabled={installed || installing !== null}
                          style={{
                            flexShrink: 0,
                            padding: "5px 14px",
                            fontSize: 12,
                            fontWeight: 500,
                            borderRadius: "var(--radius-control)",
                            border: installed ? "1px solid transparent" : "1px solid var(--border)",
                            cursor: installed || installing !== null ? "default" : "pointer",
                            background: installed
                              ? "color-mix(in srgb, var(--status-success) 10%, transparent)"
                              : "none",
                            color: installed
                              ? "var(--status-success)"
                              : installing === skill.id
                                ? "var(--accent)"
                                : "var(--text-muted)",
                            transition: "color var(--dur-fast) var(--ease-out-warm)",
                          }}
                        >
                          {installed
                            ? t("skillsConfig.installed")
                            : installing === skill.id
                              ? t("skillsConfig.installing")
                              : t("skillsConfig.install")}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Detail pane */}
            {showDetailPane && (
              <div
                style={{
                  width: isMobile ? "100%" : 400,
                  flexShrink: 0,
                  borderLeft: isMobile ? "none" : "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  overflowY: "auto",
                  padding: 18,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                {isMobile && selectedId && (
                  <button
                    onClick={() => setSelectedId(null)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      alignSelf: "flex-start",
                      padding: "4px 8px",
                      fontSize: 12,
                      background: "none",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    <ArrowLeft size={13} aria-hidden="true" />
                    {t("skillsConfig.store.back")}
                  </button>
                )}
                {!selected ? (
                  <div style={{ margin: "auto", fontSize: 13, color: "var(--text-dim)", textAlign: "center" }}>
                    {t("skillsConfig.store.detailHint")}
                  </div>
                ) : (
                  <>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
                        {detail?.name || selected.name}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
                          {selected.source}
                        </span>
                        {installsBadge(selected, t("skillsConfig.store.installs")) && (
                          <span style={{ fontSize: 11, fontWeight: 500, color: "var(--accent-strong)" }}>
                            {installsBadge(selected, t("skillsConfig.store.installs"))}
                          </span>
                        )}
                        <a
                          href={selected.url}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 3,
                            fontSize: 11,
                            color: "var(--accent)",
                            textDecoration: "none",
                          }}
                        >
                          skills.sh
                          <ExternalLink size={10} aria-hidden="true" />
                        </a>
                      </div>
                    </div>

                    {/* Scope + install */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {/* One scope is not a choice: an engine with a single
                          skills root (Hermes) gets no selector at all. */}
                      {scopes.length > 1 && (
                        <div
                          style={{
                            display: "flex",
                            borderRadius: "var(--radius-control)",
                            border: "1px solid var(--border)",
                            overflow: "hidden",
                            fontSize: 12,
                            flexShrink: 0,
                          }}
                        >
                          {scopes.map((option) => (
                            <button
                              key={option}
                              onClick={() => setScope(option)}
                              style={{
                                padding: "4px 12px",
                                border: "none",
                                cursor: "pointer",
                                background: scope === option ? "var(--bg-selected)" : "none",
                                color: scope === option ? "var(--accent)" : "var(--text-dim)",
                                fontWeight: scope === option ? 600 : 400,
                              }}
                            >
                              {t(option === "global" ? "skillsConfig.scopeGlobal" : "skillsConfig.scopeProject")}
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        onClick={() => {
                          if (!isInstalled(selected) && installing === null) void install(selected);
                        }}
                        disabled={isInstalled(selected) || installing !== null}
                        style={{
                          flex: 1,
                          padding: "6px 14px",
                          fontSize: 12,
                          fontWeight: 600,
                          borderRadius: "var(--radius-control)",
                          border: "none",
                          cursor: isInstalled(selected) || installing !== null ? "default" : "pointer",
                          background: isInstalled(selected)
                            ? "color-mix(in srgb, var(--status-success) 10%, transparent)"
                            : "var(--accent)",
                          color: isInstalled(selected) ? "var(--status-success)" : "var(--on-accent)",
                        }}
                      >
                        {isInstalled(selected)
                          ? t("skillsConfig.installed")
                          : installing === selected.id
                            ? t("skillsConfig.installing")
                            : t("skillsConfig.install")}
                      </button>
                    </div>

                    {selected.sourceType === "well-known" && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          padding: "8px 10px",
                          borderRadius: "var(--radius-control)",
                          background: "var(--bg-subtle)",
                          lineHeight: 1.5,
                        }}
                      >
                        {t("skillsConfig.store.wellKnownNote", { source: selected.source })}
                      </div>
                    )}

                    {detailLoading ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div className="skeleton" style={{ height: 12, width: "90%" }} />
                        <div className="skeleton" style={{ height: 12, width: "75%" }} />
                        <div className="skeleton" style={{ height: 120, width: "100%", borderRadius: "var(--radius-card)" }} />
                      </div>
                    ) : (
                      <>
                        {(detail?.description || descriptions[selected.id]) && (
                          <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.55 }}>
                            {detail?.description || descriptions[selected.id]}
                          </div>
                        )}
                        {detail?.readme && (
                          <div
                            style={{
                              borderTop: "1px solid var(--border)",
                              paddingTop: 12,
                              fontSize: 13,
                            }}
                          >
                            <MarkdownBody>{detail.readme}</MarkdownBody>
                            {detail.readmeTruncated && (
                              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
                                {t("skillsConfig.store.readmeTruncated")}
                              </div>
                            )}
                          </div>
                        )}
                        {detail && detail.files.length > 0 && (
                          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                            {t("skillsConfig.store.fileCount", { count: detail.files.length })}
                          </div>
                        )}
                        {!detail?.readme && !detail?.description && !descriptions[selected.id] && (
                          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                            {t("skillsConfig.store.noDescription")}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
