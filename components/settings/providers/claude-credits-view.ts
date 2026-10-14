/**
 * Pure view logic for the "API credits (backup)" section of Settings ›
 * Providers › Anthropic: how a saved key is masked, which plan title a row
 * carries, and whether the saved keys are covering for the plans right now.
 * No React, no `@/` imports, so a plain test can load it.
 */

/** The only part of a key the browser ever holds. */
export function maskKey(last4: string): string {
  return `••••${last4}`;
}

export type PlanTitle = { kind: "primary" } | { kind: "secondary" } | { kind: "other"; n: number };

/** The plan card's naming: position 0 Primary, 1 Secondary, else Account N. */
export function planTitle(position: number): PlanTitle {
  if (position === 0) return { kind: "primary" };
  if (position === 1) return { kind: "secondary" };
  return { kind: "other", n: position + 1 };
}

export type CreditsCoverage = "covering" | "standby";

/**
 * `null` when no key is saved (nothing to describe). Otherwise "covering" only
 * when no plan account can serve and at least one is limited: every account is
 * `limited`, or `disabled` (omp took it out of rotation, so it cannot serve
 * either). Any `in_use`/`standby` account means a plan still works, so the
 * credits wait. No accounts at all is never "covering".
 */
export function creditsCoverage(states: readonly string[], keyCount: number): CreditsCoverage | null {
  if (keyCount <= 0) return null;
  const allBlocked = states.length > 0 && states.every((state) => state === "limited" || state === "disabled");
  return allBlocked && states.includes("limited") ? "covering" : "standby";
}

/** A short local date for "Added …", or null when the stamp is unreadable. */
export function formatAddedDate(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
