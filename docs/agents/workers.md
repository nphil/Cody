# Workers: heavy jobs on other machines (`lib/workers/`)

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the section AGENTS.md summarizes.

Sections in this file:
- Workers: heavy jobs on other machines (`lib/workers/`, `lib/machines/`)

### Workers: heavy jobs on other machines (`lib/workers/`, `lib/machines/`)

An ssh machine in Settings › System › Machines can be switched on as a WORKER. The agent tool `run_on_worker`
`{command, cwd?, include?, results?, arch?, tools?, timeoutSeconds?, fallbackLocal?}` then sends one heavy command
there: copy the project in, run it niced, stream the output, copy `results` back, delete the copy. Everything else
(quick commands, edits, git, anything that needs this server's services, ports or secrets) stays local; the tool
description says so, and the operator's user `RULES.md` carries one line for every session and subagent.

- **The worker contract.** An ssh destination whose login runs POSIX `sh`, with `tar`, a work
  root `/srv/cody-work` on its own disk that the ssh user can write, and `/etc/cody-worker.json`:
  `{"name","arch":"x86_64|aarch64","cpus","memMB","slots","tools":[...],"mapPaths":["/data"],"limits":{"onlyWhenIdle":bool}}`
  (`amd64`/`arm64` are read as `x86_64`/`aarch64`; `slots` defaults to 1, `tools` to none). `checkWorkerFacts`
  (`lib/machines/types.ts`) is the ONE gate for the file and for what is saved: names are lower case words, `cpus`
  1–4096, `memMB`, `slots` 1–64, at most 64 tools. Nothing else a worker says is used.
  `mapPaths` (at most 8 absolute anchors such as `/data`, each passing `isMapAnchor`: never `/usr`, `/etc`, `/tmp`, `/var`…) names where the
  worker can show a project at the SAME absolute path as on the server (see "Same paths"); an old file without it reads as none.
- **Settings.** `cody-machines.json` gets `worker: true` and `workerFacts` per ssh machine (`store.ts`). The facts are
  kept only while the machine keeps the address they were read from (`saveWorkerFacts` refuses a stale write, and
  writes only when the facts changed, so the minute check does not rewrite the file). `PUT /api/machines` takes
  `machines[].worker` (a boolean; left out keeps it). `GET /api/machines` shows `worker`, `workerFacts` and
  `workerChecks` only to someone who may edit; the live stream carries `worker: {jobs, ready}` for workers and no address.
- **Checking a worker** (`health.ts`, `facts.ts`). ONE short ssh command (`buildWorkerCheckCommand`, `sh -c '…'`
  with no quote, backslash or `!`, like the meter loop) prints the facts file, whether `/srv/cody-work` is a writable
  directory, how many `j-*` job directories have a live process (it also deletes the ones older than 12 hours with no
  live process: what a crashed Cody left) and two meter frames in the exact shape `ssh.ts` prints, so placement has a
  CPU/memory reading even with nobody watching. Problems are CODES (`not_a_worker`, `bad_facts`, `no_work_root`, or
  an ssh reason), worded in the browser (`machines.worker.problem.*`). `POST /api/machines/worker-check {id}` (admin)
  backs the "Check worker" button (at most 2 checks at once, `429 worker_check_busy`); `startWorkerMonitor` checks every
  worker each 60 s while at least one `GET /api/machines/stream` is open (the last viewer leaving stops it).
- **Housekeeping on the worker** (the same check script, so nothing runs on a schedule of its own). Besides crashed `j-*` jobs it deletes
  the kept Cargo `target` dirs (`<work root>/keep/*`) and per-chat scratch (`<work root>/scratch/*`) untouched for 14 days, and when the
  work root's disk is over 85% full it deletes the oldest of those first (never one used in the last hour) until it is at or under 70%
  (`CACHE_MAX_AGE_DAYS`, `CACHE_PRESSURE_PERCENT`, `CACHE_RELIEF_PERCENT` in `facts.ts`).
- **Placement** (`placement.ts`, pure). Eligible = known healthy worker of the requested `arch` with every requested
  tool and a free slot (`running < slots`), at least 512 MB available, and, when `onlyWhenIdle`, CPU at or under 25%.
  Best = most free cores (idle cores minus a slot's share for each job Cody started in the last 6 s), then fewest
  running jobs, then most free memory, then name. `busy` (would fit once something ends: queue) and `none` (nobody ever
  could: wrong arch, missing tools, down) are different answers. A worker on Cody's own machine (its probe's boot id is
  Cody's: `sameHost`) counts `SAME_HOST_CORES` (2) fewer free cores, so a separate machine wins a near tie: its jobs
  would slow Cody's own chats.
- **Memory** (`lib/machines/memory.ts` pure, `memory-store.ts` ledger `cody-worker-memory.json` in the agent dir,
  `memory-watch.ts`). Costs no model tokens and nothing while all is well. Each job's peak memory comes back in its exit
  marker; a command's need (project + command shape) is the biggest of its last 3 runs in 14 days × 1.2, and placement
  puts the workers where it fits first. A worker whose kernel killed a job for lack of memory goes behind the others for
  5 min, one short of it (PSI `some avg10` ≥ 10%) for 2 min. A job killed for memory gets its one rerun only on a machine
  with MORE memory (`minCapMB`); with none, it fails and says so. Memory never refuses a job by itself: it only reorders.
  This server's own control group is watched by the kernel (`fs.watch` on `memory.events`, plus a 15 s timer for a slow
  climb): an out-of-memory kill is a line in the recent memory events, passing 90% of the limit sends one `memoryHigh`
  notification naming the biggest processes (again only after it fell under 80%). `GET /api/machines/memory` (any
  signed-in person, like the meters) feeds the Machines panel: jobs per machine in the last 24 h and the week's events.
- **Queue and fallback** (`scheduler.ts`). One dispatcher per server, first in first out; a freed slot goes to the
  oldest job that can use it. 16 jobs wait at most, 30 min each. It re-looks every 5 s while anything waits. Knowledge
  of a worker, newest wins: live meter (6 s fresh), ssh probe (cached 15 s, a failure 30 s, dropped when a job ends
  there), Cody's own job count. `local: true` in the request (the agent allowed `fallbackLocal` and this server has the
  arch and tools — `localFits`) means "busy" answers "run here" at once; `none` with nothing local fitting is refused
  with every machine's reason in plain words. `fallbackLocal: false` waits in the queue instead. While this server is short
  of memory (85% of its limit), a job that may run here waits up to `LOCAL_WAIT_MS` (60 s) for a worker, then runs here anyway.
- **Copy in** (`files.ts`, `tarball.ts`, `transfer.ts`). The project is the git repository around `cwd` (the whole
  repository, so `../shared` and the top lockfile are there), else `cwd`. Default file list is
  `git ls-files -co --exclude-standard` (submodules up to 3 deep): `node_modules` and ignored files are NOT copied, so the
  command installs its own dependencies. `include` globs (relative to `cwd`, at most 64) replace the default list; `.git`
  and `node_modules` are skipped by a glob unless a pattern names them. Over 100,000 files or 1 GiB is refused with a
  hint to narrow `include`. The system `tar -c --null --no-recursion -T -` writes the archive; the far side runs
  `umask 077 && mkdir -p <job>/<cwd> && tar -xof - -C <job>`. No data for 90 s = a stuck connection.
  `cwd` may sit outside the chat's workspace when it is inside another git repository (not one that contains the home directory), so a helper that works in
  a sibling checkout is not refused.
- **Sibling repositories** (`findOutsideDirs` in `files.ts`). Cargo path dependencies that leave the repository
  (`../../LumaShow/crate`, and what those use in turn: at most 256 crates, 512 manifests) are copied too, to the SAME path
  for the job. Each sibling git repository goes whole (its `git ls-files -co --exclude-standard`, without `target` and other
  build output; outside git the workspace or the lone crate), because a build script may read its assets (lumaglass's
  `lumashow-ui/build.rs` reads `palettes.json`). One that would take the copy past the limits, the project's own files
  counted, sends only what the build needs at the least: its crates' files and the workspace's top `Cargo.toml`. The result
  says "Also copied <dir>, N files (S), which the project builds from…". Nothing that holds the project or the home
  directory is ever copied this way.
- **Run** (`remote.ts`, `execute.ts`). `buildExecCommand` is a fixed script around values Cody made (job directory,
  token) or `shQuote`d (the agent's command, at most 24 KiB): it starts the command from the copy of `cwd`, niced
  (`nice -n 19`) and in its own process group (`setsid`) when those programs exist, between `@@cody-<token>-started` and `@@cody-<token>-exit:<code>`; the token is random, so nothing the job prints can pass for them.
  The exit marker is the ONLY proof the command ended and with which status. No start marker within 60 s = it
  never ran. The time limit (default 1800 s, at most 7200 s) counts from the start marker; at the limit or on cancel
  ssh's stdin is closed. Cody never writes to it and never uses `-n`: that open pipe is the dead-man's switch, so when
  Cody dies, however it dies, the kernel closes the pipe and the far wrapper stops the job's process group
  (TERM, KILL 5 s later); whatever the command left running in its group is stopped when it ends. `.pid` and `.done` marker files sit in the job directory root.
- **Same paths** (`mapPaths`, `remote.ts` `JOB_WRAPPER`). A worker whose facts list an anchor (say `/data`) and whose
  `<work root>/root<anchor>` holds a mirror of the server's toolchains and caches runs a project that lives under that anchor
  at the SAME absolute path: the wrapper starts the command in a private user+mount namespace (`unshare --user --map-root-user --mount`,
  no root needed), bind-mounts the overlay over the EMPTY real `<anchor>` and the job's copy over the project's path, so absolute
  paths in configs, `$HOME`-relative venvs and `.cargo/config.toml` resolve unchanged. It sources `<work root>/env.sh` (HOME and PATH of
  the mirror; the worker's own node/bun/python 3.11 come first) and gives the job `CODY_SCRATCH`/`CODY_DATA_SCRATCH`/`TMPDIR` under
  `<work root>/scratch/<chat scratch name>`, which persists for the chat. The topmost Cargo workspace's `target` directory is a keep-mount
  (`<work root>/keep/<hash of the project path>/…`), so the next build is incremental. Anything that does not hold (no namespaces, the
  anchor or the project path not empty, no overlay, a project outside every anchor or with an odd path) prints a
  `[cody] not run at <path> (<why>)` line and the command runs in the plain job directory instead; the result then also says so in its
  notes (with the reason), because paths under the anchor will not resolve. A path that holds files is never shadowed; one that holds
  only empty directories counts as empty (a job that ran docker with bind mounts leaves such directories at the real `/data/...`,
  as the Docker daemon works outside the job's namespace), and nothing is deleted. `env.sh` also points `npm_config_nodedir` at the
  headers beside the node on PATH (`<prefix>/include/node`): the namespace maps only root, so node-gyp cannot unpack the headers it
  downloads (`fchown EINVAL`) and a plain `npm ci` (node-pty) would fail. A worker's own node 22 needs its copy of the headers at
  `<mirror>/home/.local/share/cody-worker/include/node`.
- **Results back** (`tarball.ts` `TarExtractor`). `results` (at most 64 paths, relative to `cwd`) are validated BEFORE the
  job (`checkResultPaths`: no absolute path, no `..`, not `.`, not `.git`, must stay inside the workspace). What comes back is
  produced by another machine and is NOT trusted: Cody's own reader restores regular files and directories only, under
  those paths, never through a link that leaves the project (200,000 files / 4 GiB at most); links and special files are
  skipped and counted. They are copied also when the command fails (so a log or a report comes back) but NOT after a
  timeout or a lost run. Existing files are overwritten, nothing is deleted. One retry when the copy back fails.
- **Drops and reruns** (`run.ts`). A worker that fails BEFORE the command started (unreachable, the copy failed, including one that
  vanishes while the project is being sent: tar here then fails writing to ssh, `onlyDestinationWriteErrors` in `transfer.ts`, while ssh exits non-zero)
  is excluded and the next one is asked for (or this server, per `fallbackLocal`); it never ran, so it costs none of the one re-run. A genuine
  packing error on this side (an unreadable or vanished file) still fails the job with its reason: no other worker would do better. One that goes away AFTER the start (connection lost, container stopped, no exit
  marker) loses that run: Cody says so ("that run was lost and no result files were copied"), keeps the lost run's output file,
  and runs the command again from the start elsewhere (or here). A second loss is a failure, never a third run. The
  job directory is always deleted (a failed delete is reported with its path).
- **What the agent gets.** Progress while it runs (`progress.ts`: first non-empty line = status "Copying 1,650 files (20 MB) to <label>…",
  "Running on <label> · 12 s", "Waiting for a worker (2 of 3, 8.0 s): <why>"; then the newest 20 output lines; at most twice
  a second and again every 5 s so a quiet compile still shows time moving). The result starts with `Exit code N:` and where it ran,
  then timing, results, and the last 200 output lines (at most 48 KB); the WHOLE output (terminal colours and cursor codes
  removed, a rewriting progress bar shown as its last state) is in `<chat scratch>/workers/<job id>.log` (cut at 32 MB;
  a rerun writes `-2`), the path is in the result. `isError` is true for any non-zero exit, a timeout, a cancel, a refusal
  and a job that could not be completed (for example result paths that were not produced).
- **Where the tool is offered.** omp chats (not the sidebar, not the smallest local profile): the extension
  `lib/omp/extensions/cody-run-on-worker.ts`, NOT a host tool. omp hands host tools to the main chat only (0 of 2,558 helper sessions ever held
  it, and helpers ran 89% of the heavy commands), while an extension reaches every helper. `lib/workers/access.ts` gives the engine
  `CODY_WORKERS_ENDPOINT`/`_SESSION`/`_TOKEN` (a capability for `scratch:<scratch folder name>`: a session id does not exist when the engine starts);
  the extension posts to `POST /api/internal/workers`, which finds the chat with `findRpcSessionByScratch` and takes `cwd` and scratch from it. It refuses an
  agent with neither `bash` nor `eval` (a read-only scout gets no shell through it), defaults `cwd` to the caller's own directory, shows progress as tool
  updates and hangs up (the job stops) when cancelled. It registers NO `tool_call`/`tool_result` handler (that would switch off `task.speculativeLaunch`).
  The words are `lib/workers/definition.ts`. Claude/Codex (ACP): `bin/cody-display-mcp.js`
  registers it and posts to `POST /api/internal/workers` (capability-token auth, on `proxy.ts`'s `PUBLIC_EXACT`, env
  `CODY_WORKERS_ENDPOINT` from `lib/display/engine-tools.ts`/`capability.ts`). The route answers `application/x-ndjson`:
  `{"type":"progress","text"}`, `{"type":"heartbeat"}` every 15 s, last `{"type":"result","text","isError"}`; the bridge
  has NO fetch timeout for this one tool (a job may run two hours), forwards progress as MCP progress notifications when
  the client asked for them, and aborting the call aborts the fetch, which makes the server stop the job and clean up.
- **State on `globalThis`**: `__codyWorkerScheduler` (`live.ts`: one queue for the server, whichever bundle loaded
  the tool) and `__codyWorkerRegistry` (`lib/machines/jobs.ts`: jobs per machine, the newest check per machine). The
  Machines dropdown reads the job count from the stream (`MachinesPanel.tsx`), the sampler's `notifyMachinesChanged`
  pushes a fresh frame when a count or a health state changes. No `@/` under `lib/workers/` or `lib/machines/`.
- **Seams for tests.** `shell.ts` (`RemoteShell`) is the single place that knows ssh exists. `lib/workers/local-shell.mjs`
  makes THIS machine act as a worker (the real generated scripts and real `tar` run for real; it can also drop the
  connection on cue); `run-ssh.test.mjs` puts a stand-in `ssh` first on PATH to test the real `sshShell`.
- **Do not.** Put `-n` on ssh or hand a job's ssh stdin to anything; build a remote command from anything but constants
  and `shQuote`d values; accept `results: ["."]`; unpack a result with `tar -x` instead of `TarExtractor`; report success
  without the exit marker; make workers the default for ordinary commands; add `@/` imports under `lib/workers/`.
- **Known limits.** `.pid`/`.done` sit in the job directory root and show in `ls -a`. "waited N s for a worker" includes
  the first machine check when the facts are stale. Edits made in the workspace while a job runs are not copied. A worker
  that stops its container (the Proxmox guard does when the Windows VM runs) loses its running jobs: Cody reruns them once.
  Unraid's Docker ignores `--memory-swap` (moby #51480): a container worker there gets swap 0 only through its parent
  control group (docs/unraid.md › Build worker), and Cody's own container can still swap. Docker bind mounts name host paths the
  namespace does not change. A job must write its temporary files to `$TMPDIR`/`$CODY_SCRATCH`/`$CODY_DATA_SCRATCH`, not to `$HOME/tmp` or
  anything else under `/data/home`: on a worker that shows the server's home read-only the write fails (`ENOENT`/`EROFS`), and a test that waits
  on it can hang until the job's timeout (`lib/notifications/end-to-end.test.mjs` does this). `node_modules` is never kept: install inside `command`. A short test run (about 10 s) loses to copy-in plus install.
- **Mirroring a worker.** The overlay is a plain directory on the worker's work disk (`<work root>/root<anchor>`), filled with
  `scripts/sync-worker-mirror.sh` (rsync of an explicit list: cargo/rustup, `~/.local/bin`, uv pythons, Go, `toolchains` and
  `~/.cache/toolchains` (the sysroot's system-library links copied as real files, swift's links kept), the generated swift
  config, named venvs and an ffmpeg bundle with wrapper scripts; never `~/.ssh`, tokens or `agent.db`; never deletes).
  It needs `rsync` on both ends (the Cody image has it). Cody does NOT sync it by itself: re-run the script after installing
  a toolchain or venv on the server. Worker-only: node 22, bun and python 3.11 under `home/.local/share/cody-worker/bin` and
  `<work root>/env.sh`. The facts file's `tools` is what resolves on the job PATH inside the namespace.
- **A worker beside Cody** (`docker/worker/cody-worker`, `listen.py`, `docker/unraid-worker-template.xml`). A second container
  from Cody's image, started with that entrypoint, is a worker with no mirror to keep: Cody's home is bind-mounted into it
  READ-ONLY at `<work root>/root/data/home`, a live view. What builds write to caches (the `OWN` list: npm, cargo registry,
  uv, pip, zig, sccache, the clang module cache, swiftpm, …; add more with `CODY_WORKER_OWN_EXTRA`) gets the worker's own
  writable copy on its disk. Its sshd answers on a Unix socket in a folder both containers share (no network port), it has
  its own memory limit with swap 0, and every job is niced. It shares Cody's boot id, so it is `sameHost`. Setup, limits
  and undo: docs/unraid.md › Build worker.
