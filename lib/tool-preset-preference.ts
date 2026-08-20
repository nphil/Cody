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

export function getPreferredToolPreset(storage: StorageLike | null = browserStorage()): ToolPreset {
  if (!storage) return DEFAULT_TOOL_PRESET;
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isToolPreset(value) ? value : DEFAULT_TOOL_PRESET;
  } catch {
    return DEFAULT_TOOL_PRESET;
  }
}

export function setPreferredToolPreset(preset: ToolPreset, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
  } catch {
    // Preferences remain optional when storage is unavailable.
  }
}
