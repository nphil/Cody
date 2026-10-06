/**
 * Which usage provider meters a model: the one translation between an engine's
 * own provider ids and the ids `omp usage` reports accounts under.
 *
 * Shared by the composer's quota ring and by the server's scheduled messages,
 * which wait on the SAME answer to "has this model's quota refilled?".
 */

/** The founding engine's id (components/SettingsTabs `OMP_ENGINE_ID`). Repeated here because lib/ never imports from components/. */
const OMP_ENGINE = "omp";

/** omp's own models already carry the provider id `/api/usage` reports
 *  accounts under ("anthropic", "openai-codex", ...). An ACP engine (Claude
 *  Code, Codex) instead reports every one of ITS models under its own
 *  engine id as `provider` (`lib/harness/acp-session.ts`'s `resolvedModel()`
 *  sets `provider: this.spec.id`), so a bare "claude-opus-4-5" or "gpt-5.1"
 *  needs translating before it means anything to the usage snapshot. */
const ACP_ENGINE_USAGE_PROVIDER: Record<string, string> = {
  claude: "anthropic",
  codex: "openai-codex",
};

/**
 * The omp usage-provider id that actually meters a model, or null when Cody
 * cannot say so with confidence.
 *
 * Deliberately conservative: only omp itself (whose models already carry the
 * right id) and the two ACP engines above translate, and only when the
 * option's own provider IS that engine's id — never a guess for Pi, Hermes,
 * or any other engine. A wrong guess would mark a healthy model exhausted,
 * or hide a real exhaustion; showing nothing is the safe wrong answer,
 * mismarking is not.
 */
export function usageProviderFor(engineId: string | null | undefined, modelProvider: string): string | null {
  if (engineId === OMP_ENGINE) return modelProvider;
  if (!engineId || modelProvider !== engineId) return null;
  return ACP_ENGINE_USAGE_PROVIDER[engineId] ?? null;
}
