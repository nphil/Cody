# Subagent integration

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

### Subagent integration (`lib/subagent-types.ts`, `lib/subagent-history.ts`)
- **Lifecycle + progress, never "events"** (`SUBAGENT_SUBSCRIPTION_LEVEL` in
  lib/rpc-manager.ts). omp's events level forwards every child's streaming
  delta as a `subagent_event` carrying the FULL message so far (~70 KB each).
  Measured on a real session: five children thinking at once wrote 5.3 GB in
  five minutes. omp spills output Cody has not read yet to a temp file
  (`/tmp/omp-rpc-output-*/output`) and drains it at a few hundred KB/s, so
  every later frame of that session — replies, `agent_end`, the answer to
  `get_subagents` — arrived hours late and the roster could never refresh.
  Progress frames (omp-throttled to ~7/s per child, ~11 KB) carry what the UI
  shows. If a session looks frozen, check that temp file's size first.
- **Live detail**: `subagent_progress` frames carry the full `AgentProgress`
  object — `lib/subagent-types.ts` parses it defensively into
  `SubagentInfo.progress` (current tool/intent, tokens, cost, context
  gauge, resolved model, retry state, detached flag, agentSource). The
  composer chips surface the current activity + telemetry line; retry
  (`⟳ retrying N/M`) takes precedence over the tool line. The transcript
  dialog's activity list is derived from successive progress frames
  (`activityFromProgressChange`: tool started, model switch or fallback,
  reasoning change), and each frame bumps the child's transcript version so
  an open dialog follows new output. omp 18.4+ adds `currentToolIntent`
  (cleared per call, unlike the sticky `lastIntent`), `currentToolArgsKey`
  and `recentTools[].{intent,argsKey,isError}`; `subagentActivityIntent`
  prefers `currentToolIntent` for the chip and the dialog's tool line, and
  falls back to `lastIntent` on 18.3 frames.
- **The roster is run-scoped, on purpose** (`useAgentSession`): the composer
  panel is a live view of the CURRENT run, newest activity first (actives
  lead, then settled, both newest-first — `selectVisibleSubagents`). It is
  NEVER seeded from on-disk history: run end drops finished children and
  keeps ones still working (background/async tasks outlive the main turn).
  A progress frame for a RUNNING child the roster does not know adopts it —
  that is how a child reappears after a session switch or a missed
  `started` frame; `mergeSubagents` refuses terminal frames for unknown ids
  outside a run so late completions cannot resurrect chips. Seeding from
  `extractSubagentHistory` is the removed design that bloated long
  conversations to 20+ stale chips — do not bring it back; past runs stay
  reachable through each task call's in-message summary (TaskResultPanel).
  `get_subagents` snapshots rehydrate the LIVE roster on mount of ANY live
  session (main agent idle or not — the event stream is attached then too),
  after SSE reconnect, on send, and on the reconcile poll; the `/subagents`
  route is now consumed only for its `subagentUsage` sum
  (`refreshSubagentUsage`).
- **On-disk history** (`lib/subagent-history.ts`, `/api/sessions/[id]/subagents*`):
  omp persists each subagent's transcript to the parent session's sibling
  artifacts dir (`<session-dir>/<subagent-id>.jsonl`) and the parent file's
  task toolResults keep `progress[]`/`results[]` snapshots
  (`extractSubagentHistory` still reads them for the route's roster payload
  and usage sum). The transcript route (`?tail=1` newest page,
  `?beforeByte=N` the page before N, `?fromByte=N` forward) reads ONLY the
  bytes a page needs (`readSubagentTranscriptPage`: fd range reads, 64 KB
  newline scans, one reusable buffer) — never the whole file, so there is no
  size cap any more (real transcripts are 14–21 MB; a page costs ~2–10 ms and
  ~110 KB whatever the file size). Every page is whole JSONL lines:
  `fromByte`/`nextByte` are line starts, `offsets[i]` names the line each
  message came from, `endByte` is the end of the last COMPLETE line (a line
  still being written is never returned). A page is ≤256 KB and ≤200 lines,
  except that one longer line comes back whole up to 8 MB (beyond that: one
  "Entry omitted" placeholder). `slimSubagentMessage` bounds each message
  before it ships: `providerPayload` and `thinkingSignature` (over half of a
  real assistant line, never rendered) are dropped, rendered strings over 64K
  chars get a visible "… truncated" marker, inline images over 512 KB become a
  note. `get_subagent_messages` (RPC-registry-gated, forward-only, starts at
  the OLDEST page) is only a fallback for a running child whose file the disk
  reader cannot find. The dialog reads the final output — `<id>.md` via
  `?mode=completion` (bounded read) with a live `get_subagents` snapshot
  fallback for header enrichment.
  IDs can be explicit task names with spaces/punctuation: validate a bounded safe
  filename component and retain realpath confinement, not an AdjectiveNoun regex.
- **The transcript dialog** (`SubagentTranscriptDialog` → `SubagentTranscript`,
  `useSubagentTranscript`, `useTranscriptScroll`). Top to bottom: fixed header,
  Result (once `<id>.md` exists; folded when long), Task (collapsed), Transcript,
  steer footer. The dialog body is the ONE scroll container (the old nested 50dvh
  scroller and its height/maxHeight flip are gone) and the popup has a fixed
  height, so nothing resizes when pages land or the child finishes. The
  transcript mounts with the dialog and fetches only while it is open.
  - **Same rows as the chat.** Rows are the main chat's `MessageView`
    (`activityDisplayMode="compact"`, thinking collapsed, tool calls as the
    normal cards with results attached by id; a toolResult is never a row of its
    own). `allowDistill={false}` plus no session/entry id: a subagent row can
    never request a summary or fetch anything. Row keys are the line's byte
    offset, never an array index — pages are PREPENDED.
  - **Bounded, not virtualized.** The window keeps at most `MAX_WINDOW_MESSAGES`
    (400) messages; past that `trimWindow` drops the page farthest from the
    reader (never the page under them) and "Show earlier" / the auto-load /
    "Jump to latest" bring pages back. Chosen over `content-visibility: auto`
    because a row's cost here is React script time, not layout (measured in dev
    for 22 rows: layout 20 ms, style 18 ms, script 688 ms) — which
    content-visibility cannot skip — and exact row geometry keeps the scroll
    anchor exact. The 20 MB file never costs more than the window.
  - **Paging.** ONE "Show earlier" control at the top, only while earlier
    content exists; the previous page also loads on its own once the reader is
    within 240 px of the top (rate-limited: 250 ms, 2 s for a flip of direction,
    so a window that renders almost nothing cannot loop). There is no forward
    button: a running child's new lines append through the throttled
    `transcriptVersion` (600 ms, one more fetch ~1 s after the child settles),
    and a trimmed window walks down by itself near its bottom.
  - **Follow vs read** (`lib/transcript-scroll.ts`). Pinned: every commit and
    every content resize re-pins the bottom with an INSTANT scroll. Reading:
    nothing scrolls the reader; the row at the top edge is held (stable key +
    offset) through a prepended page, a trimmed page or a row expanding above
    them. Our own writes are told apart by VALUE (`pinnedAfterScroll`), so there
    is no window in which the reader's scrolling is ignored; wheel up, a
    downward finger drag, Up/PageUp/Home or a scrollbar drag unpin at once,
    returning within 40 px re-pins, and a click on any control inside the
    scroller (opening a card, "Show earlier") unpins too so growth never drags
    the reader. "Jump to latest" shows when rows arrived while reading, or when
    the window was trimmed away from the live end (it reloads the newest page).
    The scroller sets `overflow-anchor: none` and `scroll-behavior: auto` so the
    browser's own anchoring and smooth scrolling never fight this.
  - **Entry point.** The dialog opens only from the live roster's composer
    chips. A finished session has no chips (the roster is run-scoped) and
    TaskResultPanel rows are not clickable, so past runs' transcripts have no
    way in today.
- **In-message task summary** (`components/MessageView.tsx` TaskResultPanel):
  the session reader allowlists a SIZE-BOUNDED subset of `task` toolResult
  details (telemetry only — no `output`/`stderr`, long text truncated to
  240 chars, `lib/session-reader.ts` `keepTaskToolResultDetails`), and
  expanded `task` tool calls render a per-subagent summary (status, agent,
  task, tokens/cost/duration/model, async marker) above the raw result text.
- **Chip extras**: agent-source labels (`user`/`project`), nested-subagent
  count (`inflightTaskDetails`/`extractedToolData.task` progress), and the
  `⤴` async marker (live `detached` flag or history `details.async`
  presence). Shared formatters live in `lib/subagent-format.ts`.

A `task` call is summarised on its card by `lib/task-call-preview.ts` (batch:
"N subagents: names", omp 18.19 `task.steps`: first step plus "(N steps)").
Since omp 18.18 a parent agent's message to a running subagent is a `user`
message carrying `parentIrc {from, body}` beside the model-facing `<irc …>`
wrapper; `lib/irc-display.ts` turns it into the same incoming-IRC card peers
use, so a subagent transcript shows the plain text and the sender. omp 18.17+
puts `progress`, `broadcast`, `replyTo` in the IRC message details; the card
shows them as small tags. `AgentProgress.stage`/`watch` (omp 18.19) come only
from the completion probe, which omp never runs under RPC, so Cody does not
read them.

