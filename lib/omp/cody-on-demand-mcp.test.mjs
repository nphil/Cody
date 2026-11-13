import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createJiti } from "jiti";

/**
 * lib/omp/extensions/cody-on-demand-mcp.ts: omp loads it under Bun; here a fake
 * `pi` and a fake MCP connection stand in for omp and for the real server, and
 * the real handlers are driven the way omp drives them.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const extension = await jiti.import("./extensions/cody-on-demand-mcp.ts");
const registryModule = await jiti.import("../on-demand-mcp/registry.ts");
const { ON_DEMAND_COMPUTER_ENV, ON_DEMAND_ENTRY_TYPE, ON_DEMAND_REGISTRY_ENV, onDemandToolName } = registryModule;

const dir = mkdtempSync(join(tmpdir(), "cody-ondemand-ext-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
let stamp = Date.now() / 1000;
/** Write a registry file (mtime always moves forward: the extension re-reads on mtime change). */
function writeRegistry(servers) {
  counter += 1;
  const path = join(dir, `registry-${counter}.json`);
  writeRegistryAt(path, servers);
  return path;
}
function writeRegistryAt(path, servers) {
  writeFileSync(path, JSON.stringify({ version: 1, servers }));
  stamp += 5;
  utimesSync(path, stamp, stamp);
}

const REA = { purpose: "Reverse engineering: binaries, APKs, firmware", config: { command: "rea" } };
const OTHER = { purpose: "Another toolset", config: { type: "http", url: "https://other.test/mcp" } };

const REA_TOOLS = [
  {
    name: "open_binary",
    description: "Open a binary",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { path: { type: "string" }, note: { type: "string", nullable: true } }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  { name: "rea_close_binary", description: "Close", inputSchema: { type: "object", properties: {} } },
  { name: "inspect_pe_v2" },
];

/** A fake MCP connection: records every call, can fail, and reports when it is closed. */
function makeConnect({ tools = REA_TOOLS, delayMs = 0 } = {}) {
  const state = { connects: [], clients: [], failWith: undefined, listFails: undefined, gate: undefined, instructions: undefined };
  const connect = async (config, options) => {
    state.connects.push({ config, options });
    if (delayMs) await sleep(delayMs);
    if (state.gate) await state.gate;
    if (state.failWith) throw new Error(state.failWith);
    const client = {
      instructions: state.instructions,
      calls: [],
      closed: 0,
      closeHandlers: [],
      result: { content: [{ type: "text", text: "ok" }] },
      async listTools() {
        if (state.listFails) throw new Error(state.listFails);
        return tools;
      },
      async callTool(name, args, options) {
        client.calls.push({ name, args, options });
        if (client.callError) throw new Error(client.callError);
        return client.result;
      },
      async close() {
        client.closed += 1;
      },
      onClose(handler) {
        client.closeHandlers.push(handler);
      },
    };
    state.clients.push(client);
    return client;
  };
  return { connect, state };
}

/** A fake omp: collects tools and handlers, and activates a registered tool after `activateMs`. */
function makePi({ activateMs = 0, preActive = [] } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const entries = [];
  const registered = [];
  const active = new Set(["bash", ...preActive]);
  const pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
      registered.push(tool.name);
      if (activateMs < 0) return;
      if (activateMs === 0) active.add(tool.name);
      else setTimeout(() => active.add(tool.name), activateMs).unref();
    },
    getActiveTools: () => [...active],
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx = { cwd: dir, sessionManager: { getBranch: () => entries } };
  const fire = async (event, payload = {}) => {
    const results = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  };
  return { pi, ctx, tools, handlers, entries, registered, active, fire };
}

const exitListeners = process.listeners("exit").length;
afterEach(() => {
  // every mount hooks `process.once("exit")`; keep the test process clean
  for (const listener of process.listeners("exit").slice(exitListeners)) process.removeListener("exit", listener);
});

/** Register the extension. `env` is what Cody would put in the engine's environment. */
function setup({ servers = { rea: REA }, env = {}, connectOptions, piOptions, ...deps } = {}) {
  const registryPath = writeRegistry(servers);
  const fake = makeConnect(connectOptions);
  const host = makePi(piOptions);
  extension.createOnDemandMcp({ registryPath, env, connect: fake.connect, mountTimeoutMs: 150, pollMs: 5, restoreWaitMs: 400, ...deps })(host.pi);
  return { ...fake, ...host, registryPath };
}

const textOf = (result) => result.content.map((block) => block.text).join("\n");
const loadTools = (host, params) => host.tools.get("load_tools").execute("call-1", params, undefined, undefined, host.ctx);
const callTool = (host, name, params, signal) => host.tools.get(name).execute("call-2", params, signal, undefined, host.ctx);

test("nothing on demand: no tool and no handler (zero cost); the default export is a function omp can call", () => {
  const host = setup({ servers: {}, env: {} });
  assert.deepEqual(host.registered, []);
  assert.equal(host.handlers.size, 0);
  assert.equal(typeof extension.default, "function");
});

test("load_tools is ONE small essential read-tool, its description lists each toolset and stays tiny", () => {
  const host = setup({ servers: { rea: REA, other: OTHER }, env: { [ON_DEMAND_COMPUTER_ENV]: "off" } });
  assert.deepEqual(host.registered, ["load_tools"]);
  const tool = host.tools.get("load_tools");
  assert.equal(tool.loadMode, "essential");
  assert.equal(tool.approval, "read");
  assert.deepEqual(tool.parameters, registryModule.LOAD_TOOLS_SCHEMA);
  const lines = tool.description.split("\n");
  assert.match(lines[0], /^Mount an on-demand toolset into this chat/);
  assert.deepEqual(lines.slice(1).map((line) => line.split(":")[0]), ["Toolsets", "- computer", "- other", "- rea"]);
  assert.ok(!tool.description.includes("[on]"));
  const size = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
  assert.ok(size <= 900, `load_tools is ${size} chars`);
});

test("the [on] marker appears in the description and the listing when Cody switched computer on for this chat", async () => {
  const host = setup({ servers: {}, env: { [ON_DEMAND_COMPUTER_ENV]: "on" } });
  assert.match(host.tools.get("load_tools").description, /- computer: .*\[on\]$/m);
  assert.match(textOf(await loadTools(host, {})), /computer: .*\[on\]/);
});

test("with no server given, load_tools lists the toolsets with their state; an unreadable list says there is none", async () => {
  const host = setup({ servers: { rea: REA, other: OTHER }, env: { [ON_DEMAND_COMPUTER_ENV]: "off" } });
  let listing = textOf(await loadTools(host, {}));
  assert.match(listing, /^On-demand toolsets:\n- other: Another toolset\n- rea: Reverse engineering: binaries, APKs, firmware\n- computer: /);
  assert.ok(!listing.includes("[loaded]"));
  await loadTools(host, { server: "rea" });
  listing = textOf(await loadTools(host, { server: "  " }));
  assert.match(listing, /- rea: .* \[loaded\]/);
  // the file vanishes after the chat began: nothing to list (and no computer line without Cody's env)
  rmSync(host.registryPath);
  const gone = setup({ servers: { rea: REA } });
  rmSync(gone.registryPath);
  assert.equal(textOf(await loadTools(gone, {})), "There are no on-demand toolsets.");
});

test("loading mounts every tool as mcp__<server>_<tool> with omp's metadata, the entry is recorded, the result names the tools", async () => {
  const host = setup();
  host.state.instructions = "use open_binary first";
  const result = await loadTools(host, { server: "rea" });
  assert.equal(result.isError, undefined);
  assert.equal(host.state.connects.length, 1);
  assert.deepEqual(host.state.connects[0].config, REA.config);
  assert.equal(host.state.connects[0].options.cwd, dir);
  assert.deepEqual(host.registered, ["load_tools", "mcp__rea_open_binary", "mcp__rea_close_binary", "mcp__rea_inspect_pe_v2"]);
  assert.deepEqual(host.entries, [{ type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "rea", action: "load" } }]);
  const text = textOf(result);
  assert.match(text, /Loaded "rea": 3 tools are mounted now, for the rest of this chat\./);
  assert.match(text, /xd:\/\/mcp__rea_<tool>/);
  assert.match(text, /Tools: open_binary, close_binary, inspect_pe_v2/);
  assert.match(text, /Server notes: use open_binary first/);

  const open = host.tools.get("mcp__rea_open_binary");
  assert.equal(open.label, "rea/open_binary");
  assert.equal(open.description, "Open a binary");
  assert.equal(open.approval, "write");
  assert.equal(open.strict, false);
  assert.equal(open.mcpServerName, "rea");
  assert.equal(open.mcpToolName, "open_binary");
  assert.equal(open.mcpReadOnlyHint, true);
  assert.equal(open.legacyName, undefined);
  assert.deepEqual(open.parameters, { type: "object", properties: { path: { type: "string" }, note: { type: "string" } }, required: ["path"] }, "$schema and nullable are stripped");
  const bare = host.tools.get("mcp__rea_inspect_pe_v2");
  assert.equal(bare.description, "MCP tool from rea");
  assert.deepEqual(bare.parameters, { type: "object", properties: {} });
  assert.equal(bare.legacyName, "mcp__rea_inspect_pe_v");
  assert.equal("mcpReadOnlyHint" in bare, false);
});

test("a mounted tool calls the client with the model's arguments (harness intent and empty optionals dropped) and formats the result", async () => {
  const host = setup();
  await loadTools(host, { server: "rea" });
  const client = host.state.clients[0];
  client.result = { content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }] };
  const controller = new AbortController();
  const result = await callTool(host, "mcp__rea_open_binary", { path: "/bin/ls", note: "", i: "Opening ls" }, controller.signal);
  assert.deepEqual(client.calls, [{ name: "open_binary", args: { path: "/bin/ls" }, options: { signal: controller.signal } }]);
  assert.deepEqual(result.content, [{ type: "text", text: "line one\n\nline two" }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }]);
  assert.equal(result.isError, undefined);
  // a required empty value is kept
  await callTool(host, "mcp__rea_open_binary", { path: "" });
  assert.deepEqual(client.calls[1].args, { path: "" });
  // a tool error is an error result, a thrown failure becomes the MCP-failure text
  client.result = { isError: true, content: [{ type: "text", text: "no such file" }] };
  const failed = await callTool(host, "mcp__rea_open_binary", { path: "x" });
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text, "Error: no such file");
  client.callError = "connection lost";
  const thrown = await callTool(host, "mcp__rea_open_binary", { path: "x" });
  assert.equal(thrown.isError, true);
  assert.equal(thrown.content[0].text, "MCP failure\nserver: rea\ntool: open_binary\nmessage: connection lost");
});

test("formatResult: structured data is fenced once, resources are labelled, empty results stay a text block", () => {
  const { formatResult } = extension;
  assert.deepEqual(formatResult({ content: [] }).content, [{ type: "text", text: "" }]);
  const structured = formatResult({ content: [], structuredContent: { ok: true } });
  assert.equal(structured.content.at(-1).text, '```json\n{\n  "ok": true\n}\n```');
  const duplicate = formatResult({ content: [{ type: "text", text: '{"ok":true}' }], structuredContent: { ok: true } });
  assert.equal(duplicate.content.length, 1, "the same data is not shown twice");
  const resources = formatResult({ content: [{ type: "resource", resource: { uri: "file:///a", text: "body" } }, { type: "resource", resource: { uri: "file:///b" } }] });
  assert.equal(resources.content[0].text, "[Resource: file:///a]\nbody\n\n[Resource: file:///b]");
  const imageError = formatResult({ isError: true, content: [{ type: "image", data: "x" }] });
  assert.deepEqual(imageError.content[0], { type: "text", text: "Error:" });
  assert.equal(imageError.content[1].mimeType, "image/png");
});

test("loading twice is idempotent: one connection, one registration, the entry is not duplicated", async () => {
  const host = setup();
  await loadTools(host, { server: "rea" });
  const again = await loadTools(host, { server: "rea" });
  assert.equal(textOf(again), '"rea" is already loaded (3 tools).');
  assert.equal(host.state.connects.length, 1);
  assert.equal(host.registered.filter((name) => name === "mcp__rea_open_binary").length, 1);
  assert.equal(host.entries.length, 1);
});

test("concurrent loads are serialized: the second sees the first", async () => {
  const host = setup({ connectOptions: { delayMs: 30 } });
  const [first, second] = await Promise.all([loadTools(host, { server: "rea" }), loadTools(host, { server: "rea" })]);
  assert.match(textOf(first), /^Loaded "rea"/);
  assert.match(textOf(second), /already loaded/);
  assert.equal(host.state.connects.length, 1);
});

test("unload closes the client, records it, and the stale tools answer 'not running' until loaded again (without re-registering)", async () => {
  const host = setup();
  await loadTools(host, { server: "rea" });
  const client = host.state.clients[0];
  const unload = await loadTools(host, { server: "rea", unload: true });
  assert.match(textOf(unload), /^Stopped "rea"\. Its 3 tools stay listed/);
  assert.equal(client.closed, 1);
  assert.deepEqual(host.entries.map((entry) => entry.data), [{ server: "rea", action: "load" }, { server: "rea", action: "unload" }]);
  assert.deepEqual(registryModule.replayLoaded(host.entries), []);
  const dead = await callTool(host, "mcp__rea_open_binary", { path: "x" });
  assert.equal(dead.isError, true);
  assert.match(dead.content[0].text, /The "rea" toolset is not running \(unloaded\)\. Call load_tools \{"server":"rea"\} to start it again\./);
  assert.match(textOf(await loadTools(host, {})), /- rea: .* \[stopped: unloaded\]/);
  assert.equal(textOf(await loadTools(host, { server: "rea", unload: true })), '"rea" is not loaded.');

  const before = host.registered.length;
  const reload = await loadTools(host, { server: "rea" });
  assert.match(textOf(reload), /^Loaded "rea": 3 tools/);
  assert.equal(host.registered.length, before, "omp cannot forget a tool: the same registrations serve the restarted server");
  assert.equal(host.state.connects.length, 2);
  const ok = await callTool(host, "mcp__rea_open_binary", { path: "x" });
  assert.equal(ok.isError, undefined);
  assert.equal(host.state.clients[1].calls.length, 1);
});

test("an unknown server is an error that lists the known ones; this also holds for names that exist on Object.prototype", async () => {
  const host = setup({ servers: { rea: REA, other: OTHER } });
  for (const name of ["nope", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
    const result = await loadTools(host, { server: name });
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), new RegExp(`^There is no on-demand toolset "${name}"\\.\\nOn-demand toolsets:\\n- other: .*\\n- rea: `), name);
    const unload = await loadTools(host, { server: name, unload: true });
    assert.equal(unload.isError, true, name);
  }
  assert.equal(host.state.connects.length, 0);
});

test("a failing connection or tools/list reports the error, mounts nothing and records nothing; a failed list closes the client", async () => {
  const host = setup();
  host.state.failWith = "spawn rea ENOENT";
  const result = await loadTools(host, { server: "rea" });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Could not load "rea": spawn rea ENOENT');
  host.state.failWith = undefined;
  host.state.listFails = "tools/list timed out";
  const second = await loadTools(host, { server: "rea" });
  assert.match(textOf(second), /Could not load "rea": tools\/list timed out/);
  assert.equal(host.state.clients[0].closed, 1);
  assert.deepEqual(host.entries, []);
  assert.deepEqual(host.registered, ["load_tools"]);
  host.state.listFails = undefined;
  assert.match(textOf(await loadTools(host, { server: "rea" })), /^Loaded "rea"/);
});

test("tools omp does not activate in time are reported, not hidden", async () => {
  const host = setup({ piOptions: { activateMs: -1 } });
  const result = await loadTools(host, { server: "rea" });
  assert.match(textOf(result), /3 of them are still being activated; retry in a moment/);
  assert.equal(result.isError, undefined);
});

test("a name another MCP connection already owns is left alone", async () => {
  const host = setup({ piOptions: { preActive: ["mcp__rea_open_binary"] } });
  const result = await loadTools(host, { server: "rea" });
  assert.match(textOf(result), /Loaded "rea": 2 tools/);
  assert.match(textOf(result), /1 more are already provided by an MCP connection of the same name and were left alone/);
  assert.equal(host.tools.has("mcp__rea_open_binary"), false);
});

test("a server that dies is reported by the tool and the listing, and can be loaded again", async () => {
  const host = setup();
  await loadTools(host, { server: "rea" });
  host.state.clients[0].closeHandlers[0]("MCP server exited (code 1)");
  const dead = await callTool(host, "mcp__rea_open_binary", { path: "x" });
  assert.equal(dead.isError, true);
  assert.match(dead.content[0].text, /not running \(MCP server exited \(code 1\)\)/);
  assert.match(textOf(await loadTools(host, {})), /\[stopped: MCP server exited \(code 1\)\]/);
  assert.match(textOf(await loadTools(host, { server: "rea" })), /^Loaded "rea"/);
  assert.equal(host.state.connects.length, 2);
  // a late close notice from the old, replaced client must not unmount the new one
  host.state.clients[0].closeHandlers[0]("late");
  assert.equal((await callTool(host, "mcp__rea_open_binary", { path: "x" })).isError, undefined);
});

test("a chat that comes back remounts what its own session recorded (session_start), and the first request waits for it", async () => {
  const host = setup({ servers: { rea: REA, other: OTHER }, connectOptions: { delayMs: 60 } });
  host.entries.push(
    { type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "rea", action: "load" } },
    { type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "other", action: "load" } },
    { type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "other", action: "unload" } },
  );
  await host.fire("session_start");
  assert.deepEqual(host.registered, ["load_tools"], "mounting runs in the background: session_start returns at once");
  const started = Date.now();
  const [answer] = await host.fire("before_agent_start", { systemPrompt: ["base"] });
  assert.ok(Date.now() - started >= 50, "the first request waited for the restore");
  assert.deepEqual(answer, {});
  assert.equal(host.state.connects.length, 1);
  assert.ok(host.tools.has("mcp__rea_open_binary"));
  assert.equal((await callTool(host, "mcp__rea_open_binary", { path: "x" })).isError, undefined);
  assert.equal(host.entries.length, 3, "restoring does not write new entries");
});

test("every session event restores: switch, branch and tree each re-read the entries; a branch that had not loaded it stops the server", async () => {
  const host = setup();
  host.entries.push({ type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "rea", action: "load" } });
  await host.fire("session_switch");
  await host.fire("before_agent_start", { systemPrompt: [] });
  assert.equal(host.state.connects.length, 1);
  await host.fire("session_tree");
  await host.fire("before_agent_start", { systemPrompt: [] });
  assert.equal(host.state.connects.length, 1, "already mounted: nothing restarts");
  host.entries.length = 0;
  await host.fire("session_branch");
  await host.fire("before_agent_start", { systemPrompt: [] });
  assert.equal(host.state.clients[0].closed, 1);
  const stopped = await callTool(host, "mcp__rea_open_binary", { path: "x" });
  assert.match(stopped.content[0].text, /not running \(this part of the conversation had not loaded it\)/);
});

const NOTE_RU = (failed) => `On-demand toolsets this chat had loaded but that could not be restored: ${failed}. Call load_tools to try again.`;

test("a restore that fails leaves ONE hidden note (never a systemPrompt) and a marker in the listing; loading by hand changes the note", async () => {
  const host = setup({ servers: { rea: REA, gone: OTHER } });
  host.entries.push(
    { type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "rea", action: "load" } },
    { type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "removed", action: "load" } },
  );
  host.state.failWith = "spawn rea ENOENT";
  await host.fire("session_start");
  const [answer] = await host.fire("before_agent_start", { systemPrompt: ["base prompt"] });
  assert.deepEqual(Object.keys(answer), ["message"], "omp re-announces its whole tool catalog for any systemPrompt, so there is none");
  assert.deepEqual(answer.message, {
    customType: extension.RESTORE_NOTE_TYPE,
    content: NOTE_RU("rea (spawn rea ENOENT); removed (it is no longer in the on-demand list)"),
    display: false,
    attribution: "agent",
  });
  assert.match(textOf(await loadTools(host, {})), /- rea: .* \[could not be restored: spawn rea ENOENT\]/);
  host.state.failWith = undefined;
  await loadTools(host, { server: "rea" });
  const [after] = await host.fire("before_agent_start", { systemPrompt: ["base"] });
  assert.deepEqual(Object.keys(after), ["message"]);
  assert.equal(after.message.content, NOTE_RU("removed (it is no longer in the on-demand list)"));
});

test("the restore note is given once: nothing is added while the conversation still holds it, and again after a compaction or reset", async () => {
  const host = setup({ servers: { rea: REA } });
  host.entries.push({ type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "rea", action: "load" } });
  host.state.failWith = "boom";
  await host.fire("session_start");
  const content = NOTE_RU("rea (boom)");
  const [first] = await host.fire("before_agent_start", {});
  assert.equal(first.message.content, content);
  // omp stored it as a custom_message entry
  host.entries.push({ type: "custom_message", customType: extension.RESTORE_NOTE_TYPE, content, display: false });
  assert.deepEqual((await host.fire("before_agent_start", {}))[0], {});
  // another extension's later note does not hide it
  host.entries.push({ type: "custom_message", customType: "cody-local-time", content: "clock" });
  assert.deepEqual((await host.fire("before_agent_start", {}))[0], {});
  // an older note with different content is not "live"
  host.entries.splice(-2, 1, { type: "custom_message", customType: extension.RESTORE_NOTE_TYPE, content: "older text" });
  assert.equal((await host.fire("before_agent_start", {}))[0].message.content, content);
  host.entries.splice(-2, 1, { type: "custom_message", customType: extension.RESTORE_NOTE_TYPE, content });
  assert.deepEqual((await host.fire("before_agent_start", {}))[0], {});
  for (const boundary of ["compaction", "reset_boundary"]) {
    host.entries.push({ type: boundary });
    assert.equal((await host.fire("before_agent_start", {}))[0].message.content, content, `after ${boundary}`);
    host.entries.pop();
  }
  // a branch omp cannot read counts as "not there"
  const unreadable = { sessionManager: { getBranch: () => { throw new Error("no branch"); } } };
  const [handler] = host.handlers.get("before_agent_start");
  assert.equal((await handler({}, unreadable)).message.content, content);
});

test("the restore note's type is one the transcript never shows", async () => {
  const display = await jiti.import("../message-display.ts");
  assert.equal(extension.RESTORE_NOTE_TYPE, "cody-on-demand-restore");
  assert.equal(display.isHiddenFromTranscript({ role: "custom", customType: extension.RESTORE_NOTE_TYPE }), true);
  assert.equal(display.isHiddenFromTranscript({ role: "user", customType: extension.RESTORE_NOTE_TYPE }), false);
});

test("a healthy restore adds nothing", async () => {
  const host = setup();
  host.entries.push({ type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "rea", action: "load" } });
  await host.fire("session_start");
  const [answer] = await host.fire("before_agent_start", { systemPrompt: ["base"] });
  assert.deepEqual(answer, {});
});

test("restored tools that omp never activates count as a failed restore", async () => {
  const host = setup({ piOptions: { activateMs: -1 } });
  host.entries.push({ type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "rea", action: "load" } });
  await host.fire("session_start");
  const [answer] = await host.fire("before_agent_start", { systemPrompt: [] });
  assert.match(answer.message.content, /rea \(3 tools were not activated in time\)/);
});

test("the first request waits only a bounded time for a restore that hangs", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const host = setup({ restoreWaitMs: 120 });
  host.state.gate = gate;
  host.entries.push({ type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "rea", action: "load" } });
  await host.fire("session_start");
  const started = Date.now();
  const [answer] = await host.fire("before_agent_start", { systemPrompt: ["base"] });
  const waited = Date.now() - started;
  assert.ok(waited >= 100 && waited < 1_000, `waited ${waited} ms`);
  assert.deepEqual(answer, {});
  release();
  await host.fire("before_agent_start", { systemPrompt: [] });
  assert.ok(host.tools.has("mcp__rea_open_binary"), "the restore still completes in the background");
});

test("session_shutdown closes every client", async () => {
  const host = setup({ servers: { rea: REA, other: OTHER } });
  await loadTools(host, { server: "rea" });
  await loadTools(host, { server: "other" });
  await host.fire("session_shutdown");
  assert.deepEqual(host.state.clients.map((client) => client.closed), [1, 1]);
  assert.match((await callTool(host, "mcp__rea_open_binary", { path: "x" })).content[0].text, /not running/);
});

test("the process exit hook closes clients (a crash of omp leaves no server behind)", async () => {
  const host = setup();
  await loadTools(host, { server: "rea" });
  const added = process.listeners("exit").slice(exitListeners);
  assert.equal(added.length, 1);
  added[0]();
  await sleep(5);
  assert.equal(host.state.clients[0].closed, 1);
});

test("computer: load asks Cody (details.codyOnDemand) instead of mounting anything; repeating it does not ask twice", async () => {
  const host = setup({ servers: {}, env: { [ON_DEMAND_COMPUTER_ENV]: "off" } });
  const result = await loadTools(host, { server: "computer" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, { codyOnDemand: { server: "computer", action: "load" } });
  assert.match(textOf(result), /^Desktop control \(computer\) is switched on for this chat\. Cody restarts the engine as soon as this turn ends/);
  assert.match(textOf(result), /telling the user to send their request again/);
  const again = await loadTools(host, { server: "computer" });
  assert.equal(again.details, undefined);
  assert.match(textOf(again), /already being switched on/);
  assert.equal(host.state.connects.length, 0);
  assert.deepEqual(host.entries, [], "computer is Cody's state, not a session entry");
  // the real tool_execution_end frame for it is recognized by Cody's parser
  const frame = { type: "tool_execution_end", toolCallId: "c", toolName: "load_tools", result, isError: false };
  assert.deepEqual(registryModule.onDemandSignalFromEvent(frame), { server: "computer", action: "load" });
});

test("computer: already on is a plain answer; unload asks Cody to switch it off; unloading while off is a plain answer", async () => {
  const on = setup({ servers: {}, env: { [ON_DEMAND_COMPUTER_ENV]: "on" } });
  const already = await loadTools(on, { server: "computer" });
  assert.equal(textOf(already), "Desktop control is already on in this chat.");
  assert.equal(already.details, undefined);
  const off = await loadTools(on, { server: "computer", unload: true });
  assert.deepEqual(off.details, { codyOnDemand: { server: "computer", action: "unload" } });
  assert.match(textOf(off), /switched off for this chat/);
  assert.match(textOf(await loadTools(on, { server: "computer", unload: true })), /already being switched off/);

  const idle = setup({ servers: {}, env: { [ON_DEMAND_COMPUTER_ENV]: "off" } });
  const none = await loadTools(idle, { server: "computer", unload: true });
  assert.equal(textOf(none), "Desktop control is not on in this chat.");
  assert.equal(none.details, undefined);
});

test("computer: when Cody does not offer it (no env), 'computer' is just an unknown toolset", async () => {
  const host = setup({ env: {} });
  const result = await loadTools(host, { server: "computer" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /There is no on-demand toolset "computer"/);
  assert.equal(result.details, undefined);
});

test("computer and MCP toolsets live side by side in one chat", async () => {
  const host = setup({ env: { [ON_DEMAND_COMPUTER_ENV]: "off" } });
  assert.match(textOf(await loadTools(host, { server: "rea" })), /^Loaded "rea"/);
  assert.deepEqual((await loadTools(host, { server: "computer" })).details.codyOnDemand, { server: "computer", action: "load" });
  assert.match(textOf(await loadTools(host, {})), /- rea: .* \[loaded\]\n- computer: /);
});

test("the extension registers NO tool_call / tool_result handler (omp would switch off task.speculativeLaunch) and only the events it needs", () => {
  const host = setup({ env: { [ON_DEMAND_COMPUTER_ENV]: "off" } });
  assert.deepEqual([...host.handlers.keys()].sort(), ["before_agent_start", "session_branch", "session_shutdown", "session_start", "session_switch", "session_tree"]);
  for (const forbidden of ["tool_call", "tool_result", "tool_execution_end", "tool_execution_start"]) assert.equal(host.handlers.has(forbidden), false, forbidden);
});

test("a registry edited after the chat began is picked up for the listing and for loads", async () => {
  const host = setup({ servers: { rea: REA } });
  assert.equal((await loadTools(host, { server: "other" })).isError, true);
  writeRegistryAt(host.registryPath, { rea: REA, other: OTHER });
  assert.match(textOf(await loadTools(host, {})), /- other: /);
  assert.match(textOf(await loadTools(host, { server: "other" })), /^Loaded "other"/);
  assert.deepEqual(host.state.connects.at(-1).config, OTHER.config);
});

test("a corrupt registry mid-chat lists nothing instead of crashing; entries it cannot use are ignored", async () => {
  const host = setup({ servers: { rea: REA, bad: { config: { type: "sse", url: "https://x.test/sse" } } } });
  assert.deepEqual(host.tools.get("load_tools").description.split("\n").slice(2), ["- rea: Reverse engineering: binaries, APKs, firmware"]);
  writeFileSync(host.registryPath, "{broken");
  stamp += 5;
  utimesSync(host.registryPath, stamp, stamp);
  assert.equal(textOf(await loadTools(host, {})), "There are no on-demand toolsets.");
  const result = await loadTools(host, { server: "rea" });
  assert.equal(result.isError, true);
});

test("registryPathFromEnv: explicit file, else the agent dir, else ~/.omp/agent", () => {
  const { registryPathFromEnv } = extension;
  assert.equal(registryPathFromEnv({ [ON_DEMAND_REGISTRY_ENV]: "/x/reg.json", PI_CODING_AGENT_DIR: "/y" }), "/x/reg.json");
  assert.equal(registryPathFromEnv({ PI_CODING_AGENT_DIR: "/y" }), join("/y", "cody-on-demand-mcp.json"));
  assert.match(registryPathFromEnv({}), /\.omp[\\/]agent[\\/]cody-on-demand-mcp\.json$/);
});

test("onDemandToolName and the extension agree on the minted name", async () => {
  const host = setup();
  await loadTools(host, { server: "rea" });
  for (const tool of REA_TOOLS) assert.ok(host.tools.has(onDemandToolName("rea", tool.name)), tool.name);
});
