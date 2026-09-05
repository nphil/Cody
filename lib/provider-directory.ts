/**
 * The Providers hub's one list, joined from four sources that each know a
 * different part of the truth about "how does this engine reach a vendor":
 *
 *   - the engine's OWN sign-in roster (`providerLogins.list()`): which
 *     subscriptions and OAuth accounts it can log in to, and which it has;
 *   - Cody's key store (`describeProviders`): which API-key variables are
 *     saved here or set on the container — flags only, never values;
 *   - the effective model catalog: how many models each provider id
 *     currently serves, which is the only evidence that a key WORKS;
 *   - the engine's own registry (`HarnessAdapter.providerDirectory`): custom
 *     endpoints in its model config, plus disabled / ordered / locked state.
 *
 * `PROVIDER_CATALOG.loginIds` and `catalogIds` are the join keys: omp's
 * `anthropic` OAuth entry, `ANTHROPIC_API_KEY` and the `anthropic` models
 * are one row with two methods, not three rows. Anything the join cannot
 * place is still listed (the roster is the engine's), just under "Other".
 *
 * Pure: no I/O, no engine import, so the same function answers the route,
 * the unit test over the checked-in roster fixture, and — through its
 * exported types — the client.
 */
import { groupForRow, POPULAR_ORDER, popularityRank, PROVIDER_VARIANTS, SUBSCRIPTION_IDS, type ProviderGroup } from "@/components/settings/providers/provider-groups";
import type { ProviderDefinition } from "@/lib/harness/provider-catalog";
import type { ProviderDirectoryInfo, ProviderLoginOption } from "@/lib/harness/types";

export type ProviderMethodKind = "oauth" | "device" | "key" | "env" | "custom";
export type ProviderMethodState = "connected" | "available" | "unset";

export interface ProviderMethodVariable {
  name: string;
  label: string;
  secret: boolean;
  hint?: string;
  /** Saved through Cody (wins over the container's value). */
  stored: boolean;
  /** Present in the server's own environment. */
  fromEnvironment: boolean;
  optional?: boolean;
}

export interface ProviderMethod {
  /** `oauth` / `device`: the engine's own sign-in. `key`: a variable saved
   * in Cody. `env`: the same variable set on the container (no Cody value
   * over it). `custom`: an endpoint declared in the engine's model config. */
  kind: ProviderMethodKind;
  /** `available` is a sign-in the engine offers but has not completed;
   * `unset` is a key with nothing behind it. */
  state: ProviderMethodState;
  /** The engine's own id for a sign-in method, for `/api/auth/login/<id>`. */
  loginId?: string;
  /** The engine's own name for the sign-in — the label of a variant select
   * when a row carries several. */
  name?: string;
  canLogout?: boolean;
  hint?: string;
  /** The key method's variables; `key` and `env` carry the same list. */
  variables?: ProviderMethodVariable[];
  /** The one method the row's status line describes: the highest-precedence
   * connected method (signed in › key saved in Cody › key from the
   * container › custom endpoint), or the first method when none is. */
  winning: boolean;
}

export interface ProviderRow {
  /** Row id: the key-catalogue id when the row is joined from it, else the
   * engine's own roster id or the custom endpoint's name. */
  id: string;
  name: string;
  /** Provider id to draw the brand mark from (`providerBrand`). */
  brand: string;
  group: ProviderGroup;
  methods: ProviderMethod[];
  connected: boolean;
  /** Models this row currently serves; `null` when unknown (an ACP engine
   * keeps models in the session; a spawn failed; the cached read had no
   * catalog yet — see `pending` and `reason`). */
  modelCount: number | null;
  /** The count (or roster) has not been read yet: a cached answer. */
  pending?: boolean;
  /** Why `modelCount` is null, in the engine's own words. */
  reason?: string;
  /** Switched off in the engine's own config (omp `disabledProviders`). */
  disabled?: boolean;
  /** Position in the engine's provider preference order, when listed. */
  order?: number;
  /** A regional / plan variant of another row (collapsed in the picker). */
  variantOf?: string;
  popular?: boolean;
  /** The model-catalog provider ids this row sums its count over: the
   * definition's own id, its `catalogIds`, AND every engine's login id for
   * the vendor (the join key that folds a subscription and its API key into
   * one row) — curation reads across all of them. */
  catalogIds: string[];
  /** The ids that are genuinely the engine's OWN provider ids — never an
   * engine's login/session id (`claude`, `anthropic-console`, `chatgpt`,
   * `openai-codex-device`, ...), which name a DIFFERENT engine's sign-in
   * roster, not an omp model-provider. Config keys that name providers
   * (`modelProviderOrder`, `disabledProviders`) must be written from this
   * list, never from `catalogIds`; a row with none (a login-only entry the
   * catalogue never claimed) is skipped by those writes. */
  orderIds: string[];
  /** A custom endpoint's facts, for the row's status line. */
  endpoint?: { api?: string; baseUrl?: string };
}

export interface ProvidersResponse {
  engine: { id: string; shortName: string };
  /** The caller is an administrator: sign-ins, keys and removal are theirs. */
  canEdit: boolean;
  /** `POST /api/providers/verify` will answer for this engine (it has a
   * sessionless catalog to read); hidden otherwise. */
  canVerify: boolean;
  /** `readonly` when the engine's registry holds entries Cody must not
   * rewrite; the hub then shows the reason and disables curation, removal
   * and reordering. */
  instanceSource: "writable" | "readonly";
  readonlyReason?: string;
  /** Some rows are still waiting on a read the cached answer skipped. */
  pending?: boolean;
  providers: ProviderRow[];
}

/** The key store's per-provider status, structurally (values never appear). */
export interface DirectoryKeyProvider {
  id: string;
  name: string;
  variables: ReadonlyArray<{ name: string; label: string; secret: boolean; hint?: string; stored: boolean; fromEnvironment: boolean }>;
}

export interface BuildProviderDirectoryInput {
  /** The engine's sign-in roster; null when the engine has none or the
   * cached read did not have it yet. */
  logins: readonly ProviderLoginOption[] | null;
  keys: readonly DirectoryKeyProvider[];
  /** Model counts per catalog provider id; null when unknown. */
  counts: Readonly<Record<string, number>> | null;
  /** Why `counts` is null. */
  countsReason?: string;
  directory: ProviderDirectoryInfo | null;
  /** The key catalogue for this engine (`providersForEngine`). */
  catalog: readonly ProviderDefinition[];
  /** Which inputs a cached answer left unread. */
  pending?: { counts?: boolean; logins?: boolean };
}

const METHOD_PRECEDENCE: readonly ProviderMethodKind[] = ["oauth", "device", "key", "env", "custom"];

/**
 * A sign-in wins over a key only when it is a real subscription. omp's
 * roster lists its API-key vendors too (its /login prompts for the key), and
 * reports one "authenticated" whenever the vendor resolves a credential —
 * including the key Cody just handed the child through the environment. A
 * row whose only sign-in is such an entry describes itself by the key.
 */
export function isSubscriptionLogin(method: ProviderMethod): boolean {
  return (method.kind === "oauth" || method.kind === "device") && method.loginId !== undefined && SUBSCRIPTION_IDS.has(method.loginId);
}

function precedenceOf(method: ProviderMethod): number {
  if (method.kind === "oauth" || method.kind === "device") return isSubscriptionLogin(method) ? 0 : 3;
  if (method.kind === "key") return 1;
  if (method.kind === "env") return 2;
  return 4;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function loginMethod(login: ProviderLoginOption): ProviderMethod {
  return {
    kind: login.kind,
    state: login.authenticated ? "connected" : "available",
    loginId: login.id,
    name: login.name,
    canLogout: login.canLogout,
    ...(login.hint ? { hint: login.hint } : {}),
    winning: false,
  };
}

/** One method for the whole variable set: its kind says which source is in
 * force (a Cody value beats the container's), its state whether every
 * required variable is present somewhere. */
function keyMethod(definition: ProviderDefinition | undefined, stored: DirectoryKeyProvider): ProviderMethod {
  const optionalNames = new Set((definition?.variables ?? []).filter((variable) => variable.optional).map((variable) => variable.name));
  const variables: ProviderMethodVariable[] = stored.variables.map((variable) => ({
    name: variable.name,
    label: variable.label,
    secret: variable.secret,
    ...(variable.hint ? { hint: variable.hint } : {}),
    stored: variable.stored,
    fromEnvironment: variable.fromEnvironment,
    ...(optionalNames.has(variable.name) ? { optional: true } : {}),
  }));
  const anyStored = variables.some((variable) => variable.stored);
  const anyEnv = variables.some((variable) => variable.fromEnvironment);
  const required = variables.filter((variable) => !variable.optional);
  const complete = required.length > 0 && required.every((variable) => variable.stored || variable.fromEnvironment);
  return {
    kind: anyStored || !anyEnv ? "key" : "env",
    state: complete ? "connected" : "unset",
    variables,
    winning: false,
  };
}

function sumCounts(counts: Readonly<Record<string, number>> | null, ids: readonly string[]): number | null {
  if (!counts) return null;
  let total = 0;
  for (const id of ids) total += counts[id] ?? 0;
  return total;
}

function orderOf(order: readonly string[], ids: readonly string[]): number | undefined {
  let best: number | undefined;
  for (const id of ids) {
    const index = order.indexOf(id);
    if (index !== -1 && (best === undefined || index < best)) best = index;
  }
  return best;
}

function finish(row: ProviderRow, input: BuildProviderDirectoryInput, awaitsLogins: boolean): ProviderRow {
  const directory = input.directory;
  const disabled = directory ? row.catalogIds.some((id) => directory.disabledProviders.includes(id)) : false;
  const order = directory ? orderOf(directory.providerOrder, row.catalogIds) : undefined;
  const winner = [...row.methods]
    .filter((method) => method.state === "connected")
    .sort((a, b) => precedenceOf(a) - precedenceOf(b))[0] ?? row.methods[0];
  for (const method of row.methods) method.winning = method === winner;
  const connected = row.methods.some((method) => method.state === "connected") || (row.modelCount ?? 0) > 0;
  const pending = Boolean(input.pending?.counts && row.modelCount === null) || Boolean(awaitsLogins && input.pending?.logins && input.logins === null);
  return {
    ...row,
    connected,
    ...(pending ? { pending: true } : {}),
    ...(row.modelCount === null && input.countsReason ? { reason: input.countsReason } : {}),
    ...(disabled ? { disabled: true } : {}),
    ...(order !== undefined ? { order } : {}),
    ...(POPULAR_ORDER.includes(row.id) ? { popular: true } : {}),
  };
}

export function buildProviderDirectory(input: BuildProviderDirectoryInput): ProviderRow[] {
  const logins = input.logins ?? [];
  const loginById = new Map(logins.map((login) => [login.id, login]));
  const keyById = new Map(input.keys.map((key) => [key.id, key]));
  const consumedLogins = new Set<string>();
  const rows: ProviderRow[] = [];
  const rowById = new Map<string, ProviderRow>();
  // Rows that could still gain a sign-in method once the roster is read; a
  // custom endpoint or a count-only row never does, so an unread roster
  // does not make them pending.
  const awaitingLogins = new Set<string>();

  const push = (row: ProviderRow) => {
    rows.push(row);
    rowById.set(row.id, row);
  };

  // 1. The key catalogue: one row per definition this engine reads, with its
  //    sign-in methods folded in through `loginIds`.
  for (const definition of input.catalog) {
    const loginIds = definition.loginIds ?? [];
    const matched = loginIds.map((id) => loginById.get(id)).filter((login): login is ProviderLoginOption => login !== undefined);
    for (const login of matched) consumedLogins.add(login.id);
    const methods: ProviderMethod[] = matched.map(loginMethod);
    const stored = keyById.get(definition.id);
    if (stored) methods.push(keyMethod(definition, stored));
    const catalogIds = unique([definition.id, ...(definition.catalogIds ?? []), ...loginIds]);
    const orderIds = unique([definition.id, ...(definition.catalogIds ?? [])]);
    awaitingLogins.add(definition.id);
    push({
      id: definition.id,
      name: definition.name,
      brand: definition.id,
      group: groupForRow({ id: definition.id, loginIds: matched.map((login) => login.id) }),
      methods,
      connected: false,
      modelCount: sumCounts(input.counts, catalogIds),
      catalogIds,
      orderIds,
    });
  }

  // 2. Every roster entry the catalogue did not claim: the engine's own row.
  for (const login of logins) {
    if (consumedLogins.has(login.id)) continue;
    push({
      id: login.id,
      name: login.name,
      brand: login.id,
      group: groupForRow({ id: login.id, loginIds: [login.id] }),
      methods: [loginMethod(login)],
      connected: false,
      modelCount: sumCounts(input.counts, [login.id]),
      catalogIds: [login.id],
      // A pure sign-in the key catalogue never claimed has no confirmed
      // model-provider identity — never write its id into a provider list.
      orderIds: [],
    });
  }
  // Variants fold into a card only when the card itself is a row here; a
  // variant whose canonical id was absorbed by the catalogue (or is not in
  // this engine's roster) stays a row of its own.
  for (const row of rows) {
    const canonical = PROVIDER_VARIANTS[row.id];
    if (canonical && rowById.has(canonical) && canonical !== row.id) row.variantOf = canonical;
  }

  // 3. Custom endpoints from the engine's model config. A name that collides
  //    with an existing row (someone declared a models.yml provider called
  //    "openai") becomes a method on that row rather than a duplicate.
  for (const custom of input.directory?.modelsYmlProviders ?? []) {
    const endpoint = { ...(custom.api ? { api: custom.api } : {}), ...(custom.baseUrl ? { baseUrl: custom.baseUrl } : {}) };
    const method: ProviderMethod = { kind: "custom", state: "connected", ...(custom.baseUrl ? { hint: custom.baseUrl } : {}), winning: false };
    const existing = rowById.get(custom.name);
    if (existing) {
      existing.methods.push(method);
      existing.endpoint = endpoint;
      existing.group = "custom";
      if (existing.modelCount === null) existing.modelCount = custom.modelCount;
      continue;
    }
    // The file lists its models explicitly, so the count is known even when
    // the catalog has not been read: a custom row is never "pending".
    const live = input.counts ? input.counts[custom.name] : undefined;
    push({
      id: custom.name,
      name: custom.name,
      brand: custom.name,
      group: "custom",
      methods: [method],
      connected: true,
      modelCount: live ?? custom.modelCount,
      catalogIds: [custom.name],
      orderIds: [custom.name],
      endpoint,
    });
  }

  // 4. Catalog provider ids that serve models but belong to no row: the
  //    engine resolved a credential Cody knows nothing about. Listed, not
  //    hidden — 5 Bedrock Mantle models are 5 models the composer offers.
  if (input.counts) {
    const claimed = new Set(rows.flatMap((row) => row.catalogIds));
    for (const [id, count] of Object.entries(input.counts)) {
      if (claimed.has(id) || count <= 0) continue;
      push({
        id,
        name: id,
        brand: id,
        group: groupForRow({ id }),
        methods: [],
        connected: true,
        modelCount: count,
        catalogIds: [id],
        // Its id came straight out of the model catalog's own counts, so it
        // is by construction a real provider id.
        orderIds: [id],
      });
    }
  }

  return rows.map((row) => finish(row, input, awaitingLogins.has(row.id)));
}

/** Rows the Connected section shows, status-first: signed in, key saved in
 * Cody, key from the container, then local / custom; popular vendors before
 * the rest within a status, then by name. When the engine keeps a provider
 * order, listed rows come first in that order. */
export function sortConnectedRows(rows: readonly ProviderRow[]): ProviderRow[] {
  const rank = (row: ProviderRow): number => {
    const winner = row.methods.find((method) => method.winning);
    if (!winner || winner.state !== "connected") return METHOD_PRECEDENCE.length;
    return precedenceOf(winner);
  };
  return [...rows]
    .filter((row) => row.connected)
    .sort((a, b) => {
      const ao = a.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      const ar = rank(a);
      const br = rank(b);
      if (ar !== br) return ar - br;
      const ap = popularityRank(a.id);
      const bp = popularityRank(b.id);
      if (ap !== bp) return ap - bp;
      return a.name.localeCompare(b.name);
    });
}

/** The group's rows for the Add picker: not yet connected, variants folded
 * under their card, popular first, then by name. */
export function pickerRowsForGroup(rows: readonly ProviderRow[], group: ProviderGroup): Array<{ row: ProviderRow; variants: ProviderRow[] }> {
  const candidates = rows.filter((row) => !row.connected && row.group === group);
  const cards = candidates.filter((row) => !row.variantOf || !candidates.some((other) => other.id === row.variantOf));
  return cards
    .map((row) => ({ row, variants: candidates.filter((other) => other.variantOf === row.id) }))
    .sort((a, b) => {
      const ap = popularityRank(a.row.id);
      const bp = popularityRank(b.row.id);
      if (ap !== bp) return ap - bp;
      return a.row.name.localeCompare(b.row.name);
    });
}
