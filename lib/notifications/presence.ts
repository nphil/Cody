/**
 * "Skip the chat I'm looking at". A browser reports which chat is on screen
 * (when it changes, when the tab is hidden, every 30 s while visible, and on
 * page hide); the server remembers the newest report per recipient and treats
 * the chat as viewed while that report is fresh. The window is a little over
 * two heartbeats, so a closed laptop or a killed tab stops suppressing
 * notifications on its own within 75 s.
 *
 * One entry per recipient — accounts, plus the open-instance record — so the
 * map is bounded by the number of people, and stale entries are dropped as
 * they are noticed. It lives on globalThis: the presence route and the
 * observer can be separate module instances (Next reloads modules in dev).
 */

/** A report counts as "looking right now" this long. */
export const PRESENCE_TTL_MS = 75_000;

interface Presence {
  sessionId: string;
  at: number;
}

declare global {
  var __codyNotificationPresence: Map<string, Presence> | undefined;
}

function presenceMap(): Map<string, Presence> {
  if (!globalThis.__codyNotificationPresence) globalThis.__codyNotificationPresence = new Map();
  return globalThis.__codyNotificationPresence;
}

/** Record what `recipientKey` is looking at; `null` means nothing (tab hidden or closed). */
export function recordPresence(recipientKey: string, sessionId: string | null, now = Date.now()): void {
  const map = presenceMap();
  for (const [key, entry] of map) {
    if (now - entry.at > PRESENCE_TTL_MS) map.delete(key);
  }
  if (sessionId === null) map.delete(recipientKey);
  else map.set(recipientKey, { sessionId, at: now });
}

/** Is `recipientKey` looking at `sessionId` right now? */
export function isViewing(recipientKey: string, sessionId: string, now = Date.now()): boolean {
  const entry = presenceMap().get(recipientKey);
  return entry !== undefined && entry.sessionId === sessionId && now - entry.at <= PRESENCE_TTL_MS;
}
