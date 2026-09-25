import { randomBytes } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  deriveChains,
  providerOf,
  resolveRosterModel,
} from "../model-plan/derive";
import { extractJsonObject, ROLE_BRIEF_LINES } from "../model-plan/planner";
import { OMP_BIN_MISSING, resolveOmpBin } from "../omp/omp-cli";
import { getAgentDir } from "../omp/paths";
import {
  runOneShotModelStreaming,
  type ToolEndEvent,
  type ToolStartEvent,
} from "../model-plan/one-shot";
import type { Roster, RosterModel } from "../model-plan/roster";
import { isRecord } from "../type-guards";
import { presetRoleNames } from "./store";
import type {
  ModelEvidence,
  PresetProposal,
  PresetRationale,
  ResearchProgressItem,
  ResearchResult,
  ResearchRunSnapshot,
  ResearchSource,
  ResearchSourceKind,
} from "./types";

/**
 * The web-research planner: a user-chosen strong model does real, cited web
 * research (benchmarks, independent reviews, forum/reddit threads, social
 * media, vendor claims) instead of relying on its own training data, and
 * proposes role assignments for one or more presets. The run itself (spawning
 * omp, reading its NDJSON stream) is lib/model-plan/one-shot.ts; this module
 * owns the prompt, the untrusted-content isolation, answer validation, and
 * the run registry behind POST/GET/DELETE /api/model-presets/research.
 *
 * ── Security: an untrusted-content-reading child with the user's own credentials ──
 *
 * The planner spends most of its turn reading whatever the open web hands it
 * back, then writes model selectors into config Cody applies unattended. That
 * is prompt-injection surface: a hostile page can try to make the model call
 * whatever tools it can see. What that child may DO about it has to be fixed
 * independently of the prompt, not asked of the model politely.
 *
 * Investigated first (omp 18.2.11, `/data/agent/tools/lib/node_modules/@oh-my-pi/pi-coding-agent/src`):
 *   - There is no supported way to confine omp's `read` tool to URLs only. It
 *     is one unified tool for local paths, internal URIs (memory://, xd://,
 *     ssh://…) AND remote URLs (tools/read.ts, tools/fetch.ts); the settings
 *     schema (config/settings-schema.ts) and CLI flags (cli/args.ts,
 *     cli/flag-tables.ts) have nothing resembling a `read.allowedRoots` or
 *     `read.urlOnly` gate. `read` is therefore excluded entirely: this run
 *     never requests it, at all, in `--tools=`.
 *   - `--tools=<csv>` (cli/flag-tables.ts) IS a real allow-list, but for
 *     BUILT-IN tools only: `createTools()` (tools/index.ts) filters exactly
 *     `{...BUILTIN_TOOLS, ...HIDDEN_TOOLS}` against it. Tools contributed by
 *     configured MCP servers attach through a completely separate path
 *     (`mcpManagerToolNames` in session/session-tools.ts) that ignores the
 *     built-in allow-list and activates unconditionally. Verified empirically
 *     on this install: `omp -p --mode=json --tools=web_search
 *     --model=openai-codex/gpt-6-luna` — asked to read /etc/hostname — still
 *     offered and CALLED `mcp__ha_mcp_ha_read_file` (a user-level MCP server
 *     configured for this instance), even though only `web_search` was in
 *     `--tools=`. So `--tools=web_search` alone is NOT sufficient here: on any
 *     install with MCP servers configured (file access, home-automation
 *     control, container/DNS/firewall management — see this project's own MCP
 *     roster), the untrusted child would still reach them.
 *   - omp's user-level MCP config is read from `<agent dir>/mcp.json`
 *     (lib/omp/mcp-config.ts `getUserMcpPath`), and project-level config is
 *     discovered by walking up from the spawn cwd. Both are therefore fully
 *     controlled by `PI_CODING_AGENT_DIR` + `cwd`. Credentials (OAuth for
 *     subscriptions, API keys) live in `<agent dir>/agent.db`
 *     ("Default: local SQLite store at `<agentDir>/agent.db`", sdk.ts) — a
 *     SEPARATE file in the same directory — so isolating the whole agent dir
 *     would also throw away the user's login.
 *
 * Final design: run the child from (a) a fresh, single-use temp cwd (no
 * project `.mcp.json`) and (b) `PI_CODING_AGENT_DIR` pointed at a fresh,
 * single-use temp directory whose `mcp.json` is explicitly empty and which
 * SYMLINKS only `agent.db` (credentials), `models.yml` (providers and custom
 * endpoints) and `config.yml` (the user's web-search provider settings) to
 * the real files — no skills, rules or extensions — plus
 * `--tools=web_search` (never `read`, never `bash`, never anything else).
 * The same layout the sidebar chat uses (lib/rpc-manager.ts sidebarAgentDir,
 * measured there: no MCP tool reaches the child with config.yml linked).
 *
 * Linked, never copied: omp refreshes OAuth tokens as it uses them and a
 * provider may ROTATE the refresh token on refresh. A refresh written into a
 * copy would leave the real store holding a refresh token the provider has
 * already invalidated — signing the user out of that account. SQLite puts
 * `-wal`/`-shm` beside the symlink target, so the live database is shared
 * exactly as it is between any two omp processes. Both temp directories are
 * deleted the moment the child exits, success or failure.
 *
 * Verified with the isolation in place and an adversarial prompt: the child's
 * only tool was `web_search` (no MCP tool at all), and web_search still
 * returned live, cited results through the codex-grounded backend on the
 * user's own credentials. `--no-skills --no-rules --no-extensions
 * --no-session --no-title --no-prewalk` (one-shot.ts's flags and overlay)
 * apply on top as defense in depth.
 */

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface PresetBrief {
  id: string;
  name: string;
  intent: string;
}

/** Roles the research planner may assign: `store.ts`'s own live chat-role
 * list (omp's role vocabulary minus NON_CHAT_ROLES) — the same set a preset
 * can actually store, so a role such as `memory` (absent from
 * lib/model-plan/derive.ts's fixed ROLE_NAMES) is still offered. */

const MEMORY_ROLE_BRIEF =
  "memory - background calls the memory backend itself makes (Mnemopi/Hindsight extraction, consolidation, and recall synthesis); never a user-facing chat turn, and only relevant when memory is not off.";

function roleBriefFor(role: string): string {
  if (role === "memory") return MEMORY_ROLE_BRIEF;
  return ROLE_BRIEF_LINES[role] ?? `${role} - an omp role not documented here; use the same judgement as the closest similar role.`;
}

export const RESEARCH_SYSTEM_PROMPT = [
  "You are researching which AI models best fit a coding agent's roles, using live web research rather than only your own training knowledge.",
  "Answer with a single JSON object and nothing else: no prose, no explanation outside the JSON, no markdown fence.",
  "Use only the model selectors given to you. Never invent, abbreviate, or reformat a selector.",
].join(" ");

/** Every serious search budget this run's prompt asks the model to keep to. */
export const SEARCH_BUDGET_HINT = 30;

export function buildResearchPrompt(roster: Roster, presets: readonly PresetBrief[], roles: readonly string[] = presetRoleNames()): string {
  const roleBrief = roles.map(roleBriefFor).join("\n");
  const presetBrief = presets.map((preset) => `- id "${preset.id}": "${preset.name}" — ${preset.intent}`).join("\n");

  return [
    "Research and propose model role assignments for these presets.",
    "",
    "Available models and providers (JSON) — use exactly these selectors, `provider/id`, optionally with a `:level` reasoning suffix:",
    JSON.stringify(roster),
    "",
    [
      "`local: true` means the endpoint is actually on a loopback or private-network address.",
      "`thinkingEfforts` lists the reasoning levels THAT SPECIFIC model supports; a level outside that list (or `off` on a model with `reasoning: false`) will be rejected.",
      "`relativeCost` is published per-token pricing for within-provider comparison only, never a proxy for live quota or a subscription's real cost.",
    ].join(" "),
    "",
    "The roles you may assign (never invent a role name):",
    roleBrief,
    "",
    "Presets to research and fill in, each a distinct tier of capability:",
    presetBrief,
    "",
    "Research method (required, not optional):",
    [
      "For every serious candidate model, research it on the open web instead of relying on prior knowledge:",
      "benchmark results, independent reviews, forum and Reddit threads, social media opinion, and the vendor's own claims.",
      "Weigh independent evidence above vendor marketing; explicitly note where they disagree.",
      "Prefer recent sources — this catalog, its pricing, and model quality all change quickly.",
      "Cite the source URL for every claim that actually drove a choice.",
      `Budget your searches: roughly ${SEARCH_BUDGET_HINT} searches total across every candidate is enough for a thorough pass — do not loop indefinitely.`,
      "For token-heavy tiers, whether a model is billed by subscription or pay-per-token matters as much as raw capability.",
    ].join(" "),
    "",
    "Answer with exactly this JSON shape:",
    JSON.stringify({
      summary: "<a few sentences on the overall conclusion>",
      models: [
        {
          selector: "<provider/id>",
          verdict: "<one or two sentences>",
          strengths: ["<...>"],
          weaknesses: ["<...>"],
          sources: [{ url: "<https url>", title: "<title>", kind: "benchmark|review|forum|social|official|other" }],
        },
      ],
      proposals: {
        "<presetId>": {
          roles: { "<role>": "<provider/id or provider/id:level>" },
          rationale: [{ role: "<role or overall>", text: "<one sentence>", sources: ["<https url>"] }],
        },
      },
    }),
    "",
    [
      `Rules. Role names must come from this list: ${roles.join(", ")}.`,
      "Omit a role from a preset only when no available model can satisfy its required image input (vision), or the role does not matter for that preset's intent.",
      "vision must use a model whose roster entry has vision: true.",
      "Presets are tiers of the same idea (e.g. Max/High/Medium/Low): differ them in BOTH model strength and reasoning level per role, not only one axis.",
      "A `:level` suffix is only valid on a model that actually supports it — check that model's own thinkingEfforts in the roster JSON before using it.",
      "Every rationale entry that rests on research should carry at least one source URL from what you found.",
    ].join(" "),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Answer parsing and validation (pure)
// ---------------------------------------------------------------------------

const VALID_SOURCE_KINDS: Record<string, true> = {
  benchmark: true,
  review: true,
  forum: true,
  social: true,
  official: true,
  other: true,
};

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function validateSource(entry: unknown): ResearchSource[] {
  if (!isRecord(entry) || !isHttpUrl(entry.url)) return [];
  const url = entry.url.trim();
  const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : url;
  const kind = typeof entry.kind === "string" && Object.hasOwn(VALID_SOURCE_KINDS, entry.kind) ? (entry.kind as ResearchSourceKind) : "other";
  return [{ url, title, kind }];
}

function validateModelEvidence(entry: unknown, rosterModels: RosterModel[]): ModelEvidence[] {
  if (!isRecord(entry) || typeof entry.selector !== "string") return [];
  const model = resolveRosterModel(entry.selector.trim(), rosterModels);
  if (!model) return [];

  const strengths = Array.isArray(entry.strengths) ? entry.strengths.filter((s): s is string => typeof s === "string") : [];
  const weaknesses = Array.isArray(entry.weaknesses) ? entry.weaknesses.filter((s): s is string => typeof s === "string") : [];
  const sources = Array.isArray(entry.sources) ? entry.sources.flatMap(validateSource) : [];

  return [{
    // Normalized to the roster's own selector: evidence is about the model,
    // not one specific reasoning level of it.
    selector: model.selector,
    verdict: typeof entry.verdict === "string" ? entry.verdict : "",
    strengths,
    weaknesses,
    sources,
  }];
}

function validateRationale(entry: unknown): PresetRationale[] {
  if (!isRecord(entry) || typeof entry.role !== "string" || typeof entry.text !== "string") return [];
  if (!entry.role.trim() || !entry.text.trim()) return [];
  const sources = Array.isArray(entry.sources) ? entry.sources.filter(isHttpUrl).map((url) => url.trim()) : [];
  return [{ role: entry.role.trim(), text: entry.text.trim(), sources }];
}

/** Whether `level` is one `model` can actually run: a real thinking level in
 * its own `thinkingEfforts`, `auto` (omp's engine-resolved alias, valid on any
 * reasoning model), or `off` on a model that does not reason at all. */
function modelSupportsLevel(model: RosterModel, level: string): boolean {
  if (!model.reasoning) return level === "off";
  return level === "auto" || model.thinkingEfforts.includes(level);
}

/** Presets are per-conversation overlays, not the global plan: keep only the
 * chains this preset can ever read at launch — its assigned roles, the bare
 * selector each resolved to (never the `:level` suffix; deriveChains keys
 * exact chains by `model.selector`), and those models' provider wildcards. */
function relevantChainKeys(roles: Record<string, string>, resolvedModels: ReadonlyMap<string, RosterModel>): Set<string> {
  const keys = new Set<string>(Object.keys(roles));
  for (const model of resolvedModels.values()) {
    keys.add(model.selector);
    keys.add(`${model.provider}/*`);
  }
  return keys;
}

/**
 * One preset's proposal out of the planner's raw JSON. Never throws: an
 * unusable role is dropped with a warning, and a preset left with no usable
 * role at all is reported as a failure through `warnings`, never an
 * exception — matching every other one-shot planner in this codebase.
 */
function buildProposal(raw: unknown, rosterModels: RosterModel[], liveRoles: ReadonlySet<string>): PresetProposal {
  const warnings: string[] = [];
  const roles: Record<string, string> = {};
  const resolvedModels = new Map<string, RosterModel>();
  const rawRoles = isRecord(raw) && isRecord(raw.roles) ? raw.roles : {};

  for (const [role, rawSelector] of Object.entries(rawRoles)) {
    if (!liveRoles.has(role)) {
      warnings.push(`Ignored role "${role}": not a role this preset can assign.`);
      continue;
    }
    if (typeof rawSelector !== "string" || !rawSelector.trim()) {
      warnings.push(`Dropped ${role}: no selector given.`);
      continue;
    }

    const selector = rawSelector.trim();
    const model = resolveRosterModel(selector, rosterModels);
    if (!model) {
      warnings.push(`Dropped ${role}: "${rawSelector}" is not an available model.`);
      continue;
    }
    if (role === "vision" && !model.vision) {
      warnings.push(`Dropped vision: ${model.selector} does not accept image input.`);
      continue;
    }

    const suffix = selector.length > model.selector.length ? selector.slice(model.selector.length + 1) : null;
    let finalSelector = model.selector;
    if (!suffix) {
      finalSelector = model.selector;
    } else if (modelSupportsLevel(model, suffix)) {
      finalSelector = selector;
    } else {
      warnings.push(`${role}: "${suffix}" is not a thinking level ${model.name} supports; using its default level instead.`);
    }
    roles[role] = finalSelector;
    resolvedModels.set(role, model);
  }

  if (Object.keys(roles).length === 0) {
    warnings.push("The planner did not assign any usable model to this preset.");
    return { roles: {}, chains: {}, usageAwareFallback: false, rationale: [], warnings };
  }

  // A ladder biased toward the providers this preset actually uses, in the
  // order they were assigned; deriveChains fills every remaining enabled
  // provider behind them in its own default tiering.
  const ladder = [...new Set(Object.values(roles).map((selector) => providerOf(selector)))];
  const fullChains = deriveChains({ roles, ladder, roster: rosterModels });
  // A preset overlay is per-conversation, not the global plan: deriveChains
  // "protects every enabled model" with one exact chain per ROSTER model, and
  // on a full catalog that alone runs well past store.ts's MAX_CHAINS with no
  // role or wildcard chain among the kept keys. Filter down to what this
  // preset can actually read at launch before it ever reaches the cap,
  // instead of leaving store.ts to cut it blind.
  const keepKeys = relevantChainKeys(roles, resolvedModels);
  const chains = Object.fromEntries(Object.entries(fullChains).filter(([key]) => keepKeys.has(key)));
  const usageAwareFallback = Object.values(chains).some((chain) => chain.length > 0);

  const rationale = Array.isArray(isRecord(raw) ? raw.rationale : undefined)
    ? (raw as { rationale: unknown[] }).rationale.flatMap(validateRationale)
    : [];

  return { roles, chains, usageAwareFallback, rationale, warnings };
}

export interface ParseResearchInput {
  presetIds: readonly string[];
  roster: Roster;
  /** Inject OMP's role list for a deterministic offline test. */
  roleNames?: readonly string[];
}

export type ParseResearchOutcome =
  | { ok: true; result: ResearchResult }
  | { ok: false; reason: string };

/** Parse and validate the planner's raw answer text into a `ResearchResult`.
 * Defensive at every layer: malformed JSON, a hallucinated model, an
 * unsupported thinking level, a non-chat role, and a non-http(s) source are
 * every one a warning or a drop, never a thrown exception. */
export function parseResearchAnswer(rawText: string, input: ParseResearchInput): ParseResearchOutcome {
  const json = extractJsonObject(rawText);
  if (!json) return { ok: false, reason: "The planner did not answer with JSON." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { ok: false, reason: `The planner's JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "The planner's answer was not a JSON object." };

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const models = Array.isArray(parsed.models)
    ? parsed.models.flatMap((entry) => validateModelEvidence(entry, input.roster.models))
    : [];

  const rawProposals = isRecord(parsed.proposals) ? parsed.proposals : {};
  const liveRoles = new Set(input.roleNames ?? presetRoleNames());
  const proposals: Record<string, PresetProposal> = {};
  for (const presetId of input.presetIds) {
    proposals[presetId] = buildProposal(rawProposals[presetId], input.roster.models, liveRoles);
  }

  return { ok: true, result: { summary, models, proposals } };
}

// ---------------------------------------------------------------------------
// Progress reducer (pure)
// ---------------------------------------------------------------------------

/** Bounded so a long run's progress log cannot grow without limit; newest
 * entries always survive. */
export const MAX_PROGRESS_ITEMS = 200;

export function appendProgress(progress: readonly ResearchProgressItem[], item: ResearchProgressItem): ResearchProgressItem[] {
  const next = [...progress, item];
  return next.length > MAX_PROGRESS_ITEMS ? next.slice(next.length - MAX_PROGRESS_ITEMS) : next;
}

export function noteProgress(text: string): ResearchProgressItem {
  return { at: new Date().toISOString(), kind: "note", text };
}

export function errorProgress(text: string): ResearchProgressItem {
  return { at: new Date().toISOString(), kind: "error", text };
}

/** One progress item per tool call the child makes. The child is restricted
 * to `web_search` (see the module doc); any other tool name showing up here
 * would mean the isolation regressed, so it is surfaced as an error rather
 * than silently accepted. */
export function progressFromToolStart(event: ToolStartEvent): ResearchProgressItem {
  const at = new Date().toISOString();
  if (event.toolName === "web_search") {
    const query = isRecord(event.args) && typeof event.args.query === "string" ? event.args.query : "web search";
    return { at, kind: "search", text: query };
  }
  if (event.toolName === "read") {
    const path = isRecord(event.args) && typeof event.args.path === "string" ? event.args.path : "";
    return { at, kind: "read", text: path ? `Reading ${path}` : "Reading a URL", ...(isHttpUrl(path) ? { url: path.trim() } : {}) };
  }
  return { at, kind: "error", text: `Unexpected tool call "${event.toolName}" — the research sandbox should never offer this.` };
}

/** Only tool FAILURES get their own progress item; a success is already
 * represented by the matching start item and does not need a second entry. */
export function progressFromToolEnd(event: ToolEndEvent): ResearchProgressItem | null {
  if (!event.isError) return null;
  return errorProgress(`${event.toolName} failed: ${event.resultExcerpt}`);
}

// ---------------------------------------------------------------------------
// Isolated child run
// ---------------------------------------------------------------------------

/** Only `web_search`. See the module doc: this is deliberate, not a
 * placeholder — `read`/`fetch` cannot be confined to URLs, and every other
 * built-in is unrelated to research. */
export const RESEARCH_TOOLS: readonly string[] = ["web_search"];

/** Research is a long, many-search task; 30 minutes is generous rather than
 * tight, since the alternative is truncating real research mid-run. */
export const RESEARCH_TIMEOUT_MS = 30 * 60_000;

/** What the isolated child may see of the real agent dir. See the module doc
 * for why these are linked rather than copied. */
const LINKED_AGENT_FILES = ["agent.db", "models.yml", "models.yaml", "config.yml", "config.yaml"] as const;
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}\n';

/** Build the throwaway agent dir: an explicitly empty `mcp.json`, and links to
 * the files the child needs to authenticate and reach the user's providers.
 * A file the real agent dir does not have (a fresh install) is skipped rather
 * than linked dangling. */
function linkIsolatedAgentDir(targetDir: string): void {
  writeFileSync(join(targetDir, "mcp.json"), EMPTY_MCP_CONFIG, { mode: 0o600 });
  const sourceDir = getAgentDir();
  for (const name of LINKED_AGENT_FILES) {
    const source = join(sourceDir, name);
    if (existsSync(source)) symlinkSync(source, join(targetDir, name));
  }
}

export interface ResearchRunnerArgs {
  plannerModel: string;
  prompt: string;
  signal: AbortSignal;
  onToolStart: (event: ToolStartEvent) => void;
  onToolEnd: (event: ToolEndEvent) => void;
}

export type ResearchRunner = (args: ResearchRunnerArgs) => Promise<{ text: string | null; error: string | null }>;

/** The real runner: an isolated omp child restricted to web_search. Injected
 * as a default so tests can substitute a deterministic fake instead of
 * spawning a process or touching a real agent dir. */
export const realResearchRunner: ResearchRunner = async ({ plannerModel, prompt, signal, onToolStart, onToolEnd }) => {
  const bin = resolveOmpBin();
  if (!bin) return { text: null, error: OMP_BIN_MISSING };

  const isoAgentDir = mkdtempSync(join(tmpdir(), "cody-research-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "cody-research-cwd-"));
  try {
    linkIsolatedAgentDir(isoAgentDir);
    return await runOneShotModelStreaming({
      bin,
      model: plannerModel,
      systemPrompt: RESEARCH_SYSTEM_PROMPT,
      prompt,
      timeoutMs: RESEARCH_TIMEOUT_MS,
      tools: [...RESEARCH_TOOLS],
      cwd,
      extraEnv: { PI_CODING_AGENT_DIR: isoAgentDir },
      signal,
      onToolStart,
      onToolEnd,
    });
  } finally {
    rmSync(isoAgentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Persistence: the latest finished run survives a restart
// ---------------------------------------------------------------------------

const RESEARCH_FILE_NAME = "cody-model-research.json";
const FILE_VERSION = 1;

function writeJsonAtomic(target: string, value: unknown): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

function persistFinishedRun(run: ResearchRunSnapshot): void {
  try {
    writeJsonAtomic(join(getAgentDir(), RESEARCH_FILE_NAME), { version: FILE_VERSION, run });
  } catch {
    // A run whose result cannot be persisted is still fully usable for the
    // rest of this process's lifetime (the in-memory registry has it); it
    // simply will not survive a restart.
  }
}

function isSnapshotShaped(value: unknown): value is ResearchRunSnapshot {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.status === "string"
    && typeof value.plannerModel === "string"
    && Array.isArray(value.presetIds)
    && Array.isArray(value.progress);
}

function readPersistedRun(): ResearchRunSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), RESEARCH_FILE_NAME), "utf8"));
    if (!isRecord(parsed) || !isSnapshotShaped(parsed.run)) return null;
    return parsed.run;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Run registry: one run at a time, in-memory (hot-reload safe), persisted on finish
// ---------------------------------------------------------------------------

interface RunState {
  run: ResearchRunSnapshot;
  controller: AbortController;
  /** Set by cancelRun before aborting, so the runner's own settle handlers
   * become no-ops instead of overwriting the cancelled snapshot they already
   * finalized synchronously. */
  cancelledByUser: boolean;
}

interface RegistryState {
  current: RunState | null;
}

function registry(): RegistryState {
  const g = globalThis as typeof globalThis & { __codyModelResearchRun?: RegistryState };
  return (g.__codyModelResearchRun ??= { current: null });
}

export interface StartResearchInput {
  plannerModel: string;
  presetIds: string[];
  presets: PresetBrief[];
  roster: Roster;
}

export type StartResearchResult =
  | { ok: true; run: ResearchRunSnapshot; done: Promise<void> }
  | { ok: false; code: "research_running"; run: ResearchRunSnapshot }
  | { ok: false; code: "invalid_request"; message: string };

/** Start a research run. Refuses with `research_running` while one is already
 * in flight; the route surfaces that as 409. `runner` is injectable for tests;
 * production callers should omit it and get `realResearchRunner`. */
export function startResearchRun(input: StartResearchInput, runner: ResearchRunner = realResearchRunner): StartResearchResult {
  const reg = registry();
  if (reg.current && reg.current.run.status === "running") {
    return { ok: false, code: "research_running", run: reg.current.run };
  }

  const plannerModel = input.plannerModel.trim();
  const presetIds = [...new Set(input.presetIds.map((id) => id.trim()).filter(Boolean))];
  if (!plannerModel) return { ok: false, code: "invalid_request", message: "plannerModel is required." };
  if (presetIds.length === 0) return { ok: false, code: "invalid_request", message: "presetIds must include at least one preset." };
  if (!resolveRosterModel(plannerModel, input.roster.models)) {
    return { ok: false, code: "invalid_request", message: "The planner model is not in the current curated roster." };
  }

  const run: ResearchRunSnapshot = {
    id: randomBytes(16).toString("hex"),
    status: "running",
    plannerModel,
    presetIds,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: [noteProgress(`Starting research with ${plannerModel} for ${presetIds.length} preset${presetIds.length === 1 ? "" : "s"}.`)],
  };
  const controller = new AbortController();
  const state: RunState = { run, controller, cancelledByUser: false };
  reg.current = state;

  const pushProgress = (item: ResearchProgressItem): void => {
    run.progress = appendProgress(run.progress, item);
  };

  const prompt = buildResearchPrompt(input.roster, input.presets);
  const done = runner({
    plannerModel,
    prompt,
    signal: controller.signal,
    onToolStart: (event) => pushProgress(progressFromToolStart(event)),
    onToolEnd: (event) => {
      const item = progressFromToolEnd(event);
      if (item) pushProgress(item);
    },
  })
    .then((result) => {
      if (state.cancelledByUser) return;
      run.finishedAt = new Date().toISOString();
      if (!result.text) {
        run.status = "failed";
        run.error = result.error ?? "The planner returned no answer.";
        pushProgress(errorProgress(run.error));
        persistFinishedRun(run);
        return;
      }

      const parsed = parseResearchAnswer(result.text, { presetIds, roster: input.roster });
      if (!parsed.ok) {
        run.status = "failed";
        run.error = parsed.reason;
        pushProgress(errorProgress(parsed.reason));
      } else {
        run.status = "succeeded";
        run.result = parsed.result;
        pushProgress(noteProgress("Research complete."));
      }
      persistFinishedRun(run);
    })
    .catch((error) => {
      if (state.cancelledByUser) return;
      const message = error instanceof Error ? error.message : String(error);
      run.status = "failed";
      run.error = message;
      run.finishedAt = new Date().toISOString();
      pushProgress(errorProgress(message));
      persistFinishedRun(run);
    });

  return { ok: true, run, done };
}

/** The latest run: in-memory if this process has one (running or just
 * finished), otherwise the last one persisted before a restart. A run that
 * was still running when the process stopped is gone, per the contract —
 * only a FINISHED run is ever persisted. */
export function getCurrentRun(): ResearchRunSnapshot | null {
  const reg = registry();
  if (reg.current) return reg.current.run;
  return readPersistedRun();
}

export function getRun(runId: string): ResearchRunSnapshot | null {
  const reg = registry();
  if (reg.current?.run.id === runId) return reg.current.run;
  const persisted = readPersistedRun();
  return persisted?.id === runId ? persisted : null;
}

/** Cancel a running run: kills the child (via its AbortSignal) and finalizes
 * the snapshot immediately rather than waiting for the child to actually
 * exit. Returns null when `runId` does not name the currently running run —
 * the route treats that as 404. */
export function cancelRun(runId: string): ResearchRunSnapshot | null {
  const reg = registry();
  const state = reg.current;
  if (!state || state.run.id !== runId || state.run.status !== "running") return null;

  state.cancelledByUser = true;
  state.run.status = "cancelled";
  state.run.finishedAt = new Date().toISOString();
  persistFinishedRun(state.run);
  state.controller.abort();
  return state.run;
}

/** Test-only: drop in-memory run state so a suite starts from a clean slate. */
export function resetResearchRegistryForTests(): void {
  (globalThis as typeof globalThis & { __codyModelResearchRun?: RegistryState }).__codyModelResearchRun = undefined;
}
