import { resolveRosterModel } from "../model-plan/derive";
import type { RosterModel } from "../model-plan/roster";
import { isRecord } from "../type-guards";

/**
 * Check only model choices against OMP's effective roster. OMP already applies
 * enabledModels and disabledProviders to get_available_models; reproducing its
 * glob rules here would disagree with hand-written or scoped curation.
 * Invalid shapes are left to the preset store's normal validation.
 */
export function unavailablePresetSelection(
  selection: { roles?: unknown; chains?: unknown },
  models: RosterModel[],
): string | null {
  if (isRecord(selection.roles)) {
    for (const [role, selector] of Object.entries(selection.roles)) {
      if (typeof selector === "string" && selector && !resolveRosterModel(selector, models)) {
        return `The ${role} role's model "${selector}" is not available under the current provider curation.`;
      }
    }
  }

  if (isRecord(selection.chains)) {
    for (const [key, entries] of Object.entries(selection.chains)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry !== "string" || !entry || entry.startsWith("@")) continue;
        if (/^[^/]+\/\*$/.test(entry)) {
          const provider = entry.slice(0, -2);
          if (!models.some((model) => model.provider === provider)) {
            return `The ${key} fallback's provider "${provider}" has no available models under the current provider curation.`;
          }
        } else if (!resolveRosterModel(entry, models)) {
          return `The ${key} fallback's model "${entry}" is not available under the current provider curation.`;
        }
      }
    }
  }

  return null;
}
