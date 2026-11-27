import type { AgentMessage, AssistantMessage } from "./types";

export interface ContextUsageValue {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

type ActiveModel = {
  readonly provider: string;
  readonly modelId: string;
};

type ContextWindowModel = {
  readonly id: string;
  readonly provider: string;
  readonly contextWindow?: number;
};

function isUsableTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function promptTokensFrom(message: Pick<AssistantMessage, "usage" | "contextSnapshot">): number | null {
  const snapshotTokens = message.contextSnapshot?.promptTokens;
  if (isUsableTokenCount(snapshotTokens)) return snapshotTokens;

  const usage = message.usage;
  if (
    !usage
    || !isUsableTokenCount(usage.input)
    || !isUsableTokenCount(usage.cacheRead)
    || !isUsableTokenCount(usage.cacheWrite)
  ) {
    return null;
  }

  const total = usage.input + usage.cacheRead + usage.cacheWrite;
  return Number.isFinite(total) ? Math.max(0, total) : null;
}

/**
 * The context fill of the newest assistant turn. `fallbackUsage` stands in for
 * the newest turn when `messages` holds none (a windowed transcript that only
 * holds older pages, or only live tool traffic): the server's `latestAssistant`.
 */
export function derivePersistedContextUsage(
  messages: readonly AgentMessage[],
  activeModel: ActiveModel | null | undefined,
  modelList: readonly ContextWindowModel[],
  fallbackUsage?: AssistantMessage["usage"] | null,
): ContextUsageValue | null {
  if (!activeModel) return null;
  const model = modelList.find(
    (entry) => entry.id === activeModel.modelId && entry.provider === activeModel.provider,
  );
  const contextWindow = model?.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }

  let latestAssistant: Pick<AssistantMessage, "usage" | "contextSnapshot"> | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      latestAssistant = message;
      break;
    }
  }
  if (!latestAssistant && fallbackUsage) latestAssistant = { usage: fallbackUsage };
  if (!latestAssistant) return null;

  const tokens = promptTokensFrom(latestAssistant);
  if (tokens === null) return null;

  return {
    percent: (tokens / contextWindow) * 100,
    contextWindow,
    tokens,
  };
}
