import type { ResolvedModel } from "./session-model-provenance";

/**
 * The page's side of an agent-requested model switch (the `switch_model` tool,
 * lib/model-switch).
 *
 * The server announces the switch on the chat's own stream with
 * `cody_agent_model_switch` just BEFORE it tells the engine. Without that
 * frame the `model_changed` that follows looks like the engine acting on its
 * own, and the composer would raise its fallback marker; with it the page can
 * say "switched by the agent, at your request" and leave Smart exactly as a
 * manual pick does. Pure decisions only — useAgentSession holds the state and
 * does the wiring.
 */

/** How long an announced switch may wait for the engine's own report of it. */
export const AGENT_SWITCH_WINDOW_MS = 15_000;

export interface AgentModelSwitch {
  sessionId: string;
  provider: string;
  modelId: string;
  /** What the notice calls the model: its display name, else provider/id. */
  name: string;
  /** The reasoning level the agent asked for, when it asked for one. */
  thinkingLevel?: string;
  /** False: the model stays and only its reasoning level changes. */
  modelChanges: boolean;
  /** When the page saw the announcement. */
  at: number;
}

/** The announcement frame as an AgentModelSwitch, or null when it names no model or this page has no chat open. */
export function readAgentModelSwitch(
  event: { [key: string]: unknown },
  sessionId: string | null,
  now: number,
): AgentModelSwitch | null {
  if (!sessionId) return null;
  const provider = typeof event.provider === "string" ? event.provider : "";
  const modelId = typeof event.modelId === "string" ? event.modelId : "";
  if (!provider || !modelId) return null;
  const name = typeof event.name === "string" && event.name.trim() !== "" ? event.name.trim() : `${provider}/${modelId}`;
  const thinkingLevel = typeof event.thinkingLevel === "string" && event.thinkingLevel !== "" ? event.thinkingLevel : undefined;
  return {
    sessionId,
    provider,
    modelId,
    name,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    modelChanges: event.modelChanges !== false,
    at: now,
  };
}

function isFresh(pending: AgentModelSwitch | null, sessionId: string | null, now: number): pending is AgentModelSwitch {
  return pending !== null && pending.sessionId === sessionId && now - pending.at < AGENT_SWITCH_WINDOW_MS;
}

/**
 * The waiting switch, when the engine now reports the model it asked for: the
 * switch has landed, and this report is not a fallback. Null otherwise — no
 * switch waiting, another chat's, an expired one, a reasoning-only one (that
 * lands as a level), or the engine moved to some other model.
 */
export function agentSwitchSettledByModel(
  pending: AgentModelSwitch | null,
  sessionId: string | null,
  model: ResolvedModel | null,
  now: number,
): AgentModelSwitch | null {
  if (!isFresh(pending, sessionId, now) || !pending.modelChanges || model === null) return null;
  return model.provider === pending.provider && model.modelId === pending.modelId ? pending : null;
}

/** The waiting switch, when the engine reports a reasoning level while a reasoning-only switch of this chat is waiting for it. */
export function agentSwitchSettledByLevel(
  pending: AgentModelSwitch | null,
  sessionId: string | null,
  now: number,
): AgentModelSwitch | null {
  return isFresh(pending, sessionId, now) && !pending.modelChanges ? pending : null;
}

export interface AgentSwitchNotice {
  key: "agentSession.modelSwitchedByAgent" | "agentSession.modelSwitchedByAgentWithLevel" | "agentSession.thinkingLevelSetByAgent";
  values: { name: string; level: string };
}

/** The notice for a switch that landed. `levelLabel` is the display label of its level (empty when it asked for none). */
export function agentSwitchNotice(pending: AgentModelSwitch, levelLabel: string): AgentSwitchNotice {
  const values = { name: pending.name, level: levelLabel };
  if (!pending.modelChanges) return { key: "agentSession.thinkingLevelSetByAgent", values };
  if (pending.thinkingLevel) return { key: "agentSession.modelSwitchedByAgentWithLevel", values };
  return { key: "agentSession.modelSwitchedByAgent", values };
}
