# Session runtime: engine launch, RPC lifecycle, events, branching, warm sessions

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Human terminal engine launch is entrypoint-scoped
- RPC session lifecycle (`lib/rpc-manager.ts`)
- Two kinds of branching — don't confuse them
- ToolCall field normalization
- Event protocol differences vs pi
- Long tool calls narrate themselves
- Running state SSE + reconciliation
- A viewed session stays warm, and a closed one never leaves a deaf stream
- RPC transport limit — the utility process MUST negotiate v2

### Human terminal engine launch is entrypoint-scoped
- `TerminalManager.create()` launches the active engine once, then drops into
  the configured interactive shell. `continue()` restarts only that shell.
- The wrapper belongs only to browser PTYs created by the New Terminal action.
  Never move it into shell profiles or process-global environment handling:
  task runs, server subprocesses, and agent tool calls must stay plain commands.
- Container SSH auto-launch is separately guarded in
  `docker/entrypoint.sh` by `SSH_CONNECTION`, a real TTY, and
  `CODY_NO_AUTO_ENGINE`; non-interactive SSH commands must bypass it.
- **Terminal omp launches never self-update.** Terminal omp launches get an overlay layer pinning `update.auto: false` so omp can never self-update the engine under Cody's gated install (omp 18.17+ setting; harmless on older).

### RPC session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per session id, keyed in a `globalThis` registry.
- `globalThis` survives Next.js hot-reload; plain module-level Map does not.
- Idle sessions are disposed after a timeout — never while an event stream is
  attached (see "A viewed session stays warm" below); concurrent
  `startRpcSession()` calls must share a single start promise.
- **One child per session, even across a close.** A wrapper leaves the
  registry the moment its destroy begins, but its child holds the session file
  until it has exited (stdin closed, SIGTERM after 5 s, SIGKILL after 10 s).
  `startRpcSession` therefore waits for a RETIRING child of the same id first
  (`noteRetiring` in each registry `onDestroy`, `waitForRetiringChild`, at most
  30 s). Without it a page's event stream, which reconnects within a second of
  a close, spawned a second child beside the first; omp then moved the second
  one's writes to a NEW session file because the first still owned the
  original. That is how the LumaShow chat split in two on 2026-10-09, with an
  engine running on each half. Pinned by "a session closed a moment ago is not
  started again until its old child has exited" in `lib/rpc-manager.test.mjs`.
- **Every ack the wrapper awaits is bounded** (`PROMPT_ACK_TIMEOUT_MS`, 30 s;
  `IMAGE_PROMPT_ACK_TIMEOUT_MS`, 60 s when the prompt carries images):
  `RpcProcess.sendCommand` never times out unless told to, and a child that
  accepts a `prompt` (or the `/mcp list` prompt) but never acks it used to
  leave `promptRunning` true forever — every later call answered
  `session_busy` until a restart. On `RpcCommandTimeoutError` the wrapper
  recycles the child (`destroyAndWait`) and answers `session_unresponsive`;
  the next request spawns fresh. The bound is on the ACK only, never on the
  run. omp 18.4.6+ acks a prompt once it has ADMITTED it (earlier builds ack
  on receipt): an idle session first normalizes images and, on a text-only
  model, waits on a vision description (capped at 20 s upstream) — hence the
  wider image bound — and a queued steer/follow-up acks once it is in omp's
  queue. The turn itself then reports through events. Pinned in
  `lib/rpc-manager.test.mjs`.
- **A fresh spawn never receives a client-supplied session id.**
  `/api/agent/new` strips `sessionId` from the forwarded command; a stale or
  forged id would address the wrong session in the child.
- **Every child is opted in to ask dialogs, at spawn and at restart**
  (`enableAskDialog` → `set_ask_dialog`, omp 18.4.9+; the flag lives in the
  child process). An omp that predates it answers `Unknown command` — ignored,
  that build keeps its select/editor fallback. An engine with a restricted
  vocabulary (pi) is never asked: its id-less error could never settle the
  request. `ask` is a pending dialog like select/confirm/input/editor:
  replayed to a reconnecting stream, dropped by omp's `cancel` frame. From omp
  18.18.3 the built-in `ask` tool no longer uses the structured `ask` request, so
  `set_ask_dialog` changes nothing for the model's own questions; it still opts in
  extensions' `ctx.ui.askDialog` calls (an extension-only path, so `AskDialogForm`
  is now rare). The call stays harmless on every engine (an omp that predates it
  answers `Unknown command`).
- **Session files are read through an append-aware parse cache**
  (`lib/session-reader.ts` `loadThroughParseCache`, cursor from
  `loadSessionFileWithCursor` in `lib/omp/session-files.ts`). omp only
  appends; a rename rewrites the 256-byte title slot in place; every other
  rewrite goes through a temp file + rename (new inode). The cursor relies on
  exactly that: same inode, not smaller, and an unchanged 4 KB anchor before
  the parsed end (title slot excluded) mean "only appended", so only the new
  lines are parsed. An unterminated last line is parsed again next time.
  Legacy (pre-v3) files get no cursor and are always parsed whole.
- **Live attach never waits on `get_state`.** `GET /api/sessions/<id>/state?fast=1`
  answers a live session from the wrapper's own phase flags (`livePhase()`,
  via `livePhaseState` in lib/api-utils.ts), the shape of a stale
  `getStateBounded` answer with only `isStreaming`/`isPromptRunning`/
  `isBashRunning`/`isCompacting`. omp serializes RPC commands, so `get_state`
  sits behind a running command; the page uses the fast read to attach and
  lets the full read reconcile later. For the same attach the wrapper keeps
  the current run's last 8 finished replies and tool results
  (`liveMessageFrames`; cleared at run start, run end and compaction), which
  the events route replays after the running helpers to a stream opened with
  `?replay=1`, flagged `replayed`: they cover the gap between the page's
  transcript read and its subscription.
- **A live session can MOVE to a new id** (omp 18.4.9). When another omp
  process owns the session file for writing, this one's next write moves the
  live session to a NEW sibling `.jsonl` under a NEW session id
  (`parentSession` = the old id) and leaves the old file untouched. The only
  wire signal is `{type:"notice", level:"warning", source:"session-persistence"}`;
  `get_state` then reports the new id and file. The wrapper follows it through
  `noteIdentityChange`, the path a fork's id change takes: the registry
  re-keys (the `onIdentityChange` callback) exactly once, whichever of the
  notice-triggered `get_state` or a state poll (`buildWebState`) sees it first.
  Because no command asked for it, it also COPIES owner (a session without
  one is visible to every account), preset, Local-only snapshot and
  plan-keeper overlay to the new id (the old id stays valid, so copy, never
  move), aliases the display bus, and — once the new file is on disk — emits
  `cody_session_moved {sessionId, previousSessionId, sessionFile}` to every
  attached stream. The browser adopts it through the fork path
  (`onSessionForked`: AppShell swaps the selected session, remounts and
  rewrites `?session=`), carrying the tab's per-id state (unsent outbox rows,
  Smart pick, the web-hosted fallback goal, draft) to the new id and explaining itself in a global
  toast that outlives the remount. A fork/new_session/switch_session in
  flight (`requestedIdentityChanges`) owns its own change and announces
  nothing. Reproduce for real by resuming one session file in two omp
  processes and writing from both (the second one's first write moves) —
  never run two on one file on purpose. Pinned in `lib/rpc-manager.test.mjs`,
  through the real `startRpcSession` with a fake omp binary.
- **Idle cache warming is invisible.** omp (18.3.5+, `providers.cacheWarming`,
  default `idle`; the frames arrive from 18.4.5) refreshes the provider's
  prompt cache while a session sits idle and emits `cache_warming_start/end`.
  Those frames are forwarded but never reset the idle timer, flip the running
  state or signal the sidebar, so an unattended child still idles out after 10
  minutes (warming costs real provider calls until the child is gone).

- **Engine RPC commands added by omp 18.13–18.19 (`lib/rpc-manager.ts`).** `PASSTHROUGH_COMMANDS` now also forwards `navigate_tree`, `abort_branch_summary`, `set_label` and `get_session_lease` verbatim (omp 18.13.2+/18.14.1+). omp 18.8.3 answers them with an ordinary `Unknown command: <type>` failed response, so every caller must treat that as "feature absent" and fall back; pi never sees them (they are not in its `rpcUi.commands`). `navigate_tree` was removed from `UNSUPPORTED_COMMANDS`. The UI does NOT call any of them yet: the transcript tree's "navigate" stays display-only (`handleNavigate` in `hooks/useAgentSession.ts`) because moving the real leaf would have to spawn an engine just to browse and would change what "Edit from here" means — a product decision, not a compatibility fix.
- **Shell command "exclude from context" (`!!`) is capability-gated.** omp 18.16+ announces `supportsBashExcludeFromContext` in its `ready` frame; `AgentSessionWrapper` keeps it as `bashExcludeSupported` (reset on relaunch, re-read on the next `ready`). A `bash` command with `excludeFromContext: true` against an engine without it is refused with `WebRpcError` code `bash_exclude_unsupported` (plain message, i18n `agentSession.*`) instead of being silently treated as a normal command that the model would then see. Do not re-add a version-number check; the `ready` flag is the contract.
- **Spend cap errors (`cost_cap`).** omp 18.13+ refuses the next model request once the chat passes `session.maxCost` (`--max-cost`) and says so in a `notice` frame with `source: "cost-gate"` (warning level at `session.warnCost`, error level at the cap). `lib/error-text.ts` classifies the cap's wording as kind `cost_cap` (plain sentence, no provider guess; `readCostGateAmounts` pulls the amounts out); `hooks/useAgentSession.ts` shows it as a warning-tone notice with its own i18n sentence (`agentSession.errorCostCap*`) instead of a raw "--max-cost" error; `lib/notifications/observer.ts` tracks `costCapRunId` so a run the cap ended before any model reply is reported as failed with the spend-limit sentence (and a prompt refused outright, which never starts a run, still sends one error notification). 18.8.3 has no cost gate, so none of this fires there.
- **Launch defaults layer (`lib/omp/cody-launch-defaults.{yml,ts}`).** Cody-driven chats get `display.shellVisualization: false` via a `PI_CONFIG_FILES` layer (omp 18.17+ attaches a live copy of the shell screen to every bash progress frame and the saved entry: a 2 s bash call sent 65 frames of up to 112 KB). `buildEngineRpcLaunch` in `lib/rpc-manager.ts` merges the layer FIRST in the existing `PI_CONFIG_FILES` list (model preset / Claude credits / Local-only layers keep their order). The user's `config.yml` is never written; if the user explicitly set `display.shellVisualization: true` there, `codyLaunchDefaultsLayer()` returns null and the layer is dropped. The Settings panel shows the Cody default (`CODY_DEFAULT_OVERRIDES` / `SETTING_NOTES`). Older engines ignore the unknown key.
  Cody's launch defaults are therefore one `PI_CONFIG_FILES` layer file per omp setting, nested keys only, listed in `CODY_LAUNCH_DEFAULTS_LAYERS` (`lib/omp/cody-launch-defaults.ts`; a test pins each entry to its YAML): `cody-launch-defaults.yml` (`display.shellVisualization: false`), `-async-widgets.yml` (`async.widgets: false`), `-computer.yml` (`computer.enabled: false`) `-intent-tracing.yml` (`tools.intentTracing: true`, since omp 19.0.0) and, since omp 19.2.0, `-cross-instance.yml` (`task.crossInstance: false`, which removes a prompt sentence about `agent://peers` that rpc-ui never serves; yields to an explicit `true`). A layer is dropped when config.yml explicitly sets that key to the OPPOSITE of the layer's value (`readPersistedBoolean(key) === !value`), so the first three yield to an explicit `true` and the intent-tracing layer yields to an explicit `false`; engines without the key ignore it. **Intent tracing** (`tools.intentTracing`, the one-line `i` field on every tool call that feeds the helper chips, `lib/plan-keeper/keeper.ts` and `lib/ask-result.ts` labels): omp 18.20.1 asked for it by default, omp 19.0.0 asks only in its own terminal and is silent in RPC, which would blank those labels, so Cody launches every chat with it on. Measured against a mock provider: +~730 bytes (~180 tokens) on the main prompt and +~620 bytes (~155 tokens) on a helper's per request, inside the cached prefix, plus ~10-15 output tokens per tool call; opt out with `tools.intentTracing: false` under `tools:` in config.yml (the Settings panel shows the Cody default as On).
- **A start can open a different copy of the chat (omp 18.13.2+).** When omp
  cannot keep writing a session file (another process holds it, or it changed
  underneath) it carries the chat on in a NEW sibling file. That file holds the
  whole transcript again and its header names the old session in
  `continuationOf`; resuming the OLD id then opens the NEWEST copy. So an id
  mismatch after a start is no longer only a new chat's temporary key.
  `startRpcSession` tells them apart by `sessionFile`: with one it is a resume
  that landed on another copy, so what the app files under the old id
  (`carryConversation`: owner, preset, Local-only snapshot, crash notices,
  scheduled messages, plan checklist, display/scratch aliases) is carried to the
  new id, never renamed (the old id still names a real, frozen file that a
  bookmark, a scheduled message or a tab may ask for again), and
  `getAliases().set(oldId, child)` makes a LATER start for the old id find the
  live child instead of opening a second one on the file the first holds.
  Aliases are consulted by `startRpcSession` only, never by `getRpcSession`:
  every read route keeps reading the old file by its own id. If the newest copy
  already runs under its own id the freshly started child is destroyed and the
  live one returned. A live move (`announceSessionMove`) sets the same alias,
  but only when the new file's header says `continuationOf === previousId`; an
  older omp writes no link, so its old file stays an ordinary chat. The events
  route emits `cody_session_moved {sessionId, previousSessionId, sessionFile,
  reason: "continued"}` when a stream asked for one id attaches to a chat that
  runs as another; `hooks/useAgentSession.ts` adopts the id and shows a one-time
  notice (`agentSession.sessionContinuedTitle/Body`). Tests:
  `lib/rpc-manager.test.mjs`, `lib/session-continuation.test.mjs`.

### Restarts and the prompt cache (`lib/browser-host-tools.ts`)
- **Cause (Cody's).** The browser tools `open_url`, `notify`, `open_file` (and URI scheme `pi-web`) used to be registered only by an attached browser. A chat with no browser at spawn (woken by `send_to_chat`, a schedule, a helper) started without them; a browser-woken one had them. The tool list in the system prompt, the `eval` description's "Session tool names", and the tool catalog therefore flipped between two shapes at consecutive restarts, and each flip re-wrote the whole chat into the 1 h cache (cache write, 2x price) instead of reading it (0.1x). Real chats showed the same +-165 system tokens / +-15 tools alternation and an `xdev-mount-notice` adding those three tools after restarts. Replay of Nov 13-24: 49 losses after 4-60 min idle = 18.5M cache-write tokens; 44 (~17.3M) had a changed system-prompt digest.
- **Fix.** `lib/browser-host-tools.ts` is the single roster (browser hook and server import it). `AgentSessionWrapper` seeds `hostTools`/`hostUriSchemes` with it, publishes the URI schemes at `initialize()` and on relaunch (not for the sidebar/minimal profile), and `set_host_tools` keeps the fixed roster first and only appends extras. With no browser listening, a call is refused at once (`rejectUnexpectedHostTool`: "No Cody window is open on this chat right now ..."); the model knows the same tools every time. CHANGING a description or schema in that file changes every chat's prefix once: do it rarely.
- **Proved** on real omp 19.1.0 with a fake Anthropic server and all Cody extensions plus launch-default layers: the same roster at every start gives byte-identical system blocks, tools and message prefix across restarts. After a restart, a roster missing the browser tools changed the system prompt and tool list in some runs and only added a tail notice in others (omp's timing decides, which is why real chats flipped only some of the time); the test's control therefore compares two fresh engines given the two rosters, where the difference shows in the opening message. Test: `lib/omp/restart-cache-prefix.test.mjs` (rpc-lab restart: `lab.restart({ resume })`, request bodies in `mock.requests`).
- **Not explained.** Other, smaller prompt-size deltas at restarts (about 100-1000 tokens, plus 2-6 k ones) are not individually identified. Device tools (`device_list` always; USB/BLE tools only while a browser has granted hardware) depend on attached hardware and were left alone because they change what the model can do.
- **Keep-warm: decided against (2026-11).** omp warms an idle chat only within 30 min and never for the 1 h tier (`cache-warmer.ts`: `MAX_IDLE_WARMING_AGE_MS`, 15 % continuation); its only RPC is `set_cache_warming {off|streaming|idle}`, no warm-now. Cody destroys an unattended child after `IDLE_DESTROY_MS` (10 min), so pinging every ~50 min needs a live child per chat for hours, which breaks idle disposal and the process budget, and Cody holds no model token to ping itself. Replay (21 main Anthropic chats, 949 idle gaps over 5 min, 5 that never came back; ping cost 0.1 of the context): best case 4.9 % of all spend (6 pings, 300 min horizon); one ping at 50 min gets 3.9 % of it (31.4 M of 804 M input-equivalent tokens); 20 pings/1000 min gets 34 M; 30 pings/1500 min 27.9 M. Most of the 5-60 min gaps were the flip fixed above, so the real remaining gain is smaller. Revisit only if omp gains a warm-now command.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): navigates the entry tree within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.
- **Fork from here** (footer of a reply, omp 18.4.11+): omp's own `fork {entryId}`, sent as the web command `fork_session` (never `fork`, which is `branch` above). It KEEPS everything through that reply (a cut inside a tool-call batch is extended through its results) and the artifacts; this live process moves onto the new file like a branch, and the page follows through `onSessionForked`. `parentSession` is the parent's file path.
- **Duplicate chat** (a session row's menu, ⌘K): `fork_session` with no entry, a whole-chat copy (`parentSession` is the parent's bare id; the sidebar links both forms). It works on a chat with no live child — the route starts one first. omp only forks an IDLE chat, so the wrapper refuses up front while it is running and omp's own `session_busy` reads the same (`fork.busy`); the controls are disabled or hidden while it works. An `Unknown command`/`unsupported` answer hides both for the page (`lib/fork-session.ts`); pi and ACP never offer them (`useForkAvailable`: omp only).

### ToolCall field normalization
Sessions store toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and streaming event handling.

### Event protocol differences vs pi
omp emits no `prompt_done` / `prompt_error` / `compaction_start` /
`compaction_end` events. Completion is `agent_end` (`isTerminal !== false`),
and errors surface as failed RPC responses plus `notice` events.
omp 18.4.4+ DOES emit `queue_update {steering, followUp}` (queued message
TEXT, only when the snapshot changes) and `get_state.queuedMessages`;
`queuedMessageCount` still also counts advisor cards and next-turn messages
that the text lists leave out. Cody's queue rows come from its own delivery
ledger, which works on every omp, so these are forwarded and not rendered.
New frame types (`turn_start/end`, `notice`, `todo_reminder`, ...) must be
handled or safely ignored: `cache_warming_start/end` (idle prompt-cache
refresh) are forwarded without touching state; a `notice` may carry a
`source` — `session-persistence` at `warning` means the live session moved to
a new file (see "RPC session lifecycle"), at `error` a persistence failure;
`agent-end` a failed post-turn maintenance. `extension_ui_request`
`method:"ask"` is a structured multi-question dialog (answered with `answers`,
or `cancelled`; from omp 18.18.3 only an extension's `ui.askDialog` sends it, the model's own `ask` walks `select`/`input`/`editor` requests), and `method:"cancel"` retires an expired dialog.
**Mount notices are for the model, not the person.** omp announces `xd://`
tool roster changes twice: a `notice` (`source: "xdev"`, text
`xd://: mounted …; unmounted …`) and, persisted, an `xdev-mount-notice`
custom message whose `content` is a model prompt (`<system-notice>` plus every
tool's description) and whose `details` is `{added, removed}`. A fresh child
mounts every Cody host and browser tool, and from omp 18.7 the persisted one
is written for that spawn-time roster too, before the first user message.
Neither is ever a pop-up: tools mount all the time (Cody's host tools at every
start, `load_tools` toolsets on demand and again on resume), and one toast per
mount buried the phone screen (2026-11-13). The chat already shows the
`load_tools` call. Never toast the message `content`.

- **Manual compaction frames.** omp 18.13.3+ emits `manual_compaction_start` / `manual_compaction_end` for every manual compaction (typed `/compact`, extension, another tab). `hooks/useAgentSession.ts` shows the "compacting" banner from `manual_compaction_start` and settles from `manual_compaction_end` ONLY when this page has no `compact` request in flight (`compactRpcInFlightRef`); the page's own request still settles from its command response. Older engines send neither frame, so the page's own button behaves exactly as before.
- **Edit rejections (stale-tag edit failures).** omp 18.19 marks a rejected `edit` tool result with `details.errorKind` (e.g. `stale tag`). `lib/session-reader.ts` keeps `errorKind` on tool-result details; `MessageView.getEditRejectionReason()` shows it as an "error · stale tag" chip on the tool card; `countEditRejections()` in the hook totals them into `SessionStatsInfo.editRejections` (`lib/pi-types.ts`) which the Session stats list in `AppShell.tsx` renders as "Edit rejections". Absent on 18.8.3 → nothing shown.
- **Shell output notes (`lib/bash-output-meta.ts`).** `bashOutputNotes(meta)` turns omp 18.17+ bash result metadata (`elidedLines/elidedBytes`, `columnTruncatedLines`/`columnLimit`, `minimized`) into a typed list of notes; `BashExecutionView` in `MessageView.tsx` renders them under the card (`messageView.bashNote*` i18n keys) so a trimmed command output says it was trimmed instead of looking complete. `BashExecutionMessage.meta` carries the metadata (`lib/types.ts`). Nothing renders when the engine sends no metadata (18.8.3).
- **Narration blocks (assistant thinking with `narration: true`).** omp 18.12+ on Anthropic/Bedrock marks thinking blocks that are really prose to the user (`ThinkingContent.narration`, `lib/types.ts`). They are answer text, never thinking: `lib/message-display.ts` `isFinalAnswerBlock` counts them as answer and `groupHasThinking` does not count them as thinking; `MessageView.BlockView` renders them with `TextBlock` (never the collapsed thinking box) and `isLiveText` treats them as unboxed text; `lib/session-reader.ts` does not defer them when thinking is deferred; `ChatWindow.hasFinalAssistantAnswer` treats a non-empty narration as a final answer. Live frames carry whole message snapshots, so the flag arrives with the block. Engines without the field never set it, so behaviour there is unchanged.
**Notes for maintainers (omp 18.19 catch-up).**
- `agent_end` rewriting in `rpc-manager.handleFrame` only applies when `event.isTerminal !== false`: 18.19 sends `isTerminal:false` for an end followed by a continuation (steer, auto-retry), 18.8.3 always sends `true` (or omits it). Do not "simplify" it to always rewrite.
- A non-terminal `agent_end` can also mean "paused on background work" (`awaitingAsyncWork:true`, same frames on 18.20.1 and 18.22.2; Cody never sees a raw `agent_pause`). `pausedOnWork` is set then and cleared by `agent_start`, a terminal end, `settleAfterStop` or restart; `isRunning()` stays true. 18.22.2 also emits a non-terminal end after EACH failed auto-retry of an over-quota 429 and ends a paused run on `abort()`; 18.20.1 does neither.
- Engine builtin slash commands (`/unpin`, `/forget-approvals`, …) appear in the palette automatically (grouped as `engineBuiltin` in `ChatInput`); no per-command Cody code.
- Checked and left alone: `queue_update.liveSteered` (Cody never reads `queue_update`; `withdrawQueued`/`steerNow` already settle by trying the command and reading its boolean), `resumedToolCallIds` on `ready` (ignored; run-recovery's text nudge works on both engines), `live_connect` / `dictation_*` frames (the server has no microphone or WebRTC peer; `handleEvent` has no `default:` so unknown frames fall through harmlessly).

**Notes for maintainers (omp 19.0.0, what a chat does at run time).** Proved against the real 19.0.0 binary and a mock Anthropic server (frames and saved entries diffed against 18.20.1); 18.8.3 / 18.19 / 18.20 / 18.22 keep working through the same code.
- **Ask.** Same `xd://ask` call and result entries and same `extension_ui_request` frames as 18.20.1 (the RPC host still has no `formDialog`, so the field-by-field walk in `lib/ask-walk.ts` is unchanged). A steer sent while a dialog is open sends `extension_ui_request {method:"cancel"}` ("Ask interrupted by message"); a follow-up does not close it. `askWithdrawnByMessage` already treats 19.0.0 like 18.x. Real entries: `lib/fixtures/omp-19.0.0-ask-xdev-entries.json` (loops in `ask-result`, `session-reader`, `AskResultPanel` tests).
- **Waits and pauses.** Job, subagent and follow-up/steer-while-paused runs send identical frames on 18.20.1 and 19.0.0 (pause = non-terminal `agent_end {yielded, awaitingAsyncWork}`; wake = `agent_start`, an `async-result` custom message, the reply, a terminal `agent_end`). 19's standardized waits are `wait` calls, already in `WAITS_BY_DESIGN` (`lib/run-recovery/judge.ts`), so they cannot read as a stall. **Stop on a paused run differs:** 19.0.0 answers with an immediate terminal `agent_end {isTerminal:true, yielded:true}` plus `session_settled` and does NOT deliver the job's later result as a wake (like 18.22.2); 18.20.1 sends no frame and the later result still wakes the model. The terminal `agent_end` branch and `settleAfterStop` clear `pausedOnWork` on both, and no UI copy promises results after Stop.
- **`bash` `notify` (new).** A matching output line from a background bash job wakes an idle OR paused chat as a new turn: an `async-notify` custom message (`details.reports[]` with a job id each), the reply, then a paused `agent_end` again; the engine rate-limits it. The wake is an ordinary `agent_start`/terminal `agent_end` run to `lib/run-recovery/supervisor.ts` and the outbox. `lib/message-display.ts` folds `async-notify` into "Background activity" as kind `notification` (never needs review; identity = timestamp + report ids so a re-delivered copy replaces), and hides `eval-prelude-guide` (the model-only eval note) like `date-cwd-reminder`.
- **Handoff is background compaction.** The RPC `handoff` command now runs `compact(focus, {mode:"handoff"})`: `manual_compaction_start {mode:"handoff"}` / `manual_compaction_end` frames (18.20.1 sends none and blocks the RPC channel until done), the response (`data:{}`) comes AFTER the compaction, the chat stays responsive and `abort` cancels it ("Compaction cancelled"). The compaction banner already follows `event.mode`; no Cody control sends `handoff` (`handleHandoff` in `useAgentSession.ts` has no caller) and a typed `/handoff` is an engine builtin on both. Compaction entries (`method: "handoff" | "soft"`, `tokensBefore/After`) and `model_usage` notes read the same for the burn guard (`lib/fixtures/omp-19.0.0-burn-trail.jsonl`, test in `burn-trail.test.mjs`).
- **Thinking level across `set_model`.** 18.x re-applied the NEW model's default level after `set_model` (`thinking_level_changed` followed); 19.0.0 keeps the chat's level and only clamps it when the model cannot take it (the clamp emits `thinking_level_changed`, and the clamped value sticks on a switch back). Cody follows both through `model_changed` / `thinking_level_changed` and a `GET /api/agent/<id>` re-read (`adoptThinkingLevel`); `lib/model-switch/switch.ts` still sends `set_model` then `set_thinking_level`. Comments saying "omp re-applies the new model's default level" are 18.x-only. A preset with no level suffix therefore keeps the chat's previous level on 19.
- **Composer predictions** (`composer.predictions`, on by default in 19) are read only by omp's terminal; the RPC host never reads them and sends no extra request after `agent_end`. `predict_word` / `predict_word_feedback` (Cody's word completion) is a separate engine feature, unchanged. Nothing to switch off; the Settings panel lists both settings as terminal-only.
- **`artifact://N` became `local://N.log`.** Spilled tool output now lives in `<session>/local/N.log` and the footer says "Read local://N.log" (18.x: `<session>/N.bash.log`, `artifact://N`; old sessions keep theirs). Cody renders tool output text verbatim and resolves neither scheme (only the `artifactId` fields in `lib/pi-types.ts`), so both spellings display the same; `session-files.ts` archive/delete moves the sibling directory whole, `local/` included. A user `!bash` full-output link is unaffected: on both engines the RPC `bash` response has no `fullOutputPath` for an 8 MB output (`bashExecution.meta.truncation` only), so `lib/bash-output.ts` keeps its `pi-bash-*.log` whitelist for engines that do spill.
- **Subagents.** `before_subagent_spawn` is unchanged and still fires on 19.0.0: with a pending switch file the helper's request ran on the switched model while the main chat stayed on its own, and the entry was consumed (`lib/omp/extensions/cody-agent-switch.ts`, proved live on both engines). 19 starts a helper with three auxiliary "solution space" requests, exactly as 18.20.1 does.
- **Cache warming frames and bridge compaction.** `cache_warming_start/end` gained `phase`, `method`, `provider`, `model`, `outcome`, `usage` and `warmingStopReason`; omp 19's new strategies (`providers.cacheWarmingStrategy`: `auto` default, `keepalive`, `compact`; `providers.cacheWarmingCompactPercent` 60 / `...CompactTokens` 150000) can also compact the history in the background behind a pending long tool call (a `remote` or `handoff` summary armed during the wait and committed at the next boundary, `session-maintenance.ts startBridgeCompaction`). Cody treats the frames as informational (`rpc-manager.handleFrame`, `supervisor.ts`), and the burn guard reads only assistant `usage` and `compaction` entries (any method), so a warming replay is not a request and a bridge compaction is one ordinary entry that frees most of the context. [INFERENCE] none of this was triggered live (the lab never lets a cache expire, a bridge needs a 4-minute tool call); from the source a bridge cannot repeat until the context regrows to the threshold, so it cannot look like `churn`.
- **Extension messages.** None of Cody's extensions calls `pi.sendMessage`: they use hidden `before_agent_start` notes (`display:false`, model-facing on purpose), `additionalContext` or `pi.appendEntry`, so omp 19's `excludeFromContext` has nothing to apply to. A future person-only note must pass it behind a version check (18.x ignores the field and would show the model the note).

**Notes for maintainers (omp 19.1.0, what a chat does at run time).** Proved against the real 19.1.0 binary and a mock Anthropic server (19.0.0 diffed alongside); frames and files are in `lib/fixtures/omp-19.1.0-{approval-records,redirect-job,retry,wait}.json`, replayed by `lib/omp-19.1-runtime.test.mjs`. 19.0 / 18.x keep working through the same code.

- **Approval records.** 19.1 writes `custom` entries `tool_approval_requested` (`data:{toolCallId, parentToolCallId?, toolName, approvalMode, reason?, requestedAt}`, flushed to disk BEFORE the prompt opens) and `tool_approval_resolved` (`data:{toolCallId, toolName, approved, reason?, resolvedAt}`; reason "denied by user", an abort text or "no interactive UI available"). A request with no resolution or tool result after it is pending. 19.0 writes neither. The RPC prompt (`extension_ui_request` `select`, "Allow tool: bash\nCommand: ...", Approve / Approve bash for this session / Deny) is identical on both, and Cody's own chats already surface it as `awaitingInput` through `pendingUiRequests` → `hasPendingInput()`. `session-reader` ignores every `type:"custom"` entry, so nothing renders. **Not built:** "waiting for approval" for a chat Cody is NOT streaming. The file alone cannot tell a live wait from a crashed one; the only liveness probe is the new `omp session lease --json -- <id>...` (or RPC `get_session_lease`), which needs a child spawn plus a tail scan of every session per refresh, and Cody has no notion of sessions held by outside omp processes.
- **Redirected background jobs.** The "live visibility" of 19.1 is in-process (`proc://<id>/streams`, the TUI jobs sheet). The RPC frames are the 19.0 frames: `tool_execution_update` for an async bash job carries `partialResult.content[0].text` = what the command printed to the terminal (empty while a redirected loop runs) and `details.async {state, jobId, type}`. The redirected bytes are in no frame and no RPC command lists jobs, so `LiveToolTail` shows an empty tail for such a job, exactly as before. No change.
- **Retries.** Frames are unchanged (`auto_retry_start` gains `errorId`, `auto_retry_end` gains an always-present `retryErrors[]`); "failed attempts stay out of the transcript" is the TUI only (`event-controller.ts`). A failed attempt still arrives as an assistant `message_end` with `stopReason:"error"` BEFORE `auto_retry_start`, and the file keeps it; once the saga settles omp stamps the attempt `retryRecovery {kind:"auto-retry", status:"recovered"|"superseded", attempt, recovery, note}` (a field 19.0 wrote too). **Cody change:** `entryToUiMessage` skips such an attempt when its `usage` is zero (the provider refused before answering), because the UI's cost total sums the rebuilt messages; one that cost something stays. A dropped connection mid-stream is a silent retry with NO `auto_retry_*` frames: one error `message_end` + `turn_end` + a non-terminal `agent_end` (no `isTerminal`) + `agent_start` per attempt, one terminal `agent_end` at the end. The supervisor and burn guard read the same frames/file as on 19.0 (`burn-trail.ts` counts every assistant entry with usage, stamped or not). Provider-layer retries (HTTP 5xx/529 inside the SDK) emit nothing at all. A retry wait can now last up to `retry.maxDelayMs` (30 min default) in silence: under the 60 min silence verdict, and the 10 min probe is answered by the engine.
- **`wait`.** The 4-minute first wait is the interactive TUI (`tuiTranscript`); on rpc-ui the first call still returns after 5 s ("No job finished within 5.0s") and back-to-back idle waits climb to 240 s (jobs) or up to 30 min (a helper's reply). `wait` stays in `WAITS_BY_DESIGN` (`lib/run-recovery/judge.ts`); nothing changed.
- **omp 19.1.1 (patch; audited on the real binary, nothing needed changing in Cody's run-time code).** Frames, tool order (`read, bash, edit, ask, eval, glob, grep, task, wait, todo, web_search, write`), the `get_state` keys and the system prompt (apart from the per-request `cch=` hash) are identical to 19.1.0; `pi-wire` is unchanged. What did change, with the files that pin it:
  - **`ask` refuses a fieldset whose radios each carry their own `name`** (each radio would be a group of its own, so two options could both be answered). The refusal happens in the engine BEFORE any form request: no `extension_ui_request` is sent, no dock opens, and the tool result is an ordinary one (`isError:false`, `details:{answers:[]}`, text starting `Error: a <fieldset> holds radios that each carry a different \`name\``) that the model reads and answers with a corrected form. The card shows the call and that text (zero answer rows). 19.1.0 sent the form. Cody changed nothing; recorded in `lib/fixtures/omp-19.1.1-ask-split-radios.json`, pinned by the last two tests of `lib/ask-form-transcript.test.mjs`. One-name-per-question forms still arrive as a form request on both engines. The answered round trip on 19.1.1 was not driven (the lab client rewrites the response id), only the request.
  - **Sessions:** assistant messages may carry `requestId` (Anthropic's `request-id` header; no reader needs it); `model_change.model` is written as `provider/id@upstream` only when an upstream pin is active (`formatModelStringWithRouting`). Cody never pins an upstream (`set_model` sends provider and modelId only), and Vertex ids legitimately contain `@date`, so `lib/statistics/scan.ts` does NOT strip an `@suffix`; a chat on a pin set in `config.yml` roles would count under the suffixed model name. Restored sessions publish failed `async-result` rows for background bash jobs whose outcome is unknown; empty-stop retries are logged only, not written.
  - **Shutdown:** rpc-mode also disposes the local MCP host. Measured with a `sleep 600` MCP server: both 19.1.0 and 19.1.1 leave the server running after the RPC child exits, because it belongs to the shared MCP daemon (`mcp.shared`), so nothing observable changed under Cody. Exit took 55-245 ms on both.
  - **Errors:** a 402 billing error is now a usage-limit error and a stream stall is a timeout in omp's retry/fallback classification (pi-ai); Cody reads the same frames.
  - **Per-request cost:** the tool descriptions grew, measured on the real binary with every Cody extension and launch default: tool JSON 21,120 to 21,586 bytes (+466, about 115 tokens) per request, request body 35,461 to 35,927 bytes. `ask` +281 (one `name` per question), `eval` +133 (timeout wording), `read` +44, `bash` +8. It is static prompt text with no setting that removes it, so it is reported, not neutralised.
  - **CLI outputs** (`ps --all --json`, `plugin list --json`, `gc --help`, `gc --blobs|--strip --json`, `usage --help`) are byte-identical to 19.1.0 on an empty agent dir. `omp gc` gained a WAL checkpoint busy-timeout option (default unchanged). Corrupt `agent.db` recovery now salvages readable credentials.

- **omp 19.2.0 (minor; audited on the real binary; four Cody changes, below).** Frames, tool order (`read, bash, edit, ask, eval, glob, grep, task, wait, todo, web_search, write`) and the `get_state` keys are unchanged; the wire schema only gained the bash result fields `movedCwd` / `errexit` and the session event names `config_warnings_changed`, `advisor_cost_changed`, `advisor_yielded` (all three exist in 19.1.0's wire already; Cody ignores event types it does not handle). The request prefix is still byte-identical across a restart (`lib/omp/restart-cache-prefix.test.mjs` passes on 19.2.0). Files that pin each point:
  - **`ask` no longer refuses a form answer that breaks `required` / `pattern` / `min` / `max` / `minlength` / `maxlength` / number or email shape.** The TUI flags the field and the answer is sent on; 18 of the 77 recorded verdicts flipped from `Form field "x": Required`-style errors to accepted text (`lib/fixtures/omp-19.2.0-ask-form-cases.json`, recorded by replaying every case of the 19.1.0 file on the real binary; shape errors, unknown names, disabled options and the 19.1.1 split-radio refusal are unchanged). Cody's port holds the rules behind `enforceRules` (`parseFormSubmission` / `formDataError` / `submitError`); `askFormEnforcesRules(version)` in `lib/ask-walk.ts` turns it off from 19.2 and the form view (`components/AskHtmlForm.tsx`) then flags a broken field as you type and still sends. 19.1 and earlier keep holding the answer back, because there it fails the model's tool call. Tests: `lib/ask-form.test.mjs` replays both fixtures, `lib/ask-form-view.test.mjs` the view's side, `lib/ask-walk.test.mjs` the gate.
  - **`--no-tools` is strict and cannot be combined with `--extension`** (`CliUsageError`: "--no-tools cannot be combined with --extension, -e, --hook, or --trusted-extension"; no extensions, MCP, memory or goal/plan mode load). Cody sends `--no-tools` for the smallest local profile (`minimal`) and for an empty tool preset, next to its `--extension` flags, so on 19.2 those chats would not start at all. `buildEngineRpcLaunch` now leaves the extensions out of a `--no-tools` launch when the resolved binary's package is 19.2 or newer (`engineRefusesExtensionsWithNoTools`; an unreadable version counts as older, so 19.1 launches are unchanged); the config layers still apply. The one-shot model-plan runs use `--no-tools --no-extensions` and are unaffected. Test: `lib/rpc-manager.test.mjs` "omp 19.2 refuses --no-tools next to --extension…".
  - **The settings loader reads 19.2's new file layout.** 19.2 moved imports from `@oh-my-pi/pi-tui/*` to relative in-package modules, which the schema loader stubs, so five things silently regressed until `lib/omp/package-source.ts` was taught: tab labels now live in `src/ui/overlays/settings/pages.ts` (`SETTINGS_PAGES`, merged in as `TAB_METADATA`), and `levels.ts` (the `auto` thinking level), `frame-rate.ts` (`tui.maxFps`), `advisor-config-types.ts` (`advisor.syncBacklog`, which looked removed) and `tree-selector.ts` (`treeFilterMode`) join `SETTINGS_DATA_MODULES`; key hints in descriptions (`ui/keys/hints.ts`) come from a small synthetic module so "cleared with Ctrl+C" no longer reads "cleared with  in". See settings.md "Settings in omp 19.2.0".
  - **Behaviour with no Cody change.** Interrupting with queued input now moves a running `bash`/`eval` to the background instead of cancelling it (`detachTools`). Rewind / Edit / Retry in the omp terminal branch into a new session again; Cody's rewind uses RPC commands that did not change. Sessions gain `model_change.fallback` and a `tan-fork-boundary` custom entry (ignored by the reader). `eval.tools.enabled` now defaults to off (Cody never reads it), and `task.crossInstance` now defaults to on (neutralised, below).
  - **Per-request cost** (real binaries, a fake Anthropic server, every Cody extension and launch default): main chat system text 10,850 to 13,536 bytes and tool JSON 21,754 to 22,273, request body 36,238 to 39,443 (+3,205 bytes, about 800 tokens at 4 bytes a token); a `task` helper 33,297 to 34,272 (+975, about 245 tokens). Most of it is static prompt text (the "work statically, verify once" guidance; `ask` +348, `eval` +190, `read` +44, `bash` +40 in the tool descriptions; `task` -103) with no setting. The one part a setting removes is the `agent://peers` sentence that `task.crossInstance` (default on since 19.2) adds: omp binds the agent mesh only for its terminal UI, so under rpc-ui it was only wasted tokens. `lib/omp/cody-launch-defaults-cross-instance.yml` turns it off (a fifth launch layer, dropped when `config.yml` sets the key to true): -145 bytes (about 36 tokens) per request, main and helper alike. Net against 19.1.0 after the layer: main +3,060 bytes, helper +830 bytes.
  - **CLI outputs** (`ps --all --json`, `plugin list --json`, `gc --help`, `gc --blobs|--strip --json`, `usage --help`) are identical to 19.1.0 on an empty agent dir (only the temp path differs).

### Tool commands in the transcript (omp 19.1)
- A tool run as a command is a `bash` toolCall. The card names the tool (`toolCommandCall` in `lib/tool-command.ts`): from the result's `details.toolCommands` record when it has one, else only for an `mcp__*` first word of one simple command, so a Cody host tool shows as `bash` until its result arrives. `RunningToolInfo.name` stays `bash` (the status line and tail logic depend on it). Old `xd://` calls keep rendering as plain `write` cards.
- The mount notice is `source: "toolCommands"` / `Tool commands: added …` live and a `tool-command-mount-notice` custom message in the file (~3.3 KB, before the first user message). Both are hidden (`isToolMountNotice`, `HIDDEN_CUSTOM_TYPES`), like omp's older `xdev` forms.
- History keeps a bounded `{tool, mode, exitCode}` projection of `details.toolCommands` for `bash` results (`stripToolResultDetails` in `lib/session-reader.ts`), never the arguments or the MCP payload.

### Long tool calls narrate themselves
- `tool_execution_update` frames are handled, not dropped: the newest text
  line a tool streams about itself lands on the running-tool state
  (`RunningToolInfo.statusText`), and `tool_execution_start` stamps
  `startedAt`. The chat status line and the pending-tool headers append that
  line plus an elapsed clock once a call runs past ~8s
  (`LONG_TOOL_THRESHOLD_MS`, ChatWindow).
- The motivating case: omp's `gh` tool `run_watch` — usually invoked as a
  `write` to the `xd://github` tool device — blocks for an entire GitHub
  Actions run while polling (3s then 15s intervals), streaming a "Watching
  GitHub Actions Run #N" snapshot per poll. Without the update wiring that
  call renders as a frozen "write xd://github" for many minutes and reads as
  a hang. Contract-tested in `hooks/useAgentSession.test.mjs`.
- **Trap — the ticking clock must not ride the crossfade.** The status line
  renders through `StatusTextCrossfade`, which re-animates on ANY text
  change; folding the per-second elapsed tick into that string made the
  whole line flicker every second. The clock renders as a plain sibling span
  (`phaseElapsed`, tabular digits); only real status changes crossfade.

### Live tail on the running-tool card (`lib/live-tool-output.ts`)
What omp 19.0.0 streams during a long call (proved on the real binary with a mock model):

- **Foreground `bash`**: `tool_execution_update` per output chunk (~50 ms throttle), `partialResult.content[0].text` = the WHOLE output so far, capped at 50 KB (head + elision + tail, so the tail is always the newest). Cody's launch config (`display.shellVisualization: false`) also removes the ~625 KB `details.trace` omp otherwise attaches to every frame. A 1 line/s build is ~1 frame/s of 0.4-1.5 KB; a very chatty one ~13 frames/s of up to 53 KB.
- **Async `bash`** (`async:true`): start and end arrive ~10 ms apart (result "Backgrounded as job bg_N"); `tool_execution_update` for the SAME `toolCallId` then keeps coming, even after the non-terminal `agent_end`, with `details.async = {state: "running"|"completed", jobId, type}`.
- **`run_on_worker`** (an extension tool, `lib/omp/extensions/cody-run-on-worker.ts`; any chat or helper that has a shell): the extension posts to `/api/internal/workers` and relays the route's NDJSON progress as tool updates; `lib/workers/progress.ts` text = a headline line plus up to 20 newest output lines, ≤2/s plus a 5 s refresh. Earlier it was a host tool (`host_tool_update`), which only the main chat could hold. Read from code, not run through a live Cody.
- **Helpers** (subagent level `progress`): only `subagent_progress` (~1 KB, ~1/s) with `currentTool`, `currentToolArgs` (command, ~100 chars), `currentToolStartMs`, counts, tokens. **No tool output.** omp only forwards `tool_execution_update` for nested `task` calls.

What Cody does with it:

- Server: `ToolUpdateThrottle` (in `rpc-manager`) slims each frame (`slimToolUpdateFrame`: last 8 KB of text, `details.async`, no `args`) and sends per call at most one frame per 250 ms (leading edge + trailing flush; a finished job flushes at once; `tool_execution_end` settles).
- Page: `LiveToolOutputStore` (one per chat hook, provided via `LiveToolOutputContext`, read by `useLiveToolOutput(id)`) keeps the newest 24 lines of ≤240 chars per call, notifies at most every 250 ms, drops entries on `tool_execution_end` / end of run (async jobs stay while they stream, then linger 8 s after "completed"). Max 12 entries. Nothing goes into messages, the transcript cache or the model.
- UI: `LiveToolTail` under the card header, outside the collapsible panel, fixed height (4 rows, 14 expanded), shown only after a call has run 1.2 s. The footer carries a pulse dot, label, `ElapsedClock` (its own 1 s interval, never inside `StatusTextCrossfade`) and an expand chevron. The status line skips the bash last-line text while the card draws the tail (`phaseLabel(phase, cardShowsTail)`); other tools keep it, moving at most every 2 s.
- Helpers: chips append `HelperToolClock` after 8 s of one tool; the transcript dialog shows a "Running now" strip (tool, intent, command, clock) from the roster's `progress`. Clock start = `currentToolStartMs` when plausible against the page's clock, else first sight (`helperToolStart`).
- Limits: the clock counts from when THIS page first heard of the call; a reload loses the tails of running foreground calls (async jobs refill on their next update); the page only ever sees `tool_execution_update` while subscribed, so a helper's own bash lines are never available.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

After the page was away (hidden >= 5 s, offline, bfcache restore, OS resume, clock jump) `usePageWake` (`lib/page-wake.ts`) fires ONE debounced event (800 ms) and every live surface refetches or reconnects from it: `useAgentSession` runs `refreshChatAfterWake` (reconcile if a run was active, reload the session, re-attach the live engine, reset the reconnect budget); the sidebar reloads sessions, projects and worktrees; usage, scheduled messages, statistics and display requests refresh. The sidebar's `/api/agent/running/events` is opened by `openLiveStream` (`lib/live-stream.ts`): it opens again after a refusal (2/5/15/30 s backoff) and when the server's 30 s heartbeat is silent for 75 s; a wake calls `reopen()` at once. A bare `EventSource` reads OPEN through a dead network and never reopens after a 502, which is why pages left on a phone went stale. New live surfaces use `usePageWake`, never a private `visibilitychange`/`focus`/`online` listener.

### A viewed session stays warm, and a closed one never leaves a deaf stream
- **Idle disposal skips a session with an attached event stream**
  (`resetIdleTimer`). A cold child costs a spawn (~2.7 s) plus omp's first-
  prompt preparation (~4 s, measured: the memory backend's first recall), so
  disposing the chat a user is looking at turned their next message into a
  ~7 s wait before the agent even started.
- **Every close is announced** (`EngineSession.onClose`, both the omp wrapper
  and `AcpEngineSession`): idle, `restartIdleRpcSessions` after a settings
  save, a crash. The events route ends its stream on it, after sending
  `retry: 1000`, so the browser reconnects within a second and that reconnect
  starts the replacement child. Before this, a stream stayed subscribed to
  the dead wrapper, the next POST spawned a new one nobody listened to, and
  the page sat on "Sent" until a manual refresh showed the agent had moved on.
  An auto-reconnect re-registers host tools and re-checks the outbox.
- **The tool roster is sent only when it changes** (`publishHostTools`,
  signature-deduped, forced for a fresh child). `device_list` is always
  published; the working hardware tools follow the granted-device count and
  are withdrawn only after `DEVICE_TOOLS_RELEASE_GRACE_MS`. `device_list`
  used to follow the browser's device socket, which flaps on every reload,
  session switch and backgrounded tab: each flip re-sent the roster to omp's
  one-at-a-time command line (delaying a send queued behind it) and printed
  "xd://: unmounted device_list" / "mounted device_list" into the transcript.
- **Status reads coalesce** (`COALESCED_READS`: `get_state`, `get_subagents`).
  While one is waiting its turn in omp's queue, an identical ask joins it. The
  page's pollers (15 s reconcile, stream watchdog, turn-end refresh, the
  subagent dialog, the plan keeper) otherwise stacked dozens of copies during
  a stall, which the child then worked through one by one ahead of the next
  prompt.
- **A steer into a running turn takes no workspace checkpoint.** It exists to
  interrupt, the workspace is mid-edit anyway, and it must not wait on a full
  `git add -A` of the workspace before it reaches omp. Prompts that start a run
  and mid-run follow-ups still snapshot as before.
- **omp can freeze for minutes on its own databases.** Measured: after a turn,
  omp's post-turn memory work waited ~4.5 min on a locked `agent.db`
  (`SQLiteError: database is locked` in `~/.omp/logs`); bun's SQLite waits
  synchronously, so the child answered NO command meanwhile — `get_state`,
  `get_subagents` and the next prompt all queued. Cody cannot unlock it; the
  bounded ack (202 pending), the ledger poll and the dedupe above are what keep
  the UI truthful through it. Check those logs first when "Sending…" lingers.
- **`mnemopi.proactiveLinking` freezes a session after every reply.** omp's
  memory ingest (`pi-mnemopi` `EpisodicGraph.ingestMemory`, linkExisting)
  scores each new memory against EVERY stored one on the engine's JS thread.
  Measured on the owner's instance (omp 18.3.4, ~10k memories, 20.6 M
  `graph_edges` rows, 5.2 GB `mnemopi.db`): each `agent_end` froze the whole
  child — main agent AND in-process subagents, every transcript silent for
  the same 3 min 14 s — so a message sent then sat at "Sending…". Off by
  default in omp; Settings shows a Cody note on it (`SETTING_NOTES`). The
  symptom to recognise: all of a session's subagent `.jsonl` files go quiet at
  the same second and resume at the same second.

### RPC transport limit — the utility process MUST negotiate v2
- omp's NDJSON transport caps one logical frame at 1 MiB. At protocol **v1** it
  cannot chunk, so it replaces any oversized reply with a failed response
  carrying `"RPC response exceeded the transport limit"`. Protocol **v2**
  chunks (`lib/omp/rpc-frame.ts`, reassembled by `RpcProcess`).
- `get_available_models` grows with the provider catalog: measured 502 models /
  1,058,841 bytes on a real install (466 from a single OpenRouter key) — just
  over the limit. The session path always negotiated; `lib/omp/rpc-utility.ts`
  did not, so `/api/models` failed and the composer showed a bare "Model error"
  banner with an empty list. **Both** `startProcess` and
  `runIsolatedUtilityCommand` now negotiate; `rpc-utility.test.mjs` guards it.
  Engines that do not advertise v2 are never sent the command, so a restricted
  dialect (pi) still starts.

