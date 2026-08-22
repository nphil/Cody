import { statfsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { formatBytes } from "./format-bytes";

/**
 * Free-space probing for the paths Cody writes to.
 *
 * The motivating failure: an engine update died five minutes in with
 * `npm error errno -122 ... open '/data/home/.npm/_cacache/tmp/…'`. errno 122
 * is EDQUOT — the ZFS dataset holding the instance data dir was at its quota —
 * but libuv has no name for it, so npm printed "Unknown system error -122" and
 * the admin had nothing to act on. A cheap preflight turns that into a
 * sentence naming the full path and the bytes remaining, BEFORE the download.
 */

export { formatBytes };

export interface DiskSpace {
  /** Bytes usable by this (unprivileged) process, not raw free blocks. */
  availableBytes: number;
  totalBytes: number;
}

/** Free space for the filesystem holding `dir`, or null when it cannot be
 * read (unsupported platform, vanished path). A null result must never block
 * an operation — unknown space is not the same as no space. */
export function getDiskSpace(dir: string): DiskSpace | null {
  try {
    const stats = statfsSync(dir);
    // bavail is what a non-root process may actually use; bfree includes the
    // reserved blocks root can dip into, and would overstate the headroom.
    return {
      availableBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return null;
  }
}

/** Where npm will write its cache for a child that inherits this environment:
 * an explicit `npm_config_cache`, else `$HOME/.npm` (npm's own default). The
 * cache and the install prefix are frequently on DIFFERENT filesystems, and
 * the cache is the one that filled up here, so both get probed. */
export function getNpmCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.npm_config_cache?.trim();
  if (configured) return configured;
  const home = env.HOME?.trim() || homedir();
  return join(home, process.platform === "win32" ? "npm-cache" : ".npm");
}


/**
 * Disk errors, named. Node surfaces EDQUOT as the unnamed "Unknown system
 * error -122" (and -69 on macOS), so matching the numeric errno matters as
 * much as matching the text — that unnamed form is exactly what made the
 * original report unreadable.
 */
export function describeDiskError(text: string): "quota" | "full" | null {
  if (!text) return null;
  // Linux EDQUOT=122, macOS EDQUOT=69. Match the errno shapes npm/libuv print.
  if (/\bEDQUOT\b|quota exceeded/i.test(text)) return "quota";
  if (/(?:errno|error)\s*-(?:122|69)\b|system error -(?:122|69)\b/i.test(text)) return "quota";
  if (/\bENOSPC\b|no space left on device/i.test(text)) return "full";
  return null;
}
