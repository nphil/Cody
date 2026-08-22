"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Activity, Bot, ChevronDown,
  CircleDollarSign, Clock3, Cpu, Gauge, GitBranch, Network, RefreshCw,
  UserRound, Wrench, type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { SubagentInfo } from "@/hooks/useAgentSession";
import type { TodoPhase } from "@/lib/pi-types";
import { countNestedSubagents, formatCost, formatDuration, formatTokens, shortModel } from "@/lib/subagent-format";
import { TodoList } from "./TodoList";
import { SubagentStatusIcon } from "./SubagentStatusIcon";

const SUBAGENT_STATE_KEYS: Record<SubagentInfo["status"], string> = {
  started: "chatWindow.subagentState.started",
  completed: "chatWindow.subagentState.completed",
  failed: "chatWindow.subagentState.failed",
  aborted: "chatWindow.subagentState.aborted",
};

function SubagentStatusBadge({ subagent }: { subagent: SubagentInfo }) {
  return <SubagentStatusIcon status={subagent.status} live={subagent.source !== "history"} />;
}

/** Icon-first telemetry keeps the compact roster scannable without label noise. */
function SubagentMetric({ icon: Icon, label, children }: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-label={label}
      title={label}
      data-subagent-metric={label}
      style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      <Icon size={11} strokeWidth={1.8} aria-hidden />
      <span>{children}</span>
    </span>
  );
}

/** Compact live/secondary line under a chip label (tool, retry, telemetry). */
function SubagentActivityLine({ subagent }: { subagent: SubagentInfo }) {
  const { t } = useI18n();
  const progress = subagent.progress;
  const retryActive = Boolean(progress?.retryState ?? progress?.retryFailure);
  const parts: ReactNode[] = [];

  if (retryActive) {
    const attempt = progress?.retryState?.attempt ?? progress?.retryFailure?.attempt ?? 0;
    const maxAttempts = progress?.retryState?.maxAttempts ?? 0;
    const label = maxAttempts > 0
      ? t("chatWindow.subagentRetrying", { attempt, max: maxAttempts })
      : t("chatWindow.subagentRetryAttempt", { attempt });
    parts.push(
      <SubagentMetric key="retry" icon={RefreshCw} label={label}>
        {maxAttempts > 0 ? `${attempt}/${maxAttempts}` : attempt}
      </SubagentMetric>,
    );
  } else if (subagent.status === "started") {
    const activity = progress?.currentTool
      ? `${progress.currentTool}${progress.lastIntent ? `: ${progress.lastIntent}` : ""}`
      : progress?.lastIntent;
    if (activity) {
      parts.push(
        <SubagentMetric key="activity" icon={progress?.currentTool ? Wrench : Activity} label={activity}>
          {activity}
        </SubagentMetric>,
      );
    }
  }

  const nested = countNestedSubagents(progress);
  const source = subagent.agentSource && subagent.agentSource !== "bundled" ? subagent.agentSource : null;
  const tokens = formatTokens(progress?.tokens);
  const cost = formatCost(progress?.cost);
  const ctxTokens = formatTokens(progress?.contextTokens);
  const context = ctxTokens
    ? `${ctxTokens}/${formatTokens(progress?.contextWindow) ?? "?"}`
    : null;
  const model = shortModel(progress?.resolvedModel);
  const duration = subagent.source === "history" ? formatDuration(progress?.durationMs) : null;
  const meta: ReactNode[] = [
    source ? <SubagentMetric key="source" icon={UserRound} label={source}>{source === "user" ? null : source}</SubagentMetric> : null,
    nested > 0 ? <SubagentMetric key="nested" icon={GitBranch} label={t("chatWindow.subagentNestedCount", { count: nested })}>{nested}</SubagentMetric> : null,
    tokens ? <SubagentMetric key="tokens" icon={Cpu} label={t("chatWindow.tokensUnit", { count: tokens })}>{tokens}</SubagentMetric> : null,
    cost ? <SubagentMetric key="cost" icon={CircleDollarSign} label={cost}>{cost}</SubagentMetric> : null,
    context ? <SubagentMetric key="context" icon={Gauge} label={t("chatWindow.contextGauge", { used: ctxTokens ?? "?", total: formatTokens(progress?.contextWindow) ?? "?" })}>{context}</SubagentMetric> : null,
    model ? <SubagentMetric key="model" icon={Bot} label={model}>{model}</SubagentMetric> : null,
    duration ? <SubagentMetric key="duration" icon={Clock3} label={duration}>{duration}</SubagentMetric> : null,
  ].filter(Boolean);
  if (meta.length > 0) {
    parts.push(
      <span key="meta" style={{ display: "inline-flex", flexWrap: "wrap", gap: "2px 7px" }}>
        {meta}
      </span>,
    );
  }

  if (parts.length === 0) return null;
  return (
    <span
      style={{
        display: "flex",
        minWidth: 0,
        overflow: "hidden",
        fontSize: 10.5,
        fontFamily: "var(--font-mono)",
        color: retryActive ? "var(--accent)" : "var(--text-dim)",
        lineHeight: 1.4,
        gap: 7,
        flexWrap: "wrap",
      }}
    >
      {parts}
    </span>
  );
}

/** Default number of roster chips shown before the list truncates behind the
 * "Show all" toggle. */
const MAX_VISIBLE_SUBAGENTS = 7;

/** Roster display order: agents still working (`started`) come first, settled
 * ones (completed / failed / aborted) after, each group keeping its incoming
 * relative order. When `showAll` is off and the roster exceeds
 * `MAX_VISIBLE_SUBAGENTS`, actives claim the visible slots first and the
 * remainder is filled with the most recent terminal agents. */
export function selectVisibleSubagents(subagents: SubagentInfo[], showAll: boolean): SubagentInfo[] {
  const active = subagents.filter((subagent) => subagent.status === "started");
  const terminal = subagents.filter((subagent) => subagent.status !== "started");
  if (showAll || subagents.length <= MAX_VISIBLE_SUBAGENTS) return [...active, ...terminal];
  const visibleActive = active.slice(0, MAX_VISIBLE_SUBAGENTS);
  const terminalSlots = MAX_VISIBLE_SUBAGENTS - visibleActive.length;
  return terminalSlots > 0 ? [...visibleActive, ...terminal.slice(-terminalSlots)] : visibleActive;
}

/** Chip entrance motion, component-scoped: globals.css belongs to another
 * surface, so the class/keyframes names are unique to this panel. Newly
 * mounted chips fade/rise in; reduced motion disables the animation. */
const CHIP_MOTION_CSS = `
@keyframes composer-chip-in {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: none; }
}
.composer-roster-chip { animation: composer-chip-in var(--dur-fast) var(--ease-out-warm) both; }
@media (prefers-reduced-motion: reduce) {
  .composer-roster-chip { animation: none; }
}
`;

function SubagentsPanel({ subagents, onSelectSubagent, defaultExpanded = false }: {
  subagents: SubagentInfo[];
  onSelectSubagent: (subagent: SubagentInfo) => void;
  /** Initial expansion (default: collapsed — the header still shows the live summary). */
  defaultExpanded?: boolean;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(!defaultExpanded);
  const [showAll, setShowAll] = useState(false);
  const runningCount = subagents.filter((subagent) => subagent.source !== "history" && subagent.status === "started").length;

  // An emptied roster means a new run: the next roster starts truncated again.
  const emptied = subagents.length === 0;
  useEffect(() => {
    if (emptied) setShowAll(false);
  }, [emptied]);

  if (subagents.length === 0) return null;

  const visibleSubagents = selectVisibleSubagents(subagents, showAll);
  const truncatable = subagents.length > MAX_VISIBLE_SUBAGENTS;

  return (
    <section
      aria-label={t("chatWindow.subagentsPanel")}
      className="overflow-hidden border border-border bg-bg-subtle"
      style={{ borderRadius: "var(--radius-card)", width: "100%" }}
    >
      <style>{CHIP_MOTION_CSS}</style>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? t("chatWindow.expandPanel") : t("chatWindow.collapsePanel")}
        className={`ui-focus-ring flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-text-muted ${collapsed ? "" : "border-b border-border"}`}
        style={{ background: "none" }}
      >
        <Network size={14} strokeWidth={1.8} aria-hidden />
        <strong className="font-medium text-text">{t("chatWindow.subagentsPanel")}</strong>
        <span
          className="ml-auto inline-flex items-center gap-1.5"
          aria-label={t("chatWindow.subagentSummary", { running: runningCount, total: subagents.length })}
          title={t("chatWindow.subagentSummary", { running: runningCount, total: subagents.length })}
        >
          <span>{runningCount}/{subagents.length}</span>
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          aria-hidden
          style={{
            color: "var(--text-dim)",
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            transition: "transform var(--dur-fast) var(--ease-out-warm)",
          }}
        />
      </button>
      {!collapsed && (
        <div
          className="grid gap-1.5 px-3 py-2.5"
          // Equal-width columns instead of a content-hugging flex wrap: chips
          // whose labels truncate to near-identical text otherwise render at
          // ragged widths, and each wrap row ends mid-air.
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", maxHeight: "min(30vh, 240px)", overflowY: "auto" }}
        >
          {visibleSubagents.map((subagent) => {
            const stateLabel = t(SUBAGENT_STATE_KEYS[subagent.status]);
            const label = `${subagent.agent} · ${stateLabel} · ${subagent.task ?? subagent.description ?? ""}`.replace(/\s+$/, "");
            const live = subagent.source !== "history";
            return (
              <button
                key={subagent.id}
                type="button"
                className="ui-focus-ring composer-roster-chip"
                onClick={() => onSelectSubagent(subagent)}
                aria-label={label}
                title={`${label}${subagent.detached ? " (async)" : ""}`}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1,
                  minWidth: 0, padding: "5px 9px",
                  border: "1px solid color-mix(in srgb, var(--border) 86%, transparent)",
                  borderRadius: "var(--radius-control)",
                  background: "var(--bg)",
                  fontSize: 11.5,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  color: live && subagent.status === "started" ? "var(--text)" : "var(--text-dim)",
                  opacity: live && subagent.status === "started" ? 1 : 0.72,
                  transition: "border-color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 40%, var(--border))";
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "color-mix(in srgb, var(--border) 86%, transparent)";
                  e.currentTarget.style.background = "var(--bg)";
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, width: "100%" }}>
                  <SubagentStatusBadge subagent={subagent} />
                  <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 10.5, color: "var(--accent)", flexShrink: 0 }}>
                    {subagent.agent}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
                    {subagent.task ?? subagent.description ?? stateLabel}
                  </span>
                  {subagent.detached && (
                    <span
                      aria-hidden
                      style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, fontFamily: "var(--font-mono)" }}
                    >
                      ⤴
                    </span>
                  )}
                </span>
                <SubagentActivityLine subagent={subagent} />
              </button>
            );
          })}
        </div>
      )}
      {!collapsed && truncatable && (
        // Footer link, not a chip in the grid: mirrors TodoList's own
        // "Show all tasks" footer so the two panels read as one family.
        <button
          type="button"
          className="ui-focus-ring w-full cursor-pointer border-t border-border bg-transparent px-3 py-2 text-left text-xs text-accent hover:text-accent-hover"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? t("chatWindow.subagentShowFewer") : t("chatWindow.subagentShowAll", { count: subagents.length })}
        </button>
      )}
    </section>
  );
}

/** Session panels attached to the composer: live todo plan + running
 * subagent roster. Both render as FULL-WIDTH stacked rows aligned to the
 * composer, whatever their expansion state — a collapsed panel is a slim
 * full-width header bar, an expanded one the same bar plus its body. The
 * earlier fit-content/side-by-side layout produced every combination of
 * floating chip beside tall card at a different width; rows keep the two
 * headers (icon · title · count · chevron) vertically aligned in all four
 * states. Each panel is independently collapsible via its header and starts
 * collapsed; the headers always show live progress / running-summary over
 * the full roster, even while the chip list is truncated. */
export function ComposerPanels({ todoPhases, subagents, onSelectSubagent, defaultExpanded = false }: {
  todoPhases: TodoPhase[];
  subagents: SubagentInfo[];
  onSelectSubagent: (subagent: SubagentInfo) => void;
  /** Initial expansion of both panels (default: collapsed). */
  defaultExpanded?: boolean;
}) {
  if (todoPhases.length === 0 && subagents.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
      <TodoList phases={todoPhases} collapsible defaultExpanded={defaultExpanded} />
      <SubagentsPanel subagents={subagents} onSelectSubagent={onSelectSubagent} defaultExpanded={defaultExpanded} />
    </div>
  );
}
