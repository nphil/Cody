/**
 * The model providers an engine can be pointed at with an API key, and the
 * environment variable each engine reads that key from.
 *
 * Every engine Cody drives resolves credentials from the environment before
 * anything else: pi's env map, omp's (pi's descendant, same names and more),
 * Hermes' provider registry (`api_key_env_vars`), the Claude CLI's
 * ANTHROPIC_API_KEY, Codex's OPENAI_API_KEY. That makes an environment
 * variable the one credential path all five share — which is why Cody stores
 * keys by VARIABLE NAME and hands them to every engine child it spawns
 * (lib/harness/provider-keys.ts), rather than writing five different auth
 * files it would have to keep in step with five upstreams.
 *
 * This list is deliberately data: a provider is a name, the engines that
 * understand it, and the variables it needs. Multi-variable providers (Bedrock
 * wants an access key, a secret and a region) are one entry with several
 * fields, so the panel can ask for all of them at once.
 */

export interface ProviderVariable {
  /** The environment variable name, exactly as the engines read it. */
  name: string;
  /** Short field label for the panel. */
  label: string;
  /** Secrets are masked in the UI and never echoed back by the API. */
  secret: boolean;
  /** Where to get one, when it is not obvious. */
  hint?: string;
  /** The engine works without it (it has a default), so its absence is a
   * hint on the provider's row ("Region not set"), not an unconfigured
   * provider. */
  optional?: boolean;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  /** Engine ids that read these variables. */
  engines: readonly string[];
  variables: readonly ProviderVariable[];
  /**
   * The ids the engines' OWN sign-in rosters use for the same vendor, so the
   * Providers hub can fold a subscription and its API key into one row:
   * omp's `anthropic` OAuth entry and `ANTHROPIC_API_KEY` are two ways of
   * reaching one provider, not two providers. An id absent here stays a row
   * of its own — the roster is the engine's, and an unmapped entry is still
   * listed, just not merged.
   */
  loginIds?: readonly string[];
  /**
   * The ids an engine's MODEL catalog files models under for this provider,
   * when they differ from `id` (omp serves Bedrock models as
   * `amazon-bedrock`, the Kimi key's as `kimi-coding`). Model counts on the
   * row sum over `id`, these, and `loginIds`.
   */
  catalogIds?: readonly string[];
}

const ALL = ["omp", "pi", "hermes"] as const;

// `loginIds` name every engine's roster entry for the vendor: omp's and pi's
// pi-ai ids, Claude Code's `claude` / `anthropic-console`, Codex's `chatgpt`,
// Hermes' `*-oauth` ids. `catalogIds` name the model-catalog provider ids
// that differ from the row id. Both are joins, never displayed as such.
export const PROVIDER_CATALOG: readonly ProviderDefinition[] = [
  { id: "anthropic", name: "Anthropic", engines: [...ALL, "claude"], variables: [{ name: "ANTHROPIC_API_KEY", label: "API key", secret: true }], loginIds: ["anthropic", "claude", "anthropic-console"] },
  { id: "openai", name: "OpenAI", engines: [...ALL, "codex"], variables: [{ name: "OPENAI_API_KEY", label: "API key", secret: true }], loginIds: ["openai-codex", "openai-codex-device", "chatgpt"] },
  { id: "openrouter", name: "OpenRouter", engines: ALL, variables: [{ name: "OPENROUTER_API_KEY", label: "API key", secret: true }], loginIds: ["openrouter"] },
  { id: "google", name: "Google Gemini", engines: ALL, variables: [{ name: "GEMINI_API_KEY", label: "API key", secret: true }], loginIds: ["google-gemini-cli", "google-antigravity"] },
  { id: "xai", name: "xAI", engines: ALL, variables: [{ name: "XAI_API_KEY", label: "API key", secret: true }], loginIds: ["xai", "xai-oauth"] },
  { id: "deepseek", name: "DeepSeek", engines: ALL, variables: [{ name: "DEEPSEEK_API_KEY", label: "API key", secret: true }], loginIds: ["deepseek"] },
  { id: "groq", name: "Groq", engines: ["omp", "pi"], variables: [{ name: "GROQ_API_KEY", label: "API key", secret: true }] },
  { id: "mistral", name: "Mistral", engines: ["omp", "pi"], variables: [{ name: "MISTRAL_API_KEY", label: "API key", secret: true }] },
  { id: "huggingface", name: "Hugging Face", engines: ["omp", "pi", "hermes"], variables: [{ name: "HF_TOKEN", label: "Access token", secret: true }], loginIds: ["huggingface"] },
  { id: "cerebras", name: "Cerebras", engines: ["omp", "pi"], variables: [{ name: "CEREBRAS_API_KEY", label: "API key", secret: true }], loginIds: ["cerebras"] },
  { id: "fireworks", name: "Fireworks", engines: ["omp", "pi"], variables: [{ name: "FIREWORKS_API_KEY", label: "API key", secret: true }], loginIds: ["fireworks"] },
  { id: "minimax", name: "MiniMax", engines: ["omp", "pi", "hermes"], variables: [{ name: "MINIMAX_API_KEY", label: "API key", secret: true }], loginIds: ["minimax-code", "minimax-code-cn", "minimax-oauth"], catalogIds: ["minimax-cn"] },
  { id: "kimi", name: "Kimi (Moonshot)", engines: ["omp", "pi", "hermes"], variables: [{ name: "KIMI_API_KEY", label: "API key", secret: true }], loginIds: ["kimi-code", "moonshot"], catalogIds: ["kimi-coding", "moonshotai"] },
  { id: "zai", name: "Z.AI", engines: ["omp", "pi", "hermes"], variables: [{ name: "ZAI_API_KEY", label: "API key", secret: true }], loginIds: ["zai", "zai-coding-plan"], catalogIds: ["zai-coding-cn"] },
  { id: "ollama-cloud", name: "Ollama Cloud", engines: ["hermes"], variables: [{ name: "OLLAMA_API_KEY", label: "API key", secret: true }], loginIds: ["ollama-cloud"] },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    engines: ALL,
    variables: [
      { name: "AWS_ACCESS_KEY_ID", label: "Access key ID", secret: false },
      { name: "AWS_SECRET_ACCESS_KEY", label: "Secret access key", secret: true },
      // The SDK falls back to its own default region, so a missing one is a
      // row hint, not an unconfigured provider.
      { name: "AWS_REGION", label: "Region", secret: false, hint: "e.g. us-east-1", optional: true },
    ],
    catalogIds: ["amazon-bedrock"],
  },
];

/** Every variable name the catalog knows, for validating writes. */
export const PROVIDER_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  PROVIDER_CATALOG.flatMap((provider) => provider.variables.map((variable) => variable.name)),
);

export function providersForEngine(engineId: string): ProviderDefinition[] {
  return PROVIDER_CATALOG.filter((provider) => provider.engines.includes(engineId));
}
