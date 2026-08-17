import { STORAGE_KEYS } from "./storage-keys";

export const TERMINAL_SOFT_KEYS = [
  { id: "escape", label: "Esc", data: "\x1b" },
  { id: "tab", label: "Tab", data: "\t" },
  { id: "shift-tab", label: "Shift Tab", data: "\x1b[Z" },
  { id: "slash", label: "/", data: "/" },
  { id: "mention", label: "@", data: "@" },
  { id: "up", label: "↑", data: "\x1b[A" },
  { id: "down", label: "↓", data: "\x1b[B" },
  { id: "left", label: "←", data: "\x1b[D" },
  { id: "right", label: "→", data: "\x1b[C" },
  { id: "enter", label: "Enter", data: "\r" },
  { id: "ctrl-c", label: "Ctrl C", data: "\x03" },
  { id: "ctrl-d", label: "Ctrl D", data: "\x04" },
  { id: "ctrl-z", label: "Ctrl Z", data: "\x1a" },
  { id: "ctrl-l", label: "Ctrl L", data: "\x0c" },
  { id: "ctrl-r", label: "Ctrl R", data: "\x12" },
  { id: "ctrl-u", label: "Ctrl U", data: "\x15" },
  { id: "ctrl-w", label: "Ctrl W", data: "\x17" },
  { id: "home", label: "Home", data: "\x1b[H" },
  { id: "end", label: "End", data: "\x1b[F" },
  { id: "page-up", label: "PgUp", data: "\x1b[5~" },
  { id: "page-down", label: "PgDn", data: "\x1b[6~" },
  { id: "delete", label: "Del", data: "\x1b[3~" },
] as const;

export type TerminalSoftKeyId = (typeof TERMINAL_SOFT_KEYS)[number]["id"];

export const DEFAULT_TERMINAL_SOFT_KEY_IDS: readonly TerminalSoftKeyId[] = TERMINAL_SOFT_KEYS.map((key) => key.id);


/** Parse the stored selection. Missing or malformed state keeps the complete
 * default toolbar; an intentionally empty array remains empty. */
export function parseTerminalSoftKeyIds(value: string | null): TerminalSoftKeyId[] {
  if (value === null) return [...DEFAULT_TERMINAL_SOFT_KEY_IDS];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
      return [...DEFAULT_TERMINAL_SOFT_KEY_IDS];
    }
    const selected = new Set(parsed.filter((id) => DEFAULT_TERMINAL_SOFT_KEY_IDS.includes(id as TerminalSoftKeyId)));
    return DEFAULT_TERMINAL_SOFT_KEY_IDS.filter((id) => selected.has(id));
  } catch {
    return [...DEFAULT_TERMINAL_SOFT_KEY_IDS];
  }
}

export function readTerminalSoftKeyIds(): TerminalSoftKeyId[] {
  if (typeof window === "undefined") return [...DEFAULT_TERMINAL_SOFT_KEY_IDS];
  try {
    return parseTerminalSoftKeyIds(window.localStorage.getItem(STORAGE_KEYS.terminalSoftKeyIds));
  } catch {
    return [...DEFAULT_TERMINAL_SOFT_KEY_IDS];
  }
}

export function writeTerminalSoftKeyIds(ids: readonly TerminalSoftKeyId[]): void {
  window.localStorage.setItem(STORAGE_KEYS.terminalSoftKeyIds, JSON.stringify(ids));
}

/** xterm's paste path intentionally adds bracketed-paste control sequences when
 * the child advertises mode 2004. Cody sends clipboard text directly to the
 * PTY instead, normalizing browser newlines without adding invisible bytes. */
export function normalizeTerminalPaste(text: string): string {
  return text.replace(/\r\n|\n/g, "\r");
}
