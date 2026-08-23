import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
// Namespace import, not default: node-pty is CJS with `__esModule: true` and
// no default export, so webpack's production interop resolves a default
// import to `undefined` (Turbopack dev interops differently, which hides the
// bug until `next build --webpack`). `pty.spawn` then throws
// "Cannot read properties of undefined (reading 'spawn')" on every terminal.
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { getHarness } from "./harness";

export type TerminalInfo = {
  id: string;
  cwd: string;
  name: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
  /** True for a terminal that opened as the read-only live chat view. */
  attached?: boolean;
};

/** Request to open the terminal as a read-only follower of a chat session.
 * Honored only when the workspace has no other live web terminal. */
export type TerminalAttach = { sessionFile: string; locale: string };
export type TerminalEvent =
  | { type: "output"; data: string; replay?: boolean }
  | { type: "exit"; exitCode?: number }
  | { type: "error"; message: string };

type TerminalRecord = TerminalInfo & {
  pty?: IPty;
  replay: string;
  listeners: Set<(event: TerminalEvent) => void>;
  /** The engine whose CLI this terminal was launched into, when it was one.
   * Internal: it stays off TerminalInfo so it never reaches an API response.
   * A plain shell leaves it undefined and is never touched by a switch. */
  engineId?: string;
};
const MAX_REPLAY = 200_000;
const MIN_DIM = 2;
const MAX_DIM = 500;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare global { var __codyTerminalManager: TerminalManager | undefined; }

function dimension(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < MIN_DIM || value > MAX_DIM) throw new Error("Invalid terminal dimensions");
  return value;
}

export async function authorizeTerminalCwd(input: string): Promise<string> {
  if (typeof input !== "string" || !input.trim()) throw new Error("cwd is required");
  const candidate = input === "~" ? homedir() : path.resolve(input);
  let cwd: string;
  try { cwd = realpathSync(candidate); } catch { throw new Error("Workspace is not allowed"); }
  const roots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, roots)) throw new Error("Workspace is not allowed");
  return cwd;
}

function terminalEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.CODY_TERMINAL = "1";
  return env;
}

type SpawnCommand = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Set only on the branch that actually launches an engine CLI, so the
   * record can be torn down when that engine is no longer active. A plain
   * shell leaves it unset. */
  engineId?: string;
};
type SpawnMode = { launchEngine: boolean; attach?: TerminalAttach };

/** Resolve what a browser PTY runs. All three shapes are exclusive to a
 * user-created Cody terminal; server subprocesses, task runners and
 * non-interactive SSH commands never pass through here. */
function terminalCommand(mode: SpawnMode): SpawnCommand {
  const shell = process.env.CODY_TERMINAL_SHELL || (process.platform === "win32" ? "powershell.exe" : userInfo().shell || "/bin/sh");

  // Read-only chat follower (bin/cody-session-tail.js): renders the active
  // conversation, follows appends, and hands the PTY to the login shell on
  // demand. It never writes to the session file, so the live rpc-ui process
  // stays the single writer. create() only requests it on POSIX, like the
  // engine wrapper below.
  if (mode.attach) {
    const packageRoot = process.env.CODY_PACKAGE_DIR || process.cwd();
    return {
      command: process.execPath,
      args: [path.join(packageRoot, "bin", "cody-session-tail.js"), mode.attach.sessionFile],
      env: { CODY_TAIL_SHELL: shell, CODY_TAIL_LOCALE: mode.attach.locale },
    };
  }
  if (!mode.launchEngine || process.platform === "win32") return { command: shell, args: [] };

  const harness = getHarness();
  const engine = harness.resolveBinary();
  if (!engine) return { command: shell, args: [] };

  // Positionals are consumed up front so whatever remains is the engine's own
  // argv. Most engines open their TUI when run bare; an ACP adapter run bare
  // is a JSON-RPC server that would read the user's keystrokes as protocol
  // frames, so it names the argv that reaches its interactive CLI instead.
  const script = [
    `name="$1"; engine="$2"; shell="$3"; shift 3`,
    `printf 'Cody: starting %s — exit the engine to drop to a shell.\\n' "$name"`,
    `"$engine" "$@" || true`,
    `printf 'Cody: %s exited — this is a plain shell now.\\n' "$name"`,
    `exec "$shell" -i`,
  ].join("\n");
  return {
    command: "/bin/sh",
    args: ["-c", script, "cody-terminal", harness.binaryName, engine, shell, ...(harness.cliArgs ?? [])],
    // Named so the record can be torn down when this engine stops being the
    // active one. Reported from HERE rather than re-derived at the call site
    // because this is the branch that decides an engine was launched at all —
    // an unresolved binary falls through to a plain shell above.
    engineId: harness.id,
    // Whatever the engine needs to find its own parts, the same values the
    // live session and the post-install probe get. Without it, an engine Cody
    // points at a CLI it manages separately would fail in a terminal only —
    // the one place the user goes to sign in.
    env: harness.engineEnv?.(),
  };
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();

  list(cwd: string): TerminalInfo[] {
    const normalized = path.resolve(cwd);
    return [...this.terminals.values()].filter((terminal) => terminal.cwd === normalized).map(publicInfo);
  }

  /** True while any terminal in this workspace still has a live PTY. The
   * first-terminal attach rule counts here, server-side, so racing clients
   * cannot create two chat views. */
  private hasLiveTerminal(cwd: string): boolean {
    const normalized = path.resolve(cwd);
    return [...this.terminals.values()].some((terminal) => terminal.cwd === normalized && !terminal.exited);
  }

  create(cwd: string, name?: string, cols?: number, rows?: number, attach?: TerminalAttach): TerminalInfo {
    const requestedName = name?.trim();
    if (requestedName && !/^[\w .:+-]{1,80}$/.test(requestedName)) throw new Error("Invalid terminal name");
    // Server-authoritative first-terminal rule: only the FIRST live terminal
    // of a workspace may attach to the chat; every other one gets the normal
    // engine wrapper, whatever the client claimed.
    const attaching = attach !== undefined && process.platform !== "win32" && !this.hasLiveTerminal(cwd);
    const record: TerminalRecord = {
      id: randomUUID(),
      cwd,
      name: requestedName || `Shell ${this.list(cwd).length + 1}`,
      createdAt: new Date().toISOString(),
      exited: false,
      ...(attaching ? { attached: true } : {}),
      replay: "",
      listeners: new Set(),
    };
    this.spawn(record, cols, rows, { launchEngine: true, attach: attaching ? attach : undefined });
    this.terminals.set(record.id, record);
    return publicInfo(record);
  }

  get(id: string): TerminalRecord {
    if (!ID_RE.test(id)) throw new Error("Invalid terminal id");
    const record = this.terminals.get(id);
    if (!record) throw new Error("Terminal not found");
    return record;
  }

  rename(id: string, name: string): TerminalInfo {
    const record = this.get(id);
    const requestedName = name.trim();
    if (!/^[\w .:+-]{1,80}$/.test(requestedName)) throw new Error("Invalid terminal name");
    record.name = requestedName;
    return publicInfo(record);
  }

  subscribe(id: string, listener: (event: TerminalEvent) => void): () => void {
    const record = this.get(id);
    record.listeners.add(listener);
    if (record.replay) listener({ type: "output", data: record.replay, replay: true });
    if (record.exited) listener({ type: "exit", exitCode: record.exitCode });
    return () => record.listeners.delete(listener);
  }

  write(id: string, data: string): void {
    const record = this.get(id);
    if (!record.pty || typeof data !== "string" || data.length > 1_000_000) throw new Error("Terminal is not running");
    record.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.get(id).pty?.resize(dimension(cols, 80), dimension(rows, 24));
  }

  continue(id: string, cols?: number, rows?: number): TerminalInfo {
    const record = this.get(id);
    if (!record.exited) return publicInfo(record);
    const marker = "\r\n[continued in interactive shell]\r\n";
    record.replay = (record.replay + marker).slice(-MAX_REPLAY);
    this.emit(record, { type: "output", data: marker });
    this.spawn(record, cols, rows, { launchEngine: false });
    return publicInfo(record);
  }

  close(id: string): void {
    const record = this.get(id);
    record.listeners.clear();
    record.pty?.kill();
    this.terminals.delete(id);
  }

  dispose(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  /**
   * Close terminals running an engine that is no longer the active one.
   *
   * The PTY lives on globalThis, so it outlives the page reload an engine
   * switch triggers — and `terminalCommand` resolved the engine ONCE, at spawn
   * time, baking that binary into the `/bin/sh -c` wrapper. Everything else
   * belonging to the old engine is torn down by the switch; without this the
   * terminal panel reattaches to a live REPL of the PREVIOUS engine, still
   * announcing it in the replay buffer, inside a Cody that reports a different
   * engine everywhere else. Anything typed there — a login, a config edit —
   * goes to the wrong engine.
   *
   * Plain shells are left alone: they carry no engineId, and a user's shell is
   * not the switch's to close.
   */
  closeTerminalsForOtherEngines(activeEngineId: string): number {
    let closed = 0;
    for (const [id, record] of [...this.terminals.entries()]) {
      if (!record.engineId || record.engineId === activeEngineId) continue;
      this.close(id);
      closed += 1;
    }
    return closed;
  }

  private spawn(record: TerminalRecord, cols: number | undefined, rows: number | undefined, mode: SpawnMode): void {
    const shell = terminalCommand(mode);
    record.exited = false;
    delete record.exitCode;
    // Re-stamped on every spawn: a record that respawns into a plain shell
    // must stop claiming an engine, or a later switch would kill a shell the
    // user is working in.
    if (shell.engineId) record.engineId = shell.engineId;
    else delete record.engineId;
    const child = pty.spawn(shell.command, shell.args, {
      name: "xterm-256color",
      cols: dimension(cols, 80),
      rows: dimension(rows, 24),
      cwd: record.cwd,
      env: { ...terminalEnvironment(), ...shell.env },
    });
    record.pty = child;
    child.onData((data) => {
      record.replay = (record.replay + data).slice(-MAX_REPLAY);
      this.emit(record, { type: "output", data });
    });
    child.onExit(({ exitCode }) => {
      if (record.pty !== child) return;
      record.exited = true;
      record.exitCode = exitCode;
      record.pty = undefined;
      this.emit(record, { type: "exit", exitCode });
    });
  }

  private emit(record: TerminalRecord, event: TerminalEvent): void {
    for (const listener of record.listeners) {
      try {
        listener(event);
      } catch {
        // Socket owners remove disconnected listeners.
      }
    }
  }
}

function publicInfo(record: TerminalRecord): TerminalInfo {
  const { id, cwd, name, createdAt, exited, exitCode, attached } = record;
  return {
    id, cwd, name, createdAt, exited,
    ...(attached ? { attached } : {}),
    ...(exited && exitCode !== undefined ? { exitCode } : {}),
  };
}

export function getTerminalManager(): TerminalManager {
  if (!globalThis.__codyTerminalManager) {
    globalThis.__codyTerminalManager = new TerminalManager();
    process.once("exit", () => globalThis.__codyTerminalManager?.dispose());
  }
  return globalThis.__codyTerminalManager;
}
