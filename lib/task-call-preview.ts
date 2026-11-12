import { isRecord } from "./type-guards";

const MAX = 120;

/** The two counted phrases a preview needs, supplied by the caller so the
 * wording goes through i18n (this module stays free of UI strings). */
export interface TaskPreviewLabels {
  subagents: (count: number) => string;
  steps: (count: number) => string;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX ? `${flat.slice(0, MAX - 1)}…` : flat;
}

/** What one task item is asked to do, in a line: its name, else the start of
 * its instruction, else (omp 18.19 `task.steps`) its first step; several steps
 * are counted. */
function itemLine(item: unknown, labels: TaskPreviewLabels): string {
  if (!isRecord(item)) return "";
  const steps = Array.isArray(item.steps) ? item.steps.filter((step): step is string => typeof step === "string") : [];
  const lead = typeof item.name === "string" && item.name.trim()
    ? item.name.trim()
    : typeof item.task === "string" && item.task.trim()
      ? item.task
      : steps[0] ?? "";
  return steps.length > 1 ? `${lead} (${labels.steps(steps.length)})` : lead;
}

/**
 * The one-line preview of a `task` tool call, or null when there is nothing
 * Cody can summarise (the caller falls back to its generic preview).
 *
 * omp 18.8 sends one subagent per call (`{ name?, agent, task, … }`) or a batch
 * (`{ context, tasks: [...] }`); omp 18.19 can send `steps: string[]` where a
 * subagent used to get `task` (setting `task.steps`). The generic preview
 * showed the first key only: the shared context of a batch, or one step.
 */
export function taskCallPreview(input: unknown, labels: TaskPreviewLabels): string | null {
  if (!isRecord(input)) return null;
  if (Array.isArray(input.tasks)) {
    const items = input.tasks.map((item) => itemLine(item, labels)).filter(Boolean);
    const head = labels.subagents(input.tasks.length);
    return items.length > 0 ? clip(`${head}: ${items.join(", ")}`) : head;
  }
  const line = itemLine(input, labels);
  return line ? clip(line) : null;
}
