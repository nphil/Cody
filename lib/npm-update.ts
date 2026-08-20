import packageJson from "../package.json";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, normalize, sep } from "path";
import { readEnv } from "./env";

const NPM_PACKAGE = "@nphil/cody";
const CONTAINER_IMAGE = "ghcr.io/nphil/cody:latest";
const GITHUB_RELEASES_URL = "https://api.github.com/repos/nphil/Cody/releases/latest";
/** Docker writes this marker into every container it builds. */
const CONTAINER_MARKER = "/.dockerenv";
const CHECK_TTL_MS = 60 * 60 * 1000;

export interface NpmUpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
  /** Which channel actually ships to this deployment, so the card can name
   * the one update path that works here instead of assuming a CLI install. */
  managedBy: "docker" | "npm" | "bun";
}

let cached: { checkedAt: number; status: NpmUpdateStatus } | null = null;

function parseVersion(version: string): { parts: number[]; prerelease: boolean } | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) };
}

export function isNewerVersion(availableVersion: string, currentVersion: string): boolean {
  const available = parseVersion(availableVersion);
  const current = parseVersion(currentVersion);
  if (!available || !current) return false;

  for (let index = 0; index < available.parts.length; index += 1) {
    if (available.parts[index] !== current.parts[index]) {
      return available.parts[index] > current.parts[index];
    }
  }
  return !available.prerelease && current.prerelease;
}

/** The npm registry publishes the CLI install; the GitHub releases feed
 * publishes the container image. Each deployment has to be compared against
 * the channel that ships to it, or the card reports a version nobody here
 * can install (the image build is not on npm at all). */
async function fetchLatestVersion(managedBy: NpmUpdateStatus["managedBy"]): Promise<string | null> {
  const signal = AbortSignal.timeout(5_000);
  if (managedBy === "docker") {
    const response = await fetch(GITHUB_RELEASES_URL, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
      signal,
    });
    const data = response.ok ? await response.json() as { tag_name?: unknown } : null;
    // Release tags are shaped `v0.9.0`; the bare semver is what compares.
    const tag = typeof data?.tag_name === "string" ? data.tag_name.replace(/^v/, "") : "";
    return tag || null;
  }

  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`, {
    cache: "no-store",
    signal,
  });
  const data = response.ok ? await response.json() as { version?: unknown } : null;
  return typeof data?.version === "string" ? data.version : null;
}

/** `markerPath` is a test seam: production callers omit it and get the real
 * container marker. */
export async function checkNpmUpdate(force = false, markerPath?: string): Promise<NpmUpdateStatus> {
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.status;

  const currentVersion = packageJson.version;
  const managedBy: NpmUpdateStatus["managedBy"] = detectContainerDeployment(markerPath)
    ? "docker"
    : detectInstallMethod(readEnv("PACKAGE_DIR") ?? process.cwd());
  const updateCommand = managedBy === "docker"
    ? `docker pull ${CONTAINER_IMAGE}`
    : managedBy === "bun"
      ? `bun add -g ${NPM_PACKAGE}`
      : `npm install -g ${NPM_PACKAGE}`;

  try {
    const availableVersion = await fetchLatestVersion(managedBy);
    const status: NpmUpdateStatus = {
      currentVersion,
      availableVersion,
      updateAvailable: Boolean(availableVersion && isNewerVersion(availableVersion, currentVersion)),
      updateCommand,
      managedBy,
    };
    cached = { checkedAt: Date.now(), status };
    return status;
  } catch {
    return { currentVersion, availableVersion: null, updateAvailable: false, updateCommand, managedBy };
  }
}

/** Whether this instance runs from a container image, which is updated by
 * pulling the image again rather than through a package manager. The marker
 * path is injectable so tests can drive both branches without writing to the
 * filesystem root. */
export function detectContainerDeployment(markerPath: string = CONTAINER_MARKER): boolean {
  return existsSync(markerPath);
}

/** Which package manager owns a given install dir, so updates always run
 * through the manager that manages it (bun global root, npm global root,
 * anything else → npm as the fallback). Separators are normalized so the
 * classification is deterministic even when a Windows-style path is passed
 * on a POSIX host (e.g. in CI tests). */
export function detectInstallMethod(packageDir: string): "bun" | "npm" {
  const toPlatformPath = (value: string): string => normalize(value).replaceAll("\\", sep);
  const normalized = toPlatformPath(packageDir);
  const bunRoots = [
    // bun 1.3.x globals on Windows live in ~/node_modules; POSIX uses the
    // standard ~/.bun/install/global/node_modules.
    join(process.env.USERPROFILE ?? process.env.HOME ?? "", "node_modules"),
    join(homedir(), ".bun", "install", "global", "node_modules"),
  ].map(toPlatformPath);
  return bunRoots.some((root) => normalized.startsWith(root + sep)) ? "bun" : "npm";
}

