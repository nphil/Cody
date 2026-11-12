import { randomBytes } from "node:crypto";
import { CHAT_MESSAGE_LIMITS, type ChatMessageRecord } from "./types";

/**
 * The deliveries chats have made to each other, kept in memory.
 *
 * What a delivery IS lives in the target chat's own delivery ledger
 * (lib/rpc-manager.ts) and in its transcript; this only remembers which chat
 * sent what to whom under which id, so `message_status` can ask the right
 * ledger, and whether the target has answered. Like that ledger it does not
 * outlive the server process, and an id is forgotten after a day.
 *
 * On `globalThis` because the server loads its modules more than once (the
 * Next bundle and the custom server): a send made through one copy must be
 * found by a status asked through the other.
 */

interface Registry {
  records: Map<string, ChatMessageRecord>;
  /** When each chat sent, newest last: the loop guard. */
  sends: Map<string, number[]>;
}

declare global {
  var __codyChatMessages: Registry | undefined;
}

function registry(): Registry {
  globalThis.__codyChatMessages ??= { records: new Map(), sends: new Map() };
  return globalThis.__codyChatMessages;
}

function prune(now: number): void {
  const { records } = registry();
  for (const [id, record] of records) {
    if (record.createdAt + CHAT_MESSAGE_LIMITS.keepMs <= now) records.delete(id);
  }
  // Insertion order is creation order, so the first key is the oldest.
  while (records.size > CHAT_MESSAGE_LIMITS.cap) {
    const oldest = records.keys().next();
    if (oldest.done) break;
    records.delete(oldest.value);
  }
}

function newId(): string {
  const { records } = registry();
  let id = `msg_${randomBytes(5).toString("base64url")}`;
  while (records.has(id)) id = `msg_${randomBytes(5).toString("base64url")}`;
  return id;
}

/** May this chat send another message now? When not, how long until its oldest recent send ages out of the window. */
export function sendAllowance(sessionId: string, now = Date.now()): { allowed: true } | { allowed: false; retryInMs: number } {
  const { sends } = registry();
  const recent = (sends.get(sessionId) ?? []).filter((at) => at > now - CHAT_MESSAGE_LIMITS.windowMs);
  if (recent.length === 0) sends.delete(sessionId);
  else sends.set(sessionId, recent);
  if (recent.length < CHAT_MESSAGE_LIMITS.perSender) return { allowed: true };
  return { allowed: false, retryInMs: Math.max(1_000, recent[0] + CHAT_MESSAGE_LIMITS.windowMs - now) };
}

/** Start a delivery: remembered as `sending`, and counted against the sender's allowance. */
export function createChatMessage(
  fields: Pick<ChatMessageRecord, "fromSessionId" | "fromTitle" | "toSessionId" | "urgency" | "preview">,
  now = Date.now(),
): ChatMessageRecord {
  const state = registry();
  prune(now);
  const record: ChatMessageRecord = { id: newId(), ...fields, createdAt: now, state: "sending" };
  state.records.set(record.id, record);
  const sends = state.sends.get(fields.fromSessionId) ?? [];
  sends.push(now);
  state.sends.set(fields.fromSessionId, sends);
  return record;
}

export function findChatMessage(id: string, now = Date.now()): ChatMessageRecord | undefined {
  prune(now);
  return registry().records.get(id);
}

/** What `from` sent to `to` that `to` has not answered yet, oldest first. */
export function unansweredChatMessages(fromSessionId: string, toSessionId: string): ChatMessageRecord[] {
  return [...registry().records.values()].filter((record) =>
    record.fromSessionId === fromSessionId
    && record.toSessionId === toSessionId
    && record.state === "accepted"
    && record.repliedAt === undefined);
}

/** Forget everything: a test's clean slate. */
export function resetChatMessages(): void {
  globalThis.__codyChatMessages = undefined;
}
