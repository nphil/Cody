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
  `{"name","arch":"x86_64|aarch64","cpus","memMB","slots","tools":[...],"limits":{"onlyWhenIdle":bool}}`
  (`amd64`/`arm64` are read as `x86_64`/`aarch64`; `slots` defaults to 1, `tools` to none). `checkWorkerFacts`
  (`lib/machines/types.ts`) is the ONE gate for the file and for what is saved: names are lower case words, `cpus`
  1–4096, `memMB`, `slots` 1–64, at most 64 tools. Nothing else a worker says is used.
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
- **Placement** (`placement.ts`, pure). Eligible = known healthy worker of the requested `arch` with every requested
  tool and a free slot (`running < slots`), at least 512 MB available, and, when `onlyWhenIdle`, CPU at or under 25%.
  Best = most free cores (idle cores minus a slot's share for each job Cody started in the last 6 s), then fewest
  running jobs, then most free memory, then name. `busy` (would fit once something ends: queue) and `none` (nobody ever
  could: wrong arch, missing tools, down) are different answers.
- **Queue and fallback** (`scheduler.ts`). One dispatcher per server, first in first out; a freed slot goes to the
  oldest job that can use it. 16 jobs wait at most, 30 min each. It re-looks every 5 s while anything waits. Knowledge
  of a worker, newest wins: live meter (6 s fresh), ssh probe (cached 15 s, a failure 30 s, dropped when a job ends
  there), Cody's own job count. `local: true` in the request (the agent allowed `fallbackLocal` and this server has the
  arch and tools — `localFits`) means "busy" answers "run here" at once; `none` with nothing local fitting is refused
  with every machine's reason in plain words. `fallbackLocal: false` waits in the queue instead.
- **Copy in** (`files.ts`, `tarball.ts`, `transfer.ts`). The project is the git repository around `cwd` (the whole
  repository, so `../shared` and the top lockfile are there), else `cwd`. Default file list is
  `git ls-files -co --exclude-standard` (submodules up to 3 deep): `node_modules` and ignored files are NOT copied, so the
  command installs its own dependencies. `include` globs (relative to `cwd`, at most 64) replace the default list; `.git`
  and `node_modules` are skipped by a glob unless a pattern names them. Over 100,000 files or 1 GiB is refused with a
  hint to narrow `include`. The system `tar -c --null --no-recursion -T -` writes the archive; the far side runs
  `umask 077 && mkdir -p <job>/<cwd> && tar -xof - -C <job>`. No data for 90 s = a stuck connection.
- **Run** (`remote.ts`, `execute.ts`). `buildExecCommand` is a fixed script around values Cody made (job directory,
  token) or `shQuote`d (the agent's command, at most 24 KiB): it starts the command from the copy of `cwd`, niced
  (`nice -n 19`) and in its own process group (`setsid`) when those programs exist, between `@@cody-<token>-started` and `@@cody-<token>-exit:<code>`; the token is random, so nothing the job prints can pass for them.
  The exit marker is the ONLY proof the command ended and with which status. No start marker within 60 s = it
  never ran. The time limit (default 1800 s, at most 7200 s) counts from the start marker; at the limit or on cancel
  ssh's stdin is closed. Cody never writes to it and never uses `-n`: that open pipe is the dead-man's switch, so when
  Cody dies, however it dies, the kernel closes the pipe and the far wrapper stops the job's process group
  (TERM, KILL 5 s later); whatever the command left running in its group is stopped when it ends. `.pid` and `.done` marker files sit in the job directory root.
- **Results back** (`tarball.ts` `TarExtractor`). `results` (at most 64 paths, relative to `cwd`) are validated BEFORE the
  job (`checkResultPaths`: no absolute path, no `..`, not `.`, not `.git`, must stay inside the workspace). What comes back is
  produced by another machine and is NOT trusted: Cody's own reader restores regular files and directories only, under
  those paths, never through a link that leaves the project (200,000 files / 4 GiB at most); links and special files are
  skipped and counted. They are copied also when the command fails (so a log or a report comes back) but NOT after a
  timeout or a lost run. Existing files are overwritten, nothing is deleted. One retry when the copy back fails.
- **Drops and reruns** (`run.ts`). A worker that fails BEFORE the command started (unreachable, the copy failed) is
  excluded and the next one is asked for. One that goes away AFTER the start (connection lost, container stopped, no exit
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
- **Where the tool is offered.** omp main chats: a server-settled host tool in `SERVER_HOST_TOOLS` (`lib/rpc-manager.ts`:
  not the sidebar chat); progress is `host_tool_update`, `host_tool_cancel` and engine exit abort the job through
  `serverToolCalls`/`abortServerToolCalls`, and a late result is dropped. Claude/Codex (ACP): `bin/cody-display-mcp.js`
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
