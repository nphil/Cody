# Chat automation: cross-session messaging, scheduled messages, overnight runs

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Cross-session awareness (`lib/session-tools.ts`)
- Scheduled messages (`lib/scheduled/`)
- Overnight runs: stalls, crashes and restarts carry on (`lib/run-recovery/`)

### Cross-session awareness (`lib/session-tools.ts`)

One conversation regularly needs to know what another is doing, and Cody is
the only party that can answer: an engine's own agent hub sees nothing but its
own subagents, while Cody holds the live child registry AND every transcript
on disk. Three read-only tools, in every session's tool list:
`list_sessions` (what exists, what is running, when it last moved),
`session_status` (one session's live phase plus its newest message; with no
argument, every running session) and `read_session` (a condensed transcript,
paged). A main chat also gets `send_to_chat` and `message_status` (below).

- **Addressed by the NAME the user set.** An exact session id wins, then a
  case-insensitive substring of the name; more than one match returns the
  candidate list rather than picking one. Guessing which conversation was
  meant and then reporting on it is a far worse failure than asking, because
  nothing downstream can tell it happened.
- **Snapshot-only, never a wait.** A tool that blocked until another session
  finished would tie up the caller's own turn on a run it cannot influence.
  "Poll it" is a call the model repeats; the module promises nothing more.
- **Phase comes off the registry, not a round trip.**
  `getLiveSessionPhases()` reads each wrapper's own flags
  (`EngineSession.livePhase?.()`, optional because an ACP session cannot break
  "running" down and reports just that). Asking the other child over RPC is
  exactly what must not happen: the session being asked about may be wedged,
  and awaiting it would hang the asker.
- **Ownership is the boundary, and an UNOWNED caller is the trap.** Listings
  go through `filterSessionsForUser` so an inaccessible session's id or title
  is never enumerated, and every single-target read re-checks
  `canAccessSession`; blocked and missing answer identical text. A main
  session has no request behind its tool calls, so the acting account is the
  session's OWNER (`getSessionOwner` → `findUserById`). When a session has no
  recorded owner (pre-accounts, terminal-created) `user: null` would mean
  "sees everything", so it is paired with `restrictToUnowned`, which limits it
  to other unowned sessions. Both the host-tool path and the internal route
  compute it the same way: `user === null && hasAnyUser()`.
- **One declaration, two callers.** The sidebar appends
  `SESSION_AWARENESS_TOOLS` verbatim instead of re-declaring the schemas — a
  second copy is how the sidebar and the main chat start describing the same
  tool differently. The main chat gets a larger page
  (`MAIN_SESSION_RESULT_CHARS`, 24k) than the sidebar's
  smallest-window-assumption budget; both still report a continuation offset.
- **ACP engines reach them over MCP** like the display tools:
  `POST /api/internal/sessions` (capability-token authenticated, on
  `proxy.ts`'s `PUBLIC_EXACT` list for the same reason display is) with
  the three tools declared in `bin/cody-display-mcp.js`. The route trusts
  `capability.sid` alone — a body may name any session id, but it must match
  the token, and the caller's identity is derived server-side from it.
- **Sending to another chat: `send_to_chat` / `message_status`**
  (`lib/chat-messages/`). Before them the only way to reach another chat was
  `schedule_message`, a follow-up that waits out the target's whole turn: measured
  over 121 real cross-chat messages (2026-11), median 27 min, p90 5.8 h, worst
  9.6 h, every slow one parked behind one long turn. `send_to_chat {session,
  message, urgency}` takes the composer's own path (`delivery.ts`): `next_step`
  (default) is `prompt` + `streamingBehavior: "steer"`, which the wrapper sends
  straight to the engine, so a running turn reads it at its next step and an
  idle chat starts a turn on it; `after_turn` is the follow-up, held in
  `heldQueue`. A chat with no live child is started with `acquireSession` in the
  owner's zone, as the scheduler does. The target sees one header line before
  the sender's words naming the sender chat's title and id, saying an agent sent
  it with no user authority, and how to answer (`send_to_chat` back); senders no
  longer type their own "not Nitin" disclaimer. The tool returns a `msg_…`
  delivery id at once and waits at most 15 s, and only for the engine to TAKE the
  message (never to read or answer it); a slower engine leaves the record
  `sending` and the delivery finishes in the background.
  `message_status` reads the TARGET wrapper's delivery ledger by
  `clientMessageId` `chat-<id>` (queued / started / delivered / failed /
  withdrawn; queued + held = `after_turn`), falls back to the transcript
  (`ref msg_…` is in the header) when the ledger row is gone, says `lost` when
  neither has it, and says whether the target answered with `send_to_chat`
  (marked when the target sends back after READING the message). Resolution and
  ownership are `resolveSessionArgument` / `mayRead` exactly as for the other
  session tools (a chat the caller may not see, and a delivery id between such
  chats, answer like a missing one). Limits (`CHAT_MESSAGE_LIMITS`): 32 KB, 20
  sends per sending chat per 10 min (two agents answering each other would never
  stop), and the low-disk gate (`checkDiskForNewTurn`: refused unless it is a
  steer into a turn already running). The delivery ledger is in memory
  (`globalThis.__codyChatMessages`, 500 ids, 24 h) like the engine's own and does
  not survive a restart. Main chats only (the sidebar's schema budget is a small
  model's); ACP engines call the same handlers through `POST
  /api/internal/messaging` (`bin/cody-display-mcp.js`, capability token, on
  `proxy.ts`'s `PUBLIC_EXACT`, trusting `capability.sid` alone), and
  `bin/cody-display-mcp.test.mjs` fails on drift. An ACP engine runs one turn at
  a time: a busy chat takes a `next_step` message only if it advertises steering
  and refuses `after_turn`, with a sentence telling the sender to resend.
  `lib/chat-messages/delivery.ts` is imported lazily from `tools.ts` (delivery
  imports the session manager, which imports the tools).

### Scheduled messages (`lib/scheduled/`)

The Send button's ▾ menu and the agent's own tools put a message into a chat
LATER: at a chosen time, or when the chat's own model's quota refills. When it
is due it is an ordinary user turn — nothing about the chat is special-cased,
and nothing repeats (one-off, by design).

- **One store, one timer** (`store.ts`, `scheduler.ts`). The store is
  `cody-scheduled.json` in the instance data dir (0600, atomic; every change is
  one synchronous read-modify-write, so a cancel and a claim cannot both win).
  `startScheduledSender()` / `stopScheduledSender()` run from
  `bin/cody-server.js` beside the quota watch. The timer is armed for the NEXT
  moment something can happen (an item's time, a retry's back-off, a quota
  re-check) — never on a fixed cadence — is `unref`'d, and sleeps at most a
  minute, because Node's timers do not count time a suspended machine spent
  asleep. A message due while the server was down is sent on boot (3 s after
  start); one found `sending` at boot was interrupted and goes back to waiting
  as an attempt. Different chats are served side by side, one chat's messages
  in the order they were due.
- **Delivery is the composer's own path** (`delivery.ts`): the chat's child is
  started if none is alive (`acquireSession` in `lib/session-acquire.ts`, in
  the OWNER's zone; shared with run recovery), then a `prompt` with
  `streamingBehavior: "followUp"` (a chat mid-turn holds it until the turn
  ends) and a `clientMessageId` that is stable for the life of one delivery
  (`sched-<id>[-<n>]`), so a retry rejoins the wrapper's ledger instead of
  sending twice; a retry after a crash also looks for its own message in the
  transcript first. A send that could not be handed over retries on a back-off
  (15 s, 1, 3, 10, 30 min), then stays `failed` for the person — Retry, Edit or
  Cancel; an engine's own refusal is final at once. A message is sent exactly
  once: it is claimed (`pending` → `sending`) before delivery and removed only
  once the chat has STARTED it. Sent and failed both notify the owner (the
  `scheduled` kind: progress group, on by default, priority 3; `notify.ts`).
- **Queued is not delivered.** A chat that is mid-turn only HOLDS a follow-up
  (the wrapper's in-memory `heldQueue`, or omp's own queue), and an engine loss
  or a server restart takes the hold with it: two overnight check-ins were lost
  exactly that way on 2026-10-08. So a send that comes back queued keeps its
  item `sending` with `handedAt` and the exact `handedClientMessageId`
  (`isHandedOver`), and every round asks the live wrapper's ledger about it
  (`checkHandedOver`, never starting a session; re-read every 30 s,
  `HANDED_CHECK_MS`): started/delivered → removed and "sent"; still queued →
  waits; withdrawn (the person's Stop handed it back to the composer) → removed
  silently; failed → retried under a fresh id (that wrapper memoizes the old
  id's outcome); unknown or no live wrapper (engine replaced, server restarted)
  → retried on the usual back-off, transcript check first. The composer row
  reads "waiting for the current reply to finish…" (`schedule.rowWaiting`).
  An engine without a ledger (ACP) keeps the old rule: a taken send is
  delivered.
- **A message may carry its own model** (`ScheduledModelChoice`: provider, modelId,
  optional thinkingLevel — `types.ts`; stored on the item as `model`). The
  composer's ▾ menu has a Model row (below), an agent's `schedule_message` takes
  `model` + `reasoning`. Create NEVER calls a model: it validates the shape, the
  engine is not asked, nothing is spawned (the quota read is a usage read and the
  chat-model fallback is a transcript read). At DELIVERY `putChatOnModel`
  (`delivery.ts`) switches the chat with the same `switchChatModel` the composer's
  and the agent's switches use (`lib/model-switch/switch.ts`: model first, then
  reasoning), and only then sends the prompt. Nothing is approximated: a switch
  the engine refuses (model gone, credentials gone) fails the message with the
  engine's reason and the message is NOT sent on another model; a switch that is
  `deferred` (the chat is mid-turn) leaves the message waiting; a chat already on
  the model and level sends straight away. `PATCH` with `model: null` takes the
  choice away (the chat's own model again).
- **"When quota resets"** is about THE MODEL THE MESSAGE GOES OUT ON: the chosen
  `model` when there is one, else the chat's own — the composer sends the one it
  shows (`chatModel`), an agent's call asks the chat (`resolveChatModel`) — and
  the account that model is on (`planQuotaForChat`: the same ranking the ring
  uses). So "carry on on Opus when Sonnet's quota is spent" waits for OPUS and
  works even when the chat's own model has nothing left. Nothing goes before the
  reset; then a FRESH usage read must say the model is usable (`judgeQuota`: a
  provider that reports nothing counts as usable, a read that did not happen
  does not), re-read every 3 minutes; a later reset the provider names is slept
  until; 24 h after the reset it waited for, it gives up as `failed`. **A model
  whose provider names NO reset time is no longer refused**: the item is stored
  with `quota.unknownReset` and keeps waiting — first check immediately, then
  every 3 minutes — and is given up on 7 days after it was scheduled
  (`QUOTA_UNKNOWN_RESET_GIVE_UP_MS`), with a reason that says "waiting 7 days"
  rather than "24 hours after the reset". A reset over 30 days away is still
  refused up front (`no_quota_reset`, now only when the usage read itself is
  unavailable).
- **Limits, in one place** (`types.ts` `SCHEDULED_LIMITS`; the routes, the tools
  and the composer all read it): 20 waiting per chat, 100 per account (the
  chat's owner's), a time within 30 days and not in the past, 64 KB a message.
  A failed message is kept 7 days. Ownership is the boundary: every route goes
  through `access.ts` (a chat of another account, a sidebar chat and a missing
  chat all answer the same 404) and a tool through `resolveSessionArgument`.
- **Agents schedule too** (`tools.ts`): `schedule_message`, `list_scheduled`,
  `cancel_scheduled`, written once. omp gets them as server host tools
  (`SCHEDULE_TOOLS`, merged into every MAIN chat's `set_host_tools` beside the
  session tools; the sidebar chat is not offered them — its schema budget is a
  small local model's). ACP engines reach them over MCP: three tools in
  `bin/cody-display-mcp.js` calling `POST /api/internal/scheduled`
  (capability-token authenticated, on `proxy.ts`'s `PUBLIC_EXACT`, trusting
  `capability.sid` alone like `/api/internal/sessions`);
  `bin/cody-display-mcp.test.mjs` fails when the bridge's copy of a name,
  schema or description drifts from `tools.ts` (the bridge's copy also carries
  `model` and `reasoning`, and `list_scheduled` lines show "on <model>"). The
  target chat is a name or id resolved with the ownership gate; `model` is resolved HERE with `lib/model-switch/resolve.ts` (a name or part of
  one, never a guess: several matches schedule nothing and list the candidates;
  an unknown name lists the closest; `reasoning` must be a level that model
  offers and needs `model`) against the models of an engine that is already
  running — the chat's own, else the caller's; scheduling never starts one, and
  with none running it says so and schedules nothing; `at` without an offset is read in the
  OWNER's zone; results use `formatToolTime`. The descriptions teach what the
  tools are for (continue after a quota reset, run a job at a set time, check
  back on CI) and that the message arrives as a normal user turn. A message the
  agent scheduled is marked "by the agent" in the composer. The operator's
  user RULES.md carries one line telling every session and subagent the
  capability exists. `schedule_message` to ANOTHER chat is a follow-up and waits out that chat's
  whole turn; its description points agents at `send_to_chat` (Cross-session
  awareness) for "tell that chat now".
  `schedule_message` now takes an optional `model` (and `reasoning`, which needs
  `model`), resolved with `lib/model-switch/resolve.ts` against the target
  chat's catalog; a scheduled item that names a model is switched with
  `switchChatModel` (scope chat) just before delivery. For a later switch ("back
  to Sonnet at 1am") the agent schedules a message with `model` set; the
  `switch_model` description teaches exactly that. `switch_model` itself changes
  things once, now.
- **The composer** (`components/SendPill.tsx`, `ScheduleMenu.tsx`,
  `ScheduledBar.tsx`, `hooks/useScheduledMessages.ts`). The Send pill gains a
  joined ▾ zone (+22 px on a desktop, +24 px on a phone, where Send stays an
  icon); the ▾, a right-click and a long press (450 ms, touch/pen) on Send open
  the menu — a popover on a mouse, a bottom sheet with 48 px rows on a touch
  screen. Choosing a row schedules at once and clears the box (the same
  snapshot/restore as a failed send, `restoreComposer`); only "Pick…" asks for a
  Schedule press. The menu has a **Model** row under the time rows
  (`components/ScheduleModelPicker.tsx`, state and words in
  `lib/scheduled/model-ui.ts`, all tested): "Same as chat" (the default —
  "Currently <name>") or any model of the composer's own catalog (pinned models
  first, one group per provider, search over everything), and — once a model
  that has a reasoning ladder is chosen — chips "Default / Low / … / Max" built
  from the SAME per-model levels the composer's reasoning control reads
  (`modelThinkingLevels`, passed down from `ChatWindow`). Choosing a model
  re-validates the level (kept when the new model offers it, else Default).
  "Send now" and "Pick…" carry the choice too. "When quota resets" there reads
  the CHOSEN model's quota (`scheduleChosenQuota` in `ChatInput`) and its reason
  text names that model. The request body carries `model` (the choice) and
  `chatModel` (what the composer shows, for a quota wait with no choice).
  Editing a message puts its model back in the menu. The queued-messages bar
  shows a small model chip (icon + display name, id when the catalog knows no
  better; tooltip: the full `provider/id` and level) on a row only when a model
  was chosen (`describeScheduledItem` → `modelLabel`, `modelTitle`). A row that cannot work is OFF with its reason, never hidden:
  an empty box or attachments still preparing, a chat that does not exist yet,
  images attached, a `!` shell line (a scheduled message arrives as a plain
  prompt, so the command would reach the model as text), or no reset time
  known. "Tonight 11 PM" disappears once it has passed. The queued messages are
  ONE slim full-width bar above the composer (the Tasks/Agents bars' look: icon ·
  title · detail · chevron), collapsed by default: "2 scheduled · next 9:30 PM",
  "1 scheduled · 9:30 PM · <first words>", "waiting for the current reply…", and
  in the error colour "1 failed to send" (it never opens by itself). The words
  come from `summarizeScheduled` (`lib/scheduled/ui.ts`, tested). Opened it is a
  list (max height, scrolls) with one row per message: time, "by the agent", the
  text ellipsised, and icon buttons Edit / Send now / Cancel (Retry / Edit /
  Cancel when failed; none while it is sending), 38 px on a touch screen; a
  failed row adds a second line with the reason, and on a phone the time sits over
  the text. The bar renders in `ChatInput` above the waiting/outbox rows because
  the hook lives there (the Send menu shares it). Edit cancels the item and puts
  its text back in the box ahead of whatever is typed there. The list is never
  polled: it is read when the chat opens, the tab or the network returns, a run
  ends (an agent may have scheduled something during it) and at the next due
  time (`sync.ts`, `planScheduledRefresh`).
- **Traps.** Nothing under `lib/scheduled/` that `bin/cody-server.js` loads may
  use `@/` (`lib/server-import-graph.test.mjs`). `scheduler.ts` imports
  `delivery.ts` lazily: delivery imports the session manager, which imports the
  tools, which import the store. The Send pill's main button is `aria-disabled`,
  not `disabled`: a disabled button swallows the pointer events the long press
  listens to. The ▾ menu's chips compute from the moment it OPENED, but "In 1
  hour" is resolved when it is CHOSEN. A failed read of the list keeps the rows
  the page already has rather than blanking them. A stored `model` is an exact provider/id: `lib/scheduled/model-ui.ts` and
  `store.ts` must not import `@/` (server import graph); the picker's chips must
  use the composer's `modelThinkingLevels`, never a second ladder; `delivery.ts`
  imports `lib/model-switch/switch.ts` lazily-safe (it already loads
  `rpc-manager` in the same module, so no new cycle); do not add a switch call
  to `service.ts` (create must stay model-free).

### Overnight runs: stalls, crashes and restarts carry on (`lib/run-recovery/`)

Two nights running (2026-10-08, 2026-10-09) a long unattended LumaShow run died
without anyone being told. Once a host script stopped Cody's container mid-run
and nothing picked the run up again. Once the container hit its process limit
and the main agent's `edit`/`bash` calls (and one tool in each of eight
subagents) never returned: the omp process stayed alive, said nothing for
4.5 h, and Cody showed the chat as running the whole time. The run supervisor
is the part of Cody that notices both.

- **An observer, never a listener** (`superviseRun`, called beside
  `observeSessionForNotifications` in `startRpcSession` and
  `startEngineSession`; never for a sidebar chat). It uses only
  `observeEvents` and `onClose`: `onDestroy`/`onIdentityChange` hold ONE
  callback each and belong to the registry. Its state lives on
  `globalThis.__codyRunRecovery`, because the custom server owns the timer
  while the Next bundle registers sessions, and they are separate module
  instances; anything that imports the session manager is reached through a
  lazy `import()`.
- **The run journal** (`journal.ts`, `cody-run-journal.json` in the instance
  data dir, 0600, atomic): one entry from `agent_start` until a terminal
  `agent_end` or the person's Stop, heartbeat at most once a minute, re-keyed
  when omp moves the session to a new id. A close while a run is in flight
  KEEPS the entry only when the server is shutting down
  (`markServerShuttingDown`, the first thing in `bin/cody-server.js`'s
  shutdown and in the registry's exit cleanup), the engine crashed (the
  wrapper's `engine_exit` notice — the terminal `agent_end` that follows it is
  not the run finishing), or the supervisor itself is recycling the engine.
  Every other close (delete, archive, engine switch or update) drops it.
  Pruned at 24 h and 200 entries. An ending run leaves its recoveries in the
  file's `history`, and the chat's next run takes them back: the cap counts a
  CHAT's restarts, so recovered runs that end and wedge again cannot reset it.
- **Three verdicts**, one look a minute; every number is in `limits.ts`.
  (1) A main-agent tool is overdue (`judge.ts`, omp only): a tool with its own
  timeout — bash 300 s, eval 30, browser 30, computer 120, ssh 60, fetch 20,
  lsp 20, debug 30, ida 120, or its `timeout` argument; `0` means none — is
  overdue 15 min past it; a known-quick tool (read, edit, write, grep, …)
  after 20 min with no `tool_execution_update` (a `write xd://github`
  run_watch streams one per poll); `wait`, `ask`, `task`, `yield`, `goal`
  and any other tool name never. (2) No frame for 10 min, then a `get_state`
  left unanswered for 10 more (omp is known to freeze 3–5 min on its own
  databases after a turn, so the bound stays above that). (3) No progress at
  all for 60 min, unless a tool is still inside its own deadline. The clocks
  stand still while the chat waits on the person or compacts; cache-warming
  frames are not activity, and a /btw answer proves the engine is alive but
  not that the run is moving.
- **Recovery** (`recoverRun`): `destroyAndWait("stalled: …")`, then
  `acquireSession` (the retiring-child guard keeps the old and new engines
  from overlapping), then ONE user turn, `streamingBehavior: "steer"`,
  `clientMessageId: recover-<id>-<n>`, that says Cody wrote it, names what
  went wrong and when, says in-flight tool results are unknown and subagents
  and background jobs were stopped, and asks the agent to check what finished
  before it carries on (`text.ts`). The run it starts is watched from the
  send (`expectRun`), so an engine that wedges before its `agent_start` is
  still caught. An engine that died on its own is recovered after 30 s. At
  boot, every journal entry younger than 6 h is resumed, one chat at a time
  and 3 s apart, with "Cody's server restarted at …"; an older one is
  dropped with a "Not resumed" push. At most 3 recoveries per chat in 12 h
  (counted across its runs), then one "stopped trying" push and the entry
  goes. Pushes use the `error` kind (`notify.ts`, same pattern as
  `lib/scheduled/notify.ts`).
- **Every stop leaves a reason in the log.** `destroy(reason)` /
  `destroyAndWait(reason)` log `[rpc-manager] stopping the engine of running
  chat <id>: <reason>` when the stop cuts a run short, and an engine that
  exits mid-run logs its last stderr line. Before this nothing recorded why a
  chat lost its engine: the 07:07 stop on 2026-10-09 could not be explained
  afterwards. Each recovery and give-up also writes one `[run-recovery]` line.
- **Engine exits nobody asked for are also named to the user** (`lib/engine-crash.ts`: out of memory, disk full, too many processes, crashed, or restarted; see "Push notifications", Engine crash alerts).
- `CODY_RUN_RECOVERY=0` turns off the watchdog, crash recovery and boot
  resume (the journal is still written).
- **Known gaps.** An ACP agent that exits on its own emits no `engine_exit`
  notice, so it is not crash-recovered (its close drops the entry). Tool
  deadlines are judged for omp only; other engines get verdicts 2 and 3.
- **Host limits matter as much as Cody.** The 2026-10-09 wedge was Docker's
  default pids limit (2048, threads included) refusing forks: omp's native
  thread pool failed to start (`ThreadPoolBuildError … WouldBlock` in
  `~/.omp/logs/native-panic-*`) and tool promises never settled. The
  container template now carries `--pids-limit 16384`; check
  `/sys/fs/cgroup/pids.events` (`max` counts refused forks) before blaming
  the engine.

- **Run recovery: `tool_execution_update` for unknown tool ids.** `lib/run-recovery/supervisor.ts` `toolUpdated` now only refreshes a call that is already in flight. Since omp 18.10.2 the engine no longer drops a tool's late progress frames (a background job that keeps reporting after the call or the run ended); the old code created a tracker entry from such a frame, and since that call never gets an end the entry outlived the run as a ghost: `insideOwnDeadline` excused real silence from a `bash` call and `findOverdueTool` called a healthy run stalled. A call enters the table only through its `tool_execution_start`.

