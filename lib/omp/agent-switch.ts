/**
 * Moving a running helper to another model, from Cody's helper window.
 *
 * omp has no command that changes the model of a helper that is already
 * running, so "change model" is a restart: stop that helper, tell the main
 * agent to start it again, and make sure the new one lands on the chosen
 * model. Three parts, in this order:
 *  1. The choice. Either it is also saved as the setting for every later
 *     helper of that kind (`task.agentModelOverrides`, which omp reads on every
 *     spawn), or, for this restart only, it is left as a one-shot entry in the
 *     chat's scratch folder that lib/omp/extensions/cody-agent-switch.ts hands
 *     to omp just before the next helper of that kind starts.
 *  2. The helper is stopped with omp's own `cancel_subagent`.
 *  3. The main agent is told, in a steer message (it arrives even mid-turn),
 *     and the chat gets a line saying the person made the switch.
 * A helper that had already finished is left alone: nothing is told or
 * recorded, and a one-shot entry is taken back.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentModelSelector } from "../agent-model-selector";
import { engineCrashSentence, type EngineCrashNotice } from "../engine-crash";
import { isRecord } from "../type-guards";

/** lib/omp/extensions/cody-agent-switch.ts SWITCH_FILE. */
export const SWITCH_FILE = "cody-agent-switch.json";
/** How long a one-shot entry waits for the main agent to start the helper again. */
export const SWITCH_TTL_MS = 30 * 60_000;
const MAX_PENDING = 20;

/** One waiting restart; the same shape cody-agent-switch.ts reads. */
export interface PendingSwitch {
  id: string;
  agent: string;
  helper: string;
  model: string;
  note: string;
  expiresAt: number;
}

function readPending(scratchDir: string, now: number): PendingSwitch[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(scratchDir, SWITCH_FILE), "utf8"));
  } catch {
    return [];
  }
  const list: unknown[] = isRecord(raw) && Array.isArray(raw.switches) ? raw.switches : [];
  return list.flatMap((item): PendingSwitch[] => {
    if (!isRecord(item)) return [];
    const { id, agent, helper, model, note, expiresAt } = item;
    if (typeof id !== "string" || typeof agent !== "string" || typeof helper !== "string") return [];
    if (typeof model !== "string" || typeof note !== "string" || typeof expiresAt !== "number" || expiresAt <= now) return [];
    return [{ id, agent, helper, model, note, expiresAt }];
  });
}

function writePending(scratchDir: string, entries: readonly PendingSwitch[]): void {
  const target = join(scratchDir, SWITCH_FILE);
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, switches: entries }));
  renameSync(temp, target);
}

/** Leave a restart waiting for the extension; the newest few are kept. */
export function addPendingSwitch(scratchDir: string, entry: PendingSwitch, now: number): void {
  writePending(scratchDir, [...readPending(scratchDir, now), entry].slice(-MAX_PENDING));
}

export function removePendingSwitch(scratchDir: string, id: string, now: number): void {
  const entries = readPending(scratchDir, now);
  if (entries.some((entry) => entry.id === id)) writePending(scratchDir, entries.filter((entry) => entry.id !== id));
}

/** The restarts still waiting (expired ones are not shown). */
export function pendingSwitches(scratchDir: string, now: number): PendingSwitch[] {
  return readPending(scratchDir, now);
}

/** A choice in words the main agent and the person both understand: "the slow role (anthropic/claude-opus-5-5)" or the exact model. */
export function describeSwitchTarget(selector: string, roleModel: (role: string) => string | undefined): string {
  const parsed = parseAgentModelSelector(selector);
  if (parsed?.kind === "role") {
    const model = roleModel(parsed.role);
    return model ? `the ${parsed.role} role (${model})` : `the ${parsed.role} role`;
  }
  return selector;
}

export interface SwitchNoteInput {
  helperId: string;
  agent: string;
  target: string;
  /** The choice also became the setting for every later helper of the kind. */
  alsoFuture: boolean;
  transcriptPath?: string;
}

/** The user turn that tells the main agent what happened to its helper and what to do about it. */
export function switchNote(input: SwitchNoteInput): string {
  const { helperId, agent, target, alsoFuture, transcriptPath } = input;
  return [
    "This is an automatic message from Cody, not from the user.",
    `The user moved your helper \`${helperId}\` (agent \`${agent}\`) to ${target}, so Cody stopped it on its old model.`,
    `Start that job again now with agent \`${agent}\`: it will start on ${target}${alsoFuture ? ", and so will every later helper of that kind" : " (this once)"}.`,
    "Do not ask for another model and do not move it back.",
    transcriptPath
      ? `Its transcript so far is at ${transcriptPath}: tell the new helper to read it and continue from there instead of starting over.`
      : "Tell the new helper what is already done so it continues instead of starting over.",
  ].join(" ");
}

export interface SwitchRequest {
  /** The helper being moved (its id as the helper window shows it). */
  subagentId: string;
  /** Its kind: `deep-task`. */
  agent: string;
  /** A role alias or one `provider/model`. */
  selector: string;
  /** Also keep the choice as the setting for every later helper of the kind. */
  alsoFuture: boolean;
  transcriptPath?: string;
}

/** What the helper's chat offers; the engine session (`EngineSession`) satisfies it. */
export interface SwitchSession {
  sessionId: string;
  scratchDir?: string | null;
  send(command: Record<string, unknown>): Promise<unknown>;
  announce?(event: Record<string, unknown>): void;
}

export interface SwitchDeps {
  now(): number;
  zoneFor(sessionId: string): string;
  /** The model a role is set to, or undefined while the engine's own choice applies. */
  roleModel(role: string): string | undefined;
  /** Save the choice as the setting for the helper's kind. */
  setOverride(agent: string, selector: string): void;
  /** File the line that stays in the chat. */
  record(sessionId: string, notice: EngineCrashNotice, now: number): void;
  /** How long to wait for the engine to answer one command. */
  sendBoundMs: number;
  /** This omp tells extensions before a helper starts, so a restart can use another model without a setting. */
  canSwitchOnce: boolean;
}

export type SwitchOutcome =
  | {
      ok: true;
      /** `setting`: saved for every later helper of the kind. `once`: only the next one. */
      how: "setting" | "once";
      /** The main agent was told. False means the helper is stopped but the message did not go through. */
      told: boolean;
    }
  | {
      ok: false;
      /** `already_finished`: nothing to stop. `needs_setting`: this omp cannot do a one-time switch. `no_scratch`: the chat has nowhere to keep the one-time choice. */
      code: "already_finished" | "needs_setting" | "no_scratch";
      /** The choice was saved as the setting before the helper turned out to be gone. */
      settingSaved: boolean;
    };

/** `work`, but no longer than `ms`: an engine that does not answer must not hold the request for ever. */
function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  const { promise: timedOut, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`timed out ${what}`)), ms);
  return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
}

export async function switchHelper(session: SwitchSession, request: SwitchRequest, deps: SwitchDeps): Promise<SwitchOutcome> {
  const { alsoFuture } = request;
  const scratchDir = session.scratchDir ?? null;
  if (!alsoFuture && !deps.canSwitchOnce) return { ok: false, code: "needs_setting", settingSaved: false };
  if (!alsoFuture && !scratchDir) return { ok: false, code: "no_scratch", settingSaved: false };
  const started = deps.now();
  const target = describeSwitchTarget(request.selector, deps.roleModel);

  // 1. The choice, before the helper stops: the main agent can start it again the moment it is gone.
  const waiting: PendingSwitch | null = alsoFuture
    ? null
    : { id: `${request.subagentId}-${started}`, agent: request.agent, helper: request.subagentId, model: request.selector, note: `Moved by you to ${target}`, expiresAt: started + SWITCH_TTL_MS };
  if (alsoFuture) deps.setOverride(request.agent, request.selector);
  else if (waiting && scratchDir) addPendingSwitch(scratchDir, waiting, started);
  const takeBack = (): void => {
    if (waiting && scratchDir) removePendingSwitch(scratchDir, waiting.id, deps.now());
  };

  // 2. Stop the helper. A helper that is already gone changes nothing.
  let cancelled: boolean;
  try {
    const reply = await bounded(session.send({ type: "cancel_subagent", subagentId: request.subagentId }), deps.sendBoundMs, "stopping the helper");
    cancelled = isRecord(reply) && reply.cancelled === true;
  } catch (error) {
    takeBack();
    throw error;
  }
  if (!cancelled) {
    takeBack();
    return { ok: false, code: "already_finished", settingSaved: alsoFuture };
  }

  // 3. Tell the main agent, then leave the line in the chat. Each stands alone: the helper is already stopped.
  const now = deps.now();
  let told = true;
  try {
    await bounded(
      session.send({
        type: "prompt",
        message: switchNote({ helperId: request.subagentId, agent: request.agent, target, alsoFuture, transcriptPath: request.transcriptPath }),
        streamingBehavior: "steer",
        clientMessageId: `agentswitch-${session.sessionId}-${now}`,
        timeZone: deps.zoneFor(session.sessionId),
      }),
      deps.sendBoundMs,
      "telling the agent",
    );
  } catch (error) {
    told = false;
    console.warn(`[agent-switch] could not tell the agent of chat ${session.sessionId}:`, error instanceof Error ? error.message : error);
  }
  const notice: EngineCrashNotice = { reason: "helper_switched", detail: `${request.subagentId} → ${target}`, disk: null, quota: false, code: null, signal: null, recovery: "automatic", at: now };
  try {
    deps.record(session.sessionId, notice, now);
    session.announce?.({ type: "notice", level: "info", reason: "helper_switched", message: engineCrashSentence(notice), crash: notice });
  } catch (error) {
    console.warn(`[agent-switch] could not put the line in chat ${session.sessionId}:`, error instanceof Error ? error.message : error);
  }
  return { ok: true, how: alsoFuture ? "setting" : "once", told };
}
