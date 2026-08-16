/**
 * Workspace Tasks configuration schema + validation.
 *
 * Pure module: no I/O, no throwing. Every failure path returns the result
 * union so callers (the API routes and their tests) can render a specific,
 * user-facing message instead of catching exceptions.
 *
 * Ported from pi-web's workspace-tasks plugin. Cody keeps the file under
 * `.cody/` instead of `.pi-web/`, and validation semantics are preserved so
 * task authors get the same diagnostics.
 */

/** Where the config lives, relative to the workspace root. */
export const TASKS_CONFIG_RELATIVE_PATH = ".cody/tasks.json";

/** Only version 1 exists so far; the field is an explicit forward-compat gate. */
export const TASKS_CONFIG_VERSION = 1;

/** Ids are used in URLs/DOM keys and must stay stable and lowercase. */
export const TASK_ID_PATTERN = /^[a-z][a-z0-9.-]*$/u;

export interface WorkspaceTask {
  id: string;
  title: string;
  command: string;
  description?: string;
  group?: string;
  /** Normalized: absent in the file means `false`, never `undefined`. */
  confirm: boolean;
}

export type TasksConfigResult =
  | { ok: true; tasks: WorkspaceTask[] }
  | { ok: false; error: string };

export interface WorkspaceTaskGroup {
  group: string | undefined;
  tasks: WorkspaceTask[];
}

/**
 * Parse and validate the raw text of `.cody/tasks.json`.
 * Returns `{ ok: false, error }` for every malformed input — never throws.
 */
export function parseTasksConfig(raw: string): TasksConfigResult {
  if (typeof raw !== "string") return invalid("Config must be an object");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return invalid(`Invalid JSON: ${errorText(error)}`);
  }

  if (!isRecord(parsed)) return invalid("Config must be an object");
  if (parsed.version !== TASKS_CONFIG_VERSION) return invalid("Config version must be 1");

  const rawTasks = parsed.tasks;
  if (!Array.isArray(rawTasks)) return invalid("Config tasks must be an array");

  const seenIds = new Set<string>();
  const tasks: WorkspaceTask[] = [];
  for (const [index, entry] of rawTasks.entries()) {
    const result = parseTask(entry, index);
    if (!result.ok) return { ok: false, error: result.error };
    if (seenIds.has(result.task.id)) return invalid(`Duplicate task id: ${result.task.id}`);
    seenIds.add(result.task.id);
    tasks.push(result.task);
  }

  return { ok: true, tasks };
}

/**
 * Bucket tasks by their `group`, preserving first-seen group order. Tasks
 * without a group keep their own bucket at the position where the first
 * ungrouped task appeared, so the file's authoring order survives.
 */
export function groupTasks(tasks: WorkspaceTask[]): WorkspaceTaskGroup[] {
  const groups: WorkspaceTaskGroup[] = [];
  for (const task of tasks) {
    let bucket = groups.find((candidate) => candidate.group === task.group);
    if (bucket === undefined) {
      bucket = { group: task.group, tasks: [] };
      groups.push(bucket);
    }
    bucket.tasks.push(task);
  }
  return groups;
}

type ParseTaskResult =
  | { ok: true; task: WorkspaceTask }
  | { ok: false; error: string };

function parseTask(value: unknown, index: number): ParseTaskResult {
  const label = `Task ${String(index + 1)}`;
  if (!isRecord(value)) return invalid(`${label} must be an object`);

  const id = requiredString(value, "id", label);
  if (!id.ok) return id;
  if (!TASK_ID_PATTERN.test(id.value)) return invalid(`${label} id must match ${TASK_ID_PATTERN.source}`);

  const title = requiredString(value, "title", label);
  if (!title.ok) return title;

  const command = requiredString(value, "command", label);
  if (!command.ok) return command;

  const description = optionalString(value, "description", label);
  if (!description.ok) return description;

  const group = optionalString(value, "group", label);
  if (!group.ok) return group;

  const confirm = value.confirm;
  if (confirm !== undefined && typeof confirm !== "boolean") return invalid(`${label} confirm must be a boolean`);

  return {
    ok: true,
    task: {
      id: id.value,
      title: title.value,
      command: command.value,
      ...(description.value === undefined ? {} : { description: description.value }),
      ...(group.value === undefined ? {} : { group: group.value }),
      confirm: confirm ?? false,
    },
  };
}

type RequiredStringResult = { ok: true; value: string } | { ok: false; error: string };
type OptionalStringResult = { ok: true; value: string | undefined } | { ok: false; error: string };

function requiredString(record: Record<string, unknown>, key: string, label: string): RequiredStringResult {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") return invalid(`${label} ${key} must be a non-empty string`);
  return { ok: true, value };
}

function optionalString(record: Record<string, unknown>, key: string, label: string): OptionalStringResult {
  const value = record[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(`${label} ${key} must be a non-empty string when provided`);
  }
  return { ok: true, value };
}

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
