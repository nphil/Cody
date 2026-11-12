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
  // `steeringMode`, `followUpMode` and `interruptMode` are deliberately NOT
  // here: the engine core reads them for rpc-ui sessions too (sdk.ts), and
  // Cody drives the live values through set_steering_mode /
  // set_follow_up_mode / set_interrupt_mode (hooks/useAgentSession.ts).
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
  // omp 18.8.6-18.17: switches that only the interactive terminal session (or
  // its CLI launch) reads. Checked against the omp 18.19.0 source: none of
  // them appears anywhere under src/modes/rpc or src/modes/acp, which is how
  // Cody drives it.
  //  - `update.auto`: omp's self-update at an interactive launch, so it never
  //    updates a Cody child;
  //  - `session.worktreeScope`: scopes the TUI's resume picker (Cody lists
  //    sessions itself);
  //  - `composer.predictions` / `composer.predictionAlternatives`: the TUI
  //    composer's ghost-text prompt predictions;
  //  - `terminal.programStatus`: the OSC 7501 status the TUI writes to the
  //    terminal it runs in;
  //  - `worktree.onStart` / `worktree.onExit`: only `maybeAutoCreateWorktree`
  //    at an interactive launch acts on them, and RPC hosts are pinned to
  //    their defaults (off / keep);
  //  - `extensionHandlers.modeControl`, `extensionRenderers.assistantText`,
  //    `extensionRenderers.transcriptPresenters`: `ctx.sessionModes` is only
  //    supplied by the TUI, and the renderers are only asked for by its
  //    transcript;
  //  - `btw.inject`: `/btw` drafting an <inject> prompt for Alt+I in the TUI;
  //  - `async.printWake`: wakes print mode, which Cody never runs.
  "update.auto",
  "session.worktreeScope",
  "composer.predictions",
  "composer.predictionAlternatives",
  "terminal.programStatus",
  "worktree.onStart",
  "worktree.onExit",
  "extensionHandlers.modeControl",
  "extensionRenderers.assistantText",
  "extensionRenderers.transcriptPresenters",
  "btw.inject",
  "async.printWake",
  // omp 18.14.1 `title.refreshAfterPrompts`: only a session the engine
  // auto-titles can be re-titled after N prompts, and `autoTitle` is on for the
  // interactive terminal host alone (main.ts: `options.autoTitle = isInteractive`;
  // `#titleRefreshEnabled("drift")` requires it). Cody names its chats itself
  // through set_session_name, which the engine treats as a name the user chose
  // and never replaces. (`title.refreshOnReplan` is NOT listed: the todo replan
  // path can still title an unnamed Cody session.)
  "title.refreshAfterPrompts",
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
  // memory is still scored against EVERY live stored memory (content re-read +
  // token Jaccard + entity overlap), synchronously on the engine's JS thread, so
  // the cost grows with the memory count. omp 18.9 (DC-MN-01) made it much
  // cheaper: one transaction per memory instead of one commit per edge (the
  // fsync storm that froze the loop for seconds), no edges to retired memories,
  // and the date-word edge growth is gone. Before that, measured on a real
  // install (omp 18.3.4): ~10k memories, 20.6 M graph_edges rows, a 5.2 GB
  // mnemopi.db, and each agent_end froze the whole session for 3 min 14 s.
  "mnemopi.proactiveLinking":
    "Still compares each new memory with every live stored memory while the whole session (subagents included) waits, so the delay grows with the number of memories. omp 18.9 made it much cheaper; before that a store of about 10,000 memories froze every reply for over 3 minutes and grew the memory database to 5 GB. Leave this off unless you have measured it on your own memories.",
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
  // omp 18.19.0 src/task/settings.ts + judgment/index.ts: each new top-level
  // prompt is sent to the native judge (the `judge` model role) to find
  // independent subtasks; "suggest" emits an info `notice` (source task) that
  // Cody shows as a chat notice, "on" also tells the agent to delegate in one
  // parallel task call. The setting has an RPC protocol default of "off", so
  // it only applies when it is written to config.yml (as Cody's panel does).
  "task.autoParallel":
    "Costs one extra request to your \"judge\" model for every new prompt you send, and does nothing when no judge model is configured. \"Suggest\" only shows the proposed split as a notice in the chat; \"On\" also tells the assistant to start those parts as parallel subagents, which can multiply model spend. It stays off in Cody until you turn it on here.",
  // omp 18.19.0 task/settings.ts: the model is accepted only when the
  // configuration already routes to it (role models, the agent's own model,
  // the parent's); a project config can only narrow, never approve a model.
  "task.perCallModel":
    "Lets the assistant name one exact model for a single subagent call instead of using that agent's usual model, bypassing the model Cody's routing picked for that agent. Only models your configuration already routes to are accepted, and the allowlist below narrows it further. The subagent chip and its dialog show the model it actually ran on.",
  // omp 18.14.0 internal-urls/out-protocol.ts `outRepliesActive`: a configured
  // `out.enabled` wins; unset, it follows the host — on in the interactive
  // terminal, off under rpc-ui — so the schema's declared `true` never reaches
  // a Cody chat (settings-schema.ts therefore shows Off as the unset value). On,
  // the system prompt advertises out:// and the model sends mid-task replies as
  // `write` calls to it; Cody has no out:// handling, so they draw as tool cards.
  "out.enabled":
    "Off in Cody until you turn it on here (the engine's own terminal switches it on by default). Turned on, the assistant posts mid-task replies as writes to out://, which Cody shows as ordinary tool cards rather than as chat messages.",
  // omp 18.14.0 session/settings-stream-fn.ts: `liveSteering` reaches the
  // provider stream only while `providers.openaiLiveSteering` is on (true by
  // default before 18.14, false since). Off, a message queued while a GPT-6
  // response streams waits for the next tool boundary like any other steer.
  "providers.openaiLiveSteering":
    "omp 18.14 changed the default to Off. While Off, a message you send during a GPT-6 reply waits for the next tool call or the end of the reply before the model reads it; On feeds it into the streaming reply over the Codex WebSocket. Only GPT-6 replies are affected.",
  // omp 18.12.3 sdk.ts + job-widgets/registry.ts: the model's own job/wait tool
  // calls `widgets.view(job)` in every mode (async/job-control.ts), and a viewed
  // job that has run 15 s then costs a widget-author call (shell jobs that
  // printed 3+ lines, subagent jobs that declared what to watch; at most 3
  // attempts) and, for a long shell command, one caption call. Both use the
  // `widget` model role (resolves like smol) and are recorded as session usage
  // (job-widget / job-caption). No widget crosses the rpc-ui wire.
  "async.widgets":
    "Cody draws no job widgets, but the engine still makes the small model calls for them: when the assistant waits on a background job or a long shell command that has run for 15 seconds, it asks the \"widget\" model role (your small model until you assign one) to design a widget (up to three tries) and to caption the command in one line. Turn off to skip that spend.",
  // omp 18.11.3 session/prewalk.ts: under `suggest`/`on` every new top-level
  // prompt is classified by the native judge (the `judge` model role); without
  // a judge nothing is classified. `suggest` emits an info `notice` (source
  // prewalk) that Cody shows as a chat notice; `on` arms a handoff to
  // `prewalk.autoTarget` at the first edit, so the chat's model changes mid-task
  // and the next task starts back on the planning model. Off in plan mode.
  "prewalk.auto":
    "Costs one extra request to your \"judge\" model for every new prompt you send, and does nothing when no judge model is set. \"Suggest\" only posts its verdict as a notice in the chat; \"On\" can hand a task over to the auto-prewalk target (your small model by default) at its first edit, so the model working on it changes mid-task, and the next task starts on the planning model again.",
  // omp spotlight/* (Developer group, env PI_SPOTLIGHT_EXPERIMENT): shapes the
  // text `read`, `bash`, `eval` and other tools hand the model, and ranks it by
  // `POST https://cloud.stencil.so/v1/spotlight` (request body carries the tool
  // output items) with a Stencil credential (/login Stencil or STENCIL_API_KEY).
  // Without one it still cuts by unranked fallback rules (spotlight/session.ts);
  // a random share of cuts is held out for measurement (holdout / scoreFree).
  "spotlight.experiment.enabled":
    "An omp developer experiment. It cuts down what the assistant sees from file reads and commands. When a Stencil login or STENCIL_API_KEY exists, it also sends that text to Stencil's cloud service (cloud.stencil.so) to rank which lines to keep; without one it still cuts output by plain rules. Some cuts are skipped at random for measurement. Leave this off unless you mean to take part.",
  // omp pi-ai openai-codex/access-programs.ts: while on (the default) a
  // ChatGPT-authenticated request asks for `access_programs.cyber =
  // "daybreak_blue"` whenever account discovery says the selected account may
  // use it on that model. 18.8.3 already did this unconditionally; 18.14.1 only
  // added the switch.
  "providers.openai-codex.daybreak":
    "On by default, and omp already behaved this way before the switch existed: requests from a ChatGPT account that OpenAI has made eligible ask for the Daybreak Blue cyber access program. OpenAI may use the content of Daybreak Blue sessions to improve its models. Turn this off to opt out. Models named gpt-daybreak-blue-* are separate and may still run as Daybreak sessions.",
  // omp 18.13.3: off stops the `xd://: mounted …` notices. Cody hides them in
  // the transcript and only turns an MCP mount into an "MCP tools updated" toast
  // (hooks/useAgentSession.ts notice / xdev-mount-notice), so off removes that.
  "tools.xdevNotices":
    "Cody never shows these notices in the chat; it only turns the one for newly connected MCP tools into a short \"MCP tools updated\" toast. Turning this off removes that toast too, and the assistant still learns of the change with its next prompt.",
  // omp 18.16.0 hindsight backend: `retain` / `learn` may pass `scope: "global"`
  // only when this is on, and the memory scoping mode must be global or
  // per-project-tagged for it to take effect.
  "hindsight.globalScope":
    "Only has an effect when Hindsight's scoping is set to global or per-project-tagged. A global memory is stored without the project tag, so every project recalls it, including projects you would rather keep apart.",
  // omp 18.19.0 tools/ask.ts: at the deadline the form's current values
  // (preselected options, empty text) are submitted and the result carries
  // `timedOut: true`; plan mode has no timeout. The same setting also bounds
  // `cfg://` settings-approval prompts, but only the terminal UI registers a
  // host for those (cfg-protocol.ts refuses without one), so a Cody chat
  // never reaches that path. Older engines auto-selected the recommended answer.
  "ask.timeout":
    "When time runs out on a question the assistant asked, omp 18.19 and later send the form as it stands (preselected options, empty text boxes) and tell the assistant nobody answered in time; older engines pick the recommended answer instead. Questions asked in plan mode never time out. 0 means no time limit.",
  // omp 18.17.0 display.shellVisualization (default on) attaches a
  // `details.trace` — a copy of the shell's screen — to every bash progress
  // update and to the saved session; only the terminal UI draws it. Cody
  // launches every chat with it off (lib/omp/cody-launch-defaults.yml, dropped
  // when config.yml explicitly turns it on), and settings-schema.ts
  // CODY_DEFAULT_OVERRIDES makes the row read Off while nothing configures it.
  "display.shellVisualization":
    "Cody starts every chat with this off. omp's terminal UI is the only thing that draws the visualization, and with it on each bash progress update carries about 40 times more data. Turn it on only if you also resume these chats in the omp terminal and want the visualization there; it applies to chats started afterwards.",
  // omp 18.18.7 split Claude's single `autoRedeem` per window. Its in-memory
  // migration copies the old value into 5h and weekly only; the Fable window
  // is new and stays unset (src/config/settings.ts, "Fable window is new").
  "claudeResets.autoRedeem5h": "Fable is a separate consent: it is not copied from the old switch.",
  "claudeResets.autoRedeemWeekly": "Fable is a separate consent: it is not copied from the old switch.",
  "claudeResets.autoRedeemFable": "Fable is a separate consent: it is not copied from the old switch.",
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
