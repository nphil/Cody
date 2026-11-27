import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MessageView } = await jiti.import("./MessageView.tsx");
const { fetchLazyPage } = await jiti.import("./LazyDetailText.tsx");
const { LAZY_BLOCK_MIN_CHARS, LAZY_PREVIEW_CHARS, projectLazyBlocks } = await jiti.import("@/lib/lazy-blocks");

const HEAD = "HEAD-MARK-";
const TAIL = "-TAIL-MARK";
const big = (fill) => HEAD + fill.repeat(LAZY_BLOCK_MIN_CHARS * 2) + TAIL;

/** What the history route sends: one oldest-first walk with the pairing state of the session reader. */
function projectWalk(messages) {
  const calls = new Set();
  return messages.map((message, index) => projectLazyBlocks(message, `e${index}`, calls));
}

const call = (toolCallId, toolName, input) => ({ type: "toolCall", toolCallId, toolName, input });
const result = (toolCallId, text, extra = {}) => ({ role: "toolResult", toolCallId, toolName: "x", content: [{ type: "text", text }], ...extra });

function render(message, results, props = {}) {
  const toolResults = new Map(results.map((r) => [r.toolCallId, r]));
  return renderToStaticMarkup(React.createElement(MessageView, { message, toolResults, sessionId: "s1", entryId: "e0", activityDisplayMode: "full", ...props }));
}

test("an open card holds only the previews and offers the full text on request", () => {
  const [assistant, toolResult] = projectWalk([
    { role: "assistant", content: [call("c1", "write", { path: "/f", content: big("w") })] },
    result("c1", big("o")),
  ]);
  const html = render(assistant, [toolResult]);
  assert.match(html, /HEAD-MARK-/);
  assert.doesNotMatch(html, new RegExp(TAIL), "the tail of the oversized text is not in the page");
  assert.doesNotMatch(html, /w{2000}/);
  assert.doesNotMatch(html, /o{2000}/);
  assert.match(html, /Show full text \(\d[\d,]* characters\)/, "the result stub says how long the original is");
  assert.match(html, /Show full content \(\d[\d,]* characters\)/, "the argument stub names its field");
  assert.ok(html.length < LAZY_PREVIEW_CHARS * 40, `markup is ${html.length} chars`);
  assert.doesNotMatch(html, /data-testid="lazy-detail"/, "nothing is fetched or mounted until the reader asks");
});

test("a real bash call (a script) gets the same controls on its output", () => {
  const [assistant, toolResult] = projectWalk([
    { role: "assistant", content: [call("b1", "bash", { command: "set -e\nfor f in *; do cat \"$f\"; done" })] },
    result("b1", big("b"), { toolName: "bash", isError: true }),
  ]);
  const html = render(assistant, [toolResult], { activityDisplayMode: "compact" });
  assert.match(html, /Show full text \(\d[\d,]* characters\)/, "a failed call opens itself, its output is a stub with a control");
  assert.doesNotMatch(html, new RegExp(TAIL));
});

test("a simple bash command's output is a stub with a control; a tool command's output stays whole", () => {
  const [assistant, toolResult] = projectWalk([
    { role: "assistant", content: [call("s1", "bash", { command: "cat big.log" })] },
    result("s1", big("s"), { toolName: "bash" }),
  ]);
  const html = render(assistant, [toolResult]);
  assert.match(html, /Show full text \(\d[\d,]* characters\)/);
  assert.doesNotMatch(html, new RegExp(TAIL));

  const details = { toolCommands: [{ tool: "open_url", mode: "json", exitCode: 0 }] };
  const [commandCall, commandResult] = projectWalk([
    { role: "assistant", content: [call("t1", "bash", { command: `open_url -j '${JSON.stringify({ url: "https://example.com" })}'` })] },
    result("t1", big("z"), { toolName: "bash", details }),
  ]);
  assert.equal(commandResult.content[0].text, big("z"), "arrives whole for the tool-command card");
  assert.doesNotMatch(render(commandCall, [commandResult]), /Show full/);
});

test("a result with no call on the branch is not stubbed and renders as before (nothing standalone)", () => {
  const [orphan] = projectWalk([result("nobody", big("q"))]);
  assert.equal(orphan.content[0].text, big("q"));
  assert.equal(orphan.content[0].lazyChars, undefined);
  assert.equal(renderToStaticMarkup(React.createElement(MessageView, { message: orphan, sessionId: "s1", entryId: "e0" })), "");
});

test("a stub without a session to ask says the text is unavailable instead of offering a dead button", () => {
  const [assistant, toolResult] = projectWalk([
    { role: "assistant", content: [call("c1", "write", { path: "/f", content: big("w") })] },
    result("c1", big("o")),
  ]);
  const html = render(assistant, [toolResult], { sessionId: undefined });
  assert.match(html, /unavailable until the chat is reloaded/);
  assert.doesNotMatch(html, /Show full text/);
});

test("a collapsed card renders neither the previews nor any detail", () => {
  const [assistant, toolResult] = projectWalk([
    { role: "assistant", content: [call("c1", "write", { path: "/f", content: big("w") })] },
    result("c1", big("o")),
  ]);
  const html = render(assistant, [toolResult], { activityDisplayMode: "compact" });
  assert.doesNotMatch(html, /HEAD-MARK-/);
  assert.doesNotMatch(html, /lazy-/);
});

test("oversized thinking mounts its paged viewer only while the box is open", () => {
  const [message] = projectWalk([{ role: "assistant", content: [{ type: "thinking", thinking: big("t") }] }]);
  const closed = render(message, [], { thinkingDefaultExpanded: false });
  assert.doesNotMatch(closed, /lazy-detail/);
  assert.doesNotMatch(closed, /t{200}/);
  const open = render(message, [], { thinkingDefaultExpanded: true });
  assert.match(open, /data-testid="lazy-detail"/);
  assert.match(open, /Loading…/);
  assert.doesNotMatch(open, /t{200}/);
});

test("fetchLazyPage asks the detail route for one page, with no cache, and rejects bad answers", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  const answer = (init) => async (url, options) => {
    seen.push({ url, options });
    return init;
  };
  try {
    const ref = { sessionId: "s1", entryId: "e1", kind: "result", blockIndex: 0 };
    const page = { text: "abc", page: 2, pages: 9, total: 9 * 3 };
    globalThis.fetch = answer({ ok: true, json: async () => page });
    assert.deepEqual(await fetchLazyPage(ref, 2), page);
    assert.equal(seen[0].url, "/api/sessions/s1/detail?entryId=e1&kind=result&blockIndex=0&page=2&limit=65536");
    assert.equal(seen[0].options.cache, "no-store");

    globalThis.fetch = answer({ ok: false, status: 404, json: async () => ({}) });
    await assert.rejects(fetchLazyPage(ref, 0), /HTTP 404/);
    globalThis.fetch = answer({ ok: true, json: async () => ({ thinking: "old shape" }) });
    await assert.rejects(fetchLazyPage(ref, 0));
  } finally {
    globalThis.fetch = realFetch;
  }
});
