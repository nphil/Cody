import { createHash, randomBytes } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { getNotificationsStatePath } from "../auth/paths";
import { providerBrand } from "../provider-brand";
import { effectiveTimeZone } from "../time-zone-prefs";
import { formatToolTime } from "../tool-time";
import { isRecord } from "../type-guards";
import { getUsageSnapshot } from "../usage/cache";
import { usageReaderInstalled } from "../usage/omp-usage";
import type { EngineSession } from "../harness/types";
import type { UsageAccount, UsageSnapshot, UsageWindow } from "../usage/types";
import type { NotificationPrefs } from "./catalog";
import { EVENT_TAGS, buildBody, buildTitle } from "./compose";
import { reportNtfyFailure } from "./dispatch";
import { publishNtfy, type NtfyMessage, type NtfyResult, type NtfyTarget } from "./ntfy";
import { recipientsForAccountEvent, type NotificationRecipient } from "./recipients";
import { isConfigured } from "./store";

/**
 * "Quota running low" and "Quota used up": the notifications that belong to the
 * instance rather than to a chat.
 *
 * Nothing in Cody reads quota on its own — the usage ring only refreshes while a
 * browser tab polls — and the point of these notifications is the owner who has
 * no tab open. So this watcher reads the same shared snapshot
 * (lib/usage/cache.ts, one `omp usage` spawn however many callers) at two
 * moments, and never blindly:
 *  - a minute after a chat's run ends (quota moved because of that run), but
 *    never more than once in three minutes;
 *  - every ten minutes while any chat is live.
 * It reads nothing at all unless the usage reader is installed and someone has
 * a quota notification switched on. Timers are unref'd, and the whole thing is
 * started and stopped from bin/cody-server.js beside the engine housekeeping.
 *
 * What was announced is remembered in a 0600 file keyed by recipient and by a
 * hash of event, provider, account, window and reset time, so a window that
 * stays past its threshold is announced once, and one that resets and fills
 * again is announced again. The file is pruned as windows reset.
 *
 * The watcher's own state is on globalThis: the observer calls
 * noteTerminalTurn from the request side of the server while the timers belong
 * to the custom server, and they may be separate module instances.
 */

export const QUOTA_AFTER_TURN_DELAY_MS = 60_000;
export const QUOTA_MIN_READ_SPACING_MS = 3 * 60_000;
export const QUOTA_INTERVAL_MS = 10 * 60_000;
/** A window with no reset time is remembered this long. */
const NO_RESET_MEMORY_MS = 8 * 24 * 60 * 60 * 1000;
/** Reset times are compared to this granularity: a provider that reports "resets in N seconds" moves the absolute time by seconds between reads. */
const RESET_BUCKET_MS = 15 * 60_000;

interface WatchState {
  started: boolean;
  interval: NodeJS.Timeout | undefined;
  /** The scheduled read after a turn, if one is waiting. */
  pending: NodeJS.Timeout | undefined;
  lastReadAt: number;
  inFlight: Promise<number> | null;
  /** What scheduled reads use; production passes nothing, a test passes its own. */
  deps: QuotaCheckDeps;
}

declare global {
  var __codyQuotaWatch: WatchState | undefined;
  /** The live-session registry lib/rpc-manager.ts keeps; read here only to know whether any chat is live. */
  var __ompSessions: Map<string, EngineSession> | undefined;
}

function watchState(): WatchState {
  if (!globalThis.__codyQuotaWatch) {
    globalThis.__codyQuotaWatch = { started: false, interval: undefined, pending: undefined, lastReadAt: 0, inFlight: null, deps: {} };
  }
  return globalThis.__codyQuotaWatch;
}

/** One window that deserves a message. */
export interface QuotaAlert {
  event: "quotaLow" | "quotaOut";
  /** The provider as the owner knows it ("Claude", "Codex"). */
  provider: string;
  /** 1-based position among this provider's accounts, in the snapshot's order. Never an email. */
  position: number;
  accountCount: number;
  window: string;
  utilization: number;
  resetsAt: string | null;
  /** The provider refused one request and omp set a deadline: nothing measured the quota. */
  blocked: boolean;
  /** Hash of what makes this alert the same alert next time. */
  fingerprint: string;
  /** When the memory of it can go: its window will have reset. */
  expiresAt: number;
}

function titleCase(provider: string): string {
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function providerName(provider: string): string {
  return providerBrand(provider)?.name ?? (titleCase(provider) || provider);
}

function isExhausted(window: UsageWindow): boolean {
  return window.state === "exhausted" || window.utilization >= 100 || window.source === "block";
}

/**
 * Every window of `snapshot` that crosses a line `prefs` cares about: spent (a
 * measured window at its limit, or a provider block) or past the recipient's
 * warning percentage. Pure: nothing here knows what was announced before.
 */
export function evaluateQuota(snapshot: UsageSnapshot, prefs: NotificationPrefs, now: number): QuotaAlert[] {
  const accounts: UsageAccount[] = snapshot.accounts;
  const alerts: QuotaAlert[] = [];
  for (const account of accounts) {
    if (account.unlimited || account.disabled) continue;
    const siblings = accounts.filter((other) => other.provider === account.provider);
    for (const window of account.windows) {
      const resetsMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
      // The reading predates this window's reset: it is no longer true.
      if (Number.isFinite(resetsMs) && resetsMs <= now) continue;
      const event = isExhausted(window) ? "quotaOut" : window.utilization >= prefs.quotaLowPercent ? "quotaLow" : null;
      if (!event || !prefs.events[event].enabled) continue;
      const resetBucket = Number.isFinite(resetsMs) ? Math.floor(resetsMs / RESET_BUCKET_MS) : "none";
      alerts.push({
        event,
        provider: providerName(account.provider),
        position: siblings.indexOf(account) + 1,
        accountCount: siblings.length,
        window: window.label,
        utilization: window.utilization,
        resetsAt: Number.isFinite(resetsMs) ? window.resetsAt : null,
        blocked: window.source === "block",
        // Hashed: an account id can be an email, and this lands on disk.
        fingerprint: createHash("sha256").update([event, account.provider, account.id, window.id, resetBucket].join("|")).digest("hex").slice(0, 24),
        expiresAt: Number.isFinite(resetsMs) ? resetsMs : now + NO_RESET_MEMORY_MS,
      });
    }
  }
  return alerts;
}

/** What one alert says to one person, with the reset time in their own zone. */
export function describeQuotaAlert(alert: QuotaAlert, zone: string): { title: string; body: string } {
  const who = alert.accountCount > 1 ? `Account ${alert.position}/${alert.accountCount}: ` : "";
  const reset = alert.resetsAt ? formatToolTime(alert.resetsAt, zone) : null;
  let body: string;
  if (alert.event === "quotaLow") {
    body = `${who}${alert.window} is at ${Math.round(alert.utilization)}% of its limit.${reset ? ` Resets ${reset}.` : ""}`;
  } else if (alert.blocked) {
    body = `${who}The provider blocked this account (${alert.window}).${reset ? ` Expected back ${reset}.` : ""}`;
  } else {
    body = `${who}${alert.window} is used up.${reset ? ` Resets ${reset}.` : ""}`;
  }
  return { title: buildTitle(alert.event, alert.provider), body: buildBody(body) };
}

interface StateFile {
  version: 1;
  /** recipient key -> fingerprint -> when the memory expires (epoch ms). */
  recipients: Record<string, Record<string, number>>;
}

function readState(): StateFile {
  const state: StateFile = { version: 1, recipients: {} };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getNotificationsStatePath(), "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.recipients)) return state;
    for (const [key, entries] of Object.entries(parsed.recipients)) {
      if (!isRecord(entries)) continue;
      const known: Record<string, number> = {};
      for (const [fingerprint, expiresAt] of Object.entries(entries)) {
        if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) known[fingerprint] = expiresAt;
      }
      state.recipients[key] = known;
    }
  } catch {
    // No file yet, or one that cannot be read: nothing is remembered.
  }
  return state;
}

function writeState(state: StateFile): void {
  const target = getNotificationsStatePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** Forget what has expired, and anyone left with nothing. */
function prune(state: StateFile, now: number): void {
  for (const [key, known] of Object.entries(state.recipients)) {
    for (const [fingerprint, expiresAt] of Object.entries(known)) {
      if (expiresAt <= now) delete known[fingerprint];
    }
    if (Object.keys(known).length === 0) delete state.recipients[key];
  }
}

export interface QuotaCheckDeps {
  now?: () => number;
  readerInstalled?: () => boolean;
  readUsage?: () => Promise<UsageSnapshot>;
  recipients?: () => NotificationRecipient[];
  publish?: (target: NtfyTarget, message: NtfyMessage) => Promise<NtfyResult>;
}

/** Someone who wants a quota notification and has somewhere to receive it. */
function wantsQuotaNotifications(recipient: NotificationRecipient): boolean {
  return isConfigured(recipient.prefs) && (recipient.prefs.events.quotaLow.enabled || recipient.prefs.events.quotaOut.enabled);
}

async function check(deps: QuotaCheckDeps): Promise<number> {
  if (!(deps.readerInstalled ?? usageReaderInstalled)()) return 0;
  const recipients = (deps.recipients ?? recipientsForAccountEvent)().filter(wantsQuotaNotifications);
  if (recipients.length === 0) return 0;

  watchState().lastReadAt = Date.now();
  const snapshot = await (deps.readUsage ?? (() => getUsageSnapshot({ awaitFresh: true })))();
  if (!snapshot.available) return 0;

  const now = (deps.now ?? Date.now)();
  const state = readState();
  const publish = deps.publish ?? ((target, message) => publishNtfy(target, message));
  let sent = 0;
  let changed = false;
  for (const recipient of recipients) {
    const { prefs } = recipient;
    const known = state.recipients[recipient.key] ?? {};
    const zone = effectiveTimeZone(recipient.user).zone;
    const target: NtfyTarget = { server: prefs.server, topic: prefs.topic, token: prefs.token };
    for (const alert of evaluateQuota(snapshot, prefs, now)) {
      if (known[alert.fingerprint] !== undefined) continue;
      const { title, body } = describeQuotaAlert(alert, zone);
      const result = await publish(target, {
        title,
        message: body,
        priority: prefs.events[alert.event].priority,
        tags: [EVENT_TAGS[alert.event]],
        ...(prefs.codyUrl ? { click: prefs.codyUrl } : {}),
      });
      if (!result.ok) {
        // Not remembered, so the next read tries again.
        reportNtfyFailure(recipient.key, target.server, "publish", result);
        continue;
      }
      known[alert.fingerprint] = alert.expiresAt;
      state.recipients[recipient.key] = known;
      sent += 1;
      changed = true;
    }
  }
  const before = JSON.stringify(state.recipients);
  prune(state, now);
  if (changed || JSON.stringify(state.recipients) !== before) writeState(state);
  return sent;
}

/**
 * Read quota now and announce what crossed a line. Resolves to how many
 * notifications were sent; never rejects. One read at a time: a second call
 * made while one runs joins it.
 */
export function runQuotaCheck(deps: QuotaCheckDeps = {}): Promise<number> {
  const state = watchState();
  if (state.inFlight) return state.inFlight;
  const run = check(deps)
    .catch((error: unknown) => {
      console.warn("[notifications] quota check failed:", error instanceof Error ? error.message : error);
      return 0;
    })
    .finally(() => {
      if (state.inFlight === run) state.inFlight = null;
    });
  state.inFlight = run;
  return run;
}

function hasLiveSession(): boolean {
  const registry = globalThis.__ompSessions;
  if (!registry) return false;
  for (const session of registry.values()) {
    if (session.isAlive()) return true;
  }
  return false;
}

/**
 * A chat's run just ended: quota moved, so read it soon. A minute from now, and
 * not within three minutes of the previous read; further runs ending before
 * then are covered by the read already waiting. A no-op until the watcher is
 * started, so nothing reads quota in a process that never asked to.
 */
export function noteTerminalTurn(): void {
  const state = watchState();
  if (!state.started || state.pending) return;
  const delay = Math.max(QUOTA_AFTER_TURN_DELAY_MS, state.lastReadAt + QUOTA_MIN_READ_SPACING_MS - Date.now());
  const timer = setTimeout(() => {
    state.pending = undefined;
    if (state.started) void runQuotaCheck(state.deps);
  }, delay);
  timer.unref?.();
  state.pending = timer;
}

/** Begin watching. Idempotent. `deps` replaces the collaborators scheduled reads use (a test seam). */
export function startQuotaWatch(deps: QuotaCheckDeps = {}): void {
  const state = watchState();
  if (state.started) return;
  state.started = true;
  state.deps = deps;
  const interval = setInterval(() => {
    if (hasLiveSession()) void runQuotaCheck(state.deps);
  }, QUOTA_INTERVAL_MS);
  interval.unref?.();
  state.interval = interval;
}

/** Stop watching and drop any read waiting to happen. Idempotent. */
export function stopQuotaWatch(): void {
  const state = watchState();
  clearInterval(state.interval);
  clearTimeout(state.pending);
  state.interval = undefined;
  state.pending = undefined;
  state.started = false;
  state.deps = {};
}
