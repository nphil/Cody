/**
 * What the Statistics page shows, worked out from the index: the headline
 * totals beside the period before, the ring tree, the daily timeline and a few
 * plain findings. Pure — no disk, no clock, no network. Who may see which chat
 * and the human labels come in as arguments, so one code path answers for every
 * account and a hand-made store can test it.
 */

import { providerLabel } from "./billing";
import { dayToInt, eachDay, intToDay, previousPeriod } from "./days";
import type { IndexStatus } from "./service";
import type { StatsStore } from "./store";
import {
  emptyCounters,
  addCounters,
  GROUP_BY_DIMS,
  OTHER_KEY,
  SLUG_PREFIX,
  totalTokens,
  type Counters,
  type DeepDiveResponse,
  type DeepDiveSubagent,
  type DeepDiveTurn,
  type DeepDiveWorker,
  type Dim,
  type FileEntry,
  type GroupBy,
  type Insight,
  type PeriodInfo,
  type PeriodTotals,
  type StatNode,
  type StatRow,
  type StatisticsResponse,
  type TimelineSeries,
  type TopTurn,
} from "./types";
import { parseWorker } from "./workers";

/** Decides whether the viewer may see usage that belongs to a chat. `""` is usage outside any chat. */
export type ChatVisibility = (chat: string) => boolean;

export interface StatsLabels {
  /** Chat id -> its title. */
  titles: ReadonlyMap<string, string>;
  /**
   * Working directory -> the project it belongs to (the repo its worktrees
   * share). An empty string files the directory under no project at all.
   */
  projectOf: ReadonlyMap<string, string>;
}

export const NO_LABELS: StatsLabels = { titles: new Map(), projectOf: new Map() };

export interface StatisticsArgs {
  store: StatsStore;
  now: number;
  period: PeriodInfo;
  groupBy: GroupBy;
  visible: ChatVisibility;
  labels: StatsLabels;
  status: IndexStatus;
}

export interface DeepDiveArgs {
  store: StatsStore;
  chat: string;
  /** Restricts `inPeriod`; null leaves it out. */
  period: PeriodInfo | null;
  labels: StatsLabels;
  status: IndexStatus;
}

/** Nodes kept under the root; the page colours them, so there is a palette's worth. */
const ROOT_KEEP = 9;
/** Children kept under any other parent, tried in turn until the whole tree fits. */
const KEEP_STEPS: readonly number[] = [24, 16, 10, 6, 4];
/** The most nodes a response carries, so a big install cannot send a huge tree. */
export const MAX_NODES = 1_500;
const TOP_TURNS_SHOWN = 8;
const SUBAGENTS_SHOWN = 60;
const UNPRICED_MODELS_SHOWN = 8;
/** A first-ring node must reach this share of the cost or tokens to be called out as the top spender. */
const TOP_SPENDER_MIN_SHARE = 0.3;
/** Savings below this are noise, not a finding. */
const CACHE_SAVED_MIN = 0.5;

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/** The counters plus the part of the cost that was real pay-as-you-go money. */
interface Tally extends Counters {
  payg: number;
}

function emptyTally(): Tally {
  return { ...emptyCounters(), payg: 0 };
}

function addTally(into: Tally, from: Tally): void {
  addCounters(into, from);
  into.payg += from.payg;
}

function addRow(into: Tally, row: StatRow, payg: boolean): void {
  into.n += row.n;
  into.input += row.input;
  into.output += row.output;
  into.cacheRead += row.cacheRead;
  into.cacheWrite += row.cacheWrite;
  into.cost += row.cost;
  into.unpriced += row.unpriced;
  into.save += row.save;
  if (payg) into.payg += row.cost;
}

function totalsOf(tally: Tally, chats: number): PeriodTotals {
  const prompt = tally.input + tally.cacheRead + tally.cacheWrite;
  return {
    cost: tally.cost,
    paygCost: tally.payg,
    tokens: totalTokens(tally),
    input: tally.input,
    output: tally.output,
    cacheRead: tally.cacheRead,
    cacheWrite: tally.cacheWrite,
    unpricedTokens: tally.unpriced,
    chats,
    messages: tally.n,
    cacheHitRate: prompt > 0 ? tally.cacheRead / prompt : null,
  };
}

/** A node of the tree while it is still being summed. */
interface Branch extends Tally {
  dim: Dim | "root";
  key: string;
  provider: string;
  model: string;
  kids: Map<string, Branch> | null;
}

function newBranch(dim: Dim | "root", key: string, provider: string, model: string): Branch {
  return { ...emptyTally(), dim, key, provider, model, kids: null };
}

// ---------------------------------------------------------------------------
// Which project and chat a transcript's rows belong to
// ---------------------------------------------------------------------------

interface FileCtx {
  chat: string;
  /** Project key: a directory, `slug:<folder>`, or '' for none. */
  project: string;
  visible: boolean;
}

function ownProject(file: FileEntry, projectOf: ReadonlyMap<string, string>): string {
  if (file.cwd) return projectOf.get(file.cwd) ?? file.cwd;
  return file.slug ? `${SLUG_PREFIX}${file.slug}` : "";
}

/**
 * A chat's own transcript names its project; its subagents, advisor and
 * background jobs are filed under the same one, so a chat is never split
 * across projects by a helper that ran somewhere else.
 */
function fileContexts(store: StatsStore, visible: ChatVisibility, labels: StatsLabels): Map<number, FileCtx> {
  const chatProject = new Map<string, string>();
  for (const file of store.files.values()) {
    if (file.kind === "main" || file.kind === "sidebar") chatProject.set(file.chat, ownProject(file, labels.projectOf));
  }
  const allowed = new Map<string, boolean>();
  const out = new Map<number, FileCtx>();
  for (const file of store.files.values()) {
    let ok = allowed.get(file.chat);
    if (ok === undefined) {
      ok = visible(file.chat);
      allowed.set(file.chat, ok);
    }
    out.set(file.id, { chat: file.chat, project: chatProject.get(file.chat) ?? ownProject(file, labels.projectOf), visible: ok });
  }
  return out;
}

function dimKey(dim: Dim, row: StatRow, ctx: FileCtx): string {
  if (dim === "provider") return row.provider;
  if (dim === "model") return `${row.provider}/${row.model}`;
  if (dim === "project") return ctx.project;
  if (dim === "chat") return ctx.chat;
  return row.worker;
}

/**
 * Short names for project keys: the last folder of the path, widened with its
 * parents only while two different projects would otherwise read the same.
 */
export function projectLabels(keys: Iterable<string>): Map<string, string> {
  const parts = new Map<string, string[]>();
  for (const key of new Set(keys)) {
    if (key === "") continue;
    parts.set(key, key.startsWith(SLUG_PREFIX) ? [key.slice(SLUG_PREFIX.length).split("-").filter(Boolean).pop() ?? key] : key.split(/[\\/]+/).filter(Boolean));
  }
  const width = new Map<string, number>();
  for (const key of parts.keys()) width.set(key, 1);
  const labelOf = (key: string): string => (parts.get(key) ?? []).slice(-(width.get(key) ?? 1)).join("/");
  for (let round = 0; round < 6; round += 1) {
    const byLabel = new Map<string, string[]>();
    for (const key of parts.keys()) {
      const label = labelOf(key);
      const same = byLabel.get(label);
      if (same) same.push(key);
      else byLabel.set(label, [key]);
    }
    let widened = false;
    for (const same of byLabel.values()) {
      if (same.length < 2) continue;
      for (const key of same) {
        const have = width.get(key) ?? 1;
        if (have < (parts.get(key)?.length ?? 0)) {
          width.set(key, have + 1);
          widened = true;
        }
      }
    }
    if (!widened) break;
  }
  const out = new Map<string, string>();
  for (const key of parts.keys()) out.set(key, labelOf(key) || key);
  return out;
}

// ---------------------------------------------------------------------------
// The ring tree
// ---------------------------------------------------------------------------

interface NodeEnv {
  store: StatsStore;
  labels: StatsLabels;
  projectNames: Map<string, string>;
  dims: readonly Dim[];
}

/** Most expensive first, then the most tokens, then by key so equal nodes keep a fixed order. */
function byWeight(a: Branch, b: Branch): number {
  return b.cost - a.cost || totalTokens(b) - totalTokens(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * Keeps the `limit` children that matter most — by their share of the parent's
 * cost or of its tokens, whichever is larger, so a model that is cheap but
 * token-heavy survives as well as an expensive one — and folds the rest into one
 * `other` node. A single leftover is kept as it is: an "other" holding one
 * thing hides it for nothing.
 */
function trim(parent: Branch, kids: Branch[], limit: number): Branch[] {
  if (kids.length <= limit + 1) return kids.sort(byWeight);
  const parentCost = parent.cost;
  const parentTokens = totalTokens(parent);
  const importance = (kid: Branch): number =>
    Math.max(parentCost > 0 ? kid.cost / parentCost : 0, parentTokens > 0 ? totalTokens(kid) / parentTokens : 0);
  const ranked = kids.map((kid) => ({ kid, score: importance(kid) })).sort((a, b) => b.score - a.score || byWeight(a.kid, b.kid));
  const kept = ranked.slice(0, limit).map((entry) => entry.kid).sort(byWeight);
  const other = newBranch(kids[0].dim, OTHER_KEY, "", "");
  for (const entry of ranked.slice(limit)) addTally(other, entry.kid);
  kept.push(other);
  return kept;
}

function labelOf(branch: Branch, env: NodeEnv): string {
  if (branch.dim === "root" || branch.key === OTHER_KEY) return "";
  if (branch.dim === "provider") return providerLabel(branch.key);
  if (branch.dim === "model") return branch.model;
  if (branch.dim === "project") return env.projectNames.get(branch.key) ?? "";
  if (branch.dim === "chat") return env.labels.titles.get(branch.key) ?? "";
  return branch.key;
}

function toNode(branch: Branch, depth: number, keep: number, env: NodeEnv, count: { nodes: number }): StatNode {
  count.nodes += 1;
  const node: StatNode = {
    key: branch.key,
    dim: branch.dim,
    label: labelOf(branch, env),
    cost: branch.cost,
    paygCost: branch.payg,
    tokens: totalTokens(branch),
    input: branch.input,
    output: branch.output,
    cacheRead: branch.cacheRead,
    cacheWrite: branch.cacheWrite,
    unpricedTokens: branch.unpriced,
    messages: branch.n,
  };
  if (branch.dim !== "root" && branch.key === OTHER_KEY) {
    node.other = true;
    return node;
  }
  if (branch.dim === "provider" || branch.dim === "model") {
    node.provider = branch.provider;
    node.billing = env.store.billingOf(branch.provider);
  } else if (branch.dim === "chat" && branch.key !== "") {
    node.chat = branch.key;
  } else if (branch.dim === "project" && branch.key !== "" && !branch.key.startsWith(SLUG_PREFIX)) {
    node.detail = branch.key;
  }
  if (branch.kids && depth < env.dims.length) {
    const limit = depth === 0 ? ROOT_KEEP : keep;
    node.children = trim(branch, [...branch.kids.values()], limit).map((kid) => toNode(kid, depth + 1, keep, env, count));
  }
  return node;
}

/** Builds the tree with the roomiest `keep` that still fits MAX_NODES. */
function buildTree(root: Branch, env: NodeEnv, step = 0): StatNode {
  const count = { nodes: 0 };
  const tree = toNode(root, 0, KEEP_STEPS[step], env, count);
  return count.nodes <= MAX_NODES || step === KEEP_STEPS.length - 1 ? tree : buildTree(root, env, step + 1);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** One day of the timeline, per first-ring key: [cost, tokens]. */
type DayCells = Map<number, Map<string, [number, number]>>;

function addDayCell(days: DayCells, day: number, key: string, cost: number, tokens: number): void {
  let cells = days.get(day);
  if (!cells) {
    cells = new Map();
    days.set(day, cells);
  }
  const cell = cells.get(key);
  if (cell) {
    cell[0] += cost;
    cell[1] += tokens;
  } else {
    cells.set(key, [cost, tokens]);
  }
}

interface Findings {
  dim: Dim;
  tree: StatNode;
  totals: PeriodTotals;
  save: number;
  subagent: { cost: number; tokens: number };
  background: { cost: number; tokens: number };
  days: DayCells;
  periodDays: number;
  unpricedModels: string[];
}

/** The few plain findings, most worth reading first. Every one is skipped when its numbers would say nothing. */
function insightsFor(f: Findings): Insight[] {
  const out: Insight[] = [];
  const { totals } = f;
  const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);
  if (f.subagent.tokens > 0 && totals.tokens > 0) {
    out.push({ id: "subagentShare", values: { tokenShare: share(f.subagent.tokens, totals.tokens), costShare: share(f.subagent.cost, totals.cost) } });
  }
  if (f.save >= CACHE_SAVED_MIN) out.push({ id: "cacheSaved", values: { amount: f.save } });
  const top = f.tree.children?.[0];
  if (top && !top.other && (f.tree.children?.length ?? 0) > 1) {
    const costShare = share(top.cost, totals.cost);
    const tokenShare = share(top.tokens, totals.tokens);
    if (costShare >= TOP_SPENDER_MIN_SHARE || tokenShare >= TOP_SPENDER_MIN_SHARE) {
      out.push({ id: "topSpender", values: { dim: f.dim, key: top.key, label: top.label, costShare, tokenShare } });
    }
  }
  if (f.background.tokens > 0 && totals.tokens > 0) {
    out.push({ id: "backgroundShare", values: { cost: f.background.cost, tokens: f.background.tokens, costShare: share(f.background.cost, totals.cost), tokenShare: share(f.background.tokens, totals.tokens) } });
  }
  if (f.periodDays > 1) {
    let best: { day: number; cost: number; tokens: number } | null = null;
    for (const [day, cells] of f.days) {
      let cost = 0;
      let tokens = 0;
      for (const [dayCost, dayTokens] of cells.values()) {
        cost += dayCost;
        tokens += dayTokens;
      }
      if (!best || cost > best.cost || (cost === best.cost && tokens > best.tokens)) best = { day, cost, tokens };
    }
    if (best && (best.cost > 0 || best.tokens > 0)) out.push({ id: "priciestDay", values: { day: intToDay(best.day), cost: best.cost, tokens: best.tokens } });
  }
  if (totals.unpricedTokens > 0) out.push({ id: "unpriced", values: { tokens: totals.unpricedTokens, models: f.unpricedModels.length } });
  return out;
}

/**
 * Everything the page needs for one period: totals and the period before, the
 * ring tree for the chosen order, the timeline coloured like the first ring,
 * and the findings. Rows of chats the viewer may not see are never read.
 */
export function buildStatistics(args: StatisticsArgs): StatisticsResponse {
  const { store, period, groupBy, labels, status } = args;
  const dims = GROUP_BY_DIMS[groupBy];
  const previous = previousPeriod(period);
  const from = dayToInt(period.from);
  const to = dayToInt(period.to);
  const prevFrom = dayToInt(previous.from);
  const prevTo = dayToInt(previous.to);
  const contexts = fileContexts(store, args.visible, labels);

  const root = newBranch("root", "", "", "");
  const prior = emptyTally();
  const chats = new Set<string>();
  const priorChats = new Set<string>();
  const projectKeys = new Set<string>();
  const days: DayCells = new Map();
  const subagent = { cost: 0, tokens: 0 };
  const background = { cost: 0, tokens: 0 };
  const unpricedByModel = new Map<string, number>();
  let dataFrom = Number.POSITIVE_INFINITY;
  let dataTo = Number.NEGATIVE_INFINITY;

  for (const [fileId, rows] of store.rows) {
    const ctx = contexts.get(fileId);
    if (!ctx?.visible) continue;
    for (const row of rows.values()) {
      const tokens = row.input + row.output + row.cacheRead + row.cacheWrite;
      if (tokens === 0 && row.cost <= 0) continue;
      if (row.day < dataFrom) dataFrom = row.day;
      if (row.day > dataTo) dataTo = row.day;
      const inPeriod = row.day >= from && row.day <= to;
      if (!inPeriod && !(row.day >= prevFrom && row.day <= prevTo)) continue;
      const payg = store.billingOf(row.provider) === "payg";
      if (!inPeriod) {
        addRow(prior, row, payg);
        if (ctx.chat !== "") priorChats.add(ctx.chat);
        continue;
      }
      addRow(root, row, payg);
      if (ctx.chat !== "") chats.add(ctx.chat);
      projectKeys.add(ctx.project);
      let node = root;
      for (const dim of dims) {
        const key = dimKey(dim, row, ctx);
        const kids = (node.kids ??= new Map());
        let kid = kids.get(key);
        if (!kid) {
          kid = newBranch(dim, key, row.provider, row.model);
          kids.set(key, kid);
        }
        addRow(kid, row, payg);
        node = kid;
      }
      addDayCell(days, row.day, dimKey(dims[0], row, ctx), row.cost, tokens);
      const kind = parseWorker(row.worker).kind;
      if (kind === "subagent") {
        subagent.cost += row.cost;
        subagent.tokens += tokens;
      } else if (kind === "background" || kind === "engine") {
        background.cost += row.cost;
        background.tokens += tokens;
      }
      if (row.unpriced > 0) unpricedByModel.set(row.model, (unpricedByModel.get(row.model) ?? 0) + row.unpriced);
    }
  }

  const tree = buildTree(root, { store, labels, projectNames: projectLabels(projectKeys), dims });
  const series: TimelineSeries[] = (tree.children ?? []).map((child) => ({ key: child.key, label: child.label, ...(child.other ? { other: true } : {}) }));
  const seriesAt = new Map(series.map((entry, index) => [entry.key, index]));
  const otherAt = series.findIndex((entry) => entry.other);
  const timeline = eachDay(period.from, period.to).map((day) => {
    const cells = series.map(() => ({ cost: 0, tokens: 0 }));
    const perKey = days.get(dayToInt(day));
    if (perKey) {
      for (const [key, [cost, tokens]] of perKey) {
        const at = seriesAt.get(key) ?? otherAt;
        if (at < 0) continue;
        cells[at].cost += cost;
        cells[at].tokens += tokens;
      }
    }
    return { day, cells };
  });

  const totals = totalsOf(root, chats.size);
  const unpricedModels = [...unpricedByModel].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, UNPRICED_MODELS_SHOWN).map(([model]) => model);
  return {
    zone: store.zone,
    generatedAt: args.now,
    updating: status.updating,
    indexedAt: status.indexedAt,
    progress: status.progress,
    indexError: status.error,
    dataFrom: Number.isFinite(dataFrom) ? intToDay(dataFrom) : null,
    dataTo: Number.isFinite(dataTo) ? intToDay(dataTo) : null,
    period,
    previous,
    totals,
    previousTotals: totalsOf(prior, priorChats.size),
    groupBy,
    dims: [...dims],
    tree,
    series,
    timeline,
    insights: insightsFor({ dim: dims[0], tree, totals, save: root.save, subagent, background, days, periodDays: period.days, unpricedModels }),
    unpricedModels,
  };
}

// ---------------------------------------------------------------------------
// Deep dive: one chat
// ---------------------------------------------------------------------------

function turnScore(turn: TopTurn): number {
  return turn.cost > 0 ? turn.cost : totalTokens(turn) / 1e9;
}

/**
 * One chat in detail: what it cost over its whole retained life and inside the
 * period, its most expensive turns, what each kind of work did, and every
 * subagent that ran for it. Null when the index has no transcript for the chat.
 * The caller has already checked the viewer may see the chat.
 */
export function buildDeepDive(args: DeepDiveArgs): DeepDiveResponse | null {
  const { store, chat, period, labels } = args;
  const files: FileEntry[] = [];
  for (const file of store.files.values()) if (file.chat === chat) files.push(file);
  if (files.length === 0) return null;
  const from = period ? dayToInt(period.from) : 0;
  const to = period ? dayToInt(period.to) : 0;

  const lifetime = emptyTally();
  const inPeriod = emptyTally();
  const workers = new Map<string, Tally>();
  const subagents: DeepDiveSubagent[] = [];
  const turns: TopTurn[] = [];
  for (const file of files) {
    const own = emptyTally();
    const models = new Set<string>();
    for (const row of store.rows.get(file.id)?.values() ?? []) {
      const payg = store.billingOf(row.provider) === "payg";
      addRow(own, row, payg);
      addRow(lifetime, row, payg);
      if (period && row.day >= from && row.day <= to) addRow(inPeriod, row, payg);
      let worker = workers.get(row.worker);
      if (!worker) {
        worker = emptyTally();
        workers.set(row.worker, worker);
      }
      addRow(worker, row, payg);
      models.add(row.model);
    }
    turns.push(...file.top);
    if (file.kind === "subagent" || file.kind === "advisor") {
      subagents.push({
        name: file.name || file.kind,
        agent: file.agent,
        kind: file.kind,
        tokens: totalTokens(own),
        cost: own.cost,
        unpricedTokens: own.unpriced,
        messages: own.n,
        first: file.first,
        last: file.last,
        models: [...models].sort(),
      });
    }
  }
  const home = files.find((file) => file.kind === "main") ?? files.find((file) => file.kind === "sidebar") ?? files[0];
  const projectKey = ownProject(home, labels.projectOf);
  const topTurns: DeepDiveTurn[] = turns
    .sort((a, b) => turnScore(b) - turnScore(a) || b.ts - a.ts)
    .slice(0, TOP_TURNS_SHOWN)
    .map((turn) => ({ ts: turn.ts, provider: turn.provider, model: turn.model, worker: turn.worker, input: turn.input, output: turn.output, cacheRead: turn.cacheRead, cacheWrite: turn.cacheWrite, cost: turn.cost }));
  const workerRows: DeepDiveWorker[] = [...workers]
    .map(([worker, tally]) => ({ worker, tokens: totalTokens(tally), cost: tally.cost, unpricedTokens: tally.unpriced, messages: tally.n }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || (a.worker < b.worker ? -1 : 1));
  subagents.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.first - b.first);
  return {
    chat,
    openable: files.some((file) => file.kind === "main" && !file.gone),
    title: labels.titles.get(chat) ?? "",
    cwd: home.cwd,
    project: projectKey === "" ? "" : (projectLabels([projectKey]).get(projectKey) ?? ""),
    lifetime: totalsOf(lifetime, 1),
    inPeriod: period ? totalsOf(inPeriod, 1) : null,
    topTurns,
    workers: workerRows,
    subagents: subagents.slice(0, SUBAGENTS_SHOWN),
    updating: args.status.updating,
  };
}
