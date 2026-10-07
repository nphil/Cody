/**
 * Client-safe (no fs) mirror of the model `kind` / runner `api` rules in omp
 * 18.7's models.yml: pi-catalog `RUNNER_API_KINDS` / `servedKinds`, and
 * `validateProviderConfiguration` in config/models-config.ts. Used by both the
 * server-side validator (lib/omp/models-config.ts) and the editor
 * (components/ModelsConfig.tsx) so the inline message and the save-time error
 * can never disagree.
 */

/** `search` is deliberately absent: no api a models.yml entry can name serves it. */
export const MODEL_KIND_OPTIONS = [
  "chat",
  "tiny",
  "image",
  "tts",
  "stt",
  "judge",
  "embedding",
  "rerank",
  "video",
] as const;

/** Runner (non-chat) APIs a models.yml model may name, with the one kind each serves. */
export const RUNNER_API_KINDS: Record<string, string> = {
  typesafe: "judge",
  "openrouter-decisions": "judge",
  "openai-images": "image",
  "openrouter-images": "image",
  "xai-tts": "tts",
  "openai-speech": "tts",
  "openai-embeddings": "embedding",
  "openrouter-rerank": "rerank",
  "openrouter-video": "video",
  "openai-transcriptions": "stt",
};

export const RUNNER_API_OPTIONS = Object.keys(RUNNER_API_KINDS);

/** Chat transports `generate_image` can also run, so they accept `image` too. */
const IMAGE_CAPABLE_CHAT_APIS = [
  "openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "google-gemini-cli",
];

/** The OpenAI Responses family: the only apis `compat.statefulResponses` applies to. */
const RESPONSES_FAMILY_APIS = ["openai-responses", "openai-codex-responses", "azure-openai-responses"];

export function isResponsesFamilyApi(api: string | undefined): boolean {
  return api !== undefined && RESPONSES_FAMILY_APIS.includes(api);
}

/** Kinds a model on `api` may declare; undefined when omp does not constrain it. */
export function servedKinds(api: string): readonly string[] | undefined {
  if (api === "local-inference") return undefined;
  const runnerKind = RUNNER_API_KINDS[api];
  if (runnerKind !== undefined) return [runnerKind];
  return IMAGE_CAPABLE_CHAT_APIS.includes(api) ? ["chat", "tiny", "image"] : ["chat", "tiny"];
}

const KIND_LIST = new Intl.ListFormat("en", { type: "disjunction" });

/** omp's own message when `kind` does not match `api`, or null when they agree
 * (or either is unset). `subject` reads like `model gpt-x`. */
export function kindApiMismatch(
  providerName: string,
  subject: string,
  kind: string | undefined,
  api: string | undefined,
): string | null {
  if (!kind || !api) return null;
  const served = servedKinds(api);
  if (served === undefined || served.includes(kind)) return null;
  return `Provider ${providerName}, ${subject}: kind "${kind}" does not match api "${api}", which serves kind ${KIND_LIST.format(served.map((k) => `"${k}"`))}.`;
}

/** Set (or, with undefined, remove) one boolean `compat` flag. Other compat keys
 * are kept as-is; an emptied compat object is dropped so the file stays minimal. */
export function withCompatFlag(
  compat: Record<string, unknown> | undefined,
  key: string,
  value: boolean | undefined,
): Record<string, unknown> | undefined {
  const next = { ...(compat ?? {}) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** First kind/api mismatch among a provider's models, as the editor sees it
 * (a provider with no api behaves as openai-completions there). */
export function firstKindApiMismatch(
  providerName: string,
  provider: { api?: string; models?: { id: string; kind?: string; api?: string }[] },
): string | null {
  for (const model of provider.models ?? []) {
    const message = kindApiMismatch(providerName, `model ${model.id}`, model.kind, model.api ?? provider.api ?? "openai-completions");
    if (message) return message;
  }
  return null;
}
