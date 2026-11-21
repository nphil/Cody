import type { AgentMessage } from "./types";

// A page that attaches to a running chat reads the transcript and subscribes
// to the stream at slightly different moments. These keep the messages that
// finish in between: the stream re-sends the run's latest finished messages
// on attach (`?replay=1`, see the events route), and a switch that attached
// before its transcript landed carries the delivered ones over that landing.

/**
 * Identity of a finished message across the transcript and the stream: the
 * engine's timestamp, plus the tool call a tool result answers (parallel
 * results can share a millisecond). Null without a timestamp; such a message
 * is never deduplicated or carried over.
 */
export function messageReplayKey(message: AgentMessage): string | null {
  if (typeof message.timestamp !== "number") return null;
  return message.role === "toolResult" ? `${message.timestamp}:${message.toolCallId}` : String(message.timestamp);
}

/** Whether the list's recent tail already holds this message. */
export function holdsMessage(messages: readonly AgentMessage[], message: AgentMessage, lookback = 64): boolean {
  const key = messageReplayKey(message);
  if (key === null) return false;
  for (let index = messages.length - 1, end = Math.max(0, messages.length - lookback); index >= end; index -= 1) {
    if (messageReplayKey(messages[index]) === key) return true;
  }
  return false;
}

/**
 * The transcript a switch loaded, plus the messages of `current` the stream
 * delivered (`delivered` keys) that are newer than everything the transcript
 * holds: it was read before they were written, and replacing the list with it
 * alone hid them until the next reload.
 */
export function withDeliveredTail(transcript: AgentMessage[], current: readonly AgentMessage[], delivered: ReadonlySet<string>): AgentMessage[] {
  if (delivered.size === 0) return transcript;
  let newest = -Infinity;
  for (const message of transcript) {
    if (typeof message.timestamp === "number" && message.timestamp > newest) newest = message.timestamp;
  }
  const tail = current.filter((message) => {
    const key = messageReplayKey(message);
    return key !== null && delivered.has(key) && typeof message.timestamp === "number" && message.timestamp > newest;
  });
  return tail.length > 0 ? [...transcript, ...tail] : transcript;
}
