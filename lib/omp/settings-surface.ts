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
  // Thinking-block rendering. Both are consumed only by the harness's
  // transcript components (assistant-message, chat-transcript-builder,
  // agent-hub, streaming-reveal) and by its Ctrl+T toggle; nothing on the
  // rpc-ui protocol reads either, so thinking blocks reach Cody unchanged and
  // Cody draws them itself. See "Expand thinking blocks" in Interface &
  // Behavior for the browser-side control.
  "hideThinkingBlock",
  "proseOnlyThinking",
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
  // omp 18.1.17: Up-arrow recall of prompts cleared with Ctrl+C in the TUI
  // composer; Cody's composer keeps its own drafts (lib/draft-store.ts).
  "composer.recallClearedDrafts",
  // Desktop/terminal notifications. Cody has its own completion sound.
  "completion.notify",
  "error.notify",
  "ask.notify",
  "recap.enabled",
  "recap.idleSeconds",
  // Voice input is a terminal-session feature.
  "stt.enabled",
  // omp 18.2.4: the TUI working row's own smoothed tokens-per-second readout.
  // Cody measures its own from the engine's per-message numbers and draws it
  // on the message (lib/message-rate.ts), so this one reaches nothing here.
  "composer.tokenRate",
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
  // The macOS prompt-editor spelling features (omp 18: typo detection, word
  // autocomplete, autocorrect) act on the TUI composer; Cody's composer has
  // the browser's own spellcheck.
  "spelling.",
  // omp 18.2.5: `omp stream` livestreams the TERMINAL screen to a stream
  // server. Cody draws no such screen, but the CLI a user runs in a Cody
  // terminal does — which is exactly why these are labelled, not hidden.
  "stream.",
];

/** Whether a setting configures the harness's terminal UI and therefore has no
 * effect while working in Cody. */
export function isTerminalOnlySetting(key: string): boolean {
  if (TERMINAL_ONLY_KEYS.has(key)) return true;
  return TERMINAL_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Settings whose BEHAVIOUR differs under Cody — not because Cody ignores
 * them, but because the engine takes a different path when it is driven
 * over RPC instead of from its own terminal. Rendered as a warning clause
 * beside the control.
 *
 * Same discipline as the terminal-only list: each entry names a mechanism
 * that was read in the installed engine's source, never a guess.
 */
const SETTING_NOTES: Record<string, string> = {
  // turn-recovery.ts: `shouldFallback = depleted || policy === "auto" || !confirmer`,
  // and setUsageFallbackConfirmer is wired only by the ACP agent and the
  // interactive TUI controller — never by `--mode rpc-ui`, which is how
  // Cody drives the engine. So "Confirm interactively" cannot ask anyone
  // here and always answers yes. auth-storage getModelUsageHealth rates
  // each account and calls the provider healthy while ANY account is, then
  // re-selects that account, so a second account is used before the chain.
  "retry.usageAwareFallback":
    "Before each request the engine moves to another signed-in account of the same provider when the current one is spent, and only walks the fallback chain once every account is. \"Confirm interactively\" cannot ask anyone in Cody and behaves as \"Auto-fallback\".",
  "retry.usageReservePolicy":
    "\"Confirm interactively\" is unavailable over Cody's connection to the engine and behaves as \"Auto-fallback\".",
  // omp 18.1.15 turn-recovery.ts: with `retry.waitForUsageReset` a provider-
  // stated usage-limit reset is slept through on the ordinary auto-retry path
  // (`auto_retry_start` with the full delayMs, abortable through the retry
  // controller), so Cody shows it as a retry countdown and "Abort retry" ends
  // it. Cody's usage-aware routing (lib/routing) re-points roles around an
  // exhausted provider before the request is made, so the two mechanisms
  // disagree about what a spent quota should do.
  "retry.waitForUsageReset":
    "In Cody the wait appears as an auto-retry countdown that can last until the provider's reset (hours to a week) and holds subagents; Abort retry ends it. Cody's routing already routes roles around exhausted providers, so leave this off unless you want turns to block instead.",
  // pi-mnemopi episodic-graph.ts ingestMemory(linkExisting: true): every new
  // memory is scored against EVERY stored memory (content re-read + token
  // Jaccard + entity/temporal queries), synchronously on the engine's JS
  // thread. Measured on a real install (omp 18.3.4): ~10k memories, 20.6 M
  // graph_edges rows, a 5.2 GB mnemopi.db, and each agent_end froze the whole
  // session, subagents included, for 3 min 14 s. Grows with every memory.
  "mnemopi.proactiveLinking":
    "Slows down as memories pile up: after every reply the engine compares the new memory with every stored one, and the whole session (subagents included) is frozen while it does. On an install with ~10,000 memories this took over 3 minutes per reply and grew the memory database to 5 GB. Leave this off.",
};

/** The Cody-specific caveat for a setting, when one applies. */
export function settingNoteFor(key: string): string | undefined {
  return SETTING_NOTES[key];
}

/** The notes themselves, for the test that keeps them matching the schema. */
export const SETTING_NOTE_KEYS = Object.keys(SETTING_NOTES);

/** The rules themselves, for the test that keeps them honest. */
export const TERMINAL_ONLY_RULES = {
  keys: [...TERMINAL_ONLY_KEYS],
  prefixes: [...TERMINAL_ONLY_PREFIXES],
};
