/**
 * Shared vocabulary of the Statistics feature: the rows the indexer keeps, the
 * shapes `/api/statistics` answers with, and the page reads. Types only (plus
 * a few string constants), so the browser can import this file without pulling
 * any server code along.
 */

/** How a provider is paid for. It decides the honesty label, never the maths. */
export type BillingKind =
  /** A plan or OAuth login (Claude plans, ChatGPT plan, Copilot, ...): the
   * figure is what the usage WOULD cost on the API, never money charged. */
  | "subscription"
  /** Pay-as-you-go (Claude API credits, API-key vendors, gateways): real money. */
  | "payg"
  /** Runs on the user's own machine: no per-token price exists. */
  | "local"
  /** Cody cannot say how this provider bills. */
  | "unknown";

/**
 * The dimensions a ring of the sunburst can show. `worker` is "what did the
 * work": the main chat, a subagent type, a Cody background job, compaction.
 */
export type Dim = "provider" | "model" | "project" | "chat" | "worker";

/** The ring orders offered by the "Group by" switch. The first dimension is the
 * inner ring and the colour family of everything outside it. */
export type GroupBy = "provider" | "project" | "model" | "worker";

export const GROUP_BY_DIMS: Record<GroupBy, readonly Dim[]> = {
  provider: ["provider", "model", "project", "chat", "worker"],
  project: ["project", "model", "chat", "worker"],
  model: ["model", "project", "chat", "worker"],
  worker: ["worker", "model", "project", "chat"],
};

export const GROUP_BY_ORDER: readonly GroupBy[] = ["provider", "project", "model", "worker"];

export function isGroupBy(value: unknown): value is GroupBy {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GROUP_BY_DIMS, value);
}

/** The key of the node that stands for everything the server trimmed from a parent. */
export const OTHER_KEY = "~other";
/** A project whose directory is unknown is keyed by its transcript folder: `slug:<folder>`. */
export const SLUG_PREFIX = "slug:";

/** Worker ids. Prefixed ids carry a free-form tail (an agent type, a purpose). */
export const WORKER_MAIN = "main";
export const WORKER_SIDEBAR = "sidebar";
export const WORKER_ADVISOR = "advisor";
export const WORKER_COMPACTION = "compaction";
export const WORKER_SUBAGENT_PREFIX = "subagent:";
/** A subagent transcript whose type is unknown (a fork, or `session_init` missing). */
export const WORKER_SUBAGENT = "subagent";
export const WORKER_ENGINE_PREFIX = "engine:";
export const WORKER_BACKGROUND_PREFIX = "background:";
/** A Cody background job that did not say which kind it is. */
export const WORKER_BACKGROUND = "background";

/** Where a transcript file sits, which is what decides its worker. */
export type SourceKind = "main" | "sidebar" | "subagent" | "advisor" | "oneshot";

/** The five usage counters plus what they cost. */
export interface Counters {
  /** Assistant messages (or helper calls) that reported usage. */
  n: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** List-price spend of the PRICED contributions only. */
  cost: number;
  /** Tokens of contributions with no known price. Never folded into `cost`. */
  unpriced: number;
  /** Estimated net saving from prompt caching, dollars. */
  save: number;
}

export function emptyCounters(): Counters {
  return { n: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0, save: 0 };
}

export function addCounters(into: Counters, from: Counters): void {
  into.n += from.n;
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.cost += from.cost;
  into.unpriced += from.unpriced;
  into.save += from.save;
}

export function totalTokens(c: Pick<Counters, "input" | "output" | "cacheRead" | "cacheWrite">): number {
  return c.input + c.output + c.cacheRead + c.cacheWrite;
}

/** One aggregated row: a day of one provider/model/worker inside one source file. */
export interface StatRow extends Counters {
  /** Day as yyyymmdd in the index zone (20261112). */
  day: number;
  file: number;
  provider: string;
  model: string;
  worker: string;
}

/** One expensive assistant message kept for the deep dive. */
export interface TopTurn {
  ts: number;
  /** Transcript entry id. */
  id: string;
  provider: string;
  model: string;
  worker: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 0 when the turn had no known price. */
  cost: number;
}

/** What the indexer remembers about one transcript file. */
export interface FileEntry {
  id: number;
  path: string;
  kind: SourceKind;
  /** Chat (session) id the usage belongs to; '' for jobs outside any chat. */
  chat: string;
  /** Working directory from the transcript header. */
  cwd: string;
  /** Subagent type from `session_init`, or ''. */
  agent: string;
  /** Project directory the transcript sits under (omp's cwd slug), which is how a sidebar chat finds its project. */
  slug: string;
  /** Subagent task id (the file's stem), or ''. */
  name: string;
  size: number;
  mtimeMs: number;
  /** Inode: a replaced file (rotated, rewritten through a temp file) is a new file even when it is larger. 0 where the platform has none. */
  ino: number;
  /** Bytes already folded in: the end of the last complete line read. */
  offset: number;
  /** Header timestamp (ms): the cut-off below which a fork's copied history is skipped. */
  headerTs: number;
  /** The transcript is a fork of another chat, so its early entries are copies. */
  forked: boolean;
  /** Last assistant model seen per provider, to attribute a compaction. */
  lastModel: Record<string, string>;
  first: number;
  last: number;
  top: TopTurn[];
  /** The file no longer exists; its rows stay (the money was spent). */
  gone: boolean;
}

/** USD per token, learnt from priced messages. 0 = not learnt yet. */
export interface RateEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

/** How far a running indexing pass is. */
export interface IndexProgress {
  done: number;
  total: number;
}

export type RangePreset = "today" | "7d" | "30d" | "90d";

export interface PeriodInfo {
  /** First day, YYYY-MM-DD. */
  from: string;
  /** Last day, YYYY-MM-DD, inclusive. */
  to: string;
  days: number;
  preset: RangePreset | null;
}

/** The headline numbers of a period. */
export interface PeriodTotals {
  /** Priced spend, subscription estimate + real money. */
  cost: number;
  /** The part of `cost` that is real pay-as-you-go money. */
  paygCost: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Tokens that ran on models with no known price. */
  unpricedTokens: number;
  chats: number;
  messages: number;
  /** cacheRead / (input + cacheRead + cacheWrite), or null with no prompt tokens. */
  cacheHitRate: number | null;
}

/** A node of the ring tree. The server sends cost AND tokens for every node,
 * so flipping the Cost/Tokens switch never needs another request. */
export interface StatNode {
  /** Identity inside the parent (provider id, model id, project path, chat id, worker id). */
  key: string;
  dim: Dim | "root";
  label: string;
  cost: number;
  paygCost: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  unpricedTokens: number;
  messages: number;
  /** Set on the bucket that stands for everything the server trimmed. */
  other?: boolean;
  /** Chat nodes: the chat id the deep dive and the open-chat link use. */
  chat?: string;
  /** Provider nodes: how the provider is paid for. */
  billing?: BillingKind;
  /** Provider and model nodes: the provider id, for the brand mark and the billing label. */
  provider?: string;
  /** Longer text for a tooltip: a project's full path. */
  detail?: string;
  children?: StatNode[];
}

export interface TimelineCell {
  cost: number;
  tokens: number;
}

export interface TimelineDay {
  /** YYYY-MM-DD. */
  day: string;
  /** Cells parallel to `series`. */
  cells: TimelineCell[];
}

export interface TimelineSeries {
  key: string;
  label: string;
  other?: boolean;
}

export interface InsightValue {
  [name: string]: string | number;
}

/** A plain-language finding. The page owns the sentence; the server only
 * supplies the numbers, so every locale phrases it natively. */
export interface Insight {
  id:
    | "subagentShare"
    | "cacheSaved"
    | "topSpender"
    | "priciestDay"
    | "backgroundShare"
    | "unpriced";
  values: InsightValue;
}

export interface StatisticsResponse {
  /** The zone days are bucketed in. */
  zone: string;
  generatedAt: number;
  /** An indexing pass is running or the data is older than the refresh window. */
  updating: boolean;
  /** When the last full pass finished (ms), or null before the first one. */
  indexedAt: number | null;
  /** How far the running pass is, or null when none is. */
  progress: IndexProgress | null;
  /** Why the last pass or save failed, or null. */
  indexError: string | null;
  /** First/last day with any data, for the custom-date inputs. */
  dataFrom: string | null;
  dataTo: string | null;
  period: PeriodInfo;
  previous: PeriodInfo;
  totals: PeriodTotals;
  previousTotals: PeriodTotals;
  groupBy: GroupBy;
  dims: Dim[];
  tree: StatNode;
  series: TimelineSeries[];
  timeline: TimelineDay[];
  insights: Insight[];
  /** Models that reported tokens with no known price. */
  unpricedModels: string[];
}

export interface DeepDiveTurn {
  ts: number;
  provider: string;
  model: string;
  worker: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface DeepDiveSubagent {
  /** Task id (file stem). */
  name: string;
  /** Agent type, or '' when the transcript never said. */
  agent: string;
  kind: SourceKind;
  tokens: number;
  cost: number;
  unpricedTokens: number;
  messages: number;
  first: number;
  last: number;
  models: string[];
}

/** What one kind of work (the main chat, a subagent type, compaction, ...) did inside a chat. */
export interface DeepDiveWorker {
  worker: string;
  tokens: number;
  cost: number;
  unpricedTokens: number;
  messages: number;
}

export interface DeepDiveResponse {
  chat: string;
  /** The chat can be opened in the app (a side chat cannot). */
  openable: boolean;
  title: string;
  cwd: string;
  project: string;
  /** Whole-life totals of the chat, subagents included. */
  lifetime: PeriodTotals;
  /** The same chat restricted to the requested period, when one was asked for. */
  inPeriod: PeriodTotals | null;
  topTurns: DeepDiveTurn[];
  /** What each kind of work did inside the chat, biggest first. */
  workers: DeepDiveWorker[];
  subagents: DeepDiveSubagent[];
  updating: boolean;
}
