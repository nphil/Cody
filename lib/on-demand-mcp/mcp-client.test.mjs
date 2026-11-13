import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createJiti } from "jiti";

/**
 * The in-repo MCP client the on-demand extension uses, against a fake stdio
 * server (a small node script written to a temp dir) and a fake streamable-HTTP
 * server. Nothing here starts a real MCP server.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { connectMcp, expandEnvVars } = await jiti.import("./mcp-client.ts");

const dir = mkdtempSync(join(tmpdir(), "cody-mcp-client-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** A newline-delimited JSON-RPC MCP server. FAKE_MODE selects the odd behaviours. */
const SERVER = `
const { spawn } = require("node:child_process");
const mode = process.env.FAKE_MODE || "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const tools = (names) => names.map((name) => ({ name, description: name + " tool", inputSchema: { type: "object", properties: { text: { type: "string" } } } }));
let buffer = "";
let stuck = false;
const waiting = new Map();
if (mode === "stubborn") process.stdin.on("end", () => {});
if (mode === "stubborn") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
if (mode === "noisy") process.stdout.write("starting up, not json\\n");
if (mode === "slow-init") setTimeout(() => {}, 100000);
let grandchild;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => { if (mode !== "stubborn") process.exit(0); });
function handle(message) {
  if (message.id !== undefined && message.method === undefined) { const resolve = waiting.get(message.id); if (resolve) resolve(message); return; }
  if (message.method === "notifications/cancelled") { process.stderr.write("cancelled " + message.params.requestId + "\\n"); send({ jsonrpc: "2.0", method: "notifications/message", params: { cancelled: message.params.requestId } }); return; }
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code, text) => send({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
  if (message.method === "initialize") {
    if (mode === "slow-init") return;
    if (mode === "init-error") return fail(-32000, "no license");
    return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" }, instructions: mode === "instructions" ? "  use it well  " : undefined });
  }
  if (message.method === "tools/list") {
    const cursor = message.params && message.params.cursor;
    if (mode === "bad-list") return reply({ nope: true });
    if (mode === "paged") {
      if (!cursor) return reply({ tools: tools(["one", "two"]), nextCursor: "c2" });
      if (cursor === "c2") return reply({ tools: [...tools(["three"]), { description: "nameless" }, "junk"], nextCursor: "c3" });
      return reply({ tools: tools(["four"]) });
    }
    return reply({ tools: tools(["echo", "fail", "hang", "die", "pid", "tree", "pingback", "rpcerror", "structured"]) });
  }
  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    if (name === "echo") return reply({ content: [{ type: "text", text: "echo:" + JSON.stringify(args) }] });
    if (name === "structured") return reply({ content: [], structuredContent: { ok: true } });
    if (name === "fail") return reply({ isError: true, content: [{ type: "text", text: "boom" }] });
    if (name === "hang") return;
    if (name === "die") { process.stderr.write("fatal: went away\\n"); process.exit(3); }
    if (name === "pid") return reply({ content: [{ type: "text", text: String(process.pid) }] });
    if (name === "tree") {
      grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      return reply({ content: [{ type: "text", text: String(grandchild.pid) }] });
    }
    if (name === "pingback") {
      new Promise((resolve) => { waiting.set("srv-ping", resolve); send({ jsonrpc: "2.0", id: "srv-ping", method: "ping" }); }).then((answer) => reply({ content: [{ type: "text", text: JSON.stringify(answer.result) }] }));
      return;
    }
    if (name === "rpcerror") return fail(-32602, "bad params");
    if (name === "env") return reply({ content: [{ type: "text", text: process.env.FROM_CONFIG + "|" + process.env.PLAIN + "|" + process.argv.slice(2).join(",") + "|" + process.cwd() }] });
    return fail(-32601, "unknown tool");
  }
  fail(-32601, "unknown method " + message.method);
}
`;
const serverPath = join(dir, "fake-mcp.cjs");
writeFileSync(serverPath, SERVER);

const processEnv = { ...process.env };
const stdioConfig = (mode = "", extra = {}) => ({ type: "stdio", command: process.execPath, args: [serverPath], env: { FAKE_MODE: mode }, ...extra });
const connectStdio = (mode, extra, options = {}) => connectMcp(stdioConfig(mode, extra), { cwd: dir, env: processEnv, ...options });
const textOf = (result) => result.content.map((block) => block.text).join("");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitDead(pid, ms = 6_000) {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await sleep(25);
  return !alive(pid);
}

test("stdio: handshake, tools/list and a successful tools/call", async () => {
  const client = await connectStdio("instructions");
  try {
    assert.equal(client.instructions, "use it well");
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["echo", "fail", "hang", "die", "pid", "tree", "pingback", "rpcerror", "structured"]);
    assert.equal(tools[0].description, "echo tool");
    const result = await client.callTool("echo", { text: "hi" });
    assert.equal(textOf(result), 'echo:{"text":"hi"}');
    assert.deepEqual((await client.callTool("structured", {})).structuredContent, { ok: true });
  } finally {
    await client.close();
  }
});

test("stdio: tools/list follows nextCursor across pages and skips entries without a name", async () => {
  const client = await connectStdio("paged");
  try {
    assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["one", "two", "three", "four"]);
  } finally {
    await client.close();
  }
});

test("stdio: a tools/list answer without a tools array is an error", async () => {
  const client = await connectStdio("bad-list");
  try {
    await assert.rejects(() => client.listTools(), /without a tools array/);
  } finally {
    await client.close();
  }
});

test("stdio: a tool that reports an error returns isError, a JSON-RPC error rejects", async () => {
  const client = await connectStdio();
  try {
    const failed = await client.callTool("fail", {});
    assert.equal(failed.isError, true);
    assert.equal(textOf(failed), "boom");
    await assert.rejects(() => client.callTool("rpcerror", {}), /MCP error -32602: bad params/);
    await assert.rejects(() => client.callTool("missing", {}), /MCP error -32601/);
  } finally {
    await client.close();
  }
});

test("stdio: concurrent calls are matched to their own answers and stray stdout lines are ignored", async () => {
  const client = await connectStdio("noisy");
  try {
    const results = await Promise.all(["a", "b", "c", "d"].map((text) => client.callTool("echo", { text })));
    assert.deepEqual(results.map(textOf), ["a", "b", "c", "d"].map((text) => `echo:{"text":"${text}"}`));
  } finally {
    await client.close();
  }
});

test("stdio: the server's own ping request is answered", async () => {
  const client = await connectStdio();
  try {
    assert.equal(textOf(await client.callTool("pingback", {})), "{}");
  } finally {
    await client.close();
  }
});

test("stdio: a hung call hits its timeout, the server is told, and the connection still works", async () => {
  const client = await connectStdio("", { timeout: 300 });
  try {
    const started = Date.now();
    await assert.rejects(() => client.callTool("hang", {}), /tools\/call timed out after 300ms/);
    assert.ok(Date.now() - started < 3_000);
    assert.equal(textOf(await client.callTool("echo", { text: "after" })), 'echo:{"text":"after"}');
  } finally {
    await client.close();
  }
});

test("stdio: a per-call timeout overrides the default, and an abort signal cancels a pending call", async () => {
  const client = await connectStdio();
  try {
    await assert.rejects(() => client.callTool("hang", {}, { timeoutMs: 150 }), /timed out after 150ms/);
    const controller = new AbortController();
    const pending = client.callTool("hang", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("user pressed stop")), 50);
    await assert.rejects(() => pending, /user pressed stop/);
    await assert.rejects(() => client.callTool("echo", {}, { signal: AbortSignal.abort() }), /aborted/);
  } finally {
    await client.close();
  }
});

test("stdio: a server that exits mid-call fails the call with its stderr and fires onClose once", async () => {
  const client = await connectStdio();
  const reasons = [];
  client.onClose((reason) => reasons.push(reason));
  await assert.rejects(() => client.callTool("die", {}), /MCP server exited \(code 3\): fatal: went away/);
  await sleep(50);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /exited \(code 3\).*fatal: went away/);
  await assert.rejects(() => client.callTool("echo", {}), /not running/);
  await client.close();
  assert.equal(reasons.length, 1, "close() after a crash does not report a second time");
});

test("stdio: close() ends the child, does not fire onClose, and is safe to repeat", async () => {
  const client = await connectStdio();
  const pid = Number(textOf(await client.callTool("pid", {})));
  assert.ok(alive(pid));
  const reasons = [];
  client.onClose((reason) => reasons.push(reason));
  await client.close();
  assert.ok(await waitDead(pid), "the server process is gone after close()");
  assert.deepEqual(reasons, []);
  await client.close();
});

test("stdio: close() kills a server that ignores both stdin EOF and SIGTERM, and the processes it started", async () => {
  const client = await connectStdio("stubborn");
  const pid = Number(textOf(await client.callTool("pid", {})));
  const grandchild = Number(textOf(await client.callTool("tree", {})));
  assert.ok(alive(pid) && alive(grandchild));
  await client.close();
  assert.ok(await waitDead(pid), "stubborn server killed");
  assert.ok(await waitDead(grandchild), "its descendant killed with the process group");
});

test("stdio: initialize that never answers times out and leaves no process behind; an init error rejects", async () => {
  await assert.rejects(() => connectStdio("slow-init", {}, { timeoutMs: 200 }), /initialize timed out after 200ms/);
  await assert.rejects(() => connectStdio("init-error"), /MCP error -32000: no license/);
});

test("stdio: a command that cannot start fails the handshake with the reason", async () => {
  await assert.rejects(() => connectMcp({ command: join(dir, "does-not-exist") }, { cwd: dir, env: processEnv }), /could not start|not running/);
});

test("stdio: env, args and cwd expand ${VAR} and reach the server", async () => {
  const client = await connectStdio("", {
    env: { FAKE_MODE: "", FROM_CONFIG: "${HOST_VALUE}-${MISSING:-fallback}", PLAIN: "p" },
    args: [serverPath, "${HOST_VALUE}", 7],
    cwd: dir,
  }, { env: { ...processEnv, HOST_VALUE: "hv" } });
  try {
    const result = textOf(await client.callTool("env", {}));
    assert.match(result, /^hv-fallback\|p\|hv\|/);
    assert.ok(result.endsWith(dir) || result.endsWith(dir.replace(/^\/tmp/, "/private/tmp")));
  } finally {
    await client.close();
  }
});

test("a definition that is neither stdio nor http is refused", async () => {
  await assert.rejects(() => connectMcp({ type: "sse", url: "https://x.test/sse" }, { cwd: dir }), /only stdio and http/);
});

test("expandEnvVars handles ${VAR}, ${VAR:-default}, empty values and unknown names", () => {
  const env = { A: "1", EMPTY: "" };
  assert.equal(expandEnvVars("${A}-${A}", env), "1-1");
  assert.equal(expandEnvVars("${EMPTY:-d}", env), "d");
  assert.equal(expandEnvVars("${EMPTY}", env), "");
  assert.equal(expandEnvVars("${NOPE:-d}", env), "d");
  assert.equal(expandEnvVars("${NOPE}", env), "${NOPE}");
  assert.equal(expandEnvVars("${toString}", {}), "${toString}");
});

// -- streamable HTTP ---------------------------------------------------------

/** A streamable-HTTP MCP endpoint. `sse` answers over an event stream; otherwise plain JSON. */
async function startHttpServer({ sse = false, hang = false } = {}) {
  const seen = { headers: [], deletes: [], methods: [] };
  const server = createServer((request, response) => {
    if (request.method === "DELETE") {
      seen.deletes.push(request.headers["mcp-session-id"]);
      response.writeHead(204).end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.headers.push(request.headers);
      seen.methods.push(message.method);
      if (request.headers.authorization !== "Bearer secret-token") {
        response.writeHead(401, { "Content-Type": "text/plain" }).end("no token");
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const reply = (result) => {
        const body = { jsonrpc: "2.0", id: message.id, result };
        const headers = message.method === "initialize" ? { "Mcp-Session-Id": "sess-1" } : {};
        if (sse) {
          response.writeHead(200, { ...headers, "Content-Type": "text/event-stream" });
          response.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
          response.end();
        } else {
          response.writeHead(200, { ...headers, "Content-Type": "application/json" }).end(JSON.stringify(body));
        }
      };
      if (message.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {}, instructions: "http notes" });
      if (message.method === "tools/list") return reply({ tools: [{ name: "echo", inputSchema: { type: "object" } }] });
      if (message.method === "tools/call") {
        if (message.params.name === "hang" || hang) return;
        return reply({ content: [{ type: "text", text: `http:${JSON.stringify(message.params.arguments)}` }] });
      }
      response.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { url, seen, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

for (const sse of [false, true]) {
  test(`http (${sse ? "event-stream" : "json"} replies): handshake, list, call, session header, headers with \${VAR}, DELETE on close`, async () => {
    const http = await startHttpServer({ sse });
    try {
      const client = await connectMcp(
        { type: "http", url: http.url, headers: { Authorization: "Bearer ${TOKEN}" }, timeout: 5000 },
        { cwd: dir, env: { ...processEnv, TOKEN: "secret-token" } },
      );
      assert.equal(client.instructions, "http notes");
      assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["echo"]);
      assert.equal(textOf(await client.callTool("echo", { n: 1 })), 'http:{"n":1}');
      assert.deepEqual(http.seen.methods.slice(0, 2), ["initialize", "notifications/initialized"]);
      assert.equal(http.seen.headers[0]["mcp-session-id"], undefined);
      assert.equal(http.seen.headers[1]["mcp-session-id"], "sess-1");
      assert.equal(http.seen.headers.at(-1)["mcp-protocol-version"], "2025-03-26", "the version the server negotiated is echoed");
      await client.close();
      assert.deepEqual(http.seen.deletes, ["sess-1"]);
    } finally {
      await http.close();
    }
  });
}

test("http: a rejected request (401) fails the connection with the status and body", async () => {
  const http = await startHttpServer();
  try {
    await assert.rejects(() => connectMcp({ type: "http", url: http.url }, { cwd: dir, env: processEnv }), /HTTP 401: no token/);
  } finally {
    await http.close();
  }
});

test("http: a hung call hits its timeout and the client keeps working", async () => {
  const http = await startHttpServer();
  try {
    const client = await connectMcp({ type: "http", url: http.url, headers: { Authorization: "Bearer secret-token" }, timeout: 250 }, { cwd: dir, env: processEnv });
    await assert.rejects(() => client.callTool("hang", {}), /tools\/call timed out after 250ms/);
    assert.equal(textOf(await client.callTool("echo", {})), "http:{}");
    await client.close();
  } finally {
    await http.close();
  }
});

test("http: an unreachable server rejects the handshake", async () => {
  const http = await startHttpServer();
  const { url } = http;
  await http.close();
  await assert.rejects(() => connectMcp({ type: "http", url }, { cwd: dir, env: processEnv, timeoutMs: 2000 }));
});
