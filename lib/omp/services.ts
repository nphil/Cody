import { setTimeout as sleep } from "node:timers/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { runOmpCli, parseJsonLoose } from "./plugin-cli";

/**
 * Background services the agent started (`omp ps`): dev servers, watchers, the
 * shared browser. Since omp 18.18.9 these keep running after the chat's engine
 * exits (Cody's engine is a non-interactive host, which forces `launch.persist`),
 * so without a view they pile up on the host. `omp ps --json` exists on 18.8.3
 * too, so no version gate is needed: an engine without the command answers an
 * error and the caller treats that as "not supported".
 *
 * Two answer shapes, told apart by their content, never by version number:
 * - omp ≤ 18: an array with one entry per project service manager ("broker"),
 *   each listing its `daemons`; machine-wide ones were separate `global` entries.
 * - omp 19: `{ daemon, reports }`, one per-user daemon whose board groups
 *   `units` by scope (global, project, session). Most unit kinds are engine
 *   internals (language servers, speech models, the agent mesh) or a live
 *   chat's own terminal; only `proc` units are services someone started.
 *
 * Only running or starting services are returned; exited ones are history.
 */

export interface ServiceRow {
  /** The process name the agent gave it. */
  name: string;
  /** omp 19: the daemon's id for the unit, the handle `omp ps stop` takes. Null on omp ≤ 18, which names a service by name and folder. */
  id: string | null;
  state: string;
  pid: number | null;
  /** Epoch ms the process started. */
  startedAt: number | null;
  /** The command line, one line, cut to a short length. */
  command: string;
  /** Folder the service belongs to; null for a machine-wide service. */
  projectDir: string | null;
  /** Machine-wide service: its scope name on omp ≤ 18, `"global"` on omp 19; null for a project service. */
  scope: string | null;
  /** True for services omp itself runs (the shared browser), not the agent's. */
  internal: boolean;
}

const COMMAND_MAX = 200;
const TERMINAL: Record<string, true> = { exited: true, failed: true };
/** omp 19 launches a service through its own shell host: `… __omp_worker_shell_process --source <script> -- <the command>`. */
const SHELL_HOST = /__omp_worker_shell_process\s+--source\s+\S+\s+--\s+/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function tidyCommand(raw: unknown): string {
  const flat = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  const host = SHELL_HOST.exec(flat);
  const command = host ? flat.slice(host.index + host[0].length) : flat;
  return command.length > COMMAND_MAX ? `${command.slice(0, COMMAND_MAX - 1)}…` : command;
}

function legacyRows(reports: unknown[]): ServiceRow[] {
  const rows: ServiceRow[] = [];
  for (const report of reports) {
    const scope = asRecord(report);
    if (!scope || !Array.isArray(scope.daemons)) continue;
    const projectDir = scope.kind === "project" && typeof scope.projectDir === "string" ? scope.projectDir : null;
    const service = scope.kind === "global" && typeof scope.service === "string" ? scope.service : null;
    if (projectDir === null && service === null) continue;
    for (const entry of scope.daemons) {
      const daemon = asRecord(entry);
      if (!daemon || typeof daemon.name !== "string" || typeof daemon.state !== "string") continue;
      if (TERMINAL[daemon.state]) continue;
      rows.push({
        name: daemon.name,
        id: null,
        state: daemon.state,
        pid: typeof daemon.pid === "number" ? daemon.pid : null,
        startedAt: typeof daemon.startedAt === "number" ? daemon.startedAt : null,
        command: tidyCommand(daemon.command),
        projectDir,
        scope: service,
        internal: daemon.name.startsWith("omp."),
      });
    }
  }
  return rows;
}

function daemonRows(reports: unknown[]): ServiceRow[] {
  const rows: ServiceRow[] = [];
  for (const report of reports) {
    const entry = asRecord(report);
    const scope = asRecord(entry?.scope);
    if (!entry || !scope || !Array.isArray(entry.units)) continue;
    // A session-scoped unit ends with its chat, so it is not a leftover to clean up.
    const projectDir = scope.kind === "project" && typeof scope.dir === "string" ? scope.dir : null;
    const machineWide = scope.kind === "global";
    if (projectDir === null && !machineWide) continue;
    for (const item of entry.units) {
      const unit = asRecord(item);
      if (!unit || unit.kind !== "proc" || typeof unit.id !== "string" || typeof unit.state !== "string") continue;
      if (TERMINAL[unit.state]) continue;
      const key = typeof unit.key === "string" ? unit.key : "";
      const name = typeof unit.label === "string" && unit.label !== "" ? unit.label : key;
      if (name === "") continue;
      const pid = Array.isArray(unit.pids) ? unit.pids.find((value): value is number => typeof value === "number") : undefined;
      rows.push({
        name,
        id: unit.id,
        state: unit.state,
        pid: pid ?? null,
        startedAt: typeof unit.startedAt === "number" ? unit.startedAt : null,
        command: tidyCommand(unit.command),
        projectDir,
        scope: machineWide ? "global" : null,
        internal: key.startsWith("omp.") || name.startsWith("omp."),
      });
    }
  }
  return rows;
}

/** The services on a parsed board, and whether it came from the one-daemon engine (omp 19+). */
interface ParsedBoard {
  rows: ServiceRow[];
  daemonEngine: boolean;
}

function parseBoard(stdout: string): ParsedBoard | null {
  const parsed = parseJsonLoose<unknown>(stdout);
  if (Array.isArray(parsed)) return { rows: legacyRows(parsed), daemonEngine: false };
  const board = asRecord(parsed);
  if (board && Array.isArray(board.reports)) return { rows: daemonRows(board.reports), daemonEngine: true };
  return null;
}

/** Pure parser for the JSON `omp ps --all --json` prints. Unknown shapes yield no rows. */
export function parseServiceReports(stdout: string): ServiceRow[] | null {
  return parseBoard(stdout)?.rows ?? null;
}

async function readBoard(): Promise<ParsedBoard> {
  const { stdout } = await runOmpCli(["ps", "--all", "--json"], { timeout: 30_000 });
  const board = parseBoard(stdout);
  if (board === null) throw new Error("omp ps returned an unreadable answer");
  return board;
}

/** Every running service on this host, across all projects. Throws if `omp ps` is unavailable. */
export async function listServices(): Promise<ServiceRow[]> {
  return (await readBoard()).rows;
}

export type ServiceStopMode = "stop" | "kill";

/** Stop (graceful) or kill (immediate) one service in the scope it was listed under. */
export async function stopService(
  target: { name: string; id?: string | null; projectDir: string | null; scope: string | null },
  mode: ServiceStopMode,
): Promise<void> {
  // omp 19 resolves an exact unit id before anything else, from any folder.
  if (target.id) {
    await runOmpCli(["ps", mode, target.id], { timeout: 30_000 });
    return;
  }
  const args = ["ps", mode, target.name];
  if (target.scope) args.push("--global", target.scope);
  else if (target.projectDir) args.push("--dir", target.projectDir);
  else throw new Error("A service needs a project folder or a service scope");
  await runOmpCli(args, { timeout: 30_000 });
}

// -- service managers left by omp ≤ 18 ---------------------------------------------------------
//
// omp ≤ 18 ran one service manager per project (`__omp_worker_daemon_broker`); omp 19 runs one
// daemon per user (`__omp_worker_daemon`) and does not adopt the old ones. After an engine
// update that is applied while chats are open, the services of a chat still on the old engine
// (or of a manager that outlived the update) are alive but absent from `omp ps`. A host update
// that restarts the container ends them all, so this only matters for an in-place update.

const LEGACY_BROKER_ARG = "__omp_worker_daemon_broker";

/** Whether a `/proc/<pid>/cmdline` (NUL-separated) is an omp ≤ 18 service manager. A whole argument must match, so omp 19's `__omp_worker_daemon` never does. */
export function isLegacyBrokerCmdline(cmdline: string): boolean {
  return cmdline.split("\0").includes(LEGACY_BROKER_ARG);
}

/** Process ids of omp ≤ 18 service managers owned by this user. Reads `/proc`, so other platforms see none. */
export function legacyBrokerPids(procDir = "/proc"): number[] {
  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return [];
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (uid !== null && statSync(`${procDir}/${entry}`).uid !== uid) continue;
      if (isLegacyBrokerCmdline(readFileSync(`${procDir}/${entry}/cmdline`, "utf8"))) pids.push(Number(entry));
    } catch {
      // The process ended meanwhile, or its details are not ours to read.
    }
  }
  return pids;
}

/**
 * Ask every omp ≤ 18 service manager to shut down (each stops the services it runs, 2 s grace
 * apiece, then exits) and wait until they are gone or `waitMs` passes. Returns how many were signalled.
 */
export async function stopLegacyBrokers(procDir = "/proc", waitMs = 6_000): Promise<number> {
  let signalled = 0;
  for (const pid of legacyBrokerPids(procDir)) {
    try {
      process.kill(pid, "SIGTERM");
      signalled += 1;
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + waitMs;
  while (signalled > 0 && Date.now() < deadline && legacyBrokerPids(procDir).length > 0) {
    await sleep(150);
  }
  return signalled;
}

export interface ServiceBoard {
  services: ServiceRow[];
  /** omp ≤ 18 service managers still running under an omp 19 engine, whose services this list cannot show. 0 when nothing is left over (always 0 on omp ≤ 18, which lists them itself). */
  oldManagers: number;
}

/** The services plus the leftover-manager count; what the Settings card shows. */
export async function readServiceBoard(): Promise<ServiceBoard> {
  const { rows, daemonEngine } = await readBoard();
  return { services: rows, oldManagers: daemonEngine ? legacyBrokerPids().length : 0 };
}
