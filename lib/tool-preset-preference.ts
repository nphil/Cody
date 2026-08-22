import { STORAGE_KEYS } from "./storage-keys";
import { isToolPreset, type ToolPreset } from "./tool-presets";

const STORAGE_KEY = STORAGE_KEYS.toolPreset;

// New sessions default to the full toolset so a fresh Cody session exposes the
// same builtin tools as a vanilla `omp` terminal (which passes no --tools).
const DEFAULT_TOOL_PRESET: ToolPreset = "full";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Set once a restricted preset has been chosen through a UI that says what
 * it disables. Restricted values stored BEFORE this marker existed date from
 * builds whose tools control was later removed — the restriction kept
 * applying to every new session (--tools at spawn kills omp's task/todo/
 * github/web_search builtins, i.e. subagents and task lists) with no surface
 * left to see or undo it. Those stale values are migrated back to full. */
const ACK_KEY = `${STORAGE_KEY}-ack`;

export function getPreferredToolPreset(storage: StorageLike | null = browserStorage()): ToolPreset {
  if (!storage) return DEFAULT_TOOL_PRESET;
  try {
    const value = storage.getItem(STORAGE_KEY);
    if (!isToolPreset(value)) return DEFAULT_TOOL_PRESET;
    if (value !== "full" && storage.getItem(ACK_KEY) !== "1") {
      storage.setItem(STORAGE_KEY, DEFAULT_TOOL_PRESET);
      return DEFAULT_TOOL_PRESET;
    }
    return value;
  } catch {
    return DEFAULT_TOOL_PRESET;
  }
}

export function setPreferredToolPreset(preset: ToolPreset, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
    // An explicit choice from the current, warning-labeled control is
    // acknowledged: the stale-restriction migration above must not undo it.
    storage.setItem(ACK_KEY, "1");
  } catch {
    // Preferences remain optional when storage is unavailable.
  }
}
