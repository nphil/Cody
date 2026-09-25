import { randomBytes, randomUUID } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "../omp/paths";
import { resolveRosterModel } from "../model-plan/derive";
import type { RosterModel } from "../model-plan/roster";
import { getOmpModelRoleIds, readModelRoles } from "../omp/model-roles";
import { isRecord } from "../type-guards";
import { parsePresetSelector } from "./selector";
import {
  BUILTIN_PRESET_IDS,
  NON_CHAT_ROLES,
  type BuiltinPresetId,
  type ModelPreset,
  type ModelPresetUpdate,
  type PresetRationale,
  type PresetResearchStamp,
  type SmartDefault,
} from "./types";

/**
 * Cody-owned preset store (`cody-model-presets.json` in the instance data
 * dir). omp's config.yml is never written here: a preset reaches the engine
 * only as a per-conversation overlay (./overlay.ts).
 *
 * Every write is read → validate → atomic replace, and unknown top-level keys
 * survive, so a newer Cody's fields are not lost by an older one.
 */

export const PRESETS_FILE = "cody-model-presets.json";
const VERSION = 1;
const MAX_NAME = 60;
const MAX_INTENT = 600;
const MAX_CHAIN = 32;
const MAX_CHAINS = 64;
const MAX_CUSTOM_PRESETS = 32;
const MAX_RATIONALE = 64;

/** Built-in presets as first seeded. The names and briefs are the user's own
 *  tiers; editing either keeps the preset built-in. */
export const BUILTIN_PRESETS: Readonly<Record<BuiltinPresetId, { name: string; intent: string }>> = {
  max: {
    name: "Max",
    intent: "The hardest work: difficult logic, debugging and bug fixing, creative problem solving, and large, complex projects. Use the strongest models with deep reasoning where it pays off. Token-heavy is acceptable; wasteful is not.",
  },
  high: {
    name: "High",
    intent: "Serious work that needs good reasoning but not the very top tier, such as building a custom Home Assistant integration or a multi-file feature.",
  },
  medium: {
    name: "Medium",
    intent: "Everyday coding and routine changes: solid, capable models at moderate reasoning, conserving quota.",
  },
  low: {
    name: "Low",
    intent: "Quota saver: simple edits, questions and mechanical work on the lightest capable models with minimal reasoning.",
  },
};

interface StoredPresets {
  version: number;
  presets: ModelPreset[];
  lastUsedPresetId: string | null;
  [extra: string]: unknown;
}

export class PresetValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = "invalid_preset") {
    super(message);
    this.name = "PresetValidationError";
    this.code = code;
  }
}

function presetsPath(): string {
  return path.join(getAgentDir(), PRESETS_FILE);
}

export function atomicJsonWrite(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function isBuiltinId(id: string): id is BuiltinPresetId {
  return (BUILTIN_PRESET_IDS as readonly string[]).includes(id);
}

/** The chat roles a preset may assign: omp's live role vocabulary minus the
 *  non-chat roles. The engine owns the list, so a role it drops disappears. */
export function presetRoleNames(): string[] {
  return getOmpModelRoleIds().filter((role) => !NON_CHAT_ROLES.includes(role));
}

/** `provider/modelId[:level]`: a provider, a slash, a non-empty id; no
 *  whitespace; bounded. The catalog is NOT consulted — a model that is briefly
 *  unavailable must not make a saved preset unsavable. */
export function isValidSelector(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 300 || /\s/.test(value)) return false;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

/** Fallback chain entries may also be a role reference (`@smol`) or a
 *  provider wildcard (`openai/*`), which omp accepts. */
function isValidChainEntry(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 300 || /\s/.test(value)) return false;
  return value.startsWith("@") || isValidSelector(value) || /^[^/]+\/\*$/.test(value);
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function readRoles(value: unknown, roleNames: readonly string[] | null): Record<string, string> {
  if (!isRecord(value)) return {};
  const roles: Record<string, string> = {};
  for (const [role, selector] of Object.entries(value)) {
    if (roleNames && !roleNames.includes(role)) continue;
    if (isValidSelector(selector)) roles[role] = selector;
  }
  return roles;
}

function readChains(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const chains: Record<string, string[]> = {};
  for (const [key, entries] of Object.entries(value).slice(0, MAX_CHAINS)) {
    if (!key || key.length > 300 || !Array.isArray(entries)) continue;
    const valid = [...new Set(entries.filter(isValidChainEntry))].slice(0, MAX_CHAIN);
    if (valid.length > 0) chains[key] = valid;
  }
  return chains;
}

function readRationale(value: unknown): PresetRationale[] {
  if (!Array.isArray(value)) return [];
  const out: PresetRationale[] = [];
  for (const item of value.slice(0, MAX_RATIONALE)) {
    if (!isRecord(item) || typeof item.role !== "string" || typeof item.text !== "string") continue;
    const sources = Array.isArray(item.sources)
      ? item.sources.filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url) && url.length <= 2000).slice(0, 12)
      : [];
    out.push({ role: item.role.slice(0, 40), text: item.text.slice(0, 2000), sources });
  }
  return out;
}

function readResearch(value: unknown): PresetResearchStamp | undefined {
  if (!isRecord(value)) return undefined;
  const { runId, plannerModel, completedAt } = value;
  if (typeof runId !== "string" || typeof plannerModel !== "string" || typeof completedAt !== "string") return undefined;
  if (!Number.isFinite(Date.parse(completedAt))) return undefined;
  return { runId: runId.slice(0, 100), plannerModel: plannerModel.slice(0, 300), completedAt, rationale: readRationale(value.rationale) };
}

function readPreset(value: unknown): ModelPreset | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || value.id.length > 100) return null;
  const builtIn = isBuiltinId(value.id);
  const name = cleanText(value.name, MAX_NAME) || (builtIn ? BUILTIN_PRESETS[value.id as BuiltinPresetId].name : "");
  if (!name) return null;
  const research = readResearch(value.research);
  return {
    id: value.id,
    name,
    intent: typeof value.intent === "string" ? cleanText(value.intent, MAX_INTENT) : (builtIn ? BUILTIN_PRESETS[value.id as BuiltinPresetId].intent : ""),
    builtIn,
    // Stored roles are kept even if the engine later drops a role: the
    // overlay filters to the live vocabulary at launch, and an engine
    // downgrade must not silently delete configuration.
    roles: readRoles(value.roles, null),
    chains: readChains(value.chains),
    ...(typeof value.usageAwareFallback === "boolean" ? { usageAwareFallback: value.usageAwareFallback } : {}),
    ...(research ? { research } : {}),
    updatedAt: typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : new Date(0).toISOString(),
  };
}

function seedBuiltin(id: BuiltinPresetId): ModelPreset {
  return { id, name: BUILTIN_PRESETS[id].name, intent: BUILTIN_PRESETS[id].intent, builtIn: true, roles: {}, chains: {}, updatedAt: new Date(0).toISOString() };
}

function readStore(): StoredPresets {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(presetsPath(), "utf8"));
  } catch {
    parsed = null;
  }
  const raw = isRecord(parsed) ? parsed : {};
  const seen = new Set<string>();
  const stored: ModelPreset[] = [];
  for (const entry of Array.isArray(raw.presets) ? raw.presets : []) {
    const preset = readPreset(entry);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    stored.push(preset);
  }
  // Built-ins always exist, first and in tier order; custom presets follow in
  // the order they were created.
  const builtIns = BUILTIN_PRESET_IDS.map((id) => stored.find((preset) => preset.id === id) ?? seedBuiltin(id));
  const custom = stored.filter((preset) => !preset.builtIn);
  const presets = [...builtIns, ...custom];
  const lastUsed = typeof raw.lastUsedPresetId === "string" && presets.some((preset) => preset.id === raw.lastUsedPresetId)
    ? raw.lastUsedPresetId
    : null;
  return { ...raw, version: VERSION, presets, lastUsedPresetId: lastUsed };
}

function writeStore(store: StoredPresets): void {
  atomicJsonWrite(presetsPath(), store);
}

export function listPresets(): { presets: ModelPreset[]; lastUsedPresetId: string | null } {
  const store = readStore();
  return { presets: store.presets, lastUsedPresetId: store.lastUsedPresetId };
}

export function getPreset(id: string): ModelPreset | null {
  return readStore().presets.find((preset) => preset.id === id) ?? null;
}

/** The preset a new chat starts on: the one the user picked last. Picking
 *  "Base settings" is a pick too, and is remembered as null. */
export function setLastUsedPreset(id: string | null): void {
  const store = readStore();
  const next = id !== null && store.presets.some((preset) => preset.id === id) ? id : null;
  if (store.lastUsedPresetId === next) return;
  writeStore({ ...store, lastUsedPresetId: next });
}

export function createPreset(input: { name: unknown; intent?: unknown; copyFrom?: unknown }): ModelPreset {
  const store = readStore();
  const name = cleanText(input.name, MAX_NAME);
  if (!name) throw new PresetValidationError("A preset needs a name.");
  if (store.presets.filter((preset) => !preset.builtIn).length >= MAX_CUSTOM_PRESETS) {
    throw new PresetValidationError(`At most ${MAX_CUSTOM_PRESETS} custom presets.`, "too_many_presets");
  }
  let roles: Record<string, string> = {};
  let chains: Record<string, string[]> = {};
  let usageAwareFallback: boolean | undefined;
  if (input.copyFrom === "base") {
    roles = readRoles(readModelRoles().roles, presetRoleNames());
  } else if (typeof input.copyFrom === "string" && input.copyFrom) {
    const source = store.presets.find((preset) => preset.id === input.copyFrom);
    if (!source) throw new PresetValidationError("The preset to copy no longer exists.", "not_found");
    roles = { ...source.roles };
    chains = Object.fromEntries(Object.entries(source.chains).map(([key, list]) => [key, [...list]]));
    usageAwareFallback = source.usageAwareFallback;
  }
  const preset: ModelPreset = {
    id: randomUUID(),
    name,
    intent: cleanText(input.intent, MAX_INTENT),
    builtIn: false,
    roles,
    chains,
    ...(usageAwareFallback !== undefined ? { usageAwareFallback } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeStore({ ...store, presets: [...store.presets, preset] });
  return preset;
}

/** Validate an update against the live role vocabulary. Throws on anything
 *  the client sent that cannot be stored as-is: a silent partial save would
 *  leave the user believing a role changed when it did not. */
export function updatePreset(id: string, update: ModelPresetUpdate): ModelPreset {
  const store = readStore();
  const index = store.presets.findIndex((preset) => preset.id === id);
  if (index < 0) throw new PresetValidationError("That preset no longer exists.", "not_found");
  const current = store.presets[index];
  const next: ModelPreset = { ...current };

  if (update.name !== undefined) {
    const name = cleanText(update.name, MAX_NAME);
    if (!name) throw new PresetValidationError("A preset needs a name.");
    next.name = name;
  }
  if (update.intent !== undefined) next.intent = cleanText(update.intent, MAX_INTENT);
  if (update.roles !== undefined) {
    if (!isRecord(update.roles)) throw new PresetValidationError("roles must be an object.");
    const roleNames = presetRoleNames();
    const roles: Record<string, string> = {};
    for (const [role, selector] of Object.entries(update.roles)) {
      if (!roleNames.includes(role)) throw new PresetValidationError(`"${role}" is not a chat role this engine has.`);
      if (selector === "" || selector === null) continue; // inherit base
      if (!isValidSelector(selector)) throw new PresetValidationError(`"${String(selector)}" is not a model selector (provider/model[:level]).`);
      // Anything may follow a colon: real ids carry colons (`:free`, `:batch`,
      // `qwen3:8b`), and omp itself decides what is a reasoning level.
      roles[role] = selector;
    }
    next.roles = roles;
  }
  if (update.chains !== undefined) {
    if (!isRecord(update.chains)) throw new PresetValidationError("chains must be an object.");
    const chainEntries = Object.entries(update.chains);
    if (chainEntries.length > MAX_CHAINS) {
      throw new PresetValidationError(`A preset can hold at most ${MAX_CHAINS} fallback chains, not ${chainEntries.length}.`, "too_many_chains");
    }
    const chains: Record<string, string[]> = {};
    for (const [key, rawList] of chainEntries) {
      if (!key || key.length > 300) throw new PresetValidationError(`"${key}" is not a valid fallback chain key.`);
      if (!Array.isArray(rawList) || !rawList.every(isValidChainEntry)) {
        throw new PresetValidationError(`The fallback chain for "${key}" has an entry that is not a model, wildcard or role.`);
      }
      const deduped = [...new Set(rawList)];
      if (deduped.length > MAX_CHAIN) {
        throw new PresetValidationError(`The fallback chain for "${key}" has ${deduped.length} entries; at most ${MAX_CHAIN} are kept.`, "chain_too_long");
      }
      if (deduped.length > 0) chains[key] = deduped;
    }
    next.chains = chains;
  }
  if (update.usageAwareFallback !== undefined) {
    if (update.usageAwareFallback === null) delete next.usageAwareFallback;
    else if (typeof update.usageAwareFallback === "boolean") next.usageAwareFallback = update.usageAwareFallback;
    else throw new PresetValidationError("usageAwareFallback must be true, false or null.");
  }
  if (update.research !== undefined) {
    if (update.research === null) delete next.research;
    else {
      const research = readResearch(update.research);
      if (!research) throw new PresetValidationError("research must carry runId, plannerModel and completedAt.");
      next.research = research;
    }
  }
  next.updatedAt = new Date().toISOString();
  const presets = [...store.presets];
  presets[index] = next;
  writeStore({ ...store, presets });
  return next;
}

export function deletePreset(id: string): void {
  const store = readStore();
  const preset = store.presets.find((entry) => entry.id === id);
  if (!preset) throw new PresetValidationError("That preset no longer exists.", "not_found");
  if (preset.builtIn) throw new PresetValidationError("Built-in presets can be edited but not deleted.", "builtin");
  writeStore({
    ...store,
    presets: store.presets.filter((entry) => entry.id !== id),
    lastUsedPresetId: store.lastUsedPresetId === id ? null : store.lastUsedPresetId,
  });
}

/** What Smart resolves to for a conversation on `preset` (or base settings):
 *  the preset's `default` role, else the base config's. */
export function resolveSmartDefault(preset: ModelPreset | null, roster?: RosterModel[]): SmartDefault | null {
  const selector = preset?.roles.default ?? readModelRoles().roles.default;
  if (!selector || !isValidSelector(selector)) return null;
  if (!roster) return parsePresetSelector(selector);
  // The effective OMP roster is authoritative after provider curation. An
  // exact id ending in :high must also win over the thinking-suffix parser.
  const model = resolveRosterModel(selector, roster);
  if (!model) return null;
  return {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: selector === model.selector ? null : selector.slice(model.selector.length + 1),
  };
}
