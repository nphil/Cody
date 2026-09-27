"use client";

import { useContext, useEffect, useState, type CSSProperties } from "react";
import { AlertCircle, Plus, Sparkles, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/field";
import { Select } from "@/components/ui/Select";
import { toast } from "@/components/ui/toast";
import { useConfigWriter, useNativeSettings, type NativeSettings } from "@/hooks/useConfigWriter";
import { invalidateSettingsRoutes, useSettingsRoute } from "@/hooks/useSettingsData";
import { DEFAULT_HARNESS_LABEL } from "../SettingsTabs";
import { NativeSetting, ToggleSwitch } from "./primitives";
import { useSaveStatus } from "./SaveStatus";
import { ShellContext } from "./shell-context";
import { SettingsSection } from "./SettingsSection";
import { SettingsActions } from "./SettingsActions";
import { ChainList, ChainRow } from "./models/ChainList";
import { formatModelDisplayName } from "@/lib/model-display";
import type { RefusalPolicy } from "@/lib/refusal/config";

/**
 * The engine's native retry/fallback config, redesigned so the fallback-chain
 * list reads as "here is every chain the engine will actually use" instead
 * of a single role dropdown hiding the rest. See lib/harness /
 * docs/harnesses.md for how omp resolves fallbackChains[role] ??
 * fallbackChains.default at runtime.
 *
 * This is the ONE home of `retry.enabled`: the Behavior hub's recommended
 * cards deliberately leave the retry group out so a setting is never edited
 * in two places.
 *
 * Every write goes through the config writer (`patchSection("retry", …)`,
 * the section spread) and reports to the hosting panel's save corner; the
 * reset is a "delete" write, ordered after every pending patch, and the
 * dialog names the session restart it causes.
 *
 * Persistence rule that matters: an empty array under a chain key means "no
 * fallback" to omp, which is a trap for a chain the user is mid-edit on. So a
 * freshly added or fully-emptied chain is kept in `draftChainKeys` (client
 * state only) until it has >=1 entry, at which point it joins
 * retry.fallbackChains and gets persisted like everything else.
 */

export interface RuntimeModelEntry {
  id: string;
  name: string;
  provider: string;
  thinkingLevels?: string[];
}

/** Shown until `/api/model-roles` answers with the installed engine's own list,
 * and kept as the answer when it cannot (no omp, or the call fails). A chain
 * keyed by a role omp dropped is still a chain the user may have configured, so
 * a stale entry here only mislabels the chip — it never hides a chain. */
const FALLBACK_MODEL_ROLES = ["default", "smol", "slow", "vision", "plan", "commit", "tiny", "task", "advisor"];

type UsageReservePolicy = "confirm" | "auto" | "fail-closed";
type FallbackRevertPolicy = "cooldown-expiry" | "never";

interface RetryConfig {
  enabled?: boolean;
  maxRetries?: number;
  modelFallback?: boolean;
  usageAwareFallback?: boolean;
  usageReservePct?: number;
  usageReservePolicy?: UsageReservePolicy;
  fallbackRevertPolicy?: FallbackRevertPolicy;
  fallbackChains?: Record<string, string[]>;
}
type RefusalPolicyResponse = {
  policy?: RefusalPolicy;
  supported?: boolean;
  canManage?: boolean;
  version?: string | null;
  reason?: string;
};

const REFUSAL_POLICY_CHOICES: { value: RefusalPolicy; label: string; description: string }[] = [
  { value: "ask", label: "Ask each time", description: "Choose whether to rewind the declined message or continue on the configured fallback." },
  { value: "rewind", label: "Rewind automatically", description: "Remove the declined message and clear its saved session memories." },
  { value: "fallback", label: "Continue automatically", description: "Use the configured fallback; if none is available, keep the declined response." },
];


const RETRY_ATTEMPT_OPTIONS = [0, 1, 2, 3, 5, 10, 15, 20];
const RESERVE_PCT_OPTIONS = [5, 10, 15, 20, 25];

function retryAttemptLabel(count: number, engineName: string) {
  return count === 10 ? `10 (${engineName} default)` : String(count);
}

function revertPolicies(engineName: string): { value: FallbackRevertPolicy; label: string; description: string }[] {
  return [
    { value: "cooldown-expiry", label: `After cooldown expires (${engineName} default)`, description: `${engineName} automatically switches back to the primary model once its rate-limit or error cooldown has passed.` },
    { value: "never", label: "Never — stay on fallback", description: `Once ${engineName} falls back, it keeps using that model until you change it yourself.` },
  ];
}

function reservePolicies(engineName: string): { value: UsageReservePolicy; label: string; description: string }[] {
  return [
    { value: "confirm", label: `Confirm interactively (${engineName} default)`, description: `${engineName} asks before switching providers once the reserve margin is reached.` },
    { value: "auto", label: "Auto-fallback", description: `${engineName} switches providers on its own as soon as the reserve margin is reached.` },
    { value: "fail-closed", label: "Fail closed", description: `${engineName} stops the turn instead of switching providers once the reserve margin is reached.` },
  ];
}

type ChainKind = "Role" | "Provider" | "Model";

function chainKeyKind(key: string, roleNames: string[]): ChainKind {
  if (roleNames.includes(key)) return "Role";
  if (key.endsWith("/*")) return "Provider";
  return "Model";
}

const KIND_CHIP_STYLE: Record<ChainKind, CSSProperties> = {
  Role: { background: "color-mix(in srgb, var(--accent) 15%, transparent)", color: "var(--accent)" },
  Provider: { background: "color-mix(in srgb, var(--status-renamed) 15%, transparent)", color: "var(--status-renamed)" },
  Model: { background: "var(--bg-subtle)", color: "var(--text-muted)" },
};

function KindChip({ kind }: { kind: ChainKind }) {
  return <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, fontWeight: 600, flexShrink: 0, ...KIND_CHIP_STYLE[kind] }}>{kind}</span>;
}

type FallbackModelOption = { selector: string; name: string };

/** Match the longest configured selector first, so a model id containing a
 * colon stays literal and only a suffix beyond the exact id is treated as
 * effort metadata. */
function fallbackSelectorMetadata(selector: string, options: FallbackModelOption[]) {
  const match = options
    .filter((option) => selector === option.selector || selector.startsWith(option.selector + ":"))
    .sort((a, b) => b.selector.length - a.selector.length)[0];
  return {
    name: match?.name ?? selector,
    effort: match && selector.length > match.selector.length ? selector.slice(match.selector.length + 1) : null,
  };
}

function ChainCard({ chainKey, roleNames, entries, modelOptions, candidate, onCandidateChange, onAdd, onMove, onRemoveEntry, onRemoveCard }: {
  chainKey: string;
  roleNames: string[];
  entries: string[];
  modelOptions: FallbackModelOption[];
  candidate: string;
  onCandidateChange: (value: string) => void;
  onAdd: () => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemoveEntry: (index: number) => void;
  onRemoveCard: () => void;
}) {
  const kind = chainKeyKind(chainKey, roleNames);
  const unused = modelOptions.filter((option) => !entries.includes(option.selector));
  return (
    <SettingsSection
      variant="plain"
      bodyStyle={{ padding: 0 }}
      title={<span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}><KindChip kind={kind} /><code style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 400 }}>{chainKey}</code></span>}
      action={<button type="button" onClick={onRemoveCard} title={"Remove " + chainKey + " chain"} style={{ padding: 3, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}><Trash2 size={13} /></button>}
    >
      {entries.length === 0 ? (
        <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45 }}>
          Not saved yet — add at least one model below. An empty chain would tell the engine to fall back to nothing.
        </div>
      ) : (
        <ChainList>
          {entries.map((selector, index) => {
            const metadata = fallbackSelectorMetadata(selector, modelOptions);
            return (
              <ChainRow
                key={selector}
                leading={<span style={{ width: 18, display: "inline-block", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{index + 1}</span>}
                onMoveUp={() => onMove(index, -1)}
                onMoveDown={() => onMove(index, 1)}
                onRemove={() => onRemoveEntry(index)}
                moveUpDisabled={index === 0}
                moveDownDisabled={index === entries.length - 1}
                isLast={index === entries.length - 1}
              >
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {metadata.name}{metadata.effort ? <span style={{ color: "var(--text-dim)", fontWeight: 400 }}> · {metadata.effort}</span> : null}
                  </span>
                  <code style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>{selector}</code>
                </span>
              </ChainRow>
            );
          })}
        </ChainList>
      )}
      <div style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--border)" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Select
            value={candidate || null}
            onChange={onCandidateChange}
            options={unused.map((option) => ({ value: option.selector, label: option.name }))}
            placeholder="Add a model..."
          />
        </div>
        <button type="button" disabled={!candidate} onClick={onAdd} style={{ padding: "6px 10px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", fontSize: 12, cursor: candidate ? "pointer" : "default", opacity: candidate ? 1 : 0.6, display: "inline-flex", alignItems: "center", gap: 4 }}><Plus size={13} /> Add</button>
      </div>
    </SettingsSection>
  );
}

export function RetryFallbackPanel({ models, onOpenPresets, panelId = "models" }: { models: RuntimeModelEntry[]; onOpenPresets?: () => void; panelId?: string }) {
  // Works inside the settings shell (the engine's short name, the save
  // corner) and outside it, where it falls back to the default label.
  const shell = useContext(ShellContext);
  // The attempts select and the fallback checkbox are plain labels, not
  // NativeSetting cards, so they scroll themselves into view when a search
  // result or an "Also under" chip targets their schema id.
  const highlight = shell?.highlight ?? null;
  useEffect(() => {
    if (highlight !== "schema-retry.maxRetries" && highlight !== "schema-retry.modelFallback") return;
    const target = document.querySelector(`[data-search-id="${highlight}"]`);
    if (target instanceof HTMLElement) target.scrollIntoView({ block: "center" });
  }, [highlight]);
  const engineName = shell?.harnessLabel ?? DEFAULT_HARNESS_LABEL;
  const writer = useConfigWriter();
  const native = useNativeSettings(true);
  const { track } = useSaveStatus(panelId);
  const rolesRoute = useSettingsRoute<{ roleNames?: string[] }>("/api/model-roles");
  const refusalPolicyRoute = useSettingsRoute<RefusalPolicyResponse>("/api/refusal/config");
  const [refusalPolicySaving, setRefusalPolicySaving] = useState(false);
  const [refusalPolicyError, setRefusalPolicyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Chain keys the user just added (or fully emptied out) that have no
  // persisted entries yet — see the module doc comment above.
  const [draftChainKeys, setDraftChainKeys] = useState<string[]>([]);
  const [candidateByKey, setCandidateByKey] = useState<Record<string, string>>({});
  const [addChainSelect, setAddChainSelect] = useState("");
  const [customChainKey, setCustomChainKey] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  // omp's role vocabulary changes between releases, so which chain keys are
  // roles is the engine's answer, not a list frozen here.
  const roleNames = rolesRoute.data?.roleNames?.length ? rolesRoute.data.roleNames : FALLBACK_MODEL_ROLES;

  const settings = native.settings;
  if (!settings) {
    return <div style={{ color: native.error ? "var(--status-error)" : "var(--text-muted)", fontSize: 12 }}>{native.error ?? `Loading ${engineName} retry settings…`}</div>;
  }

  const retry: RetryConfig = settings.retry ?? {};
  const chains = retry.fallbackChains ?? {};
  const modelOptions = models.map((model) => ({ selector: model.provider + "/" + model.id, name: formatModelDisplayName(model.id, model.name) }));
  const providers = [...new Set(models.map((model) => model.provider))].sort();

  const persistedKeys = Object.keys(chains);
  const visibleKeys = [...persistedKeys, ...draftChainKeys.filter((key) => !persistedKeys.includes(key))];

  // The section spread, never the whole settings object: `retry` is merged
  // under its own key by the writer.
  const setRetry = (patch: Partial<RetryConfig>) => {
    setError(null);
    void track(() => native.patchSection("retry", patch as Partial<NonNullable<NativeSettings["retry"]>>)).then((ok) => {
      if (!ok) setError("Could not save — see the status above.");
    });
  };
  const saveRefusalPolicy = async (policy: RefusalPolicy) => {
    setRefusalPolicySaving(true);
    setRefusalPolicyError(null);
    try {
      const response = await fetch("/api/refusal/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy }),
      });
      if (!response.ok) throw new Error("save failed");
      await refusalPolicyRoute.reload();
    } catch {
      setRefusalPolicyError("Could not save this setting.");
    } finally {
      setRefusalPolicySaving(false);
    }
  };

  const setChainEntries = (key: string, entries: string[]) => {
    if (entries.length === 0) {
      // Never persist an empty chain — it reads to omp as "no fallback".
      if (key in chains) {
        const nextChains = { ...chains };
        delete nextChains[key];
        setRetry({ fallbackChains: nextChains });
      }
      setDraftChainKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    } else {
      setRetry({ fallbackChains: { ...chains, [key]: entries } });
      setDraftChainKeys((prev) => prev.filter((value) => value !== key));
    }
  };

  const removeChainCard = (key: string) => {
    if (key in chains) {
      const nextChains = { ...chains };
      delete nextChains[key];
      setRetry({ fallbackChains: nextChains });
    }
    setDraftChainKeys((prev) => prev.filter((value) => value !== key));
    setCandidateByKey((prev) => { const next = { ...prev }; delete next[key]; return next; });
  };

  const addChainCard = (rawKey: string) => {
    const key = rawKey.trim();
    if (!key || visibleKeys.includes(key)) return;
    setDraftChainKeys((prev) => [...prev, key]);
  };

  const unconfiguredRoles = roleNames.filter((role) => !visibleKeys.includes(role));
  const unconfiguredWildcards = providers.map((provider) => `${provider}/*`).filter((wildcard) => !visibleKeys.includes(wildcard));

  const defaultHasEntries = (chains["default"] ?? []).length > 0;
  const otherRoleHasEntries = roleNames.some((role) => role !== "default" && (chains[role] ?? []).length > 0);
  const showDefaultCaution = !defaultHasEntries && otherRoleHasEntries;

  const REVERT_POLICIES = revertPolicies(engineName);
  const RESERVE_POLICIES = reservePolicies(engineName);
  const revertPolicy = REVERT_POLICIES.find((entry) => entry.value === (retry.fallbackRevertPolicy ?? "cooldown-expiry")) ?? REVERT_POLICIES[0];
  const reservePolicy = RESERVE_POLICIES.find((entry) => entry.value === (retry.usageReservePolicy ?? "confirm")) ?? RESERVE_POLICIES[0];

  // A section reset is a "delete" write: it waits for every queued patch so
  // it cannot erase a change the user made a moment ago.
  const runReset = () => {
    setResetting(true);
    void track(() =>
      writer.enqueue("delete", async () => {
        const response = await fetch("/api/omp-settings", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sections: ["retry"] }) });
        const data = (await response.json().catch(() => ({}))) as { restarted?: number; active?: number; error?: string };
        if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
        invalidateSettingsRoutes("/api/omp-settings", { exact: true });
        setDraftChainKeys([]);
        setCandidateByKey({});
        setResetOpen(false);
        const restarted = data.restarted ?? 0;
        const active = data.active ?? 0;
        toast.success(
          `${engineName} retry & fallback defaults restored`,
          `Applied to ${restarted} idle session${restarted === 1 ? "" : "s"}.${active > 0 ? ` ${active} running session${active === 1 ? "" : "s"} will keep the previous settings until it finishes.` : ""}`,
        );
      }),
    )
      .then((ok) => {
        if (!ok) toast.error("Could not reset retry & fallback settings");
      })
      .finally(() => setResetting(false));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Retry & Fallback</div>
        <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
          When a model call fails, {engineName} retries it, then — if allowed — falls back to another model before giving up on the turn.
        </p>
      </div>

      <NativeSetting
        label="Retry transient errors"
        description={`Retry a failed model call before ${engineName} gives up on the turn. Off means a single attempt.`}
        searchId="retry-transient-errors"
      >
        <ToggleSwitch checked={retry.enabled ?? true} onChange={(enabled) => setRetry({ enabled })} />
      </NativeSetting>

      <SettingsSection
        title="Retry attempts"
        variant="plain"
        searchId="schema-retry.maxRetries"
      >
        <Select
          value={String(retry.maxRetries ?? 10)}
          onChange={(value) => setRetry({ maxRetries: Number(value) })}
          options={RETRY_ATTEMPT_OPTIONS.map((count) => ({ value: String(count), label: retryAttemptLabel(count, engineName) }))}
        />
      </SettingsSection>

      <SettingsSection
        title="Return to primary model"
        description={revertPolicy.description}
        variant="plain"
      >
        <Select
          value={retry.fallbackRevertPolicy ?? "cooldown-expiry"}
          onChange={(value) => setRetry({ fallbackRevertPolicy: value })}
          options={REVERT_POLICIES}
        />
      </SettingsSection>

      <NativeSetting
        label="Allow model fallback"
        searchId="schema-retry.modelFallback"
      >
        <ToggleSwitch checked={retry.modelFallback ?? true} onChange={(checked) => setRetry({ modelFallback: checked })} />
      </NativeSetting>

      <NativeSetting
        label="Usage-aware fallback"
        description="Moves off a provider before it hits a hard usage limit, using coding-plan quota reports."
      >
        <ToggleSwitch checked={retry.usageAwareFallback ?? false} onChange={(checked) => setRetry({ usageAwareFallback: checked })} />
      </NativeSetting>

      {(retry.usageAwareFallback ?? false) && (
        <>
          <SettingsSection
            title="Reserve margin"
            variant="plain"
          >
            <Select
              value={String(retry.usageReservePct ?? 10)}
              onChange={(value) => setRetry({ usageReservePct: Number(value) })}
              options={RESERVE_PCT_OPTIONS.map((pct) => ({ value: String(pct), label: `${pct}%${pct === 10 ? ` (${engineName} default)` : ""}` }))}
            />
          </SettingsSection>

          <SettingsSection
            title="Reserve policy"
            description={reservePolicy.description}
            variant="plain"
          >
            <Select
              value={retry.usageReservePolicy ?? "confirm"}
              onChange={(value) => setRetry({ usageReservePolicy: value })}
              options={RESERVE_POLICIES}
            />
          </SettingsSection>
        </>
      )}

      <SettingsSection
        title="Fallback chains"
        description={`When a model fails, ${engineName} selects one chain: an exact model match first, then a provider wildcard, then a matching role. This precedence applies to both main sessions and subagents. Within the selected chain, it tries eligible models in order.`}
        variant="plain"
        bodyStyle={{ padding: 0 }}
      >
        {visibleKeys.length === 0 ? (
          <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{engineName} has no fallback chains configured — a failed call simply retries the same model, with nowhere else to go.</p>
            {onOpenPresets && (
              <button type="button" onClick={onOpenPresets} style={{ alignSelf: "flex-start", padding: 0, border: "none", background: "none", color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Sparkles size={13} /> Set them up from a model preset
              </button>
            )}
          </div>
        ) : (
          <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleKeys.map((key) => (
              <ChainCard
                key={key}
                chainKey={key}
                roleNames={roleNames}
                entries={chains[key] ?? []}
                modelOptions={modelOptions}
                candidate={candidateByKey[key] ?? ""}
                onCandidateChange={(value) => setCandidateByKey((prev) => ({ ...prev, [key]: value }))}
                onAdd={() => {
                  const value = candidateByKey[key];
                  if (!value) return;
                  setChainEntries(key, [...(chains[key] ?? []), value]);
                  setCandidateByKey((prev) => ({ ...prev, [key]: "" }));
                }}
                onMove={(index, direction) => {
                  const entries = [...(chains[key] ?? [])];
                  const target = index + direction;
                  if (target < 0 || target >= entries.length) return;
                  [entries[index], entries[target]] = [entries[target], entries[index]];
                  setChainEntries(key, entries);
                }}
                onRemoveEntry={(index) => {
                  const entries = (chains[key] ?? []).filter((_, i) => i !== index);
                  setChainEntries(key, entries);
                }}
                onRemoveCard={() => removeChainCard(key)}
              />
            ))}
          </div>
        )}

        {showDefaultCaution && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 7, margin: "10px 12px", padding: "8px 10px", border: "1px solid color-mix(in srgb, var(--status-warning) 35%, transparent)", borderRadius: "var(--radius-control)", background: "color-mix(in srgb, var(--status-warning) 10%, transparent)", color: "var(--text)", fontSize: 11, lineHeight: 1.45 }}>
            <AlertCircle size={13} style={{ color: "var(--status-warning)", flexShrink: 0, marginTop: 1 }} />
            <span>
              The <code>default</code> chain is empty, but other roles have their own chains. Any role without its own chain falls back to <code>default</code> — and would find nothing there.
            </span>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 10, borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
          <Select
            value={addChainSelect || null}
            onChange={(value) => {
              if (value === "__custom__") setAddChainSelect(value);
              else addChainCard(value);
            }}
            options={[
              ...(unconfiguredRoles.length > 0 ? [{ label: "Role", options: unconfiguredRoles.map((role) => ({ value: role, label: role })) }] : []),
              ...(unconfiguredWildcards.length > 0 ? [{ label: "Provider", options: unconfiguredWildcards.map((wildcard) => ({ value: wildcard, label: wildcard })) }] : []),
              { label: "Model", options: [{ value: "__custom__", label: "Custom key..." }] },
            ]}
            placeholder="Add chain for..."
            width="200px"
          />
          {addChainSelect === "__custom__" && (
            <>
              <input
                type="text"
                value={customChainKey}
                onChange={(event) => setCustomChainKey(event.target.value)}
                placeholder="provider/model-id"
                style={{ flex: "1 1 180px", minWidth: 0, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }}
              />
              <button
                type="button"
                disabled={!customChainKey.trim()}
                onClick={() => {
                  addChainCard(customChainKey);
                  setCustomChainKey("");
                  setAddChainSelect("");
                }}
                style={{ padding: "6px 10px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", fontSize: 12, cursor: customChainKey.trim() ? "pointer" : "default", opacity: customChainKey.trim() ? 1 : 0.6 }}
              >
                Add
              </button>
            </>
          )}
        </div>
      </SettingsSection>

      {error && (
        <div role="alert" style={{ color: "var(--status-error)", fontSize: 12 }}>
          {error}
        </div>
      )}

      <SettingsSection
        title="When a model declines for safety reasons"
        description="Choose whether Cody asks, rewinds automatically, or continues on an available fallback."
      >
        <fieldset
          disabled={!refusalPolicyRoute.data?.supported || refusalPolicyRoute.data.canManage !== true || refusalPolicySaving}
          style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "flex", flexDirection: "column" }}
        >
          <legend className="sr-only">When a model declines for safety reasons</legend>
          {REFUSAL_POLICY_CHOICES.map((choice) => (
            <label key={choice.value} style={{ display: "flex", alignItems: "flex-start", gap: 10, minHeight: 48, padding: "7px 0", cursor: "pointer" }}>
              <input
                type="radio"
                name="refusal-policy"
                value={choice.value}
                checked={(refusalPolicyRoute.data?.policy ?? "ask") === choice.value}
                onChange={() => { void saveRefusalPolicy(choice.value); }}
                style={{ width: 18, height: 18, flexShrink: 0, margin: "2px 0 0", accentColor: "var(--accent)" }}
              />
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}>{choice.label}</span>
                <span style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{choice.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {refusalPolicyRoute.data?.supported === false && (
          <p role="status" style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 11 }}>
            {refusalPolicyRoute.data.reason ?? "Needs OMP 18.3 or newer."}
            {refusalPolicyRoute.data.version ? ` (Detected ${refusalPolicyRoute.data.version}.)` : ""}
          </p>
        )}
        {refusalPolicyRoute.data?.canManage === false && (
          <p role="status" style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 11 }}>Only an administrator can change this setting.</p>
        )}
        {(refusalPolicyError || refusalPolicyRoute.error) && (
          <p role="alert" style={{ margin: "8px 0 0", color: "var(--status-error)", fontSize: 11 }}>
            {refusalPolicyError ?? refusalPolicyRoute.error}
          </p>
        )}
      </SettingsSection>

      <SettingsActions onReset={() => setResetOpen(true)} resetLabel={`Reset to ${engineName} defaults`} />

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={`Reset retry & fallback to ${engineName} defaults?`}
        description={`This deletes all retry and fallback customization — including every fallback chain you've configured — and lets ${engineName}'s built-in defaults take over. Idle sessions restart to pick this up immediately; a session mid-turn keeps its current settings until it finishes.`}
        confirmLabel="Reset to defaults"
        cancelLabel="Cancel"
        danger
        busy={resetting}
        onConfirm={runReset}
      />
    </div>
  );
}
