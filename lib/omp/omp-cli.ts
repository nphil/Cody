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
