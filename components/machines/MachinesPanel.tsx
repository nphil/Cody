"use client";

import { Server, ServerOff, SlidersHorizontal } from "lucide-react";
import { useMachineMeters } from "@/hooks/useMachineMeters";
import { usageToneColor } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { formatGigabytes, machineDisplayName, machineReasonKey, machineStatusKey, wholePercent } from "@/lib/machines/present";
import type { MachineState } from "@/lib/machines/types";

/**
 * The top-bar dropdown behind the machine meters: one card per machine with
 * exact CPU and memory, cores, load and whether it is online, and the way to
 * Settings where the list is edited. Opens in the same full-width panel the
 * session popover uses (`AppShell` owns the frame).
 */

function Gauge({ label, percent, detail, title }: { label: string; percent: number | null; detail: string; title?: string }) {
  const filled = percent === null ? 0 : wholePercent(percent);
  const color = percent === null ? undefined : usageToneColor(percent);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            color: percent === null ? "var(--text-dim)" : percent >= 70 ? color : "var(--text)",
          }}
        >
          {percent === null ? "…" : `${filled}%`}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: "var(--bg-selected)", overflow: "hidden", marginTop: 4 }}>
        <div
          style={{
            width: `${filled}%`,
            minWidth: filled > 0 ? 2 : 0,
            height: "100%",
            borderRadius: 3,
            background: color ?? "none",
            transition: "width 600ms var(--ease-out-warm), background-color 300ms var(--ease-out-warm)",
          }}
        />
      </div>
      {detail && <div title={title} style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{detail}</div>}
    </div>
  );
}

function MachineCard({ machine }: { machine: MachineState }) {
  const { t, tn } = useI18n();
  const name = machineDisplayName(machine, t);
  const metrics = machine.status === "online" ? machine.metrics : null;
  const statusColor = machine.status === "online"
    ? "var(--status-success)"
    : machine.status === "offline" ? "var(--status-error)" : "var(--text-dim)";
  const Icon = machine.status === "offline" ? ServerOff : Server;

  const cpuDetail = metrics && metrics.cpuPercent !== null
    ? [
      metrics.cores === null ? null : tn("machines.panel.cores", metrics.cores),
      metrics.load1 === null ? null : t("machines.panel.load", { value: metrics.load1.toFixed(2) }),
    ].filter(Boolean).join(" · ")
    : t("machines.panel.waiting");

  return (
    <section
      aria-label={name}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minWidth: 0,
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: "var(--bg)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Icon size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, color: machine.status === "offline" ? "var(--status-error)" : "var(--text-dim)" }} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
          {name}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, fontSize: 11, color: "var(--text-muted)" }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor }} />
          {t(machineStatusKey(machine.status))}
        </span>
      </div>
      {metrics ? (
        <>
          <Gauge
            label={t("machines.panel.cpu")}
            percent={metrics.cpuPercent}
            detail={cpuDetail}
            title={t("machines.panel.loadHint")}
          />
          <Gauge
            label={t("machines.panel.memory")}
            percent={metrics.memPercent}
            detail={t("machines.panel.memoryOf", { used: formatGigabytes(metrics.memUsedBytes), total: formatGigabytes(metrics.memTotalBytes) })}
          />
        </>
      ) : (
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--text-muted)" }}>
          {machine.reason ? t(machineReasonKey(machine.reason)) : t("machines.panel.waiting")}
        </div>
      )}
    </section>
  );
}

export function MachinesPanel({ isMobile, onManage }: { isMobile: boolean; onManage: () => void }) {
  const { t } = useI18n();
  const machines = useMachineMeters()?.machines ?? [];
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        boxShadow: "var(--shadow-pop)",
        padding: "12px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 240px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("machines.panel.title")}</div>
          <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)", marginTop: 2 }}>{t("machines.panel.help")}</div>
        </div>
        <button
          type="button"
          onClick={onManage}
          className="ui-focus-ring"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            background: "transparent",
            color: "var(--accent)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          <SlidersHorizontal size={12} strokeWidth={1.8} aria-hidden="true" />
          {t("machines.panel.manage")}
        </button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 12,
          marginTop: 12,
        }}
      >
        {machines.map((machine) => <MachineCard key={machine.id} machine={machine} />)}
        {machines.length === 0 && (
          <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{t("machines.panel.waiting")}</div>
        )}
      </div>
    </div>
  );
}
