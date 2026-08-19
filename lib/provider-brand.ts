/**
 * Display-only branding for engine provider ids.
 *
 * The engine (and everything in lib/usage) speaks provider ids — "anthropic",
 * "openai-codex" — and account labels derived from them ("Anthropic (work)").
 * The owner-facing surfaces speak product brands: the Anthropic subscription
 * is Claude, the OpenAI coding plan is Codex. This mapping stays strictly in
 * the view layer; nothing here renames a data field.
 */

export type BrandIconId = "claude" | "openai" | "gemini" | "copilot";

export interface ProviderBrand {
  /** Product name the owner knows the subscription by. */
  name: string;
  /** Which vendored brand mark ProviderIcon should draw. */
  icon: BrandIconId;
}

const BRANDS: Record<string, ProviderBrand> = {
  anthropic: { name: "Claude", icon: "claude" },
  claude: { name: "Claude", icon: "claude" },
  openai: { name: "OpenAI", icon: "openai" },
  "openai-codex": { name: "Codex", icon: "openai" },
  google: { name: "Gemini", icon: "gemini" },
  gemini: { name: "Gemini", icon: "gemini" },
  "google-gemini": { name: "Gemini", icon: "gemini" },
  "github-copilot": { name: "Copilot", icon: "copilot" },
};

export function providerBrand(provider: string | null | undefined): ProviderBrand | null {
  if (typeof provider !== "string") return null;
  return BRANDS[provider.trim().toLowerCase()] ?? null;
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
