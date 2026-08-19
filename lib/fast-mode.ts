import type { OmpModel } from "./omp/rpc-utility";

/**
 * Which models can actually honor the composer's fast-mode toggle.
 *
 * The toggle is not a generic "be quicker" switch: it sets the PRIORITY service
 * tier for the selected model's provider family (the harness exposes the same
 * thing as `/fast`). Only some families realize that on the wire — direct
 * Anthropic turns it into `speed: "fast"` plus a fast-mode beta header, the
 * OpenAI family sends a `service_tier` field, and everyone else has nothing to
 * send. The composer hides the control rather than offering one that silently
 * does nothing, so this predicate decides whether it appears at all.
 *
 * This restates upstream logic (`serviceTierFamily` + `realizesPriorityServiceTier`
 * in the harness's AI package) because Cody cannot import it: those packages are
 * Bun-only. That means it can drift, and this is the file to re-check against
 * upstream when a provider is added.
 *
 * Two deliberate omissions:
 * - Upstream also has a catalog-driven fallback that recognizes OpenAI-shaped
 *   models served by unrelated custom providers. Replicating it would need the
 *   catalog, so an exotic custom provider gets no toggle here. That is the safe
 *   direction: a hidden control beats a control that no-ops.
 * - Fireworks is excluded on purpose. Priority is real there, but `/fast` does
 *   not drive it — it has its own separate provider tier setting, and upstream
 *   gives those models no service-tier family at all.
 */
export function supportsPriorityFastMode(model: Pick<OmpModel, "provider" | "api" | "id">): boolean {
  const provider = model.provider;
  // Direct Anthropic is the only place Claude realizes priority.
  if (provider === "anthropic") return true;
  // Claude served by anyone else — Bedrock, Vertex, an Anthropic-compatible
  // proxy — accepts the request and drops the tier. Checked before the provider
  // branches below so Vertex-served and OpenRouter-served Claude both land here.
  if (model.api === "anthropic-messages") return false;
  // The Codex subscription is its own provider id, distinct from the API's.
  // Missing it is what hid this control from Codex models.
  if (provider === "openai" || provider === "openai-codex") return true;
  if (provider === "google" || provider === "google-vertex") return true;
  // OpenRouter realizes priority only for its OpenAI- and Google-family
  // upstreams, which are identifiable only from the model id's prefix.
  if (provider === "openrouter") {
    return model.id.startsWith("openai/") || model.id.startsWith("google/");
  }
  return false;
}
