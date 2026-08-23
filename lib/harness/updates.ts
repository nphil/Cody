import { listHarnesses } from ".";
import { isNewerVersion } from "../npm-update";
import { probeEngineVersion } from "./engine-bin";
import { packageNameFromSpec, readInstallHistory } from "./install";

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

// Lives in ./install (which owns the spec) and is re-exported here because
// this module's importers have always taken it from `harness/updates`.
export { packageNameFromSpec };

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

/** "hermes-agent[acp]" → "hermes-agent". A PyPI spec may carry extras (and a
 * pin), neither of which belongs in a registry lookup. */
export function pypiNameFromSpec(spec: string): string {
  return spec.split(/[[=<>!~ ]/)[0].trim();
}

/**
 * Latest published version of an engine's package. The registry follows the
 * ecosystem: npm engines are on registry.npmjs.org, uv engines are Python
 * packages on PyPI. Asking npm for a PyPI package simply 404s, which would
 * quietly report "no update available" forever.
 */
export async function fetchLatestPackageVersion(
  packageName: string,
  force = false,
  via: "npm" | "uv" = "npm",
): Promise<string | null> {
  const key = `${via}:${packageName}`;
  const cached = latestCache.get(key);
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.version;
  let version: string | null = null;
  try {
    const url = via === "uv"
      ? `https://pypi.org/pypi/${encodeURIComponent(pypiNameFromSpec(packageName))}/json`
      : `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    const data = response.ok ? ((await response.json()) as { version?: unknown; info?: { version?: unknown } }) : null;
    // npm answers with the manifest directly; PyPI nests it under `info`.
    const raw = via === "uv" ? data?.info?.version : data?.version;
    version = typeof raw === "string" ? raw : null;
  } catch {
    version = null;
  }
  // A failed probe is cached too: settings opening repeatedly while offline
  // should not hammer the registry timeout on every render.
  latestCache.set(key, { checkedAt: Date.now(), version });
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
        fetchLatestPackageVersion(
          adapter.installVia === "uv"
            ? (adapter.installSpec as string)
            : packageNameFromSpec(adapter.installSpec as string),
          force,
          adapter.installVia ?? "npm",
        ),
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
        probeError: binary ? (await probeEngineVersion(binary, adapter.versionArgs)).error : null,
        latestBeyondVerified: isBeyondVerifiedMajor(latestVersion, adapter.verifiedMajor),
        installedBeyondVerified: isBeyondVerifiedMajor(installedVersion, adapter.verifiedMajor),
      };
    }),
  );
}
