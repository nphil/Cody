# Push notifications

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

### Push notifications (`lib/notifications/`)

When a chat needs the owner, finishes, fails or quota runs low, Cody publishes
to the owner's ntfy topic (server, topic, optional Bearer token and Cody's own
address are per-account settings, never hardcoded). Settings › Notifications
edits them; `app/api/notifications/{route,test,presence,action}`.
- **Settings** live in `<accounts dir>/notifications.json` (0600, atomic),
  keyed by account id plus `__instance` for an open instance. Reads degrade
  value by value to the defaults; writes are strict (`400
  invalid_notification_settings`). The token is write-only: GET returns
  `hasToken`. A deleted account's record is dropped on the next save.
- **Recipients**: a chat's owner (read at send time — the stamp is written after
  spawn); an unowned chat goes to the instance record on an open instance, else
  to every administrator. Quota goes to every account (or the instance record).
- **The observer channel is NOT a listener.** `AgentSessionWrapper` and
  `AcpEngineSession` have `observeEvents(fn)` in a set of its own: listeners
  gate the idle destroy and host-tool routing, so a permanent listener would
  keep every child alive and hang host tools. Observers also get three signals
  no stream carries: `cody_ui_request_resolved {id}` (omp emits nothing when a
  dialog is answered or times out), `cody_ui_requests_cleared` (restart/close)
  and `cody_run_stopped` (the instant Stop is pressed). The todo-pause and crash
  notices carry `reason: "awaiting_reply"` / `"engine_exit"`; the client ignores
  the extra field. Registered in `startRpcSession` (not for `kind: "sidebar"`)
  and `startEngineSession`; read `session.sessionId` fresh every time.
- **Answer buttons** are ntfy `http` actions posting a signed token to the
  PUBLIC `/api/notifications/action` (proxy.ts `PUBLIC_EXACT`; CORS `*`, no
  cookie is ever read). A token answers ONE request with ONE answer for ONE
  recipient, once, within 24 h / the request's own deadline, and carries a digest
  of the request so a reused id (ACP `perm-1` after a restart) is never answered.
  Select ≤ 3, single non-multi ask ≤ 3, confirm Allow/Deny; ACP only the
  agent's first `allow_once`/`reject_once` — NEVER an `*_always`. Turning
  buttons or notifications off, or changing the chat's owner, kills buttons
  already on a phone (403). The route rebuilds the command from the pending
  request (`getPendingUiRequest` / `getPendingPermission`), never from the token.
- **Pending-input notifications** carry a sequence id (`cody-` + 24 hex of
  sha256(session, request)) and are cleared (PUT `/<topic>/<seq>/clear`, after
  their publish settles) on resolve, cancel, expiry, restart and close.
- **Presence**: the browser POSTs the visible chat (30 s heartbeat, null on
  hide); a report < 75 s old suppresses that chat's notifications for that
  person when `skipWhenViewing`.
- **Quota** (`quota-watch.ts`): reads the shared usage snapshot only when the
  usage reader exists and someone has a quota kind on — 60 s after a run ends
  (≥ 3 min apart) and every 10 min while a chat is live; started/stopped from
  `bin/cody-server.js`. Announced windows are remembered by a hash in
  `notifications-state.json` and pruned as they reset. Messages never name an
  account's email (`UsageAccount.label` can contain one) — provider, "account
  n/m", window, reset time in the recipient's zone.
- **Account signed out** (`signed-out.ts`, sent from `quota-watch.ts`): the
  `accountSignedOut` kind (problems group, on by default, priority 4) says a
  stored login ended — "Claude · Secondary was signed out" / "Its login
  expired, so Cody is using your other accounts. Sign in again: Settings ›
  Providers." (one account: "Claude was signed out"; no other usable account:
  "…so Cody cannot use it."). Sent ONCE per credential row and cause: `so-` +
  a hash of provider, row id and the cause's own hash is remembered in
  `notifications-state.json` and forgotten only when that row is no longer
  signed out (signed in again, removed) — never because the credentials could
  not be read. Names the provider and the account's POSITION, never its
  email. The check reads omp's credential store alone (`listOmpCredentials`,
  no engine spawn, omp only) on quota-watch's schedule — once 30 s after the
  server starts, 60 s after a run ends, every 10 min while a chat is live — and
  runs whether or not any quota kind is on. Its click URL is
  `<codyUrl>/?settings=providers`: `AppShell` opens the Settings hub named by
  `?settings=<hub>` on load (`getInitialSettingsTab`,
  `lib/initial-navigation.ts`; an unknown hub opens nothing).
- **Scheduled messages** (`lib/scheduled/notify.ts`): the `scheduled` kind
  (progress group, on by default, priority 3) says a scheduled message was sent
  into its chat, or gave up and why ("Open the chat to retry or cancel it").
  Never fired for a Send now the person pressed themselves — they are looking.
  The preview is the person's own words, clipped to a line.
- **Engine crash alerts.** When a chat's engine exits without anyone asking (not
  Stop, close, a settings/routing restart, idle dispose or server shutdown),
  `AgentSessionWrapper.handleProcessExit` (lib/rpc-manager.ts) classifies the
  exit with `classifyEngineExit` (lib/engine-crash.ts, browser-safe, tested in
  lib/engine-crash.test.mjs) from the exit code/signal, the last stderr lines,
  the cgroup counter deltas (`oom_kill` in memory.events, `max` in pids.events,
  read once at spawn and once at exit by lib/engine-crash-host.ts, never
  throwing) and the disk areas (lib/disk-space.ts `describeDiskError`). One
  reason comes out: `out_of_memory`, `disk_full` (names tmp/data/quota),
  `too_many_processes`, `crashed` (with the last error line, one line, capped,
  secrets stripped) or `server_restarted` (lib/run-recovery/supervisor.ts
  `resumeInterrupted` on boot for chats the journal says were running).
  `crashRecoveryOutlook(session)` says whether Cody restarts the chat
  automatically (`automatic`), has given up after 3 tries (`gave_up`) or needs a
  message (`manual`). That one notice goes four ways: the wrapper's `notice`
  event (reason `engine_exit`, with a `crash` payload; the observer pushes its
  sentence on the existing `error` kind), the running-sessions SSE as an
  `engine_crashed` frame (lib/engine-crash-events.ts,
  `canAccessSession`-filtered; the plain running-id frames are unchanged) that
  SessionSidebar turns into a toast (components/engine-crash-toast.ts; click
  opens the chat), the persistent row stored in `<agent
  dir>/cody-engine-crashes.json` (lib/engine-crash-log.ts, at most 5 per chat,
  30 days) and merged into `GET /api/sessions/[id]` by time as a
  `cody-engine-crash` custom message with an entry id starting `cody-crash-`,
  and the live row useAgentSession appends. Words live in `engineCrash.*` keys
  (en/ja/zh-CN) and `ENGINE_CRASH_TEXT` (server English); the locale test pins
  them together.
- **Traps**: nothing here may use `@/` (the custom server loads it through bare
  jiti — `lib/server-import-graph.test.mjs`); shared state (presence, spent
  nonces, log throttle, watcher) is on `globalThis`; every ntfy call is
  fire-and-forget with a 10 s timeout and never throws into a session; a
  redirect is never followed (a redirected POST becomes a 200 page that looks
  like success); what a non-ntfy server answers is never echoed back. Tests that
  need an open instance must `delete process.env.CODY_REQUIRE_ACCOUNTS`.

**A notification button can only grant ONCE.** omp asks a tool approval as a `select` titled "Allow tool: <name>" with rows such as "Allow once", "Allow for session", "Deny". `lib/notifications/compose.ts` (`toolApprovalSelect`) offers a lock-screen/notification button only for the once and deny rows; `lib/notifications/answer.ts` (`cleanUiAnswer`) re-checks the same rule server-side, so a forged or stale tap cannot send a broader grant (session-wide, "always", or an unknown row). Broader grants stay inside the chat dialog. The predicates (`isToolApprovalTitle`, `isAskOtherRow`, `isAskDoneRow`, `isAskSelectedTitle`) live in `lib/ask-walk.ts` and are imported by compose/answer so the dock and the notifications read omp's wording one way. For the model's own questions: a plain pick gets one button per real option (omp's "Other (type your own)" row is dropped, so no button only opens a typed follow-up); a multi-choice step (a "(N selected)" title or a Done row) gets no buttons and its notification says to open the chat.

