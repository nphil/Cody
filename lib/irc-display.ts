import { isRecord } from "./type-guards";
import type { CustomMessage, UserMessage } from "./types";

/**
 * omp 18.18 sends a parent agent's message to a running subagent as an ordinary
 * `user` message: its `content` is the model-facing `<irc from="parent" …>`
 * wrapper and `parentIrc` holds the sender and the plain text. Older engines
 * never set it (they store only the wrapper), so this is feature-detected.
 */
export function readParentIrc(message: UserMessage): { from: string; body: string } | null {
  const value: unknown = message.parentIrc; // session data: validate the shape, the type only documents it
  if (!isRecord(value) || typeof value.from !== "string" || typeof value.body !== "string") return null;
  return { from: value.from, body: value.body };
}

/** `plainBody` tells the card `content` is already the bare text (no
 * envelope line to strip). The same message as the incoming-IRC card the transcript already draws for
 * peer messages, so a parent's note looks like every other IRC message instead
 * of showing the raw wrapper. */
export function parentIrcAsCustomMessage(message: UserMessage): CustomMessage | null {
  const irc = readParentIrc(message);
  if (!irc) return null;
  return {
    role: "custom",
    customType: "irc:incoming",
    content: irc.body,
    display: true,
    details: { from: irc.from, message: irc.body, fromParent: true, plainBody: true },
    attribution: "agent",
    timestamp: message.timestamp,
  };
}

/** Which of the engine's incoming-IRC flags are set (omp 18.17+ writes them
 * into the message details; older engines write none). Keys are i18n suffixes
 * under `messageView.ircTag.`. */
export function ircTags(details: unknown): Array<"progress" | "broadcast" | "reply"> {
  if (!isRecord(details)) return [];
  const tags: Array<"progress" | "broadcast" | "reply"> = [];
  if (details.progress === true) tags.push("progress");
  if (details.broadcast === true) tags.push("broadcast");
  if (typeof details.replyTo === "string" && details.replyTo !== "") tags.push("reply");
  return tags;
}

/** The sender the engine recorded, when there is one. */
export function ircSender(details: unknown): string | null {
  return isRecord(details) && typeof details.from === "string" && details.from !== "" ? details.from : null;
}
