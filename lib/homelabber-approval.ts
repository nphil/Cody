/**
 * HomeLabber approvals, read out of the chat transcript.
 *
 * HomeLabber (Nitin's homelab admin server, an MCP server named `homelabber`)
 * gates some of its tools behind a Face ID approval on his phone. A gated call
 * does not act: it comes straight back with a PENDING request, HomeLabber asks
 * Nitin, and after he approves it runs the stored action itself. The agent
 * follows the request with `approval_wait` until it settles. To the engine all
 * of that is ordinary tool calls — and the pending answer is flagged as an
 * error (`ok:false` becomes `isError`), so unaided it reads as a red "Error:".
 * This module turns those calls and results into one state per request id, so
 * the chat can show what is really happening.
 *
 * Pure and dependency-free on purpose: the UI (`components/HomelabberApproval`),
 * the link-base route and the tests all read the same answers.
 *
 * Shapes it reads (HomeLabber's MCP route, `toolResponse`):
 *   content: [text(message), text(JSON of data)]  +  structuredContent: {ok, message, data}
 *   pending  data = {approval: {id, status: "pending", expiresAt}}
 *   wait     data = {id, status, expiresAt?, items: [{seq, tool, status, message, changeId}]}
 * How the engine hands that to the transcript differs, and every route is
 * handled because none is guaranteed:
 *   - omp joins the two text blocks, prefixes "Error: " when isError, and adds
 *     the whole structuredContent as a fenced ```json block;
 *   - omp's session reader keeps no `details`, so the TEXT alone must be enough;
 *   - a live frame may still carry `details.structuredContent` (also nested
 *     under `details.xdev.inner` for a `write xd://…` device call);
 *   - a plain-text result still names the request in prose.
 *
 * A result that is not recognisably one of these is `null`, and the caller
 * keeps drawing the ordinary tool card. Nothing in here ever grants anything:
 * a card only describes; Nitin approves on his phone.
 */
import type { AgentMessage, AssistantMessage, ToolCallContent, ToolResultMessage } from "./types";
import { asNumber, isRecord } from "./type-guards";

/** Where HomeLabber's web UI lives when Cody cannot learn it from its own MCP
 *  config (see `homelabberBaseFromMcpUrl`). */
export const HOMELABBER_DEFAULT_BASE = "https://homelabber.nateshome.net";

export type ApprovalStatus =
  | "pending" | "approved" | "executing" | "executed"
  | "failed" | "denied" | "expired" | "cancelled";
export type ApprovalItemStatus = "pending" | "executed" | "failed" | "skipped";

/** How one action of a request ended. HomeLabber also sends the tool's own
 *  result data (`items[].data`, e.g. a freshly issued certificate) — that is
 *  deliberately NOT carried here: a card must never be able to print a secret. */
export interface ApprovalItemOutcome {
  seq: number;
  tool: string | null;
  status: ApprovalItemStatus;
  message: string | null;
  changeId: string | null;
}

/** What one tool call + answer says about one request. */
export interface ApprovalObservation {
  id: string;
  /** `request`: the gated call (or a plan) came back pending. `wait`: an
   *  `approval_wait` answer. */
  source: "request" | "wait";
  /** The HomeLabber tool the call went to: `firewall_open`, `approval_wait`, … */
  tool: string;
  status: ApprovalStatus;
  /** Epoch ms, when the server said it. */
  expiresAt: number | null;
  /** "HH:MM" as the server worded it, kept only when no epoch came with it. */
  expiresClock: string | null;
  items: ApprovalItemOutcome[];
  /** HomeLabber's own sentence for a settled wait; never the pending prose. */
  message: string | null;
  /** Steps in an `approval_request_plan` call. */
  steps: number | null;
}

/** The latest known truth about one request id, folded from every call that
 *  mentioned it. */
export interface ApprovalState {
  id: string;
  status: ApprovalStatus;
  expiresAt: number | null;
  expiresClock: string | null;
  items: ApprovalItemOutcome[];
  message: string | null;
}

export type ApprovalIndex = ReadonlyMap<string, ApprovalState>;
export const EMPTY_APPROVAL_INDEX: ApprovalIndex = new Map();

/** The call half of a tool call; `ToolCallContent` fits. */
export interface ApprovalCallLike {
  toolName: string;
  input?: unknown;
}

/** The result half; `ToolResultMessage` fits. */
export interface ApprovalResultLike {
  content?: unknown;
  details?: unknown;
}

/** An approval id travels into a URL path, so its alphabet is closed. HomeLabber
 *  uses UUIDs; anything with a `/`, `.`, `?`, `#` or `%` is not an id. */
const APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export function isApprovalId(value: unknown): value is string {
  return typeof value === "string" && APPROVAL_ID.test(value);
}

const STATUS_RANK: Record<ApprovalStatus, number> = {
  pending: 0, approved: 1, executing: 2,
  executed: 3, failed: 3, denied: 3, expired: 3, cancelled: 3,
};

function statusOf(value: unknown): ApprovalStatus | null {
  if (typeof value !== "string") return null;
  const status = value.trim().toLowerCase();
  return Object.hasOwn(STATUS_RANK, status) ? (status as ApprovalStatus) : null;
}

const ITEM_STATUSES: Record<ApprovalItemStatus, true> = { pending: true, executed: true, failed: true, skipped: true };

function itemStatusOf(value: unknown): ApprovalItemStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.hasOwn(ITEM_STATUSES, status) ? (status as ApprovalItemStatus) : "pending";
}

// ── Which calls are HomeLabber's ────────────────────────────────────────────

/** omp names an MCP tool `mcp__<server>_<tool>`; Claude Code `mcp__<server>__<tool>`. */
const DIRECT_TOOL = /^mcp__homelabber_{1,2}([A-Za-z0-9][A-Za-z0-9_]*)$/;
/** omp mounts MCP tools as `xd://` devices and the model drives them with a
 *  `write` whose path names the device and whose content is the JSON arguments. */
const DEVICE_PATH = /^xd:\/\/mcp__homelabber_{1,2}([A-Za-z0-9][A-Za-z0-9_]*)\/?$/;

export interface HomelabberCall {
  /** `firewall_open`, `approval_wait`, `approval_request_plan`, … */
  tool: string;
  args: Record<string, unknown>;
}

function jsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The HomeLabber tool a call goes to, or null for any other call. Both
 *  spellings of an MCP tool are recognised: the direct tool name, and omp's
 *  `write xd://mcp__homelabber_<tool>` device call. */
export function homelabberCall(toolName: string, input: unknown): HomelabberCall | null {
  const direct = DIRECT_TOOL.exec(toolName);
  if (direct) return { tool: direct[1], args: isRecord(input) ? input : {} };
  if (toolName !== "write" || !isRecord(input) || typeof input.path !== "string") return null;
  const device = DEVICE_PATH.exec(input.path.trim());
  return device ? { tool: device[1], args: jsonObject(input.content) } : null;
}

// ── Reading a result ────────────────────────────────────────────────────────

/** A result is bounded text, but it is also arbitrary text: cap what is scanned. */
const MAX_SCAN_CHARS = 200_000;
const MAX_SCAN_ATTEMPTS = 48;
const MAX_JSON_OBJECTS = 12;
const MAX_ITEMS = 50;
const MAX_MESSAGE_CHARS = 300;

function contentTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts;
}

/** Index of the `}` closing the `{` at `start`, or -1. String-aware, so a brace
 *  inside a JSON string does not count. */
function closingBrace(text: string, start: number, limit: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < limit; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === 92) escaped = true;
      else if (ch === 34) inString = false;
      continue;
    }
    if (ch === 34) inString = true;
    else if (ch === 123) depth += 1;
    else if (ch === 125 && --depth === 0) return i;
  }
  return -1;
}

/** Every top-level JSON object found in free text: the bare data block omp
 *  appends after the message, the fenced structuredContent, a text that is
 *  nothing but JSON. Prose around them is skipped. */
function jsonObjectsIn(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const limit = Math.min(text.length, MAX_SCAN_CHARS);
  let attempts = 0;
  for (let start = text.indexOf("{"); start !== -1 && start < limit; start = text.indexOf("{", start + 1)) {
    if (attempts++ >= MAX_SCAN_ATTEMPTS || found.length >= MAX_JSON_OBJECTS) break;
    const end = closingBrace(text, start, limit);
    if (end === -1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    found.push(parsed);
    start = end;
  }
  return found;
}

/** `structuredContent` wherever the engine put it: omp's MCP bridge puts it on
 *  `details`, and a `write xd://…` device call nests that under `xdev.inner`. */
function structuredIn(details: unknown, depth = 0): Record<string, unknown>[] {
  if (!isRecord(details) || depth > 3) return [];
  const found: Record<string, unknown>[] = [];
  if (isRecord(details.structuredContent)) found.push(details.structuredContent);
  for (const key of ["xdev", "inner", "details"]) found.push(...structuredIn(details[key], depth + 1));
  return found;
}

/** Trimmed, one bounded string, or null. HomeLabber writes these; they are
 *  still capped because they are rendered. */
function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Epoch ms. Seconds (a 10-digit figure) are lifted to ms rather than read as 1970. */
function epochMs(value: unknown): number | null {
  const n = asNumber(value);
  if (n === undefined || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}

function readItems(value: unknown): ApprovalItemOutcome[] | null {
  if (!Array.isArray(value)) return null;
  const items: ApprovalItemOutcome[] = [];
  for (const raw of value) {
    if (items.length >= MAX_ITEMS) break;
    if (!isRecord(raw)) continue;
    items.push({
      seq: asNumber(raw.seq) ?? items.length,
      tool: shortText(raw.tool, 80),
      status: itemStatusOf(raw.status),
      message: shortText(raw.message, MAX_MESSAGE_CHARS),
      changeId: shortText(raw.changeId, 80),
    });
  }
  return items;
}

interface Shape {
  hasApproval: boolean;
  id?: string;
  status?: ApprovalStatus;
  expiresAt?: number;
  items?: ApprovalItemOutcome[];
  message?: string;
}

/** What one JSON object says. It may be the whole outcome `{ok, message, data}`,
 *  just its `data`, or a bare `{approval}`. */
function readShape(candidate: Record<string, unknown>): Shape {
  const data = isRecord(candidate.data) ? candidate.data : null;
  const approval = isRecord(candidate.approval) ? candidate.approval
    : data && isRecord(data.approval) ? data.approval
      : null;
  const body = data ?? candidate;
  const shape: Shape = { hasApproval: approval !== null };
  for (const source of [approval, body]) {
    if (!source) continue;
    shape.id ??= isApprovalId(source.id) ? source.id : undefined;
    shape.status ??= statusOf(source.status) ?? undefined;
    shape.expiresAt ??= epochMs(source.expiresAt) ?? undefined;
  }
  shape.items = readItems(body.items) ?? undefined;
  shape.message = shortText(candidate.message, MAX_MESSAGE_CHARS) ?? undefined;
  return shape;
}

/** "(request <id>, expires <HH:MM>)" — HomeLabber's own sentence, the last
 *  resort when an engine delivers no JSON at all. */
const PENDING_PROSE = /\(request ([A-Za-z0-9][A-Za-z0-9_-]{7,63}), expires (\d{1,2}:\d{2})\)/;

const observations = new WeakMap<object, { key: string; observation: ApprovalObservation | null }>();

/**
 * What one HomeLabber call and its answer say about an approval request, or
 * null when it says nothing (another server's tool, a HomeLabber tool that was
 * never gated, a refusal such as "approvals are paused", an answer that cannot
 * be read). Accepts the answer as text, as structured content, or both.
 */
export function parseHomelabberApproval(call: ApprovalCallLike, result?: ApprovalResultLike | null): ApprovalObservation | null {
  if (!result) return null;
  const ref = homelabberCall(call.toolName, call.input);
  if (!ref) return null;
  const key = `${ref.tool}|${typeof ref.args.id === "string" ? ref.args.id : ""}|${Array.isArray(ref.args.steps) ? ref.args.steps.length : ""}`;
  const cached = observations.get(result);
  if (cached && cached.key === key) return cached.observation;
  const observation = read(ref, result);
  observations.set(result, { key, observation });
  return observation;
}

function read(ref: HomelabberCall, result: ApprovalResultLike): ApprovalObservation | null {
  const isWait = ref.tool === "approval_wait";
  const texts = contentTexts(result.content);
  const candidates = structuredIn(result.details);
  for (const text of texts) {
    // A gated tool's text is searched only when it can mention a request: a
    // `list_containers` answer is large and has nothing to find.
    if (isWait || ref.tool === "approval_request_plan" || text.includes("approval")) {
      candidates.push(...jsonObjectsIn(text));
    }
  }
  const shape: Shape = { hasApproval: false };
  for (const candidate of candidates) {
    const next = readShape(candidate);
    shape.hasApproval ||= next.hasApproval;
    shape.id ??= next.id;
    shape.status ??= next.status;
    shape.expiresAt ??= next.expiresAt;
    shape.items ??= next.items;
    shape.message ??= next.message;
  }

  if (isWait) {
    const id = shape.id ?? (isApprovalId(ref.args.id) ? ref.args.id : undefined);
    if (!id || !shape.status) return null;
    return {
      id, source: "wait", tool: ref.tool, status: shape.status,
      expiresAt: shape.expiresAt ?? null, expiresClock: null,
      items: shape.items ?? [], message: shape.message ?? null, steps: null,
    };
  }

  let expiresClock: string | null = null;
  if (!shape.hasApproval || !shape.id) {
    for (const text of texts) {
      const prose = PENDING_PROSE.exec(text);
      if (!prose) continue;
      shape.id = prose[1];
      expiresClock = prose[2];
      shape.status = "pending";
      shape.hasApproval = true;
      break;
    }
  }
  // A gated call can only come back PENDING (a retry returns the same request);
  // any later state arrives through `approval_wait`. So an `approval` object in
  // some other status, on some other tool's answer, is data that merely looks
  // like one — a read tool listing past requests, say — and draws no card.
  if (!shape.hasApproval || !shape.id || (shape.status ?? "pending") !== "pending") return null;
  return {
    id: shape.id, source: "request", tool: ref.tool, status: "pending",
    expiresAt: shape.expiresAt ?? null, expiresClock: shape.expiresAt === undefined ? expiresClock : null,
    items: shape.items ?? [], message: null,
    steps: ref.tool === "approval_request_plan" && Array.isArray(ref.args.steps) ? ref.args.steps.length : null,
  };
}

// ── One state per request ───────────────────────────────────────────────────

/** A request only moves forward: a poll that comes back `pending` after an
 *  earlier one saw `approved` is an old answer arriving late, not a step back. */
export function foldApproval(previous: ApprovalState | undefined, observation: ApprovalObservation): ApprovalState {
  const next: ApprovalState = {
    id: observation.id,
    status: observation.status,
    expiresAt: observation.expiresAt,
    expiresClock: observation.expiresClock,
    items: observation.items,
    message: observation.message,
  };
  if (!previous) return next;
  const expiresAt = next.expiresAt ?? previous.expiresAt;
  const expiresClock = next.expiresClock ?? previous.expiresClock;
  if (STATUS_RANK[next.status] < STATUS_RANK[previous.status]) return { ...previous, expiresAt, expiresClock };
  return {
    ...next,
    expiresAt,
    expiresClock,
    items: next.items.length > 0 ? next.items : previous.items,
    message: next.message ?? previous.message,
  };
}

/** The latest state of every request id the transcript mentions, from its
 *  gated calls and every `approval_wait` after them. The shared empty index
 *  when there are none — most chats — so a consumer's context never changes. */
export function buildApprovalIndex(messages: readonly AgentMessage[], toolResults: ReadonlyMap<string, ToolResultMessage>): ApprovalIndex {
  const index = new Map<string, ApprovalState>();
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    for (const block of (message as Partial<AssistantMessage>).content ?? []) {
      if (block.type !== "toolCall") continue;
      const call = block as ToolCallContent;
      const observation = parseHomelabberApproval(call, toolResults.get(call.toolCallId));
      if (observation) index.set(observation.id, foldApproval(index.get(observation.id), observation));
    }
  }
  return index.size === 0 ? EMPTY_APPROVAL_INDEX : index;
}

/**
 * When the last request among these tool calls that is still waiting on Nitin
 * closes (epoch ms), or null when none is. Only a request whose window is
 * known counts: without an expiry there is no moment to stop holding it open.
 * The chat uses it to keep a folded turn open while an answer is owed.
 */
export function latestWaitingDeadline(
  calls: Iterable<ToolCallContent>,
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  index: ApprovalIndex,
): number | null {
  let latest: number | null = null;
  for (const call of calls) {
    const observed = parseHomelabberApproval(call, toolResults.get(call.toolCallId));
    if (observed?.source !== "request") continue;
    const state = index.get(observed.id) ?? observed;
    if (state.status !== "pending" || state.expiresAt === null) continue;
    if (latest === null || state.expiresAt > latest) latest = state.expiresAt;
  }
  return latest;
}

function sameState(a: ApprovalState, b: ApprovalState): boolean {
  if (a.status !== b.status || a.expiresAt !== b.expiresAt || a.expiresClock !== b.expiresClock || a.message !== b.message) return false;
  if (a.items.length !== b.items.length) return false;
  return a.items.every((item, i) => {
    const other = b.items[i];
    return item.seq === other.seq && item.tool === other.tool && item.status === other.status
      && item.message === other.message && item.changeId === other.changeId;
  });
}

/** `next`, except that every state equal to the one `previous` already holds
 *  keeps its old object — and the whole previous index when nothing changed — so
 *  a context that carries it re-renders its readers only on a real change. */
export function reuseApprovalIndex(previous: ApprovalIndex, next: ApprovalIndex): ApprovalIndex {
  if (previous === next) return previous;
  if (next.size === 0) return EMPTY_APPROVAL_INDEX;
  let unchanged = previous.size === next.size;
  const merged = new Map<string, ApprovalState>();
  for (const [id, state] of next) {
    const before = previous.get(id);
    if (before && sameState(before, state)) merged.set(id, before);
    else {
      merged.set(id, state);
      unchanged = false;
    }
  }
  return unchanged ? previous : merged;
}

// ── How a state reads ───────────────────────────────────────────────────────

export type ApprovalPhase = "waiting" | "approved" | "done" | "failed" | "denied" | "expired" | "cancelled" | "lapsed";
export type ApprovalTone = "warning" | "accent" | "success" | "error" | "neutral";

/** `lapsed` is Cody's own, never HomeLabber's: the request's window has closed
 *  and no later answer reached the transcript, so Cody cannot say whether it
 *  was approved, only that it is no longer waiting. */
export function approvalPhase(status: ApprovalStatus, lapsed: boolean): ApprovalPhase {
  switch (status) {
    case "pending": return lapsed ? "lapsed" : "waiting";
    case "approved":
    case "executing": return "approved";
    case "executed": return "done";
    case "failed": return "failed";
    case "denied": return "denied";
    case "expired": return "expired";
    case "cancelled": return "cancelled";
  }
}

export function approvalTone(phase: ApprovalPhase): ApprovalTone {
  switch (phase) {
    case "waiting":
    case "expired": return "warning";
    case "approved": return "accent";
    case "done": return "success";
    case "failed":
    case "denied": return "error";
    case "cancelled":
    case "lapsed": return "neutral";
  }
}

/** `4:32` — what is left of a request's five minutes. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** The longest delay a browser timer takes (a signed 32-bit millisecond count). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How long to wait before reading the clock again to learn whether `deadline`
 * (epoch ms) has passed, or null when there is nothing to wait for. `seenAt` is
 * the last time the reader looked: a reader that already saw the deadline pass
 * must not arm another timer, or each look schedules the next and a closed
 * window becomes an endless re-render (caught in a real browser, not by
 * reading). The extra 20 ms makes the look land after the deadline, not on it.
 */
export function deadlineCheckDelay(deadline: number, seenAt: number, clock: number): number | null {
  if (seenAt >= deadline) return null;
  return Math.min(Math.max(0, deadline - clock) + 20, MAX_TIMER_MS);
}

// ── Links ───────────────────────────────────────────────────────────────────

/** Opens the HomeLabber app on this device, on that request. */
export function approvalDeepLink(id: string): string {
  return `homelabber://approve/${id}`;
}

/** HomeLabber's web page for one request: which shows it in full (approving happens on the phone). */
export function approvalWebUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, "")}/approvals/${id}`;
}

/**
 * The web origin to build `approvalWebUrl` on, from the URL of the configured
 * `homelabber` MCP server — or null when that URL is no help. Only the ORIGIN
 * survives: the path and query of an MCP URL can themselves be a credential,
 * and `URL.origin` drops any user:password too. An IP address or `localhost`
 * is a machine-to-machine address, not a place a person signs in (the phone's
 * HomeLabber session lives at its hostname), so those fall back to the default.
 */
export function homelabberBaseFromMcpUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  if (host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  return parsed.origin;
}
