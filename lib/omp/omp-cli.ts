import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";
import { readEnv } from "../env";
import { getAgentDir } from "./paths";

/**
 * Locating and probing the user's installed `omp` CLI. Cody never embeds
 * the (Bun-only) @oh-my-pi SDK — every live-agent capability goes through the
 * omp binary, so its absence is a first-class, user-visible state.
 */

let cachedBin: string | null = null;
let binMissAt = 0;
let cachedVersion: string | null = null;
let versionMissAt = 0;

const BIN_NAME = process.platform === "win32" ? "omp.exe" : "omp";
// Only successes are cached for the process lifetime. omp may be installed (or
// PATH repaired) while the server runs; a permanently cached "not found" would
// keep the UI reporting a missing binary until restart.
const MISS_TTL_MS = 30_000;

/**
 * What every caller says when the binary is absent. The remedy has to be the
 * one Cody actually offers: engines install from the onboarding picker and
 * Settings › System › Engines into the tools prefix. Telling a new user to
 * "install oh-my-pi or set CODY_OMP_BIN" sent them to a package manager and
 * an environment variable for a button that is two clicks away — it surfaced
 * verbatim in the setup wizard's last step on a fresh install.
 */
export const OMP_BIN_MISSING = "OMP is not installed. Install it from Settings → System → Engines (or point CODY_OMP_BIN at an existing binary).";

/** True when an Error's message is Cody's own missing-omp-binary state
 * (`OMP_BIN_MISSING`), regardless of any prefix/suffix a caller added.
 * Callers match on this instead of a hardcoded string so the check can
 * never drift from the constant it is testing for. */
export function isOmpBinMissing(message: string): boolean {
  return message.includes(OMP_BIN_MISSING);
}

/** Clear probes after an explicit `omp update` so the next request rechecks it. */
export function invalidateOmpCliCache(): void {
  cachedBin = null;
  binMissAt = 0;
  cachedVersion = null;
  versionMissAt = 0;
}

function probeOmpBin(): string | null {
  const override = readEnv("OMP_BIN");
  if (override) return existsSync(override) ? override : null;
  // Cody's persistent tools prefix first: an omp installed from the engine
  // picker must win over any stale copy elsewhere on PATH. Computed inline
  // (mirrors lib/harness/engine-bin getToolsDir) to keep lib/omp free of a
  // lib/harness import cycle.
  const toolsCandidate = join(readEnv("TOOLS_DIR") ?? join(getAgentDir(), "tools"), "bin", BIN_NAME);
  if (existsSync(toolsCandidate)) return toolsCandidate;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, BIN_NAME);
    if (existsSync(candidate)) return candidate;
  }
  // GUI-launched processes often miss homebrew/bun dirs in PATH; probe the
  // usual install locations before giving up.
  const fallbackDirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".local", "bin"),
  ];
  for (const dir of fallbackDirs) {
    const candidate = join(dir, BIN_NAME);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve the omp binary: CODY_OMP_BIN override, then PATH lookup. Returns
 * null when omp is not installed. A hit is cached for the process lifetime; a
 * miss is re-probed after MISS_TTL_MS. */
export function resolveOmpBin(): string | null {
  if (cachedBin) return cachedBin;
  if (Date.now() - binMissAt < MISS_TTL_MS) return null;
  const found = probeOmpBin();
  if (found) {
    cachedBin = found;
    binMissAt = 0;
    return found;
  }
  binMissAt = Date.now();
  return null;
}

/** Strip a leading binary-name prefix (`omp/17.3.7` → `17.3.7`) from a version
 * string. `omp --version` is the only probe in the engine set that prefixes its
 * output, and the shape has to be normalized at the source: everything
 * downstream compares versions as semver. */
export function stripVersionPrefix(version: string): string {
  const trimmed = version.trim();
  const slash = trimmed.indexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
}

/** Bare semver of the installed omp (e.g. "17.3.7"), or null when unavailable.
 * `omp --version` prints "omp/17.3.7"; the prefix is stripped here so the
 * harness layer can compare the value as semver against the npm registry.
 * Cached after the first successful probe; failures are retried after
 * MISS_TTL_MS so a later install is picked up without a server restart. */
export async function getOmpVersion(): Promise<string | null> {
  if (cachedVersion) return cachedVersion;
  if (Date.now() - versionMissAt < MISS_TTL_MS) return null;
  const bin = resolveOmpBin();
  if (!bin) {
    versionMissAt = Date.now();
    return null;
  }
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(bin, ["--version"], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    const version = stripVersionPrefix(output);
    if (version) {
      cachedVersion = version;
      versionMissAt = 0;
      return version;
    }
  } catch {
    // Fall through to the miss path: retry after the TTL.
  }
  versionMissAt = Date.now();
  return null;
}

/** `version` as [major, minor, patch], or null when it holds no semver. */
function semverParts(version: string | null | undefined): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether `version` (bare semver, or null when unreadable) is at least `min`.
 * An unreadable version is NOT at least anything, so a gate that asks "does
 * this engine have it?" stays closed; one that asks "does it lack it?" uses
 * `versionBelow`, which is just as false for an unreadable version.
 */
export function versionAtLeast(version: string | null | undefined, min: readonly [number, number, number]): boolean {
  const parts = semverParts(version);
  if (!parts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== min[index]) return parts[index] > min[index];
  }
  return true;
}

/** Whether `version` is a readable release OLDER than `release`; false when it cannot be read. */
export function versionBelow(version: string | null | undefined, release: readonly [number, number, number]): boolean {
  return semverParts(version) !== null && !versionAtLeast(version, release);
}
