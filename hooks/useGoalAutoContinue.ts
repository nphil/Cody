"use client";

/**
 * "Keep working automatically" in the Goal panel: omp's `goal.continuationModes`
 * with the run mode Cody's engine child is in (`rpc`) added or removed.
 *
 * It is one global setting in the engine's config.yml — every chat shares it,
 * and the terminal's own mode (`interactive`) is left exactly as the user had
 * it. It is written through the ordinary config writer WITHOUT `applyNow`: a
 * running engine watches that file and re-reads this setting every time it
 * decides whether to continue (verified live on omp 18.7 — flipping it while a
 * chat is open changes what the very next turn end does), whereas `applyNow`
 * restarts idle engine children, and an engine that starts up pauses a goal
 * that was active. Nothing is applied by restarting anything.
 */
import { useCallback, useState } from "react";
import { patchSettingsSchema } from "@/hooks/useConfigWriter";
import { setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { goalAutoContinues, nextContinuationModes } from "@/lib/goal-state";

const KEY = "goal.continuationModes";
const ROUTE = `/api/omp-settings/schema?values=${KEY}`;

interface ValuesBody {
  values?: Record<string, unknown>;
}

export interface GoalAutoContinue {
  /** Whether goals carry on by themselves; `null` while the setting cannot be read (not asked, loading, refused). */
  enabled: boolean | null;
  /** A write is in flight. */
  pending: boolean;
  /** Write the setting. Resolves true when that changed it, false when it already said so; rejects when the write failed, after restoring what is on screen. */
  set: (on: boolean) => Promise<boolean>;
}

/** `available` is false for every chat without a native goal: nothing is fetched then. */
export function useGoalAutoContinue(available: boolean): GoalAutoContinue {
  const route = useSettingsRoute<ValuesBody>(ROUTE, { enabled: available, ttlMs: 60_000 });
  const [pending, setPending] = useState(false);
  const { data, reload } = route;
  const persisted = data?.values?.[KEY];
  const enabled = available && data && !route.unsupported ? goalAutoContinues(persisted) : null;

  const set = useCallback(async (on: boolean): Promise<boolean> => {
    const next = nextContinuationModes(persisted, on);
    if (next === undefined) return false;
    setPending(true);
    // The switch reads back what was just chosen while the write is on its way.
    const { [KEY]: _previous, ...others } = data?.values ?? {};
    setSettingsRouteData<ValuesBody>(ROUTE, { values: next === null ? others : { ...others, [KEY]: next } });
    try {
      await patchSettingsSchema({ [KEY]: next });
      return true;
    } finally {
      // Either way the file is the truth: confirms the write, or puts back what a refused one left.
      await reload().catch(() => {});
      setPending(false);
    }
  }, [data, persisted, reload]);

  return { enabled, pending, set };
}
