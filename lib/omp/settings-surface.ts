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
  // omp 18.4.4: TUI composer input behaviour (input-controller.ts) — bare
  // `exit`/`quit`/`q` on an empty session and bare slash-command words.
  // Cody's composer has neither.
  "input.bareExitOnEmptySession",
  "input.bareSlashCommands",
  // omp 18.4.4: inside a Tern terminal pane (TERM_PROGRAM=tern) the browser
  // tool opens tabs as picture-in-pictures over omp's pane. Cody's rpc-ui child
  // never runs in one, so it only matters to a CLI started in a Tern terminal.
  "browser.tern",
  // omp 18.6.3: keeps finished thinking blocks expanded in a Tern terminal
  // pane (interactive-mode.ts setExpandThinkingBlocks). Nothing on the rpc-ui
  // protocol reads it; Cody has its own "Expand thinking blocks" control.
  "expandThinkingBlocks",
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
  // The macOS prompt-editor spelling features (omp 18: typo detection,
  // autocorrect) act on the TUI composer; Cody's composer has the browser's
  // own spellcheck. `spelling.autocomplete` is the exception: Cody's composer
  // shows the same inline word completion (predict_word, omp 18.4+).
  "spelling.",
  // omp 18.2.5: `omp stream` livestreams the TERMINAL screen to a stream
  // server. Cody draws no such screen, but the CLI a user runs in a Cody
  // terminal does — which is exactly why these are labelled, not hidden.
  "stream.",
];

/** Whether a setting configures the harness's terminal UI and therefore has no
 * effect while working in Cody. */
export function isTerminalOnlySetting(key: string): boolean {
  if (key === "spelling.autocomplete") return false;
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
  // omp 18.3.5 session/cache-warmer.ts + sdk.ts (refresh cost counted in session
  // usage since 18.4.5): the main agent loop replays
  // its last request (1-token output budget) just before the prompt-cache
  // entry expires. Default "idle" (no `protocolDefault`, so `--mode rpc-ui` is
  // NOT pinned off). Only models whose catalog entry declares a `promptCache`
  // lifetime are warmed, and each refresh must clear an expected-savings
  // floor of $0.05 (0.15 continuation probability × miss cost − warm cost), so
  // small prompts are never warmed. Idle warming stops 30 min after the real
  // request (streaming 60 min); a 1h cache entry is only warmed during a run.
  // Refreshes are real provider calls counted in session usage. Cody keeps an
  // engine alive while any tab is attached (rpc-manager resetIdleTimer), so
  // the 30-minute window runs to its end while the tab stays open; a session
  // nobody has open is closed after 10 minutes, which also ends warming.
  "providers.cacheWarming":
    "Default \"Idle\". After a reply the engine re-sends the whole conversation to the provider just before its prompt cache would expire, to keep it cheap to continue. That is a real provider request each time and it spends quota or money. It only happens for models with a known cache lifetime, only when the saving beats the cost (about $0.05, so long conversations), and for at most 30 minutes after the last reply (60 while a run is active). Cody keeps a session you have open alive, so warming keeps running while its tab is open; a session nobody has open is closed after 10 minutes and warming ends with it. Set to Off to never spend on this.",
  // omp 18.4.3 speculation/host.ts + task/index.ts: with `task.batch` the
  // task tool starts each tasks[] item's subagent while the call is still
  // streaming. Vetoed (falls back to the normal launch) when the task tool's
  // approval is not auto-allow or any extension has tool_call/tool_result/
  // tool_approval_* handlers. Cody's own extension registers none of those.
  "task.speculativeLaunch":
    "Subagents of a batch task call start as soon as each item has streamed in, so they can appear in Cody before the assistant has finished writing the call. It does not apply when the task tool needs your approval or an extension watches tool calls; the call then launches normally.",
  // omp 18.5.0 task/completion-probe.ts: `isCompletionProbeEnabled` is
  // `parentDepth === 0 && isInteractiveHost() && task.completionProbe`. The
  // probe is a TUI-only readout, so a Cody session (`--mode rpc-ui`) never
  // asks a subagent for an estimate whatever this is set to.
  "task.completionProbe":
    "No effect in Cody: the engine only asks subagents for a completion estimate in its own terminal session, never when driven over RPC, so Cody shows none whatever this is set to.",
  // omp 18.4.11+ modes/rpc/rpc-goal.ts: `#continuationWanted()` re-reads this
  // setting at every decision (each terminal agent_end, `goal create`/`resume`),
  // and it continues only when the list includes "rpc" — omp's default is
  // ["interactive"], so a goal driven from Cody (`--mode rpc-ui`) never carries
  // on by itself until "rpc" is added. A running engine watches config.yml and
  // applies the edit live (verified on 18.7: the very next turn end continues),
  // so the Goal panel's "Keep working automatically" switch writes this key
  // without restarting anything (a restart would pause an active goal).
  "goal.continuationModes":
    "In Cody add \"rpc\" to let an active goal carry on by itself between turns (the Goal panel's \"Keep working automatically\" switch does exactly this). Without it a goal only works when you send a message, because Cody's engine runs in rpc mode, not interactive mode. It applies to every chat, takes effect at the next turn end without restarting anything, and the goal still stops when the agent makes no new progress, you press Stop, or its token budget runs out.",
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
