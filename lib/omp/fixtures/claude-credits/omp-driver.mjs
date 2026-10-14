import { spawn } from "node:child_process";
import { createServer } from "node:http";

/**
 * Running a REAL omp against the fake servers, and cleaning up every process this started.
 *
 * The child's environment is built from scratch rather than inherited: a machine's own provider
 * keys, proxies, profile or agent dir must never decide where a test's requests go. The only
 * credentials omp can see are the ones in the agent dir the test seeded, and the only network it
 * is pointed at is 127.0.0.1 — anything else it tries goes to a proxy that refuses it (and
 * records the attempt, so a test can say so).
 */

const children = new Set();

/** Kill everything this module started and is still running. Safe to call twice. */
export function killAll() {
  for (const child of children) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  children.clear();
}

/** Something that answers every proxied request with a refusal, and writes down what was asked for. */
export async function startNetworkTrap() {
  const attempts = [];
  const server = createServer((req, res) => {
    attempts.push(`${req.method} ${req.url}`);
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("blocked by the test's network trap");
  });
  server.on("connect", (req, socket) => {
    attempts.push(`CONNECT ${req.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    attempts,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

/** The environment for a child omp or Bun helper. `trap` is a `startNetworkTrap()` result. */
export function childEnv({ root, agentDir, configFiles = "", trap = null, extra = {} }) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: root,
    TMPDIR: root,
    LANG: "C.UTF-8",
    PI_CODING_AGENT_DIR: agentDir,
    PI_CONFIG_FILES: configFiles,
    // Present but empty: omp must find no key here, so the only API keys it can use are the ones stored in the agent dir.
    ANTHROPIC_API_KEY: "",
    ...(trap ? { HTTP_PROXY: trap.url, HTTPS_PROXY: trap.url, ALL_PROXY: trap.url, http_proxy: trap.url, https_proxy: trap.url, all_proxy: trap.url, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } : {}),
    ...extra,
  };
}

const QUIET = ["--no-session", "--no-extensions", "--no-skills", "--no-lsp", "--no-tools", "--no-title"];

/** `omp -p <prompt>`: one turn, the model's reply on stdout. Resolves, never rejects, even on a timeout. */
export function runOmpPrint({ ompBin, env, model, prompt = "Say hello.", timeoutMs = 90_000 }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(ompBin, ["-p", ...QUIET, "--model", model, prompt], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const done = (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - startedAt });
    };
    child.once("error", (error) => { stderr += `\n[spawn error] ${error.message}`; done(null, null); });
    child.once("close", done);
  });
}

/** Run a command to completion (a Bun seeding script, `omp config get`): { code, stdout, stderr, timedOut }. */
export function runCommand(command, args, { env, timeoutMs = 90_000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (input !== undefined) child.stdin.end(input);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const done = (code) => { clearTimeout(timer); children.delete(child); resolve({ code, stdout, stderr, timedOut }); };
    child.once("error", (error) => { stderr += `\n[spawn error] ${error.message}`; done(null); });
    child.once("close", done);
  });
}

/**
 * `omp --mode rpc`: a long-lived omp that takes one JSON command per line and streams events.
 * `prompt()` sends a message and resolves with the events of that turn, up to its `agent_end`.
 */
export function startOmpRpc({ ompBin, env, model }) {
  const child = spawn(ompBin, ["--mode", "rpc", ...QUIET, "--model", model], { env, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  const events = [];
  let buffer = "";
  let stderr = "";
  let exited = false;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { events.push({ type: "raw", line: line.slice(0, 200) }); }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("close", () => { exited = true; children.delete(child); });
  child.stdin.on("error", () => undefined);

  const rpc = {
    events,
    stderr: () => stderr,
    exited: () => exited,
    kill() { try { child.kill("SIGKILL"); } catch { /* gone */ } },
    /** Wait for omp's own `ready` event: it is taking commands from here on. */
    async ready(timeoutMs = 60_000) {
      const started = Date.now();
      while (!events.some((event) => event.type === "ready") && !exited && Date.now() - started < timeoutMs) await new Promise((resolve) => setTimeout(resolve, 50));
      return events.some((event) => event.type === "ready");
    },
    async prompt(message, timeoutMs = 90_000) {
      const from = events.length;
      child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
      const started = Date.now();
      while (Date.now() - started < timeoutMs && !exited) {
        if (events.slice(from).some((event) => event.type === "agent_end")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const turn = events.slice(from);
      return { events: turn, ended: turn.some((event) => event.type === "agent_end"), timedOut: !turn.some((event) => event.type === "agent_end") && !exited };
    },
  };
  return rpc;
}

/** The assistant messages of one turn, as `provider/model: stop reason "text"`: for a failure message. */
export function describeTurn(turn) {
  return turn
    .filter((event) => ["retry_fallback_applied", "retry_fallback_succeeded", "auto_retry_start", "auto_retry_end", "agent_end"].includes(event.type) || (event.type === "message_end" && event.message?.role === "assistant"))
    .map((event) => {
      if (event.type === "message_end") return `message_end ${event.message.provider}/${event.message.model} stop=${event.message.stopReason} ${JSON.stringify((event.message.content?.[0]?.text ?? event.message.errorMessage ?? "").slice(0, 80))}`;
      if (event.type === "retry_fallback_applied") return `retry_fallback_applied ${event.from} -> ${event.to} (role ${event.role})`;
      if (event.type === "retry_fallback_succeeded") return `retry_fallback_succeeded ${event.model}`;
      if (event.type === "auto_retry_start") return `auto_retry_start attempt=${event.attempt} delay=${Math.round(event.delayMs)}ms`;
      return event.type;
    })
    .join("\n");
}

/** The assistant `message_end` events of a turn, in order. */
export const assistantMessages = (turn) => turn.filter((event) => event.type === "message_end" && event.message?.role === "assistant").map((event) => event.message);
