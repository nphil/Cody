import * as fs from "node:fs";
import type { UserRecord } from "../auth/users";
import { mapLimit } from "./walk";
import type { UsageChat, UsageChatsPayload } from "./usage-types";

/**
 * Settings › System › Disk space › Chats: the transcripts under the engine's
 * sessions folder, by size or by age, so the person can see which chats hold
 * the space. Reading only: a chat is deleted through the same
 * `DELETE /api/sessions/<id>` the sidebar uses, which also removes its scratch,
 * routing and schedule entries. Chats the requester may not open are counted
 * in the total but never listed (no title leaks).
 */

export type ChatSort = "size" | "oldest";

export const CHAT_LIST_LIMIT = 40;
const STAT_CONCURRENCY = 24;

export function isChatSort(value: unknown): value is ChatSort {
  return value === "size" || value === "oldest";
}

/** The `limit` chats to show: the biggest first, or the longest untouched first. Ties keep a stable order. */
export function rankChats(rows: readonly UsageChat[], sort: ChatSort, limit: number = CHAT_LIST_LIMIT): UsageChat[] {
  const order = sort === "size"
    ? (a: UsageChat, b: UsageChat) => b.bytes - a.bytes || a.modifiedMs - b.modifiedMs
    : (a: UsageChat, b: UsageChat) => a.modifiedMs - b.modifiedMs || b.bytes - a.bytes;
  return [...rows].sort(order).slice(0, limit);
}

export async function listChatSizes(sort: ChatSort, user: UserRecord | null): Promise<UsageChatsPayload> {
  // Loaded here, not at the top: these pull in the whole session index, which the pure ranking above never needs.
  const [{ listAllSessions }, { canAccessSession }] = await Promise.all([import("../session-reader"), import("../auth/session-owners")]);
  const sessions = await listAllSessions();
  const rows: UsageChat[] = [];
  const hidden = new Set<string>();
  await mapLimit(sessions, STAT_CONCURRENCY, async (session) => {
    try {
      const stat = await fs.promises.stat(session.path);
      rows.push({
        id: session.id,
        title: session.name || session.firstMessage || session.id,
        bytes: stat.size,
        modifiedMs: Date.parse(session.modified) || stat.mtimeMs,
        cwd: session.cwd,
      });
      if (!canAccessSession(session.id, user)) hidden.add(session.id);
    } catch {
      // Deleted since the listing.
    }
  });
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  const visible = rows.filter((row) => !hidden.has(row.id));
  return { totalBytes, count: rows.length, chats: rankChats(visible, sort) };
}
