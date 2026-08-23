/**
 * Approval prompts, browser side.
 *
 * An ACP engine can stop mid-turn and ask a human whether it may do the thing
 * it is about to do (`lib/harness/acp-session.ts`). The turn genuinely blocks
 * until the answer comes back, so what the browser renders is not a
 * notification — it is the only way that turn ever finishes.
 *
 * Everything here is pure so it can be unit-tested without a DOM: the wire
 * shapes arrive from an ARBITRARY agent over the network, and a card that
 * throws on an unexpected field would take the whole transcript with it.
 *
 * The one rule that outranks tidiness: **render the agent's own options, in
 * the order it sent them.** Cody never invents Allow/Deny buttons, never
 * reorders, never collapses two options into one. Only the agent knows which
 * grants it is offering — Hermes, for instance, sends five, two of which share
 * `kind: "allow_always"` ("Allow for session" and "Allow always") and differ
 * only by `optionId`/`name`. `optionId` is the identity, `name` is the label,
 * and `kind` is nothing but a styling hint.
 */

/** The four grant shapes ACP defines. Only a styling hint — NOT an identity:
 * two options may legitimately arrive with the same kind. */
export type AgentPermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

const PERMISSION_KINDS = new Set<string>([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);

/** One choice the AGENT offered. Mirrors `AcpPermissionOption` in
 * lib/harness/acp-session.ts, restated here because that module drags in
 * child_process and can never reach the browser bundle. */
export interface AgentPermissionOption {
  optionId: string;
  name: string;
  kind: AgentPermissionKind;
}

/** One approval waiting on a human. `toolCall` is an ACP ToolCallUpdate in
 * practice, but it is whatever the agent sent, so it stays `unknown` and is
 * read through `describeToolCall`. */
export interface AgentPermissionRequest {
  requestId: string;
  toolCall: unknown;
  options: AgentPermissionOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Options Cody can actually render. An entry missing a field is dropped
 * rather than shown as a button whose meaning nobody knows — the server drops
 * the same shapes, and this is the second half of that contract for anything
 * that reaches the browser by another route (a `get_state` hydration). */
export function readPermissionOptions(raw: unknown): AgentPermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { optionId, name, kind } = entry;
    if (typeof optionId !== "string" || !optionId) return [];
    if (typeof name !== "string" || !name) return [];
    if (typeof kind !== "string" || !PERMISSION_KINDS.has(kind)) return [];
    // Two options may share a KIND; two may never share an id, because the id
    // is what the answer is sent back as. A duplicate id would make one of the
    // buttons answer for the other.
    if (seen.has(optionId)) return [];
    seen.add(optionId);
    return [{ optionId, name, kind: kind as AgentPermissionKind }];
  });
}

/** One request off the wire — an SSE frame or a `get_state` entry, which
 * carry the same three fields. Null when there is nothing answerable: no id,
 * or no option the user could click. */
export function readPermissionRequest(raw: unknown): AgentPermissionRequest | null {
  if (!isRecord(raw)) return null;
  const requestId = typeof raw.requestId === "string" ? raw.requestId : "";
  if (!requestId) return null;
  const options = readPermissionOptions(raw.options);
  if (options.length === 0) return null;
  return { requestId, toolCall: raw.toolCall ?? null, options };
}

/** `get_state.pendingPermissions`, which is how a reloaded tab finds the
 * approval it never saw the event for. */
export function readPermissionRequests(raw: unknown): AgentPermissionRequest[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((entry) => {
    const request = readPermissionRequest(entry);
    if (!request || seen.has(request.requestId)) return [];
    seen.add(request.requestId);
    return [request];
  });
}

/** ACP's ToolKind vocabulary. Anything outside it is rendered verbatim rather
 * than translated, so an agent with its own vocabulary still reads sensibly. */
const TOOL_KINDS = new Set<string>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

/** How long a tool title may be before the card truncates it. Hermes builds
 * an execute title as `"<description>: <command>"`, and a command can be a
 * whole shell pipeline — long enough to push the buttons off screen. */
const TITLE_LIMIT = 400;

export interface ToolCallSummary {
  /** What the agent says it wants to do, or null when it said nothing. */
  title: string | null;
  /** An ACP ToolKind, when the agent sent a recognised one. */
  kind: string | null;
  /** True when `kind` is one of ACP's own, i.e. safe to translate. */
  kindKnown: boolean;
}

/**
 * Read the two useful fields off a ToolCallUpdate. Both are optional in the
 * protocol and both differ between the payloads one agent builds for a shell
 * command and for a file edit, so neither may be assumed present.
 */
export function describeToolCall(toolCall: unknown): ToolCallSummary {
  if (!isRecord(toolCall)) return { title: null, kind: null, kindKnown: false };
  const rawTitle = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  const title = rawTitle
    ? (rawTitle.length > TITLE_LIMIT ? `${rawTitle.slice(0, TITLE_LIMIT)}…` : rawTitle)
    : null;
  const rawKind = typeof toolCall.kind === "string" ? toolCall.kind.trim() : "";
  return {
    title,
    kind: rawKind || null,
    kindKnown: TOOL_KINDS.has(rawKind),
  };
}

/** Whether choosing this option grants (or refuses) something beyond the one
 * call in front of the user. A durable decision must never look like the
 * ordinary one. */
export function isDurableChoice(kind: AgentPermissionKind): boolean {
  return kind === "allow_always" || kind === "reject_always";
}

/** Whether this option lets the agent proceed. Drives which button reads as
 * primary; refusal is always the safe, secondary choice. */
export function isAllowChoice(kind: AgentPermissionKind): boolean {
  return kind === "allow_once" || kind === "allow_always";
}
