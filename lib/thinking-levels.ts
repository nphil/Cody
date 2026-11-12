/**
 * Thinking-level resolution for the CURRENT model in the composer.
 *
 * `/api/models` carries each pickable model's baked effort ladder as
 * `["off", ...efforts]`. A running session's `get_state` resolves the model
 * omp is ACTUALLY using — which can differ from the session file's model
 * entry (a disabled/renamed provider falls back to the default model, and the
 * catalog only lists enabled providers). When the catalog misses the current
 * model, the live metadata is the authoritative fallback, so the dropdown
 * never falls back to the generic ladder and lists unsupported efforts.
 */

/** Model-level thinking metadata read off the live session state. */
export interface ThinkingModelMeta {
  provider: string;
  modelId: string;
  name?: string;
  reasoning?: boolean;
  thinking?: { efforts?: string[]; unverified?: boolean };
}

const DEFAULT_THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Keep familiar levels ordered while preserving provider-defined additions. */
export function selectableThinkingLevels(available: readonly string[] | null | undefined): string[] {
  if (!available) return [...DEFAULT_THINKING_LEVELS];

  const remaining = new Set(available.filter((level) => level && level !== "auto"));
  const ordered = DEFAULT_THINKING_LEVELS.filter((level) => level === "auto" || remaining.delete(level));
  return [...ordered, ...remaining];
}

/** "off" is always a valid selector; concrete efforts come from the model. */
export function thinkingLevelsForMeta(meta: ThinkingModelMeta): string[] {
  // An unverified ladder is the opt-in ladder of a model omp has no capability
  // data for: `reasoning` is false there, yet the user may still pick a level.
  if (!meta.reasoning && !hasUnverifiedLadder(meta)) return ["off"];
  return ["off", ...(meta.thinking?.efforts ?? [])];
}

/** omp 18.10.3+ `thinking.unverified` with a ladder to offer: the efforts are a
 *  guess the user opts into, not something omp has confirmed the model does. */
export function hasUnverifiedLadder(meta: Pick<ThinkingModelMeta, "thinking">): boolean {
  return meta.thinking?.unverified === true && (meta.thinking.efforts?.length ?? 0) > 0;
}

/**
 * Levels offered for the current model: the catalog's baked ladder wins; the
 * live session model backs non-catalog models. Returns null when neither
 * source knows the model — callers then fall back to the generic ladder.
 */
export function resolveAvailableThinkingLevels(
  catalogLevels: string[] | undefined,
  model: { provider: string; modelId: string } | null,
  liveModel: ThinkingModelMeta | null,
): string[] | null {
  if (catalogLevels && catalogLevels.length > 0) return catalogLevels;
  if (model && liveModel && liveModel.provider === model.provider && liveModel.modelId === model.modelId) {
    return thinkingLevelsForMeta(liveModel);
  }
  return null;
}
