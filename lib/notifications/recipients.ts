import { getSessionOwner } from "../auth/session-owners";
import { findUserById, hasAnyUser, listUsers, type UserRecord } from "../auth/users";
import type { NotificationPrefs } from "./catalog";
import { INSTANCE_RECIPIENT_KEY, readNotificationPrefs } from "./store";

/**
 * Who a notification goes to. Notifications are per account, but a chat does
 * not always have one: the owner stamp is written after the session spawns,
 * and sessions from before accounts existed (or made from a terminal, or by a
 * since-deleted account) have none.
 *
 *  - A chat with a live owner goes to that account.
 *  - A chat with no owner goes to the instance record on an open instance (no
 *    accounts, so whoever is looking is the administrator), else to every
 *    administrator: an unowned chat is visible to all accounts, so the people
 *    answerable for the instance hear about it.
 *  - Account-wide events (quota) go to everyone who can configure them: the
 *    instance record on an open instance, else every account.
 */

export interface NotificationRecipient {
  /** The account id, or INSTANCE_RECIPIENT_KEY for the open-instance record. */
  key: string;
  /** The account, or null for the open-instance record. */
  user: UserRecord | null;
  prefs: NotificationPrefs;
}

function forAccount(user: UserRecord): NotificationRecipient {
  return { key: user.id, user, prefs: readNotificationPrefs(user.id) };
}

function forInstance(): NotificationRecipient {
  return { key: INSTANCE_RECIPIENT_KEY, user: null, prefs: readNotificationPrefs(INSTANCE_RECIPIENT_KEY) };
}

/**
 * The owner is read now, never cached: it is stamped after the session spawns
 * and moves with a fork, so what was true at registration may not be true when
 * the notification is sent.
 */
export function recipientsForSession(sessionId: string): NotificationRecipient[] {
  const ownerId = sessionId ? getSessionOwner(sessionId) : null;
  // A stamp that no longer names an account reads as unowned, exactly as the
  // session routes treat it.
  const owner = ownerId ? findUserById(ownerId) : null;
  if (owner) return [forAccount(owner)];
  if (!hasAnyUser()) return [forInstance()];
  return listUsers().filter((user) => user.role === "admin").map(forAccount);
}

/** Recipients of an event that belongs to the instance rather than one chat. */
export function recipientsForAccountEvent(): NotificationRecipient[] {
  if (!hasAnyUser()) return [forInstance()];
  return listUsers().map(forAccount);
}

/**
 * The recipient `key`, if it is still one of `sessionId`'s recipients. An
 * answer button carries the key it was issued for; this is the check that a
 * change of owner (or a deleted account) since then revokes it.
 */
export function recipientForSession(sessionId: string, key: string): NotificationRecipient | null {
  return recipientsForSession(sessionId).find((recipient) => recipient.key === key) ?? null;
}
