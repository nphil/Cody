"use client";

import { useEffect, useState } from "react";
import { Server, ServerOff, SlidersHorizontal } from "lucide-react";
import { useMachineMeters } from "@/hooks/useMachineMeters";
import { formatRelativeTime, usageToneColor } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { MemoryEvent, MemoryOverview } from "@/lib/machines/memory";
import {
  formatGigabytes,
  hostGroups,
  machineDisplayName,
  machineMemoryUsedBytes,
  machineReasonKey,
  machineStatusKey,
  memoryEventWords,
  splitHost,
  wholePercent,
} from "@/lib/machines/present";
import type { MachineState } from "@/lib/machines/types";

/**
 * The top-bar dropdown behind the machine meters: one card per machine with
 * exact CPU and memory, cores, load and whether it is online, and the way to
 * Settings where the list is edited. Opens in the same full-width panel the
 * session popover uses (`AppShell` owns the frame).
 *
 * A worker that runs beside Cody on this server's own machine has no card of
 * its own: this server's card splits the machine into Cody, the worker and the
 * whole machine. Under each card: how many jobs it ran in the last day and its
 * newest memory events (`GET /api/machines/memory`, read while the panel is open).
 */

/** The whole-machine layer of a bar: a grey that shows on the track in every
 * theme (the text colours are always legible on the panel) and leaves the
 * accent, Cody's own colour, clear to read on top of it. */
const MACHINE_LAYER = "color-mix(in srgb, var(--text-muted) 45%, var(--bg-selected))";

/** A worker beside Cody on the same machine: Cody's colour, striped, so it reads as the machine's other tenant in
 * every theme without borrowing a status colour. */
const WORKER_LAYER = "repeating-linear-gradient(135deg, var(--accent) 0 2px, color-mix(in srgb, var(--accent) 30%, transparent) 2px 4px)";

/** Memory events listed under a card; the rest of the week is a count. */
const EVENTS_SHOWN = 3;
/** How often an open panel asks again for events and job counts. */
const OVERVIEW_EVERY_MS = 30_000;

/** Cores in use as a plain figure: one decimal, two when it is a sliver (never "0.0"). */
function coresUsed(percent: number, cores: number): string {
  const used = (percent / 100) * cores;
  return used > 0 && used < 0.1 ? Math.max(used, 0.01).toFixed(2) : used.toFixed(1);
}

function clampPercent(value: number | null): number {
  return value === null ? 0 : wholePercent(value);
}

/**
 * One bar, two or three layers: the whole machine's use in grey, Cody's own
 * share on top of it in the accent colour and, for a worker beside Cody on the
 * same machine, the worker's share striped right after Cody's. The parts are
 * parts of the machine's, so together they are never drawn longer than the grey
 * (two readings a moment apart can disagree by a hair). Without a Cody figure
 * the bar is the machine's alone, in the accent as it always was.
 */
function Gauge({ label, codyPercent, workerPercent, machinePercent, detail, title }: {
  label: string;
  /** Cody's own share; undefined when this machine does not show one. */
  codyPercent: number | null | undefined;
  /** The share of the workers beside Cody; undefined when none is shown. */
  workerPercent?: number | null;
  machinePercent: number | null;
  detail: string;
  title?: string;
}) {
  const { t } = useI18n();
  const layered = codyPercent !== undefined;
  const withWorker = layered && workerPercent !== undefined;
  const machine = clampPercent(machinePercent);
  const cody = layered ? Math.min(clampPercent(codyPercent), Math.max(machine, 0)) : 0;
  const worker = withWorker ? Math.min(clampPercent(workerPercent), Math.max(machine - cody, 0)) : 0;
  const headline = layered ? codyPercent : machinePercent;
  const color = headline === null ? undefined : usageToneColor(headline);
  const layer = (width: number, background: string, left = 0) => ({
    position: "absolute" as const,
    left: `${left}%`,
    top: 0,
    bottom: 0,
    width: `${width}%`,
    minWidth: width > 0 ? 2 : 0,
    borderRadius: 3,
    background,
    transition: "width 600ms var(--ease-out-warm), left 600ms var(--ease-out-warm), background-color 300ms var(--ease-out-warm)",
  });
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</span>
        {/* Each figure stays whole; when the three do not fit beside the label, the last ones wrap under it, right-aligned. */}
        <span style={{ display: "inline-flex", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "baseline", columnGap: 6, minWidth: 0, fontVariantNumeric: "tabular-nums" }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: "nowrap",
              color: headline === null ? "var(--text-dim)" : headline >= 70 ? color : "var(--text)",
            }}
          >
            {headline === null ? "…" : layered ? t("machines.panel.valueCody", { value: wholePercent(headline) }) : `${wholePercent(headline)}%`}
          </span>
          {withWorker && (
            <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              · {workerPercent === null ? "…" : t("machines.panel.valueWorker", { value: wholePercent(workerPercent) })}
            </span>
          )}
          {layered && (
            <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
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
            {worker > 0 && <div style={layer(worker, WORKER_LAYER, cody)} />}
          </>
        ) : (
          <div style={layer(machine, color ?? "none")} />
        )}
      </div>
      {detail && <div title={title} style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{detail}</div>}
    </div>
  );
}

/** What the colours mean, once for the whole panel. */
function Legend({ worker }: { worker: boolean }) {
  const { t } = useI18n();
  const swatch = (background: string) => (
    <span aria-hidden="true" style={{ width: 14, height: 6, borderRadius: 3, background, flexShrink: 0 }} />
  );
  return (
    <div style={{ display: "flex", flexWrap: "wrap", columnGap: 14, rowGap: 4, marginTop: 8, fontSize: 11, color: "var(--text-muted)" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{swatch("var(--accent)")}{t("machines.panel.legend.cody")}</span>
      {worker && <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{swatch(WORKER_LAYER)}{t("machines.panel.legend.worker")}</span>}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{swatch(MACHINE_LAYER)}{t("machines.panel.legend.machine")}</span>
    </div>
  );
}

/** The small tag that marks a machine as a worker. */
function WorkerTag() {
  const { t } = useI18n();
  return (
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
  );
}

function StatusDot({ machine }: { machine: MachineState }) {
  const { t } = useI18n();
  const color = machine.status === "online" ? "var(--status-success)" : machine.status === "offline" ? "var(--status-error)" : "var(--text-dim)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, fontSize: 11, color: "var(--text-muted)" }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: color }} />
      {t(machineStatusKey(machine.status))}
    </span>
  );
}

/** Running jobs, and a worker whose last check failed. */
function WorkerLine({ machine }: { machine: MachineState }) {
  const { t, tn } = useI18n();
  if (!machine.worker || (machine.worker.jobs === 0 && machine.worker.ready)) return null;
  return (
    <>
      {machine.worker.jobs > 0 && <span style={{ color: "var(--text)" }}>{tn("machines.worker.jobsRunning", machine.worker.jobs)}</span>}
      {!machine.worker.ready && <span>{t("machines.worker.panelNotReady")}</span>}
    </>
  );
}

const SMALL_ROW = { display: "flex", flexWrap: "wrap", columnGap: 10, rowGap: 2, fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" } as const;

function MachineCard({ machine, guests, events, jobs, now }: {
  machine: MachineState;
  /** Workers that run beside Cody on this machine; only ever this server's card has any. */
  guests: readonly MachineState[];
  /** This card's memory events of the last week, newest first; null until the panel has heard. */
  events: readonly MemoryEvent[] | null;
  /** Jobs in the last 24 hours, per place on this card; null when there is nothing to say. */
  jobs: readonly { name: string | null; count: number }[] | null;
  /** When the events were read, for "5 min ago". */
  now: number;
}) {
  const { locale, t, tn } = useI18n();
  const name = machineDisplayName(machine, t);
  const metrics = machine.status === "online" ? machine.metrics : null;
  const Icon = machine.status === "offline" ? ServerOff : Server;

  const own = metrics?.own ?? null;
  const split = guests.length > 0 ? splitHost(machine, guests) : null;
  const gb = formatGigabytes;
  const machineMemUsed = metrics ? machineMemoryUsedBytes(metrics) : 0;
  const machineMemPercent = metrics ? Math.max(metrics.memPercent, own?.memPercent ?? 0) : 0;
  const load = metrics && metrics.load1 !== null ? t("machines.panel.load", { value: metrics.load1.toFixed(2) }) : null;
  const ownMem = own
    ? own.memLimitBytes === null
      ? t("machines.panel.memCody", { used: gb(own.memUsedBytes) })
      : t("machines.panel.memCodyLimit", { used: gb(own.memUsedBytes), limit: gb(own.memLimitBytes) })
    : null;

  let cpuDetail: string;
  let memDetail: string;
  if (split && metrics) {
    // Every figure on the machine's scale: shares of all its cores and all its memory.
    const workers = split.workers;
    cpuDetail = metrics.cpuPercent === null
      ? t("machines.panel.waiting")
      : [
        split.cody.cpuPercent === null
          ? null
          : tn("machines.panel.cpuCody", split.cores, { used: coresUsed(split.cody.cpuPercent, split.cores), total: split.cores }),
        workers && workers.cpuPercent !== null ? t("machines.panel.cpuWorker", { used: coresUsed(workers.cpuPercent, split.cores) }) : null,
        load,
      ].filter(Boolean).join(" · ");
    memDetail = [
      ownMem,
      workers ? t("machines.panel.memWorker", { used: gb(workers.memUsedBytes) }) : null,
      t("machines.panel.memMachine", { used: gb(split.machine.memUsedBytes), total: gb(split.memTotalBytes) }),
    ].filter(Boolean).join(" · ");
  } else {
    cpuDetail = metrics && metrics.cpuPercent !== null
      ? [
        own && own.cpuPercent !== null
          ? tn("machines.panel.cpuCody", metrics.cores ?? own.cores, {
            used: coresUsed(own.cpuPercent, own.cores),
            total: metrics.cores ?? own.cores,
          })
          : metrics.cores === null ? null : tn("machines.panel.cores", metrics.cores),
        load,
      ].filter(Boolean).join(" · ")
      : t("machines.panel.waiting");
    memDetail = metrics
      ? own
        ? [ownMem, t("machines.panel.memMachine", { used: gb(machineMemUsed), total: gb(metrics.memTotalBytes) })].join(" · ")
        : t("machines.panel.memoryOf", { used: gb(metrics.memUsedBytes), total: gb(metrics.memTotalBytes) })
      : "";
  }

  // On a machine shared with workers: how long anything waited on memory lately, Cody's part and the workers'.
  const pressures = split
    ? [
      { key: "machines.panel.valueCody", value: split.cody.pressure },
      ...(split.workers ? [{ key: "machines.panel.valueWorker", value: split.workers.pressure }] : []),
    ].filter((part): part is { key: string; value: number } => part.value !== null)
    : [];
  const pressureLine = pressures.length > 0
    ? pressures.every((part) => part.value < 0.05)
      ? t("machines.panel.pressureNone")
      : t("machines.panel.pressure", {
        // One decimal below ten, whole above.
        parts: pressures.map((part) => t(part.key, { value: part.value < 10 ? part.value.toFixed(1) : Math.round(part.value) })).join(" · "),
      })
    : null;

  const placeName = (id: string): string | null => {
    if (guests.length === 0) return null;
    if (id === machine.id) return t("machines.panel.legend.cody");
    const guest = guests.find((candidate) => candidate.id === id);
    return guest ? machineDisplayName(guest, t) : null;
  };
  const shown = events?.slice(0, EVENTS_SHOWN) ?? [];
  const hidden = (events?.length ?? 0) - shown.length;
  const jobsLine = jobs
    ? jobs.every((place) => place.count === 0)
      ? t("machines.panel.jobsNone")
      : t("machines.panel.jobs24h", {
        parts: jobs
          .map((place) => (place.name === null ? String(place.count) : t("machines.panel.jobsAt", { name: place.name, count: place.count })))
          .join(" · "),
      })
    : null;

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
        {machine.worker && <WorkerTag />}
        <StatusDot machine={machine} />
      </div>
      {machine.worker && (machine.worker.jobs > 0 || !machine.worker.ready) && <div style={SMALL_ROW}><WorkerLine machine={machine} /></div>}
      {guests.map((guest) => (
        <div key={guest.id} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 8, rowGap: 2, minWidth: 0, fontSize: 11, color: "var(--text-muted)" }}>
          <WorkerTag />
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontWeight: 600 }}>
            {machineDisplayName(guest, t)}
          </span>
          <StatusDot machine={guest} />
          <WorkerLine machine={guest} />
          {guest.status !== "online" && guest.reason && <span>{t(machineReasonKey(guest.reason))}</span>}
        </div>
      ))}
      {metrics ? (
        <>
          {split ? (
            <>
              <Gauge
                label={t("machines.panel.cpu")}
                codyPercent={split.cody.cpuPercent}
                workerPercent={split.workers ? split.workers.cpuPercent : undefined}
                machinePercent={split.machine.cpuPercent}
                detail={cpuDetail}
                title={t("machines.panel.loadHint")}
              />
              <Gauge
                label={t("machines.panel.memory")}
                codyPercent={(split.cody.memUsedBytes / split.memTotalBytes) * 100}
                workerPercent={split.workers ? (split.workers.memUsedBytes / split.memTotalBytes) * 100 : undefined}
                machinePercent={(split.machine.memUsedBytes / split.memTotalBytes) * 100}
                detail={memDetail}
              />
            </>
          ) : (
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
            </>
          )}
          {pressureLine && <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{pressureLine}</div>}
          {!own && <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)" }}>{t("machines.panel.noOwn")}</div>}
        </>
      ) : (
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--text-muted)" }}>
          {machine.reason ? t(machineReasonKey(machine.reason)) : t("machines.panel.waiting")}
        </div>
      )}
      {jobsLine && <div style={{ ...SMALL_ROW, fontVariantNumeric: "tabular-nums" }}>{jobsLine}</div>}
      {shown.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>{t("machines.panel.events")}</div>
          {shown.map((event) => {
            const where = placeName(event.machine);
            const when = formatRelativeTime(new Date(event.at).toISOString(), locale, now);
            return (
              <div key={`${event.at}-${event.machine}-${event.kind}`} title={event.text} style={{ fontSize: 11, lineHeight: 1.45, color: "var(--text-dim)", overflowWrap: "anywhere" }}>
                <span style={{ color: event.kind === "oom" ? "var(--status-error)" : "var(--status-warning)", fontVariantNumeric: "tabular-nums" }}>{when}</span>
                {" · "}
                {where && <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{where}: </span>}
                {memoryEventWords(event, t, tn)}
              </div>
            );
          })}
          {hidden > 0 && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{tn("machines.panel.eventsMore", hidden)}</div>}
        </div>
      )}
    </section>
  );
}

/** The panel's memory events and job counts: read when it opens and every half minute while it stays open. Without
 * them the panel is the same, minus those lines. */
function useMemoryOverview(): { overview: MemoryOverview; at: number } | null {
  const [heard, setHeard] = useState<{ overview: MemoryOverview; at: number } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/machines/memory", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const overview = (await response.json()) as MemoryOverview;
        setHeard({ overview, at: Date.now() });
      } catch {
        // Gone or refused: keep what the panel had.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), OVERVIEW_EVERY_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);
  return heard;
}

export function MachinesPanel({ isMobile, onManage }: { isMobile: boolean; onManage: () => void }) {
  const { t } = useI18n();
  const machines = useMachineMeters()?.machines ?? [];
  const heard = useMemoryOverview();
  const groups = hostGroups(machines);
  const anyOwn = machines.some((machine) => machine.status === "online" && machine.metrics?.own);
  const anyGuest = groups.some((group) => group.guests.length > 0);
  const cards = groups.map(({ machine, guests }) => {
    if (!heard) return { machine, guests, events: null, jobs: null };
    const places = [machine.id, ...guests.map((guest) => guest.id)];
    const count = (id: string) => heard.overview.jobs24h[id] ?? 0;
    const events = heard.overview.events.filter((event) => places.includes(event.machine));
    // A worker always says how busy it was; this server only when it ran jobs itself, or shares its machine with one.
    const jobs = guests.length > 0
      ? [{ name: t("machines.panel.legend.cody"), count: count(machine.id) }, ...guests.map((guest) => ({ name: machineDisplayName(guest, t), count: count(guest.id) }))]
      : machine.worker || count(machine.id) > 0 ? [{ name: null, count: count(machine.id) }] : null;
    return { machine, guests, events, jobs };
  });
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
          {anyOwn && <Legend worker={anyGuest} />}
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
        {cards.map((card) => <MachineCard key={card.machine.id} {...card} now={heard?.at ?? 0} />)}
        {machines.length === 0 && (
          <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{t("machines.panel.waiting")}</div>
        )}
      </div>
    </div>
  );
}
