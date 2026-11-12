# Side Bar: the isolated chat and /btw side questions

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Sidebar chat: a tiny baseline, context on demand, sized for a local GPU
- Side questions: `/btw` (`lib/btw.ts`, `hooks/useSideQuestions.ts`, `hooks/useSideQuestionsBridge.ts`, `components/SidebarSideQuestions.tsx`)

### Sidebar chat: a tiny baseline, context on demand, sized for a local GPU

The Side Bar has two views behind a switch: **New chat** (everything below: the
isolated small-model chat) and, wherever omp has `/btw`, **This chat** (side
questions about the main conversation, which see it — see "Side questions:
`/btw`"). Nothing below changes for New chat.

The sidebar is meant to run on small LOCAL models (the owner's llama-swap P40:
8,192–24,576 windows, 2k–8k reserved for output — so the smallest leaves
~6,100 tokens for everything). Measured against a fake OpenAI endpoint, a
sidebar "hi" was sending **133,559 tokens** before this: 43,438 of verbatim
`AGENTS.md` inside a `<project><instructions><file>` block, and 89,303 of
user-scope MCP tool schemas (111 tools). It now sends **~726** (310 prompt +
416 schemas).

Neither source has an omp flag or setting. `--no-rules` covers `.omp/rules`,
NOT `AGENTS.md`/`CLAUDE.md`; `--no-tools`/`--no-extensions` cover omp's own
builtins and extension discovery, NOT `<agent dir>/mcp.json`. The two levers
that do work, each measured in isolation:

| configuration | tokens |
|---|---|
| baseline | 133,559 |
| bare `--cwd` (no context file to discover) | 90,105 |
| agent dir with an empty user `mcp.json` | 43,602 |
| **both** | **144** |

- `sidebarBareCwd()` — an empty Cody-owned directory the child runs from, so
  context-file discovery finds nothing. The workspace is carried separately as
  `WrapperEngineContext.contextCwd`, because `this.cwd` is now that bare dir
  and every tool read would otherwise resolve against it.
- `sidebarAgentDir()` — a sidebar-only agent dir whose `mcp.json` is
  `{"mcpServers":{}}`, with `agent.db`/`models.yml`/`config.yml`/`blobs`
  SYMLINKED to the real ones so credentials, providers (including the local
  endpoints) and image blobs still work. Safe because SQLite puts `-wal`/`-shm`
  beside the symlink TARGET (verified), and omp already opens that database
  from concurrent processes. A missing target is skipped, not linked dangling.
  The symlink logic itself is `lib/omp/isolated-agent-dir.ts`, shared with
  Distill, the session namer and the web-research planner (see "Distill" and
  "Model presets" below) — only the directory location is sidebar-specific.
- **Every tool result is budgeted** (`lib/sidebar-context-budget.ts`). An
  unknown context window is assumed to be the SMALLEST supported, never
  unlimited: guessing large is how a 4B model receives a result it cannot fit,
  and the cost of guessing small is one extra page. One result may take ~25% of
  what remains after the output reserve, so several reads plus the conversation
  still fit; truncation always reports a `nextOffset`, and slices cut on line
  boundaries so a paged read never splits a line.
- The system prompt's job is to say the model has NO context yet and must ask.
  A model that assumes it was handed the project answers from training-set
  guesses about a codebase it has never seen, which is worse than saying it
  cannot help. `lib/rpc-manager.test.mjs` asserts that contract (starts without
  context, names a context tool, still cannot edit) rather than the sentence —
  the previous assertion pinned "cannot read or edit files", which this design
  made false.

### Side questions: `/btw` (`lib/btw.ts`, `hooks/useSideQuestions.ts`, `hooks/useSideQuestionsBridge.ts`, `components/SidebarSideQuestions.tsx`)
- **omp 18.7's `/btw`**: a question asked WHILE the main reply keeps running, answered in the Side Bar's "This chat" view, never entering the transcript. omp keeps every topic in a sidecar beside the session file (`<session minus .jsonl>/btw-history/entry-<id>.json`, shared with its own TUI), one question at a time. RPC: `btw {question, recordId?}` → `{record}` (`recordId` = a follow-up in that topic), `btw_cancel {recordId?}`, `get_btw_history`; frames `btw_delta {recordId, delta}` and `btw_record {record}`. An older omp answers `Unknown command`, and Cody hides the whole surface (latched per page; `ompVersionHasBtw` reads the installed version from `loadEngineInfo()` first). pi/ACP engines never see it: the route is `requireEngine("omp")`, their vocabularies answer `unsupported`.
- **Typed `/btw <question>` is intercepted, never sent.** omp's own `/btw` is a TUI command: over the RPC `prompt` path it would reach the model as literal text. `ChatInput.handleSend` takes it (`parseSideQuestionCommand`) BEFORE the streaming gate, so it works idle and mid-run; attachments → refused with a toast (draft kept); a refusal restores the draft; an empty `/btw` only checks that asking is possible. Once the engine took the question (or for a bare `/btw`) `ChatWindow.askSideQuestion` calls `onOpenSideQuestions`: AppShell's `handleOpenSideQuestions` opens the right panel on the Side Bar tab (on a phone the panel is full-screen, so it also closes the session drawer) and bumps a request token the Side Bar consumes once — it flips to This chat, and a bare `/btw` also puts the cursor in the question box. A refusal opens nothing. `scheduleBlock` refuses it (`btw.scheduleReason`). Another engine's own `/btw` (Claude Code has one) is untouched: `onSideQuestion` is only passed for omp (ChatWindow `sideQuestionsCapable`). The palette offers `/btw` while a run is live too and drops omp's engine-reported copy.
- **Frames never touch the chat.** `rpc-manager.handleFrame` takes `btw_delta`/`btw_record` on an early path (resets the idle timer so an answering child is not idled out, emits, returns): never `notifyRunningChange`, run flags or the delivery ledger. The browser hands them to `useSideQuestions.applyFrame` BEFORE the message-update coalescer (routed through it, every delta would flush the pending `message_update` early). A `notice` with `source:"btw-history"` (omp could not save a topic) goes to the Side Bar's error row, and `lib/notifications/observer.ts` ignores it (its `level:"error"` would become the text of an unrelated failed run).
- **Merge rules are the bug magnet (`lib/btw.ts`).** omp writes the first `btw_record` BEFORE the `btw` response, the response can reach the browser after the first deltas, and a history read can be older than a frame that arrived while it was in flight. A frame is authoritative (`btw_record` replaces; the last one of a turn carries the full answer, healing any missed delta). A command answer or history read is a snapshot: `mergeBtwSnapshot` replaces a topic only when it is at least as far along (more turns; finished beats running, so an `interrupted` read ends a stale running one) and NEVER grows a topic the page shows as running (its deltas may still arrive as frames and would be appended twice). A snapshot never removes a topic.
- **History without spawning.** `GET /api/sessions/<id>/btw` (omp only, owner-checked like `local-routing`): a live child answers `get_btw_history` inside a 3 s bound (`supported:true`; `Unknown command` → `supported:false`; a timeout → the sidecar read WITHOUT recovery, since a live writer's `running` is real); no child → `lib/btw-history.ts` reads the sidecar (≤ 200 files, ≤ 1 MiB each, ≤ 8 MiB total, symlinks refused) and maps `running` → `interrupted` (the writer died, as omp itself does on reopen). Opening a cold chat spawns nothing. The page reads it on open and on every stream (re)connect, and every 4 s while a topic shows as answering, so a dropped stream never leaves "Answering…" on screen.
- **Asking from a chat with no stream open** (`ensureSideQuestionStream`) opens it first: that also starts a cold chat's engine, and frames only reach an attached page. `btw` is NOT part of the outbox/prompt machinery (no ledger row, no run state, no stop latch). The wrapper bounds its ack at 30 s (`BTW_ACK_TIMEOUT_MS` → `btw_ack_timeout`) and never recycles the child for it; `btw_cancel` with no live child answers `{cancelled:false}` without spawning. A follow-up is offered only after a COMPLETE answer (omp's own TUI rule); a cancelled/failed/interrupted topic is followed by a new question instead.
- **UI: the Side Bar, never the composer.** Nothing sits under the composer. The state stays with the main chat (`useSideQuestions` inside its `useAgentSession`, next to the event stream that carries the frames) but is SHOWN in the Side Bar tab (`SidebarChatPanel` → `SidebarSideQuestions`), on another branch of the tree. `useSideQuestionsBridge` carries it across: AppShell owns one bridge, `ChatWindow` publishes `sideQuestions` into it, `SidebarChatPanel` subscribes with `useSyncExternalStore`, so AppShell itself never re-renders for a streaming answer. A release only counts for the publisher that made it (the old chat's cleanup cannot clear the new chat's state when one replaces the other), and the view is keyed on `sideQuestions.sessionId`, so a half-typed question never follows the reader into another chat. `engineOkForPage` (useSideQuestions) lets a chat opened later start with the omp-version answer instead of "unknown", so the switch does not blink away between two chats.
- **The "This chat | New chat" switch** is a `SegmentedControl` (ids `sidebar-mode-*`, 40px segments on touch) at the top of the Side Bar, shown only while the bridge holds an `available` state. With none (another engine, an omp older than 18.7, no main chat yet) the Side Bar is exactly the New chat view. The rules live in the pure reducer `lib/sidebar-mode.ts` (tested; the component only dispatches `choose` / `request` / `gone` / `focused`): the choice is dropped when This chat goes away, so it cannot jump back by itself when another chat appears, and a request token is consumed once even when it arrives with the Side Bar's first mount (the tab loads on first use). BOTH views stay mounted (a streaming sidebar answer and any draft survive the flip), and while an answer arrives with New chat showing, the This chat segment wears a pulsing dot.
- **This chat** lists topics newest first (ten, the rest behind Show all), scrolls back to the top when a new topic appears, and puts the new-question box at the bottom, built like the New chat composer: Enter sends, Shift+Enter adds a line, no attach button (side questions are text only), `.composer-textarea` keeps it 16px on touch, `.chat-input-shell` gives it the main composer's focus glow. Send is disabled while any answer runs (omp answers one at a time) and says why in its title; the box stays editable. Follow-up boxes live inside each topic and appear only after a COMPLETE answer. Sizes follow the pointer (`touch` prop, defaulting to `useIsMobile() || useIsCoarsePointer()`): a finger gets 16px inputs and ≥ 38px controls, a mouse the 30px / 13px of the New chat composer's Send button. A card's footer line is its one statement of state (Answered / Cancelled / Interrupted / Failed); a note under the answer appears only when it adds something (why it was interrupted, the engine's reason for a failure), never to repeat the footer.

