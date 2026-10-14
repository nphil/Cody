import { readFileSync, statSync } from "fs";
import { join } from "path";
import {
  CLAUDE_CREDITS_PROVIDER,
  CLAUDE_CREDITS_PROVIDERS,
  CLAUDE_PLAN_PROVIDER,
  claudeCreditsModelSuffix,
  type ClaudeCreditsAccount,
  type ClaudeCreditsStatus,
} from "../claude-credits";
import { addClaudeApiKey, listClaudeApiKeys, type ClaudeCreditsBridgeDeps } from "../harness/omp-claude-credits";
import { listOmpCredentials, removeOmpCredential, type OmpCredentialBridgeDeps, type OmpCredentialRow } from "../harness/omp-credentials";
import { isRecord } from "../type-guards";
import { readClaudeCreditsStore, writeClaudeCreditsStore } from "./claude-credits-store";
import { readModelsConfigFile, validateModelsConfig, writeModelsConfig, type ModelsFileConfig, type ProviderConfig } from "./models-config";
import { findOmpPackageRoot, resolveSourceSpecifier } from "./package-source";
import { readNativeSettings } from "./settings-config";

/**
 * Claude API credits, server side: the keys, the provider block that lets omp
 * serve them, and the status the Providers panel reads.
 *
 * The idea (lib/claude-credits.ts has the full reasoning): omp never reaches an
 * API key stored beside a plan account of the SAME provider, so the keys live
 * under providers of their own — `anthropic-api` for the first key,
 * `anthropic-api-2` for the second — that serve the plan's models with
 * `x-api-key`, and omp's own fallback chain walks `anthropic/<model>` →
 * `anthropic-api/<model>` → `anthropic-api-2/<model>` → whatever else the user
 * listed. Three things make that real, and this module owns the first two:
 *
 *  1. the keys, stored through omp's AuthStorage (bin/cody-omp-claude-credits.mjs),
 *     paired with a plan account in Cody's own record (claude-credits-store.ts);
 *  2. one block per key's provider in models.yml — one entry per Claude model
 *     omp knows, ids only (omp fills limits, thinking and prices from its own
 *     catalog), which exists exactly while its key does;
 *  3. the per-chat config overlay that puts the credits first in the fallback
 *     chains (claude-credits-overlay.ts).
 */

/** Where the credits' requests go. A test points it at a stand-in server. */
export const CLAUDE_CREDITS_BASE_URL = "https://api.anthropic.com";

/** A failure the route can report with a stable code (`errors.<code>` in the locales). */
export class ClaudeCreditsError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ClaudeCreditsError";
    this.code = code;
    this.status = status;
  }
}

// ── The Claude models the credits mirror ─────────────────────────────────────

export interface ClaudePlanModel {
  id: string;
  name: string;
}

let cachedPlanModels: { path: string; mtimeMs: number; models: ClaudePlanModel[] } | null = null;

/**
 * Every Claude model omp's bundled catalog lists under `anthropic`, which is
 * the set the credits must be able to answer for. Read from the installed
 * package (omp's `models.json`, the same file lib/omp/bundled-catalog.ts reads
 * for membership), cached by mtime. Null when the catalog cannot be read.
 */
export function readClaudePlanModels(packageRoot: string | null = findOmpPackageRoot()): ClaudePlanModel[] | null {
  if (!packageRoot) return null;
  const file = resolveSourceSpecifier(join(packageRoot, "package.json"), "@oh-my-pi/pi-catalog/models.json");
  if (!file) return null;
  try {
    const { mtimeMs } = statSync(file);
    if (cachedPlanModels && cachedPlanModels.path === file && cachedPlanModels.mtimeMs === mtimeMs) return cachedPlanModels.models;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const plan = isRecord(parsed) ? parsed[CLAUDE_PLAN_PROVIDER] : null;
    if (!isRecord(plan)) return null;
    const models = Object.entries(plan)
      .map(([id, entry]): ClaudePlanModel => ({ id, name: isRecord(entry) && typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (models.length === 0) return null;
    cachedPlanModels = { path: file, mtimeMs, models };
    return models;
  } catch {
    return null;
  }
}

// ── The models.yml block ─────────────────────────────────────────────────────

/** The provider block as Cody writes it. `auth: none` is deliberate: the key is
 * in omp's credential store, not in this file, and `none` is the one mode that
 * neither demands an `apiKey` here nor forces OAuth-style request shaping. */
function desiredBlock(models: readonly ClaudePlanModel[], baseUrl: string, provider: string): ProviderConfig {
  const suffix = claudeCreditsModelSuffix(provider);
  return {
    baseUrl,
    api: "anthropic-messages",
    auth: "none",
    models: models.map((model) => ({ id: model.id, name: `${model.name}${suffix}` })),
  };
}

/** A block Cody wrote: no key of its own, the plan's wire protocol, keyless auth. A hand-written
 * provider of one of the credits names with a key or another protocol is the user's and is never touched. */
export function isClaudeCreditsBlock(block: unknown): block is ProviderConfig {
  return isRecord(block) && block.api === "anthropic-messages" && block.auth === "none" && block.apiKey === undefined;
}

export interface ClaudeCreditsProviderState {
  /** models.yml holds this provider. */
  present: boolean;
  /** …and it is Cody's. */
  owned: boolean;
  /** The Claude model ids it serves. */
  modelIds: string[];
}

/** models.yml read ONCE: what it holds under each credits provider name. */
function readCreditsBlocks(): Map<string, ClaudeCreditsProviderState> {
  const file = readModelsConfigFile();
  const states = new Map<string, ClaudeCreditsProviderState>();
  if (file.parseError) return states;
  for (const name of CLAUDE_CREDITS_PROVIDERS) {
    const block = file.config.providers?.[name];
    if (block === undefined) continue;
    const modelIds = isRecord(block) && Array.isArray(block.models)
      ? block.models.flatMap((model) => (isRecord(model) && typeof model.id === "string" ? [model.id] : []))
      : [];
    states.set(name, { present: true, owned: isClaudeCreditsBlock(block), modelIds });
  }
  return states;
}

export function readClaudeCreditsProvider(provider: string = CLAUDE_CREDITS_PROVIDER): ClaudeCreditsProviderState {
  return readCreditsBlocks().get(provider) ?? { present: false, owned: false, modelIds: [] };
}

export interface SyncClaudeCreditsProviderOptions {
  /** Where the credits' requests go. Defaults to the block's own `baseUrl` when it already has one
   * (a gateway or proxy someone pointed it at survives every sync; a block added later inherits the
   * first one's), else Anthropic's API. */
  baseUrl?: string;
  models?: readonly ClaudePlanModel[];
}

/**
 * Make models.yml say what the saved keys need: a block for each credits
 * provider in `wanted` (the ones that hold a key), none for the rest.
 * Idempotent — it only writes when the file would change — and it merges onto
 * the user's document, so their comments and every other provider survive.
 * Cody owns each block's model list; the `baseUrl` it finds there is kept.
 */
export function syncClaudeCreditsProviders(wanted: readonly string[], options: SyncClaudeCreditsProviderOptions = {}): { changed: boolean } {
  const file = readModelsConfigFile();
  if (file.parseError) throw new ClaudeCreditsError("claude_credits_unavailable", "models.yml could not be read, so the Claude API credits cannot be set up. Fix that file first.", 409);
  const providers: Record<string, ProviderConfig> = { ...(file.config.providers ?? {}) };
  const wantedNames = new Set(wanted);
  const inheritedBaseUrl = CLAUDE_CREDITS_PROVIDERS.flatMap((name) => {
    const block = providers[name];
    return isClaudeCreditsBlock(block) && block.baseUrl ? [block.baseUrl] : [];
  })[0] ?? CLAUDE_CREDITS_BASE_URL;
  let models: readonly ClaudePlanModel[] | null | undefined;
  let changed = false;
  for (const name of CLAUDE_CREDITS_PROVIDERS) {
    const existing = providers[name];
    if (existing !== undefined && !isClaudeCreditsBlock(existing)) {
      if (wantedNames.has(name)) throw new ClaudeCreditsError("claude_credits_unavailable", `models.yml already has its own "${name}" provider, which Cody will not overwrite.`, 409);
      continue;
    }
    let next: ProviderConfig | undefined;
    if (wantedNames.has(name)) {
      models ??= options.models ?? readClaudePlanModels();
      if (!models) throw new ClaudeCreditsError("claude_credits_unavailable", "Cody could not read omp's list of Claude models.", 503);
      next = desiredBlock(models, options.baseUrl ?? (isClaudeCreditsBlock(existing) && existing.baseUrl ? existing.baseUrl : inheritedBaseUrl), name);
    }
    if (JSON.stringify(existing) === JSON.stringify(next)) continue;
    if (next) providers[name] = next;
    else delete providers[name];
    changed = true;
  }
  if (!changed) return { changed: false };
  const config: ModelsFileConfig = { ...file.config, providers };
  validateModelsConfig(config);
  writeModelsConfig(config);
  return { changed: true };
}

// ── "Are the credits behind the plans right now?" ────────────────────────────

export interface ClaudeCreditsRouting {
  /** A saved key is served by models.yml. */
  active: boolean;
  /** Claude model ids the credits can answer for. */
  modelIds: ReadonlySet<string>;
  /** How many saved keys models.yml serves — one per provider. */
  keyCount: number;
  /** The credits providers that hold a saved key and are served by models.yml, in the order the chain tries them. */
  providers: readonly string[];
}

/** Two small file reads, no child process: cheap enough for the usage poll and for every chat spawn. */
export function readClaudeCreditsRouting(): ClaudeCreditsRouting {
  const withKey = new Set(readClaudeCreditsStore().map((entry) => entry.provider));
  const blocks = readCreditsBlocks();
  const providers = CLAUDE_CREDITS_PROVIDERS.filter((name) => withKey.has(name) && blocks.get(name)?.owned && (blocks.get(name)?.modelIds.length ?? 0) > 0);
  const modelIds = new Set(providers.flatMap((name) => blocks.get(name)?.modelIds ?? []));
  return { active: providers.length > 0, modelIds, keyCount: providers.length, providers };
}

// ── The keys ─────────────────────────────────────────────────────────────────

export interface ClaudeCreditsDeps {
  credentials?: OmpCredentialBridgeDeps;
  keys?: ClaudeCreditsBridgeDeps;
  /** Where the credits' requests go (tests only). */
  baseUrl?: string;
}

/** Mutations are serialised: the store, the key list and models.yml must agree. */
let queue: Promise<unknown> = Promise.resolve();
function serialised<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

/** The account text a saved key is paired with. */
function accountIdentity(row: OmpCredentialRow): string {
  return row.identity ?? `account-${row.id}`;
}

function activeClaudeAccounts(rows: readonly OmpCredentialRow[]): Array<{ row: OmpCredentialRow; position: number }> {
  // `position` numbers EVERY stored plan row, disabled ones included, exactly as
  // the Subscription card does (lib/omp/provider-login.ts), so "Primary" and
  // "Secondary" mean the same account in both places.
  return rows
    .filter((row) => row.provider === CLAUDE_PLAN_PROVIDER)
    .map((row, position) => ({ row, position }))
    .filter(({ row }) => row.type === "oauth" && row.disabledCause === null);
}

function fallbackSettings(): { fallbackEnabled: boolean; returnsToPlan: boolean } {
  try {
    const { retry } = readNativeSettings().settings;
    return {
      fallbackEnabled: retry?.enabled !== false && retry?.modelFallback !== false,
      returnsToPlan: retry?.fallbackRevertPolicy !== "never",
    };
  } catch {
    return { fallbackEnabled: true, returnsToPlan: true };
  }
}

/**
 * The Providers panel's view: each plan account with the masked key saved for
 * it, keys whose account is gone, and whether omp will actually switch.
 *
 * For an administrator it also heals the books — a store entry whose key omp
 * no longer holds is dropped, and the models.yml blocks follow the keys (one
 * for each provider that holds one). A plain read never writes.
 */
export async function readClaudeCreditsStatus(canEdit: boolean, deps: ClaudeCreditsDeps = {}): Promise<ClaudeCreditsStatus> {
  const settings = fallbackSettings();
  const read = async () => {
    const [snapshot, keyList] = await Promise.all([listOmpCredentials(deps.credentials), listClaudeApiKeys(deps.keys)]);
    const held = new Map(keyList.available ? keyList.keys.map((key) => [key.id, key] as const) : []);
    const stored = readClaudeCreditsStore();
    // A pairing follows the key it names: dropped when omp no longer holds the key, moved when it is under another provider.
    const kept = stored.flatMap((entry) => {
      const row = held.get(entry.keyId);
      return row ? [{ ...entry, provider: row.provider }] : [];
    });
    if (canEdit && keyList.available && snapshot.available) {
      if (JSON.stringify(kept) !== JSON.stringify(stored)) writeClaudeCreditsStore(kept);
      // Left alone when it cannot be fixed (an unreadable models.yml): the user hears about it when they act.
      try { syncClaudeCreditsProviders(keyList.keys.map((key) => key.provider), { baseUrl: deps.baseUrl }); } catch { /* see above */ }
    }
    return { snapshot, keyList, held, kept };
  };
  // An editor's read heals what it finds, so it joins the queue behind a save in flight: a key list
  // taken before that save finished must never prune the pairing the save has just written.
  const { snapshot, keyList, held, kept } = await (canEdit ? serialised(read) : read());
  if (!keyList.available) return { available: false, reason: keyList.reason, canEdit, accounts: [], strayKeys: [], ...settings };
  if (!snapshot.available) return { available: false, reason: snapshot.reason, canEdit, accounts: [], strayKeys: [], ...settings };

  const accounts: ClaudeCreditsAccount[] = activeClaudeAccounts(snapshot.credentials).map(({ row, position }) => {
    const entry = kept.find((candidate) => candidate.account === accountIdentity(row));
    return {
      accountId: String(row.id),
      label: row.identity ?? "Claude",
      position,
      key: entry ? { keyId: String(entry.keyId), last4: held.get(entry.keyId)?.last4 ?? "", addedAt: entry.addedAt } : null,
    };
  });
  const paired = new Set(accounts.flatMap((account) => (account.key ? [account.key.keyId] : [])));
  const strayKeys = keyList.keys
    .filter((key) => !paired.has(String(key.id)))
    .map((key) => {
      const entry = kept.find((candidate) => candidate.keyId === key.id);
      return { keyId: String(key.id), last4: key.last4, addedAt: entry?.addedAt ?? null, label: entry?.account ?? null };
    });
  return { available: true, canEdit, accounts, strayKeys, ...settings };
}

/** What an Anthropic API key looks like, and what is NOT one. Throws a ClaudeCreditsError. */
export function checkClaudeApiKeyShape(key: string): void {
  if (key.length < 20 || key.length > 512 || /[\s\x00-\x1f\x7f]/.test(key)) throw new ClaudeCreditsError("claude_credits_invalid_key", "That does not look like an Anthropic API key.");
  // `sk-ant-oat…` is the sign-in token of a plan — the very thing the plans already use.
  if (key.startsWith("sk-ant-oat")) throw new ClaudeCreditsError("claude_credits_login_token", "That is a Claude sign-in token, not an API key.");
  if (!key.startsWith("sk-ant-") || key.startsWith("sk-ant-admin") || key.startsWith("sk-ant-sid")) throw new ClaudeCreditsError("claude_credits_invalid_key", "That does not look like an Anthropic API key.");
}

/**
 * Make models.yml serve exactly the providers that hold a key, judging by what
 * omp holds right now. Never throws: the caller's own outcome matters more, and
 * the next status read heals whatever this could not.
 */
async function levelBlocks(deps: ClaudeCreditsDeps): Promise<void> {
  try {
    const held = await listClaudeApiKeys(deps.keys);
    if (held.available) syncClaudeCreditsProviders(held.keys.map((row) => row.provider), { baseUrl: deps.baseUrl });
  } catch {
    // See above.
  }
}

/** Save the API key for one plan account, replacing the one it had. */
export function saveClaudeApiKey(accountId: string, rawKey: string, deps: ClaudeCreditsDeps = {}): Promise<void> {
  const key = rawKey.trim();
  checkClaudeApiKeyShape(key);
  return serialised(async () => {
    const [snapshot, held] = await Promise.all([listOmpCredentials(deps.credentials), listClaudeApiKeys(deps.keys)]);
    if (!snapshot.available) throw new ClaudeCreditsError("claude_credits_unavailable", snapshot.reason ?? "OMP's accounts are unavailable.", 503);
    if (!held.available) throw new ClaudeCreditsError("claude_credits_unavailable", held.reason ?? "OMP's saved keys are unavailable.", 503);
    const account = activeClaudeAccounts(snapshot.credentials).find(({ row }) => String(row.id) === accountId)?.row;
    if (!account) throw new ClaudeCreditsError("claude_credits_unknown_account", "That Claude account is no longer signed in.", 404);
    const identity = accountIdentity(account);

    const stored = readClaudeCreditsStore();
    const previous = stored.find((entry) => entry.account === identity);
    // One key per provider. A replacement goes where the old key was; a new key takes the first free
    // provider, so the first account's credits are tried first.
    const taken = new Set(held.keys.map((row) => row.provider));
    const target = previous && taken.has(previous.provider) ? previous.provider : CLAUDE_CREDITS_PROVIDERS.find((name) => !taken.has(name));
    if (!target) throw new ClaudeCreditsError("claude_credits_unavailable", "Too many API keys are saved.", 409);

    // Models first: a key saved while omp cannot serve it would look done and do nothing.
    syncClaudeCreditsProviders([...taken, target], { baseUrl: deps.baseUrl });
    try {
      const added = await addClaudeApiKey(key, target, deps.keys);
      if (!added.ok) throw new ClaudeCreditsError("claude_credits_unavailable", added.message, 503);
      // A key omp already holds under another provider comes back as THAT row, so its owner is known.
      const owner = stored.find((entry) => entry.keyId === added.id);
      if (owner && owner.account !== identity) throw new ClaudeCreditsError("claude_credits_duplicate_key", "That key is already saved for another account.", 409);
      writeClaudeCreditsStore([
        ...stored.filter((entry) => entry.account !== identity && entry.keyId !== added.id),
        { keyId: added.id, provider: added.provider, account: identity, addedAt: owner?.addedAt ?? new Date().toISOString() },
      ]);
      // The old key goes only after the new one is safely in: there is never a moment with neither.
      if (previous && previous.keyId !== added.id) await removeOmpCredential(previous.provider, previous.keyId, deps.credentials);
    } finally {
      // A provider that ended up holding no key (a failed or duplicate save) loses its block again.
      await levelBlocks(deps);
    }
  });
}

/** Forget one saved key (and its provider's models.yml block with it). */
export function removeClaudeApiKey(keyId: string, deps: ClaudeCreditsDeps = {}): Promise<void> {
  const id = Number(keyId);
  return serialised(async () => {
    if (!Number.isSafeInteger(id)) throw new ClaudeCreditsError("claude_credits_unknown_account", "That key is no longer saved.", 404);
    const held = await listClaudeApiKeys(deps.keys);
    if (!held.available) throw new ClaudeCreditsError("claude_credits_unavailable", held.reason ?? "OMP's saved keys are unavailable.", 503);
    const row = held.keys.find((candidate) => candidate.id === id);
    // A key omp no longer holds (a second tab, a double click) is already what was asked for: only the books are tidied.
    if (row) {
      const outcome = await removeOmpCredential(row.provider, id, deps.credentials);
      if (outcome.code) throw new ClaudeCreditsError("claude_credits_unavailable", outcome.message ?? "The key could not be removed.", 503);
    }
    writeClaudeCreditsStore(readClaudeCreditsStore().filter((entry) => entry.keyId !== id));
    await levelBlocks(deps);
  });
}

/** The error shape every caller reports. */
export function describeClaudeCreditsError(error: unknown): { message: string; code?: string; status: number } {
  if (error instanceof ClaudeCreditsError) return { message: error.message, code: error.code, status: error.status };
  return { message: "The Claude API key could not be saved.", status: 500 };
}
