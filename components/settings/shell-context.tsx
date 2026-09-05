"use client";

/**
 * What every settings panel can reach without prop threading: the workspace
 * and session it acts on, the active engine and its capabilities, the
 * shell's callbacks back into AppShell, the phone stack, the search
 * highlight and the busy register. Panels read it with `useSettingsShell()`;
 * `SettingsShell` provides it.
 *
 * `SettingsOpenerContext` is the other direction: AppShell provides one
 * `openSettings(tab, opts)` to the whole app so a composer footer or a toast
 * can open Settings › Models without a prop chain.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ActiveEngineInfo, EngineCapabilities, PlatformInfo, SettingsTab } from "../SettingsTabs";
import type { SettingsSectionId } from "./registry";

/** One model as the open session reports it (`availableModels` off get_state):
 * the catalog an ACP engine has, since it keeps no global registry. */
export interface SessionModel {
  provider: string;
  id: string;
  name: string;
}

/**
 * The register of things a navigation must not interrupt: a login SSE, an
 * install stream, a dirty form. Each caller holds a reason and releases it
 * when done; the shell asks `isBusy()` before closing or popping a level and
 * confirms with the user instead of cutting the work off.
 */
export interface SettingsBusyContext {
  isBusy(): boolean;
  /** Registers a reason; returns its release. Releasing twice is a no-op. */
  hold(reason: string): () => void;
  /** Current reasons, oldest first — for the confirmation copy. */
  reasons(): string[];
  subscribe(listener: () => void): () => void;
}

export function createSettingsBusy(): SettingsBusyContext {
  const holds = new Map<symbol, string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    isBusy: () => holds.size > 0,
    hold(reason) {
      const token = Symbol(reason);
      holds.set(token, reason);
      notify();
      return () => {
        if (holds.delete(token)) notify();
      };
    },
    reasons: () => [...holds.values()],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface SettingsShellCallbacks {
  /** The Enable Advisor card writes omp's config AND the browser-side
   * default ChatWindow reads (`cody:advisor-enabled`); AppShell owns that. */
  onAdvisorChange: (enabled: boolean) => void;
  /** models.yml changed — the composer's catalog must be re-read. */
  onModelsSaved: () => void;
  /** A plugin reload restarted the session; the chat remounts. */
  onPluginsReloaded: () => void;
  /** The engine self-update check answered; the title-bar badge follows. */
  onOmpUpdateAvailabilityChange: (available: boolean) => void;
  onClose: () => void;
  /** Switch hubs from inside a panel (System › "Skills" → Extensions › Skills). */
  selectSection: (id: SettingsTab, sub?: string) => void;
}

/** Browser-local UI preferences AppShell owns because ChatWindow reads them
 * every render; Preferences edits them through these setters. */
export interface SettingsShellPrefs {
  toolCallsDefaultCollapsed: boolean;
  setToolCallsDefaultCollapsed: (collapsed: boolean) => void;
  thinkingDefaultExpanded: boolean;
  setThinkingDefaultExpanded: (expanded: boolean) => void;
  /** The browser-side advisor default, the fallback the Enable Advisor card
   * shows until omp's config has loaded. */
  advisorEnabled: boolean;
}

export interface SettingsShellValue {
  cwd: string | null;
  sessionId: string | null;
  engine: ActiveEngineInfo | null;
  capabilities: EngineCapabilities;
  platform?: PlatformInfo;
  /** Short brand of the active engine ("OMP", "Pi", "Hermes"…). */
  harnessLabel: string;
  sessionModels: SessionModel[] | null;
  callbacks: SettingsShellCallbacks;
  prefs: SettingsShellPrefs;
  isMobile: boolean;
  /** The open hub and, for hubs with segments, the open segment. */
  section: SettingsSectionId;
  sub: string | null;
  /** Push a level onto the phone stack (a Drawer or any content). Returns the
   * level id for `closeSub`. On desktop the shell renders nothing for it —
   * callers use `Drawer`, which picks the right presentation itself. */
  openSub: (node: ReactNode, title: string, opts?: { onBack?: () => void }) => string;
  closeSub: (id?: string) => void;
  /** `data-search-id` the pane should scroll to and outline, or null. */
  highlight: string | null;
  busy: SettingsBusyContext;
  /** Positioned element inside the dialog that side drawers portal into, so
   * a drawer stays inside the dialog's focus trap and stacking context. */
  portalTarget: HTMLElement | null;
}

export const ShellContext = createContext<SettingsShellValue | null>(null);

export function useSettingsShell(): SettingsShellValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useSettingsShell must be used inside SettingsShell");
  return value;
}

export interface SettingsOpenOptions {
  sub?: string;
  /** `data-search-id` to scroll to once the panel renders. */
  highlight?: string;
}

/** Open Settings on a hub (or a legacy id); no tab means the last-open hub. */
export type OpenSettings = (tab?: SettingsTab, opts?: SettingsOpenOptions) => void;

export const SettingsOpenerContext = createContext<OpenSettings>(() => {});

export function useSettingsOpener(): OpenSettings {
  return useContext(SettingsOpenerContext);
}
