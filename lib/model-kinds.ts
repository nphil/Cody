/**
 * Client-safe (no fs) mirror of the model `kind` / runner `api` rules in omp's
 * models.yml (checked against omp 18.19): pi-catalog `RUNNER_API_KINDS` /
 * `servedKinds`, and `validateProviderConfiguration` in config/models-config.ts.
 * Used by both the server-side validator (lib/omp/models-config.ts) and the
 * editor (components/ModelsConfig.tsx) so the inline message and the save-time
 * error can never disagree.
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
  "openai-decisions": "judge",
  "workers-ai-systemone": "judge",
  "liquid-systemone": "judge",
  "openai-images": "image",
  "openrouter-images": "image",
  "xai-tts": "tts",
  "openai-speech": "tts",
  "openai-embeddings": "embedding",
  "openrouter-rerank": "rerank",
  "openrouter-video": "video",
  "openai-transcriptions": "stt",
};

/** The omp release that first accepted a runner api. An older engine rejects the
 * WHOLE models.yml that names one (the api list is a closed enum), so the editor
 * offers one only from that release (see `modelsYmlOffers`). An api absent here
 * has been accepted for as long as Cody supports. */
export const RUNNER_API_SINCE: Record<string, string> = {
  "openai-decisions": "18.9.2",
  "workers-ai-systemone": "18.9.2",
  "liquid-systemone": "18.19.0",
};

/** The omp release that first understood each newer models.yml key the editor
 * writes (omp changelogs; pi-ai 18.9.1 / 18.17.0, pi-catalog 18.10.3 / 18.16.0,
 * audit rows CM-07..CM-12 for 18.11.3 / 18.13.0 / 18.13.2). Older engines ignore an unknown KEY, but the
 * `tokenizer` list is a closed enum: one value from the future makes the whole
 * file fail to load there. So the editor offers a value or switch only from its
 * release on, plus whenever the file already carries it (so it can be seen and
 * removed). */
export const MODELS_YML_SINCE = {
  /** `discovery.advertisedReasoning` (providers that read /v1/models rows). */
  advertisedReasoning: "18.13.2",
  /** `compat.requiresThinkingPresence` (anthropic-messages gateways). */
  requiresThinkingPresence: "18.13.0",
  /** `compat.supportsThinkingBindingControls` (Bedrock Converse). */
  supportsThinkingBindingControls: "18.9.1",
  /** `compat.statefulResponses` on anthropic-messages = Anthropic message threads. */
  anthropicMessageThreads: "18.17.0",
  /** Per-model `imageCountBudget`. */
  imageCountBudget: "18.11.3",
  /** `tokenizer: o200k`. */
  tokenizerO200k: "18.10.3",
  /** `tokenizer: cl100k`. */
  tokenizerCl100k: "18.16.0",
} as const;

/** True when `version` (bare semver such as "18.19.0", or null/garbage when the
 * engine could not be read) is at least `floor`. An unreadable version is NOT at
 * least anything: a gated option then shows only when the file already uses it. */
export function engineAtLeast(version: string | null | undefined, floor: string): boolean {
  const have = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  const want = /(\d+)\.(\d+)\.(\d+)/.exec(floor);
  if (!have || !want) return false;
  for (let index = 1; index <= 3; index += 1) {
    const a = Number(have[index]);
    const b = Number(want[index]);
    if (a !== b) return a > b;
  }
  return true;
}

/** Whether the editor offers a key/value that needs omp `since`: the engine is at
 * least that release, or the file already carries it (`present`). */
export function modelsYmlOffers(version: string | null | undefined, since: string | undefined, present = false): boolean {
  return present || since === undefined || engineAtLeast(version, since);
}

/** `tokenizer` values omp's models.yml accepts, with the release that added each
 * (absent = in the 8 original values). The editor's dropdown lists the offered ones. */
export const MODEL_TOKENIZERS: readonly { value: string; since?: string }[] = [
  { value: "claude-v3" },
  { value: "claude-v47" },
  { value: "claude-v5" },
  { value: "claude-v5-sonnet" },
  { value: "qwen3" },
  { value: "deepseek-v3" },
  { value: "kimi-k2" },
  { value: "glm5" },
  { value: "o200k", since: MODELS_YML_SINCE.tokenizerO200k },
  { value: "cl100k", since: MODELS_YML_SINCE.tokenizerCl100k },
];

export const RUNNER_API_OPTIONS = Object.keys(RUNNER_API_KINDS);

/** The runner apis the editor offers an engine of `version`. `current` (the api the
 * entry already names) is always kept, so a file written for a newer engine still
 * reads and can be changed. */
export function offeredRunnerApis(version: string | null | undefined, current?: string): string[] {
  return RUNNER_API_OPTIONS.filter((api) => modelsYmlOffers(version, RUNNER_API_SINCE[api], api === current));
}

/** The tokenizer values the editor offers an engine of `version`; `current` is
 * kept even when it is one Cody has never heard of. */
export function offeredTokenizers(version: string | null | undefined, current?: string): string[] {
  const offered = MODEL_TOKENIZERS
    .filter((entry) => modelsYmlOffers(version, entry.since, entry.value === current))
    .map((entry) => entry.value);
  if (current && !offered.includes(current)) offered.push(current);
  return offered;
}

/** Discovery types omp builds from the endpoint's `/v1/models` rows: the only ones
 * that accept `discovery.advertisedReasoning` (omp 18.13.2+ drops the whole file
 * when it sits on any other type, litellm included). */
export const ADVERTISED_REASONING_DISCOVERY_TYPES = ["openai-models-list", "lm-studio", "proxy"] as const;

export function discoveryAcceptsAdvertisedReasoning(type: unknown): boolean {
  return typeof type === "string" && (ADVERTISED_REASONING_DISCOVERY_TYPES as readonly string[]).includes(type);
}

/** Chat transports `generate_image` can also run, so they accept `image` too. */
const IMAGE_CAPABLE_CHAT_APIS = [
  "openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "google-gemini-cli",
];

/** The OpenAI Responses family: where `compat.statefulResponses` means Responses chaining. */
const RESPONSES_FAMILY_APIS = ["openai-responses", "openai-codex-responses", "azure-openai-responses"];

export function isResponsesFamilyApi(api: string | undefined): boolean {
  return api !== undefined && RESPONSES_FAMILY_APIS.includes(api);
}

export type CompatSwitchKey = "statefulResponses" | "requiresThinkingPresence" | "supportsThinkingBindingControls";

/** The boolean `compat` switches omp reads for `api`, in editor order, each with the
 * release that first read it (none = always). On anthropic-messages the same
 * `statefulResponses` key controls Anthropic message threads (omp 18.17+). */
export function compatSwitchesFor(api: string | undefined): { key: CompatSwitchKey; since?: string }[] {
  if (isResponsesFamilyApi(api)) return [{ key: "statefulResponses" }];
  if (api === "anthropic-messages") {
    return [
      { key: "statefulResponses", since: MODELS_YML_SINCE.anthropicMessageThreads },
      { key: "requiresThinkingPresence", since: MODELS_YML_SINCE.requiresThinkingPresence },
    ];
  }
  if (api === "bedrock-converse-stream") {
    return [{ key: "supportsThinkingBindingControls", since: MODELS_YML_SINCE.supportsThinkingBindingControls }];
  }
  return [];
}

/** The switches the editor shows for `api` on an engine of `version`: one newer than
 * the engine appears only while `compat` already sets it. */
export function offeredCompatSwitches(
  api: string | undefined,
  compat: Record<string, unknown> | undefined,
  version: string | null | undefined,
): CompatSwitchKey[] {
  return compatSwitchesFor(api)
    .filter(({ key, since }) => modelsYmlOffers(version, since, compat?.[key] !== undefined))
    .map(({ key }) => key);
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
