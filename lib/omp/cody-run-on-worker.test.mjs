import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createRunOnWorker } = await jiti.import("./extensions/cody-run-on-worker.ts");
const { RUN_ON_WORKER_TOOL } = await jiti.import("../workers/definition.ts");

/**
 * lib/omp/extensions/cody-run-on-worker.ts: omp loads it under Bun; here a fake
 * omp registers the tool and a real local HTTP server plays Cody's
 * /api/internal/workers route. What matters: every agent (helpers too) gets the
 * tool with the shared words, a call carries the chat's token and identity,
 * progress and the result come back, and an agent without a shell is refused.
 */

function fakeOmp(active = ["read", "bash"]) {
  const tools = [];
  return { tools, pi: { registerTool: (tool) => tools.push(tool), getActiveTools: () => active } };
}

const ENV = (endpoint) => ({ CODY_WORKERS_ENDPOINT: endpoint, CODY_WORKERS_SESSION: "scratch:abcdef012345", CODY_WORKERS_TOKEN: "token-1" });

/** A route stand-in: `answer(res)` writes the reply; every request it saw is recorded. */
async function withRoute(answer, run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
    await answer(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({ endpoint: `http://127.0.0.1:${server.address().port}/api/internal/workers`, requests });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const ndjson = (response, lines) => {
  response.writeHead(200, { "Content-Type": "application/x-ndjson" });
  for (const line of lines) response.write(`${JSON.stringify(line)}\n`);
  response.end();
};

async function registered(env, active) {
  const { tools, pi } = fakeOmp(active);
  createRunOnWorker({ env, fetch })(pi);
  return tools;
}

test("every chat's agents are offered the tool with the shared definition, but only inside a Cody chat", async () => {
  const [tool] = await registered(ENV("http://127.0.0.1:1/api/internal/workers"));
  assert.equal(tool.name, "run_on_worker");
  assert.equal(tool.description, RUN_ON_WORKER_TOOL.description);
  assert.deepEqual(tool.parameters, RUN_ON_WORKER_TOOL.parameters);
  assert.equal(tool.loadMode, "essential");
  assert.equal(tool.approval, "exec");
  for (const missing of ["CODY_WORKERS_ENDPOINT", "CODY_WORKERS_SESSION", "CODY_WORKERS_TOKEN"]) {
    const env = { ...ENV("http://127.0.0.1:1/x"), [missing]: undefined };
    assert.deepEqual(await registered(env), [], `no tool without ${missing}`);
  }
});

test("a call carries the chat's token and identity, shows progress as it comes and returns the job's result", async () => {
  await withRoute((response) => ndjson(response, [{ type: "progress", text: "cargo build\nCompiling a" }, { type: "heartbeat" }, { type: "progress", text: "cargo build\nCompiling b" }, { type: "result", text: "exit 0 on the worker", isError: false }]), async ({ endpoint, requests }) => {
    const [tool] = await registered(ENV(endpoint));
    const updates = [];
    const result = await tool.execute("call-1", { command: "cargo build", results: ["target/release/app"] }, undefined, (partial) => updates.push(partial.content[0].text), { cwd: "/work/tree" });
    assert.deepEqual(result, { content: [{ type: "text", text: "exit 0 on the worker" }] });
    assert.deepEqual(updates, ["cargo build\nCompiling a", "cargo build\nCompiling b"]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, "Bearer token-1");
    assert.deepEqual(requests[0].body, {
      sessionId: "scratch:abcdef012345",
      tool: "run_on_worker",
      arguments: { command: "cargo build", results: ["target/release/app"], cwd: "/work/tree" },
    });
  });
});

test("the directory the agent names wins over its own", async () => {
  await withRoute((response) => ndjson(response, [{ type: "result", text: "ok" }]), async ({ endpoint, requests }) => {
    const [tool] = await registered(ENV(endpoint));
    await tool.execute("call-1", { command: "make", cwd: "sub" }, undefined, undefined, { cwd: "/work/tree" });
    assert.equal(requests[0].body.arguments.cwd, "sub");
  });
});

test("a failed job is an error result and a refusal before the job started says why", async () => {
  await withRoute((response) => ndjson(response, [{ type: "result", text: "exit 2", isError: true }]), async ({ endpoint }) => {
    const [tool] = await registered(ENV(endpoint));
    assert.deepEqual(await tool.execute("c", { command: "false" }, undefined, undefined, { cwd: "/w" }), { content: [{ type: "text", text: "exit 2" }], isError: true });
  });
  await withRoute((response) => {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Session not found" }));
  }, async ({ endpoint }) => {
    const [tool] = await registered(ENV(endpoint));
    assert.deepEqual(await tool.execute("c", { command: "x" }, undefined, undefined, { cwd: "/w" }), { content: [{ type: "text", text: "Session not found" }], isError: true });
  });
  await withRoute((response) => ndjson(response, [{ type: "progress", text: "only progress" }]), async ({ endpoint }) => {
    const [tool] = await registered(ENV(endpoint));
    const result = await tool.execute("c", { command: "x" }, undefined, undefined, { cwd: "/w" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ended without a result/);
  });
});

test("an agent without a shell cannot use it; one with only eval can", async () => {
  await withRoute((response) => ndjson(response, [{ type: "result", text: "ran" }]), async ({ endpoint, requests }) => {
    const [readOnly] = await registered(ENV(endpoint), ["read", "grep"]);
    const refused = await readOnly.execute("c", { command: "ls" }, undefined, undefined, { cwd: "/w" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /no shell tool/);
    assert.equal(requests.length, 0, "a refused call never reaches the server");
    const [evalOnly] = await registered(ENV(endpoint), ["eval"]);
    assert.equal((await evalOnly.execute("c", { command: "ls" }, undefined, undefined, { cwd: "/w" })).content[0].text, "ran");
  });
});

test("cancelling the call hangs up on the server and says so", async () => {
  await withRoute(() => new Promise(() => {}), async ({ endpoint }) => {
    const [tool] = await registered(ENV(endpoint));
    const controller = new AbortController();
    const pending = tool.execute("c", { command: "sleep 99" }, controller.signal, undefined, { cwd: "/w" });
    setTimeout(() => controller.abort(), 50);
    assert.deepEqual(await pending, { content: [{ type: "text", text: "run_on_worker was cancelled." }], isError: true });
  });
});
