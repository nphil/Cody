/**
 * Display-only branding for engine provider ids.
 *
 * The engine (and everything in lib/usage) speaks provider ids — "anthropic",
 * "openai-codex" — and account labels derived from them ("Anthropic (work)").
 * The owner-facing surfaces speak product brands: the Anthropic subscription
 * is Claude, the OpenAI coding plan is Codex. This mapping stays strictly in
 * the view layer; nothing here renames a data field.
 */

export type BrandIconId =
  | "claude"
  | "openai"
  | "gemini"
  | "copilot"
  | "azure"
  | "deepseek"
  | "mistral"
  | "llama"
  | "xai"
  | "groq"
  | "openrouter"
  | "cohere"
  | "bedrock"
  | "perplexity"
  | "cerebras"
  | "zhipu"
  | "moonshot"
  | "ollama"
  | "qwen";

export interface ProviderBrand {
  /** Product name the owner knows the subscription by. */
  name: string;
  /** Which vendored brand mark ProviderIcon should draw. */
  icon: BrandIconId;
}

const BRANDS: Record<string, ProviderBrand> = {
  // Subscriptions the owner knows by product name rather than vendor name.
  anthropic: { name: "Claude", icon: "claude" },
  claude: { name: "Claude", icon: "claude" },
  openai: { name: "OpenAI", icon: "openai" },
  "openai-codex": { name: "Codex", icon: "openai" },
  codex: { name: "Codex", icon: "openai" },
  google: { name: "Gemini", icon: "gemini" },
  gemini: { name: "Gemini", icon: "gemini" },
  "google-gemini": { name: "Gemini", icon: "gemini" },
  "google-vertex": { name: "Vertex AI", icon: "gemini" },
  vertex: { name: "Vertex AI", icon: "gemini" },
  "github-copilot": { name: "Copilot", icon: "copilot" },
  copilot: { name: "Copilot", icon: "copilot" },
  azure: { name: "Azure OpenAI", icon: "azure" },
  "azure-openai": { name: "Azure OpenAI", icon: "azure" },
  // Model vendors and gateways, keyed by every id the engines are known to
  // report for them. An id with no entry draws the neutral fallback mark.
  deepseek: { name: "DeepSeek", icon: "deepseek" },
  mistral: { name: "Mistral", icon: "mistral" },
  mistralai: { name: "Mistral", icon: "mistral" },
  "mistral-ai": { name: "Mistral", icon: "mistral" },
  meta: { name: "Llama", icon: "llama" },
  llama: { name: "Llama", icon: "llama" },
  "meta-llama": { name: "Llama", icon: "llama" },
  xai: { name: "xAI", icon: "xai" },
  grok: { name: "Grok", icon: "xai" },
  groq: { name: "Groq", icon: "groq" },
  openrouter: { name: "OpenRouter", icon: "openrouter" },
  cohere: { name: "Cohere", icon: "cohere" },
  "amazon-bedrock": { name: "Bedrock", icon: "bedrock" },
  bedrock: { name: "Bedrock", icon: "bedrock" },
  perplexity: { name: "Perplexity", icon: "perplexity" },
  cerebras: { name: "Cerebras", icon: "cerebras" },
  zhipuai: { name: "Zhipu AI", icon: "zhipu" },
  zhipu: { name: "Zhipu AI", icon: "zhipu" },
  moonshotai: { name: "Moonshot", icon: "moonshot" },
  moonshot: { name: "Moonshot", icon: "moonshot" },
  kimi: { name: "Moonshot", icon: "moonshot" },
  ollama: { name: "Ollama", icon: "ollama" },
  qwen: { name: "Qwen", icon: "qwen" },
  dashscope: { name: "Qwen", icon: "qwen" },
};

export function providerBrand(provider: string | null | undefined): ProviderBrand | null {
  if (typeof provider !== "string") return null;
  return BRANDS[provider.trim().toLowerCase()] ?? null;
}

/**
 * Which vendor's mark a MODEL should wear.
 *
 * A gateway is not a vendor: every model behind one OpenRouter key reports
 * `provider: "openrouter"`, so keying the picker off the provider alone paints
 * one identical mark down hundreds of rows and tells the reader nothing. The
 * model id is what carries the vendor — either as an explicit prefix
 * ("anthropic/claude-sonnet-4") or in the family name itself ("gpt-5.3") — so
 * that is consulted first and the provider is the fallback, not the lead.
 */
const MODEL_ID_BRANDS: readonly (readonly [RegExp, string])[] = [
  [/^(?:chat)?gpt|^o[1-9](?:$|[-.])|^codex|^davinci/, "openai"],
  [/^claude/, "anthropic"],
  [/^gem(?:ini|ma)/, "google"],
  [/^deepseek/, "deepseek"],
  [/^(?:mi[sx]tral|magistral|devstral|codestral|ministral|pixtral)/, "mistral"],
  [/^llama/, "meta"],
  [/^grok/, "xai"],
  [/^q(?:wen|wq)/, "qwen"],
  [/^(?:kimi|moonshot)/, "moonshotai"],
  [/^(?:chat)?glm/, "zhipuai"],
  [/^command/, "cohere"],
];

export function modelBrand(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): ProviderBrand | null {
  const id = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  const slash = id.indexOf("/");
  // "anthropic/claude-sonnet-4" — the vendor states itself.
  if (slash > 0) {
    const vendor = providerBrand(id.slice(0, slash));
    if (vendor) return vendor;
  }
  const family = slash > 0 ? id.slice(slash + 1) : id;
  for (const [pattern, key] of MODEL_ID_BRANDS) {
    if (pattern.test(family)) return BRANDS[key] ?? null;
  }
  return providerBrand(provider);
}

/**
 * Rebrand an account label the usage layer built from a provider id.
 *
 * The server names accounts by title-casing the id ("openai-codex" → "Openai
 * Codex"), optionally with a discriminator ("Anthropic (work)"). Swapping just
 * that derived prefix keeps the discriminator — "Claude (work)" — while a
 * label that is not derived from the id (an org name, say) is somebody's own
 * words and passes through untouched.
 */
export function brandAccountLabel(provider: string | null | undefined, label: string): string {
  const brand = providerBrand(provider);
  if (!brand) return label;
  const trimmed = label.trim();
  if (!trimmed) return brand.name;
  const derived = defaultProviderLabel(provider!);
  if (trimmed.toLowerCase() === provider!.trim().toLowerCase()) return brand.name;
  if (trimmed.toLowerCase().startsWith(derived.toLowerCase())) {
    const suffix = trimmed.slice(derived.length);
    // Only a word boundary counts as "the derived name plus a discriminator";
    // an org actually called "Anthropical" keeps its own name.
    if (suffix === "" || suffix.startsWith(" ") || suffix.startsWith(" (")) {
      return `${brand.name}${suffix}`;
    }
  }
  return trimmed;
}

/** Mirror of the usage layer's account naming: "openai-codex" → "Openai Codex". */
function defaultProviderLabel(provider: string): string {
  return provider
    .trim()
    .split(/[-_]/g)
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
    .filter(Boolean)
    .join(" ");
}
