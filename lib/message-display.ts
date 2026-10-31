import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent, ToolResultMessage, ActivityDisplayMode } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

/**
 * Whether a process group holds any reasoning, counting the deferred blocks a
 * history load leaves with empty text. `indices` addresses `messages`;
 * `extraBlocks` carries the final assistant message's process blocks, which
 * `splitFinalAssistantBlocks` has already peeled off that message.
 *
 * Only asked when the "Expand thinking blocks" preference is on: a group of
 * nothing but tool calls stays collapsed, so the preference opens exactly what
 * it names.
 */
export function groupHasThinking(
  messages: AgentMessage[],
  indices: number[],
  extraBlocks: AssistantContentBlock[],
): boolean {
  if (extraBlocks.some((block) => block.type === "thinking")) return true;
  for (const idx of indices) {
    const message = messages[idx];
    if (message?.role !== "assistant") continue;
    if (getDisplayableAssistantBlocks(message as AssistantMessage).some((block) => block.type === "thinking")) return true;
  }
  return false;
}

/** Custom messages the transcript never shows. The last three are how omp's
 * goal mode talks to the model: `goal-mode-context` is re-sent before EVERY
 * turn while a goal is active (token budget and all), `goal-continuation` is
 * the hidden "carry on" steer an auto-continuing goal sends between turns, and
 * `goal-budget-limit` tells the model to wrap up. They arrive as `display:false`
 * custom messages, which would otherwise each draw an "Engine note" row — two
 * of them per turn of a goal that runs by itself. The Goal panel above the
 * composer is where a goal is read. */
const HIDDEN_CUSTOM_TYPES: Record<string, true> = {
  "xdev-mount-notice": true,
  "cody-local-time": true,
  "goal-mode-context": true,
  "goal-continuation": true,
  "goal-budget-limit": true,
};

/**
 * Messages the engine gives the model that the transcript never shows: no row,
 * no spacing, not counted as a turn. The one predicate every reader
 * (session history, subagent pages, live frames, grouping) shares.
 *
 * "cody-local-time" is LOCAL_TIME_CUSTOM_TYPE (lib/time-zone.ts), repeated here
 * because this module is also loaded without a bundler, where an extensionless
 * import does not resolve; lib/time-zone.test.mjs pins the two together.
 */
export function isHiddenFromTranscript(message: { role?: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType !== undefined && Object.hasOwn(HIDDEN_CUSTOM_TYPES, message.customType);
}

export function isActionableCustomDetails(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const details = value as Record<string, unknown>;
  const failed = (status: unknown) => status === "failed" || status === "error" || status === "cancelled";
  const invalidSchema = (status: unknown) => status === "invalid" || status === "unavailable" || status === "error";
  const schemaFailed = (schema: unknown) => !!schema && typeof schema === "object"
    && invalidSchema((schema as Record<string, unknown>).status);
  if (details.notifyType === "error" || details.notifyType === "warning"
    || details.isError === true || details.requiresAction === true
    || failed(details.status) || failed(details.jobStatus)
    || invalidSchema(details.schemaStatus) || schemaFailed(details.schema)) return true;
  return Array.isArray(details.jobs) && details.jobs.some((job: unknown) => {
    if (!job || typeof job !== "object") return false;
    const item = job as Record<string, unknown>;
    return item.notifyType === "error" || item.notifyType === "warning"
      || item.isError === true || item.requiresAction === true
      || failed(item.status) || invalidSchema(item.schemaStatus) || schemaFailed(item.schema);
  });
}

/** Exact engine types, including actionable deliveries that must not be folded away. */
export function isInternalBackgroundMessage(message: AgentMessage): boolean {
  if (message.role !== "custom") return false;
  switch (message.customType) {
    case "async-result":
    case "async_result":
    case "irc:incoming":
    case "irc:autoreply":
    case "irc:relay":
    case "irc:workpool":
      return true;
    default:
      return false;
  }
}

/** Classify only engine-identified background messages, never their text. */
export function backgroundActivityKind(message: AgentMessage): "completion" | "coordination" | null {
  if (message.role !== "custom" || message.attribution === "user" || isActionableCustomDetails(message.details)) return null;
  // Schema validity describes the output format, not whether the job succeeded.
  // Missing status is common in older deliveries; keep them grouped and inspectable.
  if (message.customType === "async-result" || message.customType === "async_result") return "completion";
  switch (message.customType) {
    case "irc:incoming":
    case "irc:autoreply":
    case "irc:relay":
    case "irc:workpool":
      return "coordination";
    default:
      return null;
  }
}

/** A valid output schema does not prove a job succeeded; unknown outcomes need review. */
export function backgroundActivityNeedsReview(message: AgentMessage): boolean {
  if (backgroundActivityKind(message) !== "completion" || message.role !== "custom") return false;
  const details = message.details;
  if (!details || typeof details !== "object") return true;
  const jobs = (details as Record<string, unknown>).jobs;
  return !Array.isArray(jobs) || jobs.length === 0 || !jobs.every(job =>
    job && typeof job === "object" && (job as Record<string, unknown>).status === "completed");
}

/** Stable identity only when the engine supplies enough metadata to distinguish deliveries. */
export function backgroundMessageIdentity(message: AgentMessage): string | null {
  if (message.role !== "custom" || !message.details || typeof message.details !== "object") return null;
  const details = message.details as Record<string, unknown>;
  if (message.customType === "irc:incoming") {
    return typeof details.id === "string" && details.id !== "" ? JSON.stringify(["irc:incoming", details.id]) : null;
  }
  if ((message.customType !== "async-result" && message.customType !== "async_result")
    || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)
    || !Array.isArray(details.jobs) || details.jobs.length === 0) return null;
  const ids = details.jobs.map((job: unknown) => job && typeof job === "object" ? (job as Record<string, unknown>).jobId : undefined);
  if (!ids.every((id: unknown) => typeof id === "string" && id !== "")) return null;
  return JSON.stringify(["async-result", message.timestamp, ids]);
}

/** Replace a duplicate delivery in its existing position without changing the input. */
export function appendBackgroundMessage(messages: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const id = backgroundMessageIdentity(message);
  if (id !== null) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (backgroundMessageIdentity(messages[index]) === id) {
        const updated = messages.slice();
        updated[index] = message;
        return updated;
      }
    }
  }
  return [...messages, message];
}

/** Shared visibility boundary so hidden activity leaves no transcript wrapper. */
export function isVisibleTranscriptMessage(message: AgentMessage, mode: ActivityDisplayMode, results?: Map<string, ToolResultMessage>): boolean {
  if (message.role === "toolResult") return false;
  if (isHiddenFromTranscript(message)) return false;
  if (mode !== "hidden" || message.role === "user") return true;
  if (message.role === "assistant") {
    return message.content.some(block => block.type === "toolCall"
      ? Boolean(results?.get(block.toolCallId)?.isError)
      : !isEmptyThinkingBlock(block));
  }
  if (message.role === "custom") {
    return message.customType === "compaction" || message.attribution === "user" || isActionableCustomDetails(message.details);
  }
  if (message.role === "bashExecution") return Boolean(message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0));
  return false;
}
