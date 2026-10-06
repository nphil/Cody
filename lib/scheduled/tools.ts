import {
  mayRead,
  resolveSessionArgument,
  stringArg,
  type SessionToolArgs,
  type SessionToolContext,
  type SessionToolDefinition,
} from "../session-tools";
import { clipChars, singleLine } from "../notifications/compose";
import { formatToolTime, toolTimeZone } from "../tool-time";
import { ScheduledError } from "./errors";
import { cancelScheduled, createScheduled, listScheduled } from "./service";
import { findItem } from "./store";
import { describeDelay } from "./time";
import { SCHEDULED_LIMITS, type ScheduledItemView } from "./types";

/**
 * Scheduling, as tools any chat's agent can call.
 *
 * Three of them — `schedule_message`, `list_scheduled`, `cancel_scheduled` —
 * over the same store, timer and composer rows as a message scheduled by hand.
 * They follow the session tools' contract (lib/session-tools.ts): every handler
 * answers plain text, success or a short refusal, and never throws, so a
 * caller's dispatch needs no try/catch.
 *
 * The agent acts for the chat's OWNER. A chat it cannot see — another
 * account's, or any owned chat when the caller is unowned — is refused with the
 * same words as a chat that does not exist, and a cancel by id is refused the
 * same way for a message in such a chat.
 *
 * Not offered to the sidebar chat: its schema budget assumes the smallest local
 * model (lib/sidebar-context-budget.ts), and these descriptions are written to
 * teach, which costs tokens it cannot spare.
 */

const NOT_FOUND = "No scheduled message with that id.";
const PREVIEW_CHARS = 100;

function preview(message: string): string {
  return `"${clipChars(singleLine(message), PREVIEW_CHARS)}"`;
}

/** "2026-10-06 09:00 EDT (in 3 h 12 min)". */
function when(item: ScheduledItemView, zone: string, now: number): string {
  return `${formatToolTime(item.at, zone)} (${describeDelay(Date.parse(item.at), now)})`;
}

function refusal(error: unknown): string {
  if (error instanceof ScheduledError) return error.message;
  return `Could not complete that: ${error instanceof Error ? error.message : String(error)}`;
}

function target(item: ScheduledItemView, ctx: SessionToolContext): string {
  return item.sessionId === ctx.defaultSessionId ? "this chat" : `chat ${item.sessionId}`;
}

async function scheduleMessage(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const chat = await resolveSessionArgument(stringArg(args, "session"), ctx);
  if ("text" in chat) return chat.text;
  const zone = toolTimeZone(ctx.timeZone);
  try {
    const item = await createScheduled(
      chat.id,
      { message: args.message, at: args.at, whenQuotaResets: args.whenQuotaResets },
      { zone },
      { source: "agent", user: ctx.user },
    );
    const now = Date.now();
    const lead = item.mode === "quota"
      ? `Scheduled ${item.id} for when ${item.quota?.label ?? "the model"}'s quota resets, ${when(item, zone, now)}. It is sent once a fresh usage read shows the model usable (re-checked every few minutes) and is given up on 24 hours after the reset.`
      : `Scheduled ${item.id} for ${when(item, zone, now)}.`;
    return `${lead} It goes to ${target(item, ctx)} as an ordinary message from the user: ${preview(item.message)}. Withdraw it with cancel_scheduled id ${item.id}.`;
  } catch (error) {
    return refusal(error);
  }
}

async function listScheduledMessages(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const chat = await resolveSessionArgument(stringArg(args, "session"), ctx);
  if ("text" in chat) return chat.text;
  const items = listScheduled(chat.id);
  const owner = chat.id === ctx.defaultSessionId ? "this chat" : `chat ${chat.id}`;
  if (items.length === 0) return `Nothing is scheduled for ${owner}.`;
  const zone = toolTimeZone(ctx.timeZone);
  const now = Date.now();
  const lines = items.map((item) => {
    const what = item.mode === "quota" ? `when ${item.quota?.label ?? "the model"}'s quota resets, ${when(item, zone, now)}` : when(item, zone, now);
    const state = item.status === "failed" ? `failed: ${item.error ?? "could not be sent"}` : item.status;
    return `${item.id} | ${what} | by ${item.source === "agent" ? "the agent" : "the user"} | ${state} | ${preview(item.message)}`;
  });
  return `${items.length} scheduled for ${owner} (at most ${SCHEDULED_LIMITS.perChat}):\n${lines.join("\n")}`;
}

async function cancelScheduledMessage(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const id = stringArg(args, "id");
  if (!id) return "Pass the id of the scheduled message; list_scheduled shows them.";
  const stored = findItem(id);
  // A message in a chat this caller may not use answers exactly like one that does not exist.
  if (!stored || !mayRead(stored.sessionId, ctx)) return NOT_FOUND;
  try {
    const item = cancelScheduled(stored.sessionId, id);
    return `Cancelled ${id} (${preview(item.message)}), which was due ${formatToolTime(item.at, toolTimeZone(ctx.timeZone))}.`;
  } catch (error) {
    return refusal(error);
  }
}

export const SCHEDULE_TOOLS: SessionToolDefinition[] = [
  {
    name: "schedule_message",
    description:
      "Send a message into a chat LATER — at a time you choose, or when this chat's model quota refills. Use it to carry on unfinished work after a usage limit resets, to run something at a set time (\"at 9 AM run the full suite and report\"), or to check back on CI or a long job instead of waiting or asking the user to return. "
      + "The message arrives as an ordinary user message in that chat (this one unless `session` names another; if that chat is mid-turn it waits as a follow-up behind the turn), so write it as a complete instruction: whoever reads it — possibly you — may remember nothing but the transcript. It is sent once and never repeats. "
      + `A chat holds at most ${SCHEDULED_LIMITS.perChat} pending messages and a time must be within ${SCHEDULED_LIMITS.maxDays} days. Give \`at\` or \`whenQuotaResets\`, not both. Returns an id; cancel_scheduled withdraws it.`,
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "What the chat will receive, written as the user would." },
        at: { type: "string", description: "When to send: an ISO 8601 date and time such as 2026-10-06T09:00, read in the user's time zone unless it carries an offset (Z, +02:00)." },
        whenQuotaResets: { type: "boolean", description: "true: send once this chat's model quota refills. Cody waits for the reset, confirms the model is usable again, and gives up 24 hours after the reset." },
        session: { type: "string", description: "Another chat's id or title; omit for this chat." },
      },
      required: ["message"],
    },
    handler: scheduleMessage,
  },
  {
    name: "list_scheduled",
    description: "List the messages scheduled for this chat (or `session`): id, when, who scheduled it (the user or an agent), status and a preview.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Another chat's id or title; omit for this chat." },
      },
    },
    handler: listScheduledMessages,
  },
  {
    name: "cancel_scheduled",
    description: "Withdraw a scheduled message by id (from schedule_message or list_scheduled). A message that was already sent cannot be taken back.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The scheduled message's id, e.g. sch_k3J9x2Qa." },
      },
      required: ["id"],
    },
    handler: cancelScheduledMessage,
  },
];

export const SCHEDULE_TOOL_NAMES: readonly string[] = SCHEDULE_TOOLS.map((tool) => tool.name);
