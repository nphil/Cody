import type { UsageWindow } from "./types";

/**
 * Which of an account's windows actually constrain one model.
 *
 * A quota window is not always "the whole account": omp scopes what a request
 * is checked against per provider (`scopeLimits` / `blockScope` in pi-ai's
 * usage strategies), and Cody has to apply the same scoping or it reads a
 * healthy model as spent (or a spent one as healthy). The rules mirrored here
 * are the ones whose inputs the usage report itself carries — window ids,
 * tiers, and a block's scope — never a model list that only the catalog knows:
 *
 * - **Claude**: a tiered window (`tier: "fable"`) binds the models of that
 *   family and no others; shared (untiered) windows bind everything.
 * - **Codex**: a Spark model spends only the Spark meter and every other
 *   model only the 5-hour / weekly plan windows. A credit-billed seat has no
 *   plan windows, so its spend cap stands in for them; beside plan windows
 *   the cap only bounds credit-funded overage and gates nothing.
 * - **Cursor**: an "X Subscription" reports a weekly pool for Cursor's own
 *   models (Auto, Composer, Grok) and a prepaid-credit pool for every other
 *   model. A model is only ever limited by its own pool; a plan without that
 *   split reports one combined window that binds every model.
 * - **Factory Droid**: the extra-balance meter is a top-up, not a gate.
 * - **A block** (omp refused the credential after one rejected request)
 *   binds exactly what its scope names; an unrecognised scope binds the whole
 *   account, because refusing too much is safer than sending into a refusal.
 *
 * Everything else keeps the original rule: a window with a tier binds the
 * models that tier names (whole-token match), an untiered window binds all.
 * Plan-label tiers (Copilot's `individual`, Devin's plan name) therefore name
 * no model and constrain none — the reading is shown, it just does not gate.
 */

export const CURSOR_AUTO_POOL_WINDOW = "cursor:usd:individual-auto";
export const CURSOR_API_POOL_WINDOW = "cursor:usd:individual-api";
export const CODEX_SPEND_CAP_WINDOW = "openai-codex:spend-cap";
const CODEX_PLAN_WINDOWS = new Set(["openai-codex:primary", "openai-codex:secondary"]);
const FACTORY_DROID_EXTRA_BALANCE_WINDOW = "factory-droid:extra-balance";

function normalize(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Whether a tier-scoped window covers a given model.
 *
 * The tier has to appear in the model id as a whole token — delimited by
 * non-alphanumerics or the ends of the string — so "opus" matches
 * "claude-opus-4-5" but not "claude-opusx". Substring matching would quietly
 * charge one model's quota against an unrelated model whose name happens to
 * contain the tier.
 */
export function modelMatchesTier(modelId: string, tier: string): boolean {
  const haystack = normalize(modelId);
  const needle = normalize(tier);
  if (!haystack || !needle) return false;

  for (let from = 0; ; from = from + 1) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    if (!isAlphanumericAt(haystack, at - 1) && !isAlphanumericAt(haystack, at + needle.length)) return true;
    from = at;
  }
}

function isAlphanumericAt(value: string, index: number): boolean {
  if (index < 0 || index >= value.length) return false;
  const code = value.charCodeAt(index);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

export type CursorPool = "auto" | "api";

/** The Cursor billing pool a model spends (omp's `quotaTierFor("cursor", …)`):
 * Cursor's own models — Auto/default, Composer, Grok — spend the weekly pool;
 * every other model spends the prepaid-credit pool. */
export function cursorPoolOf(modelId: string): CursorPool {
  const id = normalize(modelId);
  return id === "composer-2.5" || id === "default" || id.includes("grok") || id.includes("composer") ? "auto" : "api";
}

/** Whether a Codex model spends the separate Spark meter rather than the
 * 5-hour / weekly chat windows (omp's `quotaTierFor("openai-codex", …)`). */
export function isCodexSparkModel(modelId: string): boolean {
  const id = normalize(modelId);
  return id === "gpt-5.3-codex-spark" || id.includes("-spark");
}

/** Per-account facts that decide how a window is scoped, computed once. */
interface ScopeContext {
  provider: string;
  modelId: string;
  /** Codex: the model spends the Spark meter. */
  spark: boolean;
  /** Codex: the account reports 5-hour / weekly plan windows. */
  hasCodexPlanWindows: boolean;
  /** Cursor: the account reports the split weekly / prepaid pools. */
  cursorSplit: boolean;
  /** Cursor: the pool this model (or, with no model, the preferred view) spends. */
  cursorPool: CursorPool;
}

function buildContext(windows: readonly UsageWindow[], provider: string, modelId: string): ScopeContext {
  const hasWindow = (id: string): boolean => windows.some((window) => window.source !== "block" && window.id === id);
  const hasAuto = hasWindow(CURSOR_AUTO_POOL_WINDOW);
  const hasApi = hasWindow(CURSOR_API_POOL_WINDOW);
  return {
    provider,
    modelId,
    spark: isCodexSparkModel(modelId),
    hasCodexPlanWindows: windows.some((window) => window.source !== "block" && CODEX_PLAN_WINDOWS.has(window.id)),
    cursorSplit: hasAuto || hasApi,
    // omp scopes nothing when no model is named; the provider-level view
    // reads the weekly pool (the one Cursor's own models and the Auto router
    // spend) and only falls back to the prepaid pool when that is all there is.
    cursorPool: modelId ? cursorPoolOf(modelId) : hasAuto || !hasApi ? "auto" : "api",
  };
}

/** Whether one block window refuses requests for this model. */
function blockCovers(window: UsageWindow, context: ScopeContext): boolean {
  const scope = normalize(window.blockScope);
  if (!scope) return true;
  if (scope.startsWith("tier:")) return modelMatchesTier(context.modelId, scope.slice("tier:".length));
  if (context.provider === "openai-codex") {
    if (scope === "spark") return context.spark;
    if (scope === "chat") return !context.spark;
    return true; // "shared" is the legacy "block everything" scope
  }
  if (context.provider === "cursor" && scope.startsWith("pool:")) {
    return scope.slice("pool:".length) === context.cursorPool;
  }
  return true;
}

function windowConstrains(window: UsageWindow, context: ScopeContext): boolean {
  if (window.source === "block") return blockCovers(window, context);

  switch (context.provider) {
    case "openai-codex":
      if (CODEX_PLAN_WINDOWS.has(window.id)) return !context.spark;
      if (window.id === CODEX_SPEND_CAP_WINDOW) return !context.spark && !context.hasCodexPlanWindows;
      break;
    case "cursor":
      if (context.cursorSplit && window.id === CURSOR_AUTO_POOL_WINDOW) return context.cursorPool === "auto";
      if (context.cursorSplit && window.id === CURSOR_API_POOL_WINDOW) return context.cursorPool === "api";
      break;
    case "factory-droid":
      if (window.id === FACTORY_DROID_EXTRA_BALANCE_WINDOW) return false;
      break;
    default:
      break;
  }

  // A reported tier scopes a window to its own models. OMP can mark a tiered
  // bucket shared too, so that flag must not erase the scope and charge it to
  // another model. Untiered windows bind the whole account.
  const tier = typeof window.tier === "string" ? window.tier.trim() : "";
  return !tier || modelMatchesTier(context.modelId, tier);
}

/**
 * The windows of ONE account that constrain `modelId` (empty string: the
 * provider-level view), in the order given. Pure; never mutates a window.
 */
export function constrainingWindows(
  windows: readonly UsageWindow[] | null | undefined,
  provider: string,
  modelId: string,
): UsageWindow[] {
  const list = (windows ?? []).filter((window): window is UsageWindow => Boolean(window));
  if (list.length === 0) return [];
  const context = buildContext(list, normalize(provider), typeof modelId === "string" ? modelId : "");
  return list.filter((window) => windowConstrains(window, context));
}

/**
 * Whether a window says something about the WHOLE account: not scoped to a
 * model family by a tier, and not a block whose scope names only part of what
 * the account serves. The provider-wide blackout, the "every account is out"
 * verdict and the unblock flow all read this; a Fable-only block or a Spark
 * meter must not take Opus or ordinary Codex chat out of routing.
 */
export function isAccountWideWindow(window: UsageWindow | null | undefined): boolean {
  if (!window) return false;
  if (typeof window.tier === "string" && window.tier.trim()) return false;
  const scope = normalize(window.blockScope);
  return !(scope.startsWith("tier:") || scope.startsWith("pool:") || scope === "spark");
}

/** The tier a block scope implies, when it names a model family — so a scoped
 * block carries the same `tier` a measured window for that family would. */
export function tierOfBlockScope(scope: string | null | undefined): string | null {
  const value = normalize(scope);
  if (value.startsWith("tier:")) return value.slice("tier:".length) || null;
  if (value === "spark") return "spark";
  return null;
}
