import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The registry module is shared by Cody's Settings store and the omp extension
 * (lib/omp/extensions/cody-on-demand-mcp.ts); it must stay dependency-free and
 * its `load_tools` text must stay tiny, because that text is in EVERY request.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const registry = await jiti.import("./registry.ts");
const {
  COMPUTER_PURPOSE,
  COMPUTER_SERVER,
  LOAD_TOOLS_NAME,
  LOAD_TOOLS_SCHEMA,
  ON_DEMAND_ENTRY_TYPE,
  ON_DEMAND_SIGNAL_KEY,
  approximateTokens,
  describeLoadTools,
  emptyRegistry,
  normalizePurpose,
  onDemandConfigProblem,
  onDemandLegacyToolName,
  onDemandSignalFromEvent,
  onDemandToolName,
  onDemandTransport,
  parseRegistry,
  registryNames,
  replayLoaded,
  serializeRegistry,
} = registry;

const stdio = { type: "stdio", command: "rea", args: ["serve"] };
const REA_PURPOSE = "Reverse-engineering: native binaries, APKs, firmware, packets, web bundles, Frida and ADB; load before analysing an artifact";

test("parseRegistry reads a valid registry, sorted names, normalized purposes", () => {
  const { registry: parsed, problems } = parseRegistry({
    version: 1,
    servers: {
      rea: { purpose: "  reverse\n engineering  ", config: stdio },
      alpha: { config: { url: "https://example.test/mcp", type: "http", headers: { Authorization: "Bearer x" } } },
      implicit: { purpose: "p", config: { command: "node" } },
    },
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(registryNames(parsed), ["alpha", "implicit", "rea"]);
  assert.equal(parsed.servers.rea.purpose, "reverse engineering");
  assert.equal(parsed.servers.alpha.purpose, "");
  assert.equal(parsed.servers.rea.config, parsed.servers.rea.config);
  assert.equal(parsed.version, 1);
});

test("parseRegistry accepts JSON text and treats blank text, null and a missing file as empty", () => {
  assert.deepEqual(parseRegistry(JSON.stringify({ servers: { rea: { config: stdio } } })).problems, []);
  for (const empty of ["", "  \n", undefined, null, {}, { servers: undefined }]) {
    const parsed = parseRegistry(empty);
    assert.deepEqual(parsed.problems, [], JSON.stringify(empty));
    assert.deepEqual(parsed.registry, emptyRegistry());
  }
});

test("parseRegistry never throws: every malformed shape becomes a problem and the good entries survive", () => {
  assert.deepEqual(parseRegistry("{nope").problems, ["the registry file is not valid JSON"]);
  assert.deepEqual(parseRegistry([]).problems, ["the registry must be a JSON object"]);
  assert.deepEqual(parseRegistry(42).problems, ["the registry must be a JSON object"]);
  assert.deepEqual(parseRegistry({ servers: [] }).problems, ["`servers` must be an object"]);
  assert.deepEqual(parseRegistry({ servers: "x" }).problems, ["`servers` must be an object"]);

  const { registry: parsed, problems } = parseRegistry({
    servers: {
      good: { purpose: "ok", config: stdio },
      "bad name": { config: stdio },
      "-leading": { config: stdio },
      notObject: 5,
      noConfig: { purpose: "x" },
      both: { config: { command: "a", url: "https://x.test" } },
      neither: { config: { type: "stdio" } },
      sse: { config: { type: "sse", url: "https://x.test/sse" } },
      httpNoUrl: { config: { type: "http", command: "node" } },
      stdioWithUrl: { config: { type: "stdio", url: "https://x.test" } },
    },
  });
  assert.deepEqual(registryNames(parsed), ["good"]);
  assert.equal(problems.length, 9);
  assert.ok(problems.some((line) => line.startsWith('"bad name"')));
  assert.ok(problems.some((line) => line.startsWith('"notObject": the entry must be an object')));
  assert.ok(problems.some((line) => line.startsWith('"sse"') && /legacy sse/.test(line)));
});

test("a hostile registry (huge purpose, prototype keys) cannot break parsing", () => {
  const hostile = JSON.parse('{"servers":{"__proto__":{"config":{"command":"x"}},"constructor":{"config":{"command":"x"}},"big":{"purpose":"' + "x".repeat(100_000) + '","config":{"command":"x"}}}}');
  const { registry: parsed, problems } = parseRegistry(hostile);
  assert.deepEqual(problems, ['"__proto__": the server name may only contain letters, numbers, dots, dashes and underscores']);
  assert.equal(parsed.servers.big.purpose.length, 160);
  assert.ok(parsed.servers.big.purpose.endsWith("…"));
  assert.equal(Object.getPrototypeOf(parsed.servers), Object.prototype);
  assert.deepEqual(registryNames(parsed), ["big", "constructor"]);
});

test("normalizePurpose collapses whitespace, caps at 160 chars and ignores non-strings", () => {
  assert.equal(normalizePurpose("  a\n\tb   c "), "a b c");
  assert.equal(normalizePurpose(5), "");
  assert.equal(normalizePurpose(undefined), "");
  assert.equal(normalizePurpose("y".repeat(160)).length, 160);
  assert.equal(normalizePurpose("y".repeat(161)).length, 160);
});

test("onDemandTransport and onDemandConfigProblem accept exactly stdio and http definitions", () => {
  assert.equal(onDemandTransport({ command: "x" }), "stdio");
  assert.equal(onDemandTransport({ type: "stdio", command: "x" }), "stdio");
  assert.equal(onDemandTransport({ type: "http", url: "https://x.test" }), "http");
  assert.equal(onDemandTransport({ url: "https://x.test" }), undefined, "a url without type http is not loadable");
  assert.equal(onDemandTransport({ command: "  " }), undefined);
  assert.equal(onDemandTransport({ type: "sse", url: "https://x.test" }), undefined);
  assert.equal(onDemandConfigProblem({ command: "x" }), undefined);
  assert.match(onDemandConfigProblem("x"), /must be an object/);
  assert.match(onDemandConfigProblem({}), /exactly one of a command/);
});

test("serializeRegistry writes version 1 with names sorted and round-trips through parseRegistry", () => {
  const source = { version: 1, servers: { z: { purpose: "z", config: { command: "z" } }, a: { purpose: "", config: { url: "https://a.test", type: "http" } } } };
  const text = serializeRegistry(source);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(Object.keys(JSON.parse(text).servers), ["a", "z"]);
  assert.deepEqual(parseRegistry(text).registry, source);
});

test("onDemandToolName mints omp's mcp__<server>_<tool> names", () => {
  assert.equal(onDemandToolName("rea", "analyze_function"), "mcp__rea_analyze_function");
  // the server prefix inside a tool name is dropped once, like omp does
  assert.equal(onDemandToolName("rea", "rea_open_binary"), "mcp__rea_open_binary");
  // case and punctuation fold to underscores; digits are kept
  assert.equal(onDemandToolName("My.Server-2", "Get Item/V2"), "mcp__my_server_2_get_item_v2");
  // nothing usable falls back to placeholders
  assert.equal(onDemandToolName("---", "!!!"), "mcp__server_tool");
});

test("a long name is cut to 64 characters with a stable hash suffix", () => {
  const long = "x".repeat(80);
  const name = onDemandToolName("rea", long);
  assert.equal(name.length, 64);
  assert.match(name, /^mcp__rea_x+_[0-9a-z]{1,8}$/);
  assert.equal(onDemandToolName("rea", long), name, "deterministic");
  assert.notEqual(onDemandToolName("rea", `${long}y`), name, "the hash separates names that share a prefix");
});

test("onDemandLegacyToolName exists only when digits made the name differ", () => {
  assert.equal(onDemandLegacyToolName("rea", "open_binary"), undefined);
  const legacy = onDemandLegacyToolName("rea", "inspect_pe_v2");
  assert.equal(legacy, "mcp__rea_inspect_pe_v");
  assert.equal(onDemandToolName("rea", "inspect_pe_v2"), "mcp__rea_inspect_pe_v2");
  assert.equal(onDemandLegacyToolName("srv2", "tool"), "mcp__srv_tool");
});

test("describeLoadTools lists toolsets by name order, one short line each, and stays tiny", () => {
  const { registry: parsed } = parseRegistry({ servers: { rea: { purpose: REA_PURPOSE, config: stdio } } });
  const text = describeLoadTools(parsed, [{ name: COMPUTER_SERVER, purpose: COMPUTER_PURPOSE }]);
  const lines = text.split("\n");
  assert.equal(lines[1], "Toolsets:");
  assert.match(lines[2], /^- computer: See and control the desktop/);
  assert.match(lines[3], /^- rea: Reverse-engineering/);
  assert.ok(lines[3].length <= 2 + 96 + "rea: ".length, "a purpose is clipped to 96 characters");
  assert.ok(lines[3].endsWith("…"));
  // the request-cost gate: measured 374 characters (about 94 tokens) for rea + computer
  assert.ok(text.length <= 600, `description is ${text.length} chars`);
  assert.ok(approximateTokens(text) <= 150, `description is ${approximateTokens(text)} tokens`);
  const definition = { name: LOAD_TOOLS_NAME, label: "Load tools", description: text, parameters: LOAD_TOOLS_SCHEMA };
  const serialized = JSON.stringify(definition).length;
  assert.ok(serialized <= 900, `load_tools definition is ${serialized} chars`);
});

test("describeLoadTools caps the list at six and says how many more there are; an empty registry lists nothing", () => {
  const servers = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`s${index}`, { purpose: "p", config: stdio }]));
  const text = describeLoadTools(parseRegistry({ servers }).registry);
  const lines = text.split("\n");
  assert.equal(lines.length, 2 + 6 + 1);
  assert.equal(lines.at(-1), "- …and 3 more (call with no server to list)");
  assert.deepEqual(describeLoadTools(emptyRegistry()).split("\n").slice(1), ["Toolsets:"]);
  // a toolset without a purpose is just its name
  assert.match(describeLoadTools(parseRegistry({ servers: { bare: { config: stdio } } }).registry), /\n- bare$/);
});

test("LOAD_TOOLS_SCHEMA is server (string) and unload (boolean) with no extras", () => {
  assert.deepEqual(LOAD_TOOLS_SCHEMA, { type: "object", properties: { server: { type: "string" }, unload: { type: "boolean" } }, additionalProperties: false });
});

const entry = (server, action) => ({ type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server, action } });

test("replayLoaded: the last record for a server wins, in load order", () => {
  assert.deepEqual(replayLoaded([]), []);
  assert.deepEqual(replayLoaded([entry("rea", "load"), entry("b", "load")]), ["rea", "b"]);
  assert.deepEqual(replayLoaded([entry("rea", "load"), entry("rea", "unload")]), []);
  assert.deepEqual(replayLoaded([entry("rea", "load"), entry("b", "load"), entry("rea", "unload"), entry("rea", "load")]), ["b", "rea"]);
  assert.deepEqual(replayLoaded([entry("rea", "load"), entry("rea", "load")]), ["rea"]);
  assert.deepEqual(replayLoaded([entry("never", "unload")]), []);
});

test("replayLoaded ignores malformed entries and entries of other types", () => {
  const noise = [
    null,
    "text",
    5,
    { type: "message", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "x", action: "load" } },
    { type: "custom", customType: "other", data: { server: "x", action: "load" } },
    { type: "custom", customType: ON_DEMAND_ENTRY_TYPE },
    { type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: "x" },
    { type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: 5, action: "load" } },
    { type: "custom", customType: ON_DEMAND_ENTRY_TYPE, data: { server: "x", action: "restart" } },
    entry("kept", "load"),
  ];
  assert.deepEqual(replayLoaded(noise), ["kept"]);
});

/** The frame omp's RPC mode emits when a tool finishes. */
const executionEnd = (overrides = {}) => ({
  type: "tool_execution_end",
  toolCallId: "call_1",
  toolName: LOAD_TOOLS_NAME,
  result: { content: [{ type: "text", text: "Desktop control is switched on" }], details: { [ON_DEMAND_SIGNAL_KEY]: { server: "computer", action: "load" } } },
  isError: false,
  ...overrides,
});

test("onDemandSignalFromEvent reads the signal of a real tool_execution_end for load_tools", () => {
  assert.deepEqual(onDemandSignalFromEvent(executionEnd()), { server: "computer", action: "load" });
  const unload = executionEnd({ result: { content: [], details: { codyOnDemand: { server: "computer", action: "unload", extra: 1 } } } });
  assert.deepEqual(onDemandSignalFromEvent(unload), { server: "computer", action: "unload" });
  assert.equal(ON_DEMAND_SIGNAL_KEY, "codyOnDemand");
});

test("onDemandSignalFromEvent rejects other tools, errored results and every wrong shape", () => {
  assert.equal(onDemandSignalFromEvent(executionEnd({ toolName: "bash" })), undefined);
  assert.equal(onDemandSignalFromEvent(executionEnd({ isError: true })), undefined);
  assert.equal(onDemandSignalFromEvent(executionEnd({ result: undefined })), undefined);
  assert.equal(onDemandSignalFromEvent(executionEnd({ result: "text" })), undefined);
  assert.equal(onDemandSignalFromEvent(executionEnd({ result: { content: [] } })), undefined);
  assert.equal(onDemandSignalFromEvent(executionEnd({ result: { details: null } })), undefined);
  assert.equal(onDemandSignalFromEvent(executionEnd({ result: { details: { codyOnDemand: "computer" } } })), undefined);
  assert.equal(onDemandSignalFromEvent(executionEnd({ result: { details: { codyOnDemand: { server: 1, action: "load" } } } })), undefined);
  assert.equal(onDemandSignalFromEvent(executionEnd({ result: { details: { codyOnDemand: { server: "computer", action: "reboot" } } } })), undefined);
  assert.equal(onDemandSignalFromEvent({ type: "tool_execution_end", toolName: LOAD_TOOLS_NAME }), undefined);
  for (const junk of [null, undefined, "x", 3, []]) assert.equal(onDemandSignalFromEvent(junk), undefined);
});
