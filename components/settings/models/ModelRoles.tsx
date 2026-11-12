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
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ui/field";
import { Select, type SelectOption } from "@/components/ui/Select";
import { toast } from "@/components/ui/toast";
import { useConfigWriter } from "@/hooks/useConfigWriter";
import { useLocalAiScan } from "@/hooks/useLocalAiScan";
import { invalidateSettingsRoutes, useSettingsRoute } from "@/hooks/useSettingsData";
import { formatModelDisplayName } from "@/lib/model-display";
import { isRecognizedThinkingSuffix } from "@/lib/model-plan/derive";
import { UNAVAILABLE_BADGE, chipStyle } from "../primitives";
import { useSaveStatus } from "../SaveStatus";
import { SettingsActions } from "../SettingsActions";
import { SettingsSection, SettingsRow } from "../SettingsSection";
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
/** omp's provider id for LM Studio. */
const LM_STUDIO_PROVIDER = "lm-studio";
/** The one role omp serves non-chat (decision) models for. */
const JUDGE_ROLE = "judge";
/** Split `provider/id[:effort]` into its model and its reasoning level. A
 * selector that IS a known model (a bare id containing a colon) keeps its
 * colon; Distill's chain editor splits the same dialect. */
export function splitSelector(raw: string, selectors: ReadonlySet<string>): { model: string; effort: string } {
  if (selectors.has(raw)) return { model: raw, effort: "" };
  const colon = raw.lastIndexOf(":");
  if (colon <= raw.lastIndexOf("/") || !isRecognizedThinkingSuffix(raw.slice(colon + 1))) {
    return { model: raw, effort: "" };
  }
  return { model: raw.slice(0, colon), effort: raw.slice(colon + 1) };
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
  // LM Studio decision models can serve the `judge` role (omp 18.13.2+) but are
  // not chat models, so omp's model list never carries them: the scan does.
  const scan = useLocalAiScan(roleNames.includes("judge"));
  const decisionSelectors = useMemo(
    () => [...new Set(scan.results.filter((result) => result.runtime === "lmstudio").flatMap((result) => result.decisionModels ?? []))].map((id) => LM_STUDIO_PROVIDER + "/" + id),
    [scan.results],
  );
  const modelSelectors = useMemo(
    () => new Set([...models.map((model) => model.provider + "/" + model.id), ...decisionSelectors]),
    [models, decisionSelectors],
  );

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
      const current = splitSelector(values[role] ?? "", modelSelectors);
      const model = next.model ?? current.model;
      const effort = next.effort ?? current.effort;
      return { ...values, [role]: model ? model + (effort ? ":" + effort : "") : "" };
    });
    setDirty(true);
  };

  const visibleModels = models.filter((model) => !model.hidden);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SettingsSection
        title="Model roles"
        description={<>Saved in {harnessLabel}&apos;s own config. Choose a model and, where it supports one, a reasoning level for each role.</>}
        variant="rows"
      >
        {route.loading && !route.data ? (
          <div style={{ padding: "10px 14px", color: "var(--text-muted)", fontSize: 12 }}>Loading roles…</div>
        ) : (
          roleNames.map((role) => {
            const { model: selectedModel, effort: selectedThinking } = splitSelector(roles[role] ?? "", modelSelectors);
            const assigned = models.find((item) => item.provider + "/" + item.id === selectedModel);
            const assignedHidden = Boolean(assigned?.hidden);
            const decisionAssigned = role === JUDGE_ROLE && decisionSelectors.includes(selectedModel);
            const modelKnown = !selectedModel || Boolean(assigned) || decisionAssigned;
            const unavailable = assignedHidden
              ? "hidden — still used until changed"
              : !modelKnown
                ? "not currently available — still used until changed"
                : null;
            const modelOptions: SelectOption<string>[] = [
              { value: "", label: "No override" },
              ...(selectedModel && (!modelKnown || assignedHidden)
                ? [{
                    value: selectedModel,
                    label: `${assigned ? formatModelDisplayName(assigned.id, assigned.name) : selectedModel} (${assignedHidden ? "hidden" : "not currently available"})`,
                  }]
                : []),
              ...visibleModels.map((item) => ({
                value: item.provider + "/" + item.id,
                label: `${formatModelDisplayName(item.id, item.name)} (${item.provider}/${item.id})`,
              })),
              ...(role === JUDGE_ROLE
                ? decisionSelectors.map((selector) => ({ value: selector, label: `${selector.slice(LM_STUDIO_PROVIDER.length + 1)} (${selector}, LM Studio decision model)` }))
                : []),
            ];
            const thinkingOptions: SelectOption<string>[] = [
              { value: "", label: "Model default" },
              ...(assigned?.thinkingLevels ?? [])
                .filter((level) => level !== "off")
                .map((level) => ({ value: level, label: level })),
            ];
            return (
              <SettingsRow
                key={role}
                label={
                  <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                    <code style={{ color: "var(--text-muted)" }}>{role}</code>
                    {unavailable && (
                      <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ ...chipStyle, color: "var(--status-warning)" }}>{UNAVAILABLE_BADGE}</span>
                        <span style={{ fontSize: 11, color: "var(--status-warning)" }}>{unavailable}</span>
                      </span>
                    )}
                  </span>
                }
              >
                <div data-search-id={`model-role-${role}`} className="model-role-row" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(168px, 0.4fr)", gap: 8, flex: 1, minWidth: 0 }}>
                  <Select
                    value={selectedModel}
                    onChange={(model) => update(role, { model })}
                    options={modelOptions}
                    aria-label={`${role} model`}
                  />
                  <Select
                    value={selectedThinking}
                    onChange={(effort) => update(role, { effort })}
                    options={thinkingOptions}
                    disabled={!assigned}
                    aria-label={`${role} reasoning level`}
                  />
                </div>
              </SettingsRow>
            );
          })
        )}
      </SettingsSection>
      {route.error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 12 }}>{route.error}</div>}
      <SettingsActions
        dirty={dirty}
        onSave={save}
        saving={saving}
        saveLabel="Save roles"
        onReset={() => setResetOpen(true)}
        resetLabel={`Reset to ${harnessLabel} defaults`}
        resetDisabled={route.loading && !route.data}
      />
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
