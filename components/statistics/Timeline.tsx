"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import { useI18n } from "@/lib/i18n";
import { formatCount, formatDay, formatTokens, formatUsd, nodeLabel } from "@/lib/statistics/present";
import { nodeValue, paintCss, seriesPaint, type Metric } from "@/lib/statistics/sunburst";
import type { Dim, TimelineDay, TimelineSeries } from "@/lib/statistics/types";

export interface TimelineProps {
  series: TimelineSeries[];
  days: TimelineDay[];
  dim: Dim;
  metric: Metric;
  onSelectRange: (from: string, to: string) => void;
}

/** A day-range the user is marking, as column indexes. `anchor` is where it started, `head` where it is now. */
interface Band {
  anchor: number;
  head: number;
}

const LEGEND_MAX = 8;
/** Room one x-axis label needs, so neighbours never touch even in a wide-glyph language. */
const LABEL_SLOT = 76;
/** Half a label's width, used to decide whether a centred label would hang over the plot's edge. */
const LABEL_HALF = 24;
const TOOLTIP_ROWS = 3;

/** The next 1 / 2 / 5 x 10^n at or above `value`, so the top gridline reads as a round number. */
function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const mantissa = value / exp;
  return (mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10) * exp;
}

function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index));
}

/** Which day labels the x axis can afford: all of them when they fit, else first and last with even steps between. */
function labelIndexes(count: number, width: number): number[] {
  const fit = width > 0 ? Math.max(1, Math.floor(width / LABEL_SLOT)) : 2;
  if (count <= fit) return Array.from({ length: count }, (_, i) => i);
  if (fit === 1) return [0];
  return Array.from({ length: fit }, (_, j) => Math.round((j * (count - 1)) / (fit - 1)));
}

/** Slides a floating element so it stays inside the plot's width, whatever its content made it. */
function placeWithin(el: HTMLElement | null, left: number, plotWidth: number): void {
  if (!el) return;
  el.style.left = `${Math.max(0, Math.min(plotWidth - el.offsetWidth, left))}px`;
}

export function Timeline({ series, days, dim, metric, onSelectRange }: TimelineProps) {
  const { locale, t } = useI18n();
  const count = days.length;

  const colsRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  /** The column a pointer drag started on; null while no drag is running. Handlers read it, rendering never does. */
  const anchorRef = useRef<number | null>(null);

  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [kbd, setKbd] = useState(false);
  const [band, setBand] = useState<Band | null>(null);

  const hasDays = count > 0;

  useEffect(() => {
    const el = colsRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[entries.length - 1];
      if (next) setWidth(Math.round(next.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasDays]);

  const colors = useMemo(() => series.map((s, i) => paintCss(seriesPaint(i, !!s.other))), [series]);

  /** Bottom-to-top stack order: the series as the server sent them, with the `other` bucket on top. */
  const order = useMemo(() => {
    const idx = series.map((_, i) => i);
    return [...idx.filter((i) => !series[i]?.other), ...idx.filter((i) => series[i]?.other)];
  }, [series]);

  const model = useMemo(() => {
    const used = series.map(() => false);
    let max = 0;
    for (const day of days) {
      let total = 0;
      for (let i = 0; i < series.length; i++) {
        const cell = day.cells[i];
        const v = cell ? nodeValue(cell, metric) : 0;
        if (v > 0) {
          used[i] = true;
          total += v;
        }
      }
      if (total > max) max = total;
    }
    return { used, max, ceil: niceCeil(max) };
  }, [days, series, metric]);

  const dayText = (cost: number, tokens: number): string => {
    if (tokens <= 0 && cost <= 0) return t("statistics.timeline.noUsage");
    if (metric === "tokens") return formatCount(tokens, locale);
    return cost > 0 ? formatUsd(cost, locale) : t("statistics.timeline.noPrice", { tokens: formatTokens(tokens, locale) });
  };
  const axisText = (value: number): string => (metric === "cost" ? formatUsd(value, locale) : formatTokens(value, locale));

  const activeIdx = active === null ? null : clampIndex(active, count);
  const lo = band ? clampIndex(Math.min(band.anchor, band.head), count) : 0;
  const hi = band ? clampIndex(Math.max(band.anchor, band.head), count) : 0;
  const multi = band !== null && lo !== hi;
  const tipIdx = band ? (multi ? null : lo) : (hover ?? (kbd ? activeIdx : null));
  const gap = width > 0 && width / Math.max(1, count) < 4 ? 0 : 1;

  // The tooltip sits beside its column and the range chip under the band; both are clamped to the plot after the browser
  // has laid out their (content-dependent) size, before anything is painted.
  useLayoutEffect(() => {
    const plotWidth = colsRef.current?.clientWidth ?? 0;
    if (count > 0 && tipIdx !== null) {
      const colWidth = plotWidth / count;
      const centre = (tipIdx + 0.5) * colWidth;
      const tip = tipRef.current;
      if (tip) placeWithin(tip, centre < plotWidth / 2 ? centre + colWidth / 2 + 8 : centre - colWidth / 2 - 8 - tip.offsetWidth, plotWidth);
    }
    if (count > 0 && band) {
      const chip = chipRef.current;
      if (chip) placeWithin(chip, ((lo + hi + 1) / 2 / count) * plotWidth - chip.offsetWidth / 2, plotWidth);
    }
  });

  const indexAt = (clientX: number): number => {
    const rect = colsRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return clampIndex(Math.floor(((clientX - rect.left) / rect.width) * count), count);
  };

  const commit = (from: number, to: number) => {
    const first = days[Math.min(from, to)];
    const last = days[Math.max(from, to)];
    if (first && last) onSelectRange(first.day, last.day);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    const idx = indexAt(e.clientX);
    e.currentTarget.setPointerCapture(e.pointerId);
    anchorRef.current = idx;
    setKbd(false);
    setActive(idx);
    setHover(idx);
    setBand({ anchor: idx, head: idx });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const idx = indexAt(e.clientX);
    const anchor = anchorRef.current;
    if (anchor !== null) {
      setHover(idx);
      setBand({ anchor, head: idx });
    } else if (e.pointerType !== "touch") {
      setHover(idx);
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    anchorRef.current = null;
    const idx = indexAt(e.clientX);
    setBand(null);
    setActive(idx);
    setHover(e.pointerType === "touch" ? null : idx);
    commit(anchor, idx);
  };

  const onPointerCancel = () => {
    anchorRef.current = null;
    setBand(null);
    setHover(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0 || e.ctrlKey || e.metaKey || e.altKey) return;
    const current = activeIdx ?? count - 1;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowLeft":
        next = clampIndex(current - 1, count);
        break;
      case "ArrowRight":
        next = clampIndex(current + 1, count);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        setBand(null);
        if (band) commit(lo, hi);
        else commit(current, current);
        return;
      case "Escape":
        if (band) {
          e.preventDefault();
          e.stopPropagation();
          setBand(null);
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    setKbd(true);
    setHover(null);
    setActive(next);
    setBand(e.shiftKey ? { anchor: band?.anchor ?? current, head: next } : null);
  };

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.matches(":focus-visible")) return;
    setKbd(true);
    setActive((prev) => prev ?? count - 1);
  };

  const onBlur = () => {
    setKbd(false);
    setBand(null);
  };

  const describeDay = (day: TimelineDay) => {
    let cost = 0;
    let tokens = 0;
    const rows: { index: number; value: number }[] = [];
    series.forEach((_, i) => {
      const cell = day.cells[i];
      if (!cell) return;
      cost += cell.cost;
      tokens += cell.tokens;
      const value = nodeValue(cell, metric);
      if (value > 0) rows.push({ index: i, value });
    });
    rows.sort((a, b) => b.value - a.value);
    return { cost, tokens, rows: rows.slice(0, TOOLTIP_ROWS) };
  };

  if (count === 0) {
    return (
      <section className="stats-timeline" aria-hidden>
        <style>{CSS}</style>
        <div className="stats-timeline__placeholder" />
      </section>
    );
  }

  const tipDay = tipIdx !== null ? days[tipIdx] : undefined;
  const tip = tipDay ? describeDay(tipDay) : null;

  const seriesName = (i: number): string => {
    const s = series[i];
    return s ? nodeLabel({ dim, key: s.key, label: s.label, other: s.other }, t) : "";
  };

  const rangeText = (from: number, to: number): string => {
    const a = formatDay(days[from]?.day ?? "", locale, from === to);
    return from === to ? a : t("statistics.timeline.range", { from: a, to: formatDay(days[to]?.day ?? "", locale) });
  };

  let announce = "";
  if (kbd && activeIdx !== null) {
    const from = band ? lo : activeIdx;
    const to = band ? hi : activeIdx;
    let cost = 0;
    let tokens = 0;
    for (let d = from; d <= to; d++) {
      const day = days[d];
      if (!day) continue;
      for (const cell of day.cells) {
        cost += cell.cost;
        tokens += cell.tokens;
      }
    }
    announce = `${rangeText(from, to)}: ${dayText(cost, tokens)}`;
  }

  const labelAt = labelIndexes(count, width);
  const legend = series.map((_, i) => i).filter((i) => model.used[i]).slice(0, LEGEND_MAX);
  const showGrid = model.max > 0;
  const halfLabel = axisText(model.ceil / 2);
  const topLabel = axisText(model.ceil);

  return (
    <section className="stats-timeline">
      <style>{CSS}</style>
      <header className="stats-timeline__head">
        <h2 className="stats-timeline__title">{t("statistics.timeline.title")}</h2>
        {count > 1 && <p className="stats-timeline__hint">{t("statistics.timeline.hint")}</p>}
      </header>

      <div className="stats-timeline__chart">
        <div className="stats-timeline__yaxis" aria-hidden>
          {showGrid && (
            <>
              <span className="stats-timeline__ylabel" style={{ bottom: "100%" }}>
                {topLabel}
              </span>
              {halfLabel !== topLabel && (
                <span className="stats-timeline__ylabel" style={{ bottom: "50%" }}>
                  {halfLabel}
                </span>
              )}
            </>
          )}
        </div>

        <div
          className="stats-timeline__plot"
          role="group"
          tabIndex={0}
          aria-label={t("statistics.timeline.plotLabel")}
          data-kbd={kbd}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => {
            if (anchorRef.current === null) setHover(null);
          }}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          {showGrid && (
            <>
              <span className="stats-timeline__grid" style={{ bottom: "100%" }} aria-hidden />
              <span className="stats-timeline__grid" style={{ bottom: "50%" }} aria-hidden />
            </>
          )}
          <span className="stats-timeline__baseline" aria-hidden />

          <div ref={colsRef} className="stats-timeline__cols" style={{ gap }}>
            {days.map((day, d) => (
              <div
                key={day.day}
                className="stats-timeline__col"
                data-hot={tipIdx === d || (band !== null && d >= lo && d <= hi)}
                data-active={kbd && activeIdx === d}
              >
                <div className="stats-timeline__stack">
                  {order.map((i) => {
                    const cell = day.cells[i];
                    const value = cell ? nodeValue(cell, metric) : 0;
                    if (value <= 0) return null;
                    return <span key={i} className="stats-timeline__seg" style={{ height: `${(value / model.ceil) * 100}%`, background: colors[i] }} />;
                  })}
                </div>
              </div>
            ))}
          </div>

          {band && (
            <span
              className="stats-timeline__band"
              style={{ left: `${(lo / count) * 100}%`, width: `${((hi - lo + 1) / count) * 100}%` }}
              aria-hidden
            />
          )}

          {tip && tipDay && (
            <div ref={tipRef} className="stats-timeline__tip" aria-hidden>
              <div className="stats-timeline__tip-day">{formatDay(tipDay.day, locale, true)}</div>
              <div className="stats-timeline__tip-total">{dayText(tip.cost, tip.tokens)}</div>
              {metric === "cost" && tip.cost > 0 && tip.tokens > 0 && (
                <div className="stats-timeline__tip-sub">{t("statistics.timeline.tokensLine", { tokens: formatTokens(tip.tokens, locale) })}</div>
              )}
              {tip.rows.length > 0 && (
                <ul className="stats-timeline__tip-rows">
                  {tip.rows.map((row) => (
                    <li key={row.index} className="stats-timeline__tip-row">
                      <span className="stats-timeline__dot" style={{ background: colors[row.index] }} />
                      <span className="stats-timeline__tip-name">{seriesName(row.index)}</span>
                      <span className="stats-timeline__tip-value">{metric === "cost" ? formatUsd(row.value, locale) : formatTokens(row.value, locale)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="stats-timeline__xaxis" aria-hidden>
          {labelAt.map((i) => {
            const centre = ((i + 0.5) / count) * width;
            const edge = width > 0 && centre < LABEL_HALF ? "start" : width > 0 && centre > width - LABEL_HALF ? "end" : "mid";
            return (
              <span
                key={i}
                className="stats-timeline__xlabel"
                data-edge={edge}
                style={edge === "mid" ? { left: `${((i + 0.5) / count) * 100}%` } : undefined}
              >
                {formatDay(days[i]?.day ?? "", locale)}
              </span>
            );
          })}
          {band && (
            <div ref={chipRef} className="stats-timeline__chip">
              {rangeText(lo, hi)}
            </div>
          )}
        </div>
      </div>

      {legend.length > 0 && (
        <ul className="stats-timeline__legend">
          {legend.map((i) => (
            <li key={i} className="stats-timeline__legend-item" title={seriesName(i)}>
              <span className="stats-timeline__dot" style={{ background: colors[i] }} />
              <span className="stats-timeline__legend-name">{seriesName(i)}</span>
            </li>
          ))}
        </ul>
      )}

      <span className="stats-timeline__sr" aria-live="polite">
        {announce}
      </span>
    </section>
  );
}

const CSS = `
.stats-timeline {
  --stats-timeline-axis: 3rem;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.stats-timeline__placeholder { height: 12rem; }
.stats-timeline__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 2px 12px;
}
.stats-timeline__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.stats-timeline__hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
}
.stats-timeline__chart {
  display: grid;
  grid-template-columns: var(--stats-timeline-axis) minmax(0, 1fr);
  grid-template-rows: clamp(120px, 14vw, 176px) auto;
  padding-top: 8px;
  min-width: 0;
}
.stats-timeline__yaxis { position: relative; padding-right: 6px; }
.stats-timeline__ylabel {
  position: absolute;
  right: 6px;
  transform: translateY(50%);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--text-dim);
}
.stats-timeline__plot {
  position: relative;
  min-width: 0;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  cursor: crosshair;
  outline: none;
}
.stats-timeline__grid {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: color-mix(in srgb, var(--border) 55%, transparent);
  pointer-events: none;
}
.stats-timeline__baseline {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: var(--border);
  pointer-events: none;
}
.stats-timeline__cols {
  position: absolute;
  inset: 0;
  display: flex;
}
.stats-timeline__col {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  border-radius: 2px 2px 0 0;
  transition: background var(--dur-fast) var(--ease-out-warm);
}
.stats-timeline__col[data-hot="true"] { background: var(--bg-hover); }
.stats-timeline__plot[data-kbd="true"] .stats-timeline__col[data-active="true"] {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
.stats-timeline__stack {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column-reverse;
}
.stats-timeline__seg {
  flex: none;
  min-height: 1px;
  transition: height var(--dur-fast) var(--ease-out-warm);
}
.stats-timeline__seg:last-child { border-radius: 2px 2px 0 0; }
.stats-timeline__band {
  position: absolute;
  top: 0;
  bottom: 0;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  box-shadow: inset 1px 0 0 var(--accent), inset -1px 0 0 var(--accent);
  pointer-events: none;
}
.stats-timeline__tip {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 5;
  width: max-content;
  max-width: min(15rem, calc(100% - 8px));
  padding: 8px 10px;
  border-radius: var(--radius-control);
  background: var(--bg-panel);
  box-shadow: var(--shadow-pop);
  color: var(--text);
  font-size: 12px;
  line-height: 1.35;
  pointer-events: none;
  animation: ui-fade-in var(--dur-fast) var(--ease-out-warm);
}
.stats-timeline__tip-day { color: var(--text-muted); }
.stats-timeline__tip-total {
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.stats-timeline__tip-sub {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.stats-timeline__tip-rows {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.stats-timeline__tip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.stats-timeline__tip-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stats-timeline__tip-value {
  flex: none;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.stats-timeline__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.stats-timeline__xaxis {
  position: relative;
  grid-column: 2;
  height: 22px;
}
.stats-timeline__xlabel {
  position: absolute;
  top: 6px;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.stats-timeline__xlabel[data-edge="mid"] { transform: translateX(-50%); }
.stats-timeline__xlabel[data-edge="start"] { left: 0; }
.stats-timeline__xlabel[data-edge="end"] { right: 0; }
.stats-timeline__chip {
  position: absolute;
  top: 2px;
  left: 0;
  padding: 3px 8px;
  border-radius: var(--radius-control);
  background: var(--accent);
  color: var(--on-accent);
  font-size: 11px;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.stats-timeline__legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}
.stats-timeline__legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.stats-timeline__legend-name {
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stats-timeline__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (max-width: 480px) {
  .stats-timeline { --stats-timeline-axis: 2.75rem; }
}
@media (prefers-reduced-motion: reduce) {
  .stats-timeline__seg,
  .stats-timeline__col { transition: none; }
  .stats-timeline__tip { animation: none; }
}
`;
