import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { execPath } from "process";
import { getToolsDir, invalidateEngineBinCache } from "./engine-bin";

/**
 * On-demand engine installs. An engine the user picks in onboarding (or in
 * Settings → Agent engine) is installed with npm into Cody's own prefix —
 * `<toolsDir>` from lib/harness/engine-bin, which lives under the persistent
 * instance data dir rather than the image's global node_modules, so installed
 * engines survive a container image update. Binary resolution already prefers
 * that prefix over PATH.
 *
 * Installs are serialized per engine id: a second request for the same engine
 * awaits the in-flight one instead of running a second npm against the same
 * prefix (concurrent global installs corrupt each other's bin symlinks).
 * Different engines may still install in parallel.
 */

const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** How much stderr is kept for the error detail shown to the admin. */
const STDERR_TAIL_LIMIT = 4_000;
/** Grace period between SIGTERM and SIGKILL for a timed-out npm. */
const KILL_GRACE_MS = 5_000;

export interface EngineInstallRequest {
  /** Engine id — the serialization key ("claude", "codex"). */
  id: string;
  /** npm spec from the adapter ("@openai/codex@latest"). */
  installSpec: string;
  /** Binary whose resolution cache must be dropped once npm finishes. */
  binaryName: string;
}

export interface EngineInstallResult {
  id: string;
  installSpec: string;
  /** The --prefix npm installed into. */
  prefix: string;
  durationMs: number;
}

/** Install failure carrying the stderr tail, so routes can surface a detail
 * without re-reading npm output themselves. */
export class EngineInstallError extends Error {
  readonly detail: string;

  constructor(message: string, detail = "") {
    super(message);
    this.name = "EngineInstallError";
    this.detail = detail;
  }
}

const inFlight = new Map<string, Promise<EngineInstallResult>>();

/** npm's own CLI shipped with the running Node (mirrors lib/npx.ts). Going
 * through `node .../npm-cli.js` avoids spawning a shell — and on Windows it
 * sidesteps npm.cmd, which Node refuses to spawn without one. */
function findNpmCli(): string | null {
  const nodeDir = dirname(execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Unreadable candidate: keep probing.
    }
  }
  return null;
}

function tail(value: string, limit = STDERR_TAIL_LIMIT): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

function runInstall(request: EngineInstallRequest): Promise<EngineInstallResult> {
  const prefix = getToolsDir();
  const args = ["install", "-g", "--prefix", prefix, request.installSpec];
  const npmCli = findNpmCli();
  const command = npmCli ? execPath : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const startedAt = Date.now();

  return new Promise<EngineInstallResult>((resolve, reject) => {
    try {
      mkdirSync(prefix, { recursive: true });
    } catch (error) {
      reject(new EngineInstallError(`Could not create the engine install directory ${prefix}`, String(error)));
      return;
    }

    // Env is inherited: npm needs HOME, PATH, proxy and registry settings from
    // the container exactly as the operator configured them.
    const child = spawn(command, commandArgs, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, INSTALL_TIMEOUT_MS);

    const finish = (error: EngineInstallError | null, result?: EngineInstallResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else resolve(result as EngineInstallResult);
    };

    child.stdout?.on("data", () => {
      // npm's progress output is not surfaced; draining keeps the pipe open.
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString("utf8"), STDERR_TAIL_LIMIT * 2);
    });

    child.on("error", (error) => {
      finish(new EngineInstallError(`Could not run npm to install ${request.installSpec}`, String(error)));
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(new EngineInstallError(`Installing ${request.installSpec} timed out after 5 minutes`, tail(stderr)));
        return;
      }
      if (code === 0) {
        finish(null, { id: request.id, installSpec: request.installSpec, prefix, durationMs: Date.now() - startedAt });
        return;
      }
      const how = signal ? `was killed with ${signal}` : `exited with code ${code}`;
      finish(new EngineInstallError(`npm install ${request.installSpec} ${how}`, tail(stderr)));
    });
  });
}

/**
 * Install an engine into the persistent tools prefix. Resolves once npm exits
 * cleanly; rejects with EngineInstallError otherwise. The binary resolution
 * cache is dropped either way — a failed install can still have written a
 * partial bin, and a stale "not installed" probe would outlive a success.
 */
export function installEngine(request: EngineInstallRequest): Promise<EngineInstallResult> {
  const existing = inFlight.get(request.id);
  if (existing) return existing;

  const pending = runInstall(request).finally(() => {
    inFlight.delete(request.id);
    invalidateEngineBinCache(request.binaryName);
  });
  inFlight.set(request.id, pending);
  return pending;
}

/** Whether an install for this engine is already running (UI/status probes). */
export function isEngineInstalling(id: string): boolean {
  return inFlight.has(id);
}
