# omp session file format (v3)

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

## omp Session File Format (v3)

Location: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"title","v":1,"title":"...","source":"...","updatedAt":"...","pad":"   ..."}   ← fixed 256-byte slot
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"...","modelId":"...","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
```

- Line 1 is a fixed-width 256-byte padded title slot, rewritable in place.
  Old pi files may lack it — the `{"type":"session"}` header is then line 1.
- Entries form a tree via `(id, parentId)`. Additional entry types
  (`title_change`, `session_init`, `mode_change`, `ttsr_injection`, ...) must
  be tolerated by readers.
- Large payloads (images) are externalized to the content-addressed blob store
  at `~/.omp/agent/blobs` and referenced from entries.
- Header may carry `continuationOf` (omp 18.13.2+): the id of the session this
  file carries on from. See "RPC session lifecycle" and the list collapse above.
- `model_usage` entries record a billed call that is not a transcript message
  (late response, discarded turn with `purpose: "discarded-turn"`, cache refresh,
  helper call). From omp 18.12.4 an entry written off the active branch names
  the branch it interrupted in `activeLeafId` (`null` = a cleared session). The
  head is NOT blindly the last entry: use `resolveSessionLeafId(entries)`
  (`lib/omp/session-files.ts`); `buildSessionTree` leaves such dead-end entries
  out. From omp 18.17.0 they count in omp's own totals, the cost cap and
  `omp stats`, so Cody sums them too: `aggregateModelUsage(entries)`
  (`lib/session-usage.ts`), `GET /api/sessions/<id>` returns it as `modelUsage`
  (omitted when zero), the page adds it to the totals it sums from messages, and
  the subagent usage scan (`lib/subagent-history.ts`) includes it.
- Every entry may carry `runtime: {version, commit, branch, label}` (omp 18.11+,
  the build that wrote it). Readers ignore unknown keys; Cody shows nothing from
  it.
- Fork and `/tan` pair a call the parent left unresolved with a `toolResult` that
  has `isError: true` and the text "...its outcome is unknown." It renders as an
  ordinary failed tool result; it is never shown as a success.
- A compaction entry's `preserveData.snapcompact` can hold up to 12 MB (24 MB
  with the reasoning-free copy) of base64 PNG frames on ONE line. Never render
  `preserveData` (`compactionUiMessage` uses `summary` only). Readers that touch
  raw lines must tolerate lines of tens of MB: `MAX_SESSION_LOAD_BYTES` is 1 GiB,
  the statistics indexer steps over lines above 64 MiB, and the disk janitor's
  transcript tail (`readTranscriptMentions`, 2 MiB) is raw text cut mid-line and
  scanned by needle, so a huge last line costs one tail read and no allocation
  per line (test: `lib/disk/transcripts.test.mjs`).
- Silent custom entries (`date-cwd-reminder`, `memory_recall`,
  `source_session_init`, `system-prompt-digest`) have `type: "custom"`, which the
  reader never turns into a row. Custom MESSAGE types that are bookkeeping are
  listed in `HIDDEN_CUSTOM_TYPES` (`lib/message-display.ts`): now also
  `auto-parallel-plan`, `skill-notice`, `memory-recall-changes`,
  `streaming-edit-recovery` and, from omp 19.0.0, `eval-prelude-guide` (the
  model-only note about the eval prelude). `session-transfer` (omp 18.10
  `session pack/unpack`) stays visible, titled by
  `messageView.sessionTransferLabel`. omp 19's `async-notify` (a `bash`
  `notify` match that woke the chat, `details.reports[]`) is not hidden: it
  folds into "Background activity" as kind `notification`, never needing
  review (`backgroundActivityKind`, `backgroundMessageIdentity` in the same
  file). Other 19.0.0 shapes the readers already handle: `model_usage`
  entries (skipped), `compaction` entries with `method: "handoff" | "soft"`,
  assistant `contextSnapshot` / `duration` fields (ignored), spilled output at
  `<session>/local/N.log` instead of `<session>/N.bash.log`.
- omp 19.1.0 adds `custom` entries `tool_approval_requested` / `tool_approval_resolved` (`data` has `toolCallId`, `toolName`, `approved`, `reason`, timestamps) and stamps an assistant message that a retry saga replaced with `retryRecovery {kind:"auto-retry", status:"recovered"|"superseded", ...}` (19.0 wrote the stamp too). The reader ignores the first pair; `entryToUiMessage` hides a stamped message only when its `usage` is zero, so the cost total (which sums the rebuilt messages) stays whole. Fixtures: `lib/fixtures/omp-19.1.0-{approval-records,retry}.json`.

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

