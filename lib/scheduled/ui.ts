/**
 * Everything the composer's scheduled-send UI decides that is not a React
 * concern: which time chips exist, how a row words its time, why a menu row is
 * off, where the popover sits, how long a press is "long", when the list
 * should be read again, and what the phone's one-line controls row has left
 * for a model name.
 *
 * Pure and browser-safe (no DOM, no Node imports) so each rule has a test that
 * does not need a browser. Times are the DEVICE's: the person is looking at
 * this screen, and "Tonight 11 PM" means the 11 PM on their wall clock.
 */
import { SCHEDULED_LIMITS, isScheduledErrorCode } from "./types";
import type { ScheduledItemView, ScheduledStatus } from "./types";

/** `useI18n().t` / `translate`. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1000;

/* ───────────────────────────────── time chips ───────────────────────────────── */

/** "Tonight" and "Tomorrow" are these wall-clock hours, in the device's zone. */
export const TONIGHT_HOUR = 23;
export const TOMORROW_HOUR = 9;

/**
 * The instant at `hour`:00 on the calendar day `dayOffset` days after `now`'s
 * LOCAL day. Built from calendar fields, never `now + n * 24 h`: a day with a
 * daylight-saving change is 23 or 25 hours long, and "tomorrow 9 AM" must
 * still read 9 AM on the wall clock.
 */
export function localClockTime(now: number, dayOffset: number, hour: number): number {
  const day = new Date(now);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + dayOffset, hour, 0, 0, 0).getTime();
}

export type ScheduleChipId = "in-1h" | "tonight" | "tomorrow";

export interface ScheduleChip {
  id: ScheduleChipId;
  /** Epoch ms the chip would schedule for, as of the `now` it was built with. */
  at: number;
}

/**
 * The quick times, soonest first. "Tonight 11 PM" is hidden once 11 PM has
 * passed today — offering a time that is already behind us would only produce
 * a refusal.
 */
export function scheduleChips(now: number): ScheduleChip[] {
  const chips: ScheduleChip[] = [{ id: "in-1h", at: now + HOUR_MS }];
  const tonight = localClockTime(now, 0, TONIGHT_HOUR);
  if (tonight > now) chips.push({ id: "tonight", at: tonight });
  chips.push({ id: "tomorrow", at: localClockTime(now, 1, TOMORROW_HOUR) });
  return chips;
}

/**
 * The instant a chip schedules for at the moment it is CHOSEN. "In 1 hour" is
 * relative, so a menu that stayed open for ten minutes must not hand back the
 * hour it computed when it opened; the wall-clock chips are fixed instants.
 */
export function resolveChipAt(chip: ScheduleChip, chosenAt: number): number {
  return chip.id === "in-1h" ? chosenAt + HOUR_MS : chip.at;
}

/** "11 PM" / "23時" / "23时": the hour as this language writes it. */
function formatHour(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(at);
}

/** The chip's text: "In 1 hour", "Tonight 11 PM", "Tomorrow 9 AM". */
export function scheduleChipLabel(chip: ScheduleChip, locale: string, t: Translate): string {
  if (chip.id === "in-1h") return t("schedule.chipInHour");
  return t(chip.id === "tonight" ? "schedule.chipTonight" : "schedule.chipTomorrow", { time: formatHour(chip.at, locale) });
}

/* ──────────────────────────────── the "Pick…" time ──────────────────────────────── */

/** A `datetime-local` value ("2026-10-06T09:30") for an instant, on the device's wall clock. */
export function toLocalInputValue(ms: number): string {
  const date = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The instant a `datetime-local` value names on the device's wall clock; null when it is empty or not a date. */
export function parseLocalInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  // `new Date(2026, 1, 31)` quietly becomes March 3rd; a value that rolled over was not a date.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export interface PickBounds {
  /** The earliest the field offers: the next whole minute. */
  min: string;
  /** The latest it offers: `maxDays` from now. */
  max: string;
  /** What the field holds when it opens: an hour from now. */
  initial: string;
}

export function pickBounds(now: number, maxDays: number = SCHEDULED_LIMITS.maxDays): PickBounds {
  const nextMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  return {
    min: toLocalInputValue(nextMinute),
    max: toLocalInputValue(now + maxDays * DAY_MS),
    initial: toLocalInputValue(now + HOUR_MS),
  };
}

export type PickCheck =
  | { ok: true; at: number }
  | { ok: false; problem: "empty" | "past" | "far" };

/** Whether a picked value may be scheduled, before the server is asked. */
export function checkPickedTime(value: string, now: number, maxDays: number = SCHEDULED_LIMITS.maxDays): PickCheck {
  const at = parseLocalInput(value);
  if (at === null) return { ok: false, problem: "empty" };
  if (at <= now) return { ok: false, problem: "past" };
  if (at > now + maxDays * DAY_MS) return { ok: false, problem: "far" };
  return { ok: true, at };
}

/* ─────────────────────────────────── row text ─────────────────────────────────── */

/** Whole local calendar days from `now` to `at` (0 = today, 1 = tomorrow, −1 = yesterday). */
export function localDayOffset(at: number, now: number): number {
  const target = new Date(at);
  const today = new Date(now);
  // UTC of the local Y/M/D triple, so a 23- or 25-hour day still counts as one.
  return Math.round((Date.UTC(target.getFullYear(), target.getMonth(), target.getDate())
    - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / DAY_MS);
}

/**
 * When a message is due, as little text as is unambiguous: the clock time
 * today, "tomorrow 9:00 AM", "Sat 9:00 AM" inside the coming week, and a short
 * date beyond it (or before today, where a weekday would be ambiguous).
 */
export function formatScheduledWhen(at: number, now: number, locale: string, t: Translate): string {
  const offset = localDayOffset(at, now);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  if (offset === 0) return time;
  if (offset === 1) return t("schedule.tomorrowTime", { time });
  if (offset >= 2 && offset <= 6) {
    return new Intl.DateTimeFormat(locale, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
  }
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

/** A message as one line, capped, so a 64 KB message is never put in the page twice. */
export function previewMessage(message: string, max = 240): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** `waiting`: the chat has the message queued behind a reply that is still running — it starts when that reply ends, which can be hours away. */
export type ScheduledRowState = "pending" | "checking" | "sending" | "waiting" | "failed";

export interface ScheduledRowText {
  state: ScheduledRowState;
  /** "at 11:40 PM" · "tomorrow 9:00 AM" · "when quota resets (11:40 PM)" · "checking quota…" · "sending…" · "waiting for the current reply to finish…" */
  when: string;
  /** The server's sentence: why it failed, or what its retry is for. */
  note: string | null;
  byAgent: boolean;
  /** "Claude · Secondary" on a quota row; never an email. */
  quotaLabel: string | null;
  preview: string;
  /** For the row's `title`: the start of the full message, not all 64 KB of it. */
  title: string;
}

/** Words for one scheduled row. `now` is passed in so the same rows render the same way twice. */
export function describeScheduledItem(item: ScheduledItemView, now: number, locale: string, t: Translate): ScheduledRowText {
  const at = Date.parse(item.at);
  const known = Number.isFinite(at);
  const due = known ? formatScheduledWhen(at, now, locale, t) : "";
  const state: ScheduledRowState = item.mode === "quota" && item.status === "pending" && known && at <= now ? "checking"
    : item.status === "sending" && item.handedOver ? "waiting"
    : item.status;
  let when: string;
  if (state === "waiting") when = t("schedule.rowWaiting");
  else if (state === "sending") when = t("schedule.rowSending");
  else if (state === "checking") when = t("schedule.rowQuotaChecking");
  else if (item.mode === "quota") when = t("schedule.rowQuota", { time: due });
  else when = known && localDayOffset(at, now) === 0 ? t("schedule.rowAt", { time: due }) : due;
  return {
    state,
    when,
    note: item.error?.trim() || null,
    byAgent: item.source === "agent",
    quotaLabel: item.mode === "quota" ? item.quota?.label ?? null : null,
    preview: previewMessage(item.message),
    title: previewMessage(item.message, 600),
  };
}

/** How many rows show while the list is collapsed. */
export const SCHEDULED_ROWS_COLLAPSED = 3;

/**
 * Which rows to draw. Up to twenty can be waiting in one chat, and they sit
 * between the transcript and the input, so a long list folds behind one
 * "N more" row. Folding a single row would save nothing (the toggle takes its
 * place), so a list only one longer than the fold shows in full.
 */
export function visibleScheduledRows<T>(rows: readonly T[], expanded: boolean): { shown: readonly T[]; hidden: number } {
  if (expanded || rows.length <= SCHEDULED_ROWS_COLLAPSED + 1) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(0, SCHEDULED_ROWS_COLLAPSED), hidden: rows.length - SCHEDULED_ROWS_COLLAPSED };
}

/**
 * Milliseconds until a waiting row's words change: the soonest pending due time
 * after `now`, when "when quota resets (11:40 PM)" becomes "checking quota…".
 * Null when no pending row is still ahead. Capped so `setTimeout` can hold it.
 */
export function nextDueTransition(items: readonly { status: ScheduledStatus; at: string }[], now: number): number | null {
  let soonest = Infinity;
  for (const item of items) {
    if (item.status !== "pending") continue;
    const at = Date.parse(item.at);
    if (Number.isFinite(at) && at > now) soonest = Math.min(soonest, at);
  }
  return Number.isFinite(soonest) ? Math.min(soonest - now + SCHEDULED_REFRESH.graceMs, SCHEDULED_REFRESH.maxTimerMs) : null;
}

/* ──────────────────────── why a menu row is switched off ──────────────────────── */

export type ScheduleBlock = "preparing" | "empty" | "no-session" | "images" | "shell" | "side-question";

export const SCHEDULE_BLOCK_KEYS: Record<ScheduleBlock, string> = {
  preparing: "schedule.reasonPreparing",
  empty: "schedule.reasonEmpty",
  "no-session": "schedule.reasonNoSession",
  images: "schedule.reasonImages",
  shell: "schedule.reasonShell",
  "side-question": "btw.scheduleReason",
};

/**
 * The reason every schedule row is off, or null when scheduling is allowed.
 * One reason, the most basic one: a new chat with a picture is told to send
 * the first message (which it must do whatever the picture), not about the
 * picture. A `!` shell line is the last reason: a scheduled message arrives as
 * an ordinary prompt, so the shell command would reach the model as text
 * instead of running. The same goes for `/btw <question>`: it is answered
 * right away by a command of its own, and a scheduled copy would reach the
 * model as literal text.
 */
export function scheduleBlock(input: { hasSession: boolean; hasImages: boolean; hasContent: boolean; preparing: boolean; shellMode: boolean; sideQuestion?: boolean }): ScheduleBlock | null {
  if (input.preparing) return "preparing";
  if (!input.hasContent) return "empty";
  if (!input.hasSession) return "no-session";
  if (input.hasImages) return "images";
  if (input.shellMode) return "shell";
  if (input.sideQuestion) return "side-question";
  return null;
}

/* ─────────────────────────── "When quota resets" row ─────────────────────────── */

/**
 * What the quota ring already knows about THIS chat's own model (the
 * `QuotaView` of `buildQuotaView`), narrowed to what this row reads. Typed
 * structurally so a ring that knows nothing (`known: false`) fits too.
 */
export interface QuotaResetSource {
  known: boolean;
  /** The usage provider id of the account the ring gauges. */
  provider?: string;
  /** When its binding window refills (ISO). */
  resetsAt?: string | null;
  /** Several accounts serve this provider: in-use first, labelled "Primary"/"Secondary"/"Account 3" — never an email. */
  accounts?: readonly { label: string }[];
}

export type QuotaRowModel =
  | { available: true; at: number; line: string }
  | { available: false; reasonKey: string };

/**
 * The row's second line — "Claude · Secondary refills at 11:40 PM" — or the
 * plain reason it is off. The account position appears only when the provider
 * has more than one account, the same rule the quota popover follows.
 */
export function quotaRowModel(
  source: QuotaResetSource | null,
  context: {
    now: number;
    t: Translate;
    /** The provider's product name ("Claude"), as the rest of the UI brands it. */
    brandName: (provider: string) => string;
    /** The reset time as the quota popover words it. */
    formatTime: (iso: string) => string | null;
  },
): QuotaRowModel {
  const unavailable: QuotaRowModel = { available: false, reasonKey: "schedule.quotaUnavailable" };
  if (!source?.known || !source.resetsAt) return unavailable;
  const at = Date.parse(source.resetsAt);
  const time = context.formatTime(source.resetsAt);
  // A reset already behind us is a stale reading, not something to wait for.
  if (!Number.isFinite(at) || at <= context.now || !time) return unavailable;
  const who = [source.provider ? context.brandName(source.provider) : "", source.accounts?.[0]?.label ?? ""].filter(Boolean).join(" · ");
  return {
    available: true,
    at,
    line: who ? context.t("schedule.quotaRefills", { account: who, time }) : context.t("schedule.quotaRefillsAt", { time }),
  };
}

/* ─────────────────────────────── refusals in words ─────────────────────────────── */

/**
 * A request's failure in the person's language. The route's stable code picks
 * the sentence; a transport failure and anything unrecognised get their own,
 * never a raw "Failed to fetch".
 */
export function scheduleErrorMessage(error: unknown, t: Translate, limits: typeof SCHEDULED_LIMITS = SCHEDULED_LIMITS): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
  if (isScheduledErrorCode(code)) {
    return t(`schedule.error.${code}`, {
      count: code === "too_many_for_account" ? limits.perAccount : limits.perChat,
      days: limits.maxDays,
      limit: `${Math.round(limits.maxMessageBytes / 1024)} KB`,
    });
  }
  return t(status === 0 ? "schedule.error.network" : "schedule.error.generic");
}

/* ───────────────────────────── the menu's position and keys ───────────────────────────── */

export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface MenuPlacement {
  left: number;
  /** Distance from the viewport's bottom edge to the menu's bottom edge. */
  bottom: number;
  width: number;
  /** The room above the anchor; the caller also keeps clear of the status-bar inset. */
  maxHeight: number;
}

export const MENU_WIDTH = 288;
const MENU_EDGE = 8;
const MENU_GAP = 6;

/**
 * Where the popover goes: above the Send pill, its right edge on the pill's,
 * and never off either side of the viewport.
 */
export function placeScheduleMenu(anchor: AnchorRect, viewport: { width: number; height: number }): MenuPlacement {
  const width = Math.max(0, Math.min(MENU_WIDTH, viewport.width - 2 * MENU_EDGE));
  const left = Math.max(MENU_EDGE, Math.min(anchor.right - width, viewport.width - width - MENU_EDGE));
  return {
    left,
    width,
    bottom: viewport.height - anchor.top + MENU_GAP,
    maxHeight: Math.max(0, anchor.top - MENU_EDGE - MENU_GAP),
  };
}

/**
 * The item a navigation key moves to, or null when the key is not one. Arrows
 * wrap (the chips are one row of the list, so left/right move along it too);
 * nothing focused yet starts at the first item going down and the last going up.
 */
export function nextMenuIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/* ───────────────────────────────────── long press ───────────────────────────────────── */

export const LONG_PRESS_MS = 450;
/** A finger that wanders further than this is scrolling or aiming, not holding. */
export const LONG_PRESS_SLOP_PX = 10;
/** The click a lifted finger produces arrives within this long of the lift. */
const LONG_PRESS_CLICK_WINDOW_MS = 600;

export interface LongPress {
  /** A finger went down at (x, y). */
  start(x: number, y: number): void;
  /** It moved. */
  move(x: number, y: number): void;
  /** It lifted, was cancelled or left: stop waiting, but remember a press that already fired. */
  end(): void;
  /**
   * Whether the click about to be handled belongs to a press that already
   * opened the menu — then it must not also send. True once per long press.
   */
  consumeClick(): boolean;
  /** Drop everything (unmount). */
  dispose(): void;
}

export function createLongPress(options: { onLongPress: () => void; delayMs?: number; slopPx?: number }): LongPress {
  const delayMs = options.delayMs ?? LONG_PRESS_MS;
  const slopPx = options.slopPx ?? LONG_PRESS_SLOP_PX;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let origin = { x: 0, y: 0 };
  let fired = false;
  let liftedAt: number | null = null;

  const stopWaiting = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return {
    start(x, y) {
      stopWaiting();
      fired = false;
      liftedAt = null;
      origin = { x, y };
      timer = setTimeout(() => {
        timer = undefined;
        fired = true;
        options.onLongPress();
      }, delayMs);
    },
    move(x, y) {
      if (timer !== undefined && Math.hypot(x - origin.x, y - origin.y) > slopPx) stopWaiting();
    },
    end() {
      stopWaiting();
      if (fired) liftedAt = Date.now();
    },
    consumeClick() {
      // A keyboard "click" arrives with no lift: it belongs to a press only if
      // that press ended a moment ago.
      const mine = fired && (liftedAt === null || Date.now() - liftedAt < LONG_PRESS_CLICK_WINDOW_MS);
      fired = false;
      liftedAt = null;
      return mine;
    },
    dispose() {
      stopWaiting();
      fired = false;
    },
  };
}

/* ──────────────────────────── when to read the list again ──────────────────────────── */

export const SCHEDULED_REFRESH = {
  /** After the soonest due time, long enough for the server to have acted on it. */
  graceMs: 1_500,
  /** While something is being sent or is overdue: 5 s, then 10 s, then 15 s. */
  followUpMs: [5_000, 10_000, 15_000],
  /** How many such re-reads in a row before the list waits for the next visit, focus or change. */
  maxFollowUps: 20,
  /** While a message waits in the chat for a reply to end — which can take hours — the row is re-read this often, with no limit, so it never stays on screen after it has started. */
  waitingMs: 30_000,
  /** A far-off due time is still re-checked now and then; `setTimeout` cannot hold 30 days. */
  maxTimerMs: 6 * HOUR_MS,
} as const;

export type ScheduledRefreshPlan =
  | { kind: "none" }
  | { kind: "transition"; delayMs: number }
  | { kind: "follow-up"; delayMs: number };

/**
 * The ONE timer the list needs, or none. There is no polling: a read is armed
 * for the soonest moment something can change (the next pending item's due
 * time), or — only while a message is on its way or already overdue — a short
 * follow-up that backs off and gives up. A hidden tab arms nothing; it reads
 * again when it becomes visible.
 */
export function planScheduledRefresh(input: {
  items: readonly { status: ScheduledStatus; at: string; handedOver?: boolean }[];
  now: number;
  visible: boolean;
  /** Follow-up reads already made in a row. */
  followUps: number;
}): ScheduledRefreshPlan {
  if (!input.visible) return { kind: "none" };
  let waiting = false;
  let queued = false;
  let soonest = Infinity;
  for (const item of input.items) {
    if (item.status === "sending") {
      if (item.handedOver) queued = true;
      else waiting = true;
    }
    if (item.status !== "pending") continue;
    const at = Date.parse(item.at);
    if (!Number.isFinite(at)) continue;
    if (at <= input.now) waiting = true;
    else soonest = Math.min(soonest, at);
  }
  const transition = Number.isFinite(soonest)
    ? Math.min(soonest - input.now + SCHEDULED_REFRESH.graceMs, SCHEDULED_REFRESH.maxTimerMs)
    : null;
  const steps = SCHEDULED_REFRESH.followUpMs;
  const quick = waiting && input.followUps < SCHEDULED_REFRESH.maxFollowUps
    ? steps[Math.min(input.followUps, steps.length - 1)]
    : null;
  // A message waiting in the chat is read about slowly but for as long as it waits; a quick follow-up for something else wins while it lasts.
  const followUp = quick ?? (queued ? SCHEDULED_REFRESH.waitingMs : null);
  if (transition !== null && (followUp === null || transition <= followUp)) return { kind: "transition", delayMs: transition };
  if (followUp !== null) return { kind: "follow-up", delayMs: followUp };
  return { kind: "none" };
}

/* ─────────────────────────── the phone's one-line controls row ─────────────────────────── */

/**
 * The numbers the phone composer's single controls row is made of, checked
 * against a real Chromium at 360, 390 and 412 px (attach, reasoning, ring and
 * Send beside the model button: its name got 49, 79 and 101 px). ChatInput's
 * own 16 px sides ARE the chat column's gutter; the card around the row adds a
 * border and its padding; every control is a 38 px box; the model button
 * spends 51 px of its own on chrome (8 + 8 padding, the provider mark, the
 * chevron and the two gaps between) before a letter of the name fits. Two
 * costs are easy to miss: the row's zero-width spacer is a flex item, so it
 * brings a gap of its own, and the ring's box keeps 4 px to its right.
 */
export const PHONE_COMPOSER = {
  gutter: 16,
  shellBorder: 1,
  shellPaddingLeft: 14,
  shellPaddingRight: 12,
  control: 38,
  gap: 4,
  /** Send stays icon-only; its ▾ zone is this much extra. */
  sendZone: 24,
  ringMargin: 4,
  modelChrome: 8 + 8 + 13 + 5 + 5 + 12,
  /** One state glyph inside the model button (the slow-mode turtle): the 12 px
   * icon and the 5 px gap that follows it. Not a box of its own — it only
   * takes from the name. */
  stateGlyph: 12 + 5,
} as const;

/** What sits on the row besides the model selector. Attach and Send always do. */
export interface PhoneControls {
  /** Reasoning level (every engine that has one). */
  reasoning: boolean;
  /** The quota ring. */
  ring: boolean;
  /** An ACP engine's agent-mode button. */
  mode: boolean;
  /** The engine-switched-the-model marker. */
  autoSwitch: boolean;
  /** The slow-mode glyph inside the model button: only while slow mode is on. */
  slow?: boolean;
}

export interface PhoneBudget {
  /** Width of the card's content box: the row itself. */
  row: number;
  /** Everything that does not shrink: the fixed controls and the gaps. */
  fixed: number;
  /** Width left for the model selector. */
  model: number;
  /** Of that, what the model's NAME gets once its own chrome is paid for. */
  name: number;
}

/** What the model name gets on a phone `viewport` px wide. Negative `name` means the row would spill. */
export function phoneBudget(viewport: number, controls: PhoneControls): PhoneBudget {
  const c = PHONE_COMPOSER;
  const row = viewport - 2 * c.gutter - 2 * c.shellBorder - c.shellPaddingLeft - c.shellPaddingRight;
  const boxes = 1 + Number(controls.reasoning) + Number(controls.ring) + Number(controls.mode) + Number(controls.autoSwitch);
  // The model selector, the Send pill and the zero-width spacer join the boxes in the gap count.
  const gaps = (boxes + 3 - 1) * c.gap;
  const fixed = boxes * c.control + (c.control + c.sendZone) + gaps + (controls.ring ? c.ringMargin : 0);
  const model = row - fixed;
  return { row, fixed, model, name: model - c.modelChrome - (controls.slow ? c.stateGlyph : 0) };
}
