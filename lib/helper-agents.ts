/**
 * The helper-agent list behind Settings › Models › Helper agents and the
 * helper window's "Change model" control: what each agent is, what model it
 * runs on right now, and why.
 *
 * Pure and browser-safe. The server finds the agent files and reads
 * `task.agentModelOverrides` (lib/omp/agent-roster.ts); this file turns what
 * it found into rows, and turns a row into the one sentence a person needs:
 * "set here", "the agent file's own choice" or "follows the chat".
 *
 * The rule it mirrors is omp's `resolveEffectiveAgentModelSelection`: a
 * setting beats the agent file's `model:`, and a file that says nothing (or
 * says `default`) takes the model of the chat that starts it.
 */
import { formatModelDisplayName } from "./model-display";
import { isRecognizedThinkingSuffix } from "./model-plan/derive";
import { isAgentName, parseAgentModelSelector, roleSelector, type AgentModelSelector } from "./agent-model-selector";

/** Where an agent definition lives. A project folder's `.omp/agents` beats the user's own folder, which beats omp's built-ins. */
export type AgentDefinitionOrigin = "project" | "user" | "bundled";

const ORIGIN_RANK: Readonly<Record<AgentDefinitionOrigin, number>> = { project: 0, user: 1, bundled: 2 };

export interface AgentDefinitionInfo {
  name: string;
  description: string;
  origin: AgentDefinitionOrigin;
  /** The `.md` file; absent for a built-in. */
  path?: string;
  /** The project folder a `project` definition belongs to. */
  projectRoot?: string;
  /** The frontmatter `model:` as a list; empty when the file sets none. */
  model: string[];
}

/** A model setting as omp stores it: one selector or a list of them. */
export type HelperSetting = string | string[];

export interface HelperAgentRow {
  name: string;
  description: string;
  /** omp ships an agent by this name. */
  builtIn: boolean;
  /** Every definition found, highest precedence first. Empty when only a setting names the agent. */
  definitions: AgentDefinitionInfo[];
  /** `task.agentModelOverrides[name]`, or null when unset. */
  setting: HelperSetting | null;
  /** The role Cody gives this agent when nothing is set, or null when Cody has no opinion. */
  codyDefault: string | null;
}

/** The roster: one row per agent name, alphabetical. A name that only appears in the setting still gets a row, so a stale entry can be seen and cleared. */
export function buildHelperRoster(
  definitions: readonly AgentDefinitionInfo[],
  settings: Readonly<Record<string, HelperSetting>>,
  codyDefaults: Readonly<Record<string, string>>,
): HelperAgentRow[] {
  const byName = new Map<string, AgentDefinitionInfo[]>();
  for (const definition of definitions) {
    const list = byName.get(definition.name);
    if (list) list.push(definition);
    else byName.set(definition.name, [definition]);
  }
  for (const name of Object.keys(settings)) if (isAgentName(name) && !byName.has(name)) byName.set(name, []);
  return [...byName.entries()]
    .map(([name, found]): HelperAgentRow => {
      const sorted = [...found].sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin]);
      return {
        name,
        description: sorted.find((definition) => definition.description)?.description ?? "",
        builtIn: sorted.some((definition) => definition.origin === "bundled"),
        definitions: sorted,
        setting: Object.hasOwn(settings, name) ? settings[name] : null,
        codyDefault: Object.hasOwn(codyDefaults, name) ? codyDefaults[name] : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** File `model:` values that follow the chat that starts the helper rather than naming a model (omp's isSessionInheritedAgentPattern). */
const FILE_MODELS_THAT_FOLLOW_THE_CHAT: Readonly<Record<string, true>> = { default: true, "@default": true, "*": true, "pi/default": true };

export function fileModelFollowsChat(model: readonly string[]): boolean {
  return model.length === 0 || (model.length === 1 && FILE_MODELS_THAT_FOLLOW_THE_CHAT[model[0].trim()] === true);
}

export type HelperModelSource = "setting" | "file" | "chat";

export interface HelperModelStatus {
  source: HelperModelSource;
  /** The single choice behind it: a role, an exact model or a custom value. Null when the helper follows the chat or runs a list. */
  selector: AgentModelSelector | null;
  /** Several models in order (a hand-written list); null otherwise. */
  list: string[] | null;
  /** The agent is defined in more than one place and the files choose different models. */
  varies: boolean;
}

function single(models: readonly string[]): { selector: AgentModelSelector | null; list: string[] | null } {
  if (models.length === 1) return { selector: parseAgentModelSelector(models[0]), list: null };
  return { selector: null, list: models.length > 1 ? [...models] : null };
}

/** What the agent runs on, and why. */
export function helperModelStatus(row: Pick<HelperAgentRow, "setting" | "definitions">): HelperModelStatus {
  const distinct = new Set(row.definitions.map((definition) => (fileModelFollowsChat(definition.model) ? "" : definition.model.join(","))));
  const varies = distinct.size > 1;
  if (row.setting !== null) {
    const models = typeof row.setting === "string" ? [row.setting] : row.setting;
    return { source: "setting", varies, ...single(models) };
  }
  const own = row.definitions.find((definition) => !fileModelFollowsChat(definition.model));
  if (own) return { source: "file", varies, ...single(own.model) };
  return { source: "chat", selector: null, list: null, varies };
}

// ---- the choices a Select offers ---------------------------------------------------

/** The roles that name a KIND OF WORK. The rest (commit, tiny, memory, widget, advisor and the non-chat kinds) each serve one engine feature. */
export const HELPER_ROLE_CHOICES: readonly string[] = ["default", "slow", "smol", "task", "plan", "vision"];

export interface HelperModelEntry {
  provider: string;
  id: string;
  name: string;
}

export interface HelperChoicesInput {
  /** The engine's own role vocabulary (empty when it could not be read). */
  roleNames: readonly string[];
  /** `modelRoles` from config.yml: role → `provider/model[:level]`. */
  roles: Readonly<Record<string, string>>;
  /** The models a person can pick: visible and reachable. */
  models: readonly HelperModelEntry[];
}

export interface HelperRoleChoice {
  role: string;
  /** `@slow`: what gets written. */
  selector: string;
  /** The model the role points at right now, in a person's words; null when the role has no explicit model. */
  model: string | null;
}

export interface HelperModelChoice {
  /** `provider/model`: what gets written. */
  selector: string;
  label: string;
  provider: string;
}

/** `provider/id[:level]` → the model's display name (with ` · level` when a reasoning level rides along). */
export function describeSelectorModel(selector: string | undefined, models: readonly HelperModelEntry[]): string | null {
  const raw = selector?.trim();
  if (!raw) return null;
  const known = (value: string) => models.find((model) => `${model.provider}/${model.id}` === value);
  const exact = known(raw);
  if (exact) return formatModelDisplayName(exact.id, exact.name);
  const colon = raw.lastIndexOf(":");
  if (colon > raw.lastIndexOf("/") && isRecognizedThinkingSuffix(raw.slice(colon + 1))) {
    const base = known(raw.slice(0, colon));
    if (base) return `${formatModelDisplayName(base.id, base.name)} · ${raw.slice(colon + 1)}`;
  }
  return raw;
}

/** The roles to offer. A role already in use is kept even when it is not one of the usual ones, so the current choice never disappears from the list. */
export function helperRoleChoices(input: HelperChoicesInput, keep?: string | null): HelperRoleChoice[] {
  const offered = HELPER_ROLE_CHOICES.filter((role) => input.roleNames.length === 0 || input.roleNames.includes(role));
  const extra = keep && !offered.includes(keep) ? [keep] : [];
  return [...offered, ...extra].map((role) => ({
    role,
    selector: roleSelector(role),
    model: describeSelectorModel(input.roles[role], input.models),
  }));
}

export function helperModelChoices(input: HelperChoicesInput): HelperModelChoice[] {
  return input.models
    .map((model) => ({
      selector: `${model.provider}/${model.id}`,
      label: formatModelDisplayName(model.id, model.name),
      provider: model.provider,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

/** The words that name what a `Select` value stands for, as a person would say it. Used in notes, toasts and the chat line. */
export function describeHelperSelector(selector: string, input: HelperChoicesInput): string {
  const parsed = parseAgentModelSelector(selector);
  if (parsed?.kind === "role") {
    const model = describeSelectorModel(input.roles[parsed.role], input.models);
    const name = capitalise(parsed.role);
    return model ? `${name} (${model})` : name;
  }
  return describeSelectorModel(selector, input.models) ?? selector;
}

// ---- the Select a settings row or the helper window shows --------------------------

/** The Select value that means "go back to the usual choice" (settings rows only). */
export const HELPER_RESET_VALUE = "reset";

export interface HelperOption {
  value: string;
  label: string;
  description?: string;
}

export interface HelperOptionGroup {
  label: string;
  options: HelperOption[];
}

/** The words around the choices. English here (Settings is English-only); the helper window passes its own. */
export interface HelperOptionWords {
  groupRoles: string;
  groupModels: string;
  groupCurrent: string;
  /** The line under a role that points at a model. */
  roleModel: (model: string) => string;
  /** The line under a role that has no model of its own yet. */
  roleEngineChoice: string;
  custom: (selector: string) => string;
}

export const ENGLISH_HELPER_WORDS: HelperOptionWords = {
  groupRoles: "Roles (recommended)",
  groupModels: "One exact model (no fallback chain)",
  groupCurrent: "Current",
  roleModel: (model) => `${model}. Keeps the role's fallback chain.`,
  roleEngineChoice: "The engine's own choice for this role.",
  custom: (selector) => `Custom: ${selector}`,
};

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A selector as a Select value: `r:slow`, `m:provider/id` or (written by hand) `c:whatever`. Null for an empty one. */
export function helperValue(selector: string): string | null {
  const parsed = parseAgentModelSelector(selector);
  if (!parsed) return null;
  return `${parsed.kind === "role" ? "r" : parsed.kind === "model" ? "m" : "c"}:${parsed.kind === "role" ? parsed.role : parsed.selector}`;
}

/** The selector to write for a Select value; null for the reset and custom values, which write nothing of their own. */
export function helperSelectorOf(value: string): string | null {
  if (value.startsWith("r:")) return roleSelector(value.slice(2));
  if (value.startsWith("m:")) return value.slice(2);
  return null;
}

export interface HelperOptionsInput extends HelperChoicesInput {
  /** The selector in use. Kept in the list even when it would not be offered (a custom value, a model that is gone, a role outside the usual ones). */
  current?: string | null;
  /** The label of a first "go back" entry, or null for none. */
  reset?: string | null;
  words?: HelperOptionWords;
}

/** The grouped options of the model Select: reset, the roles, then every exact model. */
export function helperOptionGroups(input: HelperOptionsInput): HelperOptionGroup[] {
  const words = input.words ?? ENGLISH_HELPER_WORDS;
  const current = input.current ? parseAgentModelSelector(input.current) : null;
  const groups: HelperOptionGroup[] = [];
  if (input.reset) groups.push({ label: "Reset", options: [{ value: HELPER_RESET_VALUE, label: input.reset }] });
  groups.push({
    label: words.groupRoles,
    options: helperRoleChoices(input, current?.kind === "role" ? current.role : null).map((choice) => ({
      value: `r:${choice.role}`,
      label: capitalise(choice.role),
      description: choice.model ? words.roleModel(choice.model) : words.roleEngineChoice,
    })),
  });
  const exact: HelperOption[] = helperModelChoices(input).map((choice) => ({ value: `m:${choice.selector}`, label: choice.label, description: choice.selector }));
  if (current?.kind === "model" && !exact.some((option) => option.value === `m:${current.selector}`)) {
    exact.unshift({ value: `m:${current.selector}`, label: describeSelectorModel(current.selector, input.models) ?? current.selector, description: current.selector });
  }
  groups.push({ label: words.groupModels, options: exact });
  if (current?.kind === "custom") groups.push({ label: words.groupCurrent, options: [{ value: `c:${current.selector}`, label: words.custom(current.selector) }] });
  return groups.filter((group) => group.options.length > 0);
}

/** Whether a row has a setting that Reset would change: Cody's own default role is where it goes back to for the agents it has one for. */
export function helperCanReset(row: Pick<HelperAgentRow, "setting" | "codyDefault">): boolean {
  if (row.setting === null) return false;
  return typeof row.setting !== "string" || row.setting !== row.codyDefault;
}

/** The "go back" entry's label, or null when there is nothing to go back from. */
export function helperResetLabel(row: HelperAgentRow, input: HelperChoicesInput): string | null {
  if (!helperCanReset(row)) return null;
  if (row.codyDefault) return `Reset to Cody's default: ${describeHelperSelector(row.codyDefault, input)}`;
  if (row.definitions.length === 0) return "Remove this setting (no agent file uses it)";
  const own = row.definitions.find((definition) => !fileModelFollowsChat(definition.model));
  if (own) return `Reset to the agent file's choice: ${own.model.length === 1 ? describeHelperSelector(own.model[0], input) : own.model.join(", ")}`;
  return "Reset: use the model of the chat that starts it";
}
