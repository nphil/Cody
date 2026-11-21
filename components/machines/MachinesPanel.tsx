"use client";

import { Server, ServerOff, SlidersHorizontal } from "lucide-react";
import { useMachineMeters } from "@/hooks/useMachineMeters";
import { usageToneColor } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { formatGigabytes, machineDisplayName, machineMemoryUsedBytes, machineReasonKey, machineStatusKey, wholePercent } from "@/lib/machines/present";
import type { MachineState } from "@/lib/machines/types";

/**
 * The top-bar dropdown behind the machine meters: one card per machine with
 * exact CPU and memory, cores, load and whether it is online, and the way to
 * Settings where the list is edited. Opens in the same full-width panel the
 * session popover uses (`AppShell` owns the frame).
 */

/** The whole-machine layer of a bar: a grey that shows on the track in every
 * theme (the text colours are always legible on the panel) and leaves the
 * accent, Cody's own colour, clear to read on top of it. */
const MACHINE_LAYER = "color-mix(in srgb, var(--text-muted) 45%, var(--bg-selected))";

/** Cores in use as a plain figure: one decimal, two when it is a sliver (never "0.0"). */
function coresUsed(percent: number, cores: number): string {
  const used = (percent / 100) * cores;
  return used > 0 && used < 0.1 ? Math.max(used, 0.01).toFixed(2) : used.toFixed(1);
}

function clampPercent(value: number | null): number {
  return value === null ? 0 : wholePercent(value);
}

/**
 * One bar, two layers: the whole machine's use in grey and Cody's own share on
 * top of it in the accent colour. Cody's part is part of the machine's, so it is
 * never drawn longer than the grey (two readings a moment apart can disagree by
 * a hair). Without a Cody figure the bar is the machine's alone, in the accent
 * as it always was.
 */
function Gauge({ label, codyPercent, machinePercent, detail, title }: {
  label: string;
  /** Cody's own share; undefined when this machine does not show one. */
  codyPercent: number | null | undefined;
  machinePercent: number | null;
  detail: string;
  title?: string;
}) {
  const { t } = useI18n();
  const layered = codyPercent !== undefined;
  const machine = clampPercent(machinePercent);
  const cody = layered ? Math.min(clampPercent(codyPercent), Math.max(machine, 0)) : 0;
  const headline = layered ? codyPercent : machinePercent;
  const color = headline === null ? undefined : usageToneColor(headline);
  const layer = (width: number, background: string) => ({
    position: "absolute" as const,
    left: 0,
    top: 0,
    bottom: 0,
    width: `${width}%`,
    minWidth: width > 0 ? 2 : 0,
    borderRadius: 3,
    background,
    transition: "width 600ms var(--ease-out-warm), background-color 300ms var(--ease-out-warm)",
  });
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</span>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: headline === null ? "var(--text-dim)" : headline >= 70 ? color : "var(--text)",
            }}
          >
            {headline === null ? "…" : layered ? t("machines.panel.valueCody", { value: wholePercent(headline) }) : `${wholePercent(headline)}%`}
          </span>
          {layered && (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              · {machinePercent === null ? "…" : t("machines.panel.valueMachine", { value: machine })}
            </span>
          )}
        </span>
      </div>
      <div style={{ position: "relative", height: 6, borderRadius: 3, background: "var(--bg-selected)", overflow: "hidden", marginTop: 4 }}>
        {layered ? (
          <>
            <div style={layer(machine, MACHINE_LAYER)} />
            <div style={layer(cody, "var(--accent)")} />
          </>
        ) : (
          <div style={layer(machine, color ?? "none")} />
        )}
      </div>
      {detail && <div title={title} style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{detail}</div>}
    </div>
  );
}

/** What the two colours mean, once for the whole panel. */
function Legend() {
  const { t } = useI18n();
  const swatch = (background: string) => (
    <span aria-hidden="true" style={{ width: 14, height: 6, borderRadius: 3, background, flexShrink: 0 }} />
  );
  return (
    <div style={{ display: "flex", flexWrap: "wrap", columnGap: 14, rowGap: 4, marginTop: 8, fontSize: 11, color: "var(--text-muted)" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{swatch("var(--accent)")}{t("machines.panel.legend.cody")}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{swatch(MACHINE_LAYER)}{t("machines.panel.legend.machine")}</span>
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

  const own = metrics?.own ?? null;
  const gb = formatGigabytes;
  const machineMemUsed = metrics ? machineMemoryUsedBytes(metrics) : 0;
  const machineMemPercent = metrics ? Math.max(metrics.memPercent, own?.memPercent ?? 0) : 0;
  const cpuDetail = metrics && metrics.cpuPercent !== null
    ? [
      own && own.cpuPercent !== null
        ? tn("machines.panel.cpuCody", metrics.cores ?? own.cores, {
          used: coresUsed(own.cpuPercent, own.cores),
          total: metrics.cores ?? own.cores,
        })
        : metrics.cores === null ? null : tn("machines.panel.cores", metrics.cores),
      metrics.load1 === null ? null : t("machines.panel.load", { value: metrics.load1.toFixed(2) }),
    ].filter(Boolean).join(" · ")
    : t("machines.panel.waiting");
  const memDetail = metrics
    ? own
      ? [
        own.memLimitBytes === null
          ? t("machines.panel.memCody", { used: gb(own.memUsedBytes) })
          : t("machines.panel.memCodyLimit", { used: gb(own.memUsedBytes), limit: gb(own.memLimitBytes) }),
        t("machines.panel.memMachine", { used: gb(machineMemUsed), total: gb(metrics.memTotalBytes) }),
      ].join(" · ")
      : t("machines.panel.memoryOf", { used: gb(metrics.memUsedBytes), total: gb(metrics.memTotalBytes) })
    : "";

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
        {machine.worker && (
          <span
            style={{
              flexShrink: 0,
              padding: "0 6px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              fontSize: 10.5,
              lineHeight: "16px",
              color: "var(--text-muted)",
            }}
          >
            {t("machines.worker.tag")}
          </span>
        )}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, fontSize: 11, color: "var(--text-muted)" }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor }} />
          {t(machineStatusKey(machine.status))}
        </span>
      </div>
      {machine.worker && (machine.worker.jobs > 0 || !machine.worker.ready) && (
        <div style={{ display: "flex", flexWrap: "wrap", columnGap: 10, rowGap: 2, fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>
          {machine.worker.jobs > 0 && <span style={{ color: "var(--text)" }}>{tn("machines.worker.jobsRunning", machine.worker.jobs)}</span>}
          {!machine.worker.ready && <span>{t("machines.worker.panelNotReady")}</span>}
        </div>
      )}
      {metrics ? (
        <>
          <Gauge
            label={t("machines.panel.cpu")}
            codyPercent={own ? own.cpuPercent : undefined}
            machinePercent={metrics.cpuPercent}
            detail={cpuDetail}
            title={t("machines.panel.loadHint")}
          />
          <Gauge
            label={t("machines.panel.memory")}
            codyPercent={own ? own.memPercent : undefined}
            machinePercent={machineMemPercent}
            detail={memDetail}
          />
          {!own && <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)" }}>{t("machines.panel.noOwn")}</div>}
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
  const anyOwn = machines.some((machine) => machine.status === "online" && machine.metrics?.own);
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
          {anyOwn && <Legend />}
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
