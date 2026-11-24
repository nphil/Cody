import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * A REAL omp rpc-ui child talking to a fake Anthropic server, for the tests that prove what the
 * engine's model controls do. Nothing real is touched: the child gets its own HOME and agent dir,
 * `--offline`, no title call, and its only provider is the fake one on 127.0.0.1 (a placeholder key,
 * three made-up models). The caller owns the lifetime: `stop()` kills the child, the server and the
 * temp dir.
 */

const MODELS_YML = (port) => `providers:
  mock:
    baseUrl: http://127.0.0.1:${port}
    api: anthropic-messages
    apiKey: placeholder-not-a-real-key
    models:
      - id: claude-opus-5-5
        name: Mock Opus
        reasoning: true
        contextWindow: 1000000
        maxTokens: 32000
        input:
          - text
      - id: claude-opus-5-6
        name: Mock Opus Two
        reasoning: true
        thinking:
          mode: anthropic-adaptive
          efforts: [minimal, low, medium, high, xhigh]
          defaultLevel: medium
        contextWindow: 1000000
        maxTokens: 32000
        input:
          - text
      - id: claude-haiku-5-5
        name: Mock Haiku
        reasoning: true
        thinking:
          mode: anthropic-adaptive
          efforts: [minimal, low, medium]
        contextWindow: 200000
        maxTokens: 8000
        input:
          - text
`;

const CONFIG_YML = `advisor:
  enabled: false
modelRoles:
  default: mock/claude-opus-5-5
  smol: mock/claude-haiku-5-5
  slow: mock/claude-opus-5-6:high
`;

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const textOf = (message) => {
  const content = message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n") : "";
};

/**
 * A fake Anthropic /v1/messages. Every request waits `delayMs`, is logged, and is answered with "OK" unless a
 * `reply` script is set: `setReply((request, index) => blocks)` where a block is `{type: "text", text}`,
 * `{type: "thinking", thinking, signature}` or `{type: "tool_use", id, name, input}`.
 */
export async function startAnthropicMock(delayMs = 0) {
  const requests = [];
  const timers = new Set();
  const control = { delayMs, reply: undefined };
  const replyEvents = (blocks) => blocks.flatMap((block, index) => {
    if (block.type === "thinking") return [
      sse("content_block_start", { index, content_block: { type: "thinking", thinking: "" } }),
      sse("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } }),
      sse("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature ?? "lab-signature" } }),
      sse("content_block_stop", { index }),
    ];
    if (block.type === "tool_use") return [
      sse("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }),
      sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } }),
      sse("content_block_stop", { index }),
    ];
    return [
      sse("content_block_start", { index, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { index, delta: { type: "text_delta", text: block.text } }),
      sse("content_block_stop", { index }),
    ];
  });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* a probe, not a chat request */ }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      requests.push({ model: parsed.model, lastUserText: textOf(messages.at(-1)), body: parsed });
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const blocks = control.reply ? control.reply(parsed, requests.length - 1) : [{ type: "text", text: "OK" }];
        res.end([
          sse("message_start", { message: { id: "msg_lab", type: "message", role: "assistant", model: parsed.model ?? "lab", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
          ...replyEvents(blocks),
          sse("message_delta", { delta: { stop_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
          sse("message_stop", {}),
        ].join(""));
      }, control.delayMs);
      timers.add(timer);
      res.on("close", () => { clearTimeout(timer); timers.delete(timer); });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    /** How long the next requests are held before the reply starts. */
    setDelay(ms) { control.delayMs = ms; },
    /** Script the reply blocks; `undefined` goes back to a plain "OK". */
    setReply(fn) { control.reply = fn; },
    close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** "19.1.0" from `omp --version` (it prints `omp/19.1.0`). */
export function ompVersionOf(bin) {
  const out = execFileSync(bin, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), PI_CONFIG_FILES: "" } });
  return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start the child and a JSON-lines client for it. Resolves once omp has sent `ready`.
 *
 * `args` are appended to every launch (Cody's `--extension` flags, say) and `env` is merged over the child's
 * environment (`PI_CONFIG_FILES` for the launch-default layers). `lab.restart({ resume })` ends the child the way
 * Cody's idle disposal does (SIGTERM, so omp writes its `session_exit` record) and starts a new one on the same
 * agent dir and the same fake server, resuming `resume` (a session file) like Cody's respawn.
 */
export async function startLab(bin, { delayMs = 0, args = [], env = {}, configYml = CONFIG_YML } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cody-model-controls-"));
  const agentDir = path.join(root, "agent");
  const work = path.join(root, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  const mock = await startAnthropicMock(delayMs);
  writeFileSync(path.join(agentDir, "models.yml"), MODELS_YML(mock.port));
  writeFileSync(path.join(agentDir, "config.yml"), configYml);
  const frames = [];
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let child;
  let exited;

  const launch = (launchArgs) => {
    buffer = "";
    const mine = spawn(bin, ["--mode", "rpc-ui", "--offline", "--no-title", "--cwd", work, ...launchArgs, ...args], {
      cwd: work,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        TMPDIR: root,
        LANG: "C.UTF-8",
        NO_COLOR: "1",
        PI_CODING_AGENT_DIR: agentDir,
        PI_CONFIG_FILES: "",
        ANTHROPIC_API_KEY: "",
        ...env,
      },
    });
    child = mine;
    mine.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.type === "response" && pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id); }
        else frames.push(frame);
      }
    });
    mine.stderr.on("data", () => { /* omp's logging is not part of the protocol */ });
    exited = new Promise((resolve) => mine.once("exit", resolve));
  };

  const terminate = async () => {
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(killer);
  };

  const lab = {
    mock,
    /** Every frame that was not a command response, in arrival order. */
    frames,
    /** Send one command; resolves with its `response` frame (success or not). */
    send(command, timeoutMs = 20_000) {
      const id = `lab-${nextId++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`no response to ${command.type} within ${timeoutMs} ms`)); }, timeoutMs);
        pending.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
        child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      });
    },
    /** Wait until a frame at or after `from` satisfies `predicate`; resolves with it. */
    async until(predicate, { from = 0, timeoutMs = 20_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.slice(from).find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error("timed out waiting for a frame");
        await sleep(25);
      }
    },
    /** Frames of one type at or after `from`. */
    ofType: (type, from = 0) => frames.slice(from).filter((frame) => frame.type === type),
    /** `get_state`'s data. */
    async state() {
      const response = await lab.send({ type: "get_state" });
      return response.data;
    },
    /** Send a prompt and wait until the engine has accepted it as a user message and a request is in flight. */
    async promptInFlight(message, timeoutMs = 20_000) {
      const from = frames.length;
      const response = await lab.send({ type: "prompt", message });
      await lab.until((frame) => frame.type === "message_end" && frame.message?.role === "user", { from, timeoutMs });
      await sleep(600);
      return response;
    },
    /** Wait for the run to settle (a terminal `agent_end`), then a beat for the queue to drain. */
    async settled({ from = 0, timeoutMs = 30_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = await lab.state();
        const ends = frames.slice(from).some((frame) => frame.type === "agent_end");
        if (ends && state && state.isStreaming === false && state.queuedMessageCount === 0 && state.isSettled !== false) return state;
        if (Date.now() > deadline) throw new Error("the run did not settle");
        await sleep(150);
      }
    },
    /** End the child like an idle disposal and start a new one on the same agent dir, resuming `resume` (a session file). */
    async restart({ resume }) {
      await terminate();
      frames.length = 0;
      launch(["--resume", resume]);
      await becomeReady();
    },
    async stop() {
      await terminate();
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    },
  };

  const becomeReady = async () => {
    const readyAt = Date.now();
    while (!frames.some((frame) => frame.type === "ready")) {
      if (child.exitCode !== null || Date.now() - readyAt > 60_000) { await lab.stop(); throw new Error("omp did not become ready"); }
      await sleep(50);
    }
    // Cody asks for protocol 2; an engine that does not know the command just refuses and stays on 1.
    await lab.send({ type: "negotiate_protocol", protocolVersion: 2 }).catch(() => undefined);
  };

  launch(["--model", "mock/claude-opus-5-5"]);
  await becomeReady();
  return lab;
}
