"use client";

/**
 * Settings › Providers: how the engine reaches a model vendor. The hub is
 * `ProviderDirectory` — Connected rows, Discovered local runtimes, and Add —
 * with `ProviderDetail` behind every row. Every engine has it: sign-ins gate
 * on `providerLogin`, keys are for all five, custom endpoints and curation
 * on `models`.
 */
import type { SearchEntry } from "../search-index";
import { SaveStatusCorner } from "../SaveStatus";
import { ProviderDirectory } from "../providers/ProviderDirectory";
import { PROVIDERS_PANEL_ID } from "../providers/ProviderDetail";

export { PROVIDERS_PANEL_ID };

export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  {
    id: "add-provider",
    tab: "providers",
    label: "Add provider",
    description: "Sign in to a subscription, save an API key, or add a local OpenAI-compatible endpoint.",
    keywords: ["api key", "sign in", "oauth", "subscription", "anthropic", "openai", "openrouter", "bedrock", "gemini", "ollama", "credentials"],
    breadcrumb: ["Providers"],
    action: "jump",
  },
  {
    id: "discovered-runtimes",
    tab: "providers",
    label: "Local AI runtimes",
    description: "Ollama, LM Studio and llama.cpp / llama-swap found on well-known ports where Cody runs.",
    keywords: ["local ai", "ollama", "lm studio", "llama.cpp", "llama-swap", "scan", "discovered"],
    breadcrumb: ["Providers"],
    action: "jump",
  },
];

export function ProvidersPanel() {
  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <SaveStatusCorner panelId={PROVIDERS_PANEL_ID} />
      <ProviderDirectory />
    </div>
  );
}
