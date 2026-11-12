import { getHarness } from "../harness";
import { isRecognizedThinkingSuffix } from "../model-plan/derive";
import {
  resolveSessionArgument,
  stringArg,
  type SessionToolArgs,
  type SessionToolContext,
  type SessionToolDefinition,
} from "../session-tools";
import {
  looksLikeLevel,
  modelKey,
  modelThinkingLevels,
  resolveModel,
  resolveThinkingLevel,
  type CatalogModel,
} from "./resolve";
import type {
  ChatModelCatalog,
  ChatModelState,
  EverywhereResult,
  SwitchResult,
} from "./switch";

/**
 * Switching the model, as a tool any chat's agent can call.
 *
 * One tool, `switch_model`, over the same engine commands the composer's own
 * picker sends (lib/model-switch/switch.ts). It follows the session tools'
 * contract (lib/session-tools.ts): the handler answers plain text — success or
 * a short refusal — and never throws, so a caller's dispatch needs no try/catch.
 *
 * What a model name means is decided against the target chat's OWN live
 * catalog and never by guessing: a name that fits several models answers with
 * the list, an unknown one with the closest names, a reasoning level the model
 * lacks with the levels it has.
 *
 * The scope defaults to the chat the agent runs in. Changing the default every
 * NEW chat starts on is a separate, explicit scope, because it is the kind of
 * change a user means to make on purpose.
 *
 * Not offered to the sidebar chat: its schema budget assumes the smallest local
 * model (lib/sidebar-context-budget.ts), and this description is written to
 * teach, which costs tokens it cannot spare.
 */

/** Candidates shown when a name fits several models. */
const MAX_CANDIDATES = 12;
/** Models listed when the call asks only what is available. */
const MAX_LISTED = 30;

function label(model: { provider: string; id: string; name?: string }): string {
  const key = modelKey(model);
  return model.name && model.name !== model.id ? `${key} (${model.name})` : key;
}

function describe(state: ChatModelState | null): string {
  if (!state) return "no model";
  const base = label({ provider: state.provider, id: state.modelId, name: state.name });
  return state.thinkingLevel ? `${base}, reasoning ${state.thinkingLevel}` : base;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function bounded(models: readonly CatalogModel[], limit: number): string {
  const lines = models.slice(0, limit).map(label);
  if (models.length > limit) lines.push(`… ${models.length - limit} more`);
  return lines.join("\n");
}

/** Called with neither `model` nor `reasoning`: what the chat is on and what it may move to. */
function report(catalog: ChatModelCatalog, whose: string): string {
  const lines = [`${capitalized(whose)} is on ${describe(catalog.current)}.`];
  if (catalog.sessionScoped) {
    lines.push("This engine has no reasoning levels to set.");
  } else if (catalog.currentModel) {
    lines.push(`Reasoning levels it offers: ${modelThinkingLevels(catalog.currentModel).join(", ")}.`);
  }
  if (!catalog.selectable) {
    lines.push("This engine offers no model selection for this chat, so its model cannot be changed.");
    return lines.join("\n");
  }
  if (catalog.models.length === 0) {
    lines.push("The engine lists no models to switch to.");
    return lines.join("\n");
  }
  const perProvider = new Map<string, number>();
  for (const model of catalog.models) perProvider.set(model.provider, (perProvider.get(model.provider) ?? 0) + 1);
  const providers = [...perProvider].map(([provider, count]) => `${provider} (${count})`).join(", ");
  lines.push(`${catalog.models.length} models can be switched to — ${providers}. Any name or part of one works; the first ${Math.min(MAX_LISTED, catalog.models.length)}:`);
  lines.push(bounded(catalog.models, MAX_LISTED));
  return lines.join("\n");
}

function ambiguousText(query: string, candidates: readonly CatalogModel[]): string {
  return [
    `"${query}" fits ${candidates.length} models, so nothing was changed. Ask the user which one they mean, then call again with its exact provider/id:`,
    bounded(candidates, MAX_CANDIDATES),
  ].join("\n");
}

function unknownText(query: string, suggestions: readonly CatalogModel[], total: number): string {
  const words = query.trim().split(/\s+/);
  const lastWord = words[words.length - 1] ?? "";
  const levelHint = words.length > 1 && looksLikeLevel(lastWord)
    ? ` If "${lastWord}" was meant as the reasoning level, pass it as \`reasoning\` and leave it out of \`model\`.`
    : "";
  const closest = suggestions.length > 0
    ? ` The closest are:\n${bounded(suggestions, suggestions.length)}`
    : ` ${total} models are available; call switch_model with no arguments to list them.`;
  return `No model matches "${query}", so nothing was changed.${levelHint}${closest}`;
}

function invalidLevelText(input: string, model: CatalogModel, valid: readonly string[]): string {
  return `"${input}" is not a reasoning level of ${modelKey(model)}, so nothing was changed. It offers: ${valid.join(", ")}.`;
}

/** When the new setting starts to be used, in the words of whoever is waiting for it. */
function whenText(result: SwitchResult, own: boolean): string {
  if (result.applies === "next-step") {
    return own
      ? "It applies from your next step in this turn: your next request already uses it."
      : "It applies from that chat's next request.";
  }
  return "It applies from that chat's next turn; nothing is running there now.";
}

function chatText(result: SwitchResult, whose: string, own: boolean): string {
  const before = describe(result.previous);
  switch (result.status) {
    case "refused":
      return `Could not switch ${whose}: ${result.message}`;
    case "unchanged":
      return `${capitalized(whose)} is already on ${describe(result.current)}; nothing changed.`;
    case "deferred":
      return `${capitalized(whose)} is mid-turn, so the switch is queued: it moves to ${describe(result.requested)} `
        + `${result.applies === "next-turn" ? "when the turn ends" : "at its next step boundary, normally within seconds"}. `
        + `Nothing has changed yet; it is still on ${before}. If it cannot be applied then, the chat shows a notice.`;
    case "applied":
      if (result.code === "reasoning_failed") {
        return `${capitalized(whose)} is now on ${describe(result.current)}, but its reasoning level could not be set (${result.message}). ${whenText(result, own)} It was on ${before}.`;
      }
      return `${capitalized(whose)} is now on ${describe(result.current)}. ${whenText(result, own)} It was on ${before}.`;
  }
}

/** `anthropic/claude-opus-4-8:high` -> its model and level, so an undo can be spelled as this tool's own arguments. */
function splitRoleSelector(selector: string): { model: string; level?: string } {
  const colon = selector.lastIndexOf(":");
  if (colon <= selector.lastIndexOf("/") || !isRecognizedThinkingSuffix(selector.slice(colon + 1))) return { model: selector };
  return { model: selector.slice(0, colon), level: selector.slice(colon + 1) };
}

function everywhereText(result: EverywhereResult, requested: ChatModelState): string {
  const lines = [
    `The default model for new chats and helper agents is now ${result.newDefault}`
    + `${requested.name ? ` (${requested.name})` : ""}. `
    + (result.previousDefault === null ? "It was not set before." : `It was ${result.previousDefault}.`),
    "Chats that are already open keep the model they are on; use scope \"chat\" to move one.",
    `${result.restarted} idle chat engine${result.restarted === 1 ? " was" : "s were"} restarted to read it; ${result.active} running one${result.active === 1 ? " picks" : "s pick"} it up the next time ${result.active === 1 ? "it restarts" : "they restart"}.`,
  ];
  if (result.previousDefault === null) {
    lines.push("To go back, remove the default role in Settings → Models, which restores the engine's own choice.");
  } else {
    const before = splitRoleSelector(result.previousDefault);
    const reasoning = before.level ? ` and reasoning "${before.level}"` : "";
    lines.push(`To undo: call switch_model with scope "everywhere", model "${before.model}"${reasoning}.`);
    if (!result.newDefault.includes(":") && before.level) {
      lines.push(`The previous reasoning setting (${before.level}) was not carried over because none was given.`);
    }
  }
  return lines.join("\n");
}

async function run(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  const scope = (stringArg(args, "scope") ?? "chat").toLowerCase();
  if (scope !== "chat" && scope !== "everywhere") {
    return "scope must be \"chat\" (this chat only, the default) or \"everywhere\" (the default for new chats).";
  }
  const modelQuery = stringArg(args, "model");
  const reasoningQuery = stringArg(args, "reasoning");
  const sessionArg = stringArg(args, "session");

  if (scope === "everywhere") {
    if (sessionArg) {
      return "scope \"everywhere\" changes the default for every new chat, so it cannot be combined with `session`. Drop `session`, or use scope \"chat\" to change one chat.";
    }
    if (getHarness().id !== "omp") {
      return "scope \"everywhere\" is not available for this engine: only omp has default-model settings to change. Use scope \"chat\".";
    }
    if (!modelQuery) {
      return "scope \"everywhere\" needs `model`: say which model the default should become (with `reasoning` if it should carry a level).";
    }
  }

  const chat = await resolveSessionArgument(sessionArg, ctx);
  if ("text" in chat) return chat.text;
  const own = chat.id === ctx.defaultSessionId;
  const whose = own ? "this chat" : `chat ${chat.id}`;

  // Loaded here, not at the top: switch.ts imports ../rpc-manager, which imports this module for its tool list (lib/chat-messages/tools.ts loads its delivery the same way).
  const { openChat, setEverywhereDefault, switchChatModel } = await import("./switch");
  const opened = await openChat(chat.id, { timeZone: ctx.timeZone });
  if (!opened.ok) return `Could not read ${whose}'s models: ${opened.result.message}`;
  const { session, catalog } = opened.chat;

  if (!modelQuery && !reasoningQuery) return report(catalog, whose);

  let model: CatalogModel;
  if (modelQuery) {
    if (!catalog.selectable) return `Could not switch ${whose}: this engine offers no model selection for it.`;
    const resolution = resolveModel(modelQuery, catalog.models);
    if (resolution.kind === "ambiguous") return ambiguousText(modelQuery, resolution.candidates);
    if (resolution.kind === "unknown") return unknownText(modelQuery, resolution.suggestions, catalog.models.length);
    model = resolution.model;
  } else {
    if (!catalog.currentModel) return `Could not change reasoning: ${whose} reports no current model. Pass \`model\` as well.`;
    model = catalog.currentModel;
  }

  let level: string | undefined;
  if (reasoningQuery) {
    if (catalog.sessionScoped) return `Could not switch ${whose}: this engine has no reasoning levels to set. Ask for the model alone.`;
    const resolved = resolveThinkingLevel(reasoningQuery, model);
    if (!resolved.ok) return invalidLevelText(reasoningQuery, model, resolved.valid);
    level = resolved.level;
  }

  const target = { provider: model.provider, modelId: model.id, ...(level !== undefined ? { thinkingLevel: level } : {}) };

  if (scope === "everywhere") {
    const written = await setEverywhereDefault(target);
    return everywhereText(written, { provider: model.provider, modelId: model.id, ...(model.name ? { name: model.name } : {}), ...(level !== undefined ? { thinkingLevel: level } : {}) });
  }

  // The caller's own agent is inside a tool call: no provider stream is open,
  // so a model change is safe right now on the rpc dialect.
  const result = await switchChatModel(chat.id, target, { session, catalog, atStepBoundary: own });
  return chatText(result, whose, own);
}

async function switchModel(args: SessionToolArgs, ctx: SessionToolContext): Promise<string> {
  try {
    return await run(args, ctx);
  } catch (error) {
    return `Could not complete that: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export const MODEL_SWITCH_TOOLS: SessionToolDefinition[] = [
  {
    name: "switch_model",
    description:
      "Switch the model — and optionally the reasoning level — a chat runs on. By default this changes ONLY this chat, the one you are running in, and nothing else. Use it when the user asks you to move to another model (\"switch to Opus 4.8 with high reasoning\", \"use a cheaper model for this part\"). "
      + "`model` is matched against the models this chat can really use: pass an exact `provider/id`, or a name or part of one (\"opus 4.8\"). If it fits more than one model, nothing changes and the candidates come back — ask the user which; never guess. "
      + "`reasoning` must be a level that model really offers (off, minimal, low, medium, high, xhigh, max or auto, as it lists them); a level it lacks is refused with the valid ones. Leave `model` out to change only the reasoning of the current model. Call with neither to see the current model and what is available. "
      + "The result states what is set now, whether it applies from your next step or the next turn, and what it was before. A different chat that is mid-turn gets the switch at its next step boundary. `session` targets another chat by id or title. "
      + "scope \"everywhere\" instead changes the default model new chats and helper agents start on (omp only; needs `model`, and `reasoning` becomes part of that default). Use it ONLY when the user explicitly asks to change the default for everything: chats that are already open keep their model. "
      + "This changes things now, once. For a switch at a later time (\"back to Sonnet at 1am\"), use schedule_message with `model` (and `reasoning`): the chat is switched to it just before that message is sent.",
    parameters: {
      type: "object",
      properties: {
        model: { type: "string", description: "The model: an exact provider/id (anthropic/claude-opus-4-8) or a name or part of one (\"opus 4.8\"). Omit to keep the current model." },
        reasoning: { type: "string", description: "The reasoning level for that model, one it offers: off, minimal, low, medium, high, xhigh, max or auto." },
        scope: { type: "string", enum: ["chat", "everywhere"], description: "chat (default): this chat only. everywhere: the default for new chats and helpers — only when the user explicitly asked for that." },
        session: { type: "string", description: "Another chat's id or title; omit for this chat. Not with scope everywhere." },
      },
    },
    handler: switchModel,
  },
];

export const MODEL_SWITCH_TOOL_NAMES: readonly string[] = MODEL_SWITCH_TOOLS.map((tool) => tool.name);
