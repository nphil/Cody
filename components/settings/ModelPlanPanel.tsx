"use client";

import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, Check, Loader2, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { NativeSetting, ToggleSwitch, nativeSelectStyle } from "./primitives";

/**
 * Proposes a model for every omp role plus the retry fallback chains that go
 * with them, then lets the user edit the proposal before it is written to
 * config.yml. Rendered as the last setup-wizard step and as a Settings detail;
 * the wizard passes the callbacks it needs to advance, Settings passes none.
 *
 * The fallback chains are the reason this exists. omp resolves a subagent's
 * chain as fallbackChains[roleName] ?? fallbackChains.default, so a config
 * holding only provider wildcard keys leaves subagents with no chain at all and
 * their first usage limit kills the turn. The plan therefore always carries
 * role-keyed entries, and the editor keeps role keys visually separate from
 * wildcard keys so a user pruning entries can see which ones subagents inherit.
 */

interface PlannerCandidate {
  selector: string;
  label: string;
  provider: string;
}

interface ModelPlanSnapshot {
  plannerCandidates: PlannerCandidate[];
  suggested: string | null;
  roles: Record<string, string>;
  chains: Record<string, string[]>;
  usageAwareFallback: boolean;
  roleNames: string[];
}

interface RationaleLine {
  subject: string;
  text: string;
}

interface ModelPlan {
  roles: Record<string, string>;
  chains: Record<string, string[]>;
  usageAwareFallback: boolean;
  rationale: RationaleLine[];
}

interface RosterModel {
  id: string;
  name: string;
  provider: string;
}

type Phase = "loading" | "failed" | "consent" | "planning" | "review";

/** Sentinel select value: propose without calling a model at all. */
const HEURISTIC = "heuristic";

/** The plan can name a role Cody has no blurb for (omp gains roles over time);
 * only roles listed here get a description, the rest render bare. */
const DESCRIBED_ROLES: Record<string, true> = {
  default: true, smol: true, slow: true, vision: true, plan: true,
  designer: true, commit: true, tiny: true, task: true, advisor: true,
};

/** A live model call against a cold provider is slow; the bar is paced against
 * this so it reads as progress rather than an indefinite spinner. */
const EXPECTED_PLAN_SECONDS = 120;

const buttonPrimary: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  minHeight: 34,
  padding: "0 14px",
  border: "none",
  borderRadius: "var(--radius-control)",
  background: "var(--accent)",
  color: "var(--on-accent)",
  fontSize: 12,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
};

const buttonGhost: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  minHeight: 34,
  padding: "0 14px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "transparent",
  color: "var(--text-muted)",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "inherit",
  cursor: "pointer",
};

const iconButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  flexShrink: 0,
};

function disabledStyle(base: React.CSSProperties, disabled: boolean): React.CSSProperties {
  return disabled ? { ...base, opacity: 0.55, cursor: "default" } : base;
}

async function errorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `HTTP ${response.status}`;
}

function reason(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** `provider/model:effort` split so a select can match on the model while the
 * reasoning effort the plan asked for survives an edit. */
function splitSelector(selector: string): { base: string; effort: string } {
  const match = selector.match(/:([^,:/]+)$/);
  return match ? { base: selector.slice(0, match.index), effort: match[1] } : { base: selector, effort: "" };
}

export function ModelPlanPanel({ onApplied, onSkip, compact }: {
  /** Wizard only: the plan was written, move on. */
  onApplied?: () => void;
  /** Wizard only: leave this for later. Omitted in Settings, where the user
   * simply navigates away. */
  onSkip?: () => void;
  /** Hides the panel's own heading, for surfaces that already show one. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("loading");
  const [snapshot, setSnapshot] = useState<ModelPlanSnapshot | null>(null);
  const [roster, setRoster] = useState<RosterModel[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [planner, setPlanner] = useState<string>(HEURISTIC);
  const [elapsed, setElapsed] = useState(0);
  const [planError, setPlanError] = useState<string | null>(null);

  const [roles, setRoles] = useState<Record<string, string>>({});
  const [chains, setChains] = useState<Record<string, string[]>>({});
  const [usageAware, setUsageAware] = useState(true);
  const [rationale, setRationale] = useState<RationaleLine[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [source, setSource] = useState<"llm" | "heuristic">("heuristic");
  const [plannerUsed, setPlannerUsed] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const planAbort = useRef<AbortController | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setPhase("loading");
    setLoadError(null);
    try {
      const response = await fetch("/api/model-plan", { cache: "no-store", signal });
      if (!response.ok) throw new Error(await errorText(response));
      const data = (await response.json()) as ModelPlanSnapshot;
      if (signal?.aborted) return;
      setSnapshot(data);
      setPlanner(data.suggested ?? HEURISTIC);
      setPhase("consent");
    } catch (failure) {
      if (signal?.aborted) return;
      setLoadError(reason(failure));
      setPhase("failed");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    // The roster drives the per-role select. It is a separate concern from the
    // plan itself, so a failure here only narrows the options, never blocks.
    void fetch("/api/models", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { modelList?: RosterModel[] } | null) => {
        if (!controller.signal.aborted) setRoster(data?.modelList ?? []);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (phase !== "planning") return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => () => planAbort.current?.abort(), []);

  const propose = useCallback(async () => {
    // A second click in the same tick would fire another live model call: the
    // phase-driven disabled state only lands on the next render.
    if (planAbort.current) return;
    const controller = new AbortController();
    planAbort.current = controller;
    const usingModel = planner !== HEURISTIC;
    setPhase("planning");
    setPlanError(null);
    try {
      const response = await fetch("/api/model-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(usingModel ? { plannerModel: planner, mode: "llm" } : { mode: "heuristic" }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await errorText(response));
      const data = (await response.json()) as { plan: ModelPlan; source: "llm" | "heuristic"; warnings?: string[] };
      if (controller.signal.aborted) return;
      setRoles(data.plan.roles ?? {});
      setChains(data.plan.chains ?? {});
      setUsageAware(data.plan.usageAwareFallback ?? true);
      setRationale(data.plan.rationale ?? []);
      setWarnings(data.warnings ?? []);
      setSource(data.source);
      setPlannerUsed(data.source === "llm" && usingModel ? planner : null);
      setPhase("review");
    } catch (failure) {
      if (controller.signal.aborted) return;
      setPlanError(reason(failure));
      setPhase("consent");
    } finally {
      if (planAbort.current === controller) planAbort.current = null;
    }
  }, [planner]);

  const cancelPlanning = useCallback(() => {
    planAbort.current?.abort();
    planAbort.current = null;
    setPhase("consent");
  }, []);

  const apply = useCallback(async () => {
    setApplying(true);
    try {
      // An emptied chain is an edit, not a value: omp treats a present-but-empty
      // chain as "no fallback", which is exactly what the key was there to stop.
      const payloadChains = Object.fromEntries(
        Object.entries(chains).filter(([, entries]) => entries.length > 0),
      );
      const payloadRoles = Object.fromEntries(
        Object.entries(roles).filter(([, selector]) => selector.trim() !== ""),
      );
      const response = await fetch("/api/model-plan", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: payloadRoles, chains: payloadChains, usageAwareFallback: usageAware }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      const result = (await response.json().catch(() => null)) as { restarted?: number; active?: number } | null;
      // Say how the plan reaches live sessions: idle ones were restarted onto
      // it; running ones keep the old plan until their current run ends.
      toast.success(
        t("modelPlan.applied"),
        result && result.active
          ? t("modelPlan.appliedActiveNote", { count: String(result.active) })
          : t("modelPlan.appliedNote"),
      );
      onApplied?.();
    } catch (failure) {
      // The edits stay on screen: a failed write must not cost the user the
      // review they just did.
      toast.error(t("modelPlan.applyFailed"), reason(failure));
    } finally {
      setApplying(false);
    }
  }, [chains, roles, usageAware, onApplied, t]);

  // Memoized because chainGroups depends on it: a fresh [] every render would
  // re-split the chains on every edit in the review form.
  const roleNames = useMemo(() => snapshot?.roleNames ?? [], [snapshot]);
  const rosterSelectors = useMemo(
    () => roster.map((model) => ({ selector: `${model.provider}/${model.id}`, label: model.name || model.id })),
    [roster],
  );

  const chainGroups = useMemo(() => {
    const roleKeys = new Set([...roleNames, "default"]);
    const role: Array<[string, string[]]> = [];
    const wildcard: Array<[string, string[]]> = [];
    for (const entry of Object.entries(chains)) {
      (roleKeys.has(entry[0]) ? role : wildcard).push(entry);
    }
    return { role, wildcard };
  }, [chains, roleNames]);

  const setRole = (role: string, base: string) => {
    setRoles((current) => {
      const { effort } = splitSelector(current[role] ?? "");
      return { ...current, [role]: base ? `${base}${effort ? `:${effort}` : ""}` : "" };
    });
  };

  const moveChainEntry = (key: string, index: number, delta: number) => {
    setChains((current) => {
      const entries = [...(current[key] ?? [])];
      const target = index + delta;
      if (target < 0 || target >= entries.length) return current;
      [entries[index], entries[target]] = [entries[target], entries[index]];
      return { ...current, [key]: entries };
    });
  };

  const removeChainEntry = (key: string, index: number) => {
    setChains((current) => ({ ...current, [key]: (current[key] ?? []).filter((_, at) => at !== index) }));
  };

  const heading = compact ? null : (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
        {t("modelPlan.settingsTitle")}
      </div>
      <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {t("modelPlan.settingsDescription")}
      </p>
    </div>
  );

  const skipButton = onSkip
    ? (
      <button type="button" style={buttonGhost} onClick={onSkip}>
        {t("modelPlan.skip")}
      </button>
    )
    : null;

  if (phase === "loading") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {heading}
        <div className="setup-wizard-card" role="status" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
          <span>{t("modelPlan.loading")}</span>
        </div>
      </div>
    );
  }

  if (phase === "failed") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {heading}
        <div className="setup-wizard-card">
          <p style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--status-error)" }}>
            <AlertCircle size={14} aria-hidden /> {t("modelPlan.loadFailed")}
          </p>
          {loadError && <p style={{ fontSize: 11.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)", wordBreak: "break-word" }}>{loadError}</p>}
          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
            <button type="button" style={buttonPrimary} onClick={() => void load()}>{t("modelPlan.retry")}</button>
            {skipButton}
          </div>
        </div>
      </div>
    );
  }

  if (phase === "planning") {
    const share = Math.min(95, Math.round((elapsed / EXPECTED_PLAN_SECONDS) * 100));
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {heading}
        <div className="setup-wizard-card">
          <p style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--text)", fontWeight: 600 }}>
            <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
            {t("modelPlan.planningTitle")}
          </p>
          <p>{t("modelPlan.planningNote")}</p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={EXPECTED_PLAN_SECONDS}
            aria-valuenow={Math.min(elapsed, EXPECTED_PLAN_SECONDS)}
            aria-label={t("modelPlan.planningTitle")}
            style={{ height: 4, borderRadius: 2, background: "var(--bg-hover)", overflow: "hidden" }}
          >
            <div style={{ width: `${share}%`, height: "100%", background: "var(--accent)", transition: "width var(--dur-slow) linear" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span className="setup-wizard-note">{t("modelPlan.planningElapsed", { seconds: String(elapsed) })}</span>
            <button type="button" style={buttonGhost} onClick={cancelPlanning}>{t("modelPlan.cancel")}</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "consent") {
    const candidates = snapshot?.plannerCandidates ?? [];
    const currentRoles = Object.entries(snapshot?.roles ?? {}).filter(([, selector]) => selector);
    const currentChains = Object.entries(snapshot?.chains ?? {});
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {heading}
        <div className="setup-wizard-card">
          <p>{t("modelPlan.consentLead")}</p>
          <p>{t("modelPlan.consentWhy")}</p>

          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
            {currentRoles.length === 0 && currentChains.length === 0
              ? <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{t("modelPlan.currentNone")}</span>
              : (
                <>
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                    {t("modelPlan.currentSummary", { roles: String(currentRoles.length), chains: String(currentChains.length) })}
                  </span>
                  {currentRoles.map(([role, selector]) => (
                    <div key={role} style={{ display: "flex", gap: 8, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
                      <span style={{ minWidth: 68, color: "var(--text-muted)" }}>{role}</span>
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selector}</span>
                    </div>
                  ))}
                  {currentChains.length > 0 && (
                    <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", wordBreak: "break-word" }}>
                      {currentChains.map(([key, entries]) => `${key} (${entries.length})`).join("  ")}
                    </div>
                  )}
                </>
              )}
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text)" }}>
            <span style={{ fontWeight: 600 }}>{t("modelPlan.plannerLabel")}</span>
            <select
              value={planner}
              onChange={(event) => setPlanner(event.target.value)}
              style={{ ...nativeSelectStyle, minHeight: 34, width: "100%" }}
            >
              {candidates.map((candidate) => (
                <option key={candidate.selector} value={candidate.selector}>
                  {candidate.label} ({candidate.selector})
                </option>
              ))}
              <option value={HEURISTIC}>{t("modelPlan.plannerHeuristic")}</option>
            </select>
          </label>
          <p className="setup-wizard-note">
            {candidates.length === 0 ? t("modelPlan.plannerNone") : t("modelPlan.plannerNote")}
          </p>

          {planError && (
            <p className="setup-wizard-error" role="alert">
              <AlertCircle size={13} aria-hidden /> {t("modelPlan.proposeFailed")} {planError}
            </p>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 2, flexWrap: "wrap" }}>
            <button type="button" style={buttonPrimary} onClick={() => void propose()}>
              <Sparkles size={14} aria-hidden /> {t("modelPlan.propose")}
            </button>
            {skipButton}
          </div>
        </div>
      </div>
    );
  }

  const plannerLabel = plannerUsed
    ? snapshot?.plannerCandidates.find((candidate) => candidate.selector === plannerUsed)?.label ?? plannerUsed
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {heading}

      {source === "heuristic" && (
        <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderRadius: "var(--radius-card)", border: "1px solid color-mix(in srgb, var(--status-warning) 40%, var(--border))", background: "color-mix(in srgb, var(--status-warning) 8%, var(--bg-panel))", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
          <AlertTriangle size={14} aria-hidden style={{ color: "var(--status-warning)", flexShrink: 0, marginTop: 2 }} />
          <span>{t("modelPlan.heuristicBanner")}</span>
        </div>
      )}

      {warnings.length > 0 && (
        <div style={{ padding: "10px 12px", borderRadius: "var(--radius-card)", border: "1px solid var(--border)", background: "var(--bg-panel)", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{t("modelPlan.warningsTitle")}</div>
          <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 3 }}>
            {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
          </ul>
        </div>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{t("modelPlan.reviewRolesTitle")}</div>
          <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("modelPlan.reviewRolesNote")}</p>
        </div>
        {roleNames.map((role) => {
          const value = roles[role] ?? "";
          const { base, effort } = splitSelector(value);
          const known = !base || rosterSelectors.some((entry) => entry.selector === base);
          return (
            <div key={role} className="model-role-row" style={{ display: "grid", gridTemplateColumns: "minmax(140px, 0.9fr) minmax(0, 1.1fr)", alignItems: "center", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <code style={{ fontSize: 12, color: "var(--text)" }}>{role}</code>
                {effort && <span style={{ marginLeft: 6, fontSize: 10.5, color: "var(--text-dim)" }}>{effort}</span>}
                {DESCRIBED_ROLES[role] && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45, marginTop: 2 }}>{t(`modelPlan.role.${role}`)}</div>
                )}
              </div>
              <select
                value={base}
                aria-label={role}
                onChange={(event) => setRole(role, event.target.value)}
                style={{ ...nativeSelectStyle, minHeight: 32, width: "100%" }}
              >
                <option value="">{t("modelPlan.roleUnset")}</option>
                {!known && <option value={base}>{t("modelPlan.roleUnavailable", { selector: base })}</option>}
                {rosterSelectors.map((entry) => (
                  <option key={entry.selector} value={entry.selector}>{entry.label} ({entry.selector})</option>
                ))}
              </select>
            </div>
          );
        })}
      </section>

      {([
        { key: "role", title: t("modelPlan.chainsRoleTitle"), note: t("modelPlan.chainsRoleNote"), entries: chainGroups.role },
        { key: "wildcard", title: t("modelPlan.chainsWildcardTitle"), note: t("modelPlan.chainsWildcardNote"), entries: chainGroups.wildcard },
      ] as const).filter((group) => group.entries.length > 0).map((group) => (
        <section key={group.key} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{group.title}</div>
            <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{group.note}</p>
          </div>
          {group.entries.map(([key, entries]) => (
            <div key={key} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
              <div style={{ padding: "7px 12px", background: "var(--bg-panel)", fontSize: 11.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{key}</div>
              {entries.length === 0
                ? <div style={{ padding: "8px 12px", fontSize: 11.5, color: "var(--text-dim)" }}>{t("modelPlan.chainEmpty")}</div>
                : entries.map((entry, index) => (
                  <div key={`${entry}-${index}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px 6px 12px", borderTop: "1px solid var(--border)" }}>
                    <span style={{ width: 16, fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>{index + 1}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry}</span>
                    <button type="button" title={t("modelPlan.moveUp")} aria-label={t("modelPlan.moveUp")} disabled={index === 0} onClick={() => moveChainEntry(key, index, -1)} style={disabledStyle(iconButton, index === 0)}>
                      <ArrowUp size={12} aria-hidden />
                    </button>
                    <button type="button" title={t("modelPlan.moveDown")} aria-label={t("modelPlan.moveDown")} disabled={index === entries.length - 1} onClick={() => moveChainEntry(key, index, 1)} style={disabledStyle(iconButton, index === entries.length - 1)}>
                      <ArrowDown size={12} aria-hidden />
                    </button>
                    <button type="button" title={t("modelPlan.remove")} aria-label={t("modelPlan.remove")} onClick={() => removeChainEntry(key, index)} style={iconButton}>
                      <X size={12} aria-hidden />
                    </button>
                  </div>
                ))}
            </div>
          ))}
        </section>
      ))}

      <NativeSetting
        label={t("modelPlan.usageAwareLabel")}
        description={t("modelPlan.usageAwareDescription")}
        searchId="model-plan-usage-aware-fallback"
      >
        <ToggleSwitch checked={usageAware} onChange={setUsageAware} />
      </NativeSetting>

      {rationale.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{t("modelPlan.rationaleTitle")}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {plannerLabel ? t("modelPlan.rationaleFrom", { model: plannerLabel }) : t("modelPlan.rationaleHeuristicFrom")}
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 5 }}>
            {rationale.map((line, index) => (
              <li key={`${line.subject}-${index}`} style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                <code style={{ color: "var(--text)" }}>{line.subject}</code> {line.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={disabledStyle(buttonPrimary, applying)} disabled={applying} onClick={() => void apply()}>
          {applying
            ? <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
            : <Check size={14} aria-hidden />}
          {applying ? t("modelPlan.applying") : t("modelPlan.apply")}
        </button>
        <button type="button" style={disabledStyle(buttonGhost, applying)} disabled={applying} onClick={() => setPhase("consent")}>
          {t("modelPlan.startOver")}
        </button>
        {onSkip && (
          <button type="button" style={disabledStyle(buttonGhost, applying)} disabled={applying} onClick={onSkip}>
            {t("modelPlan.skip")}
          </button>
        )}
      </div>
    </div>
  );
}
