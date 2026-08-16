/**
 * Which harness settings do nothing in a browser.
 *
 * The harness ships one settings schema for one program, and a good part of it
 * configures that program's terminal UI — its theme registry, status line,
 * glyph rendering, keybindings, desktop notifications. Cody draws its own
 * chrome and reads none of it. Those rows still belong in the settings panel,
 * because the same config file drives the CLI the user runs in a terminal, but
 * flipping one and seeing nothing change in the browser is a bug report waiting
 * to happen. So they are rendered and labelled rather than hidden.
 *
 * The schema carries no metadata for this — the harness has no notion of a
 * second front end — so this list is Cody's own judgement and the one place in
 * the settings pipeline that is hand-maintained. It is deliberately
 * conservative: a setting is listed only when it is clearly terminal chrome.
 * Mislabelling a setting that *does* reach the browser is worse than leaving a
 * terminal-only one unmarked, so anything ambiguous (share/collab endpoints,
 * magic keywords, git integration) is left alone.
 *
 * settings-surface.test.mjs asserts every rule still matches something in the
 * installed schema, so an upstream rename shows up as a failing test rather
 * than as a badge that quietly stops appearing.
 */

/** Exact dotted paths that only affect the harness's terminal UI. */
const TERMINAL_ONLY_KEYS = new Set([
  "symbolPreset",
  "colorBlindMode",
  "showHardwareCursor",
  "autoResume",
  "terminal.showImages",
  "terminal.showProgress",
  "task.showResolvedModelBadge",
  "power.sleepPrevention",
  // Input handling belongs to the TUI's own composer; Cody has its own.
  "steeringMode",
  "followUpMode",
  "interruptMode",
  "doubleEscapeAction",
  "treeFilterMode",
  "autocompleteMaxVisible",
  "emojiAutocomplete",
  "paste.largeMenuThreshold",
  // Desktop/terminal notifications. Cody has its own completion sound.
  "completion.notify",
  "error.notify",
  "ask.notify",
  "recap.enabled",
  "recap.idleSeconds",
  // Voice input is a terminal-session feature.
  "stt.enabled",
]);

/** Dotted-path prefixes (matched at a segment boundary) that are terminal-only
 * wholesale: every setting the harness declares under them draws or drives its
 * text UI. */
const TERMINAL_ONLY_PREFIXES = [
  "theme.",
  "statusLine.",
  "tui.",
  "display.",
  "startup.",
];

/** Whether a setting configures the harness's terminal UI and therefore has no
 * effect while working in Cody. */
export function isTerminalOnlySetting(key: string): boolean {
  if (TERMINAL_ONLY_KEYS.has(key)) return true;
  return TERMINAL_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** The rules themselves, for the test that keeps them honest. */
export const TERMINAL_ONLY_RULES = {
  keys: [...TERMINAL_ONLY_KEYS],
  prefixes: [...TERMINAL_ONLY_PREFIXES],
};
