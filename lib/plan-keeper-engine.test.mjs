import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The plan keeper against a REAL omp engine (CODY_OMP_BIN, else `omp` on PATH)
 * and a scripted model server, on whichever engine version is installed:
 *
 *  - the keeper's check-off goes into the engine's own list through
 *    `set_todos`, whether or not that engine's todo list knows `blocked`
 *    (omp 18.8 does, 18.19 removed it);
 *  - after the engine restarts on the same chat, the check-off is in the list
 *    again once the keeper has looked (18.12.4+ saves `set_todos` edits in the
 *    chat file itself, older engines forget them: the keeper must cover both);
 *  - the agent's own `todo` result still carries `op` and `phases`, the two
 *    fields the keeper reads to learn the agent reopened a task.
 *
 * The model server is a local HTTP stub, so nothing here spends credit or
 * needs a login. The agent dir is a throw-away one.
 */
const probeBin = process.env.CODY_OMP_BIN || "omp";
const probe = spawnSync(probeBin, ["--version"], { encoding: "utf8" });
const skip = probe.status === 0 ? false : `no omp binary (${probeBin})`;
const engineVersion = (probe.stdout ?? "").trim();

const root = fs.mkdtempSync(path.join(process.env.CODY_SCRATCH || os.tmpdir(), "cody-plan-keeper-engine-"));
const agentDir = path.join(root, "agent");
const homeDir = path.join(root, "home");
const workDir = path.join(root, "work");
const sessionDir = path.join(root, "sessions");
for (const dir of [agentDir, homeDir, workDir, sessionDir]) fs.mkdirSync(dir, { recursive: true });
// Before the first import: the overlay lives under the instance data dir.
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OMP_PROFILE = "";
process.env.PI_PROFILE = "";
delete process.env.CODY_HARNESS;
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const keeperModule = await jiti.import("./plan-keeper/keeper.ts");
const overlayModule = await jiti.import("./plan-keeper/overlay.ts");
const foldModule = await jiti.import("./plan-keeper/fold.ts");

const PHASE = "Ship";
const TASKS = ["Create notes.txt", "Count the lines in notes.txt", "Email the report"];

/** What the scripted model does: init the list, run one command, then stop.
 * Chosen by how many tool results the conversation already holds. */
function startModelServer() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-1", object: "model" }] }));
        return;
      }
      const request = JSON.parse(body || "{}");
      const toolResults = (request.messages ?? []).filter((message) => message.role === "tool").length;
      const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } } : {}) })}\n\n`;
      const call = (name, args) => [
        chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${toolResults}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null),
        chunk({}, "tool_calls"),
      ];
      let parts;
      if (toolResults === 0) parts = call("todo", { op: "init", list: [{ phase: PHASE, items: TASKS }] });
      else if (toolResults === 1) parts = call("bash", { command: "printf 'alpha beta gamma\\n' > notes.txt && cat notes.txt", i: "Writing notes.txt" });
      else parts = [chunk({ role: "assistant", content: "Stopping here." }, null), chunk({}, "stop")];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`${parts.join("")}data: [DONE]\n\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** One engine process in RPC mode: commands out, frames in. */
function startEngine({ port, resume }) {
  fs.writeFileSync(path.join(agentDir, "models.yml"), [
    "providers:",
    "  fake:",
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    "      - id: fake-1",
    "        contextWindow: 64000",
    "        maxTokens: 4096",
    "",
  ].join("\n"));
  const overlay = path.join(root, "overlay.yml");
  fs.writeFileSync(overlay, ["memory:", "  backend: off", "autolearn:", "  enabled: false", "advisor:", "  enabled: false", "prewalk:", "  enabled: false", ""].join("\n"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: homeDir, PI_CONFIG_FILES: "" };
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
  const child = spawn(probeBin, [
    "--mode", "rpc-ui", "--cwd", workDir, "--model", "fake/fake-1", "--session-dir", sessionDir, "--tools", "todo,bash",
    "--no-skills", "--no-rules", "--no-extensions", "--no-title", "--no-lsp", `--config=${overlay}`, "--thinking=off",
    ...(resume ? ["--resume", resume] : []),
  ], { cwd: workDir, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-3000); });
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.type === "ready") ready();
    if (frame.type === "response" && frame.id && pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.success) resolve(frame.data); else reject(new Error(`${frame.command}: ${frame.error}`));
      return;
    }
    for (const listener of listeners) listener(frame);
  });
  const send = (command) => new Promise((resolve, reject) => {
    const id = `c${nextId += 1}`;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });
  const waitFor = (test, ms = 60_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`timed out; stderr: ${stderr.slice(-500)}`)); }, ms);
    const listener = (frame) => {
      if (!test(frame)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(frame);
    };
    listeners.add(listener);
  });
  return {
    send,
    waitFor,
    onFrame: (listener) => { listeners.add(listener); },
    ready: Promise.race([readyPromise, new Promise((_, reject) => setTimeout(() => reject(new Error(`engine never became ready: ${stderr.slice(-500)}`)), 60_000))]),
    async stop() {
      child.stdin.end();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

const statuses = (phases) => phases.flatMap((phase) => phase.tasks.map((task) => task.status));

/** The keeper wired to an engine the way lib/rpc-manager.ts wires it. */
function keeperFor(engine, sessionId, runner) {
  const emitted = [];
  const keeper = new keeperModule.PlanKeeper({
    sessionId,
    getTodoPhases: async () => (await engine.send({ type: "get_state" })).todoPhases ?? [],
    setTodoPhases: async (phases) => { await engine.send({ type: "set_todos", phases }); },
    emit: (frame) => emitted.push(frame),
  }, { runner });
  engine.onFrame((frame) => {
    if (frame.type === "tool_execution_start") keeper.notifyToolExecutionStart(frame);
    if (frame.type === "tool_execution_end") keeper.notifyToolExecutionEnd(frame);
  });
  return { keeper, emitted };
}

async function until(read, done, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`gave up waiting; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a check-off survives an engine restart on the same chat, on this engine version", { skip, timeout: 240_000 }, async (t) => {
  const server = await startModelServer();
  const port = server.address().port;
  let engine = null;
  try {
    engine = startEngine({ port });
    await engine.ready;
    const state = await engine.send({ type: "get_state" });
    const sessionId = state.sessionId;
    const sessionFile = state.sessionFile;
    assert.ok(sessionId && sessionFile, "the engine names its chat");

    // The stand-in model judge: it cites the bash result that shows the file was made.
    let keeperRef = null;
    const runner = async () => {
      const entry = keeperRef.digestSnapshot().find((item) => item.kind === "tool" && item.tool === "bash");
      return { text: JSON.stringify({ done: [{ id: "T1", entry: entry?.seq ?? 1, quote: "alpha beta gamma" }] }), error: null };
    };
    const first = keeperFor(engine, sessionId, runner);
    keeperRef = first.keeper;

    const ended = engine.waitFor((frame) => frame.type === "agent_end" && frame.isTerminal !== false);
    await engine.send({ type: "prompt", message: "do the work" });
    await ended;

    // The agent's own todo call reached the keeper in the shape it reads: op + phases.
    const afterAgent = (await engine.send({ type: "get_state" })).todoPhases;
    assert.deepEqual(afterAgent.map((phase) => phase.name), [PHASE]);
    assert.deepEqual(afterAgent[0].tasks.map((task) => task.content), TASKS);
    assert.ok(statuses(afterAgent).every((status) => status !== "completed"), "the agent ticked nothing");

    await first.keeper.notifyTerminalAgentEnd();
    const ticked = (await engine.send({ type: "get_state" })).todoPhases;
    assert.equal(ticked[0].tasks[0].status, "completed", "the keeper's tick is in the engine's own list");
    assert.equal(ticked[0].tasks[2].status === "completed", false, "an undone task stays open");
    assert.deepEqual(overlayModule.readPlanOverlay(sessionId)?.autoCompleted, [foldModule.planTaskKey(PHASE, TASKS[0])]);
    first.keeper.dispose();
    await engine.stop();

    // Same chat, fresh engine process.
    engine = startEngine({ port, resume: sessionFile });
    await engine.ready;
    const resumed = await engine.send({ type: "get_state" });
    assert.equal(resumed.sessionId, sessionId, "the resumed chat keeps its id");
    const keptByEngine = resumed.todoPhases?.[0]?.tasks?.[0]?.status === "completed";
    t.diagnostic(`${engineVersion}: engine itself kept the tick across a restart: ${keptByEngine}`);

    const second = keeperFor(engine, sessionId, async () => ({ text: '{"done":[]}', error: null }));
    second.keeper.notifyListRebuilt();
    const restored = await until(async () => (await engine.send({ type: "get_state" })).todoPhases, (phases) => phases[0]?.tasks[0]?.status === "completed");
    assert.equal(restored[0].tasks[2].status === "completed", false);
    second.keeper.dispose();
  } finally {
    await engine?.stop().catch(() => {});
    server.close();
  }
});

test("a list holding a blocked task is accepted by set_todos, and what the engine hands back is what the keeper reads", { skip, timeout: 120_000 }, async (t) => {
  const server = await startModelServer();
  const engine = startEngine({ port: server.address().port });
  try {
    await engine.ready;
    const sent = [{ name: PHASE, tasks: [
      { content: "Write it", status: "in_progress" },
      { content: "Wait for ops", status: "blocked", blocker: "ops is out" },
      { content: "Ship it", status: "pending" },
    ] }];
    await engine.send({ type: "set_todos", phases: sent });
    const back = (await engine.send({ type: "get_state" })).todoPhases;
    t.diagnostic(`${engineVersion}: a blocked task comes back as ${JSON.stringify(back[0].tasks[1])}`);
    // Whatever the engine keeps, it is a status the keeper counts as open work.
    const second = back[0].tasks[1];
    assert.ok(["blocked", "pending"].includes(second.status), `unexpected status ${second.status}`);
    const open = new Set(["pending", "in_progress", "blocked"]);
    assert.ok(open.has(second.status));
  } finally {
    await engine.stop().catch(() => {});
    server.close();
  }
});
