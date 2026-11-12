# Chat UI: session list caching, switching, scroll, completion sound

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Session list caching — new sessions must appear immediately
- Session switching: paint from cache, never wait on the engine
- Chat scroll: a follower is pinned to the tail, a reader is pinned to their content
- Completion sound

### Session list caching — new sessions must appear immediately
- `listAllSessions()` (sidebar, command palette) is cached twice: a 30s TTL
  list cache in `lib/session-reader.ts` plus an mtime-keyed directory walk in
  `lib/omp/session-files.ts` (`listSessionFiles`).
- The walk cache keys on the **sessions root** mtime. On Windows/NTFS a new
  `.jsonl` inside an existing project subdirectory does NOT bump the root
  mtime, so the walk stays stale indefinitely.
- `invalidateSessionListCache()` (fired on `agent_end`, `session_info_update`,
  compaction, renames) must therefore ALSO clear the walk cache via
  `invalidateSessionFileListCache()` — never add a session-mutation path that
  forgets this. Regression test: `session-reader.test.mjs`.
- **No cache fixes a file that does not exist yet.** A brand-new session has
  no `.jsonl` until its first message is *persisted* — measured at ~5s after
  `agent_start` against omp, and unbounded in principle. Until then the
  session cannot be listed from disk at all, so the sidebar's row exists only
  client-side. `retainPendingSessions()` (`lib/project-ordering.ts`) keeps
  those rows until the server list reports the same id; the sidebar
  accumulates them rather than rendering only the selected one, which is what
  makes a new session survive the user switching away mid-run. The server
  side still self-heals separately: `signalWhenSessionFileAppears()` in
  `lib/rpc-manager.ts` polls for the file after `agent_start` and re-signals
  the sidebar once it lands.
- **The list reads a 4 KiB prefix, and omp 18.7 can fill it before the first
  message.** The spawn-time `xdev-mount-notice` (~3 KB with Cody's roster)
  pushed the first user message past the window: the row said "(no messages)"
  and the session namer, which needs that message, never named the chat.
  `scanSessionInfo` reads a 64 KiB prefix once more when the 4 KiB one holds
  no user message; scans are memoized per (size, mtime), so that is one extra
  read per file version. Regression test: `lib/omp/session-list-window.test.mjs`.
- - **Chat list ordering ("last active").** Each session in `/api/sessions`
  carries `lastActiveAt`: the time of the newest user message or assistant
  reply, read from the file tail (`lastActiveFromTail` in
  `lib/omp/session-files.ts`: 64 KiB tail, widened to 1 MiB only when that holds
  no such message; memoized with the rest of the scan on size+mtime). File mtime
  (`modified`) is only the fallback, because title rewrites bump it. The sidebar
  has a Recent / Projects switch (`cody:sidebar-view`, default Recent). Recent
  is one flat list across all visible projects ordered by `sortRecentSessions`
  (`lib/project-ordering.ts`): not-yet-persisted chats from
  `retainPendingSessions` first, then `lastActiveAt` desc, ties keep list order.
  The sort is a memo over the session list, so it re-sorts when the list
  refreshes and never on running/unread/clock ticks. Per-project trees also sort
  by `lastActiveAt`; the project order itself is unchanged.

**One row per chat, even after a move.** `SessionInfo.continuationOf` (read from
the header by `scanSessionInfo`) lets `collapseContinuedSessions`
(`lib/session-reader.ts`) drop the earlier copy once a listed row continues it
and nothing was said in it after the new file began; a copy that was written
afterwards holds turns the other lacks, so both stay (that is also when omp's own
resume leaves the older copy alone). omp decides this by whether the older copy's
newest entry id is held by the newer file; Cody does not read whole files for the
list, so it uses `earlier.lastActiveAt <= copy.created` instead. A chat that moved
several times is one row, forks of an earlier copy hang from the row shown, and
`/api/sessions/<id>` still reads every copy by its own id. Delete and Archive of
the row take the earlier copies along (`listSupersededCopies`) so none returns as
a chat. `lib/session-tools.ts` (cross-session awareness) collapses the same way.
The list's first-prompt scan (`scanSessionInfo`) is a head window plus a tail
window; when a chat's first prompt sits behind a large leading entry (for
example a `memory_recall` custom entry written before the first turn) the head
window holds no user message, so the scan walks the gap line by line
(`forEachFileLineSync` stops when the callback returns true) instead of
reporting an empty chat. Tests: `lib/session-collapse.test.mjs`,
`lib/omp/session-list-window.test.mjs`.

### Session switching: paint from cache, never wait on the engine

The owner saw slow switches and sessions that stayed blank, even after a
refresh, until a turn finished. Three causes, each measured on a real 21 MB
session:

- **The transcript never waits for engine state.** `loadSession` fetches the
  transcript and `/state` concurrently and releases the loading gate when the
  TRANSCRIPT settles. Gating it on the state fetch is what kept a session
  blank: state rides omp's serialized RPC queue, so it can sit behind a
  running turn's command for the whole turn.
- **Server: parse once per file version.** `loadSessionFileCached`
  (lib/session-reader.ts) memoizes the parse by path, size, mtime and load
  options. The ownership check runs before any hit. Repeat GETs went from
  0.9–1.6 s to 0.04–0.19 s.
- **Client: stale-while-revalidate across switches.**
  `lib/session-transcript-cache.ts` (12 sessions, 15 min) lives above the
  per-switch remount, so a revisited session paints before any request
  (2.4–3.0 s → ~0.45 s) and then refreshes. Deleting a session clears its
  entry.
- **A switch aborts the old session's requests** (AbortController per
  mount), so a slow response from the session you left can never land on the
  one you opened.
- **An inconclusive read is not "idle".** A `stale` state without a
  snapshot never finishes a running turn in `reconcileAgentState`. If the
  server says running but has no fresh state, the SSE stream still connects,
  so live frames are not dropped. A failed reload keeps what is painted and
  posts a notice; a first load that fails shows Retry, never a blank pane.

### Chat scroll: a follower is pinned to the tail, a reader is pinned to their content
- Two states, one flag (`completionScrollAllowedRef`, "following"). Following:
  every commit and every content resize re-pins the bottom (`scrollToBottom`
  "instant" — the follow effect, throttled to one rAF per run; the
  ResizeObserver; the terminal re-pin layout effect). Reading (the user
  scrolled up): NO programmatic scroll ever runs; the **reader pin** holds the
  viewport on the same content instead. Sending a prompt re-engages following.
- **The reader pin** (`lib/transcript-anchor.ts`, wired in useAgentSession):
  on every user scroll the anchor is captured — the row at the container's
  top edge, named by `data-turn-index` (+ `data-turn-part` for a message
  rendered in slices: `group` / `process` / `answer`), the `data-block-index`
  inside it, and both offsets — and after EVERY commit (a layout effect with
  no deps) and on every content resize (the same ResizeObserver) the
  anchored element is put back at its offset before paint. Identity, not DOM
  node, is the point: three transitions remount the rows under a reader and
  browser scroll anchoring lets go at each — `message_end` swaps the
  streaming bubble for a committed row (thinking collapses), `agent_end`
  unmounts the bubble and folds the turn into a collapsed process group, and
  the terminal reload re-keys every tail row from `idx-N` to its entry id —
  and Safari has no scroll anchoring at all. Measured before: a reader lost
  282px at turn end with `scrollTop` untouched (the content moved under a
  pixel restore). After: ≤5px for one frame on desktop, 0px on a phone.
  The streaming bubble therefore carries `data-turn-index={messages.length}`
  (the index it will have once committed) and every assistant block gets a
  `data-block-index` wrapper, so an anchor inside the bubble is found again
  in the row that replaces it.
- **Nothing a reader is looking at folds or closes under them.** A run that
  ends while the user is reading sets `readerHoldsTail`: the last turn stays
  in its live, unfolded layout until they return to the bottom (`holdLiveTail`
  into `buildTranscriptUnits`). A thinking box whose auto-expansion ends
  (the next block starts, or the committed row replaces the bubble) stays
  open when the anchor names that block and the anchored box was taller than
  a bare header (`anchorIsInsideOpenBlock`, `TranscriptViewportContext`) —
  latched as if the user had opened it, so a click still closes it.
- **Scroll events: intent decides who moved.** wheel / touchstart / keyboard
  / pointerdown mark intent for 1.2s. Without intent, our own scrolls are
  told apart by VALUE (an instant write lands on a known `scrollTop`,
  `expectedScrollTopRef`) or by a short window for a UA-animated one. What
  remains (a momentum flick past the window, find-in-page, the browser's
  own anchoring adjustment, a clamp when content below shrank) re-captures a
  READER's anchor but can never demote a FOLLOWER: a clamp's scroll event is
  delivered a frame late, by which time new tokens have grown the content
  and the geometry reads "not at bottom" — measured stranding a follower
  180px above the tail. Pin corrections are deferred while a touch scroll
  (finger down, or momentum still delivering events) is in flight.
- The lazy-load prepend needs no distance-from-end restore any more — the
  pin holds the reader through it (the old restore ignored content still
  streaming in at the bottom and ran after paint); only a CLICK on the banner
  moves the viewport to the loaded page, and re-anchors there.
- Programmatic smooth scrolling must respect `prefers-reduced-motion`
  (`usePrefersReducedMotion` in `hooks/usePrefersReducedMotion.ts` — also the
  only way to stop SVG SMIL animations, which CSS cannot).

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

