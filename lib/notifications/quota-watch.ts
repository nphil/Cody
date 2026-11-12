import { createHash, randomBytes } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { getNotificationsStatePath } from "../auth/paths";
import { listOmpCredentials, type OmpCredentialsSnapshot } from "../harness/omp-credentials";
import { effectiveTimeZone } from "../time-zone-prefs";
import { formatToolTime } from "../tool-time";
import { isRecord } from "../type-guards";
import { getUsageSnapshot } from "../usage/cache";
import { usageReaderInstalled } from "../usage/omp-usage";
import type { EngineSession } from "../harness/types";
import type { UsageAccount, UsageSnapshot, UsageWindow } from "../usage/types";
import type { NotificationPrefs } from "./catalog";
import { EVENT_TAGS, buildBody, buildTitle, providerDisplayName } from "./compose";
import { reportNtfyFailure } from "./dispatch";
import { publishNtfy, type NtfyMessage, type NtfyResult, type NtfyTarget } from "./ntfy";
import { recipientsForAccountEvent, type NotificationRecipient } from "./recipients";
import { SIGNED_OUT_PREFIX, describeSignedOut, evaluateSignedOut, signedOutFingerprint } from "./signed-out";
import { isConfigured } from "./store";

/**
 * "Quota running low", "Quota used up" and "Account signed out": the
 * notifications that belong to the instance rather than to a chat.
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
 * A login that has ended (lib/notifications/signed-out.ts) is checked first on
 * the same schedule, so it is announced even when every quota kind is off. That
 * check reads omp's credential store, never usage, and only when someone has the
 * kind on. It also runs once, SIGNED_OUT_BOOT_DELAY_MS after the watcher starts:
 * a login that expired while Cody was down, or overnight with no chat open,
 * should reach the phone without waiting for the next chat.
 *
 * What was announced is remembered in a 0600 file keyed by recipient and by a
 * hash of event, provider, account, window and reset time, so a window that
 * stays past its threshold is announced once, and one that resets and fills
 * again is announced again. The file is pruned as windows reset. A signed-out
 * account is remembered as `so-` plus a hash of its credential row and the cause
 * omp recorded, with no expiry: it is forgotten once that row is no longer
 * signed out (signed in again, or removed) — never because the credentials
 * could not be read, which would announce every old expiry again.
 *
 * The watcher's own state is on globalThis: the observer calls
 * noteTerminalTurn from the request side of the server while the timers belong
 * to the custom server, and they may be separate module instances.
 */

export const QUOTA_AFTER_TURN_DELAY_MS = 60_000;
export const QUOTA_MIN_READ_SPACING_MS = 3 * 60_000;
export const QUOTA_INTERVAL_MS = 10 * 60_000;
/** The one logins check after start: not at once, because starting is busy and the credential read spawns a helper. */
export const SIGNED_OUT_BOOT_DELAY_MS = 30_000;
/** A window with no reset time is remembered this long. */
const NO_RESET_MEMORY_MS = 8 * 24 * 60 * 60 * 1000;
/** Reset times are compared to this granularity: a provider that reports "resets in N seconds" moves the absolute time by seconds between reads. */
const RESET_BUCKET_MS = 15 * 60_000;
/** A signed-out memory lasts until its account stops being signed out, not until a time. */
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

/** The check under way. `quota`: it also reads usage (the one made shortly after start only looks at logins). */
interface InFlightCheck {
  promise: Promise<number>;
  quota: boolean;
}

interface WatchState {
  started: boolean;
  interval: NodeJS.Timeout | undefined;
  /** The scheduled read after a turn, if one is waiting. */
  pending: NodeJS.Timeout | undefined;
  /** The one logins check after start, until it has run. */
  boot: NodeJS.Timeout | undefined;
  lastReadAt: number;
  inFlight: InFlightCheck | null;
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
    globalThis.__codyQuotaWatch = { started: false, interval: undefined, pending: undefined, boot: undefined, lastReadAt: 0, inFlight: null, deps: {} };
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
        provider: providerDisplayName(account.provider),
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
  /** recipient key -> fingerprint -> when the memory expires (epoch ms; NEVER_EXPIRES for a signed-out account). */
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

/**
 * Forget what no longer applies, and anyone left with nothing: a quota memory
 * once its window has reset, a signed-out memory once its account is not signed
 * out any more. `signedOut` is the fingerprints of the accounts signed out right
 * now, from a credential read that worked; a pass without it leaves signed-out
 * memories alone.
 */
function prune(state: StateFile, now: number, signedOut?: ReadonlySet<string>): void {
  for (const [key, known] of Object.entries(state.recipients)) {
    for (const [fingerprint, expiresAt] of Object.entries(known)) {
      const over = fingerprint.startsWith(SIGNED_OUT_PREFIX) ? signedOut !== undefined && !signedOut.has(fingerprint) : expiresAt <= now;
      if (over) delete known[fingerprint];
    }
    if (Object.keys(known).length === 0) delete state.recipients[key];
  }
}

/** Prune, then write the file if anything was added or forgotten. */
function pruneAndSave(state: StateFile, added: boolean, now: number, signedOut?: ReadonlySet<string>): void {
  const before = JSON.stringify(state.recipients);
  prune(state, now, signedOut);
  if (added || JSON.stringify(state.recipients) !== before) writeState(state);
}

export interface QuotaCheckDeps {
  now?: () => number;
  readerInstalled?: () => boolean;
  readUsage?: () => Promise<UsageSnapshot>;
  listCredentials?: () => Promise<OmpCredentialsSnapshot>;
  recipients?: () => NotificationRecipient[];
  publish?: (target: NtfyTarget, message: NtfyMessage) => Promise<NtfyResult>;
}

/** Someone who wants a quota notification and has somewhere to receive it. */
function wantsQuotaNotifications(recipient: NotificationRecipient): boolean {
  return isConfigured(recipient.prefs) && (recipient.prefs.events.quotaLow.enabled || recipient.prefs.events.quotaOut.enabled);
}

/** Someone who wants to hear that a login ended and has somewhere to receive it. */
function wantsSignedOutNotifications(recipient: NotificationRecipient): boolean {
  return isConfigured(recipient.prefs) && recipient.prefs.events.accountSignedOut.enabled;
}

/**
 * Tell each person, once, about every account whose login has ended. Reads
 * omp's credential store and nothing else, and only when someone wants to hear.
 */
async function announceSignedOut(deps: QuotaCheckDeps): Promise<number> {
  if (!(deps.readerInstalled ?? usageReaderInstalled)()) return 0;
  const recipients = (deps.recipients ?? recipientsForAccountEvent)().filter(wantsSignedOutNotifications);
  if (recipients.length === 0) return 0;

  const stored = await (deps.listCredentials ?? listOmpCredentials)();
  // An unreadable store says nothing about who is signed out: announce nothing and, above all, forget nothing.
  if (!stored.available) return 0;

  // Every stored account counts for the memory, whatever anyone's settings: a login that is no longer ended is forgotten for everybody.
  const alerts = evaluateSignedOut(stored.credentials).map((alert) => ({ alert, fingerprint: signedOutFingerprint(alert) }));
  const state = readState();
  const publish = deps.publish ?? ((target, message) => publishNtfy(target, message));
  let sent = 0;
  let changed = false;
  for (const recipient of recipients) {
    const { prefs } = recipient;
    const known = state.recipients[recipient.key] ?? {};
    const target: NtfyTarget = { server: prefs.server, topic: prefs.topic, token: prefs.token };
    for (const { alert, fingerprint } of alerts) {
      if (known[fingerprint] !== undefined) continue;
      const { title, body } = describeSignedOut(alert);
      const result = await publish(target, {
        title,
        message: body,
        priority: prefs.events.accountSignedOut.priority,
        tags: [EVENT_TAGS.accountSignedOut],
        ...(prefs.codyUrl ? { click: `${prefs.codyUrl}/?settings=providers` } : {}),
      });
      if (!result.ok) {
        // Not remembered, so the next check tries again.
        reportNtfyFailure(recipient.key, target.server, "publish", result);
        continue;
      }
      known[fingerprint] = NEVER_EXPIRES;
      state.recipients[recipient.key] = known;
      sent += 1;
      changed = true;
    }
  }
  pruneAndSave(state, changed, (deps.now ?? Date.now)(), new Set(alerts.map((entry) => entry.fingerprint)));
  return sent;
}

/** Read quota and tell each person, once per window, about every one that crossed a line they care about. */
async function announceQuota(deps: QuotaCheckDeps): Promise<number> {
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
  pruneAndSave(state, changed, now);
  return sent;
}

/**
 * One pass. Logins first, so a login that ended is announced even when every
 * quota kind is off; then quota, when `withQuota`. The stages do not depend on
 * each other: each answers for its own failure, and nothing here throws.
 */
async function check(deps: QuotaCheckDeps, withQuota: boolean): Promise<number> {
  let sent = 0;
  try {
    sent += await announceSignedOut(deps);
  } catch (error) {
    console.warn("[notifications] signed-out check failed:", error instanceof Error ? error.message : error);
  }
  if (!withQuota) return sent;
  try {
    sent += await announceQuota(deps);
  } catch (error) {
    console.warn("[notifications] quota check failed:", error instanceof Error ? error.message : error);
  }
  return sent;
}

/**
 * One pass at a time. A call made while one runs joins it, unless it needs more
 * than that pass does: the check made shortly after start only looks at logins
 * and reads no usage, so a full pass asked for meanwhile waits its turn.
 */
function run(deps: QuotaCheckDeps, quota: boolean): Promise<number> {
  const state = watchState();
  const running = state.inFlight;
  if (running && (running.quota || !quota)) return running.promise;
  const next: InFlightCheck = {
    quota,
    promise: (running ? running.promise.then(() => check(deps, quota)) : check(deps, quota)).finally(() => {
      if (state.inFlight === next) state.inFlight = null;
    }),
  };
  state.inFlight = next;
  return next.promise;
}

/**
 * Announce any login that has ended, then read quota now and announce what
 * crossed a line. Resolves to how many notifications were sent; never rejects.
 * One pass at a time: a second call made while one runs joins it.
 */
export function runQuotaCheck(deps: QuotaCheckDeps = {}): Promise<number> {
  return run(deps, true);
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

/** Begin watching. Idempotent. `deps` replaces the collaborators scheduled reads use (a test seam). Also schedules the one logins check made shortly after start. */
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
  const boot = setTimeout(() => {
    state.boot = undefined;
    if (state.started) void run(state.deps, false);
  }, SIGNED_OUT_BOOT_DELAY_MS);
  boot.unref?.();
  state.boot = boot;
}

/** Stop watching and drop any read waiting to happen. Idempotent. */
export function stopQuotaWatch(): void {
  const state = watchState();
  clearInterval(state.interval);
  clearTimeout(state.pending);
  clearTimeout(state.boot);
  state.interval = undefined;
  state.pending = undefined;
  state.boot = undefined;
  state.started = false;
  state.deps = {};
}
