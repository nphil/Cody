import { createHash, randomBytes } from "node:crypto";
import { shQuote } from "./shell";

/**
 * The commands that run on a worker, and the reader for what the job prints.
 *
 * Each is a fixed script around a few values Cody made itself (the job
 * directory, a token) or quoted with {@link shQuote} (a relative path, the
 * agent's command). They are sent as `sh -c '…'` so the login shell never has
 * to understand them, the same way the meter loop is.
 */

/** A command is passed on one ssh command line (a few quotes may grow it fourfold); the kernel allows about 128 KiB per argument. */
export const MAX_COMMAND_BYTES = 24 * 1024;

const SAFE_DIRECTORY = /^\/[A-Za-z0-9_./-]*[A-Za-z0-9_]$/;
const TOKEN = /^[0-9a-f]{8,32}$/;

export function newJobId(now: number = Date.now()): string {
  return `j-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** A word printed around the job's end so nothing the job prints can pass for it. */
export function newToken(): string {
  return randomBytes(8).toString("hex");
}

export function jobDirectory(workRoot: string, jobId: string): string {
  if (!SAFE_DIRECTORY.test(workRoot)) throw new Error("Refusing a work root with unusual characters");
  if (!/^j-[a-z0-9]+-[0-9a-f]+$/.test(jobId)) throw new Error("Refusing a malformed job id");
  return `${workRoot}/${jobId}`;
}

function checkedDirectory(directory: string): string {
  if (!SAFE_DIRECTORY.test(directory)) throw new Error("Refusing a job directory with unusual characters");
  if (directory.split("/").includes("..")) throw new Error("Refusing a job directory with a parent-directory step");
  return directory;
}

/** An absolute path made of plain steps only: nothing to quote, no empty, `.` or `..` step. */
function plainPath(path: string): boolean {
  return SAFE_DIRECTORY.test(path) && path.split("/").slice(1).every((step) => step !== "" && step !== "." && step !== "..");
}

function checkedToken(token: string): string {
  if (!TOKEN.test(token)) throw new Error("Refusing a malformed job token");
  return token;
}

function wrap(lines: readonly string[]): string {
  return `sh -c ${shQuote(lines.join("\n"))}`;
}

function inside(directory: string, relative: string): string {
  return relative ? `${directory}/${relative}` : directory;
}

/** Make the job directory (and the working directory in it) and unpack the tar stream on stdin into it. */
export function buildCopyInCommand(directory: string, cwdRel: string, hasFiles: boolean): string {
  const dir = checkedDirectory(directory);
  const steps = ["umask 077", `mkdir -p ${shQuote(inside(dir, cwdRel))}`];
  if (hasFiles) steps.push(`tar -xof - -C ${dir}`);
  return wrap([steps.join(" && ")]);
}

/** A chat's scratch directory name (the last part of its path on this server): hex Cody made itself. */
const SCRATCH_KEY = /^[0-9a-f]{6,32}$/;

/** Show the project at the path it has on this server, so one command works in both places. */
export interface ExecMap {
  /** The project's top directory on this server (real path). The job's copy appears at exactly this path. */
  project: string;
  /** The worker's `mapPaths`: directories it keeps empty for this. The one that holds `project` is used. */
  anchors: readonly string[];
}

/**
 * The script a mapped job runs in (inside its private user and mount
 * namespace): `sh -c` with eleven arguments: the job directory, the project
 * path, the anchor, the working directory (relative to the project), the work
 * root, the chat's scratch name, the project's cache id, `1` when a user and
 * mount namespace is in place, a note to print, the directories outside the
 * project it needs (space-separated, see {@link buildExecCommand}), and the
 * command. No single quotes in here: it is quoted twice on the way out.
 *
 * With a namespace it puts the worker's mirror of the anchor (`<work
 * root>/root<anchor>`, holding toolchains and caches at their server paths,
 * with whatever is mounted inside it) over the anchor's empty directory, the
 * job's copy over the project's path inside it, the copies of the outside
 * directories over theirs, and a persistent directory over the Cargo `target`
 * of the project (the topmost Cargo.toml from the working directory up), so a
 * second build is incremental. It never covers something writable that has
 * files in it (a directory that holds only empty directories counts as empty:
 * docker bind mounts leave such leftovers at the real paths); a read-only
 * directory (a worker that shows the server's own files read-only) may be
 * covered by the job's copy. Any step that fails
 * leaves the command running in the plain job directory, with one line saying
 * why, so the agent knows its absolute paths do not resolve. Then: the chat's
 * persistent scratch, the worker's own `env.sh` (when it has no syntax error),
 * and the command. The job is the first thing the kernel stops when the
 * worker runs out of memory (`oom_score_adj` 1000).
 */
const JOB_WRAPPER = [
  "D=$1 M=$2 T=$3 R=$4 W=$5 K=$6 H=$7 NS=$8 NOTE=$9; shift 9; X=$1 C=$2",
  "{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null",
  // Empty means nothing but directories (find does not follow links; an error line counts as content): a job that ran
  // docker with bind mounts leaves empty directories at the real paths, and those must not stop later jobs.
  'bare() { [ -z "$(find "$1" ! -type d 2>&1 | head -n 1)" ]; }',
  "ok=0; why=",
  'if [ -n "$M" ]; then',
  '  if [ "$NS" != 1 ]; then why="user namespaces are not available"',
  '  elif [ ! -d "$T" ] || [ -L "$T" ]; then why="the worker has no empty $T directory"',
  '  elif ! bare "$T"; then why="$T is not empty on the worker"',
  '  elif [ ! -d "$W/root$T" ]; then why="$W/root$T does not exist"',
  '  elif ! mount --rbind "$W/root$T" "$T" 2>/dev/null; then why="mounting $T failed"',
  '  elif [ -L "$M" ] || ! mkdir -p "$M" 2>/dev/null; then why="$M cannot be made"',
  '  elif [ -w "$M" ] && ! bare "$M"; then why="$M is not empty on the worker"',
  '  elif ! mount --bind "$D" "$M" 2>/dev/null; then why="mounting the project at $M failed"',
  "  else ok=1; fi",
  "fi",
  'if [ "$ok" = 1 ]; then',
  "  CODY_JOB_MAPPED=1; CODY_MAPPED_ROOT=$M; export CODY_JOB_MAPPED CODY_MAPPED_ROOT",
  '  top=; d=$M; [ -n "$R" ] && d=$M/$R; n=0',
  '  while [ "$n" -lt 64 ]; do',
  '    [ -f "$d/Cargo.toml" ] && top=$d',
  '    [ "$d" = "$M" ] && break',
  "    d=${d%/*}; n=$((n+1))",
  "  done",
  '  if [ -n "$top" ]; then',
  '    rel=${top#"$M"}; rel=${rel#/}; t=${rel:+$rel/}target; kd=$W/keep/$H/$t',
  '    if [ ! -L "$M/$t" ] && [ -z "$(ls -A "$M/$t" 2>/dev/null)" ] && mkdir -p "$kd" "$M/$t" 2>/dev/null; then',
  '      mount --bind "$kd" "$M/$t" 2>/dev/null && touch "$W/keep/$H" 2>/dev/null',
  "    fi",
  "  fi",
  "  for P in $X; do",
  '    if [ -L "$P" ] || ! mkdir -p "$P" 2>/dev/null; then why="it cannot be made"',
  '    elif [ -w "$P" ] && ! bare "$P"; then why="it is not empty on the worker"',
  '    elif ! mount --bind "$D-ext$P" "$P" 2>/dev/null; then why="mounting it failed"',
  "    else continue; fi",
  '    echo "[cody] $P, which the project uses from outside itself, is not there on the worker ($why)"',
  "  done",
  '  cd "$M/$R" 2>/dev/null || cd "$M"',
  'elif [ -n "$M" ]; then',
  '  echo "[cody] not run at $M ($why): it runs in $PWD on the worker, so paths under $T do not resolve here"',
  'elif [ -n "$NOTE" ]; then',
  '  echo "[cody] $NOTE"',
  "fi",
  'if [ -n "$K" ]; then',
  '  Z=$W/scratch/$K',
  '  if mkdir -p "$Z/tmp" "$Z/data" 2>/dev/null; then',
  '    touch "$Z" 2>/dev/null',
  '    CODY_SCRATCH=$Z/tmp CODY_DATA_SCRATCH=$Z/data TMPDIR=$Z/tmp TMP=$Z/tmp TEMP=$Z/tmp',
  "    export CODY_SCRATCH CODY_DATA_SCRATCH TMPDIR TMP TEMP",
  "  fi",
  "fi",
  'if [ -r "$W/env.sh" ]; then',
  '  if sh -n "$W/env.sh" 2>/dev/null; then . "$W/env.sh"; else echo "[cody] $W/env.sh has a syntax error and was skipped"; fi',
  "fi",
  'exec sh -c "$C"',
].join("\n");

/** Two paths where one is the other or holds it. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Where a mapped job's project appears: at its own path under the worker's anchor that holds it, or (with why) in the job directory. */
function placeProject(map: ExecMap | undefined): { project: string; anchor: string; note: string } {
  if (!map) return { project: "", anchor: "", note: "" };
  const wanted = map.project;
  const found = map.anchors.find((candidate) => plainPath(candidate) && wanted.startsWith(`${candidate}/`));
  if (!plainPath(wanted)) return { project: "", anchor: "", note: "this project's path has unusual characters, so it runs in the worker's own job directory" };
  if (!found) {
    return { project: "", anchor: "", note: `${wanted} is not under ${map.anchors.join(" or ")}, the only paths this worker can show a project at, so absolute paths into the project do not resolve here` };
  }
  return { project: wanted, anchor: found, note: "" };
}

/**
 * Which of `external` (directories on this server that the project uses from
 * outside itself) a job on this worker sees at their own paths: plain paths
 * under the anchor the project is shown at, that neither hold the project nor
 * sit inside it, outermost first. None when the project itself is not shown at
 * its own path.
 */
export function mountableExternal(map: ExecMap | undefined, external: readonly string[]): string[] {
  const { project, anchor } = placeProject(map);
  if (!project) return [];
  return [...new Set(external)]
    .filter((entry) => plainPath(entry) && entry.startsWith(`${anchor}/`) && !overlaps(entry, project))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/**
 * Run the agent's command in the copy of its working directory.
 *
 * It prints `@@cody-<token>-started` once the directory is entered, the job's
 * own output (stdout and stderr together), and last
 * `@@cody-<token>-exit:<code>:<peak KB>:<OOM kills>`; no exit marker means the
 * connection or the machine went away mid-run. The peak is the most memory the
 * job's processes held together (summed every 2 seconds from `/proc`), the OOM
 * count how many processes the kernel killed for memory in the worker's
 * control group while it ran; either is empty when the worker cannot tell.
 *
 * The job runs at low priority in its own process group (when `setsid` exists)
 * with no stdin, and it is the first thing the kernel stops when memory runs
 * out. Cody keeps ssh's stdin open and never writes to it: the
 * session's stdin is saved as fd 3 and a watcher reads it, so the moment Cody
 * closes it on purpose (a timeout, a cancelled call) or dies by any means, the
 * watcher stops the job: TERM to its group, KILL five seconds later. Without
 * it a job whose ssh vanished would run on, unwatched, for good. `.pid` names
 * this script's shell so a later check can tell the job is alive; `.done` stops
 * a late watcher from signalling a group that is already gone. Whatever the
 * command left running in its group is stopped when it ends, so a build that
 * starts a background server does not leave it on the worker.
 *
 * With `map` and/or `scratch` the command goes through {@link JOB_WRAPPER}
 * (a private user + mount namespace when the worker allows one) first.
 * `external` names directories outside the project that it uses (a Cargo path
 * dependency in a sibling repository); their copies are in `<job>-ext<path>`
 * and appear at their own paths, when those are under the same anchor.
 */
export function buildExecCommand(options: {
  directory: string;
  cwdRel: string;
  command: string;
  token: string;
  map?: ExecMap;
  /** The chat's scratch directory name: the job gets its own persistent `CODY_SCRATCH`, `CODY_DATA_SCRATCH` and `TMPDIR`. */
  scratch?: string;
  /** Server paths of directories outside the project the job needs, copied to `<directory>-ext<path>`. */
  external?: readonly string[];
}): string {
  const dir = checkedDirectory(options.directory);
  const token = checkedToken(options.token);
  const scratch = options.scratch && SCRATCH_KEY.test(options.scratch) ? options.scratch : "";
  const { project, anchor, note } = placeProject(options.map);
  const external = mountableExternal(options.map, options.external ?? []);
  const wrapped = Boolean(options.map) || scratch !== "";
  const workRoot = dir.slice(0, dir.lastIndexOf("/"));
  const launch = wrapped
    ? [
      ...(project ? ['U=; NS=0; if unshare --user --map-root-user --mount true >/dev/null 2>&1; then U="unshare --user --map-root-user --mount"; NS=1; fi'] : ["U=; NS=0"]),
      `$S $N $U sh -c ${shQuote(JOB_WRAPPER)} cody-job "$D" ${[project, anchor, project ? options.cwdRel : "", workRoot, scratch, project ? createHash("sha1").update(project).digest("hex").slice(0, 16) : ""].map(shQuote).join(" ")} "$NS" ${shQuote(note)} ${shQuote(external.join(" "))} ${shQuote(options.command)} </dev/null 2>&1 3<&- &`,
    ]
    : [`$S $N sh -c ${shQuote('{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null; exec sh -c "$0"')} ${shQuote(options.command)} </dev/null 2>&1 3<&- &`];
  return wrap([
    "umask 077",
    `D=${dir}`,
    `cd ${shQuote(inside(dir, options.cwdRel))} 2>/dev/null || { echo @@cody-${token}-nodir; exit 0; }`,
    'echo $$ > "$D/.pid"',
    `echo @@cody-${token}-started`,
    "exec 3<&0",
    "S=; command -v setsid >/dev/null 2>&1 && S=setsid",
    'N=; command -v nice >/dev/null 2>&1 && N="nice -n 19"',
    'E=/sys/fs/cgroup/memory.events; o=$(sed -n "s/^oom_kill //p" $E 2>/dev/null)',
    ...launch,
    "p=$!",
    '( cat <&3 >/dev/null 2>&1; [ -e "$D/.done" ] && exit 0; kill -TERM -$p 2>/dev/null || kill -TERM $p 2>/dev/null; sleep 5; kill -KILL -$p 2>/dev/null || kill -KILL $p 2>/dev/null ) >/dev/null 2>&1 &',
    "w=$!",
    "( m=0; while kill -0 $p 2>/dev/null; do t=$(cat /proc/[0-9]*/status 2>/dev/null | awk -v s=$p '/^Name:/{a=0} /^NSsid:/{a=($2==s)} /^VmRSS:/{if(a)r+=$2} END{print r+0}'); [ \"${t:-0}\" -gt \"$m\" ] 2>/dev/null && m=$t && echo $m > \"$D/.peak\"; sleep 2; done ) >/dev/null 2>&1 3<&- &",
    "q=$!",
    "wait $p",
    "rc=$?",
    ': > "$D/.done"',
    "kill -KILL -$p 2>/dev/null",
    "kill $w $q 2>/dev/null",
    'k=$(sed -n "s/^oom_kill //p" $E 2>/dev/null)',
    'case "$o:$k" in *[!0-9:]*|:*|*:) k= ;; *) k=$((k-o)); [ "$k" -ge 0 ] || k= ;; esac',
    'm=$(cat "$D/.peak" 2>/dev/null); case "$m" in *[!0-9]*) m= ;; esac',
    `printf '\\n@@cody-${token}-exit:%s:%s:%s\\n' "$rc" "$m" "$k"`,
  ]);
}

/** The marker that ends the text section of {@link buildCopyBackCommand}'s answer. */
export function copyBackMarker(token: string): string {
  return `@@cody-${checkedToken(token)}-data\n`;
}

/**
 * Send paths (relative to the job directory's top) back as a tar stream. The
 * answer starts with a text section, one `missing:<n>` line for each path (by
 * its position in `paths`) that does not exist, then the data marker, then the
 * tar bytes. `@@cody-<token>-nodir` means the job directory is gone.
 */
export function buildCopyBackCommand(options: { directory: string; paths: readonly string[]; token: string }): string {
  const dir = checkedDirectory(options.directory);
  const token = checkedToken(options.token);
  const names = options.paths.map((entry) => shQuote(`./${entry}`)).join(" ");
  return wrap([
    "umask 077",
    `cd ${dir} 2>/dev/null || { echo @@cody-${token}-nodir; exit 0; }`,
    "i=0; set --",
    `for p in ${names}; do if [ -e "$p" ] || [ -L "$p" ]; then set -- "$@" "$p"; else echo "missing:$i"; fi; i=$((i+1)); done`,
    `echo @@cody-${token}-data`,
    'if [ $# -gt 0 ]; then exec tar -cf - "$@"; fi',
  ]);
}

/** Delete the job directory (and the copies of outside directories next to it) once nothing of the job is alive (waiting a few seconds for a stopped one to go). */
export function buildCleanupCommand(directory: string, workRoot: string): string {
  const dir = checkedDirectory(directory);
  const root = checkedDirectory(workRoot);
  if (!dir.startsWith(`${root}/j-`)) throw new Error("Refusing to delete a directory that is not a job directory");
  return wrap([
    `D=${dir}`,
    `case "$D" in ${root}/j-*) ;; *) exit 98;; esac`,
    'p=$(cat "$D/.pid" 2>/dev/null); n=0',
    'while [ -n "$p" ] && kill -0 "$p" 2>/dev/null && [ "$n" -lt 15 ]; do sleep 1; n=$((n+1)); done',
    'rm -rf "$D" "$D-ext"',
    '[ ! -e "$D" ] && [ ! -e "$D-ext" ]',
  ]);
}

// ── Reading what the job printed ─────────────────────────────────────────────

/** What the worker could tell about a job's memory when it ended. */
export interface JobMemory {
  /** The most memory the job's processes held together; null when unknown. */
  peakBytes: number | null;
  /** Processes the kernel killed for memory in the worker's control group while the job ran; null when unknown. */
  oomKills: number | null;
}

export type ExecEvent =
  | { kind: "started" }
  /** The working directory was not there: nothing ran. */
  | { kind: "nodir" }
  | { kind: "output"; text: string }
  /** `memory` is there when the worker's script reports it (every script this version sends). */
  | { kind: "exit"; code: number; memory?: JobMemory };

/** How much of what came before the start marker is kept (login banners, or the reason it never started). */
const PREAMBLE_KEEP = 4096;

/**
 * Turns the text of an exec command's stdout into events: the start marker,
 * the job's output (with the exit marker held back until it is complete), the
 * exit code. Anything before the start marker is not the job's (a login
 * banner) and is kept only as `preamble`.
 */
export class ExecStreamParser {
  private state: "pre" | "run" | "done" = "pre";
  private buffer = "";
  /** The stream ended; `finished` stays false unless the job's own end marker was read. */
  private closed = false;
  /** What came before the start marker. */
  preamble = "";
  private readonly startMarker: string;
  private readonly nodirMarker: string;
  private readonly exitMarker: string;

  constructor(token: string) {
    checkedToken(token);
    this.startMarker = `@@cody-${token}-started\n`;
    this.nodirMarker = `@@cody-${token}-nodir\n`;
    this.exitMarker = `\n@@cody-${token}-exit:`;
  }

  get finished(): boolean {
    return this.state === "done";
  }

  feed(text: string): ExecEvent[] {
    const events: ExecEvent[] = [];
    if (this.state === "done" || this.closed || !text) return events;
    this.buffer += text;
    for (;;) {
      if (this.state === "pre") {
        const started = this.buffer.indexOf(this.startMarker);
        const nodir = this.buffer.indexOf(this.nodirMarker);
        const at = started >= 0 && (nodir < 0 || started < nodir) ? started : nodir;
        if (at < 0) {
          if (this.buffer.length > PREAMBLE_KEEP * 4) {
            this.preamble = (this.preamble + this.buffer.slice(0, -PREAMBLE_KEEP)).slice(-PREAMBLE_KEEP);
            this.buffer = this.buffer.slice(-PREAMBLE_KEEP);
          }
          return events;
        }
        const marker = at === started ? this.startMarker : this.nodirMarker;
        this.preamble = (this.preamble + this.buffer.slice(0, at)).slice(-PREAMBLE_KEEP);
        this.buffer = this.buffer.slice(at + marker.length);
        if (at === started) {
          this.state = "run";
          events.push({ kind: "started" });
        } else {
          this.state = "done";
          this.buffer = "";
          events.push({ kind: "nodir" });
          return events;
        }
        continue;
      }
      // run: the output, up to the exit marker
      const at = this.buffer.indexOf(this.exitMarker);
      if (at >= 0) {
        const after = this.buffer.slice(at + this.exitMarker.length);
        const code = /^(\d{1,3})(?::(\d{0,12}):(\d{0,9}))?\n/.exec(after);
        if (code) {
          if (at > 0) events.push({ kind: "output", text: this.buffer.slice(0, at) });
          const exitCode = Number.parseInt(code[1], 10);
          events.push(
            code[2] === undefined
              ? { kind: "exit", code: exitCode }
              : { kind: "exit", code: exitCode, memory: { peakBytes: code[2] ? Number(code[2]) * 1024 : null, oomKills: code[3] ? Number(code[3]) : null } },
          );
          this.state = "done";
          this.buffer = "";
          return events;
        }
        if (!after.includes("\n") && after.length < 32) {
          // the marker is still arriving
          if (at > 0) events.push({ kind: "output", text: this.buffer.slice(0, at) });
          this.buffer = this.buffer.slice(at);
          return events;
        }
        // something that only looks like the marker: it is output
        events.push({ kind: "output", text: this.buffer.slice(0, at + this.exitMarker.length) });
        this.buffer = after;
        continue;
      }
      // Hold back only what could still turn into the marker.
      let hold = 0;
      for (let length = Math.min(this.exitMarker.length - 1, this.buffer.length); length > 0; length -= 1) {
        if (this.buffer.endsWith(this.exitMarker.slice(0, length))) {
          hold = length;
          break;
        }
      }
      if (this.buffer.length > hold) events.push({ kind: "output", text: this.buffer.slice(0, this.buffer.length - hold) });
      this.buffer = this.buffer.slice(this.buffer.length - hold);
      return events;
    }
  }

  /** The stream ended: whatever was held back was output after all. No exit event means the job did not finish. */
  end(): ExecEvent[] {
    const events: ExecEvent[] = [];
    if (this.state === "run" && this.buffer) events.push({ kind: "output", text: this.buffer });
    else if (this.state === "pre") this.preamble = (this.preamble + this.buffer).slice(-PREAMBLE_KEEP);
    this.buffer = "";
    this.closed = true;
    return events;
  }
}
