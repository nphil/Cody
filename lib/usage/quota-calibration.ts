import type { QuotaPoint } from "./quota-history";

/**
 * How many tokens, of each kind, one percent of a quota window costs.
 *
 * Input: the quota history (quota-history.ts: percent used per account window,
 * with reset times) and token rows for the same time (one per request: when,
 * which provider, which credential when known, and the four token counts the
 * Statistics index already keeps). Output: per account window, the tokens that
 * were spent between the first and the last reading of each stretch the window
 * ran without a reset, divided by the percentage points it moved.
 *
 * It answers "not enough data" rather than guess, and says why:
 *  - a stretch only counts between readings of ONE window run: the interval
 *    that crosses a reset is dropped, because nobody knows how the spend split
 *    around it;
 *  - the window must have moved `minPercentSpan` points in total (percentages
 *    are whole numbers, so a one-point move can be a 0.1 to 1.9 point move);
 *  - tokens must exist for the interval, and no more than `maxUnattributedShare`
 *    of them may be ones that cannot be told apart between accounts (a row with
 *    no credential while the provider has several accounts in the history).
 *
 * Quota is shared with whatever else uses the account (another app, the web
 * chat): that spend moves the percentage without a token row, so the result is
 * an UPPER bound per percent wherever the account is shared. Pure and clock-free.
 */

/** One request's tokens. `at` is epoch ms. */
export interface TokenRow {
  at: number;
  provider: string;
  /** omp's credential row id; absent or null when the request does not say which login served it. */
  credentialId?: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface QuotaCalibrationOptions {
  /** Least total movement, in percentage points, before a window gets an answer. Default 5. */
  minPercentSpan?: number;
  /** Most share of the interval's tokens that may be unassignable to an account. Default 0.2. */
  maxUnattributedShare?: number;
}

export interface QuotaCalibrationOk {
  status: "ok";
  provider: string;
  account: string;
  windowId: string;
  /** Percentage points the window moved over the counted stretches. */
  percentSpan: number;
  /** Counted stretches (reset to reset, or reading to reading, whichever ends first). */
  stretches: number;
  /** Tokens spent over the counted stretches. */
  tokens: TokenCounts;
  /** Tokens per one percentage point, by kind. */
  perPercent: TokenCounts & { total: number };
  /** First and last reading used, epoch ms. */
  from: number;
  to: number;
}

export interface QuotaCalibrationUnknown {
  status: "not-enough-data";
  provider: string | null;
  account: string | null;
  windowId: string | null;
  reason: string;
}

export type QuotaCalibration = QuotaCalibrationOk | QuotaCalibrationUnknown;

const DEFAULT_MIN_PERCENT_SPAN = 5;
const DEFAULT_MAX_UNATTRIBUTED_SHARE = 0.2;
/** A reset time that jumps ahead by at least this is a new window, whatever the percentage did. */
const NEW_WINDOW_JUMP_MS = 30 * 60_000;

const emptyCounts = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const sumOf = (counts: TokenCounts) => counts.input + counts.output + counts.cacheRead + counts.cacheWrite;

/** Whether `next` belongs to a later run of the window than `previous`: the percentage fell, the earlier reset time had passed, or the reset time jumped ahead. */
function startsNewRun(previous: QuotaPoint, next: QuotaPoint): boolean {
  if (next.u < previous.u) return true;
  if (previous.r !== null && next.t >= previous.r) return true;
  return previous.r !== null && next.r !== null && next.r - previous.r >= NEW_WINDOW_JUMP_MS;
}

/** The stretches of `points` (one window, oldest first) that ran without a reset, each as its first and last reading with at least two readings. */
function runsOf(points: QuotaPoint[]): Array<{ first: QuotaPoint; last: QuotaPoint }> {
  const runs: Array<{ first: QuotaPoint; last: QuotaPoint }> = [];
  let start = 0;
  for (let i = 1; i <= points.length; i += 1) {
    if (i < points.length && !startsNewRun(points[i - 1], points[i])) continue;
    if (i - start >= 2) runs.push({ first: points[start], last: points[i - 1] });
    start = i;
  }
  return runs;
}

export function calibrateQuota(
  history: readonly QuotaPoint[],
  rows: readonly TokenRow[],
  options: QuotaCalibrationOptions = {},
): QuotaCalibration[] {
  const minSpan = options.minPercentSpan ?? DEFAULT_MIN_PERCENT_SPAN;
  const maxUnattributed = options.maxUnattributedShare ?? DEFAULT_MAX_UNATTRIBUTED_SHARE;
  if (history.length === 0) {
    return [{ status: "not-enough-data", provider: null, account: null, windowId: null, reason: "no quota readings have been recorded yet" }];
  }

  const accountsOf = new Map<string, Set<string>>();
  const windows = new Map<string, QuotaPoint[]>();
  for (const point of [...history].sort((a, b) => a.t - b.t)) {
    (accountsOf.get(point.p) ?? accountsOf.set(point.p, new Set()).get(point.p)!).add(point.a);
    const key = `${point.p}\u0000${point.a}\u0000${point.w}`;
    (windows.get(key) ?? windows.set(key, []).get(key)!).push(point);
  }

  const results: QuotaCalibration[] = [];
  for (const points of windows.values()) {
    const { p: provider, a: account, w: windowId } = points[0];
    const unknown = (reason: string): QuotaCalibration => ({ status: "not-enough-data", provider, account, windowId, reason });
    const credential = [...points].reverse().find((point) => point.c !== null)?.c ?? null;
    const onlyAccount = (accountsOf.get(provider)?.size ?? 0) === 1;
    const providerRows = rows.filter((row) => row.provider === provider);
    /** Whether a row is this account's: its credential matches, or it names none and this is the provider's only account. */
    const isMine = (row: TokenRow): boolean | null => {
      const named = row.credentialId !== undefined && row.credentialId !== null;
      if (named && credential !== null) return row.credentialId === credential;
      return onlyAccount ? true : null;
    };

    const runs = runsOf(points);
    if (runs.length === 0) {
      results.push(unknown("fewer than two readings in one run of the window"));
      continue;
    }
    let span = 0;
    let unassignable = 0;
    const tokens = emptyCounts();
    let counted = 0;
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    for (const { first, last } of runs) {
      const moved = last.u - first.u;
      if (moved <= 0) continue;
      for (const row of providerRows) {
        if (row.at <= first.t || row.at > last.t) continue;
        const mine = isMine(row);
        const rowTotal = row.input + row.output + row.cacheRead + row.cacheWrite;
        if (mine === null) unassignable += rowTotal;
        else if (mine) {
          tokens.input += row.input;
          tokens.output += row.output;
          tokens.cacheRead += row.cacheRead;
          tokens.cacheWrite += row.cacheWrite;
        }
      }
      span += moved;
      counted += 1;
      from = Math.min(from, first.t);
      to = Math.max(to, last.t);
    }
    if (counted === 0) {
      results.push(unknown("the window did not move between readings"));
      continue;
    }
    if (span < minSpan) {
      results.push(unknown(`the window moved only ${Math.round(span * 100) / 100} percentage points; at least ${minSpan} are needed`));
      continue;
    }
    const total = sumOf(tokens);
    if (total === 0) {
      results.push(unknown("no token rows fall inside the readings' time span"));
      continue;
    }
    if (unassignable / (unassignable + total) > maxUnattributed) {
      results.push(unknown("too many requests do not say which account served them, and the provider has several accounts"));
      continue;
    }
    results.push({
      status: "ok",
      provider,
      account,
      windowId,
      percentSpan: Math.round(span * 100) / 100,
      stretches: counted,
      tokens,
      perPercent: {
        input: tokens.input / span,
        output: tokens.output / span,
        cacheRead: tokens.cacheRead / span,
        cacheWrite: tokens.cacheWrite / span,
        total: total / span,
      },
      from,
      to,
    });
  }
  return results.sort((a, b) => `${a.provider}\u0000${a.account}\u0000${a.windowId}`.localeCompare(`${b.provider}\u0000${b.account}\u0000${b.windowId}`));
}
