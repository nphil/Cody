import { listHarnesses } from ".";
import { isNewerVersion } from "../npm-update";
import { probeEngineVersion } from "./engine-bin";
import { type InstallHistoryEntry, packageNameFromSpec, readInstallHistory } from "./install";
import type { HarnessAdapter } from "./types";

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
 *
 * An engine is not always ONE package. Claude Code and Codex are an ACP
 * adapter plus the CLI it drives (HarnessAdapter.engineCli), installed and
 * updated together — so the check compares BOTH against their own registry
 * entries. Comparing only the adapter is not a smaller answer, it is a wrong
 * one: the adapter goes months between releases while the CLI ships most
 * days, so an adapter-only comparison reports a CLI many releases behind as
 * "up to date" and never offers the update that would fix it.
 */

const CHECK_TTL_MS = 10 * 60_000;

/**
 * One half of a two-package engine, as the card shows it. Cody installs an
 * ACP adapter plus the CLI it drives, and until both are named the row can
 * only show one number without saying which package it belongs to.
 */
export interface EngineComponentStatus {
  /** Registry package name — what `latestVersion` was compared against. */
  packageName: string;
  /** Human label from the adapter ("Claude Code CLI"), like `authHint` and
   * `tagline`: engine data, not a translation key. */
  label: string;
  installedVersion: string | null;
  latestVersion: string | null;
  /** Same tri-state as the engine's own: null when either side is unknown. */
  updateAvailable: boolean | null;
}

export interface EngineUpdateStatus {
  id: string;
  /** Version of the package `installSpec` names. For a two-package engine
   * that is the ADAPTER's, which is also what `previousVersion` records and
   * what a revert pins — so it stays the primary number even though it is not
   * the one a user means by the engine's name (that is `engineVersion`). */
  installedVersion: string | null;
  latestVersion: string | null;
  /** true when EITHER half of the engine has a newer published version: the
   * install brings both forward, so an update to either one is an update to
   * the engine. false only when both are known to be current; null when
   * either side is unknown (registry unreachable, version probe failed). */
  updateAvailable: boolean | null;
  /** The number a user means by this engine's name: the engine CLI's for a
   * two-package engine, `installedVersion` otherwise. Null when unreadable. */
  engineVersion: string | null;
  /** Every package this engine is installed from, adapter first, when there
   * is more than one. Empty for a single-package engine — the headline
   * already says everything there is to say. */
  components: EngineComponentStatus[];
  /** Label for the package `verifiedVersion` and `installedVersion` describe
   * ("Claude Code ACP adapter"), so the compat notice cannot be read as a
   * claim about the CLI's unrelated major. Null for single-package engines,
   * where the engine's own name is already the right subject. */
  adapterLabel: string | null;
  /** Version the last successful install replaced — the revert target when
   * an update breaks the engine. Null when no history exists. */
  previousVersion: string | null;
  /** The engine CLI's version at that same moment, for a two-package engine.
   * A revert restores this pin alongside `previousVersion`; the button names
   * it, because it is the number the user recognizes. */
  previousEngineVersion: string | null;
  /** Why the version probe failed, when installedVersion is null: usually a
   * binary that resolves but cannot run. Null whenever the version is known,
   * so a healthy engine never pays for the extra probe. */
  probeError: string | null;
  /** The registry's latest is newer than this Cody build has been verified
   * against — including a patch or minor release — so the card warns before
   * the update instead of after it. */
  latestBeyondVerified: boolean;
  /** The installed binary is already newer than the verified version; the row
   * marks that Cody may not surface everything this engine can do. */
  installedBeyondVerified: boolean;
  /** The exact version this Cody build was audited against (the package
   * installSpec names), shown on the engine card. Null when unmarked. */
  verifiedVersion: string | null;
}

// Lives in ./install (which owns the spec) and is re-exported here because
// this module's importers have always taken it from harness/updates.
export { packageNameFromSpec };

/** A newer semver version is beyond what this Cody build has been verified
 * against. Unknown versions and unmarked engines never warn. */
export function isBeyondVerifiedVersion(
  version: string | null,
  verifiedVersion: string | undefined,
): boolean {
  return Boolean(version && verifiedVersion && isNewerVersion(version, verifiedVersion));
}

const latestCache = new Map<string, { checkedAt: number; version: string | null }>();

/**
 * Latest published version of an engine's package on npm registry.
 */
export async function fetchLatestPackageVersion(
  packageName: string,
  force = false,
): Promise<string | null> {
  const cached = latestCache.get(packageName);
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.version;
  let version: string | null = null;
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    const data = response.ok ? ((await response.json()) as { version?: unknown }) : null;
    version = typeof data?.version === "string" ? data.version : null;
  } catch {
    version = null;
  }
  latestCache.set(packageName, { checkedAt: Date.now(), version });
  return version;
}

/** Tri-state "is there something newer" for one package. */
function comparePackage(installed: string | null, latest: string | null): boolean | null {
  return installed && latest ? isNewerVersion(latest, installed) : null;
}

/**
 * Whether the ENGINE has an update, across every package it is installed
 * from. One install brings all of them forward, so any stale half makes the
 * whole engine stale. Unknown loses to a known "yes" (there really is
 * something to install) but beats a known "no" (claiming "up to date" while
 * half the answer is missing is the lie this whole module exists to avoid).
 */
function combineUpdateAvailability(parts: readonly (boolean | null)[]): boolean | null {
  if (parts.some((part) => part === true)) return true;
  if (parts.some((part) => part === null)) return null;
  return false;
}

/**
 * One engine's update status. Split out from checkEngineUpdates so the
 * two-package arithmetic — which registry each half is asked about, when a
 * stale half makes the whole engine stale, when a revert is still on offer —
 * can be exercised against a stub adapter instead of whatever happens to be
 * installed on the machine running the tests.
 */
export async function engineUpdateStatus(
  adapter: HarnessAdapter,
  history: Record<string, InstallHistoryEntry>,
  force = false,
): Promise<EngineUpdateStatus> {
  const cli = adapter.engineCli ?? null;
  const [installedVersion, latestVersion, cliInstalled, cliLatest] = await Promise.all([
    adapter.getVersion(),
    fetchLatestPackageVersion(packageNameFromSpec(adapter.installSpec as string), force),
    // The second half of a split engine. Both probes are npm packages on
    // the same registry, so they run together rather than one after the
    // other — the CLI probe spawns a real CLI and is the slow one.
    cli ? cli.getVersion() : Promise.resolve(null),
    cli ? fetchLatestPackageVersion(cli.packageName, force) : Promise.resolve(null),
  ]);
  const entry = history[adapter.id];
  const previous = entry?.previousVersion ?? null;
  const previousEngine = entry?.previousEngineVersion ?? null;
  const revertsSomething = previous !== null
    && (previous !== installedVersion
      || (cli !== null && previousEngine !== null && previousEngine !== cliInstalled));
  const adapterUpdate = comparePackage(installedVersion, latestVersion);
  const cliUpdate = cli ? comparePackage(cliInstalled, cliLatest) : undefined;
  // Only the broken case pays for a second spawn, and it is the only case
  // with something to explain: a version in hand already says the binary
  // runs.
  const binary = installedVersion === null ? adapter.resolveBinary() : null;
  return {
    id: adapter.id,
    installedVersion,
    latestVersion,
    updateAvailable: combineUpdateAvailability(
      cli ? [adapterUpdate, cliUpdate as boolean | null] : [adapterUpdate],
    ),
    engineVersion: cli ? cliInstalled : installedVersion,
    components: cli
      ? [
        {
          packageName: packageNameFromSpec(adapter.installSpec as string),
          label: cli.adapterLabel,
          installedVersion,
          latestVersion,
          updateAvailable: adapterUpdate,
        },
        {
          packageName: cli.packageName,
          label: cli.label,
          installedVersion: cliInstalled,
          latestVersion: cliLatest,
          updateAvailable: cliUpdate as boolean | null,
        },
      ]
      : [],
    adapterLabel: cli ? cli.adapterLabel : null,
    // Offering a "revert" to the version already running is noise — but
    // for a two-package engine "already running" means BOTH halves match.
    // The adapter goes months between releases while the CLI ships most
    // days, so the common update moves only the CLI and leaves the adapter
    // version identical; comparing that half alone would hide the revert
    // for precisely the updates that produce one.
    previousVersion: revertsSomething ? previous : null,
    previousEngineVersion: revertsSomething ? previousEngine : null,
    probeError: binary ? (await probeEngineVersion(binary, adapter.versionArgs)).error : null,
    latestBeyondVerified: isBeyondVerifiedVersion(latestVersion, adapter.verifiedVersion),
    installedBeyondVerified: isBeyondVerifiedVersion(installedVersion, adapter.verifiedVersion),
    verifiedVersion: adapter.verifiedVersion ?? null,
  };
}

/** Update status for every installed, installable engine. */
export async function checkEngineUpdates(force = false): Promise<EngineUpdateStatus[]> {
  const adapters = listHarnesses().filter(
    (adapter) => adapter.installSpec && adapter.resolveBinary() !== null,
  );
  const history = readInstallHistory();
  return Promise.all(adapters.map((adapter) => engineUpdateStatus(adapter, history, force)));
}
