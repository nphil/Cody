"use client";

import { useSettingsRoute } from "./useSettingsData";
import { SETTINGS_ROUTE, type NativeSettings } from "./useConfigWriter";

/**
 * The slice of omp's config.yml that decides how big a helper's history may
 * grow (task.agentCompactionThresholdOverrides, compaction.threshold*), read
 * through the same cached /api/omp-settings route the Settings cards use, so
 * many chips cost one fetch. Null until it is read, or when the engine has no
 * config to read (the chip then simply shows the model's full window).
 */
export function useHelperLimitConfig(enabled = true): Pick<NativeSettings, "task" | "compaction"> | null {
  const route = useSettingsRoute<{ settings?: NativeSettings }>(SETTINGS_ROUTE, { enabled });
  return route.data?.settings ?? null;
}
