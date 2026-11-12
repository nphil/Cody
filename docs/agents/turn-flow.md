# Turn flow: sending during a run, todo reminders, plan keeper, native goals

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Todo reminder: quiet, and never over a question
- Live plan keeper (`lib/plan-keeper/`)
- Sending during a run: one pipeline, an outbox, and no silent drops
- Native goals (`lib/goal-state.ts`, `components/GoalPanel.tsx`)

### Todo reminder: quiet, and never over a question
omp auto-continues an unfinished todo list after a terminal turn (unless its
own last-line check says the agent asked something) by appending a
`role:"developer"` message wrapped in `<system-reminder>` and emitting
`todo_reminder`. Cody cannot stop the append, so it handles both halves:
- **Pause when the agent asked the user.** `lib/reply-question.ts`
  `replyAsksUser` scans every prose line of the last reply — questions, line
  start cues, hand-offs anywhere in a sentence ("…, then tell me", "let me
  know", "say \"next\"", "your call", "want me to", "should I"), and a
  user-action section ("What you need to do:", "Your turn", "Next step for
  you", "Action needed") that has real content under it. A section that
  says "nothing"/"none" does not count; fenced/inline code, quoted text and
  self-directed lines ("I'll tell the agent…") are ignored. rpc-manager's
  `todo_reminder` case aborts the continuation on a hit and emits the info
  notice ("Waiting for your reply — the agent's task list is on hold.").
  Bias: a false pause costs the user one "continue"; a miss lets the agent
  run on as if they had answered — keep new cues tied to a boundary (line
  start, sentence punctuation, "and/then/please") so mid-clause mentions
  don't fire.
- **Render it as a slim row, not a bubble.** `lib/system-reminder.ts`
  `foldSystemReminder` turns an omp developer message that is entirely a
  `<system-reminder>` into a `custom` message: `customType:"todo-reminder"`
  (todo reminders, `details` = `{count, attempt, max, items[{text,depth}]}`)
  or `"engine-note"` (any other reminder, e.g. tool-use). It runs at BOTH
  boundaries — `entryToUiMessage` (session-file load) and the live
  `message_end` branch in `hooks/useAgentSession.ts` — so the row is the same
  live and after reload. `MessageView`'s `EngineReminderRow` shows one
  collapsed line ("Reminded the agent about 26 open tasks (2 of 3)") with a
  chevron to expand the list; it is hidden in the "hidden" activity mode. Any
  other developer message (e.g. the post-compaction "Resume…" nudge) keeps the
  plain labelled bubble. A `custom` message with `display:false` (omp's
  hidden extension messages, e.g. the `eager-todo-prelude` nudge) is the
  engine talking to the MODEL, so it renders as the same collapsed "Engine
  note" row, never as a bubble.

### Live plan keeper (`lib/plan-keeper/`)

**Live plan keeper (`lib/plan-keeper/`).** One `PlanKeeper` per live rpc
session, created by `RpcSession.getPlanKeeper()` and fed from `handleFrame`:
`tool_execution_start` (args) and `tool_execution_end` (result), assistant
`message_end`, hidden `custom` messages of type `async-result`,
`launch-completion` and `rewind-report`, `subagent_lifecycle` terminal states,
`turn_end`, `agent_start` and `auto_compaction_end` (`notifyListRebuilt`), and
the terminal `agent_end`. It keeps a numbered activity log (60 entries, 16,000
characters; a tool entry is `tool (intent · command) => head … tail of the
result`, engine boilerplate removed) and asks omp's `smol`, then `tiny`, then
the engine default (through `runOneShotModel` in the isolated one-shot agent
dir, 45 s limit) which open tasks the log proves finished. Pace: 2 s debounce,
30 s between model calls during a turn, an immediate pass at turn end, never two
at once, one retry after a failed call. The model answers
`{done:[{id,entry,quote}], subtasks, subtasksDone, labels, summaries}`; tasks
are named by id (`T1`…), and `evidence.ts` decides what is applied: the id or
one clearly closest rewording, the quote found in the log (the cited entry
first; a single word only there), and for
verify/test/gate/publish/release/deploy tasks a pass or a push in that entry
with no later failure of the same check. Proof must be newer than the task
(`taskSince`).

A tick is written to the engine with `set_todos` AND recorded in
`cody-plan/<sessionId>.json` (`autoCompleted`, keyed `phase\0task`). The engine
keeps `set_todos` in memory only and rebuilds its list from the session file
after a compaction, restart or rewind, so `syncEngine` runs first in every pass
and on `notifyListRebuilt` to put ticks back. Rules that must hold: read the
list fresh immediately before writing; change only the status of the tasks being
ticked; never reorder; when the agent's own `todo` call lands around a write,
rebuild on its result (`rebaseOnto`); the agent's `todo` results, read off the
wire in `noteAgentTodo`, withdraw a tick the agent reopened, removed, re-added
or re-planned. Every list Cody serves applies the overlay (`applyPlanOverlay` in
`buildWebState` and `GET /api/sessions/[id]`). `fold.ts` is pure and shared by
server, browser and keeper: `buildPlanView` lays the list out (phase headings
with counts, current phase open, finished phases one line, folds of 3+ finished
tasks once a phase has more than 8 done or the list more than 15 rows, at most 3
per phase, never an open task) and `planFoldsToSummarise` names the folds that
still need their line. The overlay also holds `labels` (short text for tasks
over 60 characters) and `folds` (summary and task count, keyed by the fold's
first task). The keeper fails soft: any failure applies nothing. Tests:
`lib/plan-keeper.test.mjs`, `components/TodoList.test.mjs`.

omp 18.19.0 removed the todo status `blocked` and the `blocker` text; it reads an
old blocked task back as `pending`. Cody keeps accepting both (`TodoItem` in
`lib/pi-types.ts`, `parseTodoPhases` in `lib/session-reader.ts`, the plan keeper
and `TodoList`) because omp 18.8 still sends them and old chat files contain
them; 18.19 simply never produces one. The keeper already treats `blocked` as an
ordinary open task, so nothing in it relied on a "blocked is untouchable"
guard. `lib/plan-keeper-engine.test.mjs` runs the keeper's `set_todos` check-off
against a REAL engine (`CODY_OMP_BIN`, scripted local model server, throw-away
agent dir) and covers both versions: an engine restart keeps the tick on 18.12.4+
(the engine saves `set_todos` edits as a `user_todo_edit` entry) and loses it
on older engines (the keeper puts it back), and a list holding a blocked task
is accepted on both.

### Sending during a run: one pipeline, an outbox, and no silent drops

Three owner reports shared one root: the composer guessed whether a turn was
running, and every wrong guess lost a message. Enter during a turn left the
text in the box, a steer "hung" and then showed up after a refresh, and a
second Enter was silently ignored while the first was in flight.

- **The engine decides, not the client.** An existing session is sent a
  `prompt` with `streamingBehavior` ("steer" | "followUp", from the Settings
  submit-during-run preference). omp starts a run when idle and queues the
  message when streaming. The wrapper marks `promptRunning` for the idle case
  exactly as it does for a plain prompt. A plain `prompt` without
  `streamingBehavior` sent while omp is streaming is ACKED and then fails
  asynchronously with AgentBusyError on an already-settled id, so the message
  vanishes. Never send one to an existing session.
- **Every send carries a `clientMessageId`**, and the session wrapper keeps a
  bounded delivery ledger for at least 30 minutes. Status moves monotonically
  through `queued`/`started` to `delivered` or `failed`; repeat POSTs with the
  same ID join the original delivery instead of sending a duplicate.
  An ack is `{ delivery: "queued" | "started", clientMessageId, status?: "delivered" }`;
  the optional status prevents a late ack from re-adding a delivered message.
  Only SETTLED rows age out (an hour) or yield to the cap: a row the engine
  has not finished with (`sending`/`queued`/`started`, `isUnsettledDelivery`)
  lives as long as the wrapper, because a follow-up can wait behind an
  all-night run, and a pruned row reads `unknown` — the scheduler and a
  resuming page would then send it a second time.
- **Resume checks the server before retrying.** The browser asks
  `GET /api/agent/<sessionId>?clientMessageId=<id>` for each unfinished outbox
  entry. The response is `{ deliveries: [...] }`; known entries adopt their
  ledger status. Only unknown IDs are checked against the loaded transcript
  (timestamp, text, and image count); a match settles the entry, otherwise the
  browser retries with the same ID. A failed ledger lookup never triggers a
  blind resend.
- **Manual Retry checks before resending.** A known queued/started/delivered
   result is adopted. A known server failure or an unknown ID absent from the
   loaded transcript starts a new delivery with a fresh ID; an unknown ID that
   matches the transcript is already delivered. Resume retries absent entries
   with their original ID. A client timeout is only a guess; server failure is
   final unless later delivery is proven.
- **Delivery changes arrive by ID.** The wrapper emits `cody_delivery` SSE
  frames with `clientMessageId` and status. A user `message_end` still renders
  the message, but it does not settle an outbox row by text.
- **OMP 18.3 prompt_result is correlated by RPC ID.** Structured failures are
   surfaced once and deduped against the transcript; an aborted queued prompt
   fails rather than claiming it was read. A terminal `agent_end` settles a
   started send as delivered; engine loss settles started as delivered and
   queued as failed. A joined all-mode user message and an image-only user
   message can both prove delivery from the transcript.
- **The route waits a bounded time for the ack** and answers 202
   `pending` while the command stays in flight. Automatic transport and resume
   retries keep the ID; manual Retry follows the ledger-first check above. A
   steer, follow-up or queued-prompt ack timeout never recycles the child: only
   the idle plain-prompt no-ack path may, because nothing was running to lose.
- **omp serializes ordinary RPC commands** (`RpcInputDispatcher`), so one slow
  command delays every later one, `get_state` included. (omp 18.4.9 runs
  `prompt`, `steer_subagent`, `bash` and `predict_word` off that line: a
  prompt still being admitted no longer holds up `get_state`, `abort`, `steer`
  or `follow_up` behind it, though it still STARTS after earlier serial
  commands such as a long `compact`.) GET routes therefore
  bound `get_state` and fall back to the wrapper's last known state plus the live
  flags it tracks itself, marked `stale`, instead of hanging a session switch
  behind someone else's command.
- **Client outbox** (`lib/outbox.ts`, sessionStorage per session). The composer
  clears immediately; each message moves sending → queued/started → delivered,
  or ends failed with Retry and Edit (Edit restores text and images). Retries on
  network error, 202, 409 `session_restarting` and 503 back off up to 2 minutes,
  then stop at failed. Nothing is ever dropped without a visible row; unfinished
  entries resume only after the ledger-first check above.
- **A chat whose saved model is gone** (omp 18.6.3+ exits `--resume` with
  `error: Could not restore model <provider/id>` when the saved model no longer
  exists or has no credentials; 18.4.x silently fell back). `rpc-process.ts`
  turns that stderr line into `ModelUnrestorableError`; `startRpcSession` turns it
  into `WebRpcError` code `model_unrestorable` `{provider, modelId}` (HTTP 400,
  the details are forwarded by `agentCommandErrorResponse`), and the events
  route sends it as a `model_unrestorable` frame, then ends the stream (the
  client closes its EventSource, otherwise the browser reopens it every second).
  The outbox classifies it as `blocked`, NOT retry and NOT failed: the row stays
  `sending` with `blocked: true`, reads "Waiting for a model" with a clock icon,
  and the optimistic bubble is undone. `ModelRecoveryBanner` (ChatWindow) says
  "This chat used X, which is no longer available" and offers the current
  catalog (composer visibility honoured; the chat's Smart default pre-selected).
  The pick calls `POST /api/agent/[id]/recover-model`, which respawns ONCE with
  `--model provider/id` (`restoreModel`) and then `set_model`s — `--model` alone
  does NOT write the session's `model_change` entry, so without that later plain
  restarts would fail again. Then the hook reconnects the stream and
  `releaseBlocked` sends every held entry under its own id (fresh retry budget).
  Viewing a chat never spawns the engine, so the notice is reactive (first send
  or stream attach); scheduled sends surface it as a non-retryable delivery error.
  Traps found live: (1) the `connected` frame starts a ledger lookup whose
  "unknown" answer sends the reload recovery to match the on-screen transcript
  against unsent entries — and the OPTIMISTIC bubble matches, so a message still
  being sent was marked delivered and a refused one vanished. Entries this page
  sent and still owns (`sending`, `outboxLiveIdsRef`) are skipped
  (`idsNeedingResumeCheck`). (2) The banner can arrive (events frame) before the
  message's own 400, so `noteModelUnrestorable` blocks every `sending` entry
  (`blockWaiting`) and takes the unconfirmed optimistic run down (no "Waiting for
  model…" spinner or Stop); a refusal for an attempt that began before the pick
  (`modelRecoveredAtRef`) is stale and re-sends. (3) After the pick the composer's
  model comes from `setCurrentModelOverride` + `refreshLiveModelState`, not the
  session file read when the chat opened. The picker is `components/ui/Select.tsx`
  (searchable), never a native `<select>`.
- Brand-new-session prompts and SidebarChatPanel sends also enter the same
   outbox. Queue rows are derived from outbox state. The composer snapshots and
   clears text, images and files before preparation; preparation failure restores
   the snapshot if the composer is still empty, or keeps it in a failed Edit row
   alongside any newer draft.
- **A delivered user message always renders.** `message_end` with role `user`
  is appended even when the client believes no run is active (the old
  `agentRunningRef` guard dropped steers that landed after a missed
  `agent_start`). The transcript is deduped against the loaded messages;
  `cody_delivery` independently settles the matching outbox entry by client ID.
- **Steers go to the engine at once; only follow-ups are held.** A follow-up
  sent mid-run (or behind follow-ups still held) waits in the wrapper's
  `heldQueue` — editable, deletable, handed back on Stop — and goes out when
  the run ends, with a 1 s guard that re-checks until the hold is empty. A
  steer is never held: omp delivers it into the reply it is streaming (live
  steering), cuts a tool batch short, or reads it at the next step. The 0.41
  hold kept a steer typed while the model was only WRITING until the whole
  reply finished, and then sent it as a brand-new prompt.
- **Agents use the same two lanes.** `send_to_chat` (`lib/chat-messages/`) maps
  `urgency` one to one: `next_step` is the steer, `after_turn` the follow-up
  (`streamingBehaviorOf`, the one place the mapping lives). A steer lands at the
  engine's next step boundary, so the sender is told "next step", not "now": a
  tool batch in progress finishes first, and a non-live-steering provider reads
  it when its reply ends. Measured on 52 agent-sent steers: median 8 s, p90
  106 s, worst 157 s, against a median of 27 min for the same messages sent as
  follow-ups through `schedule_message`.
- **"Steer" is a real interrupt, and only of the model's reply**
  (`steer_now`, `AgentSessionWrapper.steerNow`). The button shows on a held
  follow-up AND on a steer the engine has queued but not read (the agent is
  still thinking or writing — non-live-steering providers such as Anthropic
  only read a steer when the reply ends). A held follow-up is first handed
  over as a steer. Then, if no tool is running, the wrapper sends omp `abort`
  WITHOUT the Stop latch: omp restores undelivered and live-steered messages
  to its steering queue on abort, and a queued steer bypasses its
  post-interrupt suppression, so it continues straight into the steer. That
  aborted run's terminal `agent_end` is forwarded as NON-terminal (the page
  keeps its run, held follow-ups are not flushed ahead of the steer); if no
  `agent_start` follows within `STEER_CONTINUATION_GRACE_MS` the end is
  replayed as real. While a tool runs nothing is aborted (`next_step`): omp
  already lands the steer at the batch end and asks backgroundable bash/eval
  to detach, and subagents are separate sessions an abort never touches. A
  follow-up the engine already holds is first promoted to omp's steering queue
  (`promote_queued_message`, omp 18.4.6+), which makes it an ordinary queued
  steer; an omp without that command keeps the old refusal (`not_steer`),
  because after an abort it would leave the follow-up waiting. A user Stop
  clears a pending steer interrupt.
- **Stop takes the queue back** (`abortRestoringQueue`, omp 18.7+ `abort_and_restore_queue`).
  A plain `abort` makes omp carry on into EVERY queued steer and follow-up in a
  new run (measured: five more model calls). The 18.7 command withdraws every
  user-authored queued message first — input a run took but never recorded
  included — then aborts, and answers `{steering, followUp, imagesDropped?,
  truncated?}` oldest first: omp's own text (raw, whitespace kept, `[Image]`
  for a picture-only message) and its own re-encoded images. The web `abort`
  sends it when the engine has it; an `Unknown command` answer is remembered
  (`queueRestoreUnsupported`) and falls back to the plain abort, as pi does.
  `steerNow`, the stop latch, the todo pause and `abort_compaction` keep the
  plain abort: they WANT the queue to run. Everything a Stop gives back leaves
  in ONE `cody_queue_returned` frame (`messages`, `truncated?`,
  `imagesDropped?`) with the held follow-ups merged in by send order
  (`lib/queue-restore.ts`), so the composer takes one draft. The composer gets
  omp's text and images, never the ledger's; a ledger row only decides WHICH
  row becomes `withdrawn` (exact submitted text, then trimmed, then the
  picture-only stand-in; the same queue first), and a message no row accounts
  for still comes back. A `queued` engine row omp did not hand back is in no
  queue any more (cut from an oversized answer, or read an instant before), so
  it is failed with Retry/Edit — a `steer`/`follow_up` send gets no
  `prompt_result` to say so. omp reports each withdrawn `prompt` `aborted`
  before OR after the answer, so while the restore is in flight
  (`stopRestore`) those results are deferred instead of failing rows the
  answer is about to withdraw. `truncated`/`imagesDropped` become notices
  (`stopQueue.*`).
- **Delete and Edit reach into omp's own queue** (`AgentSessionWrapper.withdrawQueued`).
  A message Cody still holds is simply dropped from the hold. One already
  handed to the engine is taken back with `remove_queued_message` (omp
  18.4.4+; `queue` is `steering` for a steer or a promoted follow-up,
  `followUp` otherwise) and `withdrawn:true` returns its text and attachments
  for Edit. omp finds a queued message by the text **as submitted** (it keeps
  the raw text from before slash/template expansion), never the trimmed ledger
  `text`, so a ledger row keeps a `submitted` copy (message + images) only
  while it is `queued` and never in a snapshot. `removed:false` /
  `promoted:false` mean omp already read it (`already_sent` / `already_read`);
  an `Unknown command` answer from an older omp keeps today's answers
  (`already_sent` / `not_steer`). Since 18.4.6 the ack means ADMITTED, so a
  `queued` row really is in omp's queue. The page still offers Delete/Edit
  only on held rows (`ChatInput` `editable`), so engine-held rows need that
  gate loosened before users can reach this. omp 18.7 also returns the pictures
  it queued (`images`, its own copies; `imagesDropped` when an oversized answer
  left them out): Edit gets those, or the ones the message was sent with when
  omp has none.
- **A missed frame cannot strand a row.** While any outbox row is `queued`
  or `started`, the client re-reads the ledger every 3 s
  (`OUTBOX_LEDGER_POLL_MS`, a map lookup on the server, never an engine round
  trip). The ledger client accepts `withdrawn` and `held`: rejecting
  `withdrawn` used to fail the WHOLE lookup, silently.
- **A run the page did not start gets its own run id.** A held follow-up
  handed over at `agent_end` starts a run server-side; `agent_start` with no
  run believed active bumps `promptRunIdRef`, so the previous run's terminal
  reload cannot land on top of the new one.

### Native goals (`lib/goal-state.ts`, `components/GoalPanel.tsx`)
- **omp 18.4.11+ owns the goal; Cody mirrors it.** The engine creates it, counts
  the tokens and seconds spent on it, pauses it on Stop, persists it in the
  session file and (optionally) keeps working on it. Three carriers share one
  shape (`GoalModeState`): `get_state.goal`, the `goal_updated` frame and the
  `{goal, state}` answer of the `goal` command (`op`: get|create|resume|pause|
  drop; `token_budget` only on create). `lib/goal-state.ts` is the pure reading
  of all three (parse, `adoptGoal` reducer, elapsed/age maths, `/goal` and
  budget syntax, controls per status, continuation-mode helpers); it imports
  only `type-guards`.
- **The `goal` KEY in `get_state` is the capability probe**, never a flag:
  `buildWebState` passes `goal` (and `goalAgeMs`) through only when the engine
  reported the key. Absent = older omp (answers `Unknown command: goal`), pi
  (restricted vocabulary) or ACP (`send()` refuses unknown commands) — all of
  them refuse `goal` as `unsupported` before anything is sent. `/goal` tries
  the native create first and, on `isUnsupportedCommandError`, falls back to the
  old web-hosted behaviour (expanded prompt + sessionStorage note, shown in the
  same panel as a dismissible note; a `--budget` is dropped with a notice).
  Never write the sessionStorage goal when native works.
- **State is folded, never overwritten** (`adoptGoal`): the engine stamps every
  change (`updatedAt`), reports can race (a state poll answered from cache vs a
  frame), so the newest stamp wins; a `complete` goal never goes back to
  working; a `dropped` one leaves nothing; and the engine CLEARS a completed
  goal's state at the turn's terminal `agent_end` WITHOUT an event (`get_state.goal`
  becomes `null`), so `null` must not erase the finished card — it stays, with
  what the goal cost, until dismissed or a new goal starts. The terminal
  agent_end, `reconcileAgentState` and `loadSession` all adopt `state.goal`.
- **Time ticks locally between flushes**, and the engine counts IDLE time too
  (wall clock while the goal is active, flushed only when something happens),
  so the server stamps `goalAgeMs = now - goal.updatedAt` (it shares the
  engine's clock) and `goalElapsedSeconds` adds age + time since receipt.
  Tokens move per tool completion / turn end (that is when the engine flushes).
- **A chat nobody is running still shows its goal**: `buildSessionContext`
  derives `context.goal` from the newest `mode_change` entry on the branch
  (`goal` / `goal_paused` / `none`; `goalFromPersistedMode` maps an active goal
  to paused, which is what omp does when a process reopens the file). The live
  state wins; the file only decides when `GET .../state` says `running:false`.
  Resume/Drop on such a goal spawn the engine first like any command.
- **Hidden steering never draws a row**: omp sends `goal-mode-context` before
  EVERY turn while a goal is active, `goal-continuation` between auto-continued
  turns and `goal-budget-limit` at the budget as `display:false` custom messages;
  `isHiddenFromTranscript` hides all three (they would be two "Engine note" rows
  per turn).
- **"Keep working automatically" = `goal.continuationModes` + `rpc`**
  (`hooks/useGoalAutoContinue.ts`). omp's default is `["interactive"]`, so a goal
  driven from Cody only works when you send a message. The switch adds/removes
  `rpc` through the ordinary config writer WITHOUT `applyNow`: a running engine
  watches config.yml (directory watch, 200 ms debounce, atomic renames fine) and
  re-reads the setting at every continue decision — verified live: flipping it
  mid-chat makes the next turn end continue — while `applyNow` restarts idle
  children and an engine that starts up PAUSES an active goal. It is one global
  setting (every chat), and nothing starts by itself when it is switched on for an
  idle active goal (the engine decides only at turn end / create / resume), so
  `kickGoal` waits for the file watcher and then does pause + resume (`resume`
  is a no-op on an enabled goal). Any child restart (routing change, idle
  recycle, `applyNow` from another control) pauses an active goal: the panel
  shows it paused with Resume.
- **`/goal [--budget N] <objective>`** (also mid-run — ChatInput routes it to the
  dispatcher while streaming): `goal create` then the objective as the first
  prompt, sent as a STEER (with rpc continuation on the engine starts its own turn
  the moment the goal exists; the steer folds into it, never races it). `N` takes
  `200000`, `200k`, `1.5m`, `200,000`. A scheduled `/goal` still carries the
  expanded prompt (`GOAL_PROMPT`, no native goal). Budget-limited goals offer only
  Drop (resume is a no-op, the budget cannot be raised over RPC).
- The panel starts collapsed while active and opens itself for paused /
  budget-limited / complete (they wait on a decision); Drop needs a second tap
  within 4 s. `lib/web-mode-state.ts` keeps `ActiveGoal` only for the fallback.

