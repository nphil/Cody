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
  Cody's launch defaults are therefore one `PI_CONFIG_FILES` layer file per omp setting (`lib/omp/cody-launch-defaults.yml` for `display.shellVisualization`, `lib/omp/cody-launch-defaults-async-widgets.yml` for `async.widgets`, nested keys only); each layer is dropped when config.yml explicitly sets that key to true, and engines without the key ignore it.
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
Only an MCP server's tools (`mcp__*`) changing is news: `describeMcpMountChange`
(lib/mount-notice.ts) words the toast from `details`, and the `notice` path
drops every non-MCP line. Never toast the message `content`.

- **Manual compaction frames.** omp 18.13.3+ emits `manual_compaction_start` / `manual_compaction_end` for every manual compaction (typed `/compact`, extension, another tab). `hooks/useAgentSession.ts` shows the "compacting" banner from `manual_compaction_start` and settles from `manual_compaction_end` ONLY when this page has no `compact` request in flight (`compactRpcInFlightRef`); the page's own request still settles from its command response. Older engines send neither frame, so the page's own button behaves exactly as before.
- **Edit rejections (stale-tag edit failures).** omp 18.19 marks a rejected `edit` tool result with `details.errorKind` (e.g. `stale tag`). `lib/session-reader.ts` keeps `errorKind` on tool-result details; `MessageView.getEditRejectionReason()` shows it as an "error · stale tag" chip on the tool card; `countEditRejections()` in the hook totals them into `SessionStatsInfo.editRejections` (`lib/pi-types.ts`) which the Session stats list in `AppShell.tsx` renders as "Edit rejections". Absent on 18.8.3 → nothing shown.
- **Shell output notes (`lib/bash-output-meta.ts`).** `bashOutputNotes(meta)` turns omp 18.17+ bash result metadata (`elidedLines/elidedBytes`, `columnTruncatedLines`/`columnLimit`, `minimized`) into a typed list of notes; `BashExecutionView` in `MessageView.tsx` renders them under the card (`messageView.bashNote*` i18n keys) so a trimmed command output says it was trimmed instead of looking complete. `BashExecutionMessage.meta` carries the metadata (`lib/types.ts`). Nothing renders when the engine sends no metadata (18.8.3).
- **Narration blocks (assistant thinking with `narration: true`).** omp 18.12+ on Anthropic/Bedrock marks thinking blocks that are really prose to the user (`ThinkingContent.narration`, `lib/types.ts`). They are answer text, never thinking: `lib/message-display.ts` `isFinalAnswerBlock` counts them as answer and `groupHasThinking` does not count them as thinking; `MessageView.BlockView` renders them with `TextBlock` (never the collapsed thinking box) and `isLiveText` treats them as unboxed text; `lib/session-reader.ts` does not defer them when thinking is deferred; `ChatWindow.hasFinalAssistantAnswer` treats a non-empty narration as a final answer. Live frames carry whole message snapshots, so the flag arrives with the block. Engines without the field never set it, so behaviour there is unchanged.
**Notes for maintainers (omp 18.19 catch-up).**
- `agent_end` rewriting in `rpc-manager.handleFrame` only applies when `event.isTerminal !== false`: 18.19 sends `isTerminal:false` for an end followed by a continuation (steer, auto-retry), 18.8.3 always sends `true` (or omits it). Do not "simplify" it to always rewrite.
- Engine builtin slash commands (`/unpin`, `/forget-approvals`, …) appear in the palette automatically (grouped as `engineBuiltin` in `ChatInput`); no per-command Cody code.
- Checked and left alone: `queue_update.liveSteered` (Cody never reads `queue_update`; `withdrawQueued`/`steerNow` already settle by trying the command and reading its boolean), `resumedToolCallIds` on `ready` (ignored; run-recovery's text nudge works on both engines), `live_connect` / `dictation_*` frames (the server has no microphone or WebRTC peer; `handleEvent` has no `default:` so unknown frames fall through harmlessly).

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

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

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

