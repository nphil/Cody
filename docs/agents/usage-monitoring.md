# Usage and monitoring: machine meters, Statistics page, token rate

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Machine meters in the top bar (`lib/machines/`, `components/machines/`)
- Statistics page (`lib/statistics/`, `components/statistics/`, `app/statistics/`)
- Token rate: measured from the engine's own numbers, never guessed

### Machine meters in the top bar (`lib/machines/`, `components/machines/`)

Live CPU and memory for every machine Cody runs on or uses: "This server" plus
any ssh machine an admin adds under Settings › System › Machines. They sit left
of the session's `$` cost; the three token figures that used to be there are
gone (tokens stay in the session popover and the button's tooltip).

- **The list** is `cody-machines.json` in the instance data dir (0600, atomic).
  The local entry is always there, its name editable, default "This server": a
  fresh install shows nothing of anyone's network, and no owner's hosts are in
  code. An ssh machine is a name plus a destination (an alias from
  `~/.ssh/config`, or `user@host`). `checkMachineDestination` is a WHITELIST
  (letters, digits, `. _ - : @`, never a leading `-`): the value is an ssh
  argument and, through `ProxyCommand … %h`, part of a shell line. Names are
  one collapsed line, 24 characters at most; 12 machines at most.
- **Sampling happens only while somebody looks.** `GET /api/machines/stream`
  is the subscription: the first viewer starts a collector per machine (a timer
  reading `/proc` for this server; ONE long-lived `ssh` per other machine
  running the fixed loop in `ssh.ts`), the last viewer leaving starts a 60 s
  countdown, and then every ssh process is killed. The hook closes the stream
  while the page is hidden. One record per machine, no history. The live state
  is a page-wide store the two drawing components subscribe to, never
  `AppShell` state: a frame every second or two would re-render the whole shell.
  It is one more long-lived stream per visible page: over plain HTTP/1.1 the
  browser's six connections per host are shared with the chat's own streams.
- **ssh is given nothing a person typed** except the checked destination (one
  argv entry after `--`, no local shell). The remote command is the constant
  `SAMPLE_COMMAND`: `sh -c '…'` with no quote, backslash or `!` inside, so a
  fish or csh login shell can parse it. `BatchMode`, `ConnectTimeout`,
  keep-alives and `ControlMaster=no`/`ControlPath=none` (a `ControlPersist`
  config would leave a process behind) are set; the host-key policy is NOT: the
  person's own `ssh_config` rules, and `host_key` tells them to connect once from
  a terminal. Failures only a person can fix (`auth`, `host_key`,
  `unknown_host`, `no_ssh`) are retried every 5 minutes, not every few seconds:
  a loop of refused logins is how fail2ban or CrowdSec bans Cody's address.
- **The far loop dies with Cody, however Cody dies.** An orphaned `ssh` does
  NOT exit when its parent does (it ignores the broken output pipe; one test
  orphan carried on for 54 minutes, keeping its loop alive on the far machine).
  So ssh's stdin is a pipe Cody holds open and never writes to (no `-n`), and
  the loop's background `cat` kills it at EOF: a normal `stop()` ends stdin, and
  a `SIGKILL` or an out-of-memory kill closes it for us. `ssh.test.mjs` proves
  both, including a SIGKILLed parent. Never put `-n` back, and never hand
  ssh's stdin to something that outlives the server.
- **Statuses** are `online | connecting | offline | unavailable` (reachable but
  not Linux) with a `reason` CODE; the browser turns codes into plain copy
  (`machines.reason.*`) and `lib/machines/present.test.mjs` holds all three
  locales to every status, reason and API error code. A machine that drops
  loses its numbers (never stale ones) and gets one quiet "connecting" retry
  before it shows offline. The stream carries no address and no ssh output;
  `GET /api/machines` hides destinations from non-editors; only the admin-only
  `POST /api/machines/test` returns ssh's own first line.
- **The sampler lives on `globalThis`** (`__codyMachineSampler`).
  `bin/cody-server.js` loads `sampler.ts` through jiti only to call
  `stopMachineSampler()` at shutdown, while the routes load it through Next's
  bundler: two module copies, one sampler. Nothing under `lib/machines/` may use
  `@/` (`lib/server-import-graph.test.mjs`). Timers and the ssh pipes are
  `unref`'d, so a stuck connection can never hold the server open.
- **Top bar layout** (`MachineMeters.tsx`). The component owns a `flex: 1 1 0`
  slot between the left controls and the session button and measures it with a
  ResizeObserver; `pickMeterDensity` picks the richest of `full` (name, labelled
  bars) → `compact` (icon labels) → `mini` (an initial and two 18 px bars: two
  machines fit in the 89 px that 1280 px with the sidebar and workspace panel
  open leaves) → `dot` → nothing. Widths are in `METER_LAYOUT` and MUST match
  the `.mm-*` CSS in `app/globals.css`. A phone always gets the 24 px `dot` (a
  ring for the machine that needs a look, or a struck-through server when one
  is down); to make room the session button drops its ⓘ icon while it shows a
  context figure, and no divider is drawn. Under about 385 px with omp's extra
  buttons even that does not fit, and it is left out rather than overlapped.
- The dropdown is the shared top-panel pattern (`activeTopPanel ===
  "machines"`); its "Manage machines" opens Settings › System with
  `highlight: "machines"`.

### Statistics page (`lib/statistics/`, `components/statistics/`, `app/statistics/`)

`/statistics` shows where the usage went: one ring chart (sunburst) of cost or
tokens, a per-day timeline, and a few plain findings. It reads every omp
transcript on the instance, so it covers chats, side chats (btw), subagents, the
advisor, context compaction and omp's own helper calls (memory extraction,
auto-thinking, the unexpected-stop judge) as well as Cody's background jobs.

- **Entry points.** The session cost popover in the top bar has a "Usage
  statistics" row (`components/AppShell.tsx`, a `<Link>`), and Cmd-K has the same
  item (`components/CommandPalette.tsx`, `onOpenStatistics`). The page's back link
  returns to the chat the user came from.
- **The index** (`lib/statistics/store.ts`, `indexer.ts`, `scan.ts`) is derived
  state in `<agent dir>/cody-statistics/index.json` (0600, atomic): daily
  aggregates per provider/model/worker inside one transcript file, plus a read
  offset per file. Rows and offsets share the file on purpose so a crash cannot
  count bytes twice. The indexer reads only bytes it has not read (a shrunk or
  rewritten transcript is dropped and re-read as a unit), never follows a
  symlink, sniffs each line's leading `{"type":"…"` before parsing, and keeps 400
  days / 400k rows at most. Delete the file and the next request rebuilds it.
  `lib/statistics/service.ts` is the only place that meets the live install: a
  request waits ~300 ms for a running pass and otherwise answers with what is on
  file and `updating: true`; a pass starts when the last one is >10 min old, and
  `?refresh=1` at most every 20 s. Nothing in it throws.
- **Background jobs** (chat titles, Distill, plan keeper, the onboarding planner,
  web research) run `omp -p --no-session`, so no transcript exists. The one
  hook is `recordOneShotUsage` (`lib/statistics/oneshot.ts`, called from
  `lib/model-plan/one-shot.ts` with each finished assistant message); it appends
  to a monthly JSONL log in the same dir (`joblog.ts`) that the indexer folds in.
- **Honest figures** (`billing.ts`). A subscription login (Claude plan, ChatGPT
  plan, Copilot, …) shows what the usage WOULD cost on the API and is labelled
  "Plan · estimate"; pay-as-you-go (API keys, gateways, Claude API credits) is
  real money; a local runtime has no price; a model with no known price is
  counted in tokens and flagged "Price unknown", never as 0. Prices are learnt
  from the transcripts (`rates.ts`: each call records its cost per counter), so
  there is no catalogue to keep in step; the cache saving and a compaction's cost
  come from the same learnt prices.
- **Who sees what** (`access.ts`). Only the viewer's own chats, by the rule the
  chat list uses (`lib/auth/session-owners.ts`); a chat someone else owns answers
  404 like one that does not exist. Usage that belongs to no chat is shown only on
  an open instance or to an admin.
- **The query layer** (`query.ts`, `sunburst.ts`, `present.ts`, `labels.ts`,
  `request.ts`) is pure: it turns the index into the ring tree (both cost and
  tokens on every node, so the Cost/Tokens switch needs no second request), the
  timeline, the insights (numbers only; the page words them in every locale) and
  the per-chat deep dive. Days are bucketed in the server's zone
  (`lib/time-zone.ts`).
- **Page** (`components/statistics/`). `StatisticsPage.tsx` owns the state and
  the URL (`?range=today|7d|30d|90d`, or `?from&to` for custom days, plus
  `?by=provider|project|model|worker` and `?metric=cost|tokens`, written with
  `replaceState` so Back leaves the page instead of walking through setting
  changes; `app/statistics/page.tsx` reads them on the server through
  `statistics-query.ts`, so a reload or shared link opens the same view). The
  back arrow returns to the chat the user came from (`router.back()` when the
  Navigation API says the previous entry is `/`; `document.referrer` is useless
  here because the app sends no referrer). The circle is plain SVG
  (`Sunburst.tsx`, framed by `ChartSection.tsx`) with a table twin
  (`StatsTable.tsx`) that carries the same numbers for keyboard and
  screen-reader use; `ControlsBar.tsx` (period, custom days, Cost/Tokens, ring
  order), `Summary.tsx`, `Insights.tsx`, `NodeDetail.tsx`, `DeepDive.tsx` (one
  chat), `Timeline.tsx` (clicking a day focuses the page on it, with a way back)
  and `StatisticsStates.tsx` (first run, empty, error, skeleton) are the other
  parts; on touch a tap selects a slice and its detail opens in
  `BottomSheet.tsx`. `useStatisticsData.ts` fetches `/api/statistics`, keeps the
  old numbers on screen while a new range loads and asks again every 2.5 s
  while the server says `updating`. Styling is one string in
  `statistics-css.ts` over the design tokens.
  *Layout.* The page never needs sideways scrolling on a desktop. The
  chart/table split is decided by the width of the page body, not the window
  (`.stats-body` is a CSS container, `@container stats-body (min-width: 860px)`
  gives the two columns; narrower stacks the chart above the table). The table
  is one `<tbody>` per row: from a 641px viewport up it shows name, cost, tokens
  and the share bar on the main line and the input / output / cache read /
  cache write / cache hit split as one muted line underneath (the Total row
  too); on a phone (≤640px) it keeps all nine columns, scrolls sideways inside
  its frame and pins the name column. A frame narrower than 440px also drops
  the share bar.
- **Tests.** `lib/statistics/*.test.mjs` (suite entry in `scripts/test.mjs`).
  Nothing in them touches the live data dir: the indexer is handed a directory.
- **Keys.** `statistics.*` in `lib/i18n/locales/{en,ja,zh-CN}.json`.

### Token rate: measured from the engine's own numbers, never guessed
- The transcript's `t/s` badge is the provider's **output-token count over
  the request's measured duration** — the same arithmetic the engine reports
  for its own status line (omp's `utils/token-rate.ts`: `output * 1000 /
  duration`, 100 ms floor). omp records `duration`, `ttft` and `completedAt`
  on every assistant message it writes AND sends them on `message_end`, so
  `lib/message-rate.ts` computes the identical number client-side, per
  message, with no poll lag. omp also reports `tokensPerSecond` on
  `get_state`; Cody deliberately does NOT read it — same formula, but only as
  fresh as the 15 s reconcile poll and scoped to the session's last message.
- **The estimate is labelled as one.** Before any output count exists (a
  provider that reports usage only at the end, or an ACP engine, which
  accounts for itself in `usage_event` frames and puts nothing on its
  messages) the badge falls back to `chars / 4` and wears a `~` plus a
  tooltip saying so. That heuristic is not a tokenizer: it understates CJK by
  ~3x and dense code somewhat, and its rate is a cumulative average that
  every pause (a tool call mid-message, a stall) drags down. The two live in
  one module so no call site can confuse them.
- **A rate needs enough output to mean throughput** (`MIN_RATE_OUTPUT_TOKENS`,
  48). Measured: a four-token "ok" whose 1.7 s was almost entirely the wait
  for the provider computes to 2.3 t/s and wore the SLOWEST colour on a model
  that was in fact answering at ~90 t/s. Below the floor there is no badge at
  all rather than a misleading one; the tooltip on a real one names the ttft
  and the decode-only rate, so a long provider wait reads as a wait instead
  of as a slow model.
- **`message.timestamp` is when the request STARTED, not when it ended.**
  `completedAt` is the end. Tool durations therefore measure from
  `completedAt` (the moment the tools were dispatched); measuring from
  `timestamp`, as the code used to, charged the model's whole generation time
  to the first tool call. A thinking box's generation time is `duration`
  itself, not the wall-clock gap to the previous message, which also contains
  whatever ran in between.

