"use client";

import { Bot, Check, CircleAlert, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { DeviceOperationManager, DeviceOperationSnapshot } from "@/lib/devices/operations";
import { describeRoutine, type ActivityBurst, type ActivityEntry } from "@/lib/devices/activity-groups";
import { OperationCard } from "./OperationList";
import { TOUCH } from "./ui";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const summaryStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minHeight: TOUCH,
  padding: "0 12px",
  cursor: "pointer",
  listStyle: "none",
} as const;

function RowIcon({ state }: { state: DeviceOperationSnapshot["state"] }): React.ReactElement {
  if (state === "succeeded") return <Check size={15} aria-hidden="true" style={{ flexShrink: 0, color: "var(--status-success)" }} />;
  if (state === "failed") return <CircleAlert size={15} aria-hidden="true" style={{ flexShrink: 0, color: "var(--status-error)" }} />;
  return <X size={15} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }} />;
}

/** One routine command inside a burst: what it was and what came of it; opening it shows its full card. */
function BurstRow({ manager, operation, deviceLabel }: { manager: DeviceOperationManager; operation: DeviceOperationSnapshot; deviceLabel: string }): React.ReactElement {
  const { title, outcome } = describeRoutine(operation);
  return (
    <details className="dv-disclosure" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
      <summary className="ui-focus-ring" style={summaryStyle}>
        <RowIcon state={operation.state} />
        <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
          <code style={{ fontSize: 12, color: "var(--text)", overflowWrap: "anywhere" }}>{title}</code>
          {outcome && <span style={{ fontSize: 12, color: operation.state === "succeeded" ? "var(--text-muted)" : "var(--status-error)", overflowWrap: "anywhere" }}>{outcome}</span>}
        </span>
      </summary>
      <div style={{ padding: "4px 8px 8px" }}>
        <OperationCard manager={manager} operation={operation} deviceLabel={deviceLabel} />
      </div>
    </details>
  );
}

function burstMeta(burst: ActivityBurst, t: Translate): string {
  const seconds = Math.max(1, Math.round((burst.endedAt - burst.startedAt) / 1000));
  return [
    t("devices.burstSeconds", { seconds }),
    burst.succeeded > 0 ? t("devices.burstOk", { count: burst.succeeded }) : "",
    burst.failed > 0 ? t("devices.burstFailed", { count: burst.failed }) : "",
    burst.cancelled > 0 ? t("devices.burstCancelled", { count: burst.cancelled }) : "",
  ].filter(Boolean).join(" · ");
}

/** A run of routine agent commands as one compact entry; every command stays one tap away. */
function BurstEntry({ manager, burst, deviceLabel }: { manager: DeviceOperationManager; burst: ActivityBurst; deviceLabel: string }): React.ReactElement {
  const { t, tn } = useI18n();
  const protocol = burst.protocols.join(" + ");
  const count = burst.operations.length;
  const title = count === 1
    ? t("devices.burstOne", { protocol, command: describeRoutine(burst.operations[0]).title })
    : tn("devices.burstTitle", count, { protocol });
  const problems = burst.failed + burst.cancelled > 0;
  return (
    <details className="dv-disclosure" data-burst={burst.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}>
      <summary className="ui-focus-ring" style={summaryStyle}>
        <Bot size={16} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-muted)" }} />
        <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflowWrap: "anywhere" }}>{title}</span>
          <span style={{ fontSize: 12, color: problems ? "var(--status-warning)" : "var(--text-muted)" }}>{burstMeta(burst, t)}</span>
        </span>
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 8px 8px" }}>
        {burst.operations.map((operation) => <BurstRow key={operation.id} manager={manager} operation={operation} deviceLabel={deviceLabel} />)}
      </div>
    </details>
  );
}

/**
 * The activity of one device, in the order `groupActivity` gives it: what needs the person first, then newest first.
 * An operation that is waiting, running or significant keeps its full card; routine agent commands are folded into
 * bursts.
 */
export function ActivityFeed({ manager, entries, deviceLabel }: { manager: DeviceOperationManager; entries: readonly ActivityEntry[]; deviceLabel: string }): React.ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {entries.map((entry) => entry.kind === "burst"
        ? <BurstEntry key={`burst-${entry.id}`} manager={manager} burst={entry} deviceLabel={deviceLabel} />
        : <OperationCard key={entry.operation.id} manager={manager} operation={entry.operation} deviceLabel={deviceLabel} />)}
    </div>
  );
}
