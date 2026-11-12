import { runOmpCli, parseJsonLoose } from "./plugin-cli";

/**
 * Background services the agent started (`omp ps`): dev servers, watchers, the
 * shared browser. Since omp 18.18.9 these keep running after the chat's engine
 * exits (Cody's engine is a non-interactive host, which forces `launch.persist`),
 * so without a view they pile up on the host. `omp ps --json` exists on 18.8.3
 * too, so no version gate is needed: an engine without the command answers an
 * error and the caller treats that as "not supported".
 *
 * Only running or starting services are returned; exited ones are history.
 */

export interface ServiceRow {
  /** The process name the agent gave it. */
  name: string;
  state: string;
  pid: number | null;
  /** Epoch ms the process started. */
  startedAt: number | null;
  /** The command line, one line, cut to a short length. */
  command: string;
  /** Folder the service belongs to; null for a machine-wide service. */
  projectDir: string | null;
  /** Name of a machine-wide service scope; null for a project service. */
  scope: string | null;
  /** True for services omp itself runs (the shared browser), not the agent's. */
  internal: boolean;
}

const COMMAND_MAX = 200;
const TERMINAL: Record<string, true> = { exited: true, failed: true };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Pure parser for the JSON `omp ps --all --json` prints. Unknown shapes yield no rows. */
export function parseServiceReports(stdout: string): ServiceRow[] | null {
  const parsed = parseJsonLoose<unknown>(stdout);
  if (!Array.isArray(parsed)) return null;
  const rows: ServiceRow[] = [];
  for (const report of parsed) {
    const scope = asRecord(report);
    if (!scope || !Array.isArray(scope.daemons)) continue;
    const projectDir = scope.kind === "project" && typeof scope.projectDir === "string" ? scope.projectDir : null;
    const service = scope.kind === "global" && typeof scope.service === "string" ? scope.service : null;
    if (projectDir === null && service === null) continue;
    for (const entry of scope.daemons) {
      const daemon = asRecord(entry);
      if (!daemon || typeof daemon.name !== "string" || typeof daemon.state !== "string") continue;
      if (TERMINAL[daemon.state]) continue;
      const command = typeof daemon.command === "string" ? daemon.command.replace(/\s+/g, " ").trim() : "";
      rows.push({
        name: daemon.name,
        state: daemon.state,
        pid: typeof daemon.pid === "number" ? daemon.pid : null,
        startedAt: typeof daemon.startedAt === "number" ? daemon.startedAt : null,
        command: command.length > COMMAND_MAX ? `${command.slice(0, COMMAND_MAX - 1)}…` : command,
        projectDir,
        scope: service,
        internal: daemon.name.startsWith("omp."),
      });
    }
  }
  return rows;
}

/** Every running service on this host, across all projects. Throws if `omp ps` is unavailable. */
export async function listServices(): Promise<ServiceRow[]> {
  const { stdout } = await runOmpCli(["ps", "--all", "--json"], { timeout: 30_000 });
  const rows = parseServiceReports(stdout);
  if (rows === null) throw new Error("omp ps returned an unreadable answer");
  return rows;
}

export type ServiceStopMode = "stop" | "kill";

/** Stop (graceful) or kill (immediate) one service in the scope it was listed under. */
export async function stopService(
  target: { name: string; projectDir: string | null; scope: string | null },
  mode: ServiceStopMode,
): Promise<void> {
  const args = ["ps", mode, target.name];
  if (target.scope) args.push("--global", target.scope);
  else if (target.projectDir) args.push("--dir", target.projectDir);
  else throw new Error("A service needs a project folder or a service scope");
  await runOmpCli(args, { timeout: 30_000 });
}
