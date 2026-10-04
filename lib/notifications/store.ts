import { randomBytes } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { getNotificationsPath } from "../auth/paths";
import { listUsers, type UserRecord } from "../auth/users";
import { isRecord } from "../type-guards";
import {
  FINISHED_MIN_SECONDS_MAX,
  NOTIFICATION_EVENT_IDS,
  NTFY_TOPIC_RE,
  QUOTA_LOW_PERCENT_MAX,
  QUOTA_LOW_PERCENT_MIN,
  defaultNotificationPrefs,
  isNotificationEventId,
  type NotificationEventId,
  type NotificationEventPrefs,
  type NotificationPrefs,
  type NotificationPrefsPatch,
  type NtfyPriority,
  type PublicNotificationPrefs,
} from "./catalog";

/**
 * Where each account's ntfy settings live: `<accounts dir>/notifications.json`,
 * written atomically with 0600 permissions because it carries ntfy access
 * tokens. One record per account id, plus one for an OPEN instance (no
 * accounts: whoever is looking is the administrator, exactly as the other
 * open-instance preferences work — lib/time-zone-prefs.ts).
 *
 * Reads are defensive: the file is Cody's own but the user can hand-edit it, so
 * every value is re-checked against the same rules a write uses and an invalid
 * one falls back to the default. Writes are strict: an invalid value is an
 * error the Settings page can show, never something silently stored.
 */

/** The recipient key of the open-instance record. */
export const INSTANCE_RECIPIENT_KEY = "__instance";

const TOKEN_MAX_LENGTH = 512;
const URL_MAX_LENGTH = 2048;

interface NotificationsFile {
  version: 1;
  accounts: Record<string, NotificationPrefs>;
  instance?: NotificationPrefs;
}

/** A write the store refused. `code` is what the route puts on the 400. */
export class InvalidNotificationSettingsError extends Error {
  readonly code = "invalid_notification_settings";

  constructor(message: string) {
    super(message);
    this.name = "InvalidNotificationSettingsError";
  }
}

/** The recipient key an actor reads and writes under. */
export function recipientKeyFor(user: UserRecord | null): string {
  return user ? user.id : INSTANCE_RECIPIENT_KEY;
}

/** "Configured" = switched on and told where to publish. */
export function isConfigured(prefs: NotificationPrefs): boolean {
  return prefs.enabled && prefs.server !== "" && prefs.topic !== "";
}

/**
 * A base URL as stored: http(s), no credentials, query or fragment, no trailing
 * slash. `""` (unset) is valid. Null means the value is not acceptable.
 */
export function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return "";
  // The raw text is checked as well as the parsed URL: `https://host/?` parses
  // to an empty query, but it is still a query the user typed.
  if (text.length > URL_MAX_LENGTH || /[\s?#]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

type Checked<T> = { value: T } | null;

function checkBoolean(value: unknown): Checked<boolean> {
  return typeof value === "boolean" ? { value } : null;
}

function checkInteger(min: number, max: number): (value: unknown) => Checked<number> {
  return (value) => (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? { value } : null);
}

function checkBaseUrl(value: unknown): Checked<string> {
  const normalized = normalizeBaseUrl(value);
  return normalized === null ? null : { value: normalized };
}

function checkTopic(value: unknown): Checked<string> {
  if (typeof value !== "string") return null;
  const topic = value.trim();
  return topic === "" || NTFY_TOPIC_RE.test(topic) ? { value: topic } : null;
}

/** Printable ASCII with no spaces: what can sit in an `Authorization` header. */
function checkToken(value: unknown): Checked<string> {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return token.length <= TOKEN_MAX_LENGTH && /^[\x21-\x7e]*$/.test(token) ? { value: token } : null;
}

const checkPriority = checkInteger(1, 5);

/** One entry per scalar setting: how to check it, and what to say when it is wrong. */
const SCALAR_FIELDS = {
  enabled: { check: checkBoolean, message: "enabled must be true or false" },
  server: {
    check: checkBaseUrl,
    message: "The ntfy server must be an http(s) address without a username, query or fragment (or empty)",
  },
  topic: { check: checkTopic, message: "The topic may only contain letters, numbers, dashes and underscores (up to 64), or be empty" },
  codyUrl: {
    check: checkBaseUrl,
    message: "The Cody address must be an http(s) address without a username, query or fragment (or empty)",
  },
  answerButtons: { check: checkBoolean, message: "answerButtons must be true or false" },
  skipWhenViewing: { check: checkBoolean, message: "skipWhenViewing must be true or false" },
  finishedMinSeconds: {
    check: checkInteger(0, FINISHED_MIN_SECONDS_MAX),
    message: `finishedMinSeconds must be a whole number from 0 to ${FINISHED_MIN_SECONDS_MAX}`,
  },
  quotaLowPercent: {
    check: checkInteger(QUOTA_LOW_PERCENT_MIN, QUOTA_LOW_PERCENT_MAX),
    message: `quotaLowPercent must be a whole number from ${QUOTA_LOW_PERCENT_MIN} to ${QUOTA_LOW_PERCENT_MAX}`,
  },
} as const;

type ScalarKey = keyof typeof SCALAR_FIELDS;
const SCALAR_KEYS = Object.keys(SCALAR_FIELDS) as ScalarKey[];

/** Keys a PUT body may carry besides the scalar settings. `hasToken` is what GET
 * reports; a client that sends the whole thing back is not wrong, and it is
 * never stored. */
const EXTRA_PATCH_KEYS = ["token", "events", "hasToken"];

const TOKEN_MESSAGE = `The access token must be printable characters without spaces, up to ${TOKEN_MAX_LENGTH}`;
const PRIORITY_MESSAGE = "priority must be a whole number from 1 to 5";

function clip(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The strict half: a PUT body that is acceptable, in the form it is stored
 * (addresses normalized, token trimmed). Anything else throws.
 */
export function validateNotificationPatch(input: unknown): NotificationPrefsPatch {
  if (!isRecord(input)) throw new InvalidNotificationSettingsError("The settings must be an object");
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(SCALAR_FIELDS, key) && !EXTRA_PATCH_KEYS.includes(key)) {
      throw new InvalidNotificationSettingsError(`Unknown setting "${clip(key)}"`);
    }
  }
  for (const key of SCALAR_KEYS) {
    if (input[key] === undefined) continue;
    const field = SCALAR_FIELDS[key];
    const checked = field.check(input[key]);
    if (!checked) throw new InvalidNotificationSettingsError(field.message);
    patch[key] = checked.value;
  }
  if (input.token !== undefined) {
    if (input.token === null) {
      patch.token = null;
    } else {
      const checked = checkToken(input.token);
      if (!checked) throw new InvalidNotificationSettingsError(TOKEN_MESSAGE);
      patch.token = checked.value;
    }
  }
  if (input.events !== undefined) {
    if (!isRecord(input.events)) throw new InvalidNotificationSettingsError("events must be an object");
    const events: Partial<Record<NotificationEventId, Partial<NotificationEventPrefs>>> = {};
    for (const [id, raw] of Object.entries(input.events)) {
      if (!isNotificationEventId(id)) throw new InvalidNotificationSettingsError(`Unknown notification kind "${clip(id)}"`);
      if (!isRecord(raw)) throw new InvalidNotificationSettingsError(`The settings for "${id}" must be an object`);
      const entry: Partial<NotificationEventPrefs> = {};
      for (const key of Object.keys(raw)) {
        if (key !== "enabled" && key !== "priority") throw new InvalidNotificationSettingsError(`Unknown setting "${clip(key)}" for "${id}"`);
      }
      if (raw.enabled !== undefined) {
        const checked = checkBoolean(raw.enabled);
        if (!checked) throw new InvalidNotificationSettingsError(`enabled for "${id}" must be true or false`);
        entry.enabled = checked.value;
      }
      if (raw.priority !== undefined) {
        const checked = checkPriority(raw.priority);
        if (!checked) throw new InvalidNotificationSettingsError(`${PRIORITY_MESSAGE} (${id})`);
        entry.priority = checked.value as NtfyPriority;
      }
      events[id] = entry;
    }
    patch.events = events;
  }
  return patch as NotificationPrefsPatch;
}

/** A validated patch laid over the current record. `events` merges per kind and per field. */
export function applyNotificationPatch(current: NotificationPrefs, patch: NotificationPrefsPatch): NotificationPrefs {
  const next: NotificationPrefs = { ...current, events: { ...current.events } };
  for (const key of SCALAR_KEYS) {
    const value = patch[key];
    if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
  }
  if (patch.token !== undefined) next.token = patch.token === null ? "" : patch.token;
  for (const id of NOTIFICATION_EVENT_IDS) {
    const entry = patch.events?.[id];
    if (entry) next.events[id] = { ...current.events[id], ...entry };
  }
  return next;
}

/**
 * The lenient half: whatever was on disk, as a complete record. Unknown keys
 * are dropped and an invalid value falls back to the default, so a hand edit
 * can never make the page (or the observer) throw.
 */
export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
  const prefs = defaultNotificationPrefs();
  if (!isRecord(raw)) return prefs;
  for (const key of SCALAR_KEYS) {
    const checked = SCALAR_FIELDS[key].check(raw[key]);
    if (checked) (prefs as unknown as Record<string, unknown>)[key] = checked.value;
  }
  const token = checkToken(raw.token);
  if (token) prefs.token = token.value;
  if (isRecord(raw.events)) {
    for (const id of NOTIFICATION_EVENT_IDS) {
      const stored = raw.events[id];
      if (!isRecord(stored)) continue;
      const enabled = checkBoolean(stored.enabled);
      const priority = checkPriority(stored.priority);
      prefs.events[id] = {
        enabled: enabled ? enabled.value : prefs.events[id].enabled,
        priority: priority ? (priority.value as NtfyPriority) : prefs.events[id].priority,
      };
    }
  }
  return prefs;
}

function readFile(): NotificationsFile {
  const empty: NotificationsFile = { version: 1, accounts: {} };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getNotificationsPath(), "utf8"));
    if (!isRecord(parsed)) return empty;
    const accounts: Record<string, NotificationPrefs> = {};
    if (isRecord(parsed.accounts)) {
      for (const [userId, record] of Object.entries(parsed.accounts)) accounts[userId] = parseNotificationPrefs(record);
    }
    return { version: 1, accounts, ...(isRecord(parsed.instance) ? { instance: parseNotificationPrefs(parsed.instance) } : {}) };
  } catch {
    return empty;
  }
}

function writeFile(file: NotificationsFile): void {
  const target = getNotificationsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** A recipient's saved settings; the defaults when it has saved none. */
export function readNotificationPrefs(recipientKey: string): NotificationPrefs {
  const file = readFile();
  const stored = recipientKey === INSTANCE_RECIPIENT_KEY ? file.instance : file.accounts[recipientKey];
  return stored ?? defaultNotificationPrefs();
}

/**
 * Validate `patch`, lay it over the recipient's record and save it. Throws
 * InvalidNotificationSettingsError before anything is written.
 *
 * A deleted account's record goes with it the next time anyone saves: its ntfy
 * token must not outlive the person it belonged to. Nothing is pruned while the
 * account store reads as empty, so a lost accounts file cannot wipe settings.
 */
export function updateNotificationPrefs(recipientKey: string, patch: unknown): NotificationPrefs {
  const validated = validateNotificationPatch(patch);
  const file = readFile();
  const current = recipientKey === INSTANCE_RECIPIENT_KEY ? file.instance : file.accounts[recipientKey];
  const next = applyNotificationPatch(current ?? defaultNotificationPrefs(), validated);
  if (recipientKey === INSTANCE_RECIPIENT_KEY) file.instance = next;
  else file.accounts[recipientKey] = next;
  const live = new Set(listUsers().map((user) => user.id));
  if (live.size > 0) {
    for (const userId of Object.keys(file.accounts)) {
      if (!live.has(userId)) delete file.accounts[userId];
    }
  }
  writeFile(file);
  return next;
}

/** What GET returns: everything but the token, which is reduced to a flag. Shares nothing mutable with the record it came from. */
export function toPublicPrefs(prefs: NotificationPrefs): PublicNotificationPrefs {
  const { token, events, ...rest } = prefs;
  const copy = {} as Record<NotificationEventId, NotificationEventPrefs>;
  for (const id of NOTIFICATION_EVENT_IDS) copy[id] = { ...events[id] };
  return { ...rest, events: copy, hasToken: token !== "" };
}
