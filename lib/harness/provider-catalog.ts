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
}

export interface ProviderDefinition {
  id: string;
  name: string;
  /** Engine ids that read these variables. */
  engines: readonly string[];
  variables: readonly ProviderVariable[];
}

const ALL = ["omp", "pi", "hermes"] as const;

export const PROVIDER_CATALOG: readonly ProviderDefinition[] = [
  { id: "anthropic", name: "Anthropic", engines: [...ALL, "claude"], variables: [{ name: "ANTHROPIC_API_KEY", label: "API key", secret: true }] },
  { id: "openai", name: "OpenAI", engines: [...ALL, "codex"], variables: [{ name: "OPENAI_API_KEY", label: "API key", secret: true }] },
  { id: "openrouter", name: "OpenRouter", engines: ALL, variables: [{ name: "OPENROUTER_API_KEY", label: "API key", secret: true }] },
  { id: "google", name: "Google Gemini", engines: ALL, variables: [{ name: "GEMINI_API_KEY", label: "API key", secret: true }] },
  { id: "xai", name: "xAI", engines: ALL, variables: [{ name: "XAI_API_KEY", label: "API key", secret: true }] },
  { id: "deepseek", name: "DeepSeek", engines: ALL, variables: [{ name: "DEEPSEEK_API_KEY", label: "API key", secret: true }] },
  { id: "groq", name: "Groq", engines: ["omp", "pi"], variables: [{ name: "GROQ_API_KEY", label: "API key", secret: true }] },
  { id: "mistral", name: "Mistral", engines: ["omp", "pi"], variables: [{ name: "MISTRAL_API_KEY", label: "API key", secret: true }] },
  { id: "huggingface", name: "Hugging Face", engines: ["omp", "pi", "hermes"], variables: [{ name: "HF_TOKEN", label: "Access token", secret: true }] },
  { id: "cerebras", name: "Cerebras", engines: ["omp", "pi"], variables: [{ name: "CEREBRAS_API_KEY", label: "API key", secret: true }] },
  { id: "fireworks", name: "Fireworks", engines: ["omp", "pi"], variables: [{ name: "FIREWORKS_API_KEY", label: "API key", secret: true }] },
  { id: "minimax", name: "MiniMax", engines: ["omp", "pi", "hermes"], variables: [{ name: "MINIMAX_API_KEY", label: "API key", secret: true }] },
  { id: "kimi", name: "Kimi (Moonshot)", engines: ["omp", "pi", "hermes"], variables: [{ name: "KIMI_API_KEY", label: "API key", secret: true }] },
  { id: "zai", name: "Z.AI", engines: ["omp", "pi", "hermes"], variables: [{ name: "ZAI_API_KEY", label: "API key", secret: true }] },
  { id: "ollama-cloud", name: "Ollama Cloud", engines: ["hermes"], variables: [{ name: "OLLAMA_API_KEY", label: "API key", secret: true }] },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    engines: ALL,
    variables: [
      { name: "AWS_ACCESS_KEY_ID", label: "Access key ID", secret: false },
      { name: "AWS_SECRET_ACCESS_KEY", label: "Secret access key", secret: true },
      { name: "AWS_REGION", label: "Region", secret: false, hint: "e.g. us-east-1" },
    ],
  },
];

/** Every variable name the catalog knows, for validating writes. */
export const PROVIDER_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  PROVIDER_CATALOG.flatMap((provider) => provider.variables.map((variable) => variable.name)),
);

export function providersForEngine(engineId: string): ProviderDefinition[] {
  return PROVIDER_CATALOG.filter((provider) => provider.engines.includes(engineId));
}
