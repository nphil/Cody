// Which helpers run on an expensive tier, the reason the parent gave for
// choosing it, and what each helper kind has cost this run. Pure parsing of
// what Cody already holds (live frames carry `assignment`/`task`, progress
// carries the role and the cost); no model call, no network.

import { formatCost } from "./subagent-format";

/** Agent kinds that are expensive by definition (their descriptions tell the parent to say why). */
const EXPENSIVE_AGENTS: Readonly<Record<string, true>> = { "heavy-task": true, "deep-task": true };

/** Model roles that are the main / strongest model, as against the `task` and `smol` helper roles. */
const EXPENSIVE_ROLES: Readonly<Record<string, true>> = { default: true, slow: true };

/** `pi/slow`, `@slow`, ` Slow ` → `slow`. */
function roleName(value: string): string {
  return value.trim().toLowerCase().replace(/^(?:pi\/|@)/, "");
}

export interface TierInput {
  agent?: string;
  progress?: { modelRole?: string; modelOverride?: string | string[] };
}

/** True for heavy-task / deep-task, and for any agent whose model resolves to the default or slow role. */
export function isExpensiveHelper(input: TierInput): boolean {
  if (input.agent && EXPENSIVE_AGENTS[input.agent.trim().toLowerCase()] === true) return true;
  const role = input.progress?.modelRole;
  if (role && EXPENSIVE_ROLES[roleName(role)] === true) return true;
  const override = input.progress?.modelOverride;
  const overrides = Array.isArray(override) ? override : override ? [override] : [];
  return overrides.some((entry) => typeof entry === "string" && EXPENSIVE_ROLES[roleName(entry)] === true);
}

const MAX_REASON = 200;

function clipReason(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_REASON ? `${flat.slice(0, MAX_REASON - 1)}…` : flat;
}

// A label the parent writes before the reason: "Why heavy-task:", "Why this
// tier —", "Tier reason:", "Reason for using deep-task:", "Escalation:". A bare
// "Reason:" or "Why:" is NOT taken: a task's own text uses those for its work.
const AGENT_WORD = "(?:heavy-task|deep-task|tier|agent|model|helper)";
const LABEL = new RegExp(
  "^(?:"
  + `why(?:\\s+(?:this|the|using|use|choosing|choose|not))?\\s+(?:expensive\\s+)?${AGENT_WORD}(?:\\s+(?:tier|agent|model))?`
  + `|(?:tier|agent|model|escalation|helper)\\s+(?:reason|justification|choice)`
  + `|reason\\s+for\\s+(?:using\\s+)?(?:the\\s+|this\\s+)?(?:expensive\\s+)?${AGENT_WORD}`
  + "|escalation|justification"
  + ")$",
  "i",
);

/** Markdown noise off a line: heading/quote/list marks, bold and code marks. */
function plainLine(line: string): { text: string; heading: boolean } {
  const heading = /^\s*#{1,6}\s/.test(line);
  const text = line
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/(\*\*|__|`)/g, "")
    .trim();
  return { text, heading };
}

const SEPARATOR = /^(.{1,60}?)\s*(?::|：|\s[—–-]\s)\s*(.*)$/;

function fromLabelledLine(lines: readonly string[]): string | null {
  for (let i = 0; i < lines.length; i += 1) {
    const { text, heading } = plainLine(lines[i]);
    if (!text) continue;
    const split = SEPARATOR.exec(text);
    const label = split ? split[1].trim() : text.replace(/[:：]$/, "").trim();
    if (!LABEL.test(label)) continue;
    const inline = split ? split[2].trim() : "";
    if (inline) return clipReason(inline);
    if (!heading && split === null) continue;
    // The reason sits in the paragraph under the label.
    const paragraph: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = plainLine(lines[j]);
      if (!next.text) {
        if (paragraph.length > 0) break;
        continue;
      }
      if (next.heading) break;
      paragraph.push(next.text);
    }
    if (paragraph.length > 0) return clipReason(paragraph.join(" "));
  }
  return null;
}

const BECAUSE = /\b(?:heavy-task|deep-task|this tier|this agent|expensive tier|the slow role|the default role)\b[^\n]{0,60}?\b(?:because|since)\b\s+(.+)/i;

function fromBecauseSentence(text: string): string | null {
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const match = BECAUSE.exec(sentence);
    if (match) return clipReason(match[1]);
  }
  return null;
}

/** The reason the parent gave for the tier in an assignment's text, or null when it gave none. */
export function parseTierReason(text: string | undefined): string | null {
  if (!text || !text.trim()) return null;
  return fromLabelledLine(text.split(/\r?\n/)) ?? fromBecauseSentence(text);
}

export type TierNote =
  | { kind: "given"; reason: string }
  | { kind: "missing" };

export interface TierNoteInput extends TierInput {
  assignment?: string;
  task?: string;
}

/**
 * What a helper's chip and window say about its tier: null for a cheap helper
 * (and while no assignment text has arrived yet, so a chip never claims "no
 * reason" before the frame that carries the text), the parent's reason, or
 * "missing" when the assignment is known and states none.
 */
export function helperTierNote(input: TierNoteInput): TierNote | null {
  if (!isExpensiveHelper(input)) return null;
  const texts = [input.assignment, input.task].filter((text): text is string => typeof text === "string" && text.trim() !== "");
  if (texts.length === 0) return null;
  for (const text of texts) {
    const reason = parseTierReason(text);
    if (reason) return { kind: "given", reason };
  }
  return { kind: "missing" };
}

export interface TierTotal {
  agent: string;
  cost: number;
  expensive: boolean;
}

/** What each helper kind has cost in the roster, dearest first; kinds with no cost yet are left out. */
export function tierCostTotals(subagents: readonly (TierInput & { progress?: TierInput["progress"] & { cost?: number } })[]): TierTotal[] {
  const byAgent = new Map<string, TierTotal>();
  for (const subagent of subagents) {
    const cost = subagent.progress?.cost;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) continue;
    const agent = subagent.agent?.trim() || "subagent";
    const entry = byAgent.get(agent) ?? { agent, cost: 0, expensive: false };
    entry.cost += cost;
    if (isExpensiveHelper(subagent)) entry.expensive = true;
    byAgent.set(agent, entry);
  }
  return [...byAgent.values()].sort((a, b) => b.cost - a.cost || a.agent.localeCompare(b.agent));
}

/** "task $1.20 · heavy-task $8.40" (in the order given). */
export function formatTierTotals(totals: readonly TierTotal[]): string {
  return totals.map((total) => `${total.agent} ${formatCost(total.cost) ?? ""}`.trim()).join(" · ");
}
