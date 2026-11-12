# Disk and storage: growth bounds, janitor, low-disk gate, checkpoints

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Nothing Cody or its engine writes may grow without bound
- Disk hygiene: per-chat scratch, the janitor, the low-disk gate (`lib/disk/`)
- Disk exhaustion is a first-class failure (`lib/disk-space.ts`)
- Checkpoints must never snapshot a home directory or Cody's own state

### Nothing Cody or its engine writes may grow without bound
- Every store that grows per turn, per spawn or per screenshot needs an owner
  that prunes it, inside Cody (see `lib/harness/housekeeping.ts`) — never a
  host cron. Measured on the owner's instance before this rule: 21 GB of leaked
  checkpoint packs, a 5.2 GB memory DB, ~75 screenshots a day in /tmp, ~50 temp
  dirs per `npm test`, and 7,700 memories (88% of the store) that were Cody's own
  one-shot jobs (plan keeper, Distill, session namer, model planner) retained
  because their overlay's memory switch was ignored. Those junk memories were
  also RECALLED into real chats. When adding anything that writes per event,
  add its pruning in the same change.

### Disk hygiene: per-chat scratch, the janitor, the low-disk gate (`lib/disk/`)
On 2026-11-04 the owner's server hung when its disk filled: Cody's /tmp held
208 GB (50,193 top-level leftovers: test temp dirs, a cargo target dir per
attempt, toolchains) and /data 162 GB. Every chat inherited the shared /tmp and
nothing owned what it left. The host now only has native ZFS quotas (no cron,
no script, by the owner's choice), so Cody's own janitor is the ONLY cleanup.
- **Per-chat scratch** (`scratch.ts`). Every MAIN chat's engine (omp rpc and ACP;
  never sidebar, one-shots, terminals or logins) runs with
  `TMPDIR`/`TMP`/`TEMP`/`CODY_SCRATCH` = `<tmp>/cs/<12 hex>` (`CODY_SCRATCH_ROOT`
  moves the root). Short on purpose: unix sockets under TMPDIR are capped at 108
  bytes. The index `cody-scratch.json` (0600) maps a dir to every id the chat had
  (temp id → real id, omp's move to a new id), so a restart, resume or reboot
  reuses the same dir. Never removed on engine exit or idle dispose (a resumed
  chat still needs its venv or build dir); removed on chat delete unless another
  live engine runs in it, and by the janitor. `engineChildEnv(extra, { timeZone,
  scratchDir })` applies it and always sets `CODY_DISK_AREAS` (what the extension
  probes). Every main chat's engine also gets `CODY_DATA_SCRATCH=<data root>/<the same 12
  hex>` (`dataScratchRoot()`: env `CODY_DATA_SCRATCH_ROOT`, else `<agent
  dir>/cody-data-scratch`; the agent dir is on the data volume). It exists
  because per-chat `TMPDIR` is on /tmp, a different filesystem from the code
  checkouts, and some test harnesses need temp space on the SAME disk as the
  code (agents had been pointing `TMPDIR` at `~/tmp`, which then filled with
  killed runs' leftovers). `scratchEnv(dir)` makes it (0700, lazily, on every
  spawn) and refuses a root that is the temp dir, home, agent dir or scratch
  root. Lifetime = the tmp scratch's: kept across restarts, removed by
  `removeScratchDir` together with the tmp dir (chat delete, janitor), and a
  data dir that no index entry and no tmp dir owns is an orphan
  (`listOrphanDataScratch`) that the janitor removes after `scratchIdleDays`
  (never a live chat's, never one a process uses, only with a readable process
  table). A chat whose tmp dir a reboot emptied keeps its data twin until its
  index entry is forgotten (30 days). The Settings disk card's per-chat size is
  tmp + data bytes; the janitor's disk budget pass now looks at both disks and
  only removes a chat's scratch if it holds something on a disk that is over
  budget. Tests that start real sessions must point `CODY_SCRATCH_ROOT` inside
  their private root. `lib/bash-output.ts` also accepts
  `<scratchRoot>/<12 hex>/pi-bash-*.log`.
- **The janitor** (`janitor.ts`, `sweep.ts`, `walk.ts`, `transcripts.ts`,
  `mentions.ts`; settings in `cody-disk.json` via `settings.ts`; last report in
  `cody-janitor-report.json`). Hourly, single-flight, never throws. Removes the
  scratch of chats idle `scratchIdleDays` (default 3; a live chat's never),
  orphan scratch dirs, top-level entries of the temp dir idle `tmpIdleHours` (24)
  and top-level DIRECTORIES of `~/tmp` idle `homeTmpIdleHours` (72; files there
  are helper scripts and tokens and are kept), and checkpoint shadow repos past
  `checkpointMaxAgeDays`/`checkpointMaxGb` (never a live workspace's). Inside `~/tmp` only, top-level directories whose NAME looks like a killed test
  run's leftover are swept after `testLeftoverIdleHours` (default 6, never
  longer than `homeTmpIdleHours`) instead of 72 h, under every other check
  (nothing inside changed, no process names it, no recent transcript names it,
  not a dot-entry/special/protected). `looksLikeTestLeftover` (`sweep.ts`)
  matches (a) a stand-alone 3–7 digit number that is not a pid in the process
  table now (`lumashow-ui-test-123456-abc`; a 4-digit 1970–2100 number is a
  year, not a pid; no process table → this shape never matches), or (b) a
  mkdtemp suffix: `-` or `.` then exactly six `[A-Za-z0-9]` with a digit and a
  letter (`paneldim-a1B2c3`). Everything else in `~/tmp` keeps 72 h. A temp
  entry goes only when ALL hold: nothing inside changed (mtime AND ctime) in the
  window, no process references it (one /proc scan per run: cwd, exe, root, fds,
  maps, cmdline, environ, bound unix sockets — environ matters because a venv's
  python resolves to /usr/bin), no chat file changed in 72 h names it in its
  recent tail (128 MiB per run), and it is not a dot-entry, special file, mount,
  symlink, the scratch root, the agent/home dir, the server cwd or `<tmp>/jiti`
  (the server's transpile cache: deleting it crashes the next import). Any doubt
  (truncated walk, `find` error, unreadable /proc) keeps the entry, and a second
  look runs just before the first removal. Above `budgetPercent` (70) used it also
  removes scratch of non-live chats idle ≥ 6 h, oldest first. Deletion is a
  separate niced `rm -rf`: Node's recursive rm floods the libuv pool every chat
  shares (measured 2.4 s stalls). Live chats are read from
  `globalThis.__ompSessions`; a registry that cannot be read keeps everything.
- **The low-disk gate** (`gate.ts`, thresholds in `status.ts`: low < 15 % free,
  critical < 5 %). At critical, `/api/agent/[id]` and `/api/agent/new` answer
  507 `disk_full` with a plain sentence before anything starts; commands that
  start NEW work are refused, while steer/abort into a running turn pass so a
  person can tell an agent to clean up. The outbox treats it as a final failure
  (Retry/Edit stay); scheduled sends and run recovery postpone and retry without
  using up an attempt. `describeEngineError` names ENOSPC/EDQUOT in plain words.
- **The agent rule** (`lib/omp/extensions/cody-disk-budget.ts`, a fourth
  `--extension` for main omp chats, inherited by subagents): appends the
  "Scratch and disk budget" rule to the system prompt (sizes read once per
  process, so the prompt cache holds; it says those figures override any
  remembered one), and below 15 % free adds a hidden `cody-disk-low` line per
  prompt and an `additionalContext` note on tool results (throttled). Trap: in
  omp ANY extension that registers `tool_call`/`tool_result` vetoes
  `task.speculativeLaunch`, so the `tool_result` handler is registered lazily,
  only once a disk has been seen low. Constants mirror `status.ts` (tested). When `CODY_DATA_SCRATCH` is set the rule gets one more fixed line: tests that
  need temp space on the code's disk use `$CODY_DATA_SCRATCH`, never `~/tmp`,
  `/data/home/tmp` or another fixed folder (text is fixed per process: prompt
  cache).
- **Helper-agent memory limit** (`lib/omp/extensions/cody-context-budget.ts`, a
  fifth `--extension` for main omp chats): for SUBAGENTS only, appends one
  system-prompt line saying at what size omp summarises their history and to
  keep `context_notes` current. The size is what omp itself applies to that helper's model, read from
  `<agent dir>/config.yml` (re-read when its mtime changes: one `statSync` per
  helper start) by `resolveHelperLimit` in `lib/helper-memory-limit.ts`; the
  extension passes the live `ctx.model` (provider, id, contextWindow) so the
  per-model thresholds apply (Bun-only, no config → a generic line). The text is fixed per agent+model window+config (prompt
  cache) and it registers no `tool_call`/`tool_result` handler (see the disk
  note: that vetoes `task.speculativeLaunch`). The Behavior › Context card
  "Helper agents' memory limit" (`components/settings/engine/HelperMemoryCard.tsx`,
  logic in `helper-memory.ts`) edits that map through `/api/omp-settings`, which
  reads and replaces the `task.agentCompactionThresholdOverrides` map WHOLE
  (so the client spreads it and unknown agents survive), and toggles
  `compaction.experimentalContextManagement` (all chats, not only helpers).
- **Helper memory limit: one implementation.** The helper memory limit has ONE
  implementation: `lib/helper-memory-limit.ts` (`resolveHelperLimit`,
  `effectiveHelperLimit`, `limitTokens`, `clampPercent`, `parseOverride`). It
  mirrors omp 18.9+ `resolveCompactionPoint`, in this order: the agent's
  `task.agentCompactionThresholdOverrides[<agent>]` (a token count or "N%");
  else the entry for the helper's model in `compaction.modelThresholds`
  (`enabled` not false; exact `provider/id` key beats the longest prefix
  pattern ending in `*`; the value is `"f<N>"` = N% of the window shown as a
  fixed-size trigger, `"N%"`, or a plain number = a base token count with
  optional `reserveTokens`); else root `compaction.thresholdTokens`; else root
  `thresholdPercent`. `limitTokens` follows the engine's arithmetic: a token
  limit at or above the model's window means "window minus the reserve"
  (`max(15 %, reserveTokens ?? 16384)`; an impossible reserve falls back to
  15 %), a share is clamped to 1-99 % and floored. The model is optional:
  without it (the subagent chips and transcript header, whose progress events
  carry no provider/id: `subagentContextGauge` in `lib/subagent-format.ts`,
  config from `hooks/useHelperLimitConfig.ts`) only the override, root
  keys and the new window-minus-reserve and clamp rules apply; the helper's own
  prompt line (`lib/omp/extensions/cody-context-budget.ts`, which imports the
  module by relative path — its only Cody import) knows the model and so also
  honours `modelThresholds`. The Settings card
  (`components/settings/engine/helper-memory.ts`) uses the same module; never
  write a second copy. `compaction.modelThresholds` and
  `compaction.reserveTokens` have no `ui` in omp (hidden), so they stay out of
  the schema and the panel; a per-model editor belongs to the Models hub, not
  Behavior. `readNativeSettings` returns `compaction.thresholdTokens` /
  `thresholdPercent` (validated, round-tripped on write).
- **Settings › System › Disk space** (`components/settings/DiskSection.tsx`,
  `/api/disk`: GET for any signed-in user, POST `{action:"clean"}` and PUT
  settings admin-only): meters against the quotas, the five largest scratch
  folders by chat title, the undo-snapshot total, the last clean, "Clean idle
  scratch now", and the idle-days setting (the rest, including `testLeftoverIdleHours`, under Advanced).
- **Background services (Settings › System › Services).** `lib/omp/services.ts` wraps `omp ps --all --json` (works on 18.8.3 and 18.19): list + stop/kill of detached engine services. `app/api/services/route.ts` is admin-only and validates the pid/name against the live list before stopping anything.
- **Replay data (Settings › System › Disk).** `lib/omp/gc-strip.ts` + `app/api/disk/replay-data/route.ts` drive `omp gc strip-replay-data` (18.19+; feature-detected, hidden on 18.8.3): GET previews bytes saved, POST applies. Admin only. `gc.autoCompress` is deliberately not exposed (APFS/NTFS only, no-op on Linux).

### Disk exhaustion is a first-class failure (`lib/disk-space.ts`)
- The instance data dir is finite and often quota-capped (a ZFS dataset on
  Unraid appdata). When it fills, npm dies with `errno -122` — EDQUOT, which
  libuv has no name for, so npm prints "Unknown system error -122" and the
  admin sees what looks like a Cody bug. `describeDiskError()` matches the
  NUMERIC errno (-122 linux, -69 macOS) as well as EDQUOT/ENOSPC text,
  because the unnamed form is the one that actually shows up.
- Engine installs preflight both filesystems they touch — the tools prefix AND
  the npm cache (`$npm_config_cache` else `$HOME/.npm`), which are frequently
  different mounts and where the cache is the one that filled in the field.
  Unreadable free space NEVER blocks an install: unknown is not empty.
- `/api/info` serves `storage` for the agent dir and the Info panel turns the
  row warning-colored under 2 GB, so the condition is visible before it bites.
- **The preflight threshold is measured, not fixed.** npm updates a package by
  renaming the old tree aside and unpacking the new one, so an update needs
  room for BOTH. omp is ~1.4 GB installed (two ~160 MB native addons among the
  rest), which a flat 512 MB floor waved straight through into the failure it
  existed to prevent. `requiredFreeBytes()` measures the installed tree and
  demands `size + 256 MB`, falling back to the floor only for a first install
  or an unmeasurable tree.
- **An interrupted install poisons every later one.** npm leaves its
  rename-aside tree (`@scope/.name-XXXXXX`) behind, then tries to rename onto
  that exact path next time and fails `ENOTEMPTY` forever — one out-of-disk
  install permanently blocked updates on a real instance until the directory
  was deleted by hand. `cleanStaleInstallDirs()` sweeps them before every
  install, matching npm's pattern for that package only.
- **npm exiting 0 is not proof the engine runs.** A disk-full install left a
  TRUNCATED native addon that loaded fine as a file and then killed the
  process with a Bus error on every invocation — Cody had reported the engine
  as installed. Installs now probe `<binary> --version` before reporting
  success and fail with the probe's own error otherwise, which also surfaces
  the revert affordance.
- **Trap — `formatBytes` lives in `lib/format-bytes.ts`, not `disk-space.ts`.**
  The latter imports `node:fs`; a CLIENT component importing from it pulls
  `fs` into the browser bundle and fails the build with "Can't resolve 'fs'".
  Typecheck and unit tests both pass — only `next build` (or loading the page)
  catches it.

### Checkpoints must never snapshot a home directory or Cody's own state
- Shadow repos live under the AGENT dir, keyed by a hash of the workspace
  path. Two consequences bit a production instance hard:
  - A session that opened `/data/home` as its workspace grew a **3.5 GB**
    shadow repo out of `.npm`, `.gradle` and a node_modules tree — those roots
    carry no `.gitignore`, so nothing was excluded. `isUncheckpointableRoot()`
    now refuses home, filesystem roots, and the agent/data dir (which would
    otherwise feed on its own output). Refusal returns null, the established
    "no checkpoint here" answer every caller already tolerates.
  - `checkpoints.test.mjs` created workspaces in `/tmp` but the shadow repos
    followed `getAgentDir()`, so every test run inside the container leaked
    into live appdata — **465** stale `cody-ckpt-*` repos. The test now sets
    `PI_CODING_AGENT_DIR` to a temp dir BEFORE importing the module. Any test
    touching agent-dir state must do the same.
- A second production failure was /data/home/LumaShow: it is not a git repo,
  has no .gitignore, and contains about **4.3 GB** of untracked files (including
  a ~1 GB Android NDK under tools/, 148 MB of tarballs under downloads/, a
  538 MB disk image under backups/, and Rust target/ trees). Every 15-second
  git add -A timeout left another 400–530 MB temporary pack/object behind:
  **52 leaked packs used 21 GB**, and there were **zero successful checkpoints**.
  Each send waited 15 seconds or longer before reaching the agent.
- New shadow repos exclude common dependency, compiler and cache dirs:
  node_modules/, target/, .gradle/, .venv/, venv/, __pycache__/,
  .pytest_cache/, .mypy_cache/, .ruff_cache/, .next/, .nuxt/, .svelte-kit/,
  .vite/, .output/, .turbo/, .cache/, dist/, and coverage/. NOT `build/`: in
  plenty of projects that name holds source, and an excluded directory quietly
  drops out of every undo snapshot.
  Each snapshot measures untracked files and excludes files larger than 20 MB using
  escaped, workspace-root-anchored literal patterns in the shadow repo's info/exclude.
  Those per-file rules are regenerated every time, so a file that shrinks can be
  captured later. Never exclude tracked files that grow; restore must be able to
  put those back.
- Sends spend at most 14 seconds on a snapshot. A timeout returns null and starts
  one low-priority warm-up (up to 10 minutes); further sends skip immediately
  while it runs. Restore uses the same per-workspace queue and waits for that
  warm-up. If it fails, cody-backoff.json skips snapshots for six hours; a later
  successful snapshot clears the marker.
- After a timed-out git process is killed, temporary tmp_pack_*, tmp_obj_*, and
  the fresh index.lock it left are removed. The first shadow-repo use in each
  process also sweeps those leftovers and removes an index.lock older than the
  snapshot timeout.

