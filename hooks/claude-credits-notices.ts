/**
 * The chat-side decisions behind the Claude plan -> API credits hand-off
 * (see lib/claude-credits.ts). Pure so they can be tested without React.
 *
 * What the chat should say, and when:
 * - A plan failing with a usage limit is usually followed within milliseconds
 *   by the switch to the credits. Posting the limit warning at once would show
 *   two notices for one event, so it is HELD for a moment and dropped when the
 *   retry starts (`shouldHoldPlanLimitNotice`).
 * - The switch itself, and the later return to the plan, each get one notice
 *   (`creditsNoticeKind`).
 */
import { CLAUDE_PLAN_PROVIDER, isClaudeCreditsReturn, isClaudeCreditsSwitch } from "@/lib/claude-credits";
import { describeEngineError } from "@/lib/error-text";

/** How long a plan-limit warning waits for `auto_retry_start` to cancel it.
 * The retry frame follows the failed message within milliseconds; a second
 * is generous, and a real failure (no retry) still reads as prompt. */
export const PLAN_LIMIT_NOTICE_HOLD_MS = 1_000;

/**
 * True for a failed assistant message that is the Claude PLAN hitting its
 * usage limit — the one error the credits are expected to take over from.
 * Anything else (another provider, the credits themselves, an auth failure,
 * an outage) keeps its immediate notice.
 */
export function shouldHoldPlanLimitNotice(message: { provider?: unknown; errorMessage?: unknown } | null | undefined): boolean {
  if (!message || message.provider !== CLAUDE_PLAN_PROVIDER) return false;
  const detail = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (!detail) return false;
  return describeEngineError(detail).kind === "usage";
}

/** How long the retry banner for a plan limit waits for the credits switch to
 * cancel it. Longer than the server's hold on `retry_fallback_applied`
 * (~1.2 s) plus delivery, so the plan's raw limit text never flashes. */
export const PLAN_LIMIT_RETRY_BANNER_HOLD_MS = 1_600;

/**
 * True when an automatic retry's banner should wait: the MAIN conversation's
 * retry after a Claude PLAN usage limit, which the credits are expected to
 * take over from. `provider` is the provider of the call that failed.
 * Subagent retries, other providers and other error kinds show at once.
 */
export function shouldHoldRetryBanner(retry: { job: "main" | "subagent"; provider?: unknown; errorMessage?: unknown }): boolean {
  return retry.job === "main" && shouldHoldPlanLimitNotice({ provider: retry.provider, errorMessage: retry.errorMessage });
}

/** "switch": plan -> credits. "return": credits -> plan. Null: neither. */
export type CreditsNoticeKind = "switch" | "return";

export function creditsNoticeKind(from: unknown, to: unknown): CreditsNoticeKind | null {
  if (isClaudeCreditsSwitch(from, to)) return "switch";
  if (isClaudeCreditsReturn(from, to)) return "return";
  return null;
}

/** omp names a model `provider/id`; the authoritative model state carries the halves apart. */
export function modelSelector(model: { provider: string; modelId: string }): string {
  return `${model.provider}/${model.modelId}`;
}
