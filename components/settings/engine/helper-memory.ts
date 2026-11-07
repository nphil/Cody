/**
 * The logic behind the Behavior hub's "Helper agents' memory limit" card, with
 * no React in it so a test can drive it: how `task.agentCompactionThresholdOverrides`
 * (agent name -> "20%" or a token count) reads as one shared limit plus the
 * odd agent with its own, and how a change to either turns back into the map.
 *
 * Every function takes and returns the WHOLE map, because the writer replaces
 * it whole: an entry for an agent this file has never heard of is carried
 * through untouched.
 */

export const HELPER_MEMORY_LABEL = "Helper agents' memory limit";
export const HELPER_MEMORY_DESCRIPTION = "Helper agents summarise their history once it reaches this size, and save notes first so they can pick up where they left off.";
export const HELPER_MEMORY_SEARCH_ID = "helper-agents-memory-limit";

/** The agents omp starts as helpers, in the order the Advanced list shows them. */
export const HELPER_AGENTS = ["task", "scout", "reviewer", "security-reviewer", "sonic", "luna", "heavy-task", "deep-task"] as const;
/** The one helper that is meant to differ (it does the longest, deepest work), so it never votes for the shared limit. */
const DEEP_AGENT = "deep-task";

export const PERCENT_CHOICES: readonly number[] = [10, 15, 20, 25, 30, 40, 50];
export const TOKEN_CHOICES: readonly number[] = [100_000, 150_000, 200_000, 300_000];
export const DEFAULT_PERCENT = 20;
export const DEFAULT_TOKENS = 200_000;

export type Overrides = Record<string, number | string | null>;
export type HelperMode = "percent" | "tokens" | "inherit";
/** One limit: a share of the model's window, or a fixed token count. */
export type HelperLimit = { mode: "percent" | "tokens"; value: number };

const PERCENT_ENTRY = /^(\d+(?:\.\d+)?)%$/;

/** omp's rule for one entry: a positive integer, or "N%" with N in (0, 100]. Anything else is not a limit. */
export function parseOverride(entry: unknown): HelperLimit | null {
  if (typeof entry === "number") return Number.isSafeInteger(entry) && entry > 0 ? { mode: "tokens", value: entry } : null;
  if (typeof entry !== "string") return null;
  const match = PERCENT_ENTRY.exec(entry.trim());
  const percent = match ? Number(match[1]) : Number.NaN;
  return percent > 0 && percent <= 100 ? { mode: "percent", value: percent } : null;
}

/** The value as config.yml stores it: "20%" or 200000. */
export function toOverride(limit: HelperLimit): string | number {
  return limit.mode === "percent" ? `${limit.value}%` : limit.value;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** "20%" or "200k tokens", for a person. */
export function describeLimit(limit: HelperLimit): string {
  return limit.mode === "percent" ? `${limit.value}%` : `${formatTokens(limit.value)} tokens`;
}

function sameLimit(a: HelperLimit | null, b: HelperLimit | null): boolean {
  return a === b || (a !== null && b !== null && a.mode === b.mode && a.value === b.value);
}

/** The limit most of the ordinary helpers share (ties go to the earlier one in the list), or null when none has one. */
export function sharedLimit(overrides: Overrides): HelperLimit | null {
  const counts = new Map<string, { limit: HelperLimit; count: number }>();
  for (const agent of HELPER_AGENTS) {
    if (agent === DEEP_AGENT) continue;
    const limit = parseOverride(overrides[agent]);
    if (!limit) continue;
    const key = `${limit.mode}:${limit.value}`;
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { limit, count: 1 });
  }
  let best: { limit: HelperLimit; count: number } | null = null;
  for (const candidate of counts.values()) if (!best || candidate.count > best.count) best = candidate;
  return best?.limit ?? null;
}

export interface HelperState {
  mode: HelperMode;
  /** The shared limit; null for "Same as my chats". */
  shared: HelperLimit | null;
  /** What each known helper shows in Advanced: its own limit, "same" (as the shared one) or "inherit" (not set while the others are). */
  agents: Record<string, HelperLimit | "same" | "inherit">;
}

/** The map as the card shows it. */
export function readHelperState(overrides: Overrides): HelperState {
  const shared = sharedLimit(overrides);
  const agents: HelperState["agents"] = {};
  for (const agent of HELPER_AGENTS) {
    const own = parseOverride(overrides[agent]);
    if (own === null) agents[agent] = shared ? "inherit" : "same";
    else agents[agent] = sameLimit(own, shared) ? "same" : own;
  }
  return { mode: shared?.mode ?? "inherit", shared, agents };
}

/**
 * The map after choosing the shared limit (null = "Same as my chats"). Every
 * known helper that followed the old shared limit gets the new one; a helper
 * that was given its own value in Advanced keeps it, and so does every entry
 * for an agent this card does not list.
 */
export function withSharedLimit(overrides: Overrides, next: HelperLimit | null): Overrides {
  const before = sharedLimit(overrides);
  const result: Overrides = { ...overrides };
  for (const agent of HELPER_AGENTS) {
    const own = parseOverride(overrides[agent]);
    if (own !== null && !sameLimit(own, before)) continue;
    if (next) result[agent] = toOverride(next);
    else delete result[agent];
  }
  return result;
}

/** The map after choosing one helper's own limit, or "same" to put it back on the shared one. */
export function withAgentLimit(overrides: Overrides, agent: string, next: HelperLimit | "same" | "inherit"): Overrides {
  const result: Overrides = { ...overrides };
  const shared = sharedLimit(overrides);
  if (next === "inherit") delete result[agent];
  else if (next === "same") {
    if (shared) result[agent] = toOverride(shared);
    else delete result[agent];
  } else result[agent] = toOverride(next);
  return result;
}

/** The ids of the Select rows: "same", "inherit", "percent:20", "tokens:200000". */
export function choiceId(choice: HelperLimit | "same" | "inherit"): string {
  return typeof choice === "string" ? choice : `${choice.mode}:${choice.value}`;
}

export function parseChoiceId(id: string): HelperLimit | "same" | "inherit" | null {
  if (id === "same" || id === "inherit") return id;
  const [mode, raw] = id.split(":");
  const value = Number(raw);
  return (mode === "percent" || mode === "tokens") && Number.isFinite(value) && value > 0 ? { mode, value } : null;
}

/** The sizes offered for one kind of limit, with the current one added when it is not a standard choice (a hand-edited 12.5%). */
export function limitChoices(mode: "percent" | "tokens", current: number | null): number[] {
  const standard = mode === "percent" ? PERCENT_CHOICES : TOKEN_CHOICES;
  return current !== null && !standard.includes(current) ? [...standard, current].sort((a, b) => a - b) : [...standard];
}
