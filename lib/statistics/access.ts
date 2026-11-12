/**
 * Whose usage a viewer's statistics may include.
 *
 * A chat's usage is the viewer's when they own the chat or nobody does — the
 * rule the chat list already follows (lib/auth/session-owners.ts). Usage that
 * belongs to no chat (the planner, Distill without a chat, research) is the
 * instance's own spend, so it is shown only where there is no account to
 * protect (an open instance) or to an admin.
 */

import { filterSessionsForUser } from "../auth/session-owners";
import type { UserRecord } from "../auth/users";
import type { ChatVisibility } from "./query";
import type { StatsStore } from "./store";

export function visibleChats(store: Pick<StatsStore, "files">, user: UserRecord | null): ChatVisibility {
  const chats = new Set<string>();
  for (const file of store.files.values()) if (file.chat !== "") chats.add(file.chat);
  const allowed = new Set(filterSessionsForUser([...chats].map((id) => ({ id })), user).map((entry) => entry.id));
  const instanceLevel = user === null || user.role === "admin";
  return (chat) => (chat === "" ? instanceLevel : allowed.has(chat));
}
