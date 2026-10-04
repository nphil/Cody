import type { NotificationEventId, NotificationPrefs } from "./catalog";
import { EVENT_TAGS, MAX_ANSWER_BUTTONS, sequenceIdFor, type AnswerOffer } from "./compose";
import { clearNtfy, publishNtfy, type NtfyAction, type NtfyMessage, type NtfyResult, type NtfyTarget } from "./ntfy";
import { isViewing } from "./presence";
import { recipientsForSession, type NotificationRecipient } from "./recipients";
import { isConfigured } from "./store";
import { issueAnswerToken } from "./tokens";

/**
 * From "something worth telling the owner happened in this chat" to a message
 * on their ntfy topic. The observer decides WHAT happened and says it once;
 * this decides, per recipient, whether it is sent, how loudly and with which
 * buttons — because every one of those is a setting the recipient owns.
 *
 * Publishing is fire-and-forget. A notification is never worth delaying or
 * failing a chat for: every call is bounded by the client's 10 s timeout, a
 * failure is logged (at most once a minute per recipient) and nothing here
 * throws into session code.
 */

/** One notification, as the observer describes it. */
export interface NotificationDraft {
  event: NotificationEventId;
  /** The session id at the moment of the event: read fresh, never remembered from registration. */
  sessionId: string;
  title: string;
  body: string;
  /** Tags after the kind's own — the project name. */
  tags: string[];
  /** Set for a pending-input notification: the request it is about. It gets a sequence id and can be cleared. */
  requestKey?: string;
  /** The answer buttons this request can honestly offer (see compose.ts). */
  offer?: AnswerOffer;
  /** How long the run took, for "Reply finished" — each recipient sets its own minimum. */
  runMs?: number;
  /** Sent instead when this kind is switched off for a recipient ("waiting" falls through to "finished"). */
  fallback?: NotificationDraft;
}

/** What a send leaves behind: a way to take the notification back down. */
export interface SentNotification {
  /** Clear it on every device. Waits for the publish it follows, so a fast answer cannot be overtaken. */
  clear(): void;
}

interface Delivery {
  recipientKey: string;
  target: NtfyTarget;
  sequenceId: string | null;
  /** Settles when the publish has (never rejects). */
  done: Promise<void>;
}

const LOG_INTERVAL_MS = 60_000;

declare global {
  var __codyNotificationLogAt: Map<string, number> | undefined;
}

/**
 * Log a failed ntfy call: one line per recipient per minute, because a dead
 * server must not fill the log with a line per event. Never the topic (it is
 * the password of an unauthenticated server) and never the token.
 */
export function reportNtfyFailure(recipientKey: string, server: string, action: string, result: Extract<NtfyResult, { ok: false }>): void {
  if (!globalThis.__codyNotificationLogAt) globalThis.__codyNotificationLogAt = new Map();
  const lastAt = globalThis.__codyNotificationLogAt;
  const now = Date.now();
  const last = lastAt.get(recipientKey);
  if (last !== undefined && now - last < LOG_INTERVAL_MS) return;
  lastAt.set(recipientKey, now);
  let host = "the ntfy server";
  try {
    host = new URL(server).host;
  } catch {
    // The stored address is normalized on write; a hand edit that broke it still gets a line.
  }
  console.warn(`[notifications] ${action} failed for ${host}: ${result.error}${result.status ? ` (HTTP ${result.status})` : ""}`);
}

/** The first draft in the chain this recipient wants: the kind is on, and a finished run is long enough. */
function chooseDraft(draft: NotificationDraft, prefs: NotificationPrefs): NotificationDraft | null {
  for (let candidate: NotificationDraft | undefined = draft; candidate; candidate = candidate.fallback) {
    if (!prefs.events[candidate.event].enabled) continue;
    if (candidate.event === "finished" && (candidate.runMs ?? 0) < prefs.finishedMinSeconds * 1000) continue;
    return candidate;
  }
  return null;
}

/** The page a tap on the notification opens: this chat. */
export function chatUrl(codyUrl: string, sessionId: string): string {
  return `${codyUrl}/?session=${encodeURIComponent(sessionId)}`;
}

/** Where an answer button posts. */
export function actionUrl(codyUrl: string): string {
  return `${codyUrl}/api/notifications/action`;
}

/** One http button per choice, each carrying its own signed token. Only for a recipient who turned buttons on and told Cody where it lives. */
function answerActions(recipient: NotificationRecipient, draft: NotificationDraft, now: number): NtfyAction[] {
  const { prefs } = recipient;
  const offer = draft.offer;
  if (!offer || !prefs.answerButtons || !prefs.codyUrl) return [];
  if (offer.expiresAt !== undefined && offer.expiresAt <= now) return [];
  return offer.choices.slice(0, MAX_ANSWER_BUTTONS).map((choice): NtfyAction => ({
    action: "http",
    label: choice.label,
    url: actionUrl(prefs.codyUrl),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      t: issueAnswerToken(
        { sid: draft.sessionId, rid: offer.requestId, u: recipient.key, k: offer.kind, d: offer.digest, a: choice.answer, expiresAt: offer.expiresAt },
        now,
      ),
    }),
    clear: true,
  }));
}

function deliver(recipient: NotificationRecipient, draft: NotificationDraft, now: number): Delivery {
  const { prefs } = recipient;
  const target: NtfyTarget = { server: prefs.server, topic: prefs.topic, token: prefs.token };
  const sequenceId = draft.requestKey ? sequenceIdFor(draft.sessionId, draft.requestKey) : null;
  const actions = answerActions(recipient, draft, now);
  const message: NtfyMessage = {
    title: draft.title,
    message: draft.body,
    priority: prefs.events[draft.event].priority,
    tags: [EVENT_TAGS[draft.event], ...draft.tags],
    ...(prefs.codyUrl ? { click: chatUrl(prefs.codyUrl, draft.sessionId) } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(sequenceId ? { sequenceId } : {}),
  };
  const done = publishNtfy(target, message).then((result) => {
    if (!result.ok) reportNtfyFailure(recipient.key, target.server, "publish", result);
  });
  return { recipientKey: recipient.key, target, sequenceId, done };
}

/**
 * Send `draft` to whoever should get it. Returns a handle that can take it
 * down again, or null when nobody was notified. Never throws.
 */
export function sendNotification(draft: NotificationDraft, now = Date.now()): SentNotification | null {
  try {
    const deliveries: Delivery[] = [];
    for (const recipient of recipientsForSession(draft.sessionId)) {
      if (!isConfigured(recipient.prefs)) continue;
      const chosen = chooseDraft(draft, recipient.prefs);
      if (!chosen) continue;
      // Someone looking at this very chat has no use for it, whatever it says.
      if (recipient.prefs.skipWhenViewing && isViewing(recipient.key, draft.sessionId, now)) continue;
      deliveries.push(deliver(recipient, chosen, now));
    }
    if (deliveries.length === 0) return null;
    let cleared = false;
    return {
      clear() {
        if (cleared) return;
        cleared = true;
        for (const delivery of deliveries) {
          const sequenceId = delivery.sequenceId;
          if (!sequenceId) continue;
          void delivery.done
            .then(() => clearNtfy(delivery.target, sequenceId))
            .then((result) => {
              if (!result.ok) reportNtfyFailure(delivery.recipientKey, delivery.target.server, "clear", result);
            });
        }
      },
    };
  } catch (error) {
    console.warn("[notifications] could not send a notification:", error instanceof Error ? error.message : error);
    return null;
  }
}
