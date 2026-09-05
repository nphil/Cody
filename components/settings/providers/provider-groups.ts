/**
 * Which section of the Providers hub an engine's provider id belongs to.
 *
 * Pure data, no React: the server's `/api/providers` join
 * (`lib/provider-directory.ts`) stamps every row with a group from here,
 * and the Add picker renders the groups in `GROUP_ORDER`. The roster itself
 * stays the ENGINE'S — omp's `/login` list alone has 70 entries and grows
 * every release — so an id that is in none of these tables is not dropped,
 * it lands under "Other". `components/provider-groups.test.mjs` pins every
 * id of the checked-in omp roster to exactly one group, so an upstream
 * addition shows up as a test failure naming the id rather than as a
 * silently mis-filed row.
 */

export type ProviderGroup = "subscription" | "key" | "gateway" | "local" | "search" | "custom" | "other";

export const GROUP_ORDER: readonly ProviderGroup[] = ["subscription", "key", "gateway", "local", "search", "custom", "other"];

/** Settings-panel copy (English by decision); the wizard's picker uses the
 * `modelsConfig.group*` keys instead, which are tri-locale. */
export const GROUP_LABELS: Record<ProviderGroup, string> = {
  subscription: "Subscriptions",
  key: "API key",
  gateway: "Gateways & routers",
  local: "Local & self-hosted",
  search: "Search & tools",
  custom: "Custom endpoint",
  other: "Other",
};

/** A coding plan, a subscription or an OAuth account: the engine signs the
 * user in with a browser and keeps the token itself. */
export const SUBSCRIPTION_IDS: ReadonlySet<string> = new Set([
  "openai-codex",
  "openai-codex-device",
  "chatgpt",
  "anthropic",
  "claude",
  "anthropic-console",
  "zai",
  "zai-coding-plan",
  "kimi-code",
  "github-copilot",
  "cursor",
  "devin",
  "google-antigravity",
  "google-gemini-cli",
  "xai-oauth",
  "gitlab-duo",
  "gitlab-duo-agent",
  "alibaba-coding-plan",
  "alibaba-token-plan",
  "zhipu-coding-plan",
  "umans",
  "qwen-portal",
  "qwen-oauth",
  "minimax-code",
  "minimax-code-cn",
  "minimax-oauth",
  "xiaomi",
  "xiaomi-token-plan-sgp",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "firepass",
  "cline-pass",
  "perplexity",
  "nous",
]);

/** Plain API-key vendors the engine's roster lists (omp's /login prompts
 * for the key; Cody's key store reaches the same vendor by variable). */
export const KEY_IDS: ReadonlySet<string> = new Set([
  "openrouter",
  "xai",
  "deepseek",
  "meta",
  "moonshot",
  "cerebras",
  "baseten",
  "fireworks",
  "together",
  "nvidia",
  "novita",
  "deepinfra",
  "huggingface",
  "qianfan",
  "venice",
  "siliconflow",
  "siliconflow-cn",
  "synthetic",
  "coreweave",
  "wafer-serverless",
  "gmi-cloud",
  "sakana",
  "aiand",
  "abliteration",
  "ollama-cloud",
  "google",
  "groq",
  "mistral",
  "minimax",
  "kimi",
  "bedrock",
]);

/** One key, many vendors: a router in front of other people's models. */
export const GATEWAY_IDS: ReadonlySet<string> = new Set([
  "openrouter",
  "vercel-ai-gateway",
  "cloudflare-ai-gateway",
  "litellm",
  "kilo",
  "zenmux",
  "opencode-zen",
  "opencode-go",
  "yolo-auto",
  "nanogpt",
]);

/** Runs on the user's own machine or LAN; no account behind it. */
export const LOCAL_IDS: ReadonlySet<string> = new Set([
  "ollama",
  "lm-studio",
  "llama.cpp",
  "vllm",
]);

/** Not a model vendor at all: a web-search or tool API the engine calls. */
export const SEARCH_TOOL_IDS: ReadonlySet<string> = new Set([
  "tavily",
  "kagi",
  "exa",
  "parallel",
]);

/**
 * Regional or plan-scoped duplicates of one product, collapsed into one card
 * with a select in the Add picker: variant id → the id of the card it folds
 * into. Only variants that stay separate ROWS are listed; a variant the key
 * catalogue already joins into one row (openai-codex-device under OpenAI)
 * becomes a second sign-in method on that row instead.
 */
export const PROVIDER_VARIANTS: Readonly<Record<string, string>> = {
  "xiaomi-token-plan-sgp": "xiaomi",
  "xiaomi-token-plan-ams": "xiaomi",
  "xiaomi-token-plan-cn": "xiaomi",
  "gitlab-duo-agent": "gitlab-duo",
  "alibaba-token-plan": "alibaba-coding-plan",
  "siliconflow-cn": "siliconflow",
  "minimax-code-cn": "minimax-code",
  "openai-codex-device": "openai-codex",
  "xai-oauth": "xai",
  "zai-coding-plan": "zai",
  "google-antigravity": "google-gemini-cli",
};

/** Row ids (after the join) shown first inside their group. */
export const POPULAR_ORDER: readonly string[] = [
  "anthropic",
  "openai",
  "google",
  "github-copilot",
  "openrouter",
  "xai",
  "deepseek",
  "kimi",
  "zai",
  "minimax",
  "bedrock",
  "ollama",
];

/** Gateways win over the key table because OpenRouter is in both: it takes
 * a key, and it is a router. */
export function groupForProviderId(id: string): ProviderGroup {
  if (GATEWAY_IDS.has(id)) return "gateway";
  if (LOCAL_IDS.has(id)) return "local";
  if (SEARCH_TOOL_IDS.has(id)) return "search";
  if (SUBSCRIPTION_IDS.has(id)) return "subscription";
  if (KEY_IDS.has(id)) return "key";
  return "other";
}

/**
 * The group of a JOINED row: a custom endpoint is always "custom"; a row
 * with a sign-in method whose id is a subscription reads as a subscription
 * even when it also takes a key (Anthropic: Claude Pro/Max first, API key
 * second); otherwise the row id decides, falling back to the first login id
 * that has a group of its own.
 */
export function groupForRow(input: { id: string; loginIds?: readonly string[]; custom?: boolean }): ProviderGroup {
  if (input.custom) return "custom";
  const own = groupForProviderId(input.id);
  if (own === "gateway" || own === "local" || own === "search") return own;
  const logins = input.loginIds ?? [];
  if (logins.some((loginId) => SUBSCRIPTION_IDS.has(loginId))) return "subscription";
  if (own !== "other") return own;
  for (const loginId of logins) {
    const group = groupForProviderId(loginId);
    if (group !== "other") return group;
  }
  return "other";
}

export function popularityRank(id: string): number {
  const index = POPULAR_ORDER.indexOf(id);
  return index === -1 ? POPULAR_ORDER.length : index;
}
