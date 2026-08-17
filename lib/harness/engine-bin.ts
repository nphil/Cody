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

export function getEngineVersion(binaryName: string, envSuffix: string): Promise<string | null> {
  const cached = versionCache.get(binaryName);
  if (cached?.version) return Promise.resolve(cached.version);
  if (cached && Date.now() - cached.missAt < MISS_TTL_MS) return Promise.resolve(null);
  const bin = resolveEngineBin(binaryName, envSuffix);
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        versionCache.set(binaryName, { version: null, missAt: Date.now() });
        resolve(null);
        return;
      }
      // "2.1.233 (Claude Code)" / "codex-cli 0.147.0" → first x.y.z-looking token.
      const match = String(stdout).match(/\d+\.\d+[.\w-]*/);
      const version = match ? match[0] : String(stdout).trim() || null;
      versionCache.set(binaryName, { version, missAt: version ? 0 : Date.now() });
      resolve(version);
    });
  });
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
