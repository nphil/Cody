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

export interface ProviderCuration {
  provider: string;
  /** Models the provider offers when nothing is restricted. */
  total: number;
  /** Models actually reaching sessions right now. */
  enabled: number;
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
 */
export function summarizeProviderCuration(
  fullCatalog: readonly { provider: string; id: string }[],
  allowed: readonly { provider: string; id: string }[],
): ProviderCuration[] {
  const byProvider = new Map<string, ProviderCuration>();
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
  return [...byProvider.values()].sort((a, b) => b.total - a.total || a.provider.localeCompare(b.provider));
}

/**
 * The allow-list to persist when the restriction is switched on.
 *
 * Deliberately NOT every model: seeding the full catalog is what made enabling
 * the restriction write hundreds of OpenRouter entries into config.yml and then
 * demand hundreds of un-checks. Seeding only what is already in use means
 * "restrict" starts from the working set and everything else is opt-in.
 */
export function seedAllowList(
  inUse: readonly (string | null | undefined)[],
  fallback: readonly { provider: string; id: string }[] = [],
): string[] {
  const seeded = new Set<string>();
  for (const key of inUse) if (key) seeded.add(key);
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
