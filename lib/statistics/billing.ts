/**
 * How each provider is paid for, which decides the honesty label of every
 * figure on the Statistics page:
 *
 *  - a subscription login (a Claude plan, a ChatGPT plan, Copilot, ...) shows
 *    what the usage WOULD cost on the API, marked as an estimate;
 *  - pay-as-you-go (Claude API credits, an API key, a gateway) is real money;
 *  - a local runtime has no per-token price at all.
 *
 * The id tables are the ones the Providers settings screen already groups by
 * (`components/settings/providers/provider-groups.ts`), so "subscription" means
 * the same thing here as it does there; only the two ids the engine adds for
 * Claude API credits (`anthropic-api`, `anthropic-api-2`, ...) are handled
 * apart, because they live under their own provider ids on purpose.
 */

import {
  GATEWAY_IDS,
  KEY_IDS,
  LOCAL_IDS,
  SUBSCRIPTION_IDS,
} from "../../components/settings/providers/provider-groups";
import { claudeCreditsSlot } from "../claude-credits";
import { providerBrand } from "../provider-brand";
import type { BillingKind } from "./types";

/** Local runtimes the settings table does not list but real transcripts name. */
const EXTRA_LOCAL_IDS: Record<string, true> = {
  "llama-swap": true,
  llamacpp: true,
  lmstudio: true,
  koboldcpp: true,
  localai: true,
  tabbyapi: true,
};

/** First-party API vendors a transcript names without an entry in the key table. */
const EXTRA_KEY_IDS: Record<string, true> = {
  openai: true,
  "anthropic-api": true,
  azure: true,
  "azure-openai": true,
  vertex: true,
  "google-vertex": true,
  "amazon-bedrock": true,
};

const listed = (table: Record<string, true>, id: string): boolean => Object.hasOwn(table, id);

/**
 * The billing kind of a provider id as it appears on an assistant message.
 *
 * `anthropic` and `openai-codex` are the plan logins; a bare `openai` is an API
 * key. An id the tables do not know is `unknown` rather than guessed: the page
 * then marks its figure as an estimate of unknown standing instead of calling
 * it real money.
 */
export function billingKind(provider: string): BillingKind {
  if (claudeCreditsSlot(provider) !== null) return "payg";
  if (LOCAL_IDS.has(provider) || listed(EXTRA_LOCAL_IDS, provider)) return "local";
  if (SUBSCRIPTION_IDS.has(provider)) return "subscription";
  if (GATEWAY_IDS.has(provider) || KEY_IDS.has(provider) || listed(EXTRA_KEY_IDS, provider)) return "payg";
  return "unknown";
}

/**
 * What a provider is called on the page: the product name the owner knows it
 * by ("Claude", "Codex"), "Claude API" for a pay-as-you-go Claude key (the plan
 * and the key are different bills), otherwise the id with its dashes tidied.
 */
export function providerLabel(provider: string): string {
  const slot = claudeCreditsSlot(provider);
  if (slot !== null) return slot === 0 ? "Claude API" : `Claude API ${slot + 1}`;
  const brand = providerBrand(provider);
  if (brand) return brand.name;
  return provider
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
