/**
 * The geometry of the Statistics sunburst, with no DOM and no React in it, so
 * the browser draws what this works out and a test can check the maths.
 *
 * Angles run clockwise from 12 o'clock, in radians. The ring tree comes from
 * the server (`StatNode`); "zooming" is only choosing a different focus node:
 * its children fill the whole circle and its descendants fill the rings outside.
 */

import { OTHER_KEY, type StatNode } from "./types";

export type Metric = "cost" | "tokens";

export const TAU = Math.PI * 2;

/** Keys are joined with a character no provider, model, path or id contains. */
const PATH_SEP = "\u001f";
/** A full circle cannot be one SVG arc (both ends meet), so a ring that fills it stops a hair short. */
const FULL_TURN_EPSILON = 1e-4;
/** Average glyph width as a share of the font size, for fitting a label to an arc without measuring it. */
const LATIN_WIDTH_EM = 0.56;
/** Full-width characters (CJK, kana, hangul, wide symbols) are about as wide as they are tall. */
const WIDE_WIDTH_EM = 1;
const WIDE_FROM = 0x2e80;

export function pathId(path: readonly string[]): string {
  return path.join(PATH_SEP);
}

export function nodeValue(node: Pick<StatNode, "cost" | "tokens">, metric: Metric): number {
  return metric === "cost" ? node.cost : node.tokens;
}

// ---------------------------------------------------------------------------
// Focus: which node the circle is zoomed into
// ---------------------------------------------------------------------------

export interface SunburstFocus {
  /** The part of the asked path the tree still has: cut at the first key that is gone. */
  path: string[];
  /** The nodes from the root to the focus, root first. */
  trail: StatNode[];
  node: StatNode;
}

/**
 * Walks `path` (child keys from the root) as far as the tree goes. A new
 * period or a new grouping can remove a node the page was zoomed into, so the
 * caller gets the deepest ancestor that survives instead of an empty circle.
 */
export function resolveFocus(tree: StatNode, path: readonly string[]): SunburstFocus {
  const trail: StatNode[] = [tree];
  const kept: string[] = [];
  let node = tree;
  for (const key of path) {
    const next = node.children?.find((child) => child.key === key);
    if (!next) break;
    kept.push(key);
    trail.push(next);
    node = next;
  }
  return { path: kept, trail, node };
}

/** The node at exactly `path`, or null when any key on the way is missing. */
export function rerootAt(tree: StatNode, path: readonly string[]): StatNode | null {
  const focus = resolveFocus(tree, path);
  return focus.path.length === path.length ? focus.node : null;
}

/** Children in the order a table lists them: biggest first, the `other` bucket last. */
export function rankChildren(node: StatNode, metric: Metric): StatNode[] {
  const kids = [...(node.children ?? [])];
  const order = new Map(kids.map((kid, index) => [kid, index]));
  return kids.sort((a, b) => {
    if (!!a.other !== !!b.other) return a.other ? 1 : -1;
    return nodeValue(b, metric) - nodeValue(a, metric) || (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * The hues handed to the first ring, in order, as `--todo-color-<name>` tokens
 * (app/globals.css). Neighbouring entries are far apart on the colour wheel.
 */
export const FAMILY_TOKENS: readonly string[] = ["blue", "orange", "green", "purple", "red", "yellow", "pink"];
const OTHER_TOKEN = "gray";

/** How far each ring fades toward the panel colour, by ring depth from the root (1 = innermost). */
const LEVEL_FADE: readonly number[] = [0, 0, 0.16, 0.3, 0.42, 0.52];
const SIBLING_FADE = 0.08;
/** The 8th to 10th first-ring slices reuse the hues, lighter. */
const TINT_FADE = 0.28;
const MAX_FADE = 0.78;

export interface Paint {
  /** Index of the first-ring ancestor, in the server's order; stable while zoomed. */
  family: number;
  /** The `other` bucket is grey whatever it sits under. */
  other: boolean;
  /** 0 = the pure hue, up to MAX_FADE = mostly the panel colour. */
  fade: number;
}

/** A node's paint, from its first-ring family, its depth from the root and its place among its siblings. */
export function paintFor(family: number, other: boolean, level: number, sibling: number): Paint {
  const tint = family >= FAMILY_TOKENS.length ? TINT_FADE : 0;
  const depth = LEVEL_FADE[Math.min(Math.max(level, 1), LEVEL_FADE.length) - 1];
  const alternate = level >= 2 ? (sibling % 2) * SIBLING_FADE : 0;
  return { family, other, fade: Math.min(MAX_FADE, depth + alternate + tint) };
}

/** The CSS colour of a paint: a theme token mixed toward the panel, so every theme keeps its own look. */
export function paintCss(paint: Paint): string {
  const token = paint.other ? OTHER_TOKEN : FAMILY_TOKENS[paint.family % FAMILY_TOKENS.length];
  const hue = `var(--todo-color-${token})`;
  return paint.fade <= 0 ? hue : `color-mix(in srgb, ${hue} ${Math.round((1 - paint.fade) * 100)}%, var(--bg-panel))`;
}

/** The colour a first-ring slice or a timeline series carries. */
export function seriesPaint(index: number, other: boolean): Paint {
  return paintFor(index, other, 1, 0);
}

/** The paint of the child at `index` of the focus, for a table row that has to match its arc. */
export function childPaint(tree: StatNode, focusPath: readonly string[], index: number, other: boolean): Paint {
  if (focusPath.length === 0) return paintFor(index, other, 1, index);
  const family = tree.children?.findIndex((child) => child.key === focusPath[0]) ?? -1;
  return paintFor(Math.max(0, family), other, focusPath.length + 1, index);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface SunburstOptions {
  /** Radius of the centre disc, px. */
  innerRadius: number;
  outerRadius: number;
  /** Most rings drawn outside the focus; default 6. */
  maxRings?: number;
  /** Arcs narrower than this many radians are left out: they are too thin to see or press. */
  minAngle?: number;
}

export interface SunburstArc {
  /** Child keys from the tree root. */
  path: string[];
  id: string;
  node: StatNode;
  /** 1 = the ring next to the centre. */
  ring: number;
  a0: number;
  a1: number;
  r0: number;
  r1: number;
  value: number;
  /** Share of the focus under the metric, 0 to 1. */
  share: number;
  paint: Paint;
}

export interface SunburstLayout {
  focus: SunburstFocus;
  metric: Metric;
  /** The focus's value under the metric. */
  total: number;
  /** Rings drawn; the radius from centre disc to rim is divided among them. */
  rings: number;
  arcs: SunburstArc[];
  /** The focus's own colour, for the ring drawn when it has nothing inside. */
  focusPaint: Paint;
}

const DEFAULT_MAX_RINGS = 6;
const DEFAULT_MIN_ANGLE = 0.004;

function drawableDepth(node: StatNode, metric: Metric, limit: number): number {
  if (limit <= 0) return 0;
  let deepest = 0;
  for (const kid of node.children ?? []) {
    if (nodeValue(kid, metric) > 0) deepest = Math.max(deepest, 1 + drawableDepth(kid, metric, limit - 1));
  }
  return deepest;
}

/**
 * Places every arc of the circle zoomed into `path`. A child gets the share of
 * its parent's angle that its value has of the parent's value; nodes with no
 * value under the metric (a model with no known price, in cost mode) take no
 * room at all. Angles of the children of one node always add up to at most the
 * node's own.
 */
export function layoutSunburst(tree: StatNode, path: readonly string[], metric: Metric, options: SunburstOptions): SunburstLayout {
  const focus = resolveFocus(tree, path);
  const maxRings = options.maxRings ?? DEFAULT_MAX_RINGS;
  const minAngle = options.minAngle ?? DEFAULT_MIN_ANGLE;
  const total = nodeValue(focus.node, metric);
  const rings = Math.min(maxRings, drawableDepth(focus.node, metric, maxRings));
  const thickness = rings > 0 ? (options.outerRadius - options.innerRadius) / rings : 0;
  const family = focus.path.length === 0 ? -1 : (tree.children?.findIndex((child) => child.key === focus.path[0]) ?? -1);
  const arcs: SunburstArc[] = [];

  const place = (parent: StatNode, parentPath: string[], parentFamily: number, ring: number, a0: number, a1: number): void => {
    const kids = parent.children ?? [];
    let sum = 0;
    for (const kid of kids) sum += Math.max(0, nodeValue(kid, metric));
    const denominator = Math.max(nodeValue(parent, metric), sum);
    if (!(denominator > 0)) return;
    let cursor = a0;
    kids.forEach((kid, index) => {
      const value = nodeValue(kid, metric);
      if (!(value > 0)) return;
      const start = cursor;
      const end = start + ((a1 - a0) * value) / denominator;
      cursor = end;
      if (end - start < minAngle) return;
      const kidPath = [...parentPath, kid.key];
      const kidFamily = ring === 1 && focus.path.length === 0 ? index : parentFamily;
      arcs.push({
        path: kidPath,
        id: pathId(kidPath),
        node: kid,
        ring,
        a0: start,
        a1: end,
        r0: options.innerRadius + (ring - 1) * thickness,
        r1: options.innerRadius + ring * thickness,
        value,
        share: total > 0 ? value / total : 0,
        paint: paintFor(kidFamily, kid.key === OTHER_KEY || !!kid.other, kidPath.length, index),
      });
      if (ring < rings) place(kid, kidPath, kidFamily, ring + 1, start, end);
    });
  };
  if (rings > 0) place(focus.node, focus.path, Math.max(0, family), 1, 0, TAU);

  const parent = focus.trail[focus.trail.length - 2];
  const own = parent?.children?.indexOf(focus.node) ?? 0;
  return {
    focus,
    metric,
    total,
    rings,
    arcs,
    focusPaint: paintFor(Math.max(0, family), !!focus.node.other, Math.max(1, focus.path.length), own),
  };
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

/** The point at radius `r` and angle `a` (clockwise from 12 o'clock), y growing downward as in SVG. */
export function polar(r: number, a: number): [number, number] {
  return [r * Math.sin(a), -r * Math.cos(a)];
}

function fixed(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** The outline of one ring sector as an SVG path. */
export function arcPath(a0: number, a1: number, r0: number, r1: number): string {
  const end = a0 + Math.min(a1 - a0, TAU - FULL_TURN_EPSILON);
  const large = end - a0 > Math.PI ? 1 : 0;
  const [ox0, oy0] = polar(r1, a0);
  const [ox1, oy1] = polar(r1, end);
  const outer = `M${fixed(ox0)} ${fixed(oy0)}A${fixed(r1)} ${fixed(r1)} 0 ${large} 1 ${fixed(ox1)} ${fixed(oy1)}`;
  if (r0 <= 0) return `${outer}L0 0Z`;
  const [ix1, iy1] = polar(r0, end);
  const [ix0, iy0] = polar(r0, a0);
  return `${outer}L${fixed(ix1)} ${fixed(iy1)}A${fixed(r0)} ${fixed(r0)} 0 ${large} 0 ${fixed(ix0)} ${fixed(iy0)}Z`;
}

/** How wide `text` runs at `fontSize` px, estimated per character so no DOM measurement is needed. */
export function textWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const char of text) em += (char.codePointAt(0) ?? 0) >= WIDE_FROM ? WIDE_WIDTH_EM : LATIN_WIDTH_EM;
  return em * fontSize;
}

function fitText(text: string, fontSize: number, room: number): string {
  if (textWidth(text, fontSize) <= room) return text;
  const chars = Array.from(text);
  while (chars.length > 1) {
    chars.pop();
    const cut = `${chars.join("").trimEnd()}…`;
    if (textWidth(cut, fontSize) <= room) return cut;
  }
  return "";
}

export interface ArcLabel {
  text: string;
  /** The path the text runs along, kept upright: it is drawn against the sweep in the lower half. */
  d: string;
}

/** Room an arc must have, beyond the text itself, before it is labelled. */
const LABEL_PADDING = 10;
/** Narrowest text worth showing: a label shorter than this many characters says nothing. */
const LABEL_MIN_CHARS = 3;

/**
 * A label that fits inside the arc, or null. The text follows the arc around its
 * middle, shortened with an ellipsis to the room there is.
 */
export function arcLabel(arc: Pick<SunburstArc, "a0" | "a1" | "r0" | "r1">, text: string, fontSize: number): ArcLabel | null {
  const thickness = arc.r1 - arc.r0;
  if (!text || thickness < fontSize + 4) return null;
  const mid = (arc.r0 + arc.r1) / 2;
  const span = Math.min(arc.a1 - arc.a0, TAU - FULL_TURN_EPSILON);
  const room = span * mid - LABEL_PADDING;
  const shown = fitText(text, fontSize, room);
  if (Array.from(shown).length < Math.min(LABEL_MIN_CHARS, Array.from(text).length)) return null;
  const width = textWidth(shown, fontSize);
  const centre = arc.a0 + span / 2;
  const half = Math.min(span, (width + 4) / mid) / 2;
  const from = centre - half;
  const to = centre + half;
  const turned = Math.cos(centre) < 0;
  const [x0, y0] = polar(mid, turned ? to : from);
  const [x1, y1] = polar(mid, turned ? from : to);
  return { text: shown, d: `M${fixed(x0)} ${fixed(y0)}A${fixed(mid)} ${fixed(mid)} 0 0 ${turned ? 0 : 1} ${fixed(x1)} ${fixed(y1)}` };
}
