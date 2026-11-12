// A stand-in for a worker, for tests: a RemoteShell (lib/workers/shell.ts) whose
// "far side" is this machine. Every command runs with `sh -c <command>` the way
// a remote login shell would run what ssh hands it, so the REAL generated
// scripts (copy-in with tar, the exec wrapper with its markers and dead-man's
// switch, copy-back, cleanup) run for real; only the network is missing.
//
// Not a test file (the name does not match the runner's patterns). It also
// scripts the ways a worker goes wrong, per call, through `behave(call)`.
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";

/** What a generated command is, from its text. */
export function kindOf(command) {
  if (command.includes("-started")) return "exec";
  if (command.includes("-data")) return "back";
  if (command.includes("rm -rf")) return "cleanup";
  if (command.includes("mkdir -p")) return "in";
  return "other";
}

const DROPPED = (destination) => `Connection to ${destination} closed by remote host.\n`;

/**
 * `behave(call)` is asked for every command, before it starts, and may answer:
 *
 * - nothing: run it for real on this machine;
 * - `{ fail: { code = 255, stderr } }`: ssh failed at once, nothing ran;
 * - `{ say, code = 0, stderr = "" }`: nothing ran; the "worker" printed `say` (a string or a Buffer) and exited;
 * - `{ hang: true }`: connected, but nothing is read and nothing is said until it is killed;
 * - `{ dropAfterStartedMs }`: run for real, and that long after the job's start marker
 *   the connection vanishes: no more output, ssh exits 255 "closed by remote host".
 *   The far side's dead-man's switch still ends the job, as it would for real.
 *
 * `call` is `{ destination, command, kind, index }`, `index` counting the calls
 * of that kind to that destination so far (0 for the first).
 */
export function localShell({ behave } = {}) {
  const calls = [];
  const live = new Set();

  function finished({ code, stderr = "", stdout = "" }) {
    const out = new PassThrough();
    const input = new PassThrough();
    input.resume();
    out.end(stdout);
    return { stdin: input, stdout: out, exited: Promise.resolve({ code, stderr, noSsh: false }), kill() {} };
  }

  function hanging() {
    const out = new PassThrough();
    // A tiny buffer: whoever writes to stdin is held back after the first chunk.
    const input = new PassThrough({ highWaterMark: 1 });
    const { promise, resolve } = Promise.withResolvers();
    return {
      stdin: input,
      stdout: out,
      exited: promise,
      kill() {
        input.destroy();
        out.end();
        resolve({ code: null, stderr: "", noSsh: false });
      },
    };
  }

  function run(destination, command, dropAfterStartedMs) {
    const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    live.add(child);
    child.stdin.on("error", () => {});
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    const { promise: exited, resolve } = Promise.withResolvers();
    let settled = false;
    const settle = (exit) => {
      if (settled) return;
      settled = true;
      resolve(exit);
    };
    child.once("close", () => live.delete(child));
    child.once("error", (error) => settle({ code: null, stderr: error.message, noSsh: false }));
    let stdout = child.stdout;

    if (dropAfterStartedMs === undefined) {
      child.once("close", (code) => settle({ code, stderr, noSsh: false }));
    } else {
      // The consumer sees a copy of stdout that is cut off when the "connection" drops.
      const copy = new PassThrough();
      stdout = copy;
      let dropped = false;
      let seen = "";
      const drop = () => {
        if (dropped) return;
        dropped = true;
        copy.end();
        child.stdin.end();
        // The far side's watcher ends the job; ssh already told its side the connection is gone.
        copy.once("close", () => settle({ code: 255, stderr: DROPPED(destination), noSsh: false }));
        copy.resume();
      };
      child.stdout.on("data", (chunk) => {
        if (dropped) return;
        copy.write(chunk);
        seen = (seen + chunk.toString("utf8")).slice(-256);
        if (seen.includes("-started") && !child.dropTimer) child.dropTimer = setTimeout(drop, dropAfterStartedMs);
      });
      child.stdout.on("end", () => {
        clearTimeout(child.dropTimer);
        if (!dropped) copy.end();
      });
      child.once("close", (code) => {
        clearTimeout(child.dropTimer);
        if (!dropped) copy.once("close", () => settle({ code, stderr, noSsh: false }));
      });
    }

    return {
      stdin: child.stdin,
      stdout,
      exited,
      kill() {
        // ssh is terminated: the far side sees its stdin close, nothing more arrives here.
        child.stdin.end();
        stdout.destroy();
        settle({ code: null, stderr: "", noSsh: false });
      },
    };
  }

  const shell = {
    start(destination, command) {
      const kind = kindOf(command);
      const call = { destination, command, kind, index: calls.filter((other) => other.destination === destination && other.kind === kind).length };
      calls.push(call);
      const behaviour = behave?.(call);
      if (!behaviour) return run(destination, command);
      if (behaviour.fail) return finished({ code: behaviour.fail.code ?? 255, stderr: behaviour.fail.stderr ?? "" });
      if (behaviour.say !== undefined) return finished({ code: behaviour.code ?? 0, stderr: behaviour.stderr ?? "", stdout: behaviour.say });
      if (behaviour.hang) return hanging();
      if (behaviour.dropAfterStartedMs !== undefined) return run(destination, command, behaviour.dropAfterStartedMs);
      throw new Error(`unknown behaviour ${JSON.stringify(behaviour)}`);
    },
  };

  return {
    shell,
    calls,
    /** Calls of one kind, in order. */
    of(kind) {
      return calls.filter((call) => call.kind === kind);
    },
    /** End whatever is still running: stdin first (the dead-man's switch), then the process groups. */
    stop() {
      for (const child of live) {
        child.stdin.end();
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      live.clear();
    },
  };
}
