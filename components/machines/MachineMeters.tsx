"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import { Cpu, MemoryStick, Server, ServerOff } from "lucide-react";
import { useMachineMeters } from "@/hooks/useMachineMeters";
import { usageToneColor } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import {
  machineDisplayName,
  machineInitial,
  machineSeverity,
  machineStatusKey,
  pickMeterDensity,
  wholePercent,
  worstMachine,
  type MeterDensity,
} from "@/lib/machines/present";
import type { MachineState } from "@/lib/machines/types";

/**
 * Live CPU and memory for every machine, in the top bar.
 *
 * The component owns the whole stretch of bar between the left controls and
 * the session figures (a `flex: 1` slot that is as wide as whatever is left),
 * and measures it: that leftover width, not the window's, decides how much of
 * each machine is drawn — name and labelled bars when there is room, then a
 * pair of icon-labelled bars, then an initial and two bare bars, and on a phone
 * (or when nothing else fits) one indicator for the machine that needs
 * attention. Nothing wraps and nothing spills: a chip is either drawn whole or
 * a leaner one is.
 *
 * Geometry lives in `app/globals.css` (`.mm-*`) and, as numbers the picker can
 * add up, in `METER_LAYOUT` (lib/machines/present.ts).
 */

/** Space `.shell-toolbar-divider` takes: its width plus both margins. A phone
 * has no room to spend on one, so it gets none. */
const DIVIDER_WIDTH = 17;

/** The usage thresholds paint the number only once it is worth noticing. */
function valueColor(percent: number): string | undefined {
  return percent >= 70 ? usageToneColor(percent) : undefined;
}

function Track({ percent }: { percent: number | null }) {
  const filled = percent === null ? 0 : wholePercent(percent);
  return (
    <span className="mm-track">
      <span
        className="mm-fill"
        style={{ width: `${filled}%`, minWidth: filled > 0 ? 2 : 0, background: percent === null ? "none" : usageToneColor(percent) }}
      />
    </span>
  );
}

function MeterRow({ kind, percent, density }: { kind: "cpu" | "mem"; percent: number | null; density: "full" | "compact" }) {
  const { t } = useI18n();
  const Icon = kind === "cpu" ? Cpu : MemoryStick;
  return (
    <span className="mm-row">
      {density === "full"
        ? <span className="mm-label" aria-hidden="true">{t(kind === "cpu" ? "machines.meter.cpu" : "machines.meter.memShort")}</span>
        : <Icon className="mm-icon" size={10} strokeWidth={2} aria-hidden="true" />}
      <Track percent={percent} />
      <span className="mm-value" style={{ color: percent === null ? undefined : valueColor(percent) }}>
        {percent === null ? "…" : `${wholePercent(percent)}%`}
      </span>
    </span>
  );
}

function MachineChip({ machine, density, single }: { machine: MachineState; density: "full" | "compact" | "mini"; single: boolean }) {
  const { t } = useI18n();
  const { metrics } = machine;
  const down = machine.status === "offline";

  if (density === "mini") {
    return (
      <span className="mm-chip" data-status={machine.status}>
        {!single && (
          // This computer wears a server glyph: "T" from "This server" says nothing.
          <span className="mm-badge" aria-hidden="true">
            {machine.kind === "local" ? <Server size={9} strokeWidth={2.4} /> : machineInitial(machine.name)}
          </span>
        )}
        {down
          ? <ServerOff size={13} strokeWidth={2} aria-hidden="true" style={{ color: "var(--status-error)" }} />
          : (
            <span className="mm-bars">
              <Track percent={metrics?.cpuPercent ?? null} />
              <Track percent={metrics?.memPercent ?? null} />
            </span>
          )}
      </span>
    );
  }

  return (
    <span className="mm-chip" data-status={machine.status}>
      <span className="mm-name">{machine.name}</span>
      {down && (
        <span className="mm-note" style={{ color: "var(--status-error)" }}>
          <ServerOff size={11} strokeWidth={2} aria-hidden="true" />
          {t(machineStatusKey("offline"))}
        </span>
      )}
      {machine.status === "unavailable" && <span className="mm-note">{t(machineStatusKey("unavailable"))}</span>}
      {machine.status !== "offline" && machine.status !== "unavailable" && (
        <span className="mm-rows">
          <MeterRow kind="cpu" percent={metrics?.cpuPercent ?? null} density={density} />
          <MeterRow kind="mem" percent={metrics?.memPercent ?? null} density={density} />
        </span>
      )}
    </span>
  );
}

/** One ring for the machine that needs a look: how full its busier meter is,
 * or a struck-through server when it is down. */
function WorstIndicator({ machine }: { machine: MachineState }) {
  const severity = machineSeverity(machine);
  if (severity === "down") {
    return <ServerOff size={15} strokeWidth={2} aria-hidden="true" style={{ color: "var(--status-error)" }} />;
  }
  const peak = machine.metrics ? Math.max(machine.metrics.cpuPercent ?? 0, machine.metrics.memPercent) : 0;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const arc = Math.max(wholePercent(peak), 2) / 100 * circumference;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--bg-selected)" strokeWidth="2.5" />
      {severity !== "pending" && (
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke={usageToneColor(peak)}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${arc} ${circumference}`}
          transform="rotate(-90 8 8)"
          style={{ transition: "stroke-dasharray 600ms var(--ease-out-warm), stroke 300ms var(--ease-out-warm)" }}
        />
      )}
    </svg>
  );
}

export interface MachineMetersProps {
  isMobile: boolean;
  /** The machines dropdown is open. */
  active: boolean;
  onToggle: () => void;
  /** A button (the session figures) follows, so a divider goes between them. */
  followedByStats: boolean;
  /** Space the always-visible workspace-panel toggle covers at the right edge,
   * to be kept clear when nothing else is there to do it. */
  cornerPad: number;
}

export const MachineMeters = forwardRef<HTMLButtonElement, MachineMetersProps>(function MachineMeters(
  { isMobile, active, onToggle, followedByStats, cornerPad },
  buttonRef,
) {
  const { t } = useI18n();
  // The page-wide store, not a prop: a frame a second must re-render this and
  // the dropdown, never the whole shell.
  const live = useMachineMeters();
  const slotRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const observer = new ResizeObserver((entries) => setRoom(entries[0]?.contentRect.width ?? 0));
    observer.observe(slot);
    return () => observer.disconnect();
  }, []);

  // This server's default name is stored in English; the bar shows it in the reader's language.
  const machines = (live?.machines ?? []).map((machine) => ({ ...machine, name: machineDisplayName(machine, t) }));
  const showDivider = followedByStats && !isMobile;
  const divider = showDivider ? DIVIDER_WIDTH : 0;
  const density: MeterDensity = pickMeterDensity(machines, room - divider, isMobile);
  const worst = worstMachine(machines);

  const summary = machines.map((machine) => {
    const metrics = machine.metrics;
    if (machine.status !== "online" || !metrics) {
      return t("machines.tooltip.state", { name: machine.name, state: t(machineStatusKey(machine.status)) });
    }
    return t("machines.tooltip.reading", {
      name: machine.name,
      cpu: metrics.cpuPercent === null ? "…" : `${wholePercent(metrics.cpuPercent)}%`,
      memory: `${wholePercent(metrics.memPercent)}%`,
    });
  }).join("  |  ");

  return (
    <div
      ref={slotRef}
      style={{
        flex: "1 1 0",
        minWidth: 0,
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        overflow: "hidden",
        paddingRight: followedByStats ? 0 : cornerPad,
      }}
    >
      {density !== "none" && (
        <button
          ref={buttonRef}
          type="button"
          className="mm-button ui-focus-ring"
          onClick={onToggle}
          title={summary}
          aria-label={t("machines.aria.button")}
          aria-pressed={active}
          data-density={density}
          data-single={machines.length === 1 ? "true" : "false"}
          data-live={live?.live === false ? "false" : "true"}
        >
          {density === "dot" && worst
            ? <WorstIndicator machine={worst} />
            : density !== "dot" && machines.map((machine) => (
              <MachineChip key={machine.id} machine={machine} density={density} single={machines.length === 1} />
            ))}
        </button>
      )}
      {density !== "none" && showDivider && <div className="shell-toolbar-divider" aria-hidden="true" />}
    </div>
  );
});
