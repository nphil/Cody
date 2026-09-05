"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Plus,
  RefreshCw,
  Store,
  Trash2,
} from "lucide-react";
import type {
  MarketplaceBrowseResponse,
  MarketplaceListEntry,
  MarketplacePluginListing,
  PluginScope,
} from "@/lib/api-types";

/**
 * The plugin marketplace: browse/search every catalog plugin across the
 * user's configured `omp` marketplaces, manage which marketplaces are
 * configured, and install/uninstall/upgrade plugins from them. Modeled on
 * SkillsStore.tsx (search box, split list/detail pane, scope toggle, toast
 * usage) — the marketplace-management strip above the list is the one
 * structural addition, since marketplaces (unlike the skills.sh registry)
 * are a per-instance, user-configured list rather than a fixed directory.
 *
 * Data: GET/POST /api/plugins/marketplace — a pure-Node read of
 * marketplaces.json + each marketplace's cached catalog for browsing,
 * `omp plugin ...` CLI calls for every mutation.
 */

const OFFICIAL_MARKETPLACE = "anthropics/claude-plugins-official";

function pluginId(plugin: Pick<MarketplacePluginListing, "name" | "marketplace">): string {
  return `${plugin.name}@${plugin.marketplace}`;
}

function matchesQuery(plugin: MarketplacePluginListing, query: string): boolean {
  const q = query.toLowerCase();
  if (plugin.name.toLowerCase().includes(q)) return true;
  if (plugin.description?.toLowerCase().includes(q)) return true;
  if (plugin.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
  return false;
}

function MarketplaceRow({
  marketplace,
  busy,
  onUpdate,
  onRemove,
}: {
  marketplace: MarketplaceListEntry;
  busy: "update" | "remove" | null;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: "var(--radius-control)",
        border: "1px solid var(--border)",
        background: "var(--bg)",
        flexShrink: 0,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{marketplace.name}</div>
        <div
          style={{
            fontSize: 10,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
            maxWidth: 220,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={marketplace.sourceUri}
        >
          {marketplace.sourceUri}
        </div>
        {marketplace.catalogMissing && (
          <div style={{ fontSize: 10, color: "var(--status-warning)", marginTop: 2 }}>
            {t("pluginMarket.catalogMissing")}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onUpdate}
        disabled={busy !== null}
        title={t("pluginMarket.updateMarketplace")}
        aria-label={t("pluginMarket.updateMarketplace")}
        className="ui-focus-ring"
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-control)",
          background: "none",
          color: "var(--text-muted)",
          cursor: busy !== null ? "default" : "pointer",
        }}
      >
        <RefreshCw size={12} aria-hidden="true" style={busy === "update" ? { animation: "spin 0.8s linear infinite" } : undefined} />
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={busy !== null}
        title={t("pluginMarket.removeMarketplace")}
        aria-label={t("pluginMarket.removeMarketplace")}
        className="ui-focus-ring"
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-control)",
          background: "none",
          color: "var(--status-error)",
          cursor: busy !== null ? "default" : "pointer",
        }}
      >
        <Trash2 size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

export function PluginMarketplace({
  cwd,
  onChanged,
  onClose,
  embedded = false,
}: {
  cwd: string;
  onChanged?: () => void;
  onClose: () => void;
  /** Render the marketplace's column without its own Dialog: the caller
   * hosts it (Settings › Extensions puts it in a Drawer, which already has a
   * close control and must never stack a second Dialog portal). */
  embedded?: boolean;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();

  const [data, setData] = useState<MarketplaceBrowseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [query, setQuery] = useState("");
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scope, setScope] = useState<PluginScope>("global");

  const [addSource, setAddSource] = useState("");
  const [marketplaceBusy, setMarketplaceBusy] = useState<{ name: string; kind: "update" | "remove" } | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [pluginBusy, setPluginBusy] = useState<{ id: string; kind: "install" | "uninstall" | "upgrade" } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const res = await fetch(`/api/plugins/marketplace?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
        const next = (await res.json()) as MarketplaceBrowseResponse & { error?: string; code?: string };
        if (!res.ok || "error" in next && next.error) {
          setLoadError(formatApiError(next.error ? next : `HTTP ${res.status}`));
          return;
        }
        setData(next);
      } catch (e) {
        if (!controller.signal.aborted) setLoadError(String(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [cwd, reloadNonce]);

  const marketplaces = data?.marketplaces ?? [];
  const allPlugins = useMemo(() => data?.plugins ?? [], [data?.plugins]);

  const filteredPlugins = useMemo(() => {
    const q = query.trim();
    return allPlugins.filter((plugin) => {
      if (marketplaceFilter && plugin.marketplace !== marketplaceFilter) return false;
      if (q && !matchesQuery(plugin, q)) return false;
      return true;
    });
  }, [allPlugins, marketplaceFilter, query]);

  const selected = filteredPlugins.find((plugin) => pluginId(plugin) === selectedId)
    ?? allPlugins.find((plugin) => pluginId(plugin) === selectedId)
    ?? null;

  const applyResponse = useCallback((next: MarketplaceBrowseResponse) => {
    setData(next);
  }, []);

  const runPost = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch("/api/plugins/marketplace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ...body }),
      });
      const next = (await res.json()) as MarketplaceBrowseResponse & { error?: string; code?: string };
      if (!res.ok || next.error) throw new Error(formatApiError(next.error ? next : `HTTP ${res.status}`));
      applyResponse(next);
      onChanged?.();
      return next;
    },
    [applyResponse, cwd, onChanged],
  );

  const addMarketplace = useCallback(
    async (source: string) => {
      const trimmed = source.trim();
      if (!trimmed) return;
      setAddBusy(true);
      try {
        await runPost({ action: "addMarketplace", source: trimmed });
        setAddSource("");
        toast.success(t("pluginMarket.marketplaceAdded"), trimmed);
      } catch (err) {
        toast.error(t("pluginMarket.marketplaceAddFailed"), err instanceof Error ? err.message : String(err));
      } finally {
        setAddBusy(false);
      }
    },
    [runPost, t],
  );

  const updateMarketplace = useCallback(
    async (name: string) => {
      setMarketplaceBusy({ name, kind: "update" });
      try {
        await runPost({ action: "updateMarketplaces", name });
        toast.success(t("pluginMarket.marketplaceUpdated"), name);
      } catch (err) {
        toast.error(t("pluginMarket.marketplaceUpdateFailed"), err instanceof Error ? err.message : String(err));
      } finally {
        setMarketplaceBusy(null);
      }
    },
    [runPost, t],
  );

  const removeMarketplace = useCallback(
    async (name: string) => {
      setMarketplaceBusy({ name, kind: "remove" });
      try {
        await runPost({ action: "removeMarketplace", name });
        if (marketplaceFilter === name) setMarketplaceFilter("");
        toast.success(t("pluginMarket.marketplaceRemoved"), name);
      } catch (err) {
        toast.error(t("pluginMarket.marketplaceRemoveFailed"), err instanceof Error ? err.message : String(err));
      } finally {
        setMarketplaceBusy(null);
      }
    },
    [marketplaceFilter, runPost, t],
  );

  const install = useCallback(
    async (plugin: MarketplacePluginListing) => {
      const id = pluginId(plugin);
      setPluginBusy({ id, kind: "install" });
      try {
        await runPost({ action: "install", name: plugin.name, marketplace: plugin.marketplace, scope });
        toast.success(t("pluginMarket.installSuccess"), plugin.name);
      } catch (err) {
        toast.error(t("pluginMarket.installFailed"), err instanceof Error ? err.message : String(err));
      } finally {
        setPluginBusy(null);
      }
    },
    [runPost, scope, t],
  );

  const uninstall = useCallback(
    async (plugin: MarketplacePluginListing) => {
      const id = pluginId(plugin);
      setPluginBusy({ id, kind: "uninstall" });
      try {
        await runPost({ action: "uninstall", id, scope: plugin.installedScope ?? scope });
        toast.success(t("pluginMarket.uninstallSuccess"), plugin.name);
      } catch (err) {
        toast.error(t("pluginMarket.uninstallFailed"), err instanceof Error ? err.message : String(err));
      } finally {
        setPluginBusy(null);
      }
    },
    [runPost, scope, t],
  );

  const upgrade = useCallback(
    async (plugin: MarketplacePluginListing) => {
      const id = pluginId(plugin);
      setPluginBusy({ id, kind: "upgrade" });
      try {
        await runPost({ action: "upgrade", id });
        toast.success(t("pluginMarket.upgradeSuccess"), plugin.name);
      } catch (err) {
        toast.error(t("pluginMarket.upgradeFailed"), err instanceof Error ? err.message : String(err));
      } finally {
        setPluginBusy(null);
      }
    },
    [runPost, t],
  );

  const showDetailPane = !isMobile || selectedId !== null;
  const showListPane = !isMobile || selectedId === null;

  const column = (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1, minHeight: 0 }}>
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
              {t("pluginMarket.title")}
            </span>
            <div style={{ flex: 1 }} />
            {!embedded && <button
              onClick={onClose}
              aria-label={t("pluginMarket.close")}
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
            </button>}
          </div>

          {/* ── Marketplaces strip ── */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "10px 18px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            {!loading && marketplaces.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                  fontSize: 12,
                  color: "var(--text-muted)",
                }}
              >
                <span>{t("pluginMarket.emptyMarketplaces")}</span>
                <button
                  type="button"
                  onClick={() => void addMarketplace(OFFICIAL_MARKETPLACE)}
                  disabled={addBusy}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "4px 10px",
                    fontSize: 12,
                    borderRadius: "var(--radius-control)",
                    border: "1px solid var(--accent)",
                    background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                    color: "var(--accent-strong)",
                    cursor: addBusy ? "default" : "pointer",
                  }}
                >
                  <Plus size={12} aria-hidden="true" />
                  {t("pluginMarket.addOfficial")}
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2, scrollbarWidth: "none" }}>
                {marketplaces.map((marketplace) => (
                  <MarketplaceRow
                    key={marketplace.name}
                    marketplace={marketplace}
                    busy={marketplaceBusy?.name === marketplace.name ? marketplaceBusy.kind : null}
                    onUpdate={() => void updateMarketplace(marketplace.name)}
                    onRemove={() => setConfirmRemove(marketplace.name)}
                  />
                ))}
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                value={addSource}
                onChange={(e) => setAddSource(e.target.value)}
                placeholder="owner/repo"
                aria-label={t("pluginMarket.addMarketplace")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && addSource.trim() && !addBusy) void addMarketplace(addSource);
                }}
                style={{
                  flex: 1,
                  minWidth: 160,
                  maxWidth: 320,
                  padding: "6px 10px",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: "var(--text)",
                  outline: "none",
                }}
              />
              <button
                type="button"
                onClick={() => void addMarketplace(addSource)}
                disabled={addBusy || !addSource.trim()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "6px 12px",
                  fontSize: 12,
                  fontWeight: 500,
                  borderRadius: "var(--radius-control)",
                  border: "1px solid var(--border)",
                  background: "none",
                  color: "var(--text-muted)",
                  cursor: addBusy || !addSource.trim() ? "default" : "pointer",
                }}
              >
                <Plus size={12} aria-hidden="true" />
                {addBusy ? t("pluginMarket.addingMarketplace") : t("pluginMarket.addMarketplace")}
              </button>
            </div>
          </div>

          {/* ── Search + marketplace filter ── */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 18px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("pluginMarket.searchPlaceholder")}
              aria-label={t("pluginMarket.searchPlaceholder")}
              style={{
                flex: 1,
                padding: "8px 12px",
                fontSize: 13,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text)",
                outline: "none",
              }}
            />
            {marketplaces.length > 1 && (
              <select
                value={marketplaceFilter}
                onChange={(e) => setMarketplaceFilter(e.target.value)}
                aria-label={t("pluginMarket.marketplaceAll")}
                style={{
                  padding: "8px 10px",
                  fontSize: 12,
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: "var(--text)",
                  outline: "none",
                }}
              >
                <option value="">{t("pluginMarket.marketplaceAll")}</option>
                {marketplaces.map((marketplace) => (
                  <option key={marketplace.name} value={marketplace.name}>{marketplace.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* ── Body ── */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            {showListPane && (
              <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", minWidth: 0 }}>
                {loading ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 6 }}>
                    {Array.from({ length: 6 }, (_, i) => (
                      <div key={i} className="skeleton" style={{ height: 62, borderRadius: "var(--radius-card)" }} />
                    ))}
                  </div>
                ) : loadError ? (
                  <div style={{ padding: 24, textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "var(--status-error)", marginBottom: 12 }}>
                      {t("pluginMarket.error")}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 14, wordBreak: "break-word" }}>
                      {loadError}
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
                      {t("pluginMarket.retry")}
                    </button>
                  </div>
                ) : filteredPlugins.length === 0 ? (
                  <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "var(--text-dim)" }}>
                    {query
                      ? t("pluginMarket.emptySearch", { query })
                      : t("pluginMarket.emptyBrowse")}
                  </div>
                ) : (
                  filteredPlugins.map((plugin) => {
                    const id = pluginId(plugin);
                    const active = id === selectedId;
                    return (
                      <div
                        key={id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedId(id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(id);
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
                        }}
                        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "none"; }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{plugin.name}</span>
                            {plugin.version && (
                              <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                                v{plugin.version}
                              </span>
                            )}
                            {marketplaces.length > 1 && (
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: "1px 5px",
                                  borderRadius: 3,
                                  background: "color-mix(in srgb, var(--text-dim) 12%, transparent)",
                                  color: "var(--text-dim)",
                                }}
                              >
                                {plugin.marketplace}
                              </span>
                            )}
                            {plugin.category && (
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: "1px 5px",
                                  borderRadius: 3,
                                  background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                                  color: "var(--accent-strong)",
                                }}
                              >
                                {plugin.category}
                              </span>
                            )}
                            {plugin.installed && (
                              <Check size={12} aria-hidden="true" style={{ color: "var(--status-success)" }} />
                            )}
                          </div>
                          {plugin.description && (
                            <div
                              style={{
                                fontSize: 12,
                                color: "var(--text-muted)",
                                display: "-webkit-box",
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical",
                                overflow: "hidden",
                              }}
                            >
                              {plugin.description}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!plugin.installed && pluginBusy === null) void install(plugin);
                          }}
                          disabled={plugin.installed || pluginBusy !== null}
                          style={{
                            flexShrink: 0,
                            padding: "5px 14px",
                            fontSize: 12,
                            fontWeight: 500,
                            borderRadius: "var(--radius-control)",
                            border: plugin.installed ? "1px solid transparent" : "1px solid var(--border)",
                            cursor: plugin.installed || pluginBusy !== null ? "default" : "pointer",
                            background: plugin.installed
                              ? "color-mix(in srgb, var(--status-success) 10%, transparent)"
                              : "none",
                            color: plugin.installed
                              ? "var(--status-success)"
                              : pluginBusy?.id === id
                                ? "var(--accent)"
                                : "var(--text-muted)",
                          }}
                        >
                          {plugin.installed
                            ? t("pluginMarket.installed")
                            : pluginBusy?.id === id && pluginBusy.kind === "install"
                              ? t("pluginMarket.installing")
                              : t("pluginMarket.install")}
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
                  width: isMobile ? "100%" : 380,
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
                    {t("pluginMarket.back")}
                  </button>
                )}
                {!selected ? (
                  <div style={{ margin: "auto", fontSize: 13, color: "var(--text-dim)", textAlign: "center" }}>
                    {t("pluginMarket.detailHint")}
                  </div>
                ) : (
                  <>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
                        {selected.name}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{selected.marketplace}</span>
                        {selected.homepage && (
                          <a
                            href={selected.homepage}
                            target="_blank"
                            rel="noreferrer"
                            style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "var(--accent)", textDecoration: "none" }}
                          >
                            {t("pluginMarket.homepage")}
                            <ExternalLink size={10} aria-hidden="true" />
                          </a>
                        )}
                        {selected.repository && (
                          <a
                            href={selected.repository}
                            target="_blank"
                            rel="noreferrer"
                            style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "var(--accent)", textDecoration: "none" }}
                          >
                            {t("pluginMarket.repository")}
                            <ExternalLink size={10} aria-hidden="true" />
                          </a>
                        )}
                      </div>
                    </div>

                    {selected.description && (
                      <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.55 }}>
                        {selected.description}
                      </div>
                    )}

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(70px, 100px) minmax(0, 1fr)",
                        gap: "6px 10px",
                        fontSize: 12,
                        lineHeight: 1.45,
                      }}
                    >
                      {selected.version && (
                        <>
                          <div style={{ color: "var(--text-dim)" }}>{t("pluginMarket.version")}</div>
                          <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{selected.version}</div>
                        </>
                      )}
                      {selected.author && (
                        <>
                          <div style={{ color: "var(--text-dim)" }}>{t("pluginMarket.author")}</div>
                          <div style={{ color: "var(--text-muted)" }}>{selected.author}</div>
                        </>
                      )}
                      {selected.license && (
                        <>
                          <div style={{ color: "var(--text-dim)" }}>{t("pluginMarket.license")}</div>
                          <div style={{ color: "var(--text-muted)" }}>{selected.license}</div>
                        </>
                      )}
                      {selected.category && (
                        <>
                          <div style={{ color: "var(--text-dim)" }}>{t("pluginMarket.category")}</div>
                          <div style={{ color: "var(--text-muted)" }}>{selected.category}</div>
                        </>
                      )}
                      {selected.keywords && selected.keywords.length > 0 && (
                        <>
                          <div style={{ color: "var(--text-dim)" }}>{t("pluginMarket.keywords")}</div>
                          <div style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}>{selected.keywords.join(", ")}</div>
                        </>
                      )}
                    </div>

                    {/* Scope + install/uninstall/upgrade */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {!selected.installed && (
                        <div
                          style={{
                            display: "flex",
                            borderRadius: "var(--radius-control)",
                            border: "1px solid var(--border)",
                            overflow: "hidden",
                            fontSize: 12,
                            alignSelf: "flex-start",
                          }}
                        >
                          {(["global", "project"] as const).map((s) => (
                            <button
                              key={s}
                              onClick={() => setScope(s)}
                              style={{
                                padding: "4px 12px",
                                border: "none",
                                cursor: "pointer",
                                background: scope === s ? "var(--bg-selected)" : "none",
                                color: scope === s ? "var(--accent)" : "var(--text-dim)",
                                fontWeight: scope === s ? 600 : 400,
                              }}
                            >
                              {t(s === "global" ? "pluginMarket.scopeGlobal" : "pluginMarket.scopeProject")}
                            </button>
                          ))}
                        </div>
                      )}

                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {!selected.installed ? (
                          <button
                            onClick={() => { if (pluginBusy === null) void install(selected); }}
                            disabled={pluginBusy !== null}
                            style={{
                              flex: 1,
                              padding: "6px 14px",
                              fontSize: 12,
                              fontWeight: 600,
                              borderRadius: "var(--radius-control)",
                              border: "none",
                              cursor: pluginBusy !== null ? "default" : "pointer",
                              background: "var(--accent)",
                              color: "var(--on-accent)",
                            }}
                          >
                            {pluginBusy?.id === pluginId(selected) && pluginBusy.kind === "install"
                              ? t("pluginMarket.installing")
                              : t("pluginMarket.install")}
                          </button>
                        ) : (
                          <>
                            {selected.updateAvailable && (
                              <button
                                onClick={() => { if (pluginBusy === null) void upgrade(selected); }}
                                disabled={pluginBusy !== null}
                                style={{
                                  padding: "6px 14px",
                                  fontSize: 12,
                                  fontWeight: 600,
                                  borderRadius: "var(--radius-control)",
                                  border: "1px solid var(--accent)",
                                  cursor: pluginBusy !== null ? "default" : "pointer",
                                  background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                                  color: "var(--accent-strong)",
                                }}
                              >
                                {pluginBusy?.id === pluginId(selected) && pluginBusy.kind === "upgrade"
                                  ? t("pluginMarket.upgrading")
                                  : t("pluginMarket.upgrade")}
                              </button>
                            )}
                            <button
                              onClick={() => { if (pluginBusy === null) void uninstall(selected); }}
                              disabled={pluginBusy !== null}
                              style={{
                                padding: "6px 14px",
                                fontSize: 12,
                                fontWeight: 500,
                                borderRadius: "var(--radius-control)",
                                border: "1px solid var(--border)",
                                cursor: pluginBusy !== null ? "default" : "pointer",
                                background: "none",
                                color: "var(--status-error)",
                              }}
                            >
                              {pluginBusy?.id === pluginId(selected) && pluginBusy.kind === "uninstall"
                                ? t("pluginMarket.uninstalling")
                                : t("pluginMarket.uninstall")}
                            </button>
                          </>
                        )}
                      </div>

                      {selected.installed && (
                        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                          {selected.installedVersion && `v${selected.installedVersion} · `}
                          {t(selected.installedScope === "project" ? "pluginMarket.scopeProject" : "pluginMarket.scopeGlobal")}
                          {selected.updateAvailable ? ` · ${t("pluginMarket.updateAvailable")}` : ` · ${t("pluginMarket.upToDate")}`}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
  );
  const confirm = (
        <ConfirmDialog
          open={confirmRemove !== null}
          onOpenChange={(open) => { if (!open) setConfirmRemove(null); }}
          title={t("pluginMarket.removeMarketplaceTitle")}
          description={confirmRemove ? t("pluginMarket.removeMarketplaceBody", { name: confirmRemove }) : ""}
          confirmLabel={t("pluginMarket.removeMarketplace")}
          cancelLabel={t("pluginMarket.cancel")}
          danger
          onConfirm={() => {
            const name = confirmRemove;
            setConfirmRemove(null);
            if (name) void removeMarketplace(name);
          }}
        />
  );
  if (embedded) return <>{column}{confirm}</>;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        ariaLabel={t("pluginMarket.title")}
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 1060,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "84vh",
          maxHeight: "calc(100dvh - 16px)",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {column}
        {confirm}
      </DialogContent>
    </Dialog>
  );
}
