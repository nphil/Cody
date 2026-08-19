import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

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
