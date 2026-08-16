import fs from "fs";
import path from "path";
import { isExistingFilePathAllowed } from "./file-access";
import { TASKS_CONFIG_RELATIVE_PATH, parseTasksConfig, type WorkspaceTask } from "./workspace-tasks";

/** Task configs are hand-written; anything larger is a mistake, not a config. */
export const MAX_TASKS_CONFIG_BYTES = 256 * 1024;

export type TasksConfigState =
  | { state: "missing" }
  | { state: "invalid"; error: string; code: string }
  | { state: "loaded"; tasks: WorkspaceTask[] };

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Absolute path of the tasks config inside an already-authorized workspace. */
export function tasksConfigPath(cwd: string): string {
  return path.join(cwd, ...TASKS_CONFIG_RELATIVE_PATH.split("/"));
}

/**
 * Read + validate `<cwd>/.cody/tasks.json`.
 *
 * Config problems are data, not transport failures: a broken file still yields
 * `state: "invalid"` (served as HTTP 200) so the panel can show the exact
 * reason instead of a generic request error. Only an absent file is "missing".
 *
 * Callers must authorize `cwd` against the allowed roots before calling and
 * pass those roots in: the config file itself is re-checked so a symlinked
 * `.cody/tasks.json` cannot smuggle content from outside the allow-list —
 * the same guard every other file-reading route applies to its target.
 */
export async function readTasksConfig(cwd: string, allowedRoots: Set<string>): Promise<TasksConfigState> {
  const configPath = tasksConfigPath(cwd);

  let raw: string;
  try {
    const stat = await fs.promises.stat(configPath);
    if (!stat.isFile()) {
      return { state: "invalid", error: `${TASKS_CONFIG_RELATIVE_PATH} is not a file`, code: "tasks_config_not_a_file" };
    }
    if (stat.size > MAX_TASKS_CONFIG_BYTES) {
      return {
        state: "invalid",
        error: `${TASKS_CONFIG_RELATIVE_PATH} is larger than ${String(MAX_TASKS_CONFIG_BYTES)} bytes`,
        code: "tasks_config_too_large",
      };
    }
    if (!isExistingFilePathAllowed(configPath, allowedRoots)) {
      return {
        state: "invalid",
        error: `${TASKS_CONFIG_RELATIVE_PATH} resolves outside the allowed workspace roots`,
        code: "tasks_config_outside_roots",
      };
    }
    raw = await fs.promises.readFile(configPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return { state: "missing" };
    return {
      state: "invalid",
      error: `Unable to read ${TASKS_CONFIG_RELATIVE_PATH}: ${errorText(error)}`,
      code: "tasks_config_unreadable",
    };
  }

  const parsed = parseTasksConfig(raw);
  if (!parsed.ok) return { state: "invalid", error: parsed.error, code: "tasks_config_invalid" };
  return { state: "loaded", tasks: parsed.tasks };
}
