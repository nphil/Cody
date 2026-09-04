/**
 * The Behavior hub's Recommended layer, as data.
 *
 * One page, two layers, ONE key space: every card here is a dotted config
 * path the engine's own settings file understands, and the same key also
 * appears in "All settings" below (with an "Also under Recommended" chip),
 * so a value can never live in two places. A card carries NO label or
 * description of its own — those come from the engine's schema at render
 * time — only a key, a group, an optional control hint and an optional
 * Cody-side hint sentence. The eight keys omp declares without `ui`
 * metadata (config-file only upstream) get their copy from
 * `CURATED_ONLY` instead, which is the one hand-written table in this hub.
 *
 * Membership is pinned by components/recommended-cards.test.mjs against the
 * installed omp schema AND the checked-in key snapshot
 * (lib/harness/fixtures/omp-schema-keys.json): 24 schema-declared, 8
 * curated-only, 32 in all across the three card lists.
 *
 *   - RECOMMENDED_CARDS render here, in five groups.
 *   - MCP_CARDS are the same bound cards rendered by Extensions › MCP.
 *   - RETRY_CARDS belong to Models › Assignments (the retry panel hosts
 *     `retry.enabled`); they are listed so the key space stays whole and the
 *     round-trip test covers every curated key.
 */
import type { SearchEntry } from "../search-index";

export type RecommendedControl = "select" | "toggle" | "number" | "methodOrder";

export type RecommendedGroupId = "safety" | "thinking" | "advisor" | "context" | "memory";

/** Where a bound card renders: the Behavior hub's Recommended groups, the
 * Extensions › MCP segment, or the retry panel under Models › Assignments. */
export type CardGroupId = RecommendedGroupId | "mcp" | "retry";

export interface RecommendedGroup {
  id: RecommendedGroupId;
  label: string;
  description: string;
}

export interface RecommendedCard {
  /** Dotted config path, the same one the schema list shows. */
  key: string;
  group: CardGroupId;
  /** Only needed where the schema's type does not decide the control on its
   * own: `methodOrder` swaps the generic list editor for the ordered
   * compaction-method editor. The others document intent and match what the
   * schema type already yields. */
  control?: RecommendedControl;
  /** One Cody-side sentence under the engine's description — what this
   * setting means INSIDE Cody, never a restatement of the engine's copy. */
  hint?: string;
}

export const RECOMMENDED_GROUPS: readonly RecommendedGroup[] = [
  { id: "safety", label: "Safety & approvals", description: "When the engine asks before running a tool, and the overrides for terminal commands and extension requests." },
  { id: "thinking", label: "Thinking & style", description: "Default reasoning effort, response verbosity, personality and how thinking is shown." },
  { id: "advisor", label: "Advisor", description: "A second model passively reviews each turn and leaves guidance notes." },
  { id: "context", label: "Context", description: "How a long session is kept inside the model's context window." },
  { id: "memory", label: "Memory & learning", description: "Durable memory across sessions and automatic lesson capture." },
];

export const RECOMMENDED_CARDS: readonly RecommendedCard[] = [
  // Safety & approvals (3)
  { key: "tools.approvalMode", group: "safety", control: "select" },
  { key: "tools.approval.bash", group: "safety", control: "select" },
  { key: "tools.approval.extension", group: "safety", control: "select" },
  // Thinking & style (5)
  { key: "defaultThinkingLevel", group: "thinking", control: "select" },
  { key: "textVerbosity", group: "thinking", control: "select" },
  { key: "personality", group: "thinking", control: "select" },
  { key: "hideThinkingBlock", group: "thinking", control: "toggle", hint: "Cody draws its own thinking blocks; use Expand thinking blocks under Preferences for the browser." },
  { key: "externalThinking", group: "thinking", control: "toggle" },
  // Advisor (4)
  { key: "advisor.enabled", group: "advisor", control: "toggle", hint: "Also sets the default for new sessions in this browser." },
  { key: "advisor.syncBacklog", group: "advisor", control: "select" },
  { key: "advisor.immuneTurns", group: "advisor", control: "select" },
  { key: "advisor.subagents", group: "advisor", control: "toggle" },
  // Context (5)
  { key: "compaction.enabled", group: "context", control: "toggle" },
  { key: "compaction.midTurnEnabled", group: "context", control: "toggle" },
  { key: "compaction.methodOrder", group: "context", control: "methodOrder" },
  { key: "compaction.autoContinue", group: "context", control: "toggle" },
  { key: "compaction.keepRecentTokens", group: "context", control: "number" },
  // Memory & learning (8)
  { key: "memory.backend", group: "memory", control: "select" },
  { key: "autolearn.enabled", group: "memory", control: "toggle" },
  { key: "autolearn.autoContinue", group: "memory", control: "toggle" },
  { key: "autolearn.minToolCalls", group: "memory", control: "number" },
  { key: "mnemopi.scoping", group: "memory", control: "select" },
  { key: "mnemopi.autoRecall", group: "memory", control: "toggle" },
  { key: "mnemopi.autoRetain", group: "memory", control: "toggle" },
  { key: "mnemopi.noEmbeddings", group: "memory", control: "toggle" },
];

/** The four MCP keys, rendered by Extensions › MCP as the same bound cards
 * (resolve each with `useSchemaIndex().byKey`, write with `setValue`). */
export const MCP_CARDS: readonly RecommendedCard[] = [
  { key: "mcp.enableProjectConfig", group: "mcp", control: "toggle" },
  { key: "mcp.renderMarkdownResults", group: "mcp", control: "toggle" },
  { key: "mcp.notifications", group: "mcp", control: "toggle" },
  { key: "mcp.notificationDebounceMs", group: "mcp", control: "number" },
];

/** Retry lives under Models › Assignments (the retry panel), never here. */
export const RETRY_CARDS: readonly RecommendedCard[] = [
  { key: "retry.enabled", group: "retry", control: "toggle" },
  { key: "retry.maxRetries", group: "retry", control: "select" },
  { key: "retry.modelFallback", group: "retry", control: "toggle" },
];

/** Every bound card across the three surfaces — the whole curated key space. */
export const ALL_CURATED_CARDS: readonly RecommendedCard[] = [...RECOMMENDED_CARDS, ...MCP_CARDS, ...RETRY_CARDS];

export interface CuratedOption {
  value: string;
  label: string;
}

/**
 * Copy and shape for the keys omp declares WITHOUT `ui` metadata. The
 * schema route cannot serve these (they are config-file only upstream), so
 * they read from `/api/omp-settings` and write through the section-spread
 * writer. `section` is the config.yml object the field sits in (null = a
 * top-level key); `condition` names the same predicate the schema uses for
 * the row's neighbours, so the card hides exactly when they do.
 */
export interface CuratedOnlySetting {
  key: string;
  label: string;
  description: string;
  section: "tools.approval" | "advisor" | "compaction" | "autolearn" | "retry" | null;
  field: string;
  type: "boolean" | "enum" | "number";
  options?: readonly CuratedOption[];
  default: boolean | number | string;
  condition?: string;
  min?: number;
  max?: number;
  step?: number;
}

export const CURATED_ONLY: readonly CuratedOnlySetting[] = [
  {
    key: "tools.approval.bash",
    label: "Bash Override",
    description: "Override the default approval policy specifically for terminal commands.",
    section: "tools.approval",
    field: "bash",
    type: "enum",
    options: [{ value: "allow", label: "Allow" }, { value: "prompt", label: "Always ask" }, { value: "deny", label: "Deny" }],
    default: "prompt",
  },
  {
    key: "tools.approval.extension",
    label: "Extension Tool Requests",
    description: "Automatically approve extension tool authorization requests.",
    section: "tools.approval",
    field: "extension",
    type: "enum",
    options: [{ value: "prompt", label: "Ask every time" }, { value: "allow", label: "Auto approve" }],
    default: "prompt",
  },
  {
    key: "defaultThinkingLevel",
    label: "Reasoning",
    description: "Default effort level for thinking-capable models.",
    section: null,
    field: "defaultThinkingLevel",
    type: "enum",
    options: ["auto", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => ({ value: level, label: level })),
    default: "high",
  },
  {
    key: "advisor.subagents",
    label: "Review Subagents",
    description: "Apply Advisor passive review to subagent tasks. Newer engines store this per agent (task.agentAdvisor), so a value set from a terminal may not show here.",
    section: "advisor",
    field: "subagents",
    type: "boolean",
    default: false,
    condition: "advisorEnabled",
  },
  {
    key: "compaction.autoContinue",
    label: "Continue After Compaction",
    description: "Resume task execution after compaction completes.",
    section: "compaction",
    field: "autoContinue",
    type: "boolean",
    default: true,
  },
  {
    key: "compaction.keepRecentTokens",
    label: "Recent Tokens Kept",
    description: "How many tokens of the most recent context survive a compaction verbatim.",
    section: "compaction",
    field: "keepRecentTokens",
    type: "number",
    default: 20000,
    min: 1000,
    max: 1000000,
    step: 1000,
  },
  {
    key: "autolearn.minToolCalls",
    label: "Minimum Tool Calls",
    description: "Only capture lessons from runs that made at least this many tool calls.",
    section: "autolearn",
    field: "minToolCalls",
    type: "number",
    default: 5,
    min: 0,
    max: 100,
    step: 1,
    condition: "autolearnActive",
  },
  {
    key: "retry.enabled",
    label: "Automatic Retry",
    description: "Retry failed turns automatically.",
    section: "retry",
    field: "enabled",
    type: "boolean",
    default: true,
  },
];

const CURATED_ONLY_BY_KEY: ReadonlyMap<string, CuratedOnlySetting> = new Map(CURATED_ONLY.map((entry) => [entry.key, entry]));

export function curatedOnly(key: string): CuratedOnlySetting | undefined {
  return CURATED_ONLY_BY_KEY.get(key);
}

export const CURATED_ONLY_KEYS: readonly string[] = CURATED_ONLY.map((entry) => entry.key);

export type CardSurface = "recommended" | "mcp" | "retry";

export interface CardOwner {
  surface: CardSurface;
  card: RecommendedCard;
  group: RecommendedGroup | null;
}

const OWNER_BY_KEY: ReadonlyMap<string, CardOwner> = new Map(ALL_CURATED_CARDS.map((card) => {
  const surface: CardSurface = card.group === "mcp" ? "mcp" : card.group === "retry" ? "retry" : "recommended";
  const group = RECOMMENDED_GROUPS.find((entry) => entry.id === card.group) ?? null;
  return [card.key, { surface, card, group }];
}));

/** Which curated surface owns a key, so the schema list can chip the row
 * ("Also under Recommended ↑" / "Also under Extensions › MCP") and search
 * can prefer the card. Null for the rows nothing curates. */
export function cardOwner(key: string): CardOwner | null {
  return OWNER_BY_KEY.get(key) ?? null;
}

/** Label of the chip a card-owned schema row wears. */
export const ALSO_UNDER: Record<CardSurface, string> = {
  recommended: "Also under Recommended ↑",
  mcp: "Also under Extensions › MCP",
  retry: "Also under Models › Assignments",
};

/**
 * Whether the surface that renders a key's card exists on this engine: the
 * Behavior hub's Recommended layer needs the config editor, Extensions › MCP
 * needs MCP on top, the retry panel sits under Models. When it does not,
 * the schema row is the key's only home and wears no "Also under" chip.
 */
export function cardSurfaceAvailable(surface: CardSurface, capabilities: { configEditor: boolean; mcp: boolean; models: boolean }): boolean {
  if (!capabilities.configEditor) return false;
  if (surface === "mcp") return capabilities.mcp;
  if (surface === "retry") return capabilities.models;
  return true;
}

/**
 * `data-search-id` for the one key space, per the dialog search's jump
 * contract: `schema-<key>`. A bound card and the schema row share the key;
 * when both render in the same dialog the CARD takes the id (a search jump
 * lands on it) and the row beside it takes `schema-<key>-row`, reachable
 * through the row's "Also under" chip. On an engine without the card the
 * row keeps `schema-<key>`.
 */
export function searchIdForKey(key: string): string {
  return `schema-${key}`;
}

export function rowSearchIdBesideCard(key: string): string {
  return `schema-${key}-row`;
}

/** The save corner both layers of the Behavior hub report to. */
export const ENGINE_PANEL_ID = "engine";

export function groupLabelOf(id: CardGroupId): string {
  if (id === "mcp") return "MCP";
  if (id === "retry") return "Retry";
  return RECOMMENDED_GROUPS.find((entry) => entry.id === id)?.label ?? id;
}

/**
 * The static search entries this hub can promise: the curated-only cards
 * rendered here, whose labels ARE constants. Schema-backed cards take their
 * labels from the engine at render time, so their entries are the dynamic
 * schema rows (`schema-<key>`), which jump to the card wherever one renders;
 * `cardOwner(key)` tells the collector which of those to trail as
 * Recommended › group instead of tab › group.
 */
export const SEARCH_ENTRIES: readonly SearchEntry[] = RECOMMENDED_CARDS
  .flatMap((card) => {
    const meta = curatedOnly(card.key);
    if (!meta) return [];
    return [{
      id: searchIdForKey(card.key),
      tab: "engine" as const,
      label: meta.label,
      description: meta.description,
      keywords: [card.key],
      breadcrumb: ["{engine}", "Behavior", "Recommended", groupLabelOf(card.group)],
      needsCapability: "configEditor" as const,
      action: "jump" as const,
    }];
  });
