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
};
export type TerminalEvent =
  | { type: "output"; data: string; replay?: boolean }
  | { type: "exit"; exitCode?: number }
  | { type: "error"; message: string };

type TerminalRecord = TerminalInfo & { pty?: IPty; replay: string; listeners: Set<(event: TerminalEvent) => void> };
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

function interactiveShell(launchEngine: boolean): { command: string; args: string[] } {
  const shell = process.env.CODY_TERMINAL_SHELL || (process.platform === "win32" ? "powershell.exe" : userInfo().shell || "/bin/sh");
  if (!launchEngine || process.platform === "win32") return { command: shell, args: [] };

  const harness = getHarness();
  const engine = harness.resolveBinary();
  if (!engine) return { command: shell, args: [] };

  // The wrapper is exclusive to a user-created Cody PTY. Server subprocesses,
  // task runners and non-interactive SSH commands never pass through it.
  const script = [
    `printf 'Cody: starting %s — exit the engine to drop to a shell.\\n' "$1"`,
    `"$2" || true`,
    `printf 'Cody: %s exited — this is a plain shell now.\\n' "$1"`,
    `exec "$3" -i`,
  ].join("\n");
  return {
    command: "/bin/sh",
    args: ["-c", script, "cody-terminal", harness.binaryName, engine, shell],
  };
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();

  list(cwd: string): TerminalInfo[] {
    const normalized = path.resolve(cwd);
    return [...this.terminals.values()].filter((terminal) => terminal.cwd === normalized).map(publicInfo);
  }

  create(cwd: string, name?: string, cols?: number, rows?: number): TerminalInfo {
    const requestedName = name?.trim();
    if (requestedName && !/^[\w .:+-]{1,80}$/.test(requestedName)) throw new Error("Invalid terminal name");
    const record: TerminalRecord = {
      id: randomUUID(),
      cwd,
      name: requestedName || `Shell ${this.list(cwd).length + 1}`,
      createdAt: new Date().toISOString(),
      exited: false,
      replay: "",
      listeners: new Set(),
    };
    this.spawn(record, cols, rows, true);
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
    this.spawn(record, cols, rows, false);
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

  private spawn(record: TerminalRecord, cols?: number, rows?: number, launchEngine = false): void {
    const shell = interactiveShell(launchEngine);
    record.exited = false;
    delete record.exitCode;
    const child = pty.spawn(shell.command, shell.args, {
      name: "xterm-256color",
      cols: dimension(cols, 80),
      rows: dimension(rows, 24),
      cwd: record.cwd,
      env: terminalEnvironment(),
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
  const { id, cwd, name, createdAt, exited, exitCode } = record;
  return { id, cwd, name, createdAt, exited, ...(exited && exitCode !== undefined ? { exitCode } : {}) };
}

export function getTerminalManager(): TerminalManager {
  if (!globalThis.__codyTerminalManager) {
    globalThis.__codyTerminalManager = new TerminalManager();
    process.once("exit", () => globalThis.__codyTerminalManager?.dispose());
  }
  return globalThis.__codyTerminalManager;
}
