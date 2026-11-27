import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  LAZY_BLOCK_MIN_CHARS,
  LAZY_PAGE_CHARS,
  LAZY_PREVIEW_CHARS,
  clampPageSize,
  decodePointer,
  encodePointer,
  lazyDetailText,
  lazyDetailUrl,
  parseLazyPage,
  projectLazyBlocks,
  sliceLazyPage,
} = await jiti.import("./lazy-blocks.ts");

const BIG = "a".repeat(LAZY_BLOCK_MIN_CHARS + 1);
const assistant = (content) => ({ role: "assistant", provider: "p", model: "m", content });
const call = (toolCallId, toolName, input) => ({ type: "toolCall", toolCallId, toolName, input });
const result = (toolCallId, text, extra = {}) => ({ role: "toolResult", toolCallId, toolName: "x", content: [{ type: "text", text }], ...extra });

/** One oldest-first walk, the way buildSessionContext does it. */
function walk(messages) {
  const calls = new Set();
  return messages.map((message, index) => projectLazyBlocks(message, `e${index}`, calls));
}

test("a message with nothing oversized is returned as the same object", () => {
  const messages = [
    assistant([{ type: "thinking", thinking: "a".repeat(LAZY_BLOCK_MIN_CHARS) }, call("t", "read", { path: "/x" })]),
    result("t", "ok"),
    { role: "user", content: BIG },
    { role: "custom", customType: "x", content: BIG, display: true },
  ];
  const calls = new Set();
  for (const message of messages) assert.equal(projectLazyBlocks(message, "e1", calls), message);
});

test("oversized thinking becomes an empty deferred stub that names its entry and length", () => {
  const message = assistant([{ type: "text", text: "hi" }, { type: "thinking", thinking: BIG }]);
  const projected = projectLazyBlocks(message, "e1");
  assert.notEqual(projected, message);
  assert.equal(message.content[1].thinking, BIG, "input is never mutated");
  assert.deepEqual(projected.content[1], { type: "thinking", thinking: "", deferred: true, lazyChars: BIG.length, lazyEntry: "e1" });
  assert.equal(projected.content[0], message.content[0]);
});

test("narration and already-deferred thinking are left alone", () => {
  const message = assistant([{ type: "thinking", thinking: BIG, narration: true }, { type: "thinking", thinking: BIG, deferred: true }]);
  assert.equal(projectLazyBlocks(message, "e1"), message);
});

test("a tool result is stubbed only when a generic call earlier on the walk owns its id", () => {
  const image = { type: "image", source: { type: "url", url: "/m" } };
  const paired = { ...result("c1", BIG), content: [image, { type: "text", text: BIG }, { type: "text", text: "tail" }] };
  const [, projected] = walk([assistant([call("c1", "bash", { command: "cat <<EOF\nx\nEOF" })]), paired]);
  assert.equal(projected.content[0], image);
  assert.deepEqual(projected.content[1], { type: "text", text: "a".repeat(LAZY_PREVIEW_CHARS), lazyChars: BIG.length, lazyEntry: "e1" });
  assert.equal(projected.content[2], paired.content[2]);

  const [unpaired] = walk([result("nobody", BIG)]);
  assert.equal(unpaired.content[0].text, BIG, "a result with no call on the walk arrives whole");
  assert.equal(projectLazyBlocks(result("c1", BIG), "e").content[0].text, BIG, "an entry read alone arrives whole");
});

test("specialized calls and their results arrive whole", () => {
  const ask = call("ask1", "ask", { questions: [BIG] });
  const askViaWrite = call("ask2", "write", { path: "xd://ask", content: BIG });
  const homelabber = call("h1", "mcp__homelabber_firewall_open", { note: BIG });
  const viaDevice = call("h2", "write", { path: "xd://mcp__homelabber_approval_wait", content: BIG });
  const toolCommand = call("b1", "bash", { command: `mcp__demo_tool -j '${JSON.stringify({ url: BIG })}'` });
  const calls = [ask, askViaWrite, homelabber, viaDevice, toolCommand];
  const projected = walk([assistant(calls), ...calls.map((block) => result(block.toolCallId, BIG))]);
  assert.equal(projected[0].content[0], ask);
  assert.equal(projected[0].content[1], askViaWrite);
  assert.equal(projected[0].content[2], homelabber);
  assert.equal(projected[0].content[3], viaDevice);
  assert.equal(projected[0].content[4], toolCommand);
  for (const answer of projected.slice(1)) assert.equal(answer.content[0].text, BIG);
});

test("a result carrying the engine's tool-command record arrives whole even for a generic-looking call", () => {
  const details = { toolCommands: [{ tool: "open_url", mode: "json", exitCode: 0 }] };
  const [, projected] = walk([assistant([call("c1", "bash", { command: "echo a\nopen_url" })]), result("c1", BIG, { details })]);
  assert.equal(projected.content[0].text, BIG);
});

test("a simple bash command keeps its command line whole but its output is stubbed, unless the engine recorded a tool command", () => {
  const command = call("c1", "bash", { command: `cat ${"f".repeat(LAZY_BLOCK_MIN_CHARS)}` });
  const [assistantOut, stubbed] = walk([assistant([command]), result("c1", BIG)]);
  assert.equal(assistantOut.content[0], command, "the command line is never previewed");
  assert.equal(stubbed.content[0].lazyChars, BIG.length);
  const details = { toolCommands: [{ tool: "cat", mode: "args", exitCode: 0 }] };
  const [, whole] = walk([assistant([command]), result("c1", BIG, { details })]);
  assert.equal(whole.content[0].text, BIG);
});

test("a later call that reuses an id takes the pairing with it", () => {
  const [, , second] = walk([
    assistant([call("c1", "read", { path: "/a" })]),
    assistant([call("c1", "ask", { questions: [] })]),
    result("c1", BIG),
  ]);
  assert.equal(second.content[0].text, BIG);
});

test("a preview never ends inside a surrogate pair", () => {
  const text = "x".repeat(LAZY_PREVIEW_CHARS - 1) + "😀" + "y".repeat(LAZY_BLOCK_MIN_CHARS);
  const [, projected] = walk([assistant([call("c", "read", {})]), result("c", text)]);
  assert.equal(projected.content[0].text, "x".repeat(LAZY_PREVIEW_CHARS - 1));
});

test("oversized argument strings are previewed at their pointers, other fields keep identity", () => {
  const edits = [{ old: "a", new: BIG }, { old: "b", new: "c" }];
  const keep = { nested: true };
  const input = { path: "/f", content: BIG, edits, keep };
  const message = assistant([call("t", "write", input)]);
  const block = projectLazyBlocks(message, "e3").content[0];
  assert.deepEqual(block.lazyInput, { "/content": BIG.length, "/edits/0/new": BIG.length });
  assert.equal(block.lazyEntry, "e3");
  assert.equal(block.input.content, "a".repeat(LAZY_PREVIEW_CHARS));
  assert.equal(block.input.edits[0].new, "a".repeat(LAZY_PREVIEW_CHARS));
  assert.equal(block.input.edits[1], edits[1]);
  assert.equal(block.input.keep, keep);
  assert.equal(input.content, BIG, "input is never mutated");
  assert.equal(edits[0].new, BIG);
});

test("strings deeper than the walk limit are left as they are", () => {
  const message = assistant([call("t", "x", { a: { b: { c: { d: { e: BIG } } } } })]);
  assert.equal(projectLazyBlocks(message, "e"), message);
});

test("a stored __proto__ key stays data and pollutes nothing", () => {
  const input = JSON.parse(`{"__proto__": {"polluted": "${BIG}"}, "k": "v"}`);
  const projected = projectLazyBlocks(assistant([call("t", "x", input)]), "e");
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(projected.content[0].input), Object.prototype);
  assert.equal(Object.hasOwn(projected.content[0].input, "__proto__"), true);
  assert.equal(projected.content[0].input.k, "v");
});

test("at most 64 argument strings are stubbed", () => {
  const input = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`k${index}`, BIG]));
  const block = projectLazyBlocks(assistant([call("t", "x", input)]), "e").content[0];
  assert.equal(Object.keys(block.lazyInput).length, 64);
});

test("pointers round-trip keys with slashes and tildes and refuse malformed input", () => {
  const pointer = encodePointer(["a/b", "~x", 3, ""]);
  assert.deepEqual(decodePointer(pointer), ["a/b", "~x", "3", ""]);
  assert.equal(decodePointer("no-slash"), null);
  assert.equal(decodePointer("/bad~2escape"), null);
});

test("lazyDetailText reads only the three displayed fields and only through own properties", () => {
  const msg = assistant([
    { type: "thinking", thinking: "deep" },
    { type: "text", text: "answer" },
    call("t", "write", { content: "FULL", list: ["x", "y"], n: 5 }),
  ]);
  assert.equal(lazyDetailText(msg, "thinking", 0), "deep");
  assert.equal(lazyDetailText(msg, "thinking", 1), null, "assistant text is not a detail block");
  assert.equal(lazyDetailText(msg, "arg", 2, "/content"), "FULL");
  assert.equal(lazyDetailText(msg, "arg", 2, "/list/1"), "y");
  for (const pointer of ["/n", "/__proto__", "/constructor/name", "/list/length", "", undefined]) {
    assert.equal(lazyDetailText(msg, "arg", 2, pointer), null, String(pointer));
  }
  assert.equal(lazyDetailText(msg, "result", 0), null, "kind must match the message role");
  assert.equal(lazyDetailText(msg, "thinking", -1), null);
  assert.equal(lazyDetailText(msg, "thinking", 99), null);
  const withDetails = { ...result("t", "out"), content: [{ type: "text", text: "out" }, { type: "image", data: "AAAA" }], details: { secret: "no" } };
  assert.equal(lazyDetailText(withDetails, "result", 0), "out");
  assert.equal(lazyDetailText(withDetails, "result", 1), null);
  assert.equal(lazyDetailText(withDetails, "thinking", 0), null);
  assert.equal(lazyDetailText({ role: "user", content: "x" }, "result", 0), null);
  assert.equal(lazyDetailText({ role: "bashExecution", command: "ls", output: "x" }, "result", 0), null);
});

test("pages tile the text exactly, from the first to the last, whatever the characters", () => {
  const samples = ["", "a", "abcdef", "ab😀cd", "😀😀😀😀😀", "x😀".repeat(50), "é漢字".repeat(40)];
  for (const text of samples) {
    for (const size of [2, 3, 4, 7, 64]) {
      const first = sliceLazyPage(text, 0, size);
      assert.equal(first.total, text.length);
      assert.equal(first.pages, Math.max(1, Math.ceil(text.length / clampPageSize(size))));
      let rebuilt = "";
      for (let page = 0; page < first.pages; page += 1) {
        const slice = sliceLazyPage(text, page, size);
        assert.equal(slice.page, page);
        assert.ok(slice.text.length <= clampPageSize(size) + 1, "a page is at most size + 1 units");
        assert.doesNotMatch(slice.text, /^[\udc00-\udfff]/, "a page never starts inside a pair");
        assert.doesNotMatch(slice.text, /[\ud800-\udbff]$/, "a page never ends inside a pair");
        if (text !== "") assert.notEqual(slice.text, "");
        rebuilt += slice.text;
      }
      assert.equal(rebuilt, text, `${JSON.stringify(text.slice(0, 8))} size ${size}`);
      assert.equal(sliceLazyPage(text, first.pages, size), null, "past the last page there is nothing");
    }
  }
});

test("page requests outside the text or the number line are refused", () => {
  assert.equal(sliceLazyPage("abc", -1), null);
  assert.equal(sliceLazyPage("abc", 1.5), null);
  assert.equal(sliceLazyPage("abc", Number.NaN), null);
  assert.equal(sliceLazyPage("abc", 1), null);
  assert.deepEqual(sliceLazyPage("abc", 0), { text: "abc", page: 0, pages: 1, total: 3 });
  assert.equal(sliceLazyPage("a".repeat(LAZY_PAGE_CHARS * 2), 0, LAZY_PAGE_CHARS * 10).text.length, LAZY_PAGE_CHARS);
});

test("the detail URL addresses one block and page; parseLazyPage rejects other shapes", () => {
  const url = lazyDetailUrl({ sessionId: "s/1", entryId: "e 1", kind: "arg", blockIndex: 2, pointer: "/a~1b" }, 3);
  assert.equal(url, "/api/sessions/s%2F1/detail?entryId=e+1&kind=arg&blockIndex=2&page=3&limit=65536&pointer=%2Fa%7E1b");
  const page = { text: "t", page: 0, pages: 1, total: 1 };
  assert.deepEqual(parseLazyPage(page), page);
  for (const bad of [null, { thinking: "old" }, { ...page, pages: 0 }, { ...page, page: 1 }, { ...page, page: -1 }, { ...page, total: "1" }, { ...page, text: 1 }]) {
    assert.equal(parseLazyPage(bad), null, JSON.stringify(bad));
  }
});
