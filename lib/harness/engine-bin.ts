import { execFile } from "child_process";
import { existsSync } from "fs";
import { delimiter, join } from "path";
import { readEnv } from "../env";
import { getAgentDir } from "../omp/paths";

/**
 * Binary resolution for installable engines (claude, codex, …). Mirrors the
 * omp probe (lib/omp/omp-cli.ts) with one addition: Cody's own tools prefix
 * is checked before PATH, because engines the user installs from the picker
 * land there — a persistent /data location that survives image updates,
 * unlike the image's global node_modules.
 *
 * Order: CODY_<NAME>_BIN env override → <toolsDir>/bin/<name> → PATH scan.
 * Only successes are cached; misses retry after a short TTL so an install
 * that just finished is picked up without a server restart.
 */

const MISS_TTL_MS = 30_000;
/** Ceiling on a --version probe. A healthy CLI answers in well under a
 * second; settings must not hang on one that never returns. */
const VERSION_TIMEOUT_MS = 10_000;
/** How much of a failed probe's output is kept. Long enough to carry the
 * binary's own diagnostic into an API response and the settings UI, short
 * enough that a stack trace cannot flood either. */
const PROBE_ERROR_LIMIT = 400;

const binCache = new Map<string, { path: string | null; missAt: number }>();
const versionCache = new Map<string, { version: string | null; missAt: number }>();

/** Persistent prefix for engines Cody installs itself. */
export function getToolsDir(): string {
  return readEnv("TOOLS_DIR") ?? join(getAgentDir(), "tools");
}

function probe(binaryName: string, envSuffix: string): string | null {
  const override = readEnv(`${envSuffix}_BIN`);
  if (override) return existsSync(override) ? override : null;
  const name = process.platform === "win32" ? `${binaryName}.cmd` : binaryName;
  const toolsCandidate = join(getToolsDir(), "bin", name);
  if (existsSync(toolsCandidate)) return toolsCandidate;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** @param envSuffix Env-var stem: "CLAUDE" resolves CODY_CLAUDE_BIN. */
export function resolveEngineBin(binaryName: string, envSuffix: string): string | null {
  const cached = binCache.get(binaryName);
  if (cached?.path) return cached.path;
  if (cached && Date.now() - cached.missAt < MISS_TTL_MS) return null;
  const found = probe(binaryName, envSuffix);
  binCache.set(binaryName, { path: found, missAt: found ? 0 : Date.now() });
  return found;
}

/** First x.y.z-looking token of a --version line: "2.1.233 (Claude Code)",
 * "codex-cli 0.147.0" and "omp/17.3.7" all reduce to bare semver. */
function matchVersion(output: string): string | null {
  const match = output.match(/\d+\.\d+[.\w-]*/);
  return match ? match[0] : null;
}

export function getEngineVersion(binaryName: string, envSuffix: string): Promise<string | null> {
  const cached = versionCache.get(binaryName);
  if (cached?.version) return Promise.resolve(cached.version);
  if (cached && Date.now() - cached.missAt < MISS_TTL_MS) return Promise.resolve(null);
  const bin = resolveEngineBin(binaryName, envSuffix);
  if (!bin) return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile(bin, ["--version"], { timeout: VERSION_TIMEOUT_MS }, (error, stdout, stderr) => {
    if (error) {
      versionCache.set(binaryName, { version: null, missAt: Date.now() });
      resolve(null);
      return;
    }
    // pi prints its version to stderr; the clean exit above is what proves
    // the binary ran, so on success either stream may carry the number.
    const version = matchVersion(String(stdout)) ?? matchVersion(String(stderr)) ?? (String(stdout).trim() || null);
    versionCache.set(binaryName, { version, missAt: version ? 0 : Date.now() });
    resolve(version);
  });
  return promise;
}

/** Why a probe came back empty, in the order most likely to name the real
 * cause: the binary's stderr, then its stdout, then the spawn failure. */
function probeFailureText(stderr: string, stdout: string, error: Error | null): string {
  const text = [stderr, stdout, error?.message ?? ""]
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!text) return "The version probe produced no output.";
  return text.length <= PROBE_ERROR_LIMIT ? text : `…${text.slice(-PROBE_ERROR_LIMIT)}`;
}

/**
 * Probe one already-resolved binary and say why when it fails.
 * getEngineVersion answers the everyday "which version is installed" and
 * caches it; this is its diagnostic twin, used right after an install and by
 * the update check, so it takes a path, skips the cache and keeps the
 * binary's own words. npm silently skips a platform-native optional
 * dependency it cannot resolve, which leaves an install that exited 0 behind
 * a CLI that fails on every invocation — that stderr line is the only thing
 * that makes the failure actionable. Never rejects.
 */
export function probeEngineVersion(
  binaryPath: string,
): Promise<{ version: string | null; error: string | null }> {
  const { promise, resolve } = Promise.withResolvers<{ version: string | null; error: string | null }>();
  execFile(binaryPath, ["--version"], { timeout: VERSION_TIMEOUT_MS }, (error, stdout, stderr) => {
    const out = String(stdout ?? "");
    const err = String(stderr ?? "");
    // Exit status decides whether the binary ran: a failing CLI that names a
    // package version in its diagnostic must not have that number read back
    // as the installed version. On a clean exit either stream may carry it —
    // pi versions to stderr, omp/claude/codex to stdout.
    if (!error) {
      const version = matchVersion(out) ?? matchVersion(err) ?? (out.trim() || null);
      if (version) {
        resolve({ version, error: null });
        return;
      }
    }
    resolve({ version: null, error: probeFailureText(err, out, error) });
  });
  return promise;
}

/** Clear probes after an install so the next request sees the new binary. */
export function invalidateEngineBinCache(binaryName?: string): void {
  if (binaryName) {
    binCache.delete(binaryName);
    versionCache.delete(binaryName);
  } else {
    binCache.clear();
    versionCache.clear();
  }
}
