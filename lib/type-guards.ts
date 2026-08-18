/** Shared defensive type guards for untrusted/upstream JSON shapes. Used
 * across the pure-Node libs (model catalogs, session parsing, subagent
 * telemetry, RPC frames); each lib previously carried its own private copy. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A token/usage count from an engine payload: a missing, malformed or
 *  negative figure contributes nothing rather than corrupting a sum. */
export function asCount(value: unknown): number {
  const parsed = asNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : 0;
}
