# Time zones and the daily time limit

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Time zones: the device that sent the message decides (`lib/time-zone.ts`, `lib/time-zone-prefs.ts`)
- Daily time limit: active time only, one union across devices (`lib/daily-limit/`, `hooks/useDailyLimit.ts`)

### Time zones: the device that sent the message decides (`lib/time-zone.ts`, `lib/time-zone-prefs.ts`)

Agents used to reason in UTC: omp's own "Today:" line has a date and no time or
zone, and a container with no `TZ` ran every shell in UTC. The owner travels
with a tablet, so the rule is **the zone of the browser that sent THIS
message, read when it was sent** — not the server's, not a saved setting.

- **Precedence** (`resolveTimeZone`, first valid wins): the zone the person
  CHOSE in Settings → Preferences → Time zone ("Automatic" = none chosen) > the
  browser sending this message > the account's last-seen device zone > the
  server's `TZ`, then its system zone > UTC. Zones are IANA names stored
  canonically by `normalizeTimeZone` (the server may keep `Asia/Calcutta` for a
  pick of `Asia/Kolkata` — compare canonical forms, never raw strings); a
  layer that is not a zone is skipped, an explicit save of one is `400
  invalid_time_zone`. Per account (`UserPreferences.timeZone`/`.deviceTimeZone`);
  an instance with no accounts keeps one record in `<accounts dir>/time-zone.json`
  (also what an unowned session on an instance WITH accounts uses).
  `readTimeZonePrefs` always re-reads the account: a request's record predates
  its own write.
- **The browser reports it twice.** Every message-bearing command
  (`isMessageCommandType`: prompt, steer, follow_up, abort_and_prompt) carries
  `timeZone` from `deviceTimeZoneField()` — stamped per attempt in
  `lib/agent-client.ts`, so an outbox retry goes out from where the person is
  now; the new-chat spawn and the terminal POST carry it too — and
  `hooks/useDeviceTimeZone.ts` (mounted in `AppShell`) PUTs `/api/time-zone` on
  load, focus, visible and online when the zone changed, which keeps the
  last-seen zone current for work nobody is typing for.
- **Routes settle it, sessions get only the result.** `/api/agent/[id]` and
  `/api/agent/new` call `zoneForMessage` (resolve + remember the device) and
  hand the session the resolved `timeZone`; a client value that is not a zone
  never reaches an engine. A child started with nobody typing uses
  `ownerTimeZone(sessionId)`.
- **A zone becomes a child's `TZ` in exactly one place:**
  `engineChildEnv(extra, { timeZone })` (`lib/harness/provider-keys.ts`). Callers
  pass the zone: `RpcProcess`, `AcpEngineSession`, Cody terminals, and the
  one-shot children (Distill, session namer, plan keeper, planner, research —
  the owner's/actor's zone, else the instance-level one). Sidebar chats get it
  too.
- **A running process cannot change its `TZ`.** `alignSessionTimeZone` runs
  BEFORE a message is handed over: omp restarts the same wrapper in place
  (`AgentSessionWrapper.alignTimeZone` → `restart(profile, zone)`; listeners,
  ledger and event stream stay attached, concurrent sends join one restart); an
  ACP engine's idle child is closed and the session started again from the
  engine's own stored session. Never while a turn runs, a follow-up is held or a
  delivery is unsettled (a restart would fail it) — then nothing restarts, and
  the next idle message from the new zone does. The message is not delivered
  until the restart finishes, so nothing is lost; a failed restart reaches the
  sender, whose outbox keeps it.
- **The agent is told every prompt** by `lib/omp/extensions/cody-local-time.ts`
  (a second `--extension` beside the refusal guard, main omp sessions only): on
  `before_agent_start` it asks the wrapper which zone this message is from (an
  `input` dialog titled `CODY_TIME_ZONE`, answered by `answerTimeZoneRequest`
  from memory and never forwarded to a page — the refusal guard's channel in
  reverse) and returns ONE hidden custom message (`cody-local-time`, `display:
  false`, `details.zone`): "Current local time: Friday 2 October 2026, 14:58 EDT
  (America/New_York, UTC-04:00). Use this time zone for any times you state to
  the user." When the previous line in the transcript (read back from the
  branch, so restarts, resumes and forks all know) named another zone it opens
  "The user's device time zone changed: was X, now Y.", and when the shell still
  runs in another zone it closes "Shell commands (`date`) still report X until
  the next idle restart." It is a message at the tail, never a system-prompt
  edit: replacing the system prompt would break the provider's prompt cache on
  every turn. No answer (an older Cody) means the process's own zone. The file
  repeats a few helpers of `lib/time-zone.ts` because omp loads it with no
  Cody imports; `lib/omp/cody-local-time.test.mjs` runs both on the same inputs.
  Subagents and the sidebar are not given the line (their shells and Cody's
  tools are still in the right zone).
- **Hidden on every path.** `isHiddenFromTranscript` (`lib/message-display.ts`)
  is the one predicate: `entryToUiMessage` drops the entry on reload, the
  wrapper drops the live `message_start`/`message_end` frames of the model-only
  notes (`isModelOnlyNote`: this line and the other hidden notes written for the
  model alone, listed in docs/agents/disk.md; the MCP mount notice still drives
  its toast), `isVisibleTranscriptMessage`,
  `MessageView` and the turn grouping in `ChatWindow` never make a row or a gap.
  A new reader of session entries must go through `entryToUiMessage`.
- **Cody's tools speak local time.** Every host tool that prints a time takes
  `timeZone` in its context and writes it with `formatToolTime`
  ("2026-10-01 19:31 EDT", "…08:31 UTC+09:00" where the zone has no
  abbreviation): `list_sessions`/`session_status`, `forge`, `read_app_logs`
  (whose zoneless `since` is read in that zone). The zone is the newest
  message's (`AgentSessionWrapper.currentTimeZone()`, `getSessionTimeZone()`
  for the ACP bridge route).
- **What ACP engines (Claude Code, Codex) get:** `TZ` in the child's
  environment and the idle respawn above, and Cody's tool results in local
  time. They have no extension API, so there is no hidden per-prompt line and
  no prompt is rewritten for them.
- **The Settings row** is `components/settings/TimeZoneSetting.tsx` (rows from
  `lib/time-zone-options.ts`): "Automatic (this device: X)" is the first, REAL
  option (value `""`), and a saved zone selects the row naming the same zone by
  canonical name, so an alias the server stored still shows as chosen. The
  picker is `components/ui/Select.tsx` with its optional `search={{placeholder,
  empty}}` (base-ui Combobox, input inside the popup; every typed word must
  appear, any order, `_` `/` `-` count as spaces); without `search` the plain
  path is unchanged. Saves go through the panel's Save corner, not a toast.

### Daily time limit: active time only, one union across devices (`lib/daily-limit/`, `hooks/useDailyLimit.ts`)

A personal screen-time limit, off by default (Settings › Preferences › Daily
time limit). It counts how long the person is ACTIVELY using Cody, never how
long Cody is open or how long an agent works, and the total is shared by every
device on the account. Nothing it does ever blocks a send or stops a run.
- **What counts** (`active-time.ts`): the page is visible AND focused AND there
  was real input in the last 60 s. A second counts only inside that window; the
  60 s grace is what lets reading a long reply (no key, no click) keep counting.
  Hiding or blurring closes the running stretch at that instant (the grace left
  over is not banked), input that arrives while the page is not present is
  ignored, and coming back counts nothing until the first real input. Real input
  = keydown, pointerdown, a pointer that actually MOVED, wheel, touchstart/move,
  a non-collapsed text selection. Input inside the Preview iframe is invisible
  to the page (the browser keeps those events in the frame), so it does not
  extend the grace.
- **A `scroll` event is NOT input — the one deliberate departure from "scrolling
  keeps it alive".** The chat's own auto-scroll fires `scroll` for every word an
  agent streams, so counting it would make an agent working in a tab nobody is
  touching count forever. Scrolling by hand is already covered by the wheel,
  touch, keys and pointer that cause it. For the same reason a `pointermove` at
  the position the pointer already had (the browser repeats it when content
  scrolls under a parked mouse) and every untrusted event (`isTrusted` false) are
  ignored.
- **Reports are durations, not timestamps.** The page sends `{activeSeconds,
  endedSecondsAgo}` every 15 s (`BEAT_INTERVAL_MS`): how long it was active and
  how long before sending that ended. The server places it on ITS clock, so a
  device whose clock is minutes off lands on the right seconds. The 15 s timer
  exists only while a stretch can still be reported (it starts at the first
  input and stops when the grace runs out or the page is hidden or blurred): a
  hidden or idle tab owns no timer. The last report goes as a beacon only when
  the page is hidden or closing (`pagehide`); a merely blurred page sends a
  normal request and reads the answer. Capped at 90 s per beat on the server
  (`parseBeat`).
- **The server keeps a UNION, not counters** (`ledger.ts`, `store.ts`):
  `<accounts dir>/daily-limit.json` (0600, atomic, keyed by account id plus
  `__instance`) holds, per person, the settings, the per-day notes
  (`extraSeconds`, the limit the notice was dismissed at) and the ledger of
  wall-clock intervals. Intervals that overlap or sit within 1 s merge, so two
  tabs or devices reporting the same seconds add nothing and a day of beats is a
  handful of intervals. Pruned on every write to 14 days and 5000 intervals; a
  deleted account's record goes with it (nothing is pruned while the account
  store reads empty). Beats are ignored while the limit is off, and the file is
  only rewritten when the union grew. Reads degrade field by field; writes are
  strict (`400 invalid_daily_limit`).
- **The day is the local date in the person's zone.** GET resolves it with
  `effectiveTimeZone` (a read never writes the remembered device), PUT and beat
  with `zoneForMessage`: chosen > this browser > last seen > server > UTC, as
  under "Time zones". The day's edges are FOUND, not computed from an offset
  (`localDayBounds`: a binary search over the zone's own date), so a 23- or
  25-hour DST day and a zone whose clocks change at midnight come out right,
  usage resets at the zone's midnight, and an interval across it splits there.
  Usage is a window over the ledger chosen at read time, so a zone change needs
  no rewrite; "Add 15 minutes" and the notice's dismissal are keyed by that
  local date.
- **The ring** (`DailyLimitRing`, `LimitGlyph`): ONE circle in the controls row,
  no text beside it: a thin outline and an inside that fills like liquid from the
  bottom as the day is used (a rect clipped to the inner circle, slid by a CSS
  `transform` transition; the global `prefers-reduced-motion` rule zeroes it, so
  the level jumps for anyone who asked for less motion). Its diameter IS the
  Send/Stop pill's height: 28px on a desktop, 38px on a phone. Accent normally,
  warning at 15 minutes left or less (`WARNING_SECONDS`), error at zero and below
  ("reached" for the first minute over, then "over"). Tooltip and aria-label:
  "1h 12m left today", "Daily limit reached", "12m over today's limit". A click
  opens the popover (time left in big numbers, used today, the limit, "Add 15
  minutes" once spent, a link to Settings › Preferences). It sits before the
  quota ring and costs 42px on a phone row (see "Phone composer").
- **Time's up** (`DailyLimitNotice`): one slim bar above the composer's stack
  ("You've reached today's 2h limit", "Add 15 minutes", "Done for today"). The
  SERVER decides it is due (`noticeDue`: on, limit reached, not dismissed at this
  limit), so answering on the tablet clears it on the PC. It stays until one of
  the two is pressed (it never hides itself and never blocks a send). Adding time
  raises today's limit, so reaching the new one is a new occasion. The quiet
  "12m over" state is just the ring for the rest of the day.
- **One counter per page.** `useDailyLimitTracker()` is mounted once in AppShell;
  every surface reads the same store (`useDailyLimit`, on `globalThis`). The
  state is refreshed on load, focus, visible and online (never faster than every
  5 s) and on the first input after midnight; each beat's answer is today's total
  across devices. Turning the limit off hides every surface and detaches every
  listener and timer.
- **Traps.** `LimitGlyph`'s clip-path id comes from `useId`, which is unique only
  inside ONE React root: a harness that renders circles with separate
  `renderToStaticMarkup` calls shares ids, and every circle is clipped by the
  first one's. Headless Chromium reports no hover, which Cody reads as a touch
  screen (taller notice buttons): launch with
  `--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2`
  to look at the desktop layout. A puppeteer `screenshot({clip})` fires `resize`
  and closed an open popover, so capture the viewport and crop afterwards.
- **Not done on purpose:** a push notification at the limit. The person is
  looking at Cody when it happens (the notice is their signal), and a new kind
  would touch the notification catalog, its settings page and its tests.

