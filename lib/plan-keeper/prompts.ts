import { isRecord } from "../type-guards";
import type { PlanOverlay, TodoItem } from "../pi-types";
import type { PlanFoldGroup } from "./fold";

/**
 * What the plan keeper asks the cheap model for, and how it reads the answer.
 *
 * The rule this exists to enforce: report ONLY what the log proves. The
 * model sees the tasks that are still open (each with a short id, so it never
 * has to copy a task's text back exactly) and a numbered log of recent
 * activity, and every check-off it reports has to point at the log entry that
 * proves it and quote it. lib/plan-keeper/evidence.ts then checks that quote
 * against the real log before anything is applied — this prompt is the first
 * line of defense, not the only one.
 */

export const MAX_SUBTASKS = 4;
const MAX_SUBTASK_WORDS = 8;
const MAX_LABEL_WORDS = 8;
const MAX_SUMMARY_WORDS = 10;

export const PLAN_KEEPER_SYSTEM_PROMPT = [
  "You keep a coding agent's task list current. You get the tasks that are still open and a numbered log of what the agent just did. Decide which open tasks the log PROVES are finished.",
  "Answer with ONE JSON object and nothing else: no prose, no explanation, no markdown fence.",
  'Shape: {"done":[{"id":"T2","entry":14,"quote":"12 passed, 0 failed"}],"subtasks":{"T1":["..."]},"subtasksDone":["..."],"labels":{"T3":"..."},"summaries":{"G1":"..."}}. Leave out any key you have nothing for.',
  '"done": one item per open task the log proves finished. "id" is the task\'s id from the list, "entry" is the number of the ONE log entry that proves it, and "quote" copies three or more words in a row from that entry exactly (the command and what it printed both count).',
  "Proof is a result, not an intention: a command or tool that succeeded, a subagent that reported the work complete, a commit or a push, a passing test or check, or the agent saying in the log that this work is finished. Starting a task, planning it, reading about it, or a failing result is not proof.",
  "A task that asks to verify, test, publish, release or deploy something needs an entry that shows the check passing or the push happening. If a later entry shows the same thing failing again, leave the task open.",
  "When unsure, leave the task out: a missed task is caught on the next pass, a wrong check-off misleads the agent.",
  `"subtasks": up to ${MAX_SUBTASKS} short steps (${MAX_SUBTASK_WORDS} words or fewer each) under the ONE task marked in_progress, keyed by its id, and only when the log shows distinct steps of that task happening.`,
  '"subtasksDone": the exact text of subtasks — already listed, or ones you are adding in this same answer — that the log shows are done.',
  `"labels": only for the ids listed under "Needs a short label": the same task in ${MAX_LABEL_WORDS} plain words or fewer.`,
  `"summaries": only for the groups listed under "Finished groups": one plain line of ${MAX_SUMMARY_WORDS} words or fewer saying what that group of finished tasks achieved.`,
  'Never invent a task or subtask, and never report anything the log does not show. Nothing to report: {"done":[]}.',
].join(" ");

/** One line of the activity log the model reads. */
export interface PlanKeeperDigestEntry {
  /** Counts up for the whole session and is never reused: what the model
   * cites, and what "newer than" means for evidence. */
  seq: number;
  kind: "tool" | "subagent" | "message";
  at: number;
  /** The whole line as the model sees it, already clipped. */
  text: string;
  /** Tool entries: which tool, what it was asked, what came back, and whether
   * the engine itself reported the call as failed. */
  tool?: string;
  request?: string;
  result?: string;
  failed?: boolean;
}

/** A task the keeper may check off, with the id the model refers to it by. */
export interface PlanKeeperOpenTask {
  id: string;
  /** planTaskKey(phase, task.content). */
  key: string;
  phase: string;
  task: TodoItem;
}

export interface PlanKeeperPromptInput {
  open: readonly PlanKeeperOpenTask[];
  subtasks: PlanOverlay["subtasks"];
  /** Ids of open tasks whose text is long enough to want a short label. */
  labelIds: readonly string[];
  /** Folded runs of finished tasks that still need their one-line summary. */
  groups: readonly (PlanFoldGroup & { id: string })[];
  digest: readonly PlanKeeperDigestEntry[];
}

/** The system prompt and the user prompt for one plan-keeper pass. */
export function buildPlanKeeperPrompt(input: PlanKeeperPromptInput): { systemPrompt: string; prompt: string } {
  const lines: string[] = ["Open tasks:"];
  let phase: string | null = null;
  for (const item of input.open) {
    if (item.phase !== phase) {
      phase = item.phase;
      lines.push(`[Phase: ${phase}]`);
    }
    const blocker = item.task.status === "blocked" && item.task.blocker ? ` (blocked on: ${item.task.blocker})` : "";
    lines.push(`${item.id} (${item.task.status}) ${item.task.content}${blocker}`);
    for (const subtask of input.subtasks[item.task.content] ?? []) {
      lines.push(`    subtask (${subtask.status}) ${subtask.content}`);
    }
  }
  if (input.open.length === 0) lines.push("(none)");

  if (input.labelIds.length > 0) lines.push("", `Needs a short label: ${input.labelIds.join(", ")}`);

  if (input.groups.length > 0) {
    lines.push("", "Finished groups:");
    for (const group of input.groups) {
      lines.push(`${group.id} (phase: ${group.phase})`);
      for (const task of group.tasks) lines.push(`- ${task}`);
    }
  }

  lines.push("", "Log, oldest first:");
  if (input.digest.length === 0) lines.push("(nothing recorded yet)");
  for (const entry of input.digest) lines.push(`#${entry.seq} [${entry.kind}] ${entry.text}`);

  return { systemPrompt: PLAN_KEEPER_SYSTEM_PROMPT, prompt: lines.join("\n") };
}

/**
 * Return the outermost balanced `{...}`, tolerating a code fence or stray
 * prose around it and ignoring braces inside strings. Mirrors
 * lib/model-plan/planner.ts's scanner, kept as its own copy: the two features
 * share no other code and a cross-import would be a strange edge for a dozen
 * lines with no state.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && (depth -= 1) === 0) return text.slice(start, index + 1);
  }
  return null;
}

/** Longer than `maxWords` words: cut to the first `maxWords` — a cheap model
 * is not always obeyed the first time, and a hard cap here matters more than
 * a graceful one. */
function capWords(text: string, maxWords: number): string {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  return words.length <= maxWords ? trimmed : words.slice(0, maxWords).join(" ");
}

/** One reported check-off: which task, and the log entry and words that are
 * supposed to prove it. */
export interface PlanKeeperClaim {
  /** The task's id ("T3") or, from a model that ignored the ids, its text. */
  ref: string;
  entry: number | null;
  quote: string;
}

export interface PlanKeeperAnswer {
  done: PlanKeeperClaim[];
  /** Keyed by the parent task's id (or text). */
  subtasks: Record<string, string[]>;
  subtasksDone: string[];
  /** Keyed by task id. */
  labels: Record<string, string>;
  /** Keyed by group id. */
  summaries: Record<string, string>;
}

function readClaim(value: unknown): PlanKeeperClaim | null {
  if (typeof value === "string") return value.trim() ? { ref: value.trim(), entry: null, quote: "" } : null;
  if (!isRecord(value)) return null;
  const ref = [value.id, value.task, value.content].find((field) => (typeof field === "string" && field.trim().length > 0) || typeof field === "number");
  if (ref === undefined) return null;
  const entry = typeof value.entry === "number" ? value.entry : typeof value.entry === "string" ? Number(value.entry.replace(/^#/, "")) : Number.NaN;
  const quote = [value.quote, value.evidence].find((field) => typeof field === "string");
  return { ref: String(ref).trim(), entry: Number.isInteger(entry) ? entry : null, quote: typeof quote === "string" ? quote : "" };
}

/** Labels and summaries: one line each, without the wrapping quotes or the
 * trailing full stop a model likes to add, capped to `maxWords`. */
function readShortLines(value: unknown, maxWords: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== "string" || !key.trim()) continue;
    const line = capWords(text.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”.]+$/g, ""), maxWords);
    if (line) out[key.trim()] = line;
  }
  return out;
}

/**
 * Lenient parse of the model's answer: find the JSON object wherever it is,
 * coerce every field defensively, and drop anything unknown-shaped rather
 * than fail the whole answer over one bad field. `completed` and
 * `subtasksCompleted` are read as `done` and `subtasksDone`: a model that
 * falls back to the obvious names still gets heard (and still has to prove
 * every check-off). Null only when there is no JSON object in the text at
 * all — the caller treats that as "nothing to apply".
 */
export function parsePlanKeeperAnswer(raw: string): PlanKeeperAnswer | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const claimed = Array.isArray(parsed.done) ? parsed.done : Array.isArray(parsed.completed) ? parsed.completed : [];
  const done = claimed.flatMap((value) => readClaim(value) ?? []);

  const subtasks: Record<string, string[]> = {};
  if (isRecord(parsed.subtasks)) {
    for (const [key, value] of Object.entries(parsed.subtasks)) {
      if (!key.trim() || !Array.isArray(value)) continue;
      const items = value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, MAX_SUBTASKS)
        .map((item) => capWords(item, MAX_SUBTASK_WORDS));
      if (items.length > 0) subtasks[key.trim()] = items;
    }
  }

  const finished = Array.isArray(parsed.subtasksDone) ? parsed.subtasksDone : Array.isArray(parsed.subtasksCompleted) ? parsed.subtasksCompleted : [];
  const subtasksDone = finished.filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return {
    done,
    subtasks,
    subtasksDone,
    labels: readShortLines(parsed.labels, MAX_LABEL_WORDS),
    summaries: readShortLines(parsed.summaries, MAX_SUMMARY_WORDS),
  };
}
