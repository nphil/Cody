/**
 * Telling a chat or a helper that is burning tokens from one that is working.
 *
 * Pure rules over what an agent's own transcript says it did: each model
 * request (how many tokens it paid full price for) and each compaction (how
 * much context it had before and after). No I/O; lib/run-recovery/burn-trail.ts
 * reads the transcript and lib/run-recovery/burn-guard.ts acts on the verdict.
 *
 * Why these three. On 2026-11-12 four helpers compacted on (almost) every
 * step for four hours: each compaction left the context above the trigger, so
 * the next step compacted again, and every request re-sent ~150,000 tokens
 * with no cache discount (~1.35 billion tokens). A compaction is worth its
 * price only when it frees a lot and is followed by several requests (it pays
 * back in roughly five), so:
 *
 * - `stuck`: compactions keep running and keep freeing almost nothing.
 * - `churn`: compactions come every step or two, whatever they free.
 * - `rate`: request after request pays full price for a whole context, the
 *   signature of that loop and of any other broken prompt cache.
 *
 * The numbers were set against every transcript on this server on 2026-11-13
 * (2,446 files, 387,594 requests, 12,019 compactions): they stop the incident
 * within about six requests of its start and trip on 20 files in all, each of
 * them a real loop or cache failure; no ordinary run comes close (see
 * BURN_LIMITS).
 */

/** One model request, as the transcript recorded its usage. */
export interface BurnRequest {
  kind: "request";
  /** Epoch milliseconds. */
  at: number;
  /** Tokens paid at full price or more: uncached input plus what was written to the cache. */
  fresh: number;
  /** The provider served part of the prompt from its cache. */
  cached: boolean;
}

/** One compaction (any method: remote, handoff, snapcompact, soft, or the experimental rollover). */
export interface BurnCompaction {
  kind: "compaction";
  at: number;
  /** Context tokens before and after; null when the engine did not record it. */
  before: number | null;
  after: number | null;
  /** The engine itself flagged it as having freed too little. */
  warned: boolean;
}

export type BurnEvent = BurnRequest | BurnCompaction;

export interface BurnLimits {
  /** Nothing older than this counts. */
  windowMs: number;
  /** The newest piece of evidence must be this recent: an old loop in a transcript is history, not a fire. */
  freshMs: number;
  /** `churn`: this many compactions … */
  churnCompactions: number;
  /** … with at most this many requests since the first of them. */
  churnRequests: number;
  /** `stuck`: this many compactions in a row that freed too little … */
  stuckCompactions: number;
  /** … with at most this many requests since the first of them. */
  stuckRequests: number;
  /** A compaction the engine flagged freed too little when it kept at least this share of the context. */
  warnedKeptRatio: number;
  /** One it did not flag, when it kept at least this share. */
  plainKeptRatio: number;
  /** `rate`: a request is hot when it paid full price for at least this many tokens … */
  hotTokens: number;
  /** … and this many hot requests … */
  hotRequests: number;
  /** … inside this long is a burn. */
  hotWindowMs: number;
  /** A chat is looked at no more often than this, however many frames arrive. */
  scanEveryMs: number;
  /** How much of the end of a transcript one look reads. */
  tailBytes: number;
  /** This many helpers stopped in one chat inside `escalateWindowMs` stops the chat's own run too. */
  escalateStops: number;
  escalateWindowMs: number;
  /** How long the engine has to accept a stop or a message. */
  sendBoundMs: number;
}

const MINUTE = 60_000;

/**
 * Measured margins (all transcripts on this server, 2026-11-13):
 * - `churn` 6 in 12: the regular compaction path never produced more than 5
 *   compactions that close together (once); a healthy run compacts every 13 to
 *   40+ requests. Every per-step loop on record reached 6 within 6 to 12.
 * - `stuck` 5 in 60: every loop's compactions kept 82-91% of the context; a
 *   healthy one keeps a quarter to a half (median 27%, 95th percentile 59% of
 *   1,013). Sixty requests is one useless compaction every dozen, which is
 *   how a dead end looks at a 200,000-token trigger: the context has to grow
 *   40,000 tokens back before the next one. No transcript on record has five
 *   useless compactions in a row at any spacing without being a loop.
 * - `rate` 8 hot requests in 10 minutes: ordinary runs peak at 5 (a few cache
 *   expiries and model switches); the incident ran at 107-151.
 */
export const BURN_LIMITS: Readonly<BurnLimits> = {
  windowMs: 30 * MINUTE,
  freshMs: 3 * MINUTE,
  churnCompactions: 6,
  churnRequests: 12,
  stuckCompactions: 5,
  stuckRequests: 60,
  warnedKeptRatio: 0.7,
  plainKeptRatio: 0.9,
  hotTokens: 100_000,
  hotRequests: 8,
  hotWindowMs: 10 * MINUTE,
  scanEveryMs: 20_000,
  tailBytes: 8 * 1024 * 1024,
  escalateStops: 3,
  escalateWindowMs: 60 * MINUTE,
  sendBoundMs: 60_000,
};

export type BurnVerdict =
  | { rule: "stuck" | "churn"; compactions: number; requests: number }
  | { rule: "rate"; requests: number; tokens: number; minutes: number };

function freedTooLittle(compaction: BurnCompaction, limits: BurnLimits): boolean {
  if (compaction.before === null || compaction.before <= 0 || compaction.after === null) return compaction.warned;
  const kept = compaction.after / compaction.before;
  return kept >= limits.plainKeptRatio || (compaction.warned && kept >= limits.warnedKeptRatio);
}

/**
 * The verdict on one agent's recent events (oldest first), or null when it is
 * working normally. `since` hides everything up to a moment already dealt with
 * (the last stop), so one loop is never judged twice.
 */
export function detectBurn(events: readonly BurnEvent[], now: number, limits: BurnLimits = BURN_LIMITS, since = 0): BurnVerdict | null {
  const from = Math.max(since, now - limits.windowMs);
  const recent = events.filter((event) => event.at > from);
  const compactions: number[] = [];
  recent.forEach((event, index) => { if (event.kind === "compaction") compactions.push(index); });

  const newest = compactions.length > 0 ? recent[compactions[compactions.length - 1]] : null;
  if (newest && now - newest.at <= limits.freshMs) {
    /**
     * How many requests came after the first of the last `count` compactions.
     * Null when there are fewer compactions, and when under two requests were
     * seen among them: a loop compacts BETWEEN requests, so that is a
     * transcript whose requests could not be read, not one to judge.
     */
    const requestsAcross = (count: number): number | null => {
      if (compactions.length < count) return null;
      const first = compactions[compactions.length - count];
      let requests = 0;
      for (let index = first + 1; index < recent.length; index += 1) if (recent[index].kind === "request") requests += 1;
      return requests >= 2 ? requests : null;
    };
    const stuckSpan = requestsAcross(limits.stuckCompactions);
    if (stuckSpan !== null && stuckSpan <= limits.stuckRequests) {
      const last = compactions.slice(-limits.stuckCompactions).map((index) => recent[index]);
      if (last.every((event) => event.kind === "compaction" && freedTooLittle(event, limits))) {
        return { rule: "stuck", compactions: limits.stuckCompactions, requests: stuckSpan };
      }
    }
    const churnSpan = requestsAcross(limits.churnCompactions);
    if (churnSpan !== null && churnSpan <= limits.churnRequests) {
      return { rule: "churn", compactions: limits.churnCompactions, requests: churnSpan };
    }
  }

  // A provider that never caches bills every request in full: that is its normal price, not a burn.
  if (!recent.some((event) => event.kind === "request" && event.cached)) return null;
  const hot = recent.filter((event): event is BurnRequest => (
    event.kind === "request" && event.fresh >= limits.hotTokens && event.at > now - limits.hotWindowMs
  ));
  if (hot.length < limits.hotRequests || now - hot[hot.length - 1].at > limits.freshMs) return null;
  return {
    rule: "rate",
    requests: hot.length,
    tokens: hot.reduce((sum, event) => sum + event.fresh, 0),
    minutes: Math.max(1, Math.ceil((hot[hot.length - 1].at - hot[0].at) / MINUTE)),
  };
}

function roundTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)} million`;
  return `${Math.round(tokens / 1000)},000`;
}

/** What was seen, in one plain sentence without a full stop: the chat line, the push and the message to the agent all carry it. */
export function describeBurn(verdict: BurnVerdict, who: string): string {
  switch (verdict.rule) {
    case "stuck":
      return `${who} cleaned up its memory ${verdict.compactions} times within ${Math.max(1, verdict.requests)} steps and freed almost nothing each time`;
    case "churn":
      return `${who} cleaned up its memory ${verdict.compactions} times within ${Math.max(1, verdict.requests)} steps`;
    case "rate":
      return `${who} paid full price for ${roundTokens(verdict.tokens)} tokens of context in ${verdict.minutes} ${verdict.minutes === 1 ? "minute" : "minutes"} (${verdict.requests} requests)`;
  }
}
