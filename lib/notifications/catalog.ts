/**
 * Push notifications (ntfy): the shared vocabulary.
 *
 * Pure and browser-safe — the Settings hub and the server both read it, so the
 * list of notification kinds, their grouping, their defaults and the shape of
 * the settings payload live in exactly one place. Server-only behaviour (the
 * store, the observer, the ntfy client, answer tokens) lives beside it in
 * `lib/notifications/*` and never ships to the browser.
 */

/** Every kind of notification Cody can send. Order is display order. */
export const NOTIFICATION_EVENT_IDS = [
  "approval",
  "question",
  "waiting",
  "finished",
  "subagent",
  "error",
  "fallback",
  "quotaLow",
  "quotaOut",
] as const;

export type NotificationEventId = (typeof NOTIFICATION_EVENT_IDS)[number];

export type NotificationGroupId = "needsYou" | "progress" | "problems";

/** ntfy's own priority scale: 1 min, 2 low, 3 default, 4 high, 5 urgent/max. */
export type NtfyPriority = 1 | 2 | 3 | 4 | 5;

export interface NotificationEventSpec {
  id: NotificationEventId;
  group: NotificationGroupId;
  label: string;
  description: string;
  /** Scoped to one chat (presence suppression applies), or instance-wide (quota). */
  scope: "session" | "account";
  defaultEnabled: boolean;
  defaultPriority: NtfyPriority;
}

/** Settings copy is English-only by project convention (CLAUDE.md). */
export const NOTIFICATION_EVENTS: readonly NotificationEventSpec[] = [
  {
    id: "approval",
    group: "needsYou",
    label: "Approval requests",
    description: "The agent wants permission before running a tool or command.",
    scope: "session",
    defaultEnabled: true,
    defaultPriority: 4,
  },
  {
    id: "question",
    group: "needsYou",
    label: "Questions",
    description: "The agent asked you to pick an option, answer a form or type something.",
    scope: "session",
    defaultEnabled: true,
    defaultPriority: 4,
  },
  {
    id: "waiting",
    group: "needsYou",
    label: "Waiting for your reply",
    description: "The agent finished its turn by asking you something and is paused until you answer.",
    scope: "session",
    defaultEnabled: true,
    defaultPriority: 3,
  },
  {
    id: "finished",
    group: "progress",
    label: "Reply finished",
    description: "The agent finished working and has nothing to ask.",
    scope: "session",
    defaultEnabled: true,
    defaultPriority: 3,
  },
  {
    id: "subagent",
    group: "progress",
    label: "Subagent finished",
    description: "One of the agent's helper subagents completed, failed or was stopped.",
    scope: "session",
    defaultEnabled: false,
    defaultPriority: 2,
  },
  {
    id: "error",
    group: "problems",
    label: "Errors",
    description: "A reply failed with a model or provider error, or the engine stopped unexpectedly.",
    scope: "session",
    defaultEnabled: true,
    defaultPriority: 4,
  },
  {
    id: "fallback",
    group: "problems",
    label: "Model fallback",
    description: "The engine switched to a backup model because the chosen one hit a limit, error or refusal.",
    scope: "session",
    defaultEnabled: false,
    defaultPriority: 2,
  },
  {
    id: "quotaLow",
    group: "problems",
    label: "Quota running low",
    description: "A subscription or plan window passed your warning threshold.",
    scope: "account",
    defaultEnabled: true,
    defaultPriority: 3,
  },
  {
    id: "quotaOut",
    group: "problems",
    label: "Quota used up",
    description: "An account hit its limit, was blocked by the provider, or ran out of credits.",
    scope: "account",
    defaultEnabled: true,
    defaultPriority: 4,
  },
];

export const NOTIFICATION_GROUPS: readonly { id: NotificationGroupId; label: string; description: string }[] = [
  { id: "needsYou", label: "Needs you", description: "The agent is blocked until you answer." },
  { id: "progress", label: "Progress", description: "Work finished while you were away." },
  { id: "problems", label: "Problems", description: "Something went wrong or is about to." },
];

export interface NotificationEventPrefs {
  enabled: boolean;
  priority: NtfyPriority;
}

/** What is stored per account (server side; `token` never leaves the server). */
export interface NotificationPrefs {
  /** Master switch. Nothing is sent while false. */
  enabled: boolean;
  /** ntfy server base URL, e.g. "https://ntfy.sh". No trailing slash. */
  server: string;
  /** ntfy topic: [-_A-Za-z0-9]{1,64}. */
  topic: string;
  /** ntfy access token (tk_…), sent as a Bearer token. Empty = anonymous publish. */
  token: string;
  /**
   * Base URL the phone opens for "Open in Cody" and posts answer buttons to,
   * e.g. "https://cody.example.net". Empty = no links and no buttons.
   */
  codyUrl: string;
  /** Put answer buttons on approvals and simple questions. */
  answerButtons: boolean;
  /** Skip chat notifications for the chat you are looking at right now. */
  skipWhenViewing: boolean;
  /** "Reply finished" only when the run took at least this many seconds (0 = always). */
  finishedMinSeconds: number;
  /** "Quota running low" fires when a window's used percentage reaches this. */
  quotaLowPercent: number;
  events: Record<NotificationEventId, NotificationEventPrefs>;
}

/** What GET /api/notifications returns: the token is replaced by a flag. */
export type PublicNotificationPrefs = Omit<NotificationPrefs, "token"> & { hasToken: boolean };

/**
 * PUT /api/notifications body: any subset. `token`: a string stores it, `null`
 * clears it, absent keeps it. `events` merges per id and per field.
 */
export type NotificationPrefsPatch = Partial<Omit<NotificationPrefs, "token" | "events">> & {
  token?: string | null;
  events?: Partial<Record<NotificationEventId, Partial<NotificationEventPrefs>>>;
};

/** Choices the hub offers; the server accepts any integer in the bounds below. */
export const FINISHED_MIN_SECONDS_CHOICES = [0, 30, 60, 120, 300, 600, 1800] as const;
export const QUOTA_LOW_PERCENT_CHOICES = [50, 70, 80, 90, 95] as const;
export const FINISHED_MIN_SECONDS_MAX = 24 * 60 * 60;
export const QUOTA_LOW_PERCENT_MIN = 1;
export const QUOTA_LOW_PERCENT_MAX = 99;

export const NTFY_TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

export const PRIORITY_LABELS: Record<NtfyPriority, string> = {
  1: "Min",
  2: "Low",
  3: "Default",
  4: "High",
  5: "Urgent",
};

export function isNotificationEventId(value: unknown): value is NotificationEventId {
  return typeof value === "string" && (NOTIFICATION_EVENT_IDS as readonly string[]).includes(value);
}

export function defaultNotificationPrefs(): NotificationPrefs {
  const events = {} as Record<NotificationEventId, NotificationEventPrefs>;
  for (const spec of NOTIFICATION_EVENTS) {
    events[spec.id] = { enabled: spec.defaultEnabled, priority: spec.defaultPriority };
  }
  return {
    enabled: false,
    server: "",
    topic: "",
    token: "",
    codyUrl: "",
    answerButtons: true,
    skipWhenViewing: true,
    finishedMinSeconds: 60,
    quotaLowPercent: 90,
    events,
  };
}
