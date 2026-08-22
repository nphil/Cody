import { listHarnesses } from ".";
import { isNewerVersion } from "../npm-update";
import { probeEngineVersion } from "./engine-bin";
import { readInstallHistory } from "./install";

/**
 * Update checks for installable engines: the npm registry's latest version
 * vs the installed binary's. The Settings engine card shows an Update button
 * only when this reports one — an ever-present "Update" reads as "an update
 * exists", which is a lie most of the time.
 *
 * When the installed version cannot be read at all the card has nothing to
 * compare and no story to tell, so the status also carries probeError: the
 * binary's own explanation of why it will not run. That is what turns
 * "Version unavailable" into a diagnosis the user can act on.
 */

const CHECK_TTL_MS = 10 * 60_000;

export interface EngineUpdateStatus {
  id: string;
  installedVersion: string | null;
  latestVersion: string | null;
  /** true/false when both versions are known; null when either side is not
   * (registry unreachable, or the binary's version probe failed). */
  updateAvailable: boolean | null;
  /** Version the last successful install replaced — the revert target when
   * an update breaks the engine. Null when no history exists. */
  previousVersion: string | null;
  /** Why the version probe failed, when installedVersion is null: usually a
   * binary that resolves but cannot run. Null whenever the version is known,
   * so a healthy engine never pays for the extra probe. */
  probeError: string | null;
  /** The registry's latest is a bigger major than this Cody build has been
   * exercised against (adapter.verifiedMajor) — the update card warns before
   * the jump instead of after it. */
  latestBeyondVerified: boolean;
  /** The installed binary is already past the verified major — the row keeps
   * a visible marker that Cody may not surface everything this engine can do. */
  installedBeyondVerified: boolean;
}

/** "@oh-my-pi/pi-coding-agent@latest" → "@oh-my-pi/pi-coding-agent". */
export function packageNameFromSpec(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Leading major out of "18.0.0" / "v18.0.0"; null when unparseable. */
export function majorVersionOf(version: string | null): number | null {
  const match = version?.match(/^v?(\d+)[.\-+]/) ?? version?.match(/^v?(\d+)$/);
  return match ? Number(match[1]) : null;
}

/** Whether a version has crossed past the newest major this Cody build was
 * verified against. Unknown versions and unmarked adapters never warn — the
 * notice exists for a provable jump, not as ambient anxiety. */
export function isBeyondVerifiedMajor(
  version: string | null,
  verifiedMajor: number | undefined,
): boolean {
  if (verifiedMajor === undefined) return false;
  const major = majorVersionOf(version);
  return major !== null && major > verifiedMajor;
}

const latestCache = new Map<string, { checkedAt: number; version: string | null }>();

export async function fetchLatestPackageVersion(packageName: string, force = false): Promise<string | null> {
  const cached = latestCache.get(packageName);
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.version;
  let version: string | null = null;
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const data = response.ok ? ((await response.json()) as { version?: unknown }) : null;
    version = typeof data?.version === "string" ? data.version : null;
  } catch {
    version = null;
  }
  // A failed probe is cached too: settings opening repeatedly while offline
  // should not hammer the registry timeout on every render.
  latestCache.set(packageName, { checkedAt: Date.now(), version });
  return version;
}

/** Update status for every installed, installable engine. */
export async function checkEngineUpdates(force = false): Promise<EngineUpdateStatus[]> {
  const adapters = listHarnesses().filter(
    (adapter) => adapter.installSpec && adapter.resolveBinary() !== null,
  );
  const history = readInstallHistory();
  return Promise.all(
    adapters.map(async (adapter) => {
      const [installedVersion, latestVersion] = await Promise.all([
        adapter.getVersion(),
        fetchLatestPackageVersion(packageNameFromSpec(adapter.installSpec as string), force),
      ]);
      const previous = history[adapter.id]?.previousVersion ?? null;
      // Only the broken case pays for a second spawn, and it is the only case
      // with something to explain: a version in hand already says the binary
      // runs.
      const binary = installedVersion === null ? adapter.resolveBinary() : null;
      return {
        id: adapter.id,
        installedVersion,
        latestVersion,
        updateAvailable:
          installedVersion && latestVersion ? isNewerVersion(latestVersion, installedVersion) : null,
        // Offering a "revert" to the version already running is noise.
        previousVersion: previous && previous !== installedVersion ? previous : null,
        probeError: binary ? (await probeEngineVersion(binary)).error : null,
        latestBeyondVerified: isBeyondVerifiedMajor(latestVersion, adapter.verifiedMajor),
        installedBeyondVerified: isBeyondVerifiedMajor(installedVersion, adapter.verifiedMajor),
      };
    }),
  );
}
