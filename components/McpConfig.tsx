"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { fetchSettingsRoute, useSettingsRoute } from "@/hooks/useSettingsData";
import { Directory, type DirectoryRow, type DirectorySection, type DirectoryStatus } from "./settings/Directory";
import { Drawer } from "./settings/Drawer";
import { smallButtonStyle, primaryButtonStyle, dangerButtonStyle } from "./settings/account-controls";
import { chipStyle, nativeInputStyle, SettingsHighlightContext } from "./settings/primitives";

/**
 * Settings › Extensions › MCP: every MCP server the active engine loads, on
 * the shared `Directory` primitive — one section per source the engine
 * reports (user level, project level, discovered; live status when a
 * session is open) and, with a workspace, the project's own `mcp.json`
 * whose rows open a server form in a `Drawer` (Check / Save / Remove).
 *
 * The user-level list renders without a workspace: a user-level server is
 * exactly what is configurable without a project. The header discloses the
 * user-level path once — a containerised install relocates the agent dir,
 * so the obvious `~/.omp/mcp.json` is read by nothing.
 */

type McpServer = { name: string; config: Record<string, unknown> };
// User-level servers arrive as a sanitized DTO (no raw config — env/headers
// can hold credentials and are never serialized); summary fields are computed
// server-side from the config.
type McpUserConfig = { path: string; servers: Array<{ name: string; status: string; type: string; enabled: boolean; valid: boolean }>; disabledServers: string[]; error?: string };
type McpLiveStatus = "connected" | "connecting" | "not_connected" | "inactive" | "disabled" | "configured";
type McpLiveServer = { name: string; source: string; status: McpLiveStatus; type?: string };

export interface McpRouteBody {
  servers?: McpServer[];
  user?: McpUserConfig;
  inventory?: McpLiveServer[];
  liveServers?: McpLiveServer[];
  liveError?: string;
  path?: string | null;
  error?: string;
}

/** The cache key `useSettingsRoute` reads the MCP inventory under. The
 * search hook uses the cwd-only variant: a `sessionId` makes the route ask
 * the live session, which is not a cached read. */
export function mcpRoute(cwd: string | null, sessionId?: string | null): string {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  if (sessionId) params.set("sessionId", sessionId);
  const query = params.toString();
  return query ? `/api/mcp?${query}` : "/api/mcp";
}

/** Every server the inventory lists, for the dialog-wide search. */
export function mcpInventoryOf(body: McpRouteBody | null | undefined): McpLiveServer[] {
  return body?.liveServers ?? body?.inventory ?? [];
}

const inputStyle = { ...nativeInputStyle, width: "100%", boxSizing: "border-box" as const, font: "12px var(--font-mono)" } as const;

const newServer = () => JSON.stringify({ type: "stdio", command: "", args: [] }, null, 2);

export function serverSummary(config: Record<string, unknown>): { type: string; target: string; enabled: boolean; valid: boolean } {
  const type = typeof config.type === "string" && config.type !== "stdio" ? config.type : "stdio";
  const command = typeof config.command === "string" ? config.command.trim() : "";
  const url = typeof config.url === "string" ? config.url.trim() : "";
  const hasCommand = command.length > 0;
  const hasUrl = url.length > 0;
  const valid = (hasCommand || hasUrl) && !(hasCommand && hasUrl) && (type === "http" || type === "sse" ? hasUrl : hasCommand);
  return {
    type,
    target: type === "http" || type === "sse" ? url : `${command}${Array.isArray(config.args) ? " " + config.args.join(" ") : ""}`.trim(),
    enabled: config.enabled !== false,
    valid,
  };
}

function liveStatus(status: McpLiveStatus): DirectoryStatus {
  const text = status.replace("_", " ");
  if (status === "connected") return { tone: "ok", text };
  if (status === "disabled" || status === "inactive") return { tone: "muted", text };
  return { tone: "muted", text };
}

/** A row title that answers the search highlight (`mcp-<name>`): the row
 * itself belongs to Directory, so the anchor rides on its title. */
function ServerTitle({ name }: { name: string }) {
  const highlightId = useContext(SettingsHighlightContext);
  const ref = useRef<HTMLSpanElement | null>(null);
  const highlighted = highlightId === `mcp-${name}`;
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);
  return (
    <span ref={ref} data-search-id={`mcp-${name}`} style={{ fontFamily: "var(--font-mono)", ...(highlighted ? { color: "var(--accent)" } : {}) }}>{name}</span>
  );
}

/** A section wrapper that answers the search highlight for the list itself. */
function SearchSection({ id, children }: { id: string; children: React.ReactNode }) {
  const highlightId = useContext(SettingsHighlightContext);
  const ref = useRef<HTMLDivElement | null>(null);
  const highlighted = highlightId === id;
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);
  return (
    <div ref={ref} data-search-id={id} style={{ borderRadius: "var(--radius-card)", transition: "box-shadow var(--dur-fast)", ...(highlighted ? { boxShadow: "0 0 0 2px var(--accent)" } : {}) }}>
      {children}
    </div>
  );
}

interface ServerForm {
  /** The name the server had when the form opened; null for a new one. */
  previousName: string | null;
  name: string;
  source: string;
}

export function McpConfig({ cwd, sessionId, initial }: {
  cwd: string | null;
  sessionId?: string | null;
  /** A body to paint until the cache answers (a caller holding a prefetch;
   * the fixture test). */
  initial?: McpRouteBody | null;
}) {
  const route = mcpRoute(cwd, sessionId);
  const { data, error, loading: fetching } = useSettingsRoute<McpRouteBody>(route);
  const body = (data && !data.error ? data : null) ?? initial ?? null;
  const loadError = data?.error ?? error;
  const loading = !body && !loadError;
  const [form, setForm] = useState<ServerForm | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (loadError) toast.error("Could not load MCP configuration", loadError);
  }, [loadError]);

  const reload = useCallback(() => fetchSettingsRoute<McpRouteBody>(route, { force: true }), [route]);
  // Stable: the Drawer registers a phone level in an effect keyed on its
  // onClose, so an inline arrow here would re-register on every render.
  const closeForm = useCallback(() => { setForm(null); setMessage(null); }, []);

  const servers = useMemo(() => body?.servers ?? [], [body]);
  const userConfig = body?.user ?? null;
  const displayed = useMemo(() => body ? mcpInventoryOf(body) : null, [body]);

  const openEditor = (server: McpServer | null) => {
    setMessage(null);
    setForm(server
      ? { previousName: server.name, name: server.name, source: JSON.stringify(server.config, null, 2) }
      : { previousName: null, name: "", source: newServer() });
  };

  const parse = (source: string): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(source) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Server configuration must be a JSON object");
      return value as Record<string, unknown>;
    } catch (parseError) {
      setMessage(parseError instanceof Error ? parseError.message : "Invalid JSON");
      return null;
    }
  };

  const check = async () => {
    if (!form) return;
    const server = parse(form.source);
    if (!server) return;
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, server }) });
      const result = (await response.json()) as { message?: string; error?: string };
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
      setMessage(result.message ?? "MCP server configuration is valid");
      toast.success("MCP server configuration is valid");
    } catch (checkError) {
      const detail = checkError instanceof Error ? checkError.message : String(checkError);
      setMessage(detail);
      toast.error("MCP configuration is invalid", detail);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!form) return;
    const server = parse(form.source);
    if (!server) return;
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, name: form.name, previousName: form.previousName ?? undefined, server }) });
      const result = (await response.json()) as { error?: string };
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
      toast.success(`MCP server "${form.name}" saved`, "Restart agent sessions or run /mcp reload to apply it.");
      setForm(null);
      await reload();
    } catch (saveError) {
      const detail = saveError instanceof Error ? saveError.message : String(saveError);
      setMessage(detail);
      toast.error("Could not save MCP server", detail);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, name }) });
      const result = (await response.json()) as { error?: string };
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
      toast.success(`MCP server "${name}" removed`, "Restart agent sessions or run /mcp reload to apply it.");
      setConfirmRemove(null);
      setForm(null);
      await reload();
    } catch (removeError) {
      const detail = removeError instanceof Error ? removeError.message : String(removeError);
      toast.error("Could not remove MCP server", detail);
    } finally {
      setSaving(false);
    }
  };

  // One section per source the engine reports (live status when a session
  // answered, the static inventory otherwise); without either, the
  // user-level file's own rows.
  const configuredSections: DirectorySection[] = useMemo(() => {
    if (displayed) {
      const sources = Array.from(new Set(displayed.map((server) => server.source)));
      const sections = sources.map((sourceName) => ({
        id: `source-${sourceName}`,
        title: sourceName,
        rows: displayed.filter((server) => server.source === sourceName).map((server): DirectoryRow => ({
          id: `${sourceName}:${server.name}`,
          title: <ServerTitle name={server.name} />,
          status: liveStatus(server.status),
          trailing: server.type ? <span style={chipStyle}>{server.type}</span> : undefined,
        })),
      }));
      return sections.length > 0 ? sections : [{ id: "configured-empty", rows: [], empty: loading ? "Loading…" : "No MCP servers configured" }];
    }
    const rows: DirectoryRow[] = [
      ...(userConfig?.servers ?? []).map((server): DirectoryRow => ({
        id: `user:${server.name}`,
        title: <ServerTitle name={server.name} />,
        status: server.valid ? (server.enabled ? { tone: "ok", text: "enabled" } : { tone: "muted", text: "disabled" }) : { tone: "warn", text: "invalid" },
        trailing: <span style={chipStyle}>{server.type}</span>,
      })),
      ...(userConfig?.disabledServers ?? []).map((name): DirectoryRow => ({
        id: `disabled:${name}`,
        title: <ServerTitle name={name} />,
        status: { tone: "muted", text: "disabled" },
      })),
    ];
    return [{ id: "user-level", title: "User level", rows, empty: loading ? "Loading…" : userConfig?.error ? userConfig.error : "No user-level servers" }];
  }, [displayed, userConfig, loading]);

  const projectRows: DirectoryRow[] = servers.map((server) => {
    const summary = serverSummary(server.config);
    return {
      id: `project:${server.name}`,
      title: <ServerTitle name={server.name} />,
      subtitle: summary.target || undefined,
      status: summary.valid ? (summary.enabled ? { tone: "ok", text: summary.type } : { tone: "muted", text: `${summary.type} · off` }) : { tone: "warn", text: "invalid" },
      onOpen: () => openEditor(server),
    };
  });
  const enabledCount = servers.filter((server) => serverSummary(server.config).enabled && serverSummary(server.config).valid).length;
  const invalidCount = servers.filter((server) => !serverSummary(server.config).valid).length;

  const editedServer = form?.previousName ? servers.find((server) => server.name === form.previousName) ?? null : null;
  const dirty = form !== null && (form.name !== (form.previousName ?? "") || form.source !== (editedServer ? JSON.stringify(editedServer.config, null, 2) : newServer()));

  return (
    <>
      <SearchSection id="configured-mcp-servers">
        <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden", background: "var(--bg-panel)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
            <strong style={{ fontSize: 12, color: "var(--text)", flexShrink: 0 }}>Configured MCP Servers</strong>
            <code title={userConfig?.path ?? undefined} style={{ flex: 1, minWidth: 0, color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>User level: {userConfig?.path ?? (loading ? "Loading..." : "unavailable")}</code>
            <button type="button" title="Refresh live MCP status" aria-label="Refresh live MCP status" onClick={() => void reload()} disabled={fetching} style={{ marginLeft: "auto", padding: 6, border: "none", background: "transparent", color: "var(--text-muted)", cursor: fetching ? "wait" : "pointer", display: "inline-flex" }}><RefreshCw size={14} aria-hidden="true" /></button>
          </div>
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {body?.liveError && <div role="status" style={{ color: "var(--text-muted)", fontSize: 11 }}>Live status unavailable: {body.liveError}</div>}
            <Directory sections={configuredSections} ariaLabel="Configured MCP servers" />
          </div>
        </section>
      </SearchSection>

      {cwd && (
        <SearchSection id="project-mcp-servers">
          <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden", background: "var(--bg-panel)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
              <strong style={{ fontSize: 12, color: "var(--text)", flexShrink: 0 }}>Project MCP Servers</strong>
              <code style={{ flex: "1 1 160px", minWidth: 0, color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{body?.path ?? (loading ? "Loading..." : "")}</code>
              {servers.length > 0 && (
                <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{enabledCount}/{servers.length} enabled{invalidCount > 0 ? ` · ${invalidCount} invalid` : ""}</span>
              )}
              <button type="button" onClick={() => openEditor(null)} style={smallButtonStyle}><Plus size={13} aria-hidden="true" /> Add server</button>
            </div>
            <div style={{ padding: 12 }}>
              <Directory sections={[{ id: "project", rows: projectRows, empty: loading ? "Loading…" : "No project servers yet. Add one to write this workspace's mcp.json." }]} ariaLabel="Project MCP servers" />
            </div>
          </section>
        </SearchSection>
      )}

      <Drawer
        open={form !== null}
        title={form?.previousName ? `Edit ${form.previousName}` : "Add MCP server"}
        presentation="side"
        dirty={dirty}
        onClose={closeForm}
        footer={form && (
          <>
            {form.previousName && (
              <button type="button" onClick={() => setConfirmRemove(form.previousName)} disabled={saving} style={{ ...dangerButtonStyle, marginRight: "auto" }}>
                <Trash2 size={13} aria-hidden="true" /> Remove
              </button>
            )}
            <button type="button" onClick={() => void check()} disabled={saving} style={smallButtonStyle}><Check size={13} aria-hidden="true" /> Check</button>
            <button type="button" onClick={closeForm} disabled={saving} style={smallButtonStyle}>Cancel</button>
            <button type="button" onClick={() => void save()} disabled={saving || !form.name.trim() || !dirty} style={{ ...primaryButtonStyle, opacity: saving || !form.name.trim() || !dirty ? 0.6 : 1 }}>{saving ? "Saving..." : "Save server"}</button>
          </>
        )}
      >
        {form && (
          <>
            <label style={{ display: "block", color: "var(--text-muted)", fontSize: 11 }}>
              Server name
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="filesystem" autoCapitalize="none" spellCheck={false} data-drawer-autofocus style={{ ...inputStyle, marginTop: 4 }} />
            </label>
            <label style={{ display: "block", color: "var(--text-muted)", fontSize: 11 }}>
              Server configuration (JSON)
              <textarea value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} spellCheck={false} style={{ ...inputStyle, minHeight: 200, marginTop: 4, resize: "vertical", lineHeight: 1.45 }} />
            </label>
            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>Written to this workspace&apos;s mcp.json. Restart agent sessions or run /mcp reload to apply a change.</div>
            {message && <div role="status" style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.4 }}>{message}</div>}
          </>
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => { if (!open && !saving) setConfirmRemove(null); }}
        title={confirmRemove ? `Remove ${confirmRemove}?` : "Remove MCP server"}
        description="Removes the server from this workspace's mcp.json. Running sessions keep it until they restart or run /mcp reload."
        confirmLabel={saving ? "Removing…" : "Remove server"}
        danger
        busy={saving}
        onConfirm={() => { if (confirmRemove) void remove(confirmRemove); }}
      />
    </>
  );
}
