"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, ArrowDown, ArrowUp, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";

/**
 * OMP's native retry/fallback config, redesigned so the fallback-chain list
 * reads as "here is every chain OMP will actually use" instead of a single
 * role dropdown hiding the rest. See lib/harness / docs/harnesses.md for how
 * omp resolves fallbackChains[role] ?? fallbackChains.default at runtime.
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

export const NATIVE_MODEL_ROLES = ["default", "smol", "slow", "vision", "plan", "designer", "commit", "tiny", "task", "advisor"];

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

type RetrySettings = { retry?: RetryConfig };

const RETRY_ATTEMPT_OPTIONS = [0, 1, 2, 3, 5, 10, 15, 20];
const RESERVE_PCT_OPTIONS = [5, 10, 15, 20, 25];

function retryAttemptLabel(count: number) {
  return count === 10 ? "10 (OMP default)" : String(count);
}

const REVERT_POLICIES: { value: FallbackRevertPolicy; label: string; description: string }[] = [
  { value: "cooldown-expiry", label: "After cooldown expires (OMP default)", description: "OMP automatically switches back to the primary model once its rate-limit or error cooldown has passed." },
  { value: "never", label: "Never — stay on fallback", description: "Once OMP falls back, it keeps using that model until you change it yourself." },
];

const RESERVE_POLICIES: { value: UsageReservePolicy; label: string; description: string }[] = [
  { value: "confirm", label: "Confirm interactively (OMP default)", description: "OMP asks before switching providers once the reserve margin is reached." },
  { value: "auto", label: "Auto-fallback", description: "OMP switches providers on its own as soon as the reserve margin is reached." },
  { value: "fail-closed", label: "Fail closed", description: "OMP stops the turn instead of switching providers once the reserve margin is reached." },
];

const cardStyle: CSSProperties = { padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", fontSize: 12, color: "var(--text)" };
const selectStyle: CSSProperties = { marginLeft: 8, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12 };
const helpTextStyle: CSSProperties = { margin: "6px 0 0", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45 };
const sectionCardStyle: CSSProperties = { border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" };
const sectionHeaderStyle: CSSProperties = { padding: "10px 12px", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, fontWeight: 600 };
const groupLabelStyle: CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" };

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{children}</div>;
}

type ChainKind = "Role" | "Provider" | "Model";

function chainKeyKind(key: string): ChainKind {
  if (NATIVE_MODEL_ROLES.includes(key)) return "Role";
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

function ChainCard({ chainKey, entries, modelOptions, candidate, onCandidateChange, onAdd, onMove, onRemoveEntry, onRemoveCard }: {
  chainKey: string;
  entries: string[];
  modelOptions: string[];
  candidate: string;
  onCandidateChange: (value: string) => void;
  onAdd: () => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemoveEntry: (index: number) => void;
  onRemoveCard: () => void;
}) {
  const kind = chainKeyKind(chainKey);
  const unused = modelOptions.filter((value) => !entries.includes(value));
  return (
    <section style={sectionCardStyle}>
      <div style={{ ...sectionHeaderStyle, display: "flex", alignItems: "center", gap: 8 }}>
        <KindChip kind={kind} />
        <code style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{chainKey}</code>
        <button type="button" onClick={onRemoveCard} title={`Remove ${chainKey} chain`} style={{ padding: 3, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}><Trash2 size={13} /></button>
      </div>
      {entries.length === 0 ? (
        <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45, borderTop: "1px solid var(--border)" }}>
          Not saved yet — add at least one model below. An empty chain would tell OMP to fall back to nothing.
        </div>
      ) : (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          {entries.map((selector, index) => (
            <div key={selector} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", color: "var(--text-muted)", fontSize: 12, borderBottom: index === entries.length - 1 ? "none" : "1px solid var(--border)" }}>
              <span style={{ width: 18, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{index + 1}</span>
              <code style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selector}</code>
              <button type="button" disabled={index === 0} onClick={() => onMove(index, -1)} title="Move up" style={{ padding: 2, border: "none", background: "transparent", color: "var(--text-muted)", cursor: index === 0 ? "default" : "pointer", opacity: index === 0 ? 0.4 : 1 }}><ArrowUp size={14} /></button>
              <button type="button" disabled={index === entries.length - 1} onClick={() => onMove(index, 1)} title="Move down" style={{ padding: 2, border: "none", background: "transparent", color: "var(--text-muted)", cursor: index === entries.length - 1 ? "default" : "pointer", opacity: index === entries.length - 1 ? 0.4 : 1 }}><ArrowDown size={14} /></button>
              <button type="button" onClick={() => onRemoveEntry(index)} title="Remove" style={{ padding: 2, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--border)" }}>
        <select value={candidate} onChange={(event) => onCandidateChange(event.target.value)} style={{ flex: 1, minWidth: 0, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}>
          <option value="">Add a model...</option>
          {unused.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button type="button" disabled={!candidate} onClick={onAdd} style={{ padding: "6px 10px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", fontSize: 12, cursor: candidate ? "pointer" : "default", opacity: candidate ? 1 : 0.6, display: "inline-flex", alignItems: "center", gap: 4 }}><Plus size={13} /> Add</button>
      </div>
    </section>
  );
}

export function RetryFallbackPanel({ models, onOpenModelPlan }: { models: RuntimeModelEntry[]; onOpenModelPlan?: () => void }) {
  const [settings, setSettings] = useState<RetrySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Chain keys the user just added (or fully emptied out) that have no
  // persisted entries yet — see the module doc comment above.
  const [draftChainKeys, setDraftChainKeys] = useState<string[]>([]);
  const [candidateByKey, setCandidateByKey] = useState<Record<string, string>>({});
  const [addChainSelect, setAddChainSelect] = useState("");
  const [customChainKey, setCustomChainKey] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    fetch("/api/omp-settings")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data: { settings?: RetrySettings }) => setSettings(data.settings ?? {}))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  // Serialize full-snapshot saves: each call writes the whole settings object,
  // so overlapping PUTs can land out of order and clobber newer changes. Keep
  // the latest snapshot and drain a single serialized save always writing the
  // most recent state (fixes rapid fallback-chain edits scheduling stale writes).
  const latestRef = useRef<RetrySettings | null>(null);
  const drainingRef = useRef(false);
  const save = (next: RetrySettings) => {
    setSettings(next);
    setError(null);
    latestRef.current = next;
    if (drainingRef.current) return;
    drainingRef.current = true;
    void (async () => {
      try {
        while (latestRef.current !== null) {
          const snapshot = latestRef.current;
          latestRef.current = null;
          try {
            const response = await fetch("/api/omp-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: snapshot }) });
            const data = await response.json() as { settings?: RetrySettings; error?: string };
            if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
            if (latestRef.current === null) setSettings(data.settings ?? snapshot);
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            break;
          }
        }
      } finally {
        drainingRef.current = false;
      }
    })();
  };

  if (!settings) return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Loading native OMP retry settings...</div>;

  const retry = settings.retry ?? {};
  const chains = retry.fallbackChains ?? {};
  const modelOptions = models.map((model) => `${model.provider}/${model.id}`);
  const providers = [...new Set(models.map((model) => model.provider))].sort();

  const persistedKeys = Object.keys(chains);
  const visibleKeys = [...persistedKeys, ...draftChainKeys.filter((key) => !persistedKeys.includes(key))];

  const setRetry = (patch: Partial<RetryConfig>) => void save({ ...settings, retry: { ...retry, ...patch } });

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

  const unconfiguredRoles = NATIVE_MODEL_ROLES.filter((role) => !visibleKeys.includes(role));
  const unconfiguredWildcards = providers.map((provider) => `${provider}/*`).filter((wildcard) => !visibleKeys.includes(wildcard));

  const defaultHasEntries = (chains["default"] ?? []).length > 0;
  const otherRoleHasEntries = NATIVE_MODEL_ROLES.some((role) => role !== "default" && (chains[role] ?? []).length > 0);
  const showDefaultCaution = !defaultHasEntries && otherRoleHasEntries;

  const revertPolicy = REVERT_POLICIES.find((entry) => entry.value === (retry.fallbackRevertPolicy ?? "cooldown-expiry")) ?? REVERT_POLICIES[0];
  const reservePolicy = RESERVE_POLICIES.find((entry) => entry.value === (retry.usageReservePolicy ?? "confirm")) ?? RESERVE_POLICIES[0];

  const runReset = async () => {
    setResetting(true);
    try {
      const response = await fetch("/api/omp-settings", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sections: ["retry"] }) });
      const data = await response.json() as { settings?: RetrySettings; restarted?: number; active?: number; error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setSettings(data.settings ?? {});
      setDraftChainKeys([]);
      setCandidateByKey({});
      setResetOpen(false);
      const restarted = data.restarted ?? 0;
      const active = data.active ?? 0;
      toast.success(
        "OMP retry & fallback defaults restored",
        `Applied to ${restarted} idle session${restarted === 1 ? "" : "s"}.${active > 0 ? ` ${active} running session${active === 1 ? "" : "s"} will keep the previous settings until it finishes.` : ""}`,
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error("Could not reset retry & fallback settings", message);
    } finally {
      setResetting(false);
    }
  };

  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <div>
      <SectionTitle>Retry &amp; Fallback</SectionTitle>
      <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
        When a model call fails, OMP retries it, then — if allowed — falls back to another model before giving up on the turn.
      </p>
    </div>

    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={groupLabelStyle}>Retry</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 9 }}>
        <label style={cardStyle}><input type="checkbox" checked={retry.enabled ?? true} onChange={(event) => setRetry({ enabled: event.target.checked })} /> Retry transient errors</label>
        <label style={cardStyle}>Retry attempts <select value={retry.maxRetries ?? 10} onChange={(event) => setRetry({ maxRetries: Number(event.target.value) })} style={selectStyle}>{RETRY_ATTEMPT_OPTIONS.map((count) => <option key={count} value={count}>{retryAttemptLabel(count)}</option>)}</select></label>
        <label style={{ ...cardStyle, gridColumn: "1 / -1" }}>
          Return to primary model <select value={retry.fallbackRevertPolicy ?? "cooldown-expiry"} onChange={(event) => setRetry({ fallbackRevertPolicy: event.target.value as FallbackRevertPolicy })} style={selectStyle}>{REVERT_POLICIES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select>
          <p style={helpTextStyle}>{revertPolicy.description}</p>
        </label>
      </div>
    </section>

    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={groupLabelStyle}>Fallback</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 9 }}>
        <label style={cardStyle}><input type="checkbox" checked={retry.modelFallback ?? true} onChange={(event) => setRetry({ modelFallback: event.target.checked })} /> Allow model fallback</label>
        <label style={cardStyle}>
          <input type="checkbox" checked={retry.usageAwareFallback ?? false} onChange={(event) => setRetry({ usageAwareFallback: event.target.checked })} /> Usage-aware fallback
          <p style={helpTextStyle}>Moves off a provider before it hits a hard usage limit, using coding-plan quota reports.</p>
        </label>
      </div>
      {(retry.usageAwareFallback ?? false) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 9 }}>
          <label style={cardStyle}>Reserve margin <select value={retry.usageReservePct ?? 10} onChange={(event) => setRetry({ usageReservePct: Number(event.target.value) })} style={selectStyle}>{RESERVE_PCT_OPTIONS.map((pct) => <option key={pct} value={pct}>{pct}%{pct === 10 ? " (OMP default)" : ""}</option>)}</select></label>
          <label style={cardStyle}>
            Reserve policy <select value={retry.usageReservePolicy ?? "confirm"} onChange={(event) => setRetry({ usageReservePolicy: event.target.value as UsageReservePolicy })} style={selectStyle}>{RESERVE_POLICIES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select>
            <p style={helpTextStyle}>{reservePolicy.description}</p>
          </label>
        </div>
      )}
    </section>

    <section style={sectionCardStyle}>
      <div style={sectionHeaderStyle}>Fallback chains</div>
      <p style={{ margin: 0, padding: "8px 12px", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45, borderTop: "1px solid var(--border)" }}>
        When a model fails, OMP tries these models in order. Each chain is keyed by a role, a specific model, or a provider wildcard. Roles without their own chain use the default chain.
      </p>

      {visibleKeys.length === 0 ? (
        <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>OMP has no fallback chains configured — a failed call simply retries the same model, with nowhere else to go.</p>
          {onOpenModelPlan && <button type="button" onClick={onOpenModelPlan} style={{ alignSelf: "flex-start", padding: 0, border: "none", background: "none", color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Sparkles size={13} /> Generate chains with Plan roles &amp; fallbacks</button>}
        </div>
      ) : (
        <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border)" }}>
          {visibleKeys.map((key) => (
            <ChainCard
              key={key}
              chainKey={key}
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
          <span>The <code>default</code> chain is empty, but other roles have their own chains. Any role without its own chain falls back to <code>default</code> — and would find nothing there.</span>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 10, borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
        <select
          value={addChainSelect}
          onChange={(event) => {
            const value = event.target.value;
            setAddChainSelect(value);
            if (value && value !== "__custom__") { addChainCard(value); setAddChainSelect(""); }
          }}
          style={{ padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
        >
          <option value="">Add chain for...</option>
          {unconfiguredRoles.length > 0 && <optgroup label="Role">{unconfiguredRoles.map((role) => <option key={role} value={role}>{role}</option>)}</optgroup>}
          {unconfiguredWildcards.length > 0 && <optgroup label="Provider">{unconfiguredWildcards.map((wildcard) => <option key={wildcard} value={wildcard}>{wildcard}</option>)}</optgroup>}
          <optgroup label="Model"><option value="__custom__">Custom key...</option></optgroup>
        </select>
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
              onClick={() => { addChainCard(customChainKey); setCustomChainKey(""); setAddChainSelect(""); }}
              style={{ padding: "6px 10px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", fontSize: 12, cursor: customChainKey.trim() ? "pointer" : "default", opacity: customChainKey.trim() ? 1 : 0.6 }}
            >Add</button>
          </>
        )}
      </div>
    </section>

    {error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 12 }}>{error}</div>}

    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <button
        type="button"
        onClick={() => setResetOpen(true)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--status-error)", borderRadius: "var(--radius-control)", background: "none", color: "var(--status-error)", fontSize: 12, fontWeight: 500, cursor: "pointer" }}
      >
        <RotateCcw size={13} /> Reset to OMP defaults
      </button>
    </div>

    <ConfirmDialog
      open={resetOpen}
      onOpenChange={setResetOpen}
      title="Reset retry & fallback to OMP defaults?"
      description="This deletes all retry and fallback customization — including every fallback chain you've configured — and lets OMP's built-in defaults take over. Idle sessions pick this up immediately; sessions mid-turn keep their current settings until they finish."
      confirmLabel="Reset to defaults"
      cancelLabel="Cancel"
      danger
      busy={resetting}
      onConfirm={() => void runReset()}
    />
  </div>;
}
