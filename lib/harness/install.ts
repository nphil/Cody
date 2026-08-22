import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { execPath } from "process";
import { describeDiskError, formatBytes, getDiskSpace, getNpmCacheDir } from "../disk-space";
import { stripVersionPrefix } from "../omp/omp-cli";
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
/** How much combined npm output the live progress log retains. */
const LOG_TAIL_LIMIT = 32_000;
/** Grace period between SIGTERM and SIGKILL for a timed-out npm. */
const KILL_GRACE_MS = 5_000;
/**
 * Below this, an engine install is refused before npm runs. An engine unpacks
 * far larger than its tarball (omp: ~12 MB compressed, ~50 MB on disk, plus
 * its dependency tree and the cached tarball), so a filesystem this close to
 * full will fail partway through — the expensive, confusing way. Deliberately
 * conservative: the point is to catch "no room at all", not to second-guess a
 * small-but-workable disk.
 */
const MIN_FREE_BYTES = 512 * 1024 * 1024;

export interface EngineInstallRequest {
  /** Engine id — the serialization key ("claude", "codex"). */
  id: string;
  /** npm spec from the adapter ("@openai/codex@latest"). */
  installSpec: string;
  /** Binary whose resolution cache must be dropped once npm finishes. */
  binaryName: string;
  /** Version installed BEFORE this run (probed by the route); recorded on
   * success so a broken update can be reverted. Omit to leave the record
   * untouched. */
  currentVersion?: string | null;
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

/** Progress of one engine's install, as the SSE route reports it. "idle"
 * means no install has run since the server started. */
export type InstallStatus = "idle" | "running" | "succeeded" | "failed";

export interface InstallSnapshot {
  status: InstallStatus;
  /** Combined stdout+stderr npm has printed so far (tail-capped). */
  log: string;
  error: { message: string; detail: string } | null;
}

export type InstallEvent =
  | { type: "log"; chunk: string }
  | { type: "done"; ok: boolean; error: { message: string; detail: string } | null };

type InstallListener = (event: InstallEvent) => void;

interface InstallJob {
  status: Exclude<InstallStatus, "idle">;
  log: string;
  error: { message: string; detail: string } | null;
  listeners: Set<InstallListener>;
}

interface InstallStore {
  inFlight: Map<string, Promise<EngineInstallResult>>;
  jobs: Map<string, InstallJob>;
}

// On globalThis so dedupe and progress survive dev hot reloads (the
// rpc-manager registry trick): a freshly-reloaded module that forgot an
// in-flight npm would happily start a second one against the same prefix.
const installGlobal = globalThis as typeof globalThis & { __codyEngineInstallStore?: InstallStore };
const store: InstallStore = (installGlobal.__codyEngineInstallStore ??= {
  inFlight: new Map(),
  jobs: new Map(),
});
const inFlight = store.inFlight;

function beginJob(id: string): InstallJob {
  const job: InstallJob = { status: "running", log: "", error: null, listeners: new Set() };
  store.jobs.set(id, job);
  return job;
}

function appendJobLog(job: InstallJob, chunk: string): void {
  // Cap without trimming: tail() strips trailing newlines, which would glue
  // every chunk boundary onto the previous line.
  const combined = job.log + chunk;
  job.log = combined.length <= LOG_TAIL_LIMIT ? combined : `…${combined.slice(-LOG_TAIL_LIMIT)}`;
  for (const listener of job.listeners) {
    try {
      listener({ type: "log", chunk });
    } catch {
      // A dead SSE controller must not break the install.
    }
  }
}

function finishJob(job: InstallJob, error: EngineInstallError | null): void {
  job.status = error ? "failed" : "succeeded";
  job.error = error ? { message: error.message, detail: error.detail } : null;
  const event: InstallEvent = { type: "done", ok: !error, error: job.error };
  for (const listener of job.listeners) {
    try {
      listener(event);
    } catch {
      // Ditto.
    }
  }
  job.listeners.clear();
}

/** Current install state for an engine — the SSE route's opening frame. */
export function getInstallSnapshot(id: string): InstallSnapshot {
  const job = store.jobs.get(id);
  if (!job) return { status: "idle", log: "", error: null };
  return { status: job.status, log: job.log, error: job.error };
}

/** Follow a running install's output. No-op (immediately-dead unsubscribe)
 * when nothing is running for this engine — callers read the snapshot first. */
export function subscribeInstall(id: string, listener: InstallListener): () => void {
  const job = store.jobs.get(id);
  if (!job || job.status !== "running") return () => {};
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

/** Per-engine record of the version replaced by the last successful install,
 * beside the tools prefix so it survives container image updates. This is
 * what makes "revert to the previous version" possible after an engine
 * update breaks something. */
export interface InstallHistoryEntry {
  previousVersion: string | null;
  updatedAt: string;
}

function installHistoryPath(): string {
  return join(getToolsDir(), "install-history.json");
}

export function readInstallHistory(): Record<string, InstallHistoryEntry> {
  try {
    const parsed = JSON.parse(readFileSync(installHistoryPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: Record<string, InstallHistoryEntry> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, Partial<InstallHistoryEntry>>)) {
      if (!value || typeof value !== "object") continue;
      entries[id] = {
        // Records written before the omp probe was normalized hold "omp/17.3.5";
        // the revert affordance must show the same bare semver as everywhere else.
        previousVersion: typeof value.previousVersion === "string" ? stripVersionPrefix(value.previousVersion) : null,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
      };
    }
    return entries;
  } catch {
    return {};
  }
}

function recordInstallHistory(id: string, previousVersion: string | null): void {
  try {
    const history = readInstallHistory();
    history[id] = { previousVersion, updatedAt: new Date().toISOString() };
    const file = installHistoryPath();
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(history, null, 2)}\n`);
    renameSync(temp, file);
  } catch {
    // Best-effort: losing the revert record must never fail an install.
  }
}

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

/**
 * The paths npm will write to, and whether either is too full to try. Both
 * matter and they are often on different filesystems: the prefix receives the
 * unpacked engine, while the cache receives the downloaded tarball — and the
 * cache is what filled first in the field.
 *
 * Returns a ready-to-show message, or null when there is room (or when free
 * space cannot be read at all — an unknown filesystem must never block an
 * install that would have worked).
 */
export function checkInstallDiskSpace(
  prefix: string,
  cacheDir: string,
  probe: (dir: string) => { availableBytes: number } | null = getDiskSpace,
): string | null {
  for (const [label, dir] of [["install directory", prefix], ["npm cache", cacheDir]] as const) {
    const space = probe(dir);
    if (!space || space.availableBytes >= MIN_FREE_BYTES) continue;
    return `Not enough free disk space for the ${label} ${dir}: ${formatBytes(space.availableBytes)} available, at least ${formatBytes(MIN_FREE_BYTES)} needed. Free up space on that filesystem (or raise its quota) and try again.`;
  }
  return null;
}

/** Turn npm's disk failures into the one sentence that explains them. npm
 * reports EDQUOT as "Unknown system error -122", which reads like a bug in
 * Cody rather than a full disk. */
function diskFailureMessage(stderr: string, prefix: string, cacheDir: string): string | null {
  const kind = describeDiskError(stderr);
  if (!kind) return null;
  const culprit = /_cacache|npm[\\/]_logs/.test(stderr) ? cacheDir : prefix;
  const space = getDiskSpace(culprit);
  const free = space ? ` (${formatBytes(space.availableBytes)} available)` : "";
  return kind === "quota"
    ? `Ran out of disk quota while writing to ${culprit}${free}. The filesystem holding it is at its quota — raise the quota or delete data there, then try again.`
    : `Ran out of disk space while writing to ${culprit}${free}. Free up space on that filesystem and try again.`;
}

function runInstall(request: EngineInstallRequest): Promise<EngineInstallResult> {
  const prefix = getToolsDir();
  const cacheDir = getNpmCacheDir();
  const args = ["install", "-g", "--prefix", prefix, request.installSpec];
  const npmCli = findNpmCli();
  const command = npmCli ? execPath : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const startedAt = Date.now();
  const job = beginJob(request.id);
  appendJobLog(job, `$ npm install -g --prefix ${prefix} ${request.installSpec}\n`);

  return new Promise<EngineInstallResult>((resolve, reject) => {
    try {
      mkdirSync(prefix, { recursive: true });
    } catch (error) {
      const diskNote = describeDiskError(String(error));
      const failure = new EngineInstallError(
        diskNote
          ? `Could not create the engine install directory ${prefix}: the filesystem is ${diskNote === "quota" ? "at its quota" : "full"}.`
          : `Could not create the engine install directory ${prefix}`,
        String(error),
      );
      finishJob(job, failure);
      reject(failure);
      return;
    }

    // Preflight: a five-minute download that dies on a full disk teaches the
    // admin nothing. Refuse up front, naming the path and the space left.
    const spaceProblem = checkInstallDiskSpace(prefix, cacheDir);
    if (spaceProblem) {
      appendJobLog(job, `${spaceProblem}\n`);
      const failure = new EngineInstallError(spaceProblem);
      finishJob(job, failure);
      reject(failure);
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
      finishJob(job, error);
      if (error) reject(error);
      else resolve(result as EngineInstallResult);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      appendJobLog(job, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = tail(stderr + text, STDERR_TAIL_LIMIT * 2);
      appendJobLog(job, text);
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
      // A disk failure gets named rather than passed through as npm's
      // "Unknown system error -122", which reads like a Cody bug.
      const diskMessage = diskFailureMessage(stderr, prefix, cacheDir);
      if (diskMessage) {
        finish(new EngineInstallError(diskMessage, tail(stderr)));
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

  const pending = runInstall(request)
    .then((result) => {
      if (request.currentVersion !== undefined) {
        recordInstallHistory(request.id, request.currentVersion);
      }
      return result;
    })
    .finally(() => {
      inFlight.delete(request.id);
      invalidateEngineBinCache(request.binaryName);
    });
  inFlight.set(request.id, pending);
  return pending;
}

/** Ceiling on an `npm uninstall` run — removal is file deletion, not a
 * network operation, so a minute is generous. */
const UNINSTALL_TIMEOUT_MS = 60_000;

/**
 * Remove an engine that Cody npm-installed into the persistent tools prefix.
 * Policy lives in the DELETE route (admin, not the active engine, binary
 * actually managed by Cody); this only runs npm and drops the binary caches
 * so the next probe sees the removal.
 */
export function uninstallEngine(request: { id: string; packageName: string; binaryName: string }): Promise<void> {
  if (inFlight.has(request.id)) {
    return Promise.reject(new EngineInstallError(`An install of ${request.id} is still running; wait for it to finish.`, ""));
  }
  const prefix = getToolsDir();
  const args = ["uninstall", "-g", "--prefix", prefix, request.packageName];
  const npmCli = findNpmCli();
  const command = npmCli ? execPath : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, UNINSTALL_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString("utf8"), STDERR_TAIL_LIMIT * 2);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new EngineInstallError(`Could not run npm to uninstall ${request.packageName}`, String(error)));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      // Dropped on failure too: a partial removal can leave a broken bin that
      // a stale "installed" probe would outlive.
      invalidateEngineBinCache(request.binaryName);
      if (timedOut) {
        reject(new EngineInstallError(`Uninstalling ${request.packageName} timed out after 1 minute`, tail(stderr)));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const how = signal ? `was killed with ${signal}` : `exited with code ${code}`;
      reject(new EngineInstallError(`npm uninstall ${request.packageName} ${how}`, tail(stderr)));
    });
  });
}

/** Whether an install for this engine is already running (UI/status probes). */
export function isEngineInstalling(id: string): boolean {
  return inFlight.has(id);
}
