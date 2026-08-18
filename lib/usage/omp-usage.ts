import { execFile } from "child_process";
import { resolveOmpBin } from "../omp/omp-cli";
import type { UsageAccount, UsageSnapshot, UsageWindow, UsageWindowState } from "./types";

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

/**
 * Spawn the engine's usage command and normalize its output. Resolves to an
 * unavailable snapshot — never rejects — when omp is missing, exits non-zero,
 * exceeds the timeout, or prints something that is not the expected payload.
 */
export function fetchOmpUsageSnapshot(options: { timeoutMs?: number } = {}): Promise<UsageSnapshot> {
  const bin = resolveOmpBin();
  if (!bin) return Promise.resolve(unavailableUsageSnapshot("omp binary not found"));
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
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return unavailableUsageSnapshot("omp usage returned malformed JSON");
  }
  return parseOmpUsagePayload(payload);
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
  const providerCounts = new Map<string, number>();
  for (const report of records) {
    const provider = readString(report.provider);
    if (provider) providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
  }

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
    const account = buildAccount(report, provider, index, (providerCounts.get(provider) ?? 0) > 1);
    if (account) accounts.push(account);
  }

  if (accounts.length === 0) return unavailableUsageSnapshot("omp usage reported no quota windows");

  const generatedAt = readNumber(payload.generatedAt) ?? latestFetchedAt;
  return {
    available: true,
    accounts,
    fetchedAt: toIsoString(generatedAt) ?? new Date().toISOString(),
    stale: false,
  };
}

function buildAccount(
  report: Record<string, unknown>,
  provider: string,
  index: number,
  disambiguate: boolean,
): UsageAccount | null {
  const metadata = isRecord(report.metadata) ? report.metadata : {};
  const limits = Array.isArray(report.limits) ? report.limits.filter(isRecord) : [];
  const unlimited = limits.length > 0 && limits.every(isUnlimitedLimit);

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
    label: buildAccountLabel(provider, metadata, index, disambiguate),
    planType: readString(metadata.planType) ?? null,
    unlimited,
    windows,
  };
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

  return {
    id,
    label: buildWindowLabel(limit, scope, windowInfo),
    utilization,
    resetsAt: toIsoString(readNumber(windowInfo.resetsAt) ?? readString(windowInfo.resetsAt)),
    state: deriveUsageWindowState(utilization, status),
    // The scope survives past the label so a window can be matched against the
    // selected model later: the label alone cannot say whether "Opus · weekly"
    // constrains the model in the composer right now.
    tier: readString(scope.tier)?.trim().toLowerCase() ?? null,
    shared: scope.shared === true,
  };
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
