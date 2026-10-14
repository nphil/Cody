import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import path from "path";
import { parse, stringify } from "yaml";
import { withClaudeCreditsFallback } from "../claude-credits";
import { isRecord } from "../type-guards";
import { readClaudeCreditsRouting, syncClaudeCreditsProviders } from "./claude-credits";
import { getAgentDir } from "./paths";
import { readNativeSettings } from "./settings-config";

/**
 * The config overlay that puts the Claude API credits first in omp's fallback
 * chains — the third piece of the mechanism in lib/omp/claude-credits.ts.
 *
 * It is a launch-only layer, appended to a chat's `PI_CONFIG_FILES` exactly like
 * a model preset's, so it never touches the user's config.yml. That matters for
 * three reasons: the chains Cody must change are whatever is EFFECTIVE for the
 * chat (config.yml, then its preset), the user's own edits and the Model plan
 * keep working without a hook to re-insert anything, and removing the last key
 * removes the overlay with it — nothing is left behind to un-edit.
 *
 * The file is content-addressed (a changed config yields a new path, which is
 * how a relaunch notices) and bounded: only the newest few are kept, and one is
 * never deleted until it is a week old, because an engine started earlier may
 * still name it.
 */

const OVERLAY_DIRECTORY = "cody-claude-credits";
const VERSION = 1;
const KEEP_NEWEST = 12;
const KEEP_AT_LEAST_MS = 7 * 24 * 60 * 60 * 1000;

function chainsOf(document: unknown): Record<string, unknown> {
  const retry = isRecord(document) ? document.retry : undefined;
  return isRecord(retry) && isRecord(retry.fallbackChains) ? retry.fallbackChains : {};
}

/**
 * `retry.fallbackChains` as omp will see it for a chat whose config layers
 * are `layerFiles`: config.yml first, then each layer in order. omp deep-merges
 * config records key by key; an array replaces the key's array and `null` is a
 * tombstone (what Local-only uses to retire an inherited chain).
 */
export function effectiveFallbackChains(layerFiles: readonly string[]): Record<string, string[]> {
  const chains: Record<string, string[]> = { ...(readNativeSettings().settings.retry?.fallbackChains ?? {}) };
  for (const file of layerFiles) {
    if (!existsSync(file)) continue;
    let layer: unknown;
    try {
      layer = parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(chainsOf(layer))) {
      if (value === null) delete chains[key];
      else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) chains[key] = value as string[];
    }
  }
  return chains;
}

function pruneOverlays(directory: string, keep: string): void {
  try {
    const now = Date.now();
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".yml"))
      .map((name) => ({ file: path.join(directory, name), mtimeMs: statSync(path.join(directory, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { file, mtimeMs } of files.slice(KEEP_NEWEST)) {
      if (file !== keep && now - mtimeMs > KEEP_AT_LEAST_MS) rmSync(file, { force: true });
    }
  } catch {
    // Housekeeping only: a failed sweep never blocks a chat from starting.
  }
}

/**
 * Write (once) and return the overlay for a chat started with `layerFiles`, or
 * null when no key is saved or anything goes wrong — a chat must always be able
 * to start, and without the overlay it simply behaves as it did before.
 */
export function materializeClaudeCreditsOverlay(layerFiles: readonly string[]): string | null {
  try {
    const routing = readClaudeCreditsRouting();
    if (!routing.active) return null;
    // An omp upgrade can ship a Claude model the blocks do not list yet, and a model
    // a block lacks has no credits behind it. Level the blocks with omp's catalog here,
    // where every chat starts, instead of waiting for someone to open Settings. It only
    // writes when something changed, and a failure leaves the blocks as they were.
    try {
      syncClaudeCreditsProviders(routing.providers);
    } catch {
      // A stale model list still backs the models it has; the overlay is worth more than a perfect list.
    }
    const document = { retry: { fallbackChains: withClaudeCreditsFallback(effectiveFallbackChains(layerFiles), routing.providers) } };
    const digest = createHash("sha256").update(JSON.stringify({ version: VERSION, document })).digest("hex");
    const directory = path.join(getAgentDir(), OVERLAY_DIRECTORY);
    const overlayPath = path.join(directory, `${digest}.yml`);
    if (existsSync(overlayPath)) {
      // Reused: refreshed, so a file an engine is still running on never looks old.
      const now = new Date();
      utimesSync(overlayPath, now, now);
    } else {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${overlayPath}.${randomBytes(6).toString("hex")}.tmp`;
      const header = "# Cody: Claude API credits come first in every fallback chain (Settings › Providers › Anthropic).\n";
      writeFileSync(temporary, header + stringify(document), { mode: 0o600 });
      try {
        renameSync(temporary, overlayPath);
      } catch (error) {
        if (!existsSync(overlayPath)) throw error;
      }
      pruneOverlays(directory, overlayPath);
    }
    return overlayPath;
  } catch {
    return null;
  }
}
