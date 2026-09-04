"use client";

/**
 * Settings › Models › Assignments: which model plays each of the engine's
 * roles (`modelRoles` in omp's config.yml), with the reasoning level the
 * model supports.
 *
 * The role vocabulary is the ENGINE's (`roleNames` off /api/model-roles):
 * Cody used to hand-list it and kept offering `designer` after omp dropped
 * it, so a saved override landed in config.yml for a role nothing reads.
 *
 * Options are the models that reach sessions AND are visible to this user.
 * A role already assigned to a hidden model keeps working — omp resolves
 * the role from config.yml, not from what the picker shows — so the row
 * says UNAVAILABLE with the reason rather than silently re-pointing it.
 *
 * Writes go through the config writer's "roles" family so a role save and
 * a section patch to the same file cannot race; the reset is a "delete"
 * write, ordered after every pending patch, and it names the session
 * restart it causes before running.
 */
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useConfigWriter } from "@/hooks/useConfigWriter";
import { invalidateSettingsRoutes, useSettingsRoute } from "@/hooks/useSettingsData";
import { nativeOptionStyle, nativeSelectStyle, UNAVAILABLE_BADGE, chipStyle } from "../primitives";
import { useSaveStatus } from "../SaveStatus";
import { useSettingsShell } from "../shell-context";

export interface RoleModelOption {
  id: string;
  name: string;
  provider: string;
  thinkingLevels?: string[];
  /** The model exists but this user cannot see it (hidden by an
   * administrator or by themselves). */
  hidden?: boolean;
}

interface ModelRolesBody {
  roles?: Record<string, string>;
  roleNames?: string[];
}

const ROLES_ROUTE = "/api/model-roles";

function splitSelector(raw: string): { model: string; effort: string } {
  const match = raw.match(/:([^,:/]+)$/);
  return match ? { model: raw.slice(0, match.index), effort: match[1] } : { model: raw, effort: "" };
}

export function ModelRoles({ models, panelId }: { models: RoleModelOption[]; panelId: string }) {
  const { harnessLabel } = useSettingsShell();
  const writer = useConfigWriter();
  const { track } = useSaveStatus(panelId);
  const route = useSettingsRoute<ModelRolesBody>(ROLES_ROUTE);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const roleNames = route.data?.roleNames ?? [];

  // The server's copy wins until the user edits; a save that lands re-reads
  // the route, which is the confirmation that the edit persisted.
  useEffect(() => {
    if (route.data?.roles && !dirty) setRoles(route.data.roles);
  }, [route.data, dirty]);

  const save = () => {
    setSaving(true);
    void track(() => writer.enqueue("roles", async () => {
      const response = await fetch(ROLES_ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles }) });
      const data = (await response.json().catch(() => ({}))) as { error?: string; restarted?: number; active?: number };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setDirty(false);
      invalidateSettingsRoutes(ROLES_ROUTE, { exact: true });
      const restarted = data.restarted ?? 0;
      const active = data.active ?? 0;
      toast.success(
        `${harnessLabel} model roles saved`,
        `Applied to ${restarted} idle session${restarted === 1 ? "" : "s"}.${active > 0 ? ` ${active} running session${active === 1 ? "" : "s"} will pick it up when it finishes.` : ""}`,
      );
    })).finally(() => setSaving(false));
  };

  const runReset = () => {
    setResetting(true);
    void track(() => writer.enqueue("delete", async () => {
      const response = await fetch(ROLES_ROUTE, { method: "DELETE" });
      const data = (await response.json().catch(() => ({}))) as { error?: string; restarted?: number; active?: number };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setRoles({});
      setDirty(false);
      setResetOpen(false);
      invalidateSettingsRoutes(ROLES_ROUTE, { exact: true });
      const restarted = data.restarted ?? 0;
      const active = data.active ?? 0;
      toast.success(
        `${harnessLabel} model roles reset`,
        `Every role goes back to ${harnessLabel}'s built-in choice. Applied to ${restarted} idle session${restarted === 1 ? "" : "s"}.${active > 0 ? ` ${active} running session${active === 1 ? "" : "s"} will keep the previous roles until it finishes.` : ""}`,
      );
    })).finally(() => setResetting(false));
  };

  const update = (role: string, next: { model?: string; effort?: string }) => {
    setRoles((values) => {
      const current = splitSelector(values[role] ?? "");
      const model = next.model ?? current.model;
      const effort = next.effort ?? current.effort;
      return { ...values, [role]: model ? `${model}${effort ? `:${effort}` : ""}` : "" };
    });
    setDirty(true);
  };

  const visibleModels = models.filter((model) => !model.hidden);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>Model roles</div>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Saved in {harnessLabel}&apos;s own config. Choose a model and, where it supports one, a reasoning level for each role.
        </p>
      </div>
      {route.loading && !route.data
        ? <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Loading roles…</div>
        : roleNames.map((role) => {
          const { model: selectedModel, effort: selectedThinking } = splitSelector(roles[role] ?? "");
          const assigned = models.find((item) => `${item.provider}/${item.id}` === selectedModel);
          const assignedHidden = Boolean(assigned?.hidden);
          const modelKnown = !selectedModel || Boolean(assigned);
          const unavailable = assignedHidden
            ? "hidden — still used until changed"
            : !modelKnown
              ? "not currently available — still used until changed"
              : null;
          return (
            <div key={role} data-search-id={`model-role-${role}`} className="model-role-row" style={{ display: "grid", gridTemplateColumns: "minmax(82px, 0.3fr) minmax(0, 1fr) minmax(110px, 0.35fr)", alignItems: "center", gap: 10, fontSize: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <code style={{ color: "var(--text-muted)" }}>{role}</code>
                {unavailable && (
                  <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ ...chipStyle, color: "var(--status-warning)" }}>{UNAVAILABLE_BADGE}</span>
                    <span style={{ fontSize: 10.5, color: "var(--status-warning)" }}>{unavailable}</span>
                  </span>
                )}
              </div>
              <select value={selectedModel} aria-label={`${role} model`} onChange={(event) => update(role, { model: event.target.value })} style={{ ...nativeSelectStyle, minWidth: 0, width: "100%" }}>
                <option value="" style={nativeOptionStyle}>No override</option>
                {selectedModel && (!modelKnown || assignedHidden) && (
                  <option value={selectedModel} style={nativeOptionStyle}>{assigned?.name ?? selectedModel} ({assignedHidden ? "hidden" : "not currently available"})</option>
                )}
                {visibleModels.map((item) => (
                  <option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`} style={nativeOptionStyle}>{item.name || item.id} ({item.provider}/{item.id})</option>
                ))}
              </select>
              <select value={selectedThinking} aria-label={`${role} reasoning level`} disabled={!assigned} onChange={(event) => update(role, { effort: event.target.value })} style={{ ...nativeSelectStyle, minWidth: 0, width: "100%", opacity: assigned ? 1 : 0.55 }}>
                <option value="" style={nativeOptionStyle}>Model default</option>
                {(assigned?.thinkingLevels ?? []).filter((level) => level !== "off").map((level) => <option key={level} value={level} style={nativeOptionStyle}>{level}</option>)}
              </select>
            </div>
          );
        })}
      {route.error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 12 }}>{route.error}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={save} disabled={!dirty || saving} style={{ padding: "7px 12px", minHeight: 32, border: "none", borderRadius: "var(--radius-control)", background: dirty ? "var(--accent)" : "var(--bg-hover)", color: dirty ? "var(--on-accent)" : "var(--text-dim)", cursor: saving ? "wait" : dirty ? "pointer" : "default", fontSize: 12, fontWeight: 600 }}>
          {saving ? "Saving…" : "Save roles"}
        </button>
        <button type="button" onClick={() => setResetOpen(true)} disabled={route.loading && !route.data} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", minHeight: 32, border: "1px solid var(--status-error)", borderRadius: "var(--radius-control)", background: "none", color: "var(--status-error)", cursor: "pointer", fontSize: 12, fontWeight: 500 }}>
          <RotateCcw size={13} aria-hidden="true" /> Reset to {harnessLabel} defaults
        </button>
      </div>
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={`Reset ${harnessLabel} model roles?`}
        description={`This clears every role override — ${roleNames.join(", ")} — and lets ${harnessLabel} choose each one with its built-in priorities, as on a fresh install. Idle sessions restart to pick this up; a session mid-turn keeps the previous roles until it finishes.`}
        confirmLabel="Reset to defaults"
        cancelLabel="Cancel"
        danger
        busy={resetting}
        onConfirm={runReset}
      />
    </div>
  );
}
