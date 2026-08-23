/**
 * Every browser-storage key and custom DOM event Cody owns, in one place.
 *
 * ompweb spread these across three prefixes (`omp-web:`, `omp-`, `cody-`),
 * which made it impossible to tell Cody's own UI state apart from anything the
 * omp agent might store. Everything now lives under a single `cody:` namespace.
 */
export const STORAGE_KEYS = {
  /** Chosen theme id from lib/theme-catalog. */
  theme: "cody:theme",
  /** UI locale ("en" | "ja" | "zh-CN"). */
  lang: "cody:lang",
  /** Sidebar width in pixels. */
  sidebarWidth: "cody:sidebar-width",
  /** Whether tool-call cards render collapsed by default. */
  toolCallsCollapsed: "cody:tool-calls-collapsed",
  /** Whether thinking blocks render expanded by default. */
  thinkingExpanded: "cody:thinking-expanded",
  /** Project folders left expanded in the session tree. */
  expandedProjects: "cody:expanded-projects",
  /** Session ids with unseen agent output. */
  unreadSessions: "cody:unread-session-ids",
  /** Last-opened session per project, for restoring a workspace. */
  lastOpenByProject: "cody:last-open-by-project",
  /** Whether Enter submits while the agent is still running. */
  submitDuringRun: "cody:submit-during-run",
  /** Selected tool preset (none / default / full). */
  toolPreset: "cody:tool-preset",
  /** Whether the native OMP advisor is enabled. */
  advisorEnabled: "cody:advisor-enabled",
  /** Models pinned into the composer's model picker. */
  composerModels: "cody:composer-models",
  /** Whether the turn-completion sound plays. */
  soundEnabled: "cody:sound-enabled",
  /** Selected right-panel tool (files / git / terminal / preview / tasks / info). */
  workspacePanel: "cody:workspace-panel",
  /** Git panel changed-file presentation ("list" | "tree"). */
  gitFileView: "cody:git-file-view",
  /** Right workspace panel width in pixels (unset = CSS default). */
  workspaceWidth: "cody:workspace-width",
  /** Whether the terminal soft-key toolbar is forced on or off. */
  terminalSoftKeysVisible: "cody:terminal-soft-keys",
  /** Individual buttons shown in the terminal soft-key toolbar. */
  terminalSoftKeyIds: "cody:terminal-soft-key-ids",
  /** Stream pacing parameters (JSON-serialized StreamTuning). */
  streamTuning: "cody:stream-tuning",
} as const;

/** localStorage prefixes completed with a workspace path. */
export const STORAGE_PREFIXES = {
  /** Last preview URL used in a workspace ("cody:preview-url:<cwd>"). */
  previewUrl: "cody:preview-url:",
} as const;

/**
 * Keys above whose value belongs to ONE engine's world and must not survive
 * an engine switch. Session ids are the engine's own (omp's ids mean nothing
 * to pi, and pi's mean nothing to Hermes), and a pinned model list written
 * against omp's catalog left the composer on pi showing "No models" for a
 * catalog that had loaded fine — with the Models settings tab hidden there,
 * so there was no way back.
 *
 * Scoped values live at `<key>:<engineId>`; the SHAPE of each value is
 * unchanged, only its address. Everything else Cody stores (theme, language,
 * panel widths, sound) is a property of the human, not the engine, and stays
 * global on purpose.
 *
 * The unscoped predecessor is deliberately abandoned rather than adopted into
 * the active engine's scope: adopting it is precisely the bug — it would hand
 * omp's pins to whichever engine happened to be selected on the next load.
 * Each of these is a UI convenience that costs one reset to rebuild.
 */
export const ENGINE_SCOPED_KEYS = [
  STORAGE_KEYS.composerModels,
  STORAGE_KEYS.unreadSessions,
  STORAGE_KEYS.lastOpenByProject,
] as const;

/** Address one of ENGINE_SCOPED_KEYS for a given engine. Null while the
 * active engine is still unknown (`/api/info` in flight): callers must treat
 * that as "nothing stored yet" rather than reading the global key, which is
 * another engine's data by definition. */
export function engineScopedKey(key: string, engineId: string | null | undefined): string | null {
  return engineId ? `${key}:${engineId}` : null;
}

/** sessionStorage prefixes — per-tab and rebuilt on demand, so they are not
 * migrated, only renamed. Both are completed with a session id. */
export const SESSION_STORAGE_PREFIXES = {
  /** Queued messages mirrored out of React state so a reload can restore them. */
  queue: "cody:queue:",
  /** The active goal parsed out of the running turn. */
  goal: "cody:goal:",
} as const;

/** Same-window notifications between components that share a stored value. */
export const STORAGE_EVENTS = {
  composerModelsChange: "cody:composer-models-change",
  soundPrefChange: "cody:sound-pref-change",
  terminalSoftKeysChange: "cody:terminal-soft-keys-change",
  streamTuningChange: "cody:stream-tuning-change",
} as const;

/**
 * Pre-fork key → current key. Kept in load order so the bootstrap script in
 * app/layout.tsx can serialize it verbatim and run the copy before any other
 * script reads storage.
 */
export const LEGACY_STORAGE_KEYS: readonly (readonly [string, string])[] = [
  ["cody-theme", STORAGE_KEYS.theme],
  ["omp-lang", STORAGE_KEYS.lang],
  ["omp-web:sidebar-width", STORAGE_KEYS.sidebarWidth],
  ["omp-web:tool-calls-collapsed", STORAGE_KEYS.toolCallsCollapsed],
  ["omp-web:expanded-projects", STORAGE_KEYS.expandedProjects],
  ["omp-web:unread-session-ids", STORAGE_KEYS.unreadSessions],
  ["omp-web:last-open-by-project", STORAGE_KEYS.lastOpenByProject],
  ["omp-web:submit-during-run", STORAGE_KEYS.submitDuringRun],
  ["omp-web:tool-preset", STORAGE_KEYS.toolPreset],
  ["omp-advisor-enabled", STORAGE_KEYS.advisorEnabled],
  ["omp-composer-models", STORAGE_KEYS.composerModels],
  ["omp-sound-enabled", STORAGE_KEYS.soundEnabled],
];

/**
 * Copy any pre-fork value onto its `cody:` key, once, then drop the old key.
 *
 * The migration has to finish before the theme bootstrap reads storage, i.e.
 * before first paint, so app/layout.tsx inlines a minified equivalent of this
 * loop in <head> rather than importing it. That script serializes
 * LEGACY_STORAGE_KEYS directly, so the key list cannot drift; this function is
 * the readable definition of the copy semantics those tests pin down. Change
 * the two together.
 *
 * An existing value under the new key always wins: the user has already made a
 * choice since upgrading, and re-copying stale data would silently undo it.
 * Storage can throw (private mode, quota, disabled cookies) and losing an old
 * preference is never worth breaking startup, so every step is best-effort.
 */
export function migrateLegacyStorage(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): void {
  for (const [legacy, current] of LEGACY_STORAGE_KEYS) {
    try {
      if (storage.getItem(current) !== null) {
        storage.removeItem(legacy);
        continue;
      }
      const value = storage.getItem(legacy);
      if (value === null) continue;
      storage.setItem(current, value);
      storage.removeItem(legacy);
    } catch {
      // Unreadable or unwritable storage: keep the old value where it is.
    }
  }
}
