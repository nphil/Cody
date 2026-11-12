"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useI18n } from "@/lib/i18n";
import { BILLING_KEYS, costFigure, costText, formatCount, formatShare, formatTokens, nodeLabel, shareOf, type Translate } from "@/lib/statistics/present";
import { arcLabel, arcPath, layoutSunburst, nodeValue, paintCss, pathId, rerootAt, TAU, textWidth, type ArcLabel, type Metric, type SunburstArc, type SunburstLayout } from "@/lib/statistics/sunburst";
import type { StatNode } from "@/lib/statistics/types";

type Path = readonly string[];

export interface SunburstProps {
  /** StatisticsResponse.tree. */
  tree: StatNode;
  /** The zoom focus. It may name a node that no longer exists; the layout cuts it back to the deepest one that does. */
  path: Path;
  metric: Metric;
  /** The outlined node: the one the table and the deep dive follow. */
  selected: Path | null;
  /** The highlighted node, described in the centre. The page owns it so hovering a table row lights its arc. */
  hovered: Path | null;
  onHover: (path: string[] | null) => void;
  /** Zoom into `path`; a parent path (or `[]`) zooms out. */
  onZoom: (path: string[]) => void;
  onSelect: (path: string[] | null) => void;
  /** Touch: a press SELECTS the arc (the page opens its detail sheet) instead of zooming into it. */
  tapSelects: boolean;
}

const MIN_SIZE = 240;
const MAX_SIZE = 560;
const MAX_RINGS = 6;
/** The centre disc never gets smaller than this, so its text stays readable on a phone. */
const MIN_INNER = 50;
const INNER_SHARE = 0.32;
/** Room kept free around the rim for the selection and focus strokes. */
const RIM_MARGIN = 3;
/** How far the ring drawn for "nothing to show" reaches across the space the arcs would have had. */
const EMPTY_RING_SHARE = 0.28;
const TWEEN_MS = 240;
/** What every arc but the pointed-at one fades to: the pointed-at one reads as lifted without anything moving. */
const DIM_OPACITY = 0.55;
/** A wash of the text colour, so the empty ring suits every theme. */
const EMPTY_FILL = "color-mix(in srgb, var(--text) 8%, transparent)";
/** The plain ring of the root has no arc id of its own; this can never be the id of a real arc. */
const ROOT_RING_ID = "\u0000root";
/** Smallest centre disc that has room for a brand mark above the name. */
const ICON_MIN_INNER = 58;

const NAV_KEYS: Record<string, true> = { ArrowRight: true, ArrowLeft: true, ArrowDown: true, ArrowUp: true, Home: true, End: true };

// ---------------------------------------------------------------------------
// The plan: what the layout says the picture is, with no motion in it
// ---------------------------------------------------------------------------

interface Geo {
  a0: number;
  a1: number;
  r0: number;
  r1: number;
}

/** One thing the chart draws: a layout arc, or the plain ring shown when no arc fits inside the focus. */
interface Shape extends Geo {
  id: string;
  fill: string;
  arc: SunburstArc | null;
}

/** Where the keyboard can go from one arc. */
interface ArcNav {
  arc: SunburstArc;
  /** The arcs that share this one's parent, clockwise. */
  siblings: SunburstArc[];
  index: number;
  parent: SunburstArc | null;
  firstChild: SunburstArc | null;
}

interface Plan {
  layout: SunburstLayout;
  size: number;
  inner: number;
  fontSize: number;
  shapes: Shape[];
  /** Every arc a press can reach, by arc id. */
  nav: Map<string, ArcNav>;
  /** The ring next to the centre. */
  top: SunburstArc[];
  /** Where the keyboard starts; null when there is no arc at all. */
  entry: ArcNav | null;
}

function buildNav(arcs: readonly SunburstArc[]): { nav: Map<string, ArcNav>; top: SunburstArc[]; entry: ArcNav | null } {
  const top: SunburstArc[] = [];
  const byId = new Map<string, SunburstArc>();
  const children = new Map<string, SunburstArc[]>();
  // A ring-2 and deeper arc hangs off the arc whose path is its own minus the last key; ring 1 hangs off the focus.
  const parentIds = arcs.map((arc) => (arc.ring === 1 ? null : pathId(arc.path.slice(0, -1))));
  arcs.forEach((arc, i) => {
    byId.set(arc.id, arc);
    const parentId = parentIds[i];
    if (parentId === null) {
      top.push(arc);
      return;
    }
    const siblings = children.get(parentId);
    if (siblings) siblings.push(arc);
    else children.set(parentId, [arc]);
  });
  const nav = new Map<string, ArcNav>();
  arcs.forEach((arc, i) => {
    const parentId = parentIds[i];
    const siblings = parentId === null ? top : (children.get(parentId) ?? []);
    nav.set(arc.id, {
      arc,
      siblings,
      index: siblings.indexOf(arc),
      parent: parentId === null ? null : (byId.get(parentId) ?? null),
      firstChild: children.get(arc.id)?.[0] ?? null,
    });
  });
  return { nav, top, entry: top.length > 0 ? (nav.get(top[0].id) ?? null) : null };
}

function buildPlan(tree: StatNode, path: Path, metric: Metric, size: number): Plan {
  const outer = size / 2 - RIM_MARGIN;
  const inner = Math.round(Math.max(MIN_INNER, outer * INNER_SHARE));
  const layout = layoutSunburst(tree, path, metric, { innerRadius: inner, outerRadius: outer, maxRings: MAX_RINGS });
  const { nav, top, entry } = buildNav(layout.arcs);
  let shapes: Shape[];
  if (layout.arcs.length > 0) {
    shapes = layout.arcs.map((arc) => ({ id: arc.id, a0: arc.a0, a1: arc.a1, r0: arc.r0, r1: arc.r1, fill: paintCss(arc.paint), arc }));
  } else {
    // Nothing is drawable inside the focus: the focus itself is the ring, or a faint outline when it has no value at all.
    const empty = !(layout.total > 0);
    shapes = [
      {
        id: layout.focus.path.length > 0 ? pathId(layout.focus.path) : ROOT_RING_ID,
        a0: 0,
        a1: TAU,
        r0: inner,
        r1: empty ? inner + (outer - inner) * EMPTY_RING_SHARE : outer,
        fill: empty ? EMPTY_FILL : paintCss(layout.focusPaint),
        arc: null,
      },
    ];
  }
  return { layout, size, inner, fontSize: size >= 440 ? 12 : 11, shapes, nav, top, entry };
}

type ArcText = ArcLabel & { n: number };

/** Labels that fit inside their arcs, found once per plan (the arc text only depends on the shapes and the language). */
function labelsOf(plan: Plan, t: Translate): ArcText[] {
  const labels: ArcText[] = [];
  plan.shapes.forEach((shape, n) => {
    if (!shape.arc) return;
    const label = arcLabel(shape.arc, nodeLabel(shape.arc.node, t), plan.fontSize);
    if (label) labels.push({ n, ...label });
  });
  return labels;
}

// ---------------------------------------------------------------------------
// Motion: blending one plan into the next
// ---------------------------------------------------------------------------

/** One arc as it is on screen at this instant. */
interface DrawArc extends Geo {
  key: string;
  /** Index into the plan's shapes when a press can reach the arc; -1 for the plain ring and for arcs fading out. */
  n: number;
  fill: string;
  opacity: number;
  d: string;
}

interface Scene {
  plan: Plan;
  arcs: DrawArc[];
  /** False while arcs are still moving; the labels wait for it. */
  settled: boolean;
}

interface Start extends Geo {
  opacity: number;
}

interface Tween {
  /** Where each of the plan's shapes starts, parallel to `plan.shapes`. */
  from: Start[];
  /** Arcs the new picture no longer has: they fade where they stand. */
  leaving: DrawArc[];
}

function lerp(from: number, to: number, k: number): number {
  return from + (to - from) * k;
}

function settle(plan: Plan): DrawArc[] {
  return plan.shapes.map((shape, n) => ({
    key: shape.id,
    n: shape.arc ? n : -1,
    fill: shape.fill,
    opacity: 1,
    a0: shape.a0,
    a1: shape.a1,
    r0: shape.r0,
    r1: shape.r1,
    d: arcPath(shape.a0, shape.a1, shape.r0, shape.r1),
  }));
}

/**
 * Arcs are matched by id. A slice zoomed into keeps its children, which grow to fill the circle; an arc the
 * picture did not have yet grows out of its own inner edge, so nothing pops in; an arc the new picture drops
 * fades out where it stands. Starting from what is on screen (not from the last plan) keeps a quick second
 * change smooth instead of jumping back first.
 */
function startTween(drawn: readonly DrawArc[], plan: Plan): Tween {
  const before = new Map(drawn.map((arc) => [arc.key, arc] as const));
  const staying = new Set(plan.shapes.map((shape) => shape.id));
  return {
    from: plan.shapes.map((shape) => {
      const was = before.get(shape.id);
      return was ? { a0: was.a0, a1: was.a1, r0: was.r0, r1: was.r1, opacity: was.opacity } : { a0: shape.a0, a1: shape.a1, r0: shape.r0, r1: shape.r0, opacity: 0 };
    }),
    leaving: drawn.filter((arc) => !staying.has(arc.key) && arc.opacity > 0.02).map((arc) => ({ ...arc, n: -1 })),
  };
}

/** The picture `k` of the way (0 to 1) through the tween; fading arcs come first so they sit underneath. */
function blend(tween: Tween, plan: Plan, k: number): DrawArc[] {
  const arcs = tween.leaving.map((arc) => ({ ...arc, opacity: arc.opacity * (1 - k) }));
  plan.shapes.forEach((shape, n) => {
    const from = tween.from[n];
    const a0 = lerp(from.a0, shape.a0, k);
    const a1 = lerp(from.a1, shape.a1, k);
    const r0 = lerp(from.r0, shape.r0, k);
    const r1 = lerp(from.r1, shape.r1, k);
    arcs.push({ key: shape.id, n: shape.arc ? n : -1, fill: shape.fill, opacity: lerp(from.opacity, 1, k), a0, a1, r0, r1, d: arcPath(a0, a1, r0, r1) });
  });
  return arcs;
}

/** A new tree that draws the very same picture (a refresh that changed nothing visible) needs no motion and keeps its labels. */
function samePicture(a: Plan, b: Plan): boolean {
  if (a.shapes.length !== b.shapes.length) return false;
  return a.shapes.every((shape, i) => {
    const other = b.shapes[i];
    return shape.id === other.id && shape.fill === other.fill && Math.abs(shape.a0 - other.a0) < 1e-3 && Math.abs(shape.a1 - other.a1) < 1e-3 && Math.abs(shape.r0 - other.r0) < 0.5 && Math.abs(shape.r1 - other.r1) < 0.5;
  });
}

// ---------------------------------------------------------------------------
// Reading the chart: pointer and keyboard targets, and the words in the centre
// ---------------------------------------------------------------------------

/** The arc under an event target, if the target is (inside) a pressable arc. */
function navAt(target: EventTarget, plan: Plan): ArcNav | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<SVGElement>("[data-n]");
  const arc = el ? plan.shapes[Number(el.dataset.n)]?.arc : null;
  return (arc && plan.nav.get(arc.id)) || null;
}

function neighbour(nav: ArcNav, key: string): SunburstArc | null {
  const { siblings, index } = nav;
  if (key === "ArrowRight") return siblings[(index + 1) % siblings.length];
  if (key === "ArrowLeft") return siblings[(index + siblings.length - 1) % siblings.length];
  if (key === "Home") return siblings[0];
  if (key === "End") return siblings[siblings.length - 1];
  return key === "ArrowDown" ? nav.firstChild : nav.parent;
}

/** The root has no name of its own; it is everything. */
function labelOf(node: StatNode, t: Translate): string {
  return node.dim === "root" ? t("statistics.chart.total") : nodeLabel(node, t);
}

interface CentreText {
  name: string;
  value: string;
  /** The exact token count, for a tooltip. */
  exact: string | undefined;
  /** A hovered node's share of the focus, or what the figure at the focus is. */
  sub: string | null;
  /** How a provider is billed: whether the figure is an estimate or real money. */
  billing: string | null;
}

function centreText(node: StatNode, hovered: boolean, total: number, metric: Metric, locale: string, t: Translate): CentreText {
  const figure = costFigure(node);
  const priced = figure.kind === "priced" || figure.kind === "partial";
  const value = nodeValue(node, metric);
  // "Price unknown" and "Local" already say what the figure is; only a real amount needs its billing named.
  const billing = metric === "cost" && priced && node.dim === "provider" && node.billing ? t(BILLING_KEYS[node.billing].label) : null;
  let sub: string | null;
  if (hovered) sub = value > 0 ? formatShare(shareOf(value, total), locale) : null;
  else if (node.tokens <= 0 && node.cost <= 0) sub = t("statistics.chart.empty");
  else if (metric === "tokens") sub = t("statistics.metric.tokens");
  else if (!priced || billing !== null) sub = null;
  // Money that was really paid needs no "estimate" label; a plan's figure, or a mix of the two, does.
  else sub = t(node.cost - node.paygCost > node.cost * 1e-6 ? "statistics.estCost" : "statistics.metric.cost");
  return {
    name: labelOf(node, t),
    value: metric === "cost" ? costText(figure, locale, t) : formatTokens(node.tokens, locale),
    exact: metric === "tokens" ? formatCount(node.tokens, locale) : undefined,
    sub,
    billing,
  };
}

interface CentreProps {
  text: CentreText;
  inner: number;
  size: number;
  /** Provider id for the brand mark above the name; null when the node is not a provider or the disc is too small. */
  provider: string | null;
  /** The zoom-out sentence; null at the root, where the disc is only a readout. */
  zoomOut: string | null;
  onZoomOut: () => void;
}

function Centre({ text, inner, size, provider, zoomOut, onZoomOut }: CentreProps) {
  // Type grows with the disc, and a long figure shrinks to fit instead of being cut off.
  const k = Math.min(1.25, Math.max(0.88, inner / 62));
  const room = inner * 1.5;
  const valueSize = Math.max(10, Math.min(16 * k, room / (textWidth(text.value, 1) * 1.1)));
  const body = (
    <span className="stats-sunburst__body" style={{ maxWidth: room }}>
      {provider !== null && <ProviderIcon provider={provider} size={Math.round(15 * k)} style={{ flex: "none" }} />}
      <span className="stats-sunburst__name" style={{ fontSize: 12 * k, WebkitLineClamp: text.sub !== null && text.billing !== null ? 1 : 2 }}>
        {text.name}
      </span>
      <span className="stats-sunburst__value" style={{ fontSize: valueSize }} title={text.exact}>
        {text.value}
      </span>
      {text.sub !== null && (
        <span className="stats-sunburst__sub" style={{ fontSize: 11.5 * k }}>
          {text.sub}
        </span>
      )}
      {text.billing !== null && (
        <span className="stats-sunburst__sub" style={{ fontSize: 11.5 * k }}>
          {text.billing}
        </span>
      )}
    </span>
  );
  const style = { width: `${((2 * inner - 4) / size) * 100}%` };
  if (zoomOut === null) {
    return (
      <div className="stats-sunburst__centre" style={style}>
        {body}
      </div>
    );
  }
  return (
    <button type="button" className="stats-sunburst__centre ui-focus-ring" style={style} aria-label={zoomOut} title={zoomOut} onClick={onZoomOut}>
      {body}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------

function SunburstView({ tree, path, metric, selected, hovered, onHover, onZoom, onSelect, tapSelects, size }: SunburstProps & { size: number }) {
  const { locale, t, tn } = useI18n();
  const reduced = usePrefersReducedMotion();
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const hostRef = useRef<HTMLDivElement>(null);
  /** Mirrors `scene` for effects, which start a tween from what is on screen without waiting for a render. */
  const sceneRef = useRef<Scene | null>(null);

  const [scene, setScene] = useState<Scene | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [spoken, setSpoken] = useState("");

  // The page hands over a fresh array on most renders; only its content changes the picture.
  const pathKey = JSON.stringify(path);
  const plan = useMemo(() => buildPlan(tree, JSON.parse(pathKey) as string[], metric, size), [tree, pathKey, metric, size]);
  const labels = useMemo(() => labelsOf(plan, t), [plan, t]);

  // Runs before paint, so the first frame of a change is still the old picture and never a flash of the new one.
  useLayoutEffect(() => {
    const current = sceneRef.current;
    if (current && current.plan === plan && current.settled) return;
    const show = (next: Scene) => {
      sceneRef.current = next;
      setScene(next);
    };
    const finish = () => show({ plan, arcs: settle(plan), settled: true });
    if (!current || reduced || current.plan.size !== plan.size || (current.settled && samePicture(current.plan, plan))) {
      finish();
      return;
    }
    const tween = startTween(current.arcs, plan);
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, Math.max(0, (now - began) / TWEEN_MS));
      if (k >= 1) {
        finish();
        return;
      }
      show({ plan, arcs: blend(tween, plan, 1 - (1 - k) ** 3), settled: false });
      frame = requestAnimationFrame(step);
    };
    show({ plan, arcs: blend(tween, plan, 0), settled: false });
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [plan, reduced]);

  const { focus } = plan.layout;
  const hoveredId = hovered && hovered.length > 0 ? pathId(hovered) : null;
  const selectedId = selected && selected.length > 0 ? pathId(selected) : null;
  const spotlight = hoveredId !== null && plan.nav.has(hoveredId);
  const activeNav = (activeId !== null ? plan.nav.get(activeId) : undefined) ?? plan.entry;
  // Only something inside the zoom is described in the centre: its share is of the focus, which is what the centre shows by default.
  const hoveredNode = hovered && hovered.length > focus.path.length && focus.path.every((key, i) => hovered[i] === key) ? rerootAt(tree, hovered) : null;
  const text = centreText(hoveredNode ?? focus.node, hoveredNode !== null, plan.layout.total, metric, locale, t);
  const parent = focus.trail[focus.trail.length - 2];
  const hintId = `${uid}-hint`;

  const zoomOut = () => {
    if (focus.path.length === 0) return;
    // Keep the keyboard's place on the node just zoomed out of.
    setActiveId(pathId(focus.path));
    onZoom(focus.path.slice(0, -1));
  };

  /** A press: zoom into an arc that has more inside it, otherwise select it. Touch always selects. */
  const activate = (nav: ArcNav) => {
    const { arc } = nav;
    if (!tapSelects && arc.node.children?.some((child) => nodeValue(child, metric) > 0)) {
      setActiveId(nav.firstChild?.id ?? null);
      onZoom(arc.path);
    } else {
      setActiveId(arc.id);
      onSelect(arc.path);
    }
  };

  const say = (arc: SunburstArc) => {
    const said = centreText(arc.node, true, plan.layout.total, metric, locale, t);
    const unit = metric === "tokens" ? ` ${t("statistics.metric.tokens")}` : said.billing ? ` (${said.billing})` : "";
    setSpoken(t("statistics.chart.announce", { name: said.name, value: `${said.value}${unit}`, share: said.sub ?? "" }));
  };

  const onPointerOver = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "touch") return;
    const nav = navAt(event.target, plan);
    if (nav) {
      if (nav.arc.id !== hoveredId) onHover(nav.arc.path);
    } else if (hovered !== null) {
      onHover(null);
    }
  };

  const onPointerLeave = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== "touch" && hovered !== null) onHover(null);
  };

  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    const nav = navAt(event.target, plan);
    if (nav) activate(nav);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const { key } = event;
    if (key === "Escape" || key === "Backspace") {
      if (focus.path.length === 0) return;
      event.preventDefault();
      zoomOut();
      return;
    }
    // Other keys typed on the centre button belong to the button: Enter and Space press it.
    if (event.target !== event.currentTarget || !activeNav) return;
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      activate(activeNav);
      return;
    }
    if (!Object.hasOwn(NAV_KEYS, key)) return;
    event.preventDefault();
    const next = neighbour(activeNav, key);
    if (next) {
      setActiveId(next.id);
      say(next);
    }
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    // Announce only a keyboard arrival: a mouse press focuses the group too, and must not start talking.
    if (event.target === event.currentTarget && event.currentTarget.matches(":focus-visible") && activeNav) say(activeNav.arc);
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) setSpoken("");
  };

  const onZoomOutPress = () => {
    // Zooming out to the root turns this button into a plain readout, so hand focus to the chart before it goes.
    if (focus.path.length <= 1) hostRef.current?.focus({ preventScroll: true });
    zoomOut();
  };

  const selectedArc = scene && selectedId !== null ? scene.arcs.find((arc) => arc.n >= 0 && arc.key === selectedId) : undefined;
  const activeArc = scene && activeNav ? scene.arcs.find((arc) => arc.n >= 0 && arc.key === activeNav.arc.id) : undefined;
  const labelsOn = scene !== null && scene.settled && scene.plan === plan;

  return (
    <div
      ref={hostRef}
      className="stats-sunburst__group"
      role="group"
      tabIndex={plan.entry ? 0 : undefined}
      aria-label={tn("statistics.chart.label", plan.top.length, { name: labelOf(focus.node, t) })}
      aria-describedby={plan.entry ? hintId : undefined}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {scene && (
        <svg
          className="stats-sunburst__svg"
          viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
          aria-hidden="true"
          focusable="false"
          onPointerOver={onPointerOver}
          onPointerLeave={onPointerLeave}
          onClick={onClick}
        >
          <defs>
            {labels.map((label) => (
              <path key={label.n} id={`${uid}-${label.n}`} d={label.d} />
            ))}
          </defs>
          <g className={scene.settled ? undefined : "stats-sunburst__arcs--moving"}>
            {scene.arcs.map((arc) => (
              <path
                key={arc.key}
                className={arc.n >= 0 ? "stats-sunburst__arc" : "stats-sunburst__arc stats-sunburst__arc--still"}
                d={arc.d}
                data-n={arc.n >= 0 ? arc.n : undefined}
                style={{ fill: arc.fill, opacity: arc.opacity * (spotlight && arc.n >= 0 && arc.key !== hoveredId && arc.key !== selectedId ? DIM_OPACITY : 1) }}
              />
            ))}
          </g>
          <g className="stats-sunburst__marks">
            {selectedArc && <path className="stats-sunburst__selected" d={selectedArc.d} />}
            {activeArc && (
              <g className="stats-sunburst__active">
                <path className="stats-sunburst__halo" d={activeArc.d} />
                <path className="stats-sunburst__ring" d={activeArc.d} />
              </g>
            )}
          </g>
          <g className={labelsOn ? "stats-sunburst__labels stats-sunburst__labels--on" : "stats-sunburst__labels"}>
            {labels.map((label) => (
              <text key={label.n} className="stats-sunburst__label" fontSize={plan.fontSize} dy="0.35em">
                <textPath href={`#${uid}-${label.n}`} startOffset="50%">
                  {label.text}
                </textPath>
              </text>
            ))}
          </g>
        </svg>
      )}
      <Centre
        text={text}
        inner={plan.inner}
        size={size}
        provider={plan.inner >= ICON_MIN_INNER && (hoveredNode ?? focus.node).dim === "provider" ? ((hoveredNode ?? focus.node).provider ?? null) : null}
        zoomOut={parent ? t("statistics.chart.zoomOut", { name: labelOf(parent, t) }) : null}
        onZoomOut={onZoomOutPress}
      />
      <div id={hintId} className="stats-sunburst__sr">
        {t("statistics.chart.hint")}
      </div>
      <div className="stats-sunburst__sr" aria-live="polite" aria-atomic="true">
        {spoken}
      </div>
    </div>
  );
}

export function Sunburst(props: SunburstProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(0);

  // The chart is laid out in real pixels, so it needs its width before it can draw anything.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = (width: number) => {
      if (width >= 1) setSize(Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(width))));
    };
    measure(frame.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) measure(last.contentRect.width);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <style>{CSS}</style>
      <div ref={frameRef} className="stats-sunburst">
        {size > 0 && <SunburstView {...props} size={size} />}
      </div>
    </>
  );
}

const CSS = `
.stats-sunburst {
  position: relative;
  width: 100%;
  max-width: ${MAX_SIZE}px;
  aspect-ratio: 1;
  margin-inline: auto;
}
.stats-sunburst__group {
  position: absolute;
  inset: 0;
  outline: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.stats-sunburst__svg {
  display: block;
  width: 100%;
  height: 100%;
}
.stats-sunburst__arc {
  stroke: var(--bg-panel);
  stroke-width: 1;
  stroke-linejoin: round;
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-out-warm);
}
.stats-sunburst__arc--still {
  pointer-events: none;
  cursor: default;
}
.stats-sunburst__arcs--moving .stats-sunburst__arc {
  transition: none;
}
.stats-sunburst__marks {
  pointer-events: none;
  fill: none;
  stroke-linejoin: round;
}
.stats-sunburst__selected {
  stroke: var(--text);
  stroke-width: 2;
}
.stats-sunburst__active {
  display: none;
}
.stats-sunburst__group:focus-visible .stats-sunburst__active {
  display: inline;
}
.stats-sunburst__halo {
  stroke: var(--bg-panel);
  stroke-width: 6;
}
.stats-sunburst__ring {
  stroke: var(--accent);
  stroke-width: 3;
}
.stats-sunburst__labels {
  pointer-events: none;
  opacity: 0;
}
.stats-sunburst__labels--on {
  opacity: 1;
  transition: opacity var(--dur-fast) var(--ease-out-warm);
}
.stats-sunburst__label {
  fill: var(--text);
  stroke: var(--bg-panel);
  stroke-width: 3px;
  stroke-linejoin: round;
  paint-order: stroke;
  font-weight: 500;
  text-anchor: middle;
}
.stats-sunburst__centre {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  aspect-ratio: 1;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--bg-subtle);
  color: var(--text);
  font: inherit;
  text-align: center;
  overflow: hidden;
}
button.stats-sunburst__centre {
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out-warm);
}
button.stats-sunburst__centre:hover {
  background: var(--bg-hover);
}
.stats-sunburst__body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.stats-sunburst__name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-weight: 500;
  line-height: 1.2;
}
.stats-sunburst__value {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
  white-space: nowrap;
}
.stats-sunburst__sub {
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}
.stats-sunburst__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
@media (prefers-reduced-motion: reduce) {
  .stats-sunburst__arc,
  .stats-sunburst__labels--on,
  button.stats-sunburst__centre {
    transition: none;
  }
}
@media (forced-colors: active) {
  .stats-sunburst__arc {
    stroke: CanvasText;
  }
  .stats-sunburst__label {
    fill: CanvasText;
    stroke: none;
  }
  .stats-sunburst__selected,
  .stats-sunburst__ring {
    stroke: Highlight;
  }
  .stats-sunburst__centre {
    border: 1px solid CanvasText;
  }
}
`;
