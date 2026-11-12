import {
  mayRead,
  resolveSessionArgument,
  stringArg,
  type SessionToolArgs,
  type SessionToolContext,
  type SessionToolDefinition,
} from "../session-tools";
import { clipChars, singleLine } from "../notifications/compose";
import { looksLikeLevel, modelKey, resolveModel, resolveThinkingLevel, type CatalogModel } from "../model-switch/resolve";
import type { ChatModelCatalog } from "../model-switch/switch";
import { formatToolTime, toolTimeZone } from "../tool-time";
import { ScheduledError } from "./errors";
import { cancelScheduled, createScheduled, listScheduled } from "./service";
import { findItem } from "./store";
import { describeDelay } from "./time";
import { SCHEDULED_LIMITS, type ScheduledItemView, type ScheduledModelChoice } from "./types";

/**
 * Scheduling, as tools any chat's agent can call.
 *
 * Three of them — `schedule_message`, `list_scheduled`, `cancel_scheduled` —
 * over the same store, timer and composer rows as a message scheduled by hand.
 * They follow the session tools' contract (lib/session-tools.ts): every handler
 * answers plain text, success or a short refusal, and never throws, so a
 * caller's dispatch needs no try/catch.
 *
 * The agent acts for the chat's OWNER. A chat it cannot see — another
 * account's, or any owned chat when the caller is unowned — is refused with the
 * same words as a chat that does not exist, and a cancel by id is refused the
 * same way for a message in such a chat.
 *
 * Not offered to the sidebar chat: its schema budget assumes the smallest local
 * model (lib/sidebar-context-budget.ts), and these descriptions are written to
 * teach, which costs tokens it cannot spare.
 *
 * `schedule_message` may name the model (and reasoning level) the message is
 * sent on. The name is resolved here, against the models the engine reports
 * (lib/model-switch/resolve.ts: never a guess — several matches schedule
 * nothing and list the candidates), so what is stored is an exact provider/id
 * that the delivery switches the chat to (lib/scheduled/delivery.ts) and a
 * quota wait follows. The models are read from an engine that is already
 * running; scheduling never starts one, because it must work for a chat that
 * is idle and for a person whose every quota is spent.
 */

const NOT_FOUND = "No scheduled message with that id.";
const PREVIEW_CHARS = 100;

function preview(message: string): string {
  return `"${clipChars(singleLine(message), PREVIEW_CHARS)}"`;
}

/** "2026-10-06 09:00 EDT (in 3 h 12 min)". */
function when(item: ScheduledItemView, zone: string, now: number): string {
  return `${formatToolTime(item.at, zone)} (${describeDelay(Date.parse(item.at), now)})`;
}

function refusal(error: unknown): string {
  if (error instanceof ScheduledError) return error.message;
  return `Could not complete that: ${error instanceof Error ? error.message : String(error)}`;
}

function target(item: ScheduledItemView, ctx: SessionToolContext): string {
  return item.sessionId === ctx.defaultSessionId ? "this chat" : `chat ${item.sessionId}`;
}

/** Models shown when a name fits several. */
const MAX_CANDIDATES = 12;

function modelLabel(model: Pick<CatalogModel, "provider" | "id" | "name">): string {
  const key = modelKey(model);
  return model.name && model.name !== model.id ? `${key} (${model.name})` : key;
}

function modelLines(models: readonly CatalogModel[], limit: number): string {
  const lines = models.slice(0, limit).map(modelLabel);
  if (models.length > limit) lines.push(`… ${models.length - limit} more`);
  return lines.join("\n");
}

/** "anthropic/claude-opus-4-8, reasoning high". */
function describeChoice(choice: ScheduledModelChoice): string {
  return `${choice.provider}/${choice.modelId}${choice.thinkingLevel ? `, reasoning ${choice.thinkingLevel}` : ""}`;
}

function ambiguousText(query: string, candidates: readonly CatalogModel[]): string {
  return [
    `"${query}" fits ${candidates.length} models, so nothing was scheduled. Ask the user which one they mean, then call again with its exact provider/id:`,
    modelLines(candidates, MAX_CANDIDATES),
  ].join("\n");
}

function unknownText(query: string, suggestions: readonly CatalogModel[], total: number): string {
  const words = query.split(/\s+/);
  const lastWord = words[words.length - 1] ?? "";
  const levelHint = words.length > 1 && looksLikeLevel(lastWord)
    ? ` If "${lastWord}" was meant as the reasoning level, pass it as \`reasoning\` and leave it out of \`model\`.`
    : "";
  const closest = suggestions.length > 0
    ? ` The closest are:\n${modelLines(suggestions, suggestions.length)}`
    : ` ${total} models are available; switch_model with no arguments lists them.`;
  return `No model matches "${query}", so nothing was scheduled.${levelHint}${closest}`;
}

/**
 * The models the chat's engine offers, read from an engine that is already
 * running: the chat's own, else the caller's (this tool is running inside it).
 * Never starts one.
 */
async function readCatalog(chatId: string, ctx: SessionToolContext): Promise<ChatModelCatalog | string> {
  // Loaded here, not at the top: switch.ts imports ../rpc-manager, which imports this module for its tool list (lib/model-switch/tool.ts loads it the same way).
  const [{ openChat }, { getRpcSession }] = await Promise.all([import("../model-switch/switch"), import("../rpc-manager")]);
  const live = [chatId, ctx.defaultSessionId].flatMap((id) => {
    const session = id ? getRpcSession(id) : undefined;
    return session?.isAlive() ? [session] : [];
  })[0];
  if (!live) return "No engine is running to read the available models from, so nothing was scheduled. Schedule without `model`, or try again from a chat that is running.";
  const opened = await openChat(chatId, { session: live, timeZone: ctx.timeZone });
  return opened.ok ? opened.chat.catalog : `Could not read the models this chat can use (${opened.result.message}), so nothing was scheduled.`;
}

/**
 * `model` and `reasoning` as the one model (and level) the message is sent on:
 * null when the call names none; text — saying nothing was scheduled — when
 * what it names cannot be told apart, is not there, or is not a level of it.
 */
async function chosenModel(chatId: string, args: SessionToolArgs, ctx: SessionToolContext): Promise<ScheduledModelChoice | string | null> {
  for (const key of ["model", "reasoning"]) {
    if (args[key] !== undefined && args[key] !== null && typeof args[key] !== "string") return `\`${key}\` must be text, so nothing was scheduled.`;
  }
  const query = stringArg(args, "model")?.trim();
  const levelQuery = stringArg(args, "reasoning")?.trim();
  if (!query && !levelQuery) return null;
  if (!query) return "A reasoning level belongs to one model: pass `model` as well (the message is sent on that model at that level), so nothing was scheduled.";
  const catalog = await readCatalog(chatId, ctx);
  if (typeof catalog === "string") return catalog;
  if (!catalog.selectable) return "This engine offers no model selection for this chat, so a message cannot be sent on a model of its own. Nothing was scheduled.";
  const resolution = resolveModel(query, catalog.models);
  if (resolution.kind === "ambiguous") return ambiguousText(query, resolution.candidates);
  if (resolution.kind === "unknown") return unknownText(query, resolution.suggestions, catalog.models.length);
  const { model } = resolution;
  const choice: ScheduledModelChoice = { provider: model.provider, modelId: model.id };
  if (!levelQuery) return choice;
  if (catalog.sessionScoped) return "This engine has no reasoning levels to set; schedule with the model alone. Nothing was scheduled.";
  const level = resolveThinkingLevel(levelQuery, model);
  if (!level.ok) return `"${levelQuery}" is not a reasoning level of ${modelKey(model)}, so nothing was scheduled. It offers: ${level.valid.join(", ")}.`;
  return { ...choice, thinkingLevel: level.level };
}

/** What a quota-mode message waits for, in words: a reset time, or — when its provider names none — the re-checking that stands in for one. */
function quotaWhen(item: ScheduledItemView, zone: string, now: number): string {
  const label = item.quota?.label ?? "the model";
  if (!item.quota?.unknownReset) return `when ${label}'s quota resets, ${when(item, zone, now)}`;
  return `when ${label}'s quota can be used again (no reset time is known: re-checked every few minutes, given up on ${formatToolTime(item.quota.giveUpAt, zone)})`;
}

async function scheduleMessage(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const chat = await resolveSessionArgument(stringArg(args, "session"), ctx);
  if ("text" in chat) return chat.text;
  const zone = toolTimeZone(ctx.timeZone);
  try {
    const model = await chosenModel(chat.id, args, ctx);
    if (typeof model === "string") return model;
    const item = await createScheduled(
      chat.id,
      { message: args.message, at: args.at, whenQuotaResets: args.whenQuotaResets, ...(model ? { model } : {}) },
      { zone },
      { source: "agent", user: ctx.user },
    );
    const now = Date.now();
    const lead = item.mode === "quota"
      ? item.quota?.unknownReset
        ? `Scheduled ${item.id} for ${quotaWhen(item, zone, now)}. It is sent once a fresh usage read shows the model usable (the first check is immediate), so a quota that is usable already sends it at once.`
        : `Scheduled ${item.id} for when ${item.quota?.label ?? "the model"}'s quota resets, ${when(item, zone, now)}. It is sent once a fresh usage read shows the model usable (re-checked every few minutes) and is given up on 24 hours after the reset.`
      : `Scheduled ${item.id} for ${when(item, zone, now)}.`;
    const onModel = item.model ? ` The chat is switched to ${describeChoice(item.model)} just before it is sent; if that cannot be done the message fails and says why — it never goes out on another model.` : "";
    return `${lead}${onModel} It goes to ${target(item, ctx)} as an ordinary message from the user: ${preview(item.message)}. Withdraw it with cancel_scheduled id ${item.id}.`;
  } catch (error) {
    return refusal(error);
  }
}

async function listScheduledMessages(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const chat = await resolveSessionArgument(stringArg(args, "session"), ctx);
  if ("text" in chat) return chat.text;
  const items = listScheduled(chat.id);
  const owner = chat.id === ctx.defaultSessionId ? "this chat" : `chat ${chat.id}`;
  if (items.length === 0) return `Nothing is scheduled for ${owner}.`;
  const zone = toolTimeZone(ctx.timeZone);
  const now = Date.now();
  const lines = items.map((item) => {
    const what = item.mode === "quota" ? quotaWhen(item, zone, now) : when(item, zone, now);
    const state = item.status === "failed" ? `failed: ${item.error ?? "could not be sent"}` : item.handedOver ? "queued in the chat behind the current reply" : item.status;
    const model = item.model ? ` | on ${describeChoice(item.model)}` : "";
    return `${item.id} | ${what}${model} | by ${item.source === "agent" ? "the agent" : "the user"} | ${state} | ${preview(item.message)}`;
  });
  return `${items.length} scheduled for ${owner} (at most ${SCHEDULED_LIMITS.perChat}):\n${lines.join("\n")}`;
}

async function cancelScheduledMessage(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const id = stringArg(args, "id");
  if (!id) return "Pass the id of the scheduled message; list_scheduled shows them.";
  const stored = findItem(id);
  // A message in a chat this caller may not use answers exactly like one that does not exist.
  if (!stored || !mayRead(stored.sessionId, ctx)) return NOT_FOUND;
  try {
    const item = cancelScheduled(stored.sessionId, id);
    return `Cancelled ${id} (${preview(item.message)}), which was due ${formatToolTime(item.at, toolTimeZone(ctx.timeZone))}.`;
  } catch (error) {
    return refusal(error);
  }
}

export const SCHEDULE_TOOLS: SessionToolDefinition[] = [
  {
    name: "schedule_message",
    description:
      "Send a message into a chat LATER — at a time you choose, or when this chat's model quota refills. Use it to carry on unfinished work after a usage limit resets, to run something at a set time (\"at 9 AM run the full suite and report\"), or to check back on CI or a long job instead of waiting or asking the user to return. "
      + "The message arrives as an ordinary user message in that chat (this one unless `session` names another; if that chat is mid-turn it waits as a follow-up behind the turn), so write it as a complete instruction: whoever reads it — possibly you — may remember nothing but the transcript. It is sent once and never repeats. "
      + `A chat holds at most ${SCHEDULED_LIMITS.perChat} pending messages and a time must be within ${SCHEDULED_LIMITS.maxDays} days. Give \`at\` or \`whenQuotaResets\`, not both. `
      + "Pass `model` (and `reasoning`) to send it on a model you choose: the chat is switched to it just before the message goes, and `whenQuotaResets` then waits for THAT model's quota — so work carries on later on another model, even when every quota is spent now. "
      + "Returns an id; cancel_scheduled withdraws it. "
      + "To reach ANOTHER chat's agent right away, even mid-turn, use send_to_chat: this waits out the turn it arrives in.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "What the chat will receive, written as the user would." },
        at: { type: "string", description: "When to send: an ISO 8601 date and time such as 2026-10-06T09:00, read in the user's time zone unless it carries an offset (Z, +02:00)." },
        whenQuotaResets: { type: "boolean", description: "true: send once the quota refills — `model`'s when you pass one, else this chat's model. Cody waits for the reset (re-checking every few minutes when the provider names none), confirms the model is usable again, and gives up 24 hours after the reset (7 days after scheduling when no reset time is known)." },
        model: { type: "string", description: "The model to send it on: an exact provider/id (anthropic/claude-opus-4-8) or a name or part of one (\"opus 4.8\"). If it fits several models nothing is scheduled and the candidates come back. Omit to use whatever model the chat is on when the message is sent." },
        reasoning: { type: "string", description: "The reasoning level on that model, one it offers: off, minimal, low, medium, high, xhigh, max or auto. Needs `model`." },
        session: { type: "string", description: "Another chat's id or title; omit for this chat." },
      },
      required: ["message"],
    },
    handler: scheduleMessage,
  },
  {
    name: "list_scheduled",
    description: "List the messages scheduled for this chat (or `session`): id, when, the model it is sent on (when one was chosen), who scheduled it (the user or an agent), status and a preview.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Another chat's id or title; omit for this chat." },
      },
    },
    handler: listScheduledMessages,
  },
  {
    name: "cancel_scheduled",
    description: "Withdraw a scheduled message by id (from schedule_message or list_scheduled). A message that was already sent cannot be taken back.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The scheduled message's id, e.g. sch_k3J9x2Qa." },
      },
      required: ["id"],
    },
    handler: cancelScheduledMessage,
  },
];

export const SCHEDULE_TOOL_NAMES: readonly string[] = SCHEDULE_TOOLS.map((tool) => tool.name);
