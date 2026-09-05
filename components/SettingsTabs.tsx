"use client";

import { normalizeSectionId } from "./settings/registry";

/**
 * Every id Settings can be opened with. The eight HUB ids (accounts, general,
 * providers, models, engine, extensions, memory, system) are the sections
 * `components/settings/registry.ts` renders; the rest are LEGACY ids that
 * deep links, toasts and older callers still pass, kept for one release and
 * normalised by `normalizeSectionId` (safety/intelligence/omp → engine,
 * localai → providers, mcp/skills/plugins → extensions with a sub-view).
 * `models` keeps its id but now means the Models hub, not "AI Model Defaults"
 * (those moved into Behavior).
 */
export type SettingsTab =
  | "accounts"
  | "general"
  | "safety"
  | "models"
  | "providers"
  | "intelligence"
  | "memory"
  | "engine"
  | "extensions"
  | "mcp"
  | "omp"
  | "skills"
  | "plugins"
  | "localai"
  | "system";

/**
 * The active engine's capability flags, mirroring HarnessCapabilities in
 * lib/harness/types.ts. GET /api/info reports them for the engine currently
 * driving the instance; the client keeps its own structural copy so no client
 * component has to import server code.
 */
export interface EngineCapabilities {
  liveSessions: boolean;
  models: boolean;
  skills: boolean;
  plugins: boolean;
  mcp: boolean;
  nativeSettings: boolean;
  configEditor: boolean;
  updates: boolean;
  chatExtras: boolean;
  fastMode: boolean;
  advisor: boolean;
  subagents: boolean;
  memory: boolean;
  providerLogin: boolean;
}

/** The active engine's identity, also from GET /api/info. */
export interface ActiveEngineInfo {
  id: string;
  displayName: string;
  shortName: string;
  experimental: boolean;
}

/** What an older server (no `capabilities` in /api/info) and omp both mean.
 * Everything omp serves is on, so gating only ever bites on an explicit
 * `false` — with one exception, below.
 *
 * `memory` defaults OFF because it is the one flag omp itself reports false:
 * omp keeps memory but exposes no read-back, so defaulting it on would show a
 * Memory tab whose route answers 400. A capability flag hides a surface, it
 * never renders a broken one. */
export const ALL_CAPABILITIES: EngineCapabilities = {
  liveSessions: true,
  models: true,
  skills: true,
  plugins: true,
  mcp: true,
  nativeSettings: true,
  configEditor: true,
  updates: true,
  chatExtras: true,
  fastMode: true,
  advisor: true,
  subagents: true,
  memory: false,
  providerLogin: true,
};

/** Coerce whatever /api/info returned into a full flag set, defaulting every
 * missing or non-boolean flag to ALL_CAPABILITIES' value so today's omp
 * behavior is unchanged. */
export function normalizeCapabilities(value: unknown): EngineCapabilities {
  if (!value || typeof value !== "object") return ALL_CAPABILITIES;
  const source = value as Record<string, unknown>;
  const result = { ...ALL_CAPABILITIES };
  for (const key of Object.keys(ALL_CAPABILITIES) as Array<keyof EngineCapabilities>) {
    if (typeof source[key] === "boolean") result[key] = source[key] as boolean;
  }
  return result;
}

/**
 * What shell/deployment is hosting Cody, mirroring `InfoResponse["platformInfo"]`
 * in app/api/info/route.ts. Orthogonal to EngineCapabilities above: that's
 * what the active *engine* can serve, this is what the *shell* is — a plain
 * web/Docker deployment never sets CODY_DESKTOP, so `desktop` stays false.
 */
export interface PlatformInfo {
  desktop: boolean;
}

/** Unlike ALL_CAPABILITIES, the safe default here is "no" — an older server
 * with no `platformInfo` field is never the desktop shell. */
export const DEFAULT_PLATFORM: PlatformInfo = { desktop: false };

export function normalizePlatform(value: unknown): PlatformInfo {
  if (!value || typeof value !== "object") return DEFAULT_PLATFORM;
  const source = value as Record<string, unknown>;
  return { desktop: source.desktop === true };
}

/** Fallback brand for the harness-settings tab. The real one comes from the
 * active harness (CODY_HARNESS) and arrives with the schema fetch, so this is
 * only what renders before that lands. */
export const DEFAULT_HARNESS_LABEL = "OMP";

/** The founding engine's id, as `/api/info` reports it.
 *
 * Capability flags cover almost everything the UI gates on, but a few routes
 * are ONE engine's own files rather than a capability anything else could
 * grow — session import writes omp's .jsonl layout, archive moves it with
 * omp's gc layout — and the server refuses them under any other engine
 * (lib/engine-guard `requireEngine("omp", …)`). The client half of that rule
 * needs the same id, so it is named once here instead of being spelled out
 * as a bare string wherever a control mirrors such a route. */
export const OMP_ENGINE_ID = "omp";

/** The Extensions & Tools group description, composed from what the active
 * engine actually serves so a skills-only engine (pi) is not promised MCP. */
/** What this group actually offers on the ACTIVE engine. Shared by the tab
 * entry and the panel heading: the panel is no longer hidden on an engine
 * without MCP, so a hardcoded "MCP servers, skills and OMP plugins" there
 * would name three things a pi or Hermes user does not have. */
export function extensionsGroupDescription(capabilities: EngineCapabilities): string {
  const parts = [
    ...(capabilities.mcp ? ["MCP servers"] : []),
    ...(capabilities.skills ? ["skills"] : []),
    ...(capabilities.plugins ? ["plugins"] : []),
  ];
  return parts.length > 0
    ? `${parts.join(", ").replace(/^./, (c) => c.toUpperCase())} for the active engine`
    : "Extensions for the active engine";
}

/**
 * The flag that decides whether the schema-driven "All <engine> Settings" tab
 * exists — and therefore whether its schema is worth fetching at all.
 *
 * Named once and shared because the tab and the fetch behind it drifted apart
 * twice: the route is engine-GENERIC (it serves omp's TypeScript schema and
 * Hermes\' DEFAULT_CONFIG-derived one through the same panel), so guarding the
 * fetch on `configEditor` — which means "Cody has hand-built editors for this
 * engine", omp alone — left Hermes with a settings tab whose contents the
 * dialog search could not find. One constant, one answer.
 */
export const SCHEMA_TAB_CAPABILITY = "nativeSettings" satisfies keyof EngineCapabilities;

/** Legacy id → the hub that now renders it. Delegates to the registry so the
 * alias table is spelled once. */
export const getNormalizedActive = (tab: SettingsTab): SettingsTab => normalizeSectionId(tab);
