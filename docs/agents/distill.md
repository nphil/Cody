# Distill: model-written summaries

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

### Distill: summaries that never break with the engine
- **What it is.** A user-chosen model (Settings › Models › Assignments ›
  Distill: primary + ordered fallbacks, `lib/distill/config.ts`) summarizes
  two things on the client's request (`hooks/useDistill.ts`): a COLLAPSED
  thinking block shows a one-line running summary under its header
  (`data-testid="thinking-summary"`, re-requested while streaming every
  ≥600 chars and ≥4 s ONLY while collapsed — nothing to show a running
  summary for while the box is open), plus a FINAL summary requested once
  the block settles REGARDLESS of whether it happens to be expanded right
  then (`thinkingSummaryKeys` in useDistill.ts decouples the two keys), so
  it is already there, or already in flight, the moment the reader later
  collapses it. A FINISHED reply is replaced by a distilled version at the
  Preferences verbosity (Off/Low/Medium/High, `lib/distill-preferences.ts`)
  with a "Show full reply" footer (`distilled-reply` / `distill-toggle`).
  Replies are distilled ONLY when finalized in this page session or already
  cached; history is never distilled on load, and replies under
  `REPLY_DISTILL_MIN_CHARS` (400) are left alone because a paraphrase of a
  short answer is not shorter.
- **Isolated, or every attempt times out.** Every one-shot child (Distill's
  and the session namer's) runs against `getOneShotAgentDir()`
  (`lib/omp/isolated-agent-dir.ts`: empty `mcp.json`, `agent.db`/
  `models.yml`/`config.yml`/`blobs` SYMLINKED to the real ones, never
  copied, so credential refresh and provider edits still reach the one real
  store) — the same idea `sidebarAgentDir()` and the web-research planner
  already used, now one shared helper instead of three copies of it.
  Measured cause of "summaries never appear": the real agent dir's
  user-scope MCP servers made every spawn connect to them first — 45-58s on
  a real install's two servers — before the model ever saw the prompt,
  against a 20s per-attempt timeout that therefore could never succeed.
  Isolated, the same spawn answers in single-digit seconds (~2-4s of fixed
  omp startup, the rest is the model's own latency); `THINKING_TIMEOUT_MS`
  is now 30s, sized off THAT measurement with margin for a legitimate
  multi-turn retry a role's own fallback chain can trigger — not off the
  old MCP tax. The web-research planner (`lib/model-presets/research.ts`)
  keeps its OWN fresh directory per run instead of the shared one: it
  spends its turn on untrusted web content, so a longer-lived shared dir is
  the wrong shape for it regardless of the file-linking logic being shared.
- **Trap — a config overlay must use NESTED keys.** omp resolves a setting
  by path segments, so a flat `memory.backend: off` line in an overlay is a
  key literally named "memory.backend" that nothing reads (verified with
  `PI_CONFIG_FILES=<overlay> omp config get memory.backend`, omp 18.3.4). The
  one-shot overlay (`lib/model-plan/one-shot.ts`) and the sidebar overlay
  (`SIDEBAR_OVERLAY_YAML` in rpc-manager) were written flat, so none of their
  switches applied: every Distill/session-name run booted the full memory
  system (an ~800 MB embedding worker per run, recall into the prompt, its own
  transcript retained into the shared memory DB), and the sidebar loaded the
  workspace's project MCP config. ~4,400 omp processes a day were spawned on
  the owner's instance. `one-shot.test.mjs` parses the overlay and fails on
  any dotted top-level key.
- **The subagent "summary" is not a model.** Chips and the transcript dialog
  show the raw tool-call intent strings and the verbatim `<id>.md`; the
  reusable one-shot mechanism is the session namer's `omp -p --mode=json`
  run (`lib/model-plan/one-shot.ts`), which Distill drives with `--model=`
  per attempt.
- **The material is fenced and the task restated after it.** The other
  assistant's raw text sits inside `<assistant_reasoning>`/
  `<assistant_reply>` tags with the task repeated again right after the
  closing tag (`buildDistillPrompt` in prompts.ts). The material is often
  the OTHER assistant's own first-person narration ("I need to find...",
  "I'll check..."), which a model that follows instructions weakly
  continues instead of describing once system-prompt instructions are pages
  behind it; putting the instruction where generation actually starts fixed
  that for every chain model tried, not only the strongest one.
- **Fall through, never fail hard.** Chain entries are validated
  syntactically only; Cody holds no opinion about which models exist. A
  spawn failure, non-zero exit, unknown model, timeout, empty answer, and a
  THINKING answer that addresses the reader instead of describing the
  material (`looksLikeReplyNotDescription` in prompts.ts catches the
  unambiguous self-referential opens — "I don't have...", "Sure, I can..." —
  the same english-only, high-precision trade-off session-namer's
  `REFUSAL_RE` already makes for the same class of failure) are ONE case:
  try the next selector, then the engine's own default with no `--model` at
  all. A distill that still fails leaves the original thinking or reply
  exactly as it was, with at most a muted "Could not distill · Retry" row.
  A server queue-overflow eviction (`DistillQueueOverflowError`, the
  waitlist was full and dropped the oldest, usually off-screen, waiter) is
  explicitly NOT that failure: it reads as never-asked and the client
  forgets the request, so a later visit to the same now-visible block tries
  again instead of staying latched at "Could not distill" forever.
- **Two kinds of "can't right now" are not the same.** `unsupported` (an ACP
  engine, no binary) is a structural, PERMANENT latch. A 401/403 is a
  transient auth hiccup (clock skew, an expired credential cache, a proxy
  needing re-auth) and only pauses every request for `AUTH_BACKOFF_MS`
  (60s), then tries again on its own — conflating the two used to mean one
  clock-skewed request disabled Distill for the rest of the page until
  reload.
- **Plain language is a phrasing toggle, not a third feature.**
  `plainLanguage` in `DistillPreferences` (default off, Settings ›
  Preferences, next to the existing Distill controls) asks the SAME
  summaries in everyday words instead of developer shorthand: a thinking
  summary names the goal rather than a code identifier unless the identifier
  IS the point, and a reply keeps every decision and outcome but explains
  jargon and never touches a command the reader must actually run. It rides
  on whichever of replies/thinking summaries is already on and starts
  nothing by itself. Sent as `plain` in the POST body and folded into BOTH
  the server cache key (`distillCacheKey`'s 5th segment) and the client
  store key, so a technical and a plain-language summary of the same block
  never collide or serve each other stale.
- **Deltas are an optimization.** `createFrameReader` in one-shot.ts is the
  pure NDJSON reducer: the answer comes from `turn_end`/`message_end` exactly
  as the namer takes it, every other frame type (including ones this build
  has never seen) is ignored silently, and a run whose streaming frames were
  all renamed still ends in one `done` with the whole text. `done.text`
  REPLACES what deltas built, never appends.
- **Cody-owned state.** The chain (`cody-distill.json`) and the summary cache
  (`cody-distill/<sessionId>.json`, keyed
  `${entryId}:${blockIndex|-}:${kind}:${verbosity|-}:${plain|-}`) live in
  the instance data dir, never in omp's config.yml or the engine's session
  files, so an engine upgrade or switch cannot lose or rewrite them. Under
  an ACP engine the routes answer `unsupported` and every Distill surface
  hides.
- **Smoothness.** The distilled reply streams through the coalescer, which reparses the full buffer on each animation frame, giving smooth multi-token reveals without a typewriter pacer. Thinking blocks auto-expand while streaming and collapse when finished, providing clear context hierarchy without jarring motion.
- **Trap — a collapse box must not animate its own growth.**
  `.collapse-box-panel` carries a `height` transition (with
  `interpolate-size: allow-keywords`, so `auto` is animatable) for open/close
  toggles. A thinking box grows on EVERY streamed token, so that transition
  re-targeted itself per delta and the box visibly lurched the whole time it
  streamed — the "janky thinking text" report. `ThinkingBlock` now marks the
  actively streaming box `data-streaming`, and `globals.css` drops the
  transition for exactly that box while the modifier class
  (`.collapse-box-panel--motion`, set by `useCollapseMotion` on a real
  toggle) is absent. Measured mid-stream afterwards: `transition-property:
  none`, p95 frame 18.6 ms, one frame over 32 ms in 1119.
- **Cancel subtask** (SubagentTranscriptDialog CancelSubtaskButton): omp 18.4+
  has `cancel_subagent` (`{subagentId}` → `{cancelled:boolean}`), which really
  kills the child (a lifecycle `aborted` frame follows). `runSubtaskCancel`
  sends it first: `true` → success toast, `false` → "already finished" toast
  (omp answers `false` for unknown/finished ids; it is a no-op, not an error),
  and an error matching `isUnsupportedCommandError` (18.3's `Unknown command:`
  or the wrapper's "not supported by this engine") flips a page-session flag
  and falls back to the old path: steer the PARENT (OMP 18.3 uses write
  proc://<id>/kill; the instruction names legacy hub cancel only for an older
  engine that lacks proc://). That fallback never claims the child was killed.
  The button needs no parent steer on 18.4+; on 18.3 it is gone when the
  parent can't be steered. Any other failure is a toast and the button stays.
- **Message this subagent** (`SteerSubagentBox`, dialog footer, running child
  only): `steer_subagent {subagentId, message}` (omp 18.4+; not the parent
  steer). omp holds the reply until the child accepts the message, so the box
  is disabled while sending and cleared only on success. On "Unknown command"
  the box hides for the rest of the page session with one info toast. The
  unsupported verdicts live in one module store (`useSyncExternalStore`) shared
  by the button and the box.

