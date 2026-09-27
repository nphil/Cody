import { describeEngineError } from "../lib/error-text";

export interface SessionControlScope {
  sessionId: string | null;
  provider: string | null;
  modelId: string | null;
}

export type ScopedModel = { provider: string; modelId: string } | null | undefined;

/** A session control reply may only update the session/model that sent it. */
export function sessionControlScope(sessionId: string | null, model: ScopedModel): SessionControlScope {
  return {
    sessionId,
    provider: model?.provider ?? null,
    modelId: model?.modelId ?? null,
  };
}

export function sameSessionControlScope(left: SessionControlScope, right: SessionControlScope): boolean {
  return left.sessionId === right.sessionId
    && left.provider === right.provider
    && left.modelId === right.modelId;
}

/** Only the engine's explicit Fast capability rejection disables its control. */
export function isFastModeUnavailableError(error: unknown): boolean {
  const record = typeof error === "object" && error !== null ? error as { code?: unknown } : null;
  if (record?.code === "unsupported") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /fast mode is unavailable for the current model/i.test(message);
}

/** What the reasoning selector shows after the engine reports a level.
 *
 *  omp represents Auto as the EFFECTIVE level it resolved ("high") plus
 *  `configured: "auto"` on the `thinking_level_changed` event only; a
 *  `get_state` snapshot carries the effective level alone. So the selector the
 *  user chose has to be remembered between events: a snapshot must not repaint
 *  Auto as an explicit High, and an explicit pick (whose echo carries no
 *  `configured`) must stop it reading as Auto. Returns the remembered flag
 *  alongside the level to display. */
export function resolveThinkingSelector(
  effective: string | undefined,
  configured: string | undefined,
  rememberedAuto: boolean,
): { display: string; rememberedAuto: boolean } {
  const auto = configured !== undefined ? configured === "auto" || configured === "inherit" : rememberedAuto;
  const level = effective ?? configured;
  return { display: auto || !level || level === "inherit" ? "auto" : level, rememberedAuto: auto };
}
/** A user-selected model held until it is safe to send to the live session. */
export interface PendingModelSwitch {
  scope: SessionControlScope;
  provider: string;
  modelId: string;
  name: string;
  phase: "waiting" | "applying";
}

/** Create a waiting request. Replacing this value intentionally drops an older pick. */
export function queueModelSwitch(
  scope: SessionControlScope,
  model: Pick<PendingModelSwitch, "provider" | "modelId" | "name">,
): PendingModelSwitch {
  return { ...model, scope, phase: "waiting" };
}

/**
 * Promote a queued switch only at a boundary where no provider stream is in
 * flight. A model/session change while it waited makes the request stale.
 */
export function releaseModelSwitchAtBoundary(
  pending: PendingModelSwitch | null,
  currentScope: SessionControlScope,
  atSafeBoundary: boolean,
): { pending: PendingModelSwitch | null; command: PendingModelSwitch | null } {
  if (!pending) return { pending: null, command: null };
  if (!sameSessionControlScope(pending.scope, currentScope)) return { pending: null, command: null };
  if (!atSafeBoundary || pending.phase !== "waiting") return { pending, command: null };
  const applying = { ...pending, phase: "applying" as const };
  return { pending: applying, command: applying };
}

/** A model_changed/state reply can settle only the matching session and target. */
export function pendingModelSwitchApplied(
  pending: PendingModelSwitch | null,
  sessionId: string | null,
  model: ScopedModel,
): boolean {
  return pending?.phase === "applying"
    && pending.scope.sessionId === sessionId
    && pending.provider === model?.provider
    && pending.modelId === model?.modelId;
}

export interface FallbackSubagent {
  id: string;
  agent?: string;
}

export interface ModelFallbackJob {
  kind: "main" | "subagent";
  subagentId?: string;
  agent?: string;
  roleLabelKey: string;
}

export interface ModelFallbackAttribution {
  role: string;
  job: ModelFallbackJob;
}

const ROLE_LABEL_KEYS: Record<string, string> = {
  default: "agentSession.job.default",
  task: "agentSession.job.task",
  plan: "agentSession.job.plan",
  slow: "agentSession.job.slow",
  smol: "agentSession.job.smol",
  tiny: "agentSession.job.tiny",
  commit: "agentSession.job.commit",
  advisor: "agentSession.job.advisor",
  vision: "agentSession.job.vision",
};

function normalizedRole(role: unknown): string {
  return typeof role === "string" && role.trim() ? role.trim() : "default";
}

function subagentJob(id: string, subagents: readonly FallbackSubagent[]): ModelFallbackJob {
  return {
    kind: "subagent",
    subagentId: id,
    agent: subagents.find((subagent) => subagent.id === id)?.agent,
    roleLabelKey: "agentSession.job.subagent",
  };
}

/** Attribute a parent fallback frame from its role, including dynamic child roles. */
export function fallbackAttributionForRole(
  role: unknown,
  subagents: readonly FallbackSubagent[],
): ModelFallbackAttribution {
  const normalized = normalizedRole(role);
  const subagentId = normalized.startsWith("subagent:") ? normalized.slice("subagent:".length) : "";
  if (subagentId) return { role: normalized, job: subagentJob(subagentId, subagents) };
  return {
    role: normalized,
    job: {
      kind: "main",
      roleLabelKey: ROLE_LABEL_KEYS[normalized] ?? "agentSession.job.custom",
    },
  };
}

/** Attribute a child's model fallback to that subagent, never the parent session. */
export function fallbackAttributionForSubagent(
  subagentId: string,
  role: unknown,
  subagents: readonly FallbackSubagent[],
): ModelFallbackAttribution {
  return {
    role: normalizedRole(role),
    job: subagentJob(subagentId, subagents),
  };
}

/**
 * Why the engine switched models, derived from the provider error the retry
 * saga remembered (`auto_retry_start.errorMessage`).
 *
 * `retry_fallback_applied` carries only `{from, to, role}`, so every switch
 * used to read as the same generic "hit a usage limit or error" — which
 * conflates two situations a user acts on differently:
 *
 * - `refusal`: the model itself declined on content-policy grounds. Nothing is
 *   exhausted, waiting changes nothing, and omp PINS the session to the
 *   fallback for the rest of the run (a refusal is the model's decision, not a
 *   route failure), so re-picking the original model by hand is the only way
 *   back. Saying "usage limit" here sends the user to look at a quota that is
 *   perfectly healthy.
 * - `usage`: a quota or rate limit. It resolves on its own at the reset.
 *
 * Unrecognized text returns null and the raw provider message is shown, which
 * is strictly better than guessing.
 */
export type FallbackReasonKind = "refusal" | "usage";

// The refusal/usage split itself now lives in lib/error-text.ts, which also
// tells apart auth/credits/overloaded/outdated/transport failures for the
// notice UI — this function keeps its old two-value contract (every existing
// caller and test expects exactly "refusal" | "usage" | null) by collapsing
// error-text's finer kinds down to it.
export function classifyFallbackReason(reason: string | undefined): FallbackReasonKind | null {
  if (!reason) return null;
  const kind = describeEngineError(reason).kind;
  if (kind === "refusal") return "refusal";
  if (kind === "usage") return "usage";
  return null;
}
