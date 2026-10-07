/** The web-hosted goal: the FALLBACK for an engine with no native goal mode
 * (older omp, pi, ACP). An engine that has one reports its own (lib/goal-state.ts). */
export interface ActiveGoal {
  objective: string;
  startedAt: number;
}

export interface ActivePlan {
  objective: string;
}

export function createActiveGoal(objective: string, startedAt = Date.now()): ActiveGoal {
  return { objective: objective.trim(), startedAt };
}

/** Parse sessionStorage safely: user data and old versions must never break chat. */
export function parseActiveGoal(value: string | null): ActiveGoal | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const { objective, startedAt } = parsed as Record<string, unknown>;
    if (typeof objective !== "string" || !objective.trim()
      || typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0) return null;
    return { objective, startedAt };
  } catch {
    return null;
  }
}
