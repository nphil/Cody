import { getEngineSession } from "../harness/engine-sessions";
import { buildBody, buildTitle, clipChars, projectTag, singleLine } from "../notifications/compose";
import { sendNotification, type NotificationDraft } from "../notifications/dispatch";
import { readSessionHeader, resolveSessionPath } from "../session-reader";
import { ownerTimeZone } from "../time-zone-prefs";
import { formatToolTime } from "../tool-time";
import type { StoredItem } from "./store";

/**
 * Telling the owner a scheduled message went out, or could not.
 *
 * Delivery itself is dispatch's business (who receives it, whether the kind is
 * on, whether they are looking at the chat); this only says WHAT happened. The
 * message is the person's own words, so the preview is clipped to a line and
 * never grows a notification past ntfy's limits. Never throws: a notification
 * is not worth failing a delivery for.
 */

export type ScheduledOutcome =
  | { kind: "sent"; item: StoredItem }
  | { kind: "failed"; item: StoredItem; reason: string };

const PREVIEW_CHARS = 140;
const UNTITLED = "Untitled chat";

/** The text of one notification, in the zone of the person it goes to. */
export function composeScheduledNotification(
  outcome: ScheduledOutcome,
  chat: { title: string },
  zone: string,
  now: number,
): { title: string; body: string } {
  const preview = clipChars(singleLine(outcome.item.message), PREVIEW_CHARS);
  const body = outcome.kind === "sent"
    ? `Sent ${formatToolTime(now, zone)}: ${preview}`
    : `Could not send: ${outcome.reason}\n${preview}\nOpen the chat to retry or cancel it.`;
  return { title: buildTitle("scheduled", chat.title), body: buildBody(body) };
}

export interface ScheduledNotifyDeps {
  now: () => number;
  zoneFor: (sessionId: string) => string;
  describeChat: (item: StoredItem) => Promise<{ title: string; project: string | null }>;
  send: (draft: NotificationDraft) => unknown;
}

/** The chat's name as the sidebar shows it, falling back to the message's opening words for a chat nobody has named yet. */
async function describeChat(item: StoredItem): Promise<{ title: string; project: string | null }> {
  try {
    const row = getEngineSession(item.sessionId);
    const file = row ? null : await resolveSessionPath(item.sessionId);
    const header = file ? readSessionHeader(file) : null;
    const title = row?.title?.trim() || header?.title?.trim() || clipChars(singleLine(item.message), 60) || UNTITLED;
    return { title, project: projectTag(row?.cwd ?? header?.cwd) };
  } catch {
    return { title: clipChars(singleLine(item.message), 60) || UNTITLED, project: null };
  }
}

const DEFAULT_DEPS: ScheduledNotifyDeps = {
  now: Date.now,
  zoneFor: ownerTimeZone,
  describeChat,
  send: (draft) => sendNotification(draft),
};

export async function notifyScheduledOutcome(outcome: ScheduledOutcome, overrides: Partial<ScheduledNotifyDeps> = {}): Promise<void> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  try {
    const chat = await deps.describeChat(outcome.item);
    const { title, body } = composeScheduledNotification(outcome, chat, deps.zoneFor(outcome.item.sessionId), deps.now());
    deps.send({ event: "scheduled", sessionId: outcome.item.sessionId, title, body, tags: chat.project ? [chat.project] : [] });
  } catch (error) {
    console.warn("[scheduled] could not send a notification:", error instanceof Error ? error.message : error);
  }
}
