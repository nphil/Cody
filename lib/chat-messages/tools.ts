import { getEngineSession } from "../harness/engine-sessions";
import { clipChars, singleLine } from "../notifications/compose";
import { listAllSessions } from "../session-reader";
import {
  mayRead,
  resolveSessionArgument,
  stringArg,
  type SessionToolArgs,
  type SessionToolContext,
  type SessionToolDefinition,
} from "../session-tools";
import { formatToolTime } from "../tool-time";
import type { ChatMessageProgress } from "./delivery";
import { createChatMessage, findChatMessage, sendAllowance } from "./registry";
import { CHAT_MESSAGE_LIMITS, CHAT_MESSAGE_URGENCIES, type ChatMessageRecord } from "./types";

/**
 * One chat's agent talking to another's, as tools any chat's agent can call.
 *
 * `send_to_chat` puts a message into another chat the way the composer's own
 * send does (lib/chat-messages/delivery.ts) and answers with a delivery id at
 * once; `message_status` says what became of it. Before these the only way to
 * reach another chat was `schedule_message`, which is a follow-up: it waits
 * behind the target's whole running turn, and a turn can run for hours.
 *
 * They follow the session tools' contract (lib/session-tools.ts): every handler
 * answers plain text, success or a short refusal, and never throws, so a
 * caller's dispatch needs no try/catch. The agent acts for the chat's OWNER: a
 * chat it cannot see — another account's, or any owned chat when the caller is
 * unowned — is refused with the words for a chat that does not exist.
 *
 * Not offered to the sidebar chat, for the budget reason the scheduling tools
 * give (lib/scheduled/tools.ts).
 */

const NOT_FOUND = "No message with that id.";
const PREVIEW_CHARS = 100;

function refusal(error: unknown): string {
  return `Could not complete that: ${error instanceof Error ? error.message : String(error)}`;
}

/** "4 min ago", "2 h 5 min ago". */
function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

/** The chat as the agent knows it: `"Fix login bug" (alice-login)`. */
function named(title: string, id: string): string {
  return `${title ? `"${clipChars(singleLine(title), 60)}"` : "an untitled chat"} (${id})`;
}

async function titlesOf(...ids: string[]): Promise<string[]> {
  const sessions = await listAllSessions();
  return ids.map((id) => sessions.find((session) => session.id === id)?.name ?? getEngineSession(id)?.title ?? "");
}

/** What a message's progress means to the agent that sent it, in a sentence. */
function phaseSentence(progress: ChatMessageProgress): string {
  switch (progress.phase) {
    case "sending":
      return "It is still being handed over: that chat's engine has not taken it yet (it may be starting), and the delivery carries on in the background.";
    case "held":
      return "That chat is in the middle of a turn: Cody holds the message and the agent reads it as its next message when the turn ends.";
    case "queued":
      return "That chat's engine has it and the agent reads it at its next step.";
    case "started":
      return "That chat's agent has started working on it.";
    case "delivered":
      return "That chat's agent has read it.";
    case "withdrawn":
      return "It was taken back from the chat's queue before the agent read it.";
    case "lost":
      return "It was lost: that chat's engine stopped or restarted before the agent read it. Send it again.";
    case "failed":
      return `It was not delivered: ${progress.error ?? "the chat did not accept it"}.`;
  }
}

async function sendToChat(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const message = typeof args.message === "string" ? args.message : "";
  if (message.trim().length === 0) return "Pass `message`: what the other chat should read.";
  const urgency = CHAT_MESSAGE_URGENCIES.find((candidate) => candidate === (stringArg(args, "urgency") ?? "next_step"));
  if (!urgency) return 'urgency must be "next_step" (read at the chat\'s next step) or "after_turn" (read when its current turn is over).';
  const query = stringArg(args, "session");
  if (!query) return "Pass `session`: the id or title of the chat to message; list_sessions shows them.";
  const sender = ctx.defaultSessionId;
  if (!sender) return "This chat has no id yet, so the other chat could not answer it.";
  const bytes = Buffer.byteLength(message, "utf8");
  if (bytes > CHAT_MESSAGE_LIMITS.maxBytes) {
    return `That message is ${Math.ceil(bytes / 1024)} KB; the limit is ${CHAT_MESSAGE_LIMITS.maxBytes / 1024} KB. Write the long material to a file and send its path.`;
  }
  try {
    const chat = await resolveSessionArgument(query, ctx);
    if ("text" in chat) return chat.text;
    if (chat.id === sender) return "That is this chat. To message it later, use schedule_message.";
    const allowance = sendAllowance(sender);
    if (!allowance.allowed) {
      return `This chat has already sent ${CHAT_MESSAGE_LIMITS.perSender} messages in the last ${CHAT_MESSAGE_LIMITS.windowMs / 60_000} minutes, the most it may: two agents answering each other would never stop. Try again in about ${Math.ceil(allowance.retryInMs / 60_000)} min; if a person has to see this, say so in your reply to the user.`;
    }
    // Loaded here, not at the top: delivery.ts imports ../rpc-manager, which imports this module for its tool list (lib/scheduled/scheduler.ts loads its delivery the same way).
    const delivery = await import("./delivery");
    const blocked = delivery.deliveryRefusal(chat.id, urgency);
    if (blocked) return `Not sent: ${blocked}`;
    const [fromTitle, toTitle] = await titlesOf(sender, chat.id);
    const record = createChatMessage({
      fromSessionId: sender,
      fromTitle,
      toSessionId: chat.id,
      urgency,
      preview: clipChars(singleLine(message), PREVIEW_CHARS),
    });
    await delivery.sendChatMessage(record, message);
    const progress = await delivery.chatMessageProgress(record);
    const target = named(toTitle, chat.id);
    if (progress.phase === "failed") return `Not delivered to chat ${target}: ${progress.error ?? "the chat did not accept the message"} (delivery id ${record.id}).`;
    const when = urgency === "next_step" ? "for its next step" : "to read after its current turn";
    return `Sent ${record.id} to chat ${target}, ${when}. ${phaseSentence(progress)} Nothing waits for that chat: message_status id ${record.id} shows whether it was read and whether the chat answered, and an answer arrives here as a message headed with its title and id.`;
  } catch (error) {
    return refusal(error);
  }
}

async function messageStatus(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const id = stringArg(args, "id");
  if (!id) return "Pass the delivery id that send_to_chat returned.";
  const record = findChatMessage(id);
  // A message between chats this caller may not use answers exactly like one that does not exist.
  if (!record || !mayRead(record.fromSessionId, ctx) || !mayRead(record.toSessionId, ctx)) return NOT_FOUND;
  try {
    // Lazy for the import cycle explained in sendToChat.
    const { chatMessageProgress } = await import("./delivery");
    const progress = await chatMessageProgress(record);
    const [toTitle] = await titlesOf(record.toSessionId);
    return statusText(record, progress, named(toTitle, record.toSessionId), ctx, Date.now());
  } catch (error) {
    return refusal(error);
  }
}

function statusText(record: ChatMessageRecord, progress: ChatMessageProgress, target: string, ctx: SessionToolContext, now: number): string {
  const lines = [
    `${record.id}: to chat ${target}, ${record.urgency}, sent ${formatToolTime(record.createdAt, ctx.timeZone)} (${ago(now - record.createdAt)}): "${record.preview}"`,
    phaseSentence(progress),
  ];
  if (record.repliedAt !== undefined) {
    lines.push(`That chat has answered with send_to_chat ${ago(now - record.repliedAt)} (${record.replyId}); its answer reached this chat as a message.`);
  } else if (progress.phase === "started" || progress.phase === "delivered") {
    lines.push("That chat has not answered with send_to_chat yet.");
  }
  return lines.join("\n");
}

export const CHAT_MESSAGE_TOOLS: SessionToolDefinition[] = [
  {
    name: "send_to_chat",
    description:
      "Message ANOTHER chat's agent now, without waiting for the turn it is in. urgency \"next_step\" (default) puts the message into that chat's running turn at its very next step (an idle chat starts a turn on it); \"after_turn\" waits until the turn it is in is over. "
      + "It arrives as a user message under a header naming this chat's title and id and saying an agent sent it with no user authority, so add no such disclaimer and write the message complete: its reader may remember nothing but its own transcript. The reader answers with send_to_chat to this chat's id. "
      + `At most ${CHAT_MESSAGE_LIMITS.maxBytes / 1024} KB (longer material goes in a file, send the path) and ${CHAT_MESSAGE_LIMITS.perSender} messages per ${CHAT_MESSAGE_LIMITS.windowMs / 60_000} minutes. Returns a delivery id at once and never waits for the other chat to read or answer; message_status shows whether it was read and answered. To message this chat later use schedule_message.`,
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "The other chat's id or title (several matches list the candidates to pick from); list_sessions shows the chats." },
        message: { type: "string", description: "What the other chat should read, written by you; Cody adds the sender header above it." },
        urgency: { type: "string", enum: [...CHAT_MESSAGE_URGENCIES], description: "next_step (default): read at the chat's next step, even mid-turn. after_turn: read once its current turn is over." },
      },
      required: ["session", "message"],
    },
    handler: sendToChat,
  },
  {
    name: "message_status",
    description: "Where a message sent with send_to_chat stands: still being handed over, held until a turn ends, queued, started, delivered or failed, and whether the other chat has answered with send_to_chat.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The delivery id send_to_chat returned (msg_…)." },
      },
      required: ["id"],
    },
    handler: messageStatus,
  },
];

export const CHAT_MESSAGE_TOOL_NAMES: readonly string[] = CHAT_MESSAGE_TOOLS.map((tool) => tool.name);
