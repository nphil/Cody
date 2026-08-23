import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { execPath } from "process";
import { describeDiskError, formatBytes, getDiskSpace, getNpmCacheDir } from "../disk-space";
import { stripVersionPrefix } from "../omp/omp-cli";
import { getToolsDir, invalidateEngineBinCache, probeEngineVersion, resolveEngineBin } from "./engine-bin";

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
 * Floor for a first-time install, used when the engine is not installed yet so
 * there is no existing tree to measure. Engines unpack far larger than their
 * tarballs — omp ships two ~160 MB native addons alone.
 */
const MIN_FREE_BYTES = 512 * 1024 * 1024;
/** Slack added on top of a measured tree, for the cache copy and metadata. */
const HEADROOM_BYTES = 256 * 1024 * 1024;
/** Stop measuring a tree after this many entries: the answer only needs to be
 * good enough to size a threshold, and an unbounded walk would stall a UI. */
const SIZE_WALK_ENTRY_CAP = 60_000;

/** "@oh-my-pi/pi-coding-agent@latest" → "@oh-my-pi/pi-coding-agent". */
export function packageNameFromSpec(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

export interface EngineInstallRequest {
  /** Engine id — the serialization key ("claude", "codex"). */
  id: string;
  /** npm spec from the adapter ("@openai/codex@latest"). */
  installSpec: string;
  /** Binary whose resolution cache must be dropped once the install finishes. */
  binaryName: string;
  /** Which package manager installs the spec. Defaults to npm — every engine
   * before Hermes was an npm package; Hermes is Python, on PyPI. */
  installVia?: "npm" | "uv";
  /** Further npm specs the engine needs, installed into the same prefix by the
   * same job, one invocation each (HarnessAdapter.installAlso). */
  installAlso?: readonly string[];
  /** Install `installSpec` without its platform-gated optional dependencies
   * (HarnessAdapter.skipNativeOptional). npm-only. */
  skipNativeOptional?: boolean;
  /** Environment the installed engine needs in order to find its own parts,
   * so the health probe below runs what a chat turn will run
   * (HarnessAdapter.engineEnv). */
  engineEnv?: () => Record<string, string>;
  /** Args that make the installed binary print its version. Defaults to
   * ["--version"]. */
  versionArgs?: readonly string[];
  /** Args that prove the engine's real entry point RUNS, for the post-install
   * health probe. Defaults to `versionArgs`: for most engines one invocation
   * answers both questions, and where it does not (Codex's ACP adapter
   * reports its own version without ever spawning Codex) the health probe is
   * the one that must exercise the code a chat turn will take. */
  healthArgs?: readonly string[];
  /** Version installed BEFORE this run (probed by the route); recorded on
   * success so a broken update can be reverted. Omit to leave the record
   * untouched. */
  currentVersion?: string | null;
  /** The engine CLI's version before this run, for a two-package engine.
   * Recorded alongside `currentVersion` so a revert can restore the PAIR that
   * was running, not just the half Cody happens to probe. */
  currentEngineVersion?: string | null;
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
  /**
   * The engine CLI's version at that same moment, for a two-package engine.
   * Recorded because a revert that pins only the adapter and lets the CLI
   * install `@latest` is not a revert: if the CLI is what broke, the "revert"
   * reinstalls the break, and the pair the user is put back on is one that
   * never ran here before.
   *
   * Null for single-package engines and for records written before this
   * existed — a revert then does what it always did.
   */
  previousEngineVersion: string | null;
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
        previousEngineVersion:
          typeof value.previousEngineVersion === "string" ? stripVersionPrefix(value.previousEngineVersion) : null,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
      };
    }
    return entries;
  } catch {
    return {};
  }
}

function recordInstallHistory(
  id: string,
  previousVersion: string | null,
  previousEngineVersion: string | null,
): void {
  try {
    const history = readInstallHistory();
    history[id] = { previousVersion, previousEngineVersion, updatedAt: new Date().toISOString() };
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

/** Where npm unpacks a global package under `--prefix`. */
function packageInstallDir(prefix: string, packageName: string): string {
  return join(prefix, "lib", "node_modules", ...packageName.split("/"));
}

/** Bytes on disk under `dir`, bounded so a pathological tree cannot stall the
 * request. Returns null when the walk is impossible or hits the cap — callers
 * fall back to the flat floor rather than trusting a partial number. */
export function measureTreeBytes(dir: string, entryCap = SIZE_WALK_ENTRY_CAP): number | null {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  try {
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (++seen > entryCap) return null;
        const full = join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) total += statSync(full).size;
      }
    }
  } catch {
    return null;
  }
  return total;
}

/**
 * npm updates a package by renaming the old tree aside (`@scope/.name-XXXXXX`)
 * and unpacking the new one, so an UPDATE transiently needs room for BOTH.
 * omp is ~1.1 GB installed (two ~160 MB native addons among the rest), which a
 * flat 512 MB floor would wave straight through into the failure it exists to
 * prevent. Measuring the installed tree sizes the requirement to the engine
 * actually being updated.
 */
export function requiredFreeBytes(prefix: string, packageName: string | readonly string[]): number {
  const names = typeof packageName === "string" ? [packageName] : packageName;
  let installed = 0;
  for (const name of names) {
    // One unmeasurable tree does not invalidate the others; it just means the
    // total is a floor rather than a ceiling, which is the safe direction.
    const measured = measureTreeBytes(packageInstallDir(prefix, name));
    if (measured !== null) installed += measured;
  }
  if (installed === 0) return MIN_FREE_BYTES;
  return Math.max(MIN_FREE_BYTES, installed + HEADROOM_BYTES);
}

/**
 * Remove the trees npm renamed aside and then failed to delete. A run killed
 * mid-flight (out of disk, timeout) leaves `@scope/.name-XXXXXX` behind, and
 * npm's next attempt tries to rename onto that exact path — which fails with
 * ENOTEMPTY forever, so a single interrupted install permanently blocks every
 * later update until someone deletes it by hand. Only paths matching npm's own
 * pattern for THIS package are touched.
 *
 * Returns the paths removed, for the install log.
 */
export function cleanStaleInstallDirs(prefix: string, packageName: string): string[] {
  const target = packageInstallDir(prefix, packageName);
  const parent = dirname(target);
  const base = packageName.split("/").pop() as string;
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    // npm's rename-aside form: a dot, the package basename, a dash, a suffix.
    if (!entry.startsWith(`.${base}-`)) continue;
    try {
      rmSync(join(parent, entry), { recursive: true, force: true });
      removed.push(join(parent, entry));
    } catch {
      // Reported by the ENOTEMPTY message if it still blocks the install.
    }
  }
  return removed;
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
  required: number = MIN_FREE_BYTES,
): string | null {
  for (const [label, dir] of [["install directory", prefix], ["npm cache", cacheDir]] as const) {
    const space = probe(dir);
    if (!space || space.availableBytes >= required) continue;
    return `Not enough free disk space for the ${label} ${dir}: ${formatBytes(space.availableBytes)} available, about ${formatBytes(required)} needed. Free up space on that filesystem (or raise its quota) and try again.`;
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

/**
 * npm's `--omit=optional` is IGNORED by `npm install -g` (verified against npm
 * 10.9 as a flag, as NPM_CONFIG_OMIT, and through --userconfig: all three
 * installed the platform binary anyway). The platform gate is the lever that
 * does work globally — `--os`/`--cpu` values matching no package's `os`/`cpu`
 * field make npm skip exactly the platform-specific optional dependencies,
 * and nothing else. That is how an adapter that bundles a copy of a CLI Cody
 * already installs stops shipping the second copy.
 */
const SKIP_NATIVE_OPTIONAL_ARGS = ["--os=none", "--cpu=none"];

/** One package-manager invocation of an install job. */
export interface InstallStep {
  spec: string;
  skipNativeOptional?: boolean;
}

/**
 * The invocations one install runs, in order. Each package gets its own,
 * because the flags are per-package: the adapter is installed without its
 * bundled CLI, while the CLI beside it needs precisely the platform binary
 * that flag suppresses.
 */
export function installSteps(request: EngineInstallRequest): InstallStep[] {
  const primary: InstallStep = { spec: request.installSpec, skipNativeOptional: request.skipNativeOptional };
  // uv has no equivalent, and no engine on it needs one.
  if (request.installVia === "uv") return [primary];
  return [primary, ...(request.installAlso ?? []).map((spec) => ({ spec }))];
}

function runInstall(request: EngineInstallRequest): Promise<EngineInstallResult> {
  const prefix = getToolsDir();
  const viaUv = request.installVia === "uv";
  const cacheDir = viaUv ? join(prefix, "uv-cache") : getNpmCacheDir();
  const steps = installSteps(request);
  const packageNames = steps.map((step) => packageNameFromSpec(step.spec));
  const npmCli = viaUv ? null : findNpmCli();
  const command = viaUv ? "uv" : (npmCli ? execPath : "npm");
  // uv installs a Python tool into the same prefix npm uses, so both engines
  // land in one `bin` that engine-bin already searches. --force makes a repeat
  // install an UPDATE rather than a no-op, matching npm's `@latest` behavior.
  const argsFor = (step: InstallStep): string[] => {
    const args = viaUv
      ? ["tool", "install", "--force", step.spec]
      : [
        "install", "-g", "--prefix", prefix,
        ...(step.skipNativeOptional ? SKIP_NATIVE_OPTIONAL_ARGS : []),
        step.spec,
      ];
    return npmCli ? [npmCli, ...args] : args;
  };
  const startedAt = Date.now();
  const job = beginJob(request.id);

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

    // Sweep any tree a previous interrupted run renamed aside: npm would try
    // to rename onto that exact path and fail with ENOTEMPTY every time. uv
    // replaces a tool directory outright, so it has no equivalent leftover.
    // Every package this job installs is swept, not just the first: a leftover
    // under a companion package blocks its update just as permanently.
    const swept = viaUv ? [] : packageNames.flatMap((name) => cleanStaleInstallDirs(prefix, name));
    for (const path of swept) {
      appendJobLog(job, `Removed leftover directory from an interrupted install: ${path}\n`);
    }

    // Preflight: a five-minute download that dies on a full disk teaches the
    // admin nothing. Refuse up front, naming the path and the space left. The
    // requirement covers every package the job installs, since they land on
    // the same filesystem within the same run.
    const spaceProblem = checkInstallDiskSpace(
      prefix,
      cacheDir,
      getDiskSpace,
      requiredFreeBytes(prefix, packageNames),
    );
    if (spaceProblem) {
      appendJobLog(job, `${spaceProblem}\n`);
      const failure = new EngineInstallError(spaceProblem);
      finishJob(job, failure);
      reject(failure);
      return;
    }

    // Env is inherited: the package manager needs HOME, PATH, proxy and
    // registry settings from the container exactly as the operator configured
    // them. uv additionally gets its tool/bin/cache dirs pointed inside Cody's
    // persistent prefix, so a Python engine survives an image update the same
    // way an npm one does.
    const env = viaUv
      ? {
        ...process.env,
        UV_TOOL_DIR: join(prefix, "uv-tools"),
        UV_TOOL_BIN_DIR: join(prefix, "bin"),
        UV_CACHE_DIR: cacheDir,
      }
      : process.env;

    let settled = false;
    const finish = (error: EngineInstallError | null, result?: EngineInstallResult): void => {
      if (settled) return;
      settled = true;
      finishJob(job, error);
      if (error) reject(error);
      else resolve(result as EngineInstallResult);
    };

    /**
     * npm exiting 0 is not proof the engine RUNS. An install interrupted by a
     * full disk can leave a truncated native addon behind that only faults at
     * load time, so the binary is probed before this is called a success —
     * otherwise Cody reports a healthy engine that crashes on every
     * invocation. The engine's own environment rides along, or the probe would
     * verify a different installation than the one a chat turn will run.
     */
    const verify = (stderrTail: string): void => {
      // Everything, not just this engine's own binary. A job installs
      // `installAlso` packages whose bin names Cody does not model here, and a
      // cache HIT never expires — so a companion CLI updated by this very run
      // would keep reporting the version it replaced until the server
      // restarted, and the health probe below would verify a path that no
      // longer exists.
      invalidateEngineBinCache();
      const binary = resolveEngineBin(request.binaryName, request.id.toUpperCase());
      if (!binary) {
        finish(new EngineInstallError(
          `npm installed ${request.installSpec} but no ${request.binaryName} binary appeared in ${prefix}.`,
          stderrTail,
        ));
        return;
      }
      const probeArgs = request.healthArgs ?? request.versionArgs ?? ["--version"];
      void probeEngineVersion(binary, probeArgs, request.engineEnv?.()).then((probe) => {
        if (probe.error) {
          finish(new EngineInstallError(
            `${request.installSpec} installed but ${request.binaryName} does not run — the install is damaged. Reinstall it, or revert to the previous version.`,
            probe.error,
          ));
          return;
        }
        finish(null, { id: request.id, installSpec: request.installSpec, prefix, durationMs: Date.now() - startedAt });
      });
    };

    /**
     * A job that fails on anything but its FIRST package has already replaced
     * the ones before it, so the engine is left running halves from two
     * different installs. npm's own output names only the package that failed,
     * which reads as "nothing happened" — and for a split engine (an ACP
     * adapter plus the CLI it drives) the two are very different states.
     */
    const halfInstalledNote = (index: number): string =>
      index === 0
        ? ""
        : ` ${packageNames.slice(0, index).join(", ")} was already replaced, so this engine is now part-updated: fix the cause and run the update again, or revert it.`;

    /** One package-manager run. Steps are sequential: two npm processes against
     * the same prefix corrupt each other's bin symlinks, which is the very
     * thing the per-engine serialization above exists to prevent. */
    const runStep = (index: number): void => {
      if (index >= steps.length) return;
      const step = steps[index];
      const stepPackage = packageNames[index];
      const commandArgs = argsFor(step);
      appendJobLog(job, `$ ${command} ${commandArgs.join(" ")}\n`);
      const child = spawn(command, commandArgs, { env, stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      }, INSTALL_TIMEOUT_MS);
      const clearTimers = (): void => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
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
        clearTimers();
        finish(new EngineInstallError(`Could not run ${command} to install ${step.spec}${viaUv ? " — is uv installed on this host?" : ""}.${halfInstalledNote(index)}`, String(error)));
      });

      child.on("close", (code, signal) => {
        clearTimers();
        if (settled) return;
        if (timedOut) {
          finish(new EngineInstallError(`Installing ${step.spec} timed out after 5 minutes.${halfInstalledNote(index)}`, tail(stderr)));
          return;
        }
        if (code === 0) {
          // The health probe runs once, after the LAST package: an engine
          // split across two packages is only whole when both are in place.
          if (index === steps.length - 1) verify(tail(stderr));
          else runStep(index + 1);
          return;
        }
        if (/ENOTEMPTY/.test(stderr)) {
          finish(new EngineInstallError(
            `npm could not replace the existing ${stepPackage} install (ENOTEMPTY) — a previous interrupted install left a directory behind. Cody removed what it found; run the update again, and if it still fails delete the leftover \`.\`-prefixed directory under ${dirname(packageInstallDir(prefix, stepPackage))}.${halfInstalledNote(index)}`,
            tail(stderr),
          ));
          return;
        }
        // A disk failure gets named rather than passed through as npm's
        // "Unknown system error -122", which reads like a Cody bug.
        const diskMessage = diskFailureMessage(stderr, prefix, cacheDir);
        if (diskMessage) {
          finish(new EngineInstallError(`${diskMessage}${halfInstalledNote(index)}`, tail(stderr)));
          return;
        }
        const how = signal ? `was killed with ${signal}` : `exited with code ${code}`;
        finish(new EngineInstallError(`Installing ${step.spec} ${how}.${halfInstalledNote(index)}`, tail(stderr)));
      });
    };

    runStep(0);
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
        recordInstallHistory(request.id, request.currentVersion, request.currentEngineVersion ?? null);
      }
      return result;
    })
    .finally(() => {
      inFlight.delete(request.id);
      // Same reasoning as verify(), and it runs on the FAILURE path too: a
      // half-finished job can have replaced the companion and not the primary.
      invalidateEngineBinCache();
    });
  inFlight.set(request.id, pending);
  return pending;
}

/** Ceiling on an `npm uninstall` run — removal is file deletion, not a
 * network operation, so a minute is generous. */
const UNINSTALL_TIMEOUT_MS = 60_000;

/**
 * Remove an engine Cody installed into the persistent tools prefix.
 * Policy lives in the DELETE route (admin, not the active engine, binary
 * actually managed by Cody); this only runs the package manager and drops the
 * binary caches so the next probe sees the removal.
 *
 * The manager has to match the one that INSTALLED it. Running npm against a
 * uv-installed engine is not a loud failure — npm reports nothing to remove
 * and exits 0, so the route answered "uninstalled" while the engine sat
 * untouched on disk and kept running.
 */
export function uninstallEngine(request: {
  id: string;
  packageName: string;
  /** Companion packages the install added beside the primary. Removed in the
   * same npm run — leaving one behind orphans hundreds of megabytes that
   * nothing will ever offer to delete again. */
  alsoPackageNames?: readonly string[];
  binaryName: string;
  installVia?: "npm" | "uv";
}): Promise<void> {
  if (inFlight.has(request.id)) {
    return Promise.reject(new EngineInstallError(`An install of ${request.id} is still running; wait for it to finish.`, ""));
  }
  const prefix = getToolsDir();
  const viaUv = request.installVia === "uv";
  // The same directory overrides the install used, or uv would look for the
  // tool in its default location and find nothing to remove.
  const env = viaUv
    ? {
      ...process.env,
      UV_TOOL_DIR: join(prefix, "uv-tools"),
      UV_TOOL_BIN_DIR: join(prefix, "bin"),
      UV_CACHE_DIR: join(prefix, "uv-cache"),
    }
    : process.env;
  const npmCli = viaUv ? null : findNpmCli();
  const command = viaUv ? "uv" : (npmCli ? execPath : "npm");
  // uv has no companion packages (they are an npm-only mechanism), so its
  // argv stays a single tool name.
  const removing = viaUv ? [request.packageName] : [request.packageName, ...(request.alsoPackageNames ?? [])];
  const commandArgs = viaUv
    ? ["tool", "uninstall", request.packageName]
    : (npmCli
      ? [npmCli, "uninstall", "-g", "--prefix", prefix, ...removing]
      : ["uninstall", "-g", "--prefix", prefix, ...removing]);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, { env, stdio: ["ignore", "ignore", "pipe"] });
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
      reject(new EngineInstallError(`Could not run ${command} to uninstall ${request.packageName}`, String(error)));
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
      reject(new EngineInstallError(`${viaUv ? "uv tool" : "npm"} uninstall ${request.packageName} ${how}`, tail(stderr)));
    });
  });
}

/** Whether an install for this engine is already running (UI/status probes). */
export function isEngineInstalling(id: string): boolean {
  return inFlight.has(id);
}
