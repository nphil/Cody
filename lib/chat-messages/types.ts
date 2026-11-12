/**
 * How hard a message presses on the chat it is sent to.
 *
 * - `next_step`: into the chat's running turn at its very next step, the way
 *   the composer's own steer lands; an idle chat starts a turn on it.
 * - `after_turn`: held until the chat's current turn ends, then read as the
 *   next message (a follow-up).
 */
export type ChatMessageUrgency = "next_step" | "after_turn";

export const CHAT_MESSAGE_URGENCIES: readonly ChatMessageUrgency[] = ["next_step", "after_turn"];

export const CHAT_MESSAGE_LIMITS = {
  /** The largest message body: it is read by a model, so long material belongs in a file and the path in the message. */
  maxBytes: 32 * 1024,
  /** One chat may send this many messages per `windowMs`: two agents answering each other would otherwise never stop. */
  perSender: 20,
  windowMs: 10 * 60_000,
  /** How long a delivery id keeps answering (the ids live in memory, like the engine's own delivery ledger). */
  keepMs: 24 * 3_600_000,
  /** Deliveries remembered in all; the oldest go first. */
  cap: 500,
  /** How long `send_to_chat` waits for the chat's engine to take the message before it answers "sending" instead. */
  ackWaitMs: 15_000,
} as const;

/**
 * What this server knows about one send, as opposed to what the target chat's
 * own ledger says (that is read when asked, see delivery.ts):
 * - `sending`: handed to the delivery, the chat's engine has not taken it yet;
 * - `accepted`: the engine took it, and from here the ledger tells the story;
 * - `failed`: it never reached the chat (`error` says why).
 */
export type ChatMessageState = "sending" | "accepted" | "failed";

export interface ChatMessageRecord {
  /** `msg_…`, the delivery id the sender is given. */
  id: string;
  fromSessionId: string;
  /** The sender's title when it sent: what the header names. */
  fromTitle: string;
  toSessionId: string;
  urgency: ChatMessageUrgency;
  /** The first words of the body, for the sender's own recollection of which message this was. */
  preview: string;
  createdAt: number;
  state: ChatMessageState;
  acceptedAt?: number;
  error?: string;
  /** The target sent something back with `send_to_chat` after this was accepted. */
  repliedAt?: number;
  /** The id of that answer. */
  replyId?: string;
}

/** The id a chat's delivery ledger knows the message under. */
export function clientMessageIdForChatMessage(id: string): string {
  return `chat-${id}`;
}
