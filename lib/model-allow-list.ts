/**
 * Helpers for OMP's native `enabledModels` allow-list.
 *
 * A single provider can dominate the registry: an OpenRouter key alone
 * contributed 466 of 502 models on a real install, and every one of them landed
 * in the Composer picker AND in each of the ten role selects, which render one
 * `<option>` per model per role.
 *
 * Cody deliberately does NOT apply the allow-list itself. OMP already filters
 * `get_available_models` by `enabledModels` (session/model-controls.ts), and the
 * entries are GLOB patterns matched against `provider/modelId` and bare ids
 * (config/model-resolver.ts) — reimplementing that here would mean two
 * dialects of the same setting, and Cody's would be wrong for any pattern the
 * user wrote by hand. So every model-bearing response Cody receives is already
 * the effective set, and these helpers only describe and edit the setting.
 *
 * The one piece of that dialect Cody must know, because it writes patterns of
 * its own: OMP matches with `Bun.Glob`, whose `*` stops at `/` while `**`
 * crosses it. Many providers' ids contain a slash (OpenRouter's are all
 * `vendor/model`, Workers AI's start with `@cf/`), so `provider/*` silently
 * matches NONE of them while `provider/**` matches every model the provider
 * offers now or later. Cody therefore writes the `**` form, and reads either
 * form as "the whole provider" since that is plainly what a hand-written
 * `provider/*` meant.
 */

/** An empty allow-list means "no restriction" — OMP's own reading of the
 *  setting, and why enabling the restriction must seed a concrete set rather
 *  than persisting `[]`, which would silently allow everything. */
export function allowListActive(enabledModels: readonly string[] | undefined): boolean {
  return (enabledModels?.length ?? 0) > 0;
}

/** The `provider/id` form the setting is written in and OMP matches against. */
export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * The pattern that keeps a provider fully open, including models it releases
 * after the list was written. `**` rather than `*` — see the header: `*` would
 * miss every id containing a slash.
 */
export function providerGlob(provider: string): string {
  return `${provider}/**`;
}

// A whole-provider glob: one plain provider segment (no wildcards), then `/*`
// or `/**`, nothing after. `provider/vendor/*` is a pattern that belongs to
// `provider` but does not open the whole provider; `provider/*:high` carries a
// thinking suffix Cody does not parse, so it is not recognised either.
const PROVIDER_GLOB = /^[^/*?[]+\/\*{1,2}$/;

/** True exactly for `<provider>/*` and `<provider>/**`. */
export function isProviderGlob(entry: string): boolean {
  return PROVIDER_GLOB.test(entry);
}

/**
 * The provider an entry belongs to: the FIRST path segment only, matching the
 * prefix check `replaceProviderSelection` has always used. `openrouter/vendor/m`
 * belongs to `openrouter`, never to `vendor`. Null for a bare id (no slash),
 * which OMP matches against every provider's ids.
 */
export function providerOfEntry(entry: string): string | null {
  const slash = entry.indexOf("/");
  return slash > 0 ? entry.slice(0, slash) : null;
}

export type CurationMode = "all" | "exact" | "none";

/**
 * How one provider is represented in an active allow-list: "all" when its
 * whole-provider glob is present, "exact" when it is pinned to specific
 * entries, "none" when nothing in the list belongs to it.
 */
export function curationModeFor(enabledModels: readonly string[], provider: string): CurationMode {
  let mode: CurationMode = "none";
  for (const entry of enabledModels) {
    if (providerOfEntry(entry) !== provider) continue;
    if (isProviderGlob(entry)) return "all";
    mode = "exact";
  }
  return mode;
}

export interface ProviderCuration {
  provider: string;
  /** Models the provider offers when nothing is restricted. */
  total: number;
  /** Models actually reaching sessions right now. */
  enabled: number;
  /** "unrestricted" while the allow-list is inactive; otherwise how the list
   *  represents this provider (see `curationModeFor`). */
  mode: CurationMode | "unrestricted";
}

/**
 * Per-provider `enabled of total`, for the curation summary rows. This is what
 * lets the settings panel show one row per provider instead of a checkbox per
 * model — the difference between 4 rows and 502.
 *
 * `allowed` is the effective, already-filtered list, so the enabled count is
 * correct for glob entries without Cody matching a single pattern itself.
 * Providers appear if they exist in either list: one whose every model is
 * de-selected still needs a row, or it would silently vanish from the panel.
 *
 * `enabledModels` is the raw setting; it only decides each row's `mode`. The
 * counts still come from the effective list, so a hand-written pattern that
 * matches nothing shows up honestly as "all" with 0 enabled.
 */
export function summarizeProviderCuration(
  fullCatalog: readonly { provider: string; id: string }[],
  allowed: readonly { provider: string; id: string }[],
  enabledModels?: readonly string[],
): ProviderCuration[] {
  const byProvider = new Map<string, { provider: string; total: number; enabled: number }>();
  for (const model of fullCatalog) {
    const entry = byProvider.get(model.provider) ?? { provider: model.provider, total: 0, enabled: 0 };
    entry.total += 1;
    byProvider.set(model.provider, entry);
  }
  for (const model of allowed) {
    const entry = byProvider.get(model.provider) ?? { provider: model.provider, total: 0, enabled: 0 };
    entry.enabled += 1;
    // An allowed model missing from the catalog read still implies its provider
    // offers at least that one, so the row never reads "0 of 0" while a model
    // from it is in use.
    if (entry.enabled > entry.total) entry.total = entry.enabled;
    byProvider.set(model.provider, entry);
  }
  const active = allowListActive(enabledModels);
  return [...byProvider.values()]
    .sort((a, b) => b.total - a.total || a.provider.localeCompare(b.provider))
    .map((row) => ({
      ...row,
      mode: active ? curationModeFor(enabledModels as readonly string[], row.provider) : "unrestricted",
    }));
}

export interface SeedAllowListOptions {
  /** Providers to seed as whole-provider globs rather than exact keys, so they
   *  stay open to models released after the restriction was switched on. */
  providerGlobs?: readonly string[];
}

/**
 * The allow-list to persist when the restriction is switched on.
 *
 * Deliberately NOT every model: seeding the full catalog is what made enabling
 * the restriction write hundreds of OpenRouter entries into config.yml and then
 * demand hundreds of un-checks. Seeding only what is already in use means
 * "restrict" starts from the working set and everything else is opt-in.
 *
 * With `providerGlobs`, those providers are seeded as globs (first, in the
 * given order) and their in-use exact keys are dropped as redundant; in-use
 * keys from every other provider are kept as exact entries. Without options the
 * behaviour is the original exact-keys-only seed.
 */
export function seedAllowList(
  inUse: readonly (string | null | undefined)[],
  fallback: readonly { provider: string; id: string }[] = [],
  options: SeedAllowListOptions = {},
): string[] {
  const seeded = new Set<string>();
  const globbed = new Set<string>(options.providerGlobs ?? []);
  for (const provider of globbed) seeded.add(providerGlob(provider));
  for (const key of inUse) {
    if (!key) continue;
    const provider = providerOfEntry(key);
    if (provider !== null && globbed.has(provider)) continue;
    seeded.add(key);
  }
  // With no default and no roles this would persist `[]`, which OMP reads as
  // "no restriction" — the switch would appear to do nothing.
  if (seeded.size === 0 && fallback.length > 0) seeded.add(modelKey(fallback[0]));
  return [...seeded];
}

/**
 * Replaces one provider's entries, leaving every other provider's selection —
 * and any hand-written pattern that does not belong to this provider — intact.
 */
export function replaceProviderSelection(
  enabledModels: readonly string[],
  provider: string,
  nextForProvider: Iterable<string>,
): string[] {
  const prefix = `${provider}/`;
  return [...enabledModels.filter((key) => !key.startsWith(prefix)), ...nextForProvider];
}

/**
 * What the curation dialog persists on Save for one provider.
 *
 * Every existing entry for `provider` goes — exact keys, its whole-provider
 * glob, and any hand-written pattern under it — then either the glob or the
 * exact `selected` keys come back:
 *
 * - `includeFuture` with every catalog key selected writes `provider/**`, so a
 *   model the provider adds next month is enabled without a revisit. This is
 *   the fix for the original defect: exact entries froze the list at curation
 *   time.
 * - `includeFuture` with a strict subset still writes the exact keys. A glob
 *   would un-hide the pruned models, which is the opposite of what the user
 *   just did; the trade is documented in the dialog rather than made silently.
 * - An empty `catalogForProvider` (the read failed or raced) cannot prove
 *   anything is pruned, so `includeFuture` alone is honoured there.
 *
 * Entries of other providers are untouched even when they mention this one in
 * a later segment (`openrouter/anthropic/*` belongs to `openrouter`).
 */
export function writeProviderSelection(
  enabledModels: readonly string[],
  provider: string,
  selected: readonly string[],
  catalogForProvider: readonly string[],
  options: { includeFuture: boolean },
): string[] {
  const chosen = new Set(selected);
  const wholeProvider = catalogForProvider.every((key) => chosen.has(key));
  const next = options.includeFuture && wholeProvider ? [providerGlob(provider)] : selected;
  return [...new Set(replaceProviderSelection(enabledModels, provider, next))];
}

/**
 * Providers pinned to an exact list — they have entries but no whole-provider
 * glob, so a model they release later stays hidden until someone re-curates.
 * Sorted, for the summary strip.
 */
export function exactIdProviders(enabledModels: readonly string[]): string[] {
  const providers = new Set<string>();
  for (const entry of enabledModels) {
    const provider = providerOfEntry(entry);
    if (provider !== null) providers.add(provider);
  }
  return [...providers]
    .filter((provider) => curationModeFor(enabledModels, provider) === "exact")
    .sort((a, b) => a.localeCompare(b));
}
