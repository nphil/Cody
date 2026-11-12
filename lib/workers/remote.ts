import { randomBytes } from "node:crypto";
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

/**
 * Run the agent's command in the copy of its working directory.
 *
 * It prints `@@cody-<token>-started` once the directory is entered, the job's
 * own output (stdout and stderr together), and last `@@cody-<token>-exit:<code>`;
 * no exit marker means the connection or the machine went away mid-run.
 *
 * The job runs at low priority in its own process group (when `setsid` exists)
 * with no stdin. Cody keeps ssh's stdin open and never writes to it: the
 * session's stdin is saved as fd 3 and a watcher reads it, so the moment Cody
 * closes it on purpose (a timeout, a cancelled call) or dies by any means, the
 * watcher stops the job: TERM to its group, KILL five seconds later. Without
 * it a job whose ssh vanished would run on, unwatched, for good. `.pid` names
 * this script's shell so a later check can tell the job is alive; `.done` stops
 * a late watcher from signalling a group that is already gone. Whatever the
 * command left running in its group is stopped when it ends, so a build that
 * starts a background server does not leave it on the worker.
 */
export function buildExecCommand(options: { directory: string; cwdRel: string; command: string; token: string }): string {
  const dir = checkedDirectory(options.directory);
  const token = checkedToken(options.token);
  return wrap([
    "umask 077",
    `D=${dir}`,
    `cd ${shQuote(inside(dir, options.cwdRel))} 2>/dev/null || { echo @@cody-${token}-nodir; exit 0; }`,
    'echo $$ > "$D/.pid"',
    `echo @@cody-${token}-started`,
    "exec 3<&0",
    "S=; command -v setsid >/dev/null 2>&1 && S=setsid",
    'N=; command -v nice >/dev/null 2>&1 && N="nice -n 19"',
    `$S $N sh -c ${shQuote(options.command)} </dev/null 2>&1 3<&- &`,
    "p=$!",
    '( cat <&3 >/dev/null 2>&1; [ -e "$D/.done" ] && exit 0; kill -TERM -$p 2>/dev/null || kill -TERM $p 2>/dev/null; sleep 5; kill -KILL -$p 2>/dev/null || kill -KILL $p 2>/dev/null ) >/dev/null 2>&1 &',
    "w=$!",
    "wait $p",
    "rc=$?",
    ': > "$D/.done"',
    "kill -KILL -$p 2>/dev/null",
    "kill $w 2>/dev/null",
    `printf '\\n@@cody-${token}-exit:%s\\n' "$rc"`,
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

/** Delete the job directory once nothing of the job is alive (waiting a few seconds for a stopped one to go). */
export function buildCleanupCommand(directory: string, workRoot: string): string {
  const dir = checkedDirectory(directory);
  const root = checkedDirectory(workRoot);
  if (!dir.startsWith(`${root}/j-`)) throw new Error("Refusing to delete a directory that is not a job directory");
  return wrap([
    `D=${dir}`,
    `case "$D" in ${root}/j-*) ;; *) exit 98;; esac`,
    'p=$(cat "$D/.pid" 2>/dev/null); n=0',
    'while [ -n "$p" ] && kill -0 "$p" 2>/dev/null && [ "$n" -lt 15 ]; do sleep 1; n=$((n+1)); done',
    'rm -rf "$D"',
    '[ ! -e "$D" ]',
  ]);
}

// ── Reading what the job printed ─────────────────────────────────────────────

export type ExecEvent =
  | { kind: "started" }
  /** The working directory was not there: nothing ran. */
  | { kind: "nodir" }
  | { kind: "output"; text: string }
  | { kind: "exit"; code: number };

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
        const code = /^(\d{1,3})\n/.exec(after);
        if (code) {
          if (at > 0) events.push({ kind: "output", text: this.buffer.slice(0, at) });
          events.push({ kind: "exit", code: Number.parseInt(code[1], 10) });
          this.state = "done";
          this.buffer = "";
          return events;
        }
        if (!after.includes("\n") && after.length < 6) {
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
