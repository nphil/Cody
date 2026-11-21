import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { toolCommandCall, toolCommandRecords } = await jiti.import("./tool-command.ts");

// Shapes captured from a real omp 19.1.0 run (Cody's host tools and an MCP server mounted as tool commands):
// the bash call is `{ command, i }`, and the result's details name the command the shell ran.
const OPEN_URL = { command: `open_url -j '{"url":"http://127.0.0.1:3000","title":"Proof"}'`, i: "Calling open_url" };
const OPEN_URL_DETAILS = {
  wallTimeNoticeEmitted: false,
  timeoutSeconds: 300,
  wallTimeMs: 12.4,
  toolCommands: [{ tool: "open_url", mode: "execute", exitCode: 0, args: { url: "http://127.0.0.1:3000", title: "Proof" }, tier: "exec" }],
};

test("a tool command shows as its tool once the engine's record says so", () => {
  const call = toolCommandCall("bash", OPEN_URL, OPEN_URL_DETAILS);
  assert.equal(call?.tool, "open_url");
  assert.deepEqual(call?.args, { url: "http://127.0.0.1:3000", title: "Proof" });
  assert.equal(call?.rest, `-j '{"url":"http://127.0.0.1:3000","title":"Proof"}'`);
  const help = toolCommandCall("bash", { command: "open_url --help" }, { toolCommands: [{ tool: "open_url", mode: "help", exitCode: 0 }] });
  assert.equal(help?.tool, "open_url");
  assert.equal(help?.rest, "--help");
});

test("without a record only an MCP tool's own name proves a tool command", () => {
  // A running call and a reloaded history carry no record.
  assert.equal(toolCommandCall("bash", OPEN_URL), null, "open_url could be any program on the PATH");
  assert.equal(toolCommandCall("bash", OPEN_URL, {}), null);
  const mcp = toolCommandCall("bash", { command: `mcp__mini_echo -j '{"text":"hello"}'` });
  assert.equal(mcp?.tool, "mcp__mini_echo");
  assert.deepEqual(mcp?.args, { text: "hello" });
  assert.equal(toolCommandCall("bash", { command: "mcp__mini_ping" })?.rest, "");
  assert.equal(toolCommandCall("bash", { command: "mcp__mini_echo --json='{\"a\":1}'" })?.args?.a, 1);
  assert.equal(toolCommandCall("bash", { command: "mcp__mini_echo @args.json" })?.args, null);
});

test("only a bash call whose line is ONE simple command can be a tool command", () => {
  for (const command of [
    "mcp__mini_echo -j '{}'; echo done",
    "mcp__mini_echo -j '{}' && ls",
    "mcp__mini_echo | cat",
    "mcp__mini_echo > out.txt",
    "mcp__mini_echo $(whoami)",
    "mcp__mini_echo \"$HOME\"",
    "mcp__mini_echo `whoami`",
    "mcp__mini_echo -j '{}",
    "mcp__mini_echo\nls",
    "mcp__mini_echo # a comment",
    "echo mcp__mini_echo",
    "FOO=1 mcp__mini_echo",
    "",
    "   ",
  ]) {
    assert.equal(toolCommandCall("bash", { command }), null, JSON.stringify(command));
    assert.equal(toolCommandCall("bash", { command }, { toolCommands: [{ tool: "mcp__mini_echo" }] }), null, `with a record: ${JSON.stringify(command)}`);
  }
  assert.equal(toolCommandCall("write", { command: "mcp__mini_echo" }), null);
  assert.equal(toolCommandCall("bash", undefined), null);
  assert.equal(toolCommandCall("bash", { command: 7 }), null);
});

test("quotes and escapes are read as the shell reads them", () => {
  const call = toolCommandCall("bash", { command: `mcp__mini_echo -j "{\\"text\\":\\"a b\\"}"` });
  assert.deepEqual(call?.args, { text: "a b" });
  assert.deepEqual(toolCommandCall("bash", { command: `mcp__mini_echo -j '{"text":"it is #1; ok & $HOME"}'` })?.args, { text: "it is #1; ok & $HOME" });
  assert.equal(toolCommandCall("bash", { command: `mcp__mini_echo a#b` })?.tool, "mcp__mini_echo");
  assert.equal(toolCommandCall("bash", { command: `  mcp__mini_echo   -j   '{"x":1}'  ` })?.rest, `-j   '{"x":1}'`);
});

test("the record must be the only one and name the command's own first word", () => {
  const input = { command: "open_url -j '{}'" };
  assert.equal(toolCommandCall("bash", input, { toolCommands: [{ tool: "notify" }] }), null);
  assert.equal(toolCommandCall("bash", input, { toolCommands: [{ tool: "open_url" }, { tool: "notify" }] }), null);
  assert.equal(toolCommandCall("bash", input, { toolCommands: [] }), null);
  assert.equal(toolCommandCall("bash", input, { toolCommands: [{ tool: "open_url", args: { url: "x" } }] })?.args?.url, "x");
});

test("records are bounded and only well-formed ones count", () => {
  assert.deepEqual(toolCommandRecords(undefined), []);
  assert.deepEqual(toolCommandRecords({ toolCommands: "open_url" }), []);
  const records = toolCommandRecords({
    toolCommands: [
      { tool: "open_url", mode: "execute", exitCode: 0, args: { url: "x" }, tier: "exec", inner: { huge: "x".repeat(10) } },
      { tool: "" },
      { tool: "x".repeat(129) },
      { tool: 7 },
      "open_url",
      { tool: "notify", mode: "a-very-long-mode-name", exitCode: "1" },
    ],
  });
  assert.deepEqual(records, [
    { tool: "open_url", mode: "execute", exitCode: 0, args: { url: "x" } },
    { tool: "notify", mode: null, exitCode: null },
  ]);
  assert.equal(toolCommandRecords({ toolCommands: Array.from({ length: 50 }, () => ({ tool: "open_url" })) }).length, 8);
});
