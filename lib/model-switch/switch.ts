/**
 * Moving one chat onto another model (and reasoning level) — or the default
 * every NEW chat starts on — from the server, for an agent that was asked to.
 *
 * `switchChatModel` is the one entry point for "put this chat on that model".
 * The `switch_model` tool calls it, and so can anything else that runs on the
 * server (a scheduled message that carries a model). It is deliberately free of
 * `@/` imports: lib/scheduled is loaded by the custom server, which cannot
 * resolve that alias. It imports ../rpc-manager, which imports tool.ts for its
 * tool list — so tool.ts loads this module lazily, inside its handler (the way
 * lib/chat-messages/tools.ts loads its delivery); every other caller imports
 * it normally.
 *
 * WHEN a switch may happen is the part that matters:
 *  - Reasoning alone is applied at once, in any state — it only changes what
 *    the NEXT request carries.
 *  - A model change is applied at once when the chat is idle, and when the
 *    caller is the chat's own agent inside a tool call on the rpc dialect: no
 *    provider stream is open then (the tool call starts after the assistant
 *    message finished), so the very next request of this turn uses the new
 *    model. Switching under an open stream is the one thing that is NOT safe
 *    (it aborts the Codex websocket mid-response).
 *  - Any other running chat waits for the next step boundary, the same frames
 *    the composer's own live picker waits for (assistant `message_end`,
 *    `tool_execution_start`, `turn_end`, `agent_end`). An ACP engine only has
 *    turn boundaries — its `message_end` is a streamed chunk, not a finished
 *    message — so it waits for the turn to end.
 *
 * Switching the DEFAULT writes only `modelRoles.default` in omp's config.yml,
 * through the same helpers the Settings panel uses, and hands back what it
 * replaced so the change can be reverted.
 */

import { getHarness } from "../harness";
import type { EngineEvent, EngineSession } from "../harness/types";
import { invalidateModelsCache } from "../models-cache";
import { readModelRoles, writeModelRoles } from "../omp/model-roles";
import { getRpcSession, restartIdleRpcSessions } from "../rpc-manager";
import { acquireSession, isSessionUnavailableError } from "../session-acquire";
import { toolTimeZone } from "../tool-time";
import { isRecord } from "../type-guards";
import { modelKey, resolveThinkingLevel, type CatalogModel } from "./resolve";

export interface ModelSwitchTarget {
  provider: string;
  modelId: string;
  /**
   * One of the levels this model offers (`modelThinkingLevels`), or a spelling
   * `resolveThinkingLevel` understands. Omitted: the engine's own choice — the
   * model's default level after a model change, the current level otherwise.
   */
  thinkingLevel?: string;
}

/** A model and level as the engine reports them. */
export interface ChatModelState {
  provider: string;
  modelId: string;
  name?: string;
  thinkingLevel?: string;
}

/** What one chat's engine says it can run, and what it is running now. */
export interface ChatModelCatalog {
  /** Every model this chat may switch to. Empty when the engine offers none. */
  models: CatalogModel[];
  current: ChatModelState | null;
  /** The catalog entry for the current model (or the engine's own account of it when the catalog misses it). */
  currentModel: CatalogModel | null;
  /** ACP: the models belong to this session alone, and reasoning cannot be set. */
  sessionScoped: boolean;
  /** False when the engine published no model selector for this chat. */
  selectable: boolean;
}

export interface OpenedChat {
  session: EngineSession;
  catalog: ChatModelCatalog;
}

export interface OpenChatOptions {
  /** The caller already holds the live session: use it as is. */
  session?: EngineSession;
  /** IANA zone to start a chat's engine in when it has none yet. */
  timeZone?: string;
}

export interface SwitchOptions extends OpenChatOptions {
  /** The catalog `openChat` returned for this session, to save a second read. */
  catalog?: ChatModelCatalog;
  /**
   * The caller is the chat's OWN agent, inside a tool call. No provider stream
   * is open at that moment, so a model change is safe now even though the chat
   * is running. Honoured on the rpc dialect only.
   */
  atStepBoundary?: boolean;
}

export type SwitchStatus = "applied" | "deferred" | "unchanged" | "refused";
export type SwitchApplies = "next-step" | "next-turn";

export interface SwitchResult {
  status: SwitchStatus;
  /**
   * Why it was refused, or what partly failed. Stable and snake_case:
   * `unsupported`, `unknown_model`, `invalid_level`, `busy`, `not_applied`,
   * `reasoning_failed`, `session_unavailable`, or the engine's own code
   * (`local_routing_forbidden`, `session_busy`, `invalid_model`, `session_dead`).
   */
  code?: string;
  /** One plain sentence, written for the person who asked. */
  message: string;
  /** What the chat was on before the call. */
  previous: ChatModelState | null;
  /** What the engine reports now (deferred: still the previous one). */
  current: ChatModelState | null;
  /** What was asked for. */
  requested: ChatModelState | null;
  /** `applied` / `deferred`: from which request on the new setting is used. */
  applies?: SwitchApplies;
}

export type OpenChatResult = { ok: true; chat: OpenedChat } | { ok: false; result: SwitchResult };

export interface EverywhereResult {
  /** The role string that held before, e.g. `anthropic/claude-opus-4-8:high`; null when unset. */
  previousDefault: string | null;
  /** The role string written now. */
  newDefault: string;
  /** Idle engines restarted so they pick the new default up. */
  restarted: number;
  /** Running engines left alone until they next restart. */
  active: number;
}

/** pi's catalog carries only a `reasoning` flag; its `set_thinking_level` takes the dialect's global ladder. */
const RPC_DIALECT_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** One engine model entry as a catalog model, or null when it names no provider/id. */
function toCatalogModel(raw: unknown, fallbackEfforts?: readonly string[]): CatalogModel | null {
  if (!isRecord(raw)) return null;
  const provider = text(raw.provider);
  const id = text(raw.id);
  if (!provider || !id) return null;
  const thinking = isRecord(raw.thinking) ? raw.thinking : {};
  const listed = Array.isArray(thinking.efforts)
    ? thinking.efforts.filter((effort): effort is string => typeof effort === "string")
    : undefined;
  const efforts = listed ?? (raw.reasoning === true && fallbackEfforts ? [...fallbackEfforts] : undefined);
  const defaultLevel = text(thinking.defaultLevel);
  const name = text(raw.name);
  return {
    provider,
    id,
    ...(name ? { name } : {}),
    ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
    ...(efforts || defaultLevel ? { thinking: { ...(efforts ? { efforts } : {}), ...(defaultLevel ? { defaultLevel } : {}) } } : {}),
  };
}

function currentFrom(state: Record<string, unknown>): ChatModelState | null {
  const model = toCatalogModel(state.model);
  if (!model) return null;
  const level = text(state.thinkingLevel);
  return {
    provider: model.provider,
    modelId: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(level ? { thinkingLevel: level } : {}),
  };
}

function stateOf(model: CatalogModel, thinkingLevel: string | undefined): ChatModelState {
  return {
    provider: model.provider,
    modelId: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
}

async function readState(session: EngineSession): Promise<Record<string, unknown>> {
  const state = await session.send({ type: "get_state" });
  return isRecord(state) ? state : {};
}

/** Machine code and plain message for whatever an engine command or a spawn threw. */
function failure(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = isRecord(error) && typeof error.code === "string" && error.code !== "" ? error.code : "engine_error";
  return { code, message };
}

function refused(
  code: string,
  message: string,
  previous: ChatModelState | null,
  requested: ChatModelState | null,
): SwitchResult {
  return { status: "refused", code, message, previous, current: previous, requested };
}

/**
 * What the chat's own engine says it can run, and is running. The rpc dialect
 * answers `get_available_models` (omp applies `enabledModels` itself, so this
 * is the effective set, the same one `/api/models` serves); an ACP engine lists
 * its models inside `get_state` and says whether they can be switched at all.
 */
export async function readChatCatalog(session: EngineSession, fallbackEfforts?: readonly string[]): Promise<ChatModelCatalog> {
  const state = await readState(session);
  const sessionScoped = state.modelSelectable !== undefined;
  let raw: unknown;
  if (sessionScoped) {
    raw = state.availableModels;
  } else {
    const reply = await session.send({ type: "get_available_models" });
    raw = isRecord(reply) ? reply.models : [];
  }
  const models = (Array.isArray(raw) ? raw : [])
    .map((entry) => toCatalogModel(entry, sessionScoped ? undefined : fallbackEfforts))
    .filter((model): model is CatalogModel => model !== null);
  const current = currentFrom(state);
  const currentModel = current
    ? models.find((model) => model.provider === current.provider && model.id === current.modelId)
      ?? toCatalogModel(state.model, sessionScoped ? undefined : fallbackEfforts)
    : null;
  return {
    models,
    current,
    currentModel,
    sessionScoped,
    selectable: sessionScoped ? state.modelSelectable === true : true,
  };
}

/** The chat's live session — never one that must be realigned to another time zone first (that may restart an idle child) — or a freshly started one. */
async function liveOrAcquire(sessionId: string, timeZone: string | undefined): Promise<EngineSession> {
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) return live;
  return acquireSession(sessionId, toolTimeZone(timeZone));
}

/** Open a chat's engine and read what it can run. A failure answers as a refusal, never a throw. */
export async function openChat(sessionId: string, opts: OpenChatOptions = {}): Promise<OpenChatResult> {
  try {
    const session = opts.session ?? await liveOrAcquire(sessionId, opts.timeZone);
    await session.waitUntilReady();
    const fallbackEfforts = getHarness().id === "omp" ? undefined : RPC_DIALECT_EFFORTS;
    return { ok: true, chat: { session, catalog: await readChatCatalog(session, fallbackEfforts) } };
  } catch (error) {
    if (isSessionUnavailableError(error)) {
      return { ok: false, result: refused("session_unavailable", error.message, null, null) };
    }
    const { code, message } = failure(error);
    return { ok: false, result: refused(code, `That chat's engine could not be reached: ${message}`, null, null) };
  }
}

interface Plan {
  sessionId: string;
  session: EngineSession;
  model: CatalogModel;
  /** The level to set after the model, already validated; undefined leaves it to the engine. */
  level: string | undefined;
  modelChanges: boolean;
  previous: ChatModelState | null;
  sessionScoped: boolean;
}

/** Tell the page BEFORE the engine switches: its `model_changed` handler reads the marker to call the change what it is. */
function announceSwitch(plan: Plan): void {
  const { session, model, level, modelChanges } = plan;
  session.announce?.({
    type: "cody_agent_model_switch",
    provider: model.provider,
    modelId: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(level !== undefined ? { thinkingLevel: level } : {}),
    modelChanges,
  });
}

/**
 * Send the commands, in the order omp needs them: the model first, then the
 * level — omp re-applies the new model's default level after `set_model`, so a
 * level sent before it would be silently overwritten.
 */
async function applyNow(plan: Plan, applies: SwitchApplies): Promise<SwitchResult> {
  const { session, model, level, modelChanges, previous } = plan;
  const requested = stateOf(model, level);
  announceSwitch(plan);

  if (modelChanges) {
    try {
      await session.send({ type: "set_model", provider: model.provider, modelId: model.id });
    } catch (error) {
      const { code, message } = failure(error);
      return refused(code, message, previous, requested);
    }
  }

  let levelProblem: string | undefined;
  if (level !== undefined) {
    try {
      await session.send({ type: "set_thinking_level", level });
    } catch (error) {
      levelProblem = failure(error).message;
    }
  }

  // The engine's own account, not the one this code expects: it is what the
  // next request will actually carry.
  let current: ChatModelState | null = null;
  try {
    current = currentFrom(await readState(session));
  } catch {
    // The commands were accepted; report what was asked for.
  }
  if (modelChanges && current && (current.provider !== model.provider || current.modelId !== model.id)) {
    return refused(
      "not_applied",
      `The engine accepted the switch but reports it is still on ${modelKey({ provider: current.provider, id: current.modelId })}.`,
      previous,
      requested,
    );
  }

  const now = current ?? requested;
  if (levelProblem !== undefined) {
    return {
      status: "applied",
      code: "reasoning_failed",
      message: `The model was switched, but its reasoning level could not be set: ${levelProblem}`,
      previous,
      current: now,
      requested,
      applies,
    };
  }
  return { status: "applied", message: `Switched to ${modelKey(model)}.`, previous, current: now, requested, applies };
}

/** The frames after which a model change cannot cut a provider stream short. */
function isBoundary(event: EngineEvent, sessionScoped: boolean): boolean {
  if (event.type === "turn_end" || event.type === "agent_end") return true;
  if (sessionScoped) return false;
  if (event.type === "tool_execution_start") return true;
  return event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant";
}

interface Waiting {
  cancel(): void;
}

declare global {
  var __codyModelSwitchWaiting: Map<string, Waiting> | undefined;
}

/** Switches waiting for a boundary, by chat. Kept on globalThis: the server may load this module twice (Next's bundle and the custom server). */
function waitingSwitches(): Map<string, Waiting> {
  globalThis.__codyModelSwitchWaiting ??= new Map();
  return globalThis.__codyModelSwitchWaiting;
}

/** What a deferred switch tells the person watching when it did not go through. */
function deferredNotice(plan: Plan, outcome: SwitchResult): string | null {
  const key = modelKey(plan.model);
  if (outcome.status === "refused") return `The switch to ${key} that was waiting for this chat's next step could not be applied: ${outcome.message}`;
  if (outcome.code === "reasoning_failed") return `This chat is now on ${key}, but its reasoning level could not be set: ${outcome.message}`;
  return null;
}

/**
 * Hold a model change until the chat reaches a boundary, then apply it. The
 * caller gets its answer at once ("deferred"); a failure later cannot reach it,
 * so it is announced on the chat's own stream instead. A newer request for the
 * same chat replaces one still waiting, and a chat that closes drops it.
 */
function defer(plan: Plan, applies: SwitchApplies): SwitchResult {
  const { session, sessionId, previous, model, level } = plan;
  const requested = stateOf(model, level);
  if (typeof session.observeEvents !== "function") {
    return refused("busy", "That chat is mid-turn and cannot be told to switch at a safe moment; try again when it has finished.", previous, requested);
  }

  const waiting = waitingSwitches();
  waiting.get(sessionId)?.cancel();

  let settled = false;
  let stopObserving = () => {};
  let stopListening = () => {};
  const entry: Waiting = { cancel: () => settle() };
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    stopObserving();
    stopListening();
    if (waiting.get(sessionId) === entry) waiting.delete(sessionId);
    return true;
  };

  stopObserving = session.observeEvents((event) => {
    if (!isBoundary(event, plan.sessionScoped) || !settle()) return;
    // Not inside the emit that delivered this frame: the apply announces and
    // sends, and must not re-enter the stream it is being called from.
    queueMicrotask(() => {
      void applyNow(plan, applies).then((outcome) => {
        const notice = deferredNotice(plan, outcome);
        if (notice) session.announce?.({ type: "notice", level: "info", message: notice });
      });
    });
  });
  stopListening = session.onClose(() => { settle(); });
  waiting.set(sessionId, entry);

  return {
    status: "deferred",
    message: plan.sessionScoped
      ? "That chat is mid-turn; the switch is applied when the turn ends."
      : "That chat is mid-turn; the switch is applied at its next step boundary.",
    previous,
    current: previous,
    requested,
    applies,
  };
}

/**
 * Put one chat on `target`. Validates against the chat's own live catalog (an
 * unknown model or a level the model lacks is refused, never approximated),
 * then applies or defers as described at the top of this file. Never throws.
 */
export async function switchChatModel(
  sessionId: string,
  target: ModelSwitchTarget,
  opts: SwitchOptions = {},
): Promise<SwitchResult> {
  let chat: OpenedChat;
  if (opts.session && opts.catalog) {
    chat = { session: opts.session, catalog: opts.catalog };
  } else {
    const opened = await openChat(sessionId, opts);
    if (!opened.ok) return opened.result;
    chat = opened.chat;
  }
  const { session, catalog } = chat;
  const { current: previous } = catalog;

  if (!catalog.selectable) {
    return refused("unsupported", "This engine did not offer a model selection for this chat.", previous, null);
  }
  const model = catalog.models.find((entry) => entry.provider === target.provider && entry.id === target.modelId);
  if (!model) {
    return refused("unknown_model", `${target.provider}/${target.modelId} is not among the models this chat can use.`, previous, null);
  }

  let level: string | undefined;
  if (target.thinkingLevel !== undefined) {
    if (catalog.sessionScoped) {
      return refused("unsupported", "This engine has no reasoning levels to set; ask for the model alone.", previous, stateOf(model, undefined));
    }
    const resolved = resolveThinkingLevel(target.thinkingLevel, model);
    if (!resolved.ok) {
      return refused("invalid_level", `${modelKey(model)} offers these reasoning levels: ${resolved.valid.join(", ")}.`, previous, stateOf(model, undefined));
    }
    level = resolved.level;
  }

  const modelChanges = !previous || previous.provider !== model.provider || previous.modelId !== model.id;
  // A new model resets the level to its own default, so a requested level is
  // always sent after one; on the same model only a real change is.
  const levelChanges = level !== undefined && (modelChanges || level !== previous?.thinkingLevel);
  const requested = stateOf(model, level);
  if (!modelChanges && !levelChanges) {
    return {
      status: "unchanged",
      message: `This chat is already on ${modelKey(model)}${previous?.thinkingLevel ? ` with reasoning ${previous.thinkingLevel}` : ""}.`,
      previous,
      current: previous,
      requested,
    };
  }

  const plan: Plan = {
    sessionId,
    session,
    model,
    level,
    modelChanges,
    previous,
    sessionScoped: catalog.sessionScoped,
  };
  const running = session.isRunning();
  if (!running) return applyNow(plan, "next-turn");
  if (!modelChanges) return applyNow(plan, "next-step");
  if (opts.atStepBoundary === true && !catalog.sessionScoped) return applyNow(plan, "next-step");
  return defer(plan, catalog.sessionScoped ? "next-turn" : "next-step");
}

/**
 * Make `target` the model new chats and helper agents start on. Writes ONLY
 * `modelRoles.default` (`provider/id`, plus `:level` when a level was given),
 * leaving every other role and setting as it was, then restarts the idle
 * engines so they read it. A chat that is running — including the one the
 * caller is in — keeps its engine until it next restarts. The returned
 * `previousDefault` is exactly what to write back to undo this.
 */
export async function setEverywhereDefault(target: ModelSwitchTarget): Promise<EverywhereResult> {
  const { roles } = readModelRoles();
  const previousDefault = roles.default ?? null;
  const newDefault = `${target.provider}/${target.modelId}${target.thinkingLevel ? `:${target.thinkingLevel}` : ""}`;
  writeModelRoles({ ...roles, default: newDefault });
  invalidateModelsCache();
  const { restarted, active } = await restartIdleRpcSessions().catch(() => ({ restarted: 0, active: 0 }));
  return { previousDefault, newDefault, restarted, active };
}
