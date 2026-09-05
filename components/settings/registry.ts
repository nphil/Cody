"use client";

/**
 * The Settings shell's single source of truth: which hubs exist, in what
 * order, under which eyebrow, gated on which capability, and which panel
 * module renders each one. `SettingsShell`, `SettingsSidebar` (desktop rail),
 * `MobileStack` (phone) and the dialog-wide search all read this table; a
 * hub that is not here does not exist.
 *
 * Legacy ids survive one release: every id `SettingsTab` still lists is
 * normalised here (`normalizeSectionId` / `resolveSection`) so old deep links,
 * toasts and callers land on the hub that now holds their content.
 */
import dynamic from "next/dynamic";
import { createElement, type ComponentType, type CSSProperties } from "react";
import { Brain, Cable, Cpu, KeyRound, RefreshCw, Settings2, SlidersHorizontal, UserRound } from "lucide-react";
import { isSubscriptionLogin } from "@/lib/provider-directory";
import type { ActiveEngineInfo, EngineCapabilities, SettingsTab } from "../SettingsTabs";

export type SettingsSectionId = "accounts" | "general" | "providers" | "models" | "engine" | "extensions" | "memory" | "system";

/** Eyebrow the row sits under: "You" (the human's own things), the active
 * engine's short name (its providers, models, behavior, extensions, memory)
 * or "Server" (this Cody instance). */
export type SettingsGroup = "you" | "engine" | "server";

export type CapabilityGate = keyof EngineCapabilities | readonly (keyof EngineCapabilities)[];

export interface StatusLine {
  text: string;
  /** `muted` (default) is a plain fact; `accent` draws the eye (new models,
   * an update); `warn` flags something the engine cannot work without. */
  tone?: "muted" | "accent" | "warn";
}

/** What a section's status line gets to look at. Only CACHED reads: a row
 * must never spawn an engine or wait on a network round trip to paint. */
export interface ShellData {
  capabilities: EngineCapabilities;
  engine: ActiveEngineInfo | null;
  harnessLabel: string;
  /** Bodies of the section's `statusRoutes`, keyed by route; absent until the
   * cache has them, and absent for good when the route answered an error. */
  routes: Readonly<Record<string, unknown>>;
  /** Browser-local preferences the Preferences row summarises. */
  local: { localeLabel: string; themeName: string; soundEnabled: boolean };
}

export interface SettingsSubView {
  id: string;
  label: string;
  needsCapability?: CapabilityGate;
}

export type SettingsIcon = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" | "false"; style?: CSSProperties }>;

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  group: SettingsGroup;
  Icon: SettingsIcon;
  /** Hidden entirely when the engine lacks the capability (ANY of a list). */
  needsCapability?: CapabilityGate;
  /** Position in the phone root list; groups order by their first row. */
  phoneOrder: number;
  /** Segments inside the hub, each gated on its own flag. */
  subViews?: readonly SettingsSubView[];
  /** Routes the rail prefetches (cache-only reads) for `statusLine`. */
  statusRoutes?: readonly string[];
  statusLine?: (data: ShellData) => StatusLine | null;
  /** True when the panel module renders its own `role="tabpanel"` root with
   * the `settings-panel-<id>` id (AccountSettings, SystemUpdates), so the
   * shell must not wrap it in a second one. */
  ownsTabpanel?: boolean;
  panel: ComponentType<Record<string, never>>;
}

const PanelLoading = () => createElement("div", { role: "status", style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12, padding: 20 } }, "Loading settings…");

const AccountPanel = dynamic(() => import("./panels/AccountPanel").then((m) => m.AccountPanel), { loading: PanelLoading });
const PreferencesPanel = dynamic(() => import("./panels/PreferencesPanel").then((m) => m.PreferencesPanel), { loading: PanelLoading });
const ProvidersPanel = dynamic(() => import("./panels/ProvidersPanel").then((m) => m.ProvidersPanel), { loading: PanelLoading });
const ModelsPanel = dynamic(() => import("./panels/ModelsPanel").then((m) => m.ModelsPanel), { loading: PanelLoading });
const EnginePanel = dynamic(() => import("./panels/EnginePanel").then((m) => m.EnginePanel), { loading: PanelLoading });
const ExtensionsPanel = dynamic(() => import("./panels/ExtensionsPanel").then((m) => m.ExtensionsPanel), { loading: PanelLoading });
const MemoryPanel = dynamic(() => import("./panels/MemoryPanel").then((m) => m.MemoryPanel), { loading: PanelLoading });
const SystemPanel = dynamic(() => import("./panels/SystemPanel").then((m) => m.SystemPanel), { loading: PanelLoading });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function countOf(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "accounts",
    label: "Account",
    group: "you",
    Icon: UserRound,
    phoneOrder: 8,
    statusRoutes: ["/api/accounts/me", "/api/accounts/me/tokens"],
    statusLine: ({ routes }) => {
      const user = asRecord(asRecord(routes["/api/accounts/me"])?.user);
      if (!user) return null;
      const parts = [typeof user.username === "string" ? `@${user.username}` : null, user.role === "admin" ? "Admin" : null];
      const tokens = countOf(asRecord(routes["/api/accounts/me/tokens"])?.tokens);
      if (tokens !== null) parts.push(`${tokens} token${tokens === 1 ? "" : "s"}`);
      return { text: parts.filter(Boolean).join(" · ") };
    },
    ownsTabpanel: true,
    panel: AccountPanel,
  },
  {
    id: "general",
    label: "Preferences",
    group: "you",
    Icon: Settings2,
    phoneOrder: 1,
    statusLine: ({ local }) => ({ text: `${local.localeLabel} · ${local.themeName} · sound ${local.soundEnabled ? "on" : "off"}` }),
    panel: PreferencesPanel,
  },
  {
    id: "providers",
    label: "Providers",
    group: "engine",
    Icon: KeyRound,
    phoneOrder: 2,
    // `?cached=1` answers from the catalog cache only (`pending: true` when
    // cold), so the rail never starts an engine child. Until the route lands
    // it answers 404, the cache keeps no body, and the row carries no status.
    statusRoutes: ["/api/providers?cached=1"],
    statusLine: ({ routes, engine, harnessLabel }) => {
      const body = asRecord(routes["/api/providers?cached=1"]);
      const rows = Array.isArray(body?.providers) ? body.providers.map(asRecord) : null;
      if (!rows) return null;
      const connected = rows.filter((row) => row?.connected === true).length;
      // "Signed in" is a subscription login that WINS for its provider: omp's
      // roster marks key vendors "authenticated" too, and a key is not a
      // sign-in. A cold catalog cache (`pending`) with nothing connected is
      // not yet a verdict, so no warning until the credentials are known.
      const signedIn = rows.filter((row) => Array.isArray(row?.methods) && row.methods.some((method) => {
        const entry = asRecord(method);
        return entry?.winning === true && entry.state === "connected"
          && isSubscriptionLogin({ kind: entry.kind, loginId: entry.loginId } as Parameters<typeof isSubscriptionLogin>[0]);
      })).length;
      if (connected === 0 && body?.pending === true) return null;
      if (connected === 0) return { text: `No credentials — ${engine?.shortName ?? harnessLabel} cannot answer`, tone: "warn" };
      const parts = [`${connected} connected`];
      if (signedIn > 0) parts.push(`${signedIn} signed in`);
      return { text: parts.join(" · ") };
    },
    panel: ProvidersPanel,
  },
  {
    id: "models",
    label: "Models",
    group: "engine",
    Icon: Cpu,
    phoneOrder: 3,
    subViews: [
      { id: "catalog", label: "Catalog" },
      { id: "assignments", label: "Assignments", needsCapability: "models" },
    ],
    // Both reads are cache-only: `/api/models/new?cached=1` peeks the
    // catalog cache (`pending: true` when cold, never a spawn) and carries
    // the catalog's `total`; the visibility file is a local read. Not
    // `/api/models`: on a cold cache it starts the engine's utility child,
    // and a rail row must never do that. An ACP engine has no sessionless
    // catalog (`catalogSource: "session"`) and says so instead of counting.
    statusRoutes: ["/api/models/new?cached=1", "/api/models/visibility"],
    statusLine: ({ routes }) => {
      const fresh = asRecord(routes["/api/models/new?cached=1"]);
      if (!fresh) return null;
      if (fresh.catalogSource === "session") return { text: "From the session" };
      if (fresh.pending === true || typeof fresh.total !== "number") return null;
      const parts = [`${fresh.total} model${fresh.total === 1 ? "" : "s"}`];
      const visibility = asRecord(routes["/api/models/visibility"]);
      const hidden = (countOf(visibility?.hidden) ?? 0) + (countOf(visibility?.instanceHidden) ?? 0);
      if (hidden > 0) parts.push(`${hidden} hidden`);
      const added = countOf(fresh.newModels) ?? 0;
      if (added > 0) parts.push(`${added} new`);
      return { text: parts.join(" · "), tone: added > 0 ? "accent" : "muted" };
    },
    panel: ModelsPanel,
  },
  {
    id: "engine",
    label: "Behavior",
    group: "engine",
    Icon: SlidersHorizontal,
    needsCapability: ["configEditor", "nativeSettings"],
    phoneOrder: 5,
    statusRoutes: ["/api/omp-settings/schema"],
    statusLine: ({ routes }) => {
      const body = asRecord(routes["/api/omp-settings/schema"]);
      const settings = countOf(asRecord(body?.schema)?.settings);
      if (settings === null) return null;
      // Secret leaves are redacted out of `values` and reported by key in
      // `secretsSet`; both are changed settings.
      const values = asRecord(body?.values);
      const changed = (values ? Object.keys(values).length : 0) + (countOf(body?.secretsSet) ?? 0);
      const version = asRecord(asRecord(body?.schema)?.source)?.version;
      const parts = [typeof version === "string" ? version : null, `${changed} changed`, `${settings} settings`];
      return { text: parts.filter(Boolean).join(" · ") };
    },
    panel: EnginePanel,
  },
  {
    id: "extensions",
    label: "Extensions",
    group: "engine",
    Icon: Cable,
    needsCapability: ["mcp", "skills", "plugins"],
    phoneOrder: 6,
    subViews: [
      { id: "mcp", label: "MCP", needsCapability: "mcp" },
      { id: "skills", label: "Skills", needsCapability: "skills" },
      { id: "plugins", label: "Plugins", needsCapability: "plugins" },
    ],
    // Counts need a workspace (the skills and MCP routes take a cwd and scan
    // it), which is not a cached read; the row names what this engine serves.
    statusLine: ({ capabilities }) => {
      const parts = [capabilities.mcp ? "MCP servers" : null, capabilities.skills ? "skills" : null, capabilities.plugins ? "plugins" : null].filter(Boolean);
      return parts.length > 0 ? { text: parts.join(" · ") } : null;
    },
    panel: ExtensionsPanel,
  },
  {
    id: "memory",
    label: "Memory",
    group: "engine",
    Icon: Brain,
    needsCapability: "memory",
    phoneOrder: 7,
    statusRoutes: ["/api/memory"],
    statusLine: ({ routes }) => {
      const documents = countOf(asRecord(routes["/api/memory"])?.documents);
      return documents === null ? null : { text: `${documents} document${documents === 1 ? "" : "s"}` };
    },
    panel: MemoryPanel,
  },
  {
    id: "system",
    label: "System",
    group: "server",
    Icon: RefreshCw,
    phoneOrder: 4,
    statusRoutes: ["/api/app-update", "/api/engines/updates"],
    statusLine: ({ routes }) => {
      const app = asRecord(routes["/api/app-update"]);
      const engines = asRecord(routes["/api/engines/updates"])?.updates;
      const engineUpdate = Array.isArray(engines) && engines.some((entry) => asRecord(entry)?.updateAvailable === true);
      if (!app && !engineUpdate) return null;
      const parts = [typeof app?.currentVersion === "string" ? `Cody ${app.currentVersion}` : null];
      if (app?.updateAvailable === true) parts.push("update available");
      else if (engineUpdate) parts.push("engine update available");
      return { text: parts.filter(Boolean).join(" · "), tone: app?.updateAvailable === true || engineUpdate ? "accent" : "muted" };
    },
    ownsTabpanel: true,
    panel: SystemPanel,
  },
];

/** Legacy ids and where their content lives now. `models` is deliberately
 * absent: the id survives but points at the Models hub, not at the old "AI
 * Model Defaults" tab (that content is under Behavior). */
export const SECTION_ALIASES: Readonly<Record<string, { id: SettingsSectionId; sub?: string }>> = {
  safety: { id: "engine" },
  intelligence: { id: "engine" },
  omp: { id: "engine" },
  localai: { id: "providers" },
  mcp: { id: "extensions", sub: "mcp" },
  skills: { id: "extensions", sub: "skills" },
  plugins: { id: "extensions", sub: "plugins" },
};

const SECTION_IDS = new Set<string>(SETTINGS_SECTIONS.map((section) => section.id));

export function isSectionId(value: string): value is SettingsSectionId {
  return SECTION_IDS.has(value);
}

/** The hub a legacy or current id lands on; unknown ids fall back to
 * Preferences, the one section every engine and every account has. */
export function normalizeSectionId(id: SettingsTab | string | null | undefined): SettingsSectionId {
  if (!id) return "general";
  if (isSectionId(id)) return id;
  return SECTION_ALIASES[id]?.id ?? "general";
}

/** Like `normalizeSectionId`, but keeps the sub-view a legacy id implies
 * (`skills` → Extensions › Skills). An explicit `sub` wins over the alias. */
export function resolveSection(idOrLegacy: SettingsTab | string | null | undefined, sub?: string | null): { id: SettingsSectionId; sub?: string } {
  const id = normalizeSectionId(idOrLegacy);
  const implied = idOrLegacy ? SECTION_ALIASES[idOrLegacy]?.sub : undefined;
  const resolved = sub ?? implied;
  return resolved ? { id, sub: resolved } : { id };
}

/** ANY semantics for a list: a hub whose sub-surfaces gate individually stays
 * as long as one of them can render. No gate means always. */
export function capabilityAllows(needs: CapabilityGate | undefined, capabilities: EngineCapabilities): boolean {
  if (!needs) return true;
  const list = typeof needs === "string" ? [needs] : needs;
  return list.some((key) => capabilities[key]);
}

export function getVisibleSections(capabilities: EngineCapabilities): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => capabilityAllows(section.needsCapability, capabilities));
}

export function getVisibleSubViews(section: SettingsSection, capabilities: EngineCapabilities): SettingsSubView[] {
  return (section.subViews ?? []).filter((view) => capabilityAllows(view.needsCapability, capabilities));
}

export function getSection(id: SettingsSectionId): SettingsSection {
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`Unknown settings section: ${id}`);
  return section;
}

export function groupLabel(group: SettingsGroup, harnessLabel: string): string {
  if (group === "you") return "You";
  if (group === "server") return "Server";
  return harnessLabel;
}

/** Sections grouped for a rail: desktop keeps registry order; the phone list
 * orders rows by `phoneOrder` and groups by their first row, so the same
 * eyebrows appear on both with Preferences first and Account last. */
export function groupSections(sections: readonly SettingsSection[], order: "desktop" | "phone"): Array<{ group: SettingsGroup; sections: SettingsSection[] }> {
  const ordered = order === "phone" ? [...sections].sort((a, b) => a.phoneOrder - b.phoneOrder) : [...sections];
  const groups: Array<{ group: SettingsGroup; sections: SettingsSection[] }> = [];
  for (const section of ordered) {
    const existing = groups.find((entry) => entry.group === section.group);
    if (existing) existing.sections.push(section);
    else groups.push({ group: section.group, sections: [section] });
  }
  return groups;
}
