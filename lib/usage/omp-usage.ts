import { execFile } from "child_process";
import { OMP_BIN_MISSING, resolveOmpBin } from "../omp/omp-cli";
import type {
  UsageAccount,
  UsageAccountPolicy,
  UsageProviderCapacity,
  UsageSnapshot,
  UsageUnreportedAccount,
  UsageWindow,
  UsageWindowAmount,
  UsageWindowState,
} from "./types";

/**
 * Reading plan quota out of the omp engine.
 *
 * `omp usage --json` is a built-in CLI command: it never reaches a model, so it
 * costs zero tokens and zero premium requests. It prints whatever sits in omp's
 * own 5-minute TTL SQLite cache, which omp refreshes on its own schedule and
 * shares across every omp process on the machine.
 *
 * The upstream quota endpoints are rate-limited per source IP, so Cody NEVER
 * passes a force/refresh flag — it only ever reads the cache. A "refresh" in
 * Cody means "re-read omp's cache", never "make omp hit the provider".
 *
 * Every field of the payload is treated as optional. omp's usage schema has
 * churned repeatedly across releases and covers ~16 providers, so an unknown or
 * partial shape degrades to "unavailable" or to fewer windows — it never throws.
 */

/** Cody's shipped thresholds: at or above these percentages a window is
 * warning / exhausted, regardless of how the engine grades its own windows
 * (omp only warns at 90%, which is too late to be useful in the composer). */
export const USAGE_WARNING_THRESHOLD = 70;
export const USAGE_EXHAUSTED_THRESHOLD = 100;

const OMP_USAGE_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_LABEL_LENGTH = 80;
/** Last-resort names. Every rendered window and account is named — a reading
 * with no label would print as a bare percentage naming nothing. */
const DEFAULT_WINDOW_LABEL = "quota";
const DEFAULT_ACCOUNT_LABEL = "account";

/** Engine-reported statuses that mean "spent", whatever the percentage says. */
const EXHAUSTED_STATUSES = new Set(["exhausted", "rejected"]);

export function unavailableUsageSnapshot(reason: string): UsageSnapshot {
  return { available: false, accounts: [], fetchedAt: new Date().toISOString(), stale: false, reason };
}

export function deriveUsageWindowState(utilization: number, status?: unknown): UsageWindowState {
  if (typeof status === "string" && EXHAUSTED_STATUSES.has(status.toLowerCase())) return "exhausted";
  if (!Number.isFinite(utilization)) return "ok";
  if (utilization >= USAGE_EXHAUSTED_THRESHOLD) return "exhausted";
  if (utilization >= USAGE_WARNING_THRESHOLD) return "warning";
  return "ok";
}

/** Whether the one usage reader Cody has is installed, whichever engine is
 * active. A cached probe; spawns nothing on a warm answer. */
export function usageReaderInstalled(): boolean {
  return resolveOmpBin() !== null;
}

/**
 * Spawn the engine's usage command and normalize its output. Resolves to an
 * unavailable snapshot — never rejects — when omp is missing, exits non-zero,
 * exceeds the timeout, or prints something that is not the expected payload.
 */
export function fetchOmpUsageSnapshot(options: { timeoutMs?: number } = {}): Promise<UsageSnapshot> {
  const bin = resolveOmpBin();
  if (!bin) return Promise.resolve(unavailableUsageSnapshot(OMP_BIN_MISSING));
  const { promise, resolve } = Promise.withResolvers<UsageSnapshot>();
  try {
    // Fixed argv, no shell: nothing user-controlled reaches the command line.
    execFile(bin, ["usage", "--json"], {
      timeout: options.timeoutMs ?? OMP_USAGE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        // A non-zero exit that still printed a readable payload (some builds
        // exit 1 when one provider's fetch failed) is a reading, not a
        // failure: the other accounts' numbers are good.
        if (!killed && typeof stdout === "string" && stdout.trim()) {
          const partial = parseOmpUsageOutput(stdout);
          if (partial.available) {
            resolve(partial);
            return;
          }
        }
        const detail = (stderr || error.message || "").trim().replace(/\s+/g, " ").slice(0, 200);
        resolve(unavailableUsageSnapshot(killed ? "omp usage timed out" : detail || "omp usage failed"));
        return;
      }
      resolve(parseOmpUsageOutput(stdout));
    });
  } catch (error) {
    resolve(unavailableUsageSnapshot(`omp usage could not start: ${String(error)}`));
  }
  return promise;
}

/** Parse raw stdout. Malformed or empty output degrades to unavailable. */
export function parseOmpUsageOutput(stdout: unknown): UsageSnapshot {
  if (typeof stdout !== "string" || !stdout.trim()) {
    return unavailableUsageSnapshot("omp usage returned no output");
  }
  const payload = parseJsonObject(stdout);
  if (payload === undefined) return unavailableUsageSnapshot("omp usage returned malformed JSON");
  return parseOmpUsagePayload(payload);
}

/**
 * The JSON value in `stdout`, or undefined when there is none. A notice
 * printed before or after the payload (an update line, a deprecation) must
 * not turn a good reading into "malformed", so a failed whole-text parse
 * falls back to the span from the first `{` to the last `}`.
 */
function parseJsonObject(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(stdout.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/**
 * Map the `{generatedAt, reports, ...}` payload onto a UsageSnapshot. Reports
 * that carry nothing measurable are dropped rather than rendered as pristine
 * quota; a payload with no measurable report at all reads as unavailable.
 */
export function parseOmpUsagePayload(payload: unknown): UsageSnapshot {
  if (!isRecord(payload)) return unavailableUsageSnapshot("omp usage returned an unexpected shape");
  const reports = Array.isArray(payload.reports) ? payload.reports : null;
  if (!reports) return unavailableUsageSnapshot("omp usage reported no accounts");

  const records = reports.filter(isRecord);
  const disabledRecords = (Array.isArray(payload.disabledCredentials) ? payload.disabledCredentials : []).filter(
    isRecord,
  );

  // Disambiguation (a per-provider label discriminator) has to see every
  // account that will occupy the provider's rows, disabled ones included —
  // otherwise a lone reporting account paired with one disabled tombstone
  // would both render as a bare "Anthropic" with nothing telling them apart.
  const providerCounts = new Map<string, number>();
  for (const entry of [...records, ...disabledRecords]) {
    const provider = readString(entry.provider);
    if (provider) providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
  }

  const usedIdsByProvider = new Map<string, Set<string>>();
  const usedIdsFor = (provider: string): Set<string> => {
    const existing = usedIdsByProvider.get(provider);
    if (existing) return existing;
    const created = new Set<string>();
    usedIdsByProvider.set(provider, created);
    return created;
  };

  const accounts: UsageAccount[] = [];
  let latestFetchedAt: number | undefined;
  for (let index = 0; index < records.length; index += 1) {
    const report = records[index]!;
    const provider = readString(report.provider);
    if (!provider) continue;
    const fetchedAt = readNumber(report.fetchedAt);
    if (fetchedAt !== undefined && (latestFetchedAt === undefined || fetchedAt > latestFetchedAt)) {
      latestFetchedAt = fetchedAt;
    }
    const account = buildAccount(
      report,
      provider,
      index,
      (providerCounts.get(provider) ?? 0) > 1,
      usedIdsFor(provider),
    );
    if (account) accounts.push(account);
  }

  // Appended after every reporting account: a disabled credential still holds
  // a provider slot omp will not route to, so it must stay visible (with no
  // live windows) rather than silently vanish once auth-storage tombstones it.
  for (let index = 0; index < disabledRecords.length; index += 1) {
    const summary = disabledRecords[index]!;
    const provider = readString(summary.provider);
    if (!provider) continue;
    const account = buildDisabledAccount(
      summary,
      provider,
      index,
      (providerCounts.get(provider) ?? 0) > 1,
      usedIdsFor(provider),
    );
    if (account) accounts.push(account);
  }

  const unreported = buildUnreportedAccounts(payload.accountsWithoutUsage);
  if (accounts.length === 0) {
    // Nothing measurable. When omp lists signed-in logins it could not read,
    // the read FAILED (offline, every provider fetch refused) rather than
    // the user having no quota: say so, and keep the list so the caller can
    // tell which accounts went quiet.
    const missing = unreported?.length ?? 0;
    const reason = missing > 0
      ? `omp could not read the quota of ${missing} signed-in account${missing === 1 ? "" : "s"}`
      : "omp usage reported no quota windows";
    return { ...unavailableUsageSnapshot(reason), ...(unreported ? { unreportedAccounts: unreported } : {}) };
  }

  const generatedAt = readNumber(payload.generatedAt) ?? latestFetchedAt;
  const capacity = buildCapacity(payload.capacity);
  return {
    available: true,
    accounts,
    fetchedAt: toIsoString(generatedAt) ?? new Date().toISOString(),
    stale: false,
    ...(capacity ? { capacity } : {}),
    ...(unreported ? { unreportedAccounts: unreported } : {}),
  };
}

function buildAccount(
  report: Record<string, unknown>,
  provider: string,
  index: number,
  disambiguate: boolean,
  usedIds: Set<string>,
): UsageAccount | null {
  const metadata = isRecord(report.metadata) ? report.metadata : {};
  const limits = Array.isArray(report.limits) ? report.limits.filter(isRecord) : [];
  const unlimited = limits.length > 0 && limits.every(isUnlimitedLimit);
  const resetCredits = buildResetCredits(report.resetCredits);
  const policy = buildPolicy(report.policy);
  const inactiveGates = (Array.isArray(metadata.inactiveSharedGates) ? metadata.inactiveSharedGates : [])
    .filter((gate): gate is string => typeof gate === "string" && gate.trim() !== "");

  const windows: UsageWindow[] = [];
  const seenIds = new Set<string>();
  for (let position = 0; position < limits.length; position += 1) {
    const limit = limits[position]!;
    if (isUnlimitedLimit(limit)) continue;
    const window = buildWindow(limit, provider, position, seenIds);
    if (window) windows.push(window);
  }

  if (windows.length === 0 && !unlimited) return null;

  return {
    provider,
    id: resolveAccountId(metadata, provider, index, usedIds),
    identity: readString(metadata.email) ?? readString(metadata.orgName) ?? null,
    // Active reports carry no credential row id; the cache enriches it from
    // the credential store (lib/usage/credential-order.ts).
    credentialId: null,
    label: buildAccountLabel(provider, metadata, index, disambiguate),
    planType: readString(metadata.planType) ?? null,
    unlimited,
    windows,
    ...(resetCredits ? { resetCredits } : {}),
    ...(policy ? { policy } : {}),
    ...(inactiveGates.length > 0 ? { inactiveGates } : {}),
    // Set only when a live response refreshed these windows: that is omp's
    // record of the account actually serving traffic, not merely polled.
    lastServedAt: toIsoString(readNumber(metadata.headersUpdatedAt)) ?? null,
  };
}

/**
 * A disabled credential still occupies a provider slot omp will not route to
 * — surfacing it (with no live windows, `disabled.cause` explaining why) is
 * what lets Settings show and remove it instead of it silently vanishing the
 * moment auth-storage tombstones the row.
 */
function buildDisabledAccount(
  summary: Record<string, unknown>,
  provider: string,
  index: number,
  disambiguate: boolean,
  usedIds: Set<string>,
): UsageAccount {
  return {
    provider,
    id: resolveAccountId(summary, provider, index, usedIds),
    identity: readString(summary.email) ?? readString(summary.orgName) ?? null,
    // A disabled tombstone DOES name its row, so ordering works even when the
    // credential store cannot be read.
    credentialId: readNumber(summary.id) ?? null,
    label: buildAccountLabel(provider, summary, index, disambiguate),
    planType: null,
    unlimited: false,
    windows: [],
    disabled: { cause: readString(summary.cause) ?? null },
  };
}

/**
 * Stable per-account identity: the engine's own account id, else the
 * account's email, else a positional `${provider}#${index}` fallback. Only
 * suffixed with `#${index}` when that candidate already names an earlier
 * account of the same provider — two real accounts sharing no reported
 * identity at all is the one case a bare index cannot already disambiguate.
 */
function resolveAccountId(
  fields: Record<string, unknown>,
  provider: string,
  index: number,
  usedIds: Set<string>,
): string {
  const base = readString(fields.accountId) ?? readString(fields.email) ?? `${provider}#${index}`;
  const id = usedIds.has(base) ? `${base}#${index}` : base;
  usedIds.add(id);
  return id;
}

/**
 * Parse `{ [provider]: ProviderWindowStat[] }` (omp's `computeProviderWindowStats`
 * output, keyed by provider) into `UsageSnapshot.capacity`. A stat missing its
 * window id or account counts is dropped rather than defaulted — capacity for
 * nothing is not a reading.
 */
function buildCapacity(value: unknown): Record<string, UsageProviderCapacity[]> | undefined {
  if (!isRecord(value)) return undefined;
  const capacity: Record<string, UsageProviderCapacity[]> = {};
  for (const [provider, rawStats] of Object.entries(value)) {
    if (!Array.isArray(rawStats)) continue;
    const stats: UsageProviderCapacity[] = [];
    for (const rawStat of rawStats) {
      if (!isRecord(rawStat)) continue;
      const windowId = readString(rawStat.window);
      const accountsCount = readNumber(rawStat.accounts);
      const remainingAccounts = readNumber(rawStat.remainingAccounts);
      if (windowId === undefined || accountsCount === undefined || remainingAccounts === undefined) continue;
      stats.push({ windowId, meter: readString(rawStat.meter) ?? null, accounts: accountsCount, remainingAccounts });
    }
    if (stats.length > 0) capacity[provider] = stats;
  }
  return Object.keys(capacity).length > 0 ? capacity : undefined;
}

/** The `policy` object `omp usage --json` prints for an account an
 * `auth.accountPolicies` entry matches. Every field is optional upstream, so a
 * missing one is null; an object that says nothing at all is not a policy. */
function buildPolicy(value: unknown): UsageAccountPolicy | undefined {
  if (!isRecord(value)) return undefined;
  const state = readString(value.state);
  const source = readString(value.reserveSource);
  const policy: UsageAccountPolicy = {
    priority: readNumber(value.priority) ?? null,
    reservePct: readNumber(value.reservePct) ?? null,
    reserveSource: source === "global" || source === "override" ? source : null,
    reclaimAbovePct: readNumber(value.reclaimAbovePct) ?? null,
    state: state === "eligible" || state === "inside-reserve" || state === "exhausted" ? state : "unknown",
    remainingPct: readNumber(value.remainingPct) ?? null,
  };
  const saysNothing = state === undefined && policy.priority === null && policy.reservePct === null
    && policy.reclaimAbovePct === null && policy.remainingPct === null;
  return saysNothing ? undefined : policy;
}

/**
 * `accountsWithoutUsage`: stored logins omp has a usage reader for but no
 * attributable reading of. Both 18.8.3 and 18.19.0 print the key (an empty
 * list when nothing is missing; 18.19.0 adds a per-entry `policy`), and an
 * engine that does not print it leaves it absent rather than reading as "none
 * missing". They are kept OUT of the account list on purpose: nothing was
 * measured, so a row would only invent a quota-less account.
 */
function buildUnreportedAccounts(value: unknown): UsageUnreportedAccount[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: UsageUnreportedAccount[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const provider = readString(entry.provider);
    if (!provider) continue;
    const policy = buildPolicy(entry.policy);
    rows.push({
      provider,
      type: entry.type === "api_key" ? "api_key" : "oauth",
      identity: readString(entry.email) ?? readString(entry.orgName) ?? readString(entry.accountId) ?? null,
      accountId: readString(entry.accountId) ?? null,
      ...(policy ? { policy } : {}),
    });
  }
  return rows;
}

/**
 * OMP's resetCredits is a bank of saved rate-limit resets, not a plan limit or
 * a flexible-usage dollar balance. Preserve it only when the engine gives a
 * count; an unrecognized provider payload must not turn into a zero balance.
 */
function buildResetCredits(value: unknown): UsageAccount["resetCredits"] {
  if (!isRecord(value)) return undefined;
  const availableCount = readNumber(value.availableCount);
  if (availableCount === undefined) return undefined;

  let earliestExpiresAt: string | null = null;
  for (const credit of Array.isArray(value.credits) ? value.credits : []) {
    if (!isRecord(credit)) continue;
    // omp's own banked rule: a credit counts toward the balance only while it
    // has an expiry, uses remaining, and has not been redeemed. A spent one
    // must not pull the "expires soon" date earlier.
    if (readNumber(credit.remainingCount) === 0 || readString(credit.status)?.toLowerCase() === "redeemed") continue;
    const expiresAt = toIsoString(readString(credit.expiresAt));
    if (expiresAt && (earliestExpiresAt === null || expiresAt < earliestExpiresAt)) {
      earliestExpiresAt = expiresAt;
    }
  }

  return { availableCount: Math.max(0, Math.trunc(availableCount)), earliestExpiresAt };
}

function buildWindow(
  limit: Record<string, unknown>,
  provider: string,
  position: number,
  seenIds: Set<string>,
): UsageWindow | null {
  const status = readString(limit.status);
  const explicitlyExhausted = status !== undefined && EXHAUSTED_STATUSES.has(status.toLowerCase());
  const utilization = resolveUtilization(limit) ?? (explicitlyExhausted ? 100 : undefined);
  if (utilization === undefined) return null;

  const scope = isRecord(limit.scope) ? limit.scope : {};
  const windowInfo = isRecord(limit.window) ? limit.window : {};
  const baseId = readString(limit.id) ?? `${provider}:${readString(scope.windowId) ?? position}`;
  let id = baseId;
  for (let suffix = 2; seenIds.has(id); suffix += 1) id = `${baseId}#${suffix}`;
  seenIds.add(id);

  const amount = buildAmount(limit);
  return {
    id,
    label: buildWindowLabel(limit, scope, windowInfo),
    utilization,
    resetsAt: toIsoString(readNumber(windowInfo.resetsAt) ?? readString(windowInfo.resetsAt)),
    state: deriveUsageWindowState(utilization, status),
    windowMs: windowSpanMs(readString(windowInfo.id) ?? readString(scope.windowId), readNumber(windowInfo.durationMs)),
    // The scope survives past the label so a window can be matched against the
    // selected model later: the label alone cannot say whether "Opus · weekly"
    // constrains the model in the composer right now.
    tier: readString(scope.tier)?.trim().toLowerCase() ?? null,
    shared: scope.shared === true,
    ...(amount ? { amount } : {}),
  };
}

/** Money and credit meters (a LiteLLM key budget in usd, a Codex spend cap in
 * credits, Cursor's dollar pools) keep their own numbers so the UI can print
 * "$12 of $40" beside the percentage. Percent windows have nothing to add. */
const MONEY_UNITS = new Set(["usd", "credits"]);

function buildAmount(limit: Record<string, unknown>): UsageWindowAmount | undefined {
  const amount = isRecord(limit.amount) ? limit.amount : null;
  const unit = readString(amount?.unit)?.trim().toLowerCase();
  if (!amount || !unit || !MONEY_UNITS.has(unit)) return undefined;
  return { unit, used: readNumber(amount.used) ?? null, limit: readNumber(amount.limit) ?? null };
}

/**
 * Used fraction, mirroring omp's own resolveUsedFraction precedence: explicit
 * fraction, then used/limit, then a percent-unit amount, then inverted
 * remaining. Returns a 0-100 percentage rounded to two places — state is
 * derived from the same rounded number so a bar reading 100% is never "ok".
 */
function resolveUtilization(limit: Record<string, unknown>): number | undefined {
  const amount = isRecord(limit.amount) ? limit.amount : {};
  const usedFraction = readNumber(amount.usedFraction);
  const used = readNumber(amount.used);
  const max = readNumber(amount.limit);
  const remainingFraction = readNumber(amount.remainingFraction);

  let fraction: number | undefined;
  if (usedFraction !== undefined) fraction = usedFraction;
  else if (used !== undefined && max !== undefined && max > 0) fraction = used / max;
  else if (amount.unit === "percent" && used !== undefined) fraction = used / 100;
  else if (remainingFraction !== undefined) fraction = Math.max(0, 1 - remainingFraction);
  if (fraction === undefined) return undefined;

  return Math.round(Math.min(100, Math.max(0, fraction * 100)) * 100) / 100;
}

/** github-copilot marks unmetered buckets with an "Unlimited" note and omits
 * the amounts entirely; without this they would read as a fresh empty quota. */
function isUnlimitedLimit(limit: Record<string, unknown>): boolean {
  const notes = Array.isArray(limit.notes) ? limit.notes : [];
  return notes.some((note) => typeof note === "string" && note.trim().toLowerCase() === "unlimited");
}

const WINDOW_ID_RE = /^(\d+)([hdm])$/i;
const NAMED_WINDOWS = new Set(["hourly", "daily", "weekly", "monthly"]);

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NAMED_WINDOW_SPANS: Record<string, number> = {
  hourly: HOUR_MS,
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
};

/** Window span in milliseconds, preferring the engine's own duration when it
 * reports one, else read off the same window identities windowPhrase names
 * ("5h", "7d", "weekly"). Null when neither says: selection sorts an unknown
 * span last rather than guessing how long it lasts. */
function windowSpanMs(windowId: string | undefined, durationMs: number | undefined): number | null {
  if (durationMs !== undefined && durationMs > 0) return durationMs;
  const id = windowId?.trim().toLowerCase();
  if (!id) return null;
  const named = NAMED_WINDOW_SPANS[id];
  if (named !== undefined) return named;
  const match = WINDOW_ID_RE.exec(id);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return null;
  const unit = match[2]!.toLowerCase();
  return count * (unit === "d" ? DAY_MS : unit === "h" ? HOUR_MS : 60_000);
}

/** Turn omp's window identity into short display copy: "7d" reads as "weekly",
 * "5h" as "5-hour window". Falls back to omp's own labels when the window id is
 * not one of the recognized spans. */
function windowPhrase(windowId: string | undefined, windowLabel: string | undefined): string | undefined {
  const id = windowId?.trim().toLowerCase();
  if (id) {
    if (NAMED_WINDOWS.has(id)) return id;
    const match = WINDOW_ID_RE.exec(id);
    if (match) {
      const count = Number(match[1]);
      const unit = match[2]!.toLowerCase();
      if (Number.isFinite(count) && count > 0) {
        if (unit === "d" && count === 1) return "daily";
        if (unit === "d" && count === 7) return "weekly";
        if (unit === "d" && count === 30) return "monthly";
        if (unit === "h" && count === 24) return "daily";
        const noun = unit === "d" ? "day" : unit === "h" ? "hour" : "minute";
        return `${count}-${noun} window`;
      }
    }
  }
  const label = windowLabel?.trim();
  if (!label || label.toLowerCase() === "quota window") return undefined;
  return label.toLowerCase();
}

function buildWindowLabel(
  limit: Record<string, unknown>,
  scope: Record<string, unknown>,
  windowInfo: Record<string, unknown>,
): string {
  const windowId = readString(windowInfo.id) ?? readString(scope.windowId);
  const base =
    windowPhrase(windowId, readString(windowInfo.label))
    ?? readString(limit.label)
    ?? windowId
    ?? DEFAULT_WINDOW_LABEL;
  const tier = readString(scope.tier);
  // A LiteLLM budget names whose money it caps in its id; the engine's own
  // label does not say.
  const litellm = /^litellm:(key|user):budget$/i.exec(readString(limit.id) ?? "");
  if (litellm) return `${litellm[1]!.toLowerCase()} budget`;
  // "credits" is a billing meter, not a model: a Codex seat billed by credits
  // has one spend cap over the whole account, so it must not read as a tier.
  if (tier?.trim().toLowerCase() === "credits") {
    return sanitizeLabel(/spend/i.test(base) ? "credit spend cap" : `${base} credits`, DEFAULT_WINDOW_LABEL);
  }
  const label = tier && !base.toLowerCase().includes(tier.toLowerCase()) ? `${titleCase(tier)} · ${base}` : base;
  return sanitizeLabel(label, DEFAULT_WINDOW_LABEL);
}

function buildAccountLabel(
  provider: string,
  metadata: Record<string, unknown>,
  index: number,
  disambiguate: boolean,
): string {
  const name = provider
    .split(/[-_]/g)
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
    .filter(Boolean)
    .join(" ");
  const base = name || provider;
  if (!disambiguate) return sanitizeLabel(base, DEFAULT_ACCOUNT_LABEL);
  // Two subscriptions can share one provider (and one email), so a second row
  // for the same provider gets whichever identity omp actually reported.
  const discriminator =
    readString(metadata.orgName) ??
    readString(metadata.email) ??
    readString(metadata.accountId) ??
    `account ${index + 1}`;
  return sanitizeLabel(`${base} (${discriminator})`, `${DEFAULT_ACCOUNT_LABEL} ${index + 1}`);
}

function titleCase(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function sanitizeLabel(value: string, fallback: string): string {
  // Provider-supplied text lands in the UI verbatim; strip control characters
  // (omp sanitizes the same way before rendering) and collapse the leftovers.
  const cleaned = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  // A label made entirely of control characters cleans down to nothing, and an
  // empty label would render as a bare percentage naming no window at all —
  // so the fallback has to survive sanitizing, not just the lookup above it.
  if (!cleaned) return fallback;
  return cleaned.length > MAX_LABEL_LENGTH ? `${cleaned.slice(0, MAX_LABEL_LENGTH - 1)}…` : cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** omp reports reset times as epoch milliseconds; a future omp emitting ISO
 * strings still lands here rather than being dropped. */
function toIsoString(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
