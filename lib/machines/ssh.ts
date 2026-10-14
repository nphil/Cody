import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SampleStream, type RawSample } from "./proc";
import { checkMachineDestination, type MachineReason } from "./types";

/**
 * Reading a remote machine over ssh: ONE long-lived `ssh` per machine that runs
 * a fixed sampling loop and prints a reading every couple of seconds. Nothing a
 * person types is ever part of the remote command: the destination is the only
 * variable, it is checked against a strict whitelist (`checkMachineDestination`)
 * and passed as an argument (no shell on this side), and the command is the
 * constant below.
 */

/**
 * The loop that runs on the far side. Written for any POSIX `sh` (BusyBox
 * included): no bash-isms, no fractional `sleep`. It prints the machine's first
 * `cpu` line, the memory fields Cody needs and the load average, framed by
 * `@S <cores>` and `@E`, once a second the first time (so the first CPU figure
 * arrives after one second, not three) and every two seconds after. A machine
 * without `/proc` (not Linux) answers `@NOPROC` and stops.
 *
 * It stops when its stdin ends. A background `cat` reads the session's stdin
 * (saved as fd 3, because a background job's own stdin is /dev/null) and kills
 * the loop's shell at EOF. That is the dead-man's switch: Cody keeps ssh's
 * stdin open and never writes to it, so the loop ends the moment Cody closes it
 * on purpose, or dies by any means at all, `SIGKILL` and an out-of-memory kill
 * included. Without it an orphaned `ssh` simply carries on (it ignores the
 * broken output pipe) and keeps the loop running on the far machine for good.
 *
 * It is sent as `sh -c '…'` so the person's login shell (fish, csh, …) never
 * has to understand it; that is why it holds no single quote, backslash or `!`
 * (the last because csh expands it even inside quotes), and why a background
 * job is started with `&` and a space rather than `& ;`.
 */
export const SAMPLE_SCRIPT =
  '[ -r /proc/stat ] || { echo @NOPROC; exit 0; }; n=$(grep -c "^cpu[0-9]" /proc/stat); '
  + "exec 3<&0; (cat <&3 >/dev/null; kill $$) & d=1; "
  + 'while :; do echo "@S $n"; head -n 1 /proc/stat; grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached):" /proc/meminfo; cat /proc/loadavg; echo @E; sleep $d; d=2; done';

export const SAMPLE_COMMAND = `sh -c '${SAMPLE_SCRIPT}'`;

/**
 * The arguments for one ssh connection. Everything that could make a
 * background connection misbehave is spelled out rather than left to the
 * person's `~/.ssh/config`:
 *
 * - `BatchMode`: never prompt (there is nobody to answer); a machine that needs
 *   a password simply says so.
 * - `ConnectTimeout` / `ServerAlive*`: a machine that stops answering is
 *   noticed in seconds, not minutes.
 * - `ControlMaster=no` / `ControlPath=none`: a `Host *` block that turns on
 *   connection sharing would otherwise make this client the master and leave a
 *   `ControlPersist` process behind after Cody stops looking.
 * - `LogLevel=ERROR`: only real failures reach stderr, which is what is
 *   classified into a plain reason.
 *
 * Host-key checking is NOT overridden: a machine Cody has not met yet has to be
 * trusted the way the person already trusts their others (connect once from a
 * terminal), and a stricter setting of theirs is respected.
 */
export function sshArgs(destination: string): string[] {
  if (!checkMachineDestination(destination).ok) throw new Error("Refusing to run ssh against an invalid destination");
  return [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=3",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "LogLevel=ERROR",
    "--",
    destination,
    SAMPLE_COMMAND,
  ];
}

/** The `ssh` program on PATH, or null when this server has none. A scan rather
 * than a spawn: it must be cheap enough to answer on every Settings load. */
export function findSshBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = process.platform === "win32" ? ["ssh.exe"] : ["ssh"];
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** First useful line of what ssh said, safe to show: control characters gone,
 * capped. Never contains more than ssh itself printed. */
export function firstStderrLine(stderr: string): string {
  for (const raw of stderr.split("\n")) {
    const line = raw.replace(/[\p{C}]/gu, " ").replace(/\s+/g, " ").trim();
    if (line) return line.length > 200 ? `${line.slice(0, 199)}…` : line;
  }
  return "";
}

/** A plain reason for a connection that ended, from what ssh printed. A stderr
 * that matches nothing is `failed`; the caller keeps the raw line for people
 * who can read it (`Test` in Settings). */
export function classifySshFailure(stderr: string, exitCode: number | null): MachineReason {
  const text = stderr.toLowerCase();
  if (/permission denied|authentication failed|no supported authentication|too many authentication failures|publickey/.test(text)) return "auth";
  if (/host key verification failed|remote host identification has changed|host key for .* has changed/.test(text)) return "host_key";
  if (/could not resolve hostname|name or service not known|temporary failure in name resolution|nodename nor servname/.test(text)) return "unknown_host";
  if (/connection refused/.test(text)) return "refused";
  if (/timed out|no route to host|network is unreachable|host is down|operation timed out/.test(text)) return "unreachable";
  if (/closed by remote host|connection (?:closed|reset)|connection to .* closed|broken pipe|exchange_identification/.test(text)) return "dropped";
  return exitCode === 255 || exitCode === null ? "failed" : "dropped";
}

export interface SshClose {
  reason: MachineReason;
  /** ssh's own first line of complaint (empty when it said nothing). */
  detail: string;
  /** How many readings arrived before it ended. */
  samples: number;
}

export interface SshHandlers {
  onSample(sample: RawSample): void;
  /** The far side is not Linux. The connection is closed right after. */
  onNoProc(): void;
  /** Called exactly once, unless `stop()` ended the connection first. */
  onClose(close: SshClose): void;
}

export interface SshRun {
  /** End the connection and stay quiet: `onClose` is not called. */
  stop(): void;
}

/** Keep stderr bounded: the last couple of KB hold the reason. */
const STDERR_KEEP = 4096;
const KILL_GRACE_MS = 2_000;

/** The pipes of a child are sockets and have `unref()`, but are typed as plain
 * streams. */
function canUnref(stream: unknown): stream is { unref(): void } {
  return typeof stream === "object" && stream !== null && "unref" in stream && typeof stream.unref === "function";
}

/** Never let a background connection keep the server alive on its own. */
function detach(child: ChildProcess): void {
  child.unref();
  if (canUnref(child.stdin)) child.stdin.unref();
  if (canUnref(child.stdout)) child.stdout.unref();
  if (canUnref(child.stderr)) child.stderr.unref();
}

export function runSsh(destination: string, handlers: SshHandlers): SshRun {
  let stopped = false;
  let finished = false;
  let samples = 0;
  let stderr = "";
  const stream = new SampleStream();

  const binary = findSshBinary();
  if (!binary) {
    setImmediate(() => {
      if (!stopped) handlers.onClose({ reason: "no_ssh", detail: "", samples: 0 });
    });
    return { stop() { stopped = true; } };
  }

  // stdin is a pipe Cody holds open and never writes to: the far loop's
  // dead-man's switch (see SAMPLE_SCRIPT). When this process dies, the kernel
  // closes the pipe and the loop ends, whatever killed us.
  const child = spawn(binary, sshArgs(destination), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin?.on("error", () => {
    // ssh went away first: nothing was ever going to be written here
  });
  detach(child);

  const finish = (close: SshClose) => {
    if (finished) return;
    finished = true;
    if (!stopped) handlers.onClose(close);
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (stopped) return;
    for (const event of stream.feed(chunk)) {
      if (event.kind === "sample") {
        samples += 1;
        handlers.onSample(event.sample);
      } else {
        handlers.onNoProc();
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    finish({ reason: error.code === "ENOENT" ? "no_ssh" : "failed", detail: firstStderrLine(error.message), samples });
  });
  child.on("close", (code) => {
    finish({ reason: classifySshFailure(stderr, code), detail: firstStderrLine(stderr), samples });
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      // EOF first: it is what ends the loop on the far machine. SIGTERM
      // follows because the client may be stuck in a slow handshake.
      child.stdin?.end();
      child.kill("SIGTERM");
      const hard = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      hard.unref();
    },
  };
}
