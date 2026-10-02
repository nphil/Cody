import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const {
  MAX_WINDOW_MESSAGES,
  appendPage,
  hasEarlier,
  pageFromResponse,
  prependPage,
  reachesEnd,
  renderableRows,
  toolResultsById,
  trimWindow,
  windowFromPage,
  windowMessageCount,
  windowMessages,
} = await jiti.import("./subagent-transcript.ts");

/** A server page of `count` assistant messages, one per 100-byte line. */
function page(fromByte, count, extra = {}) {
  const messages = Array.from({ length: count }, (_, i) => ({ role: "assistant", content: [{ type: "text", text: `m${fromByte + i * 100}` }] }));
  return {
    sessionFile: "x.jsonl",
    fromByte,
    nextByte: fromByte + count * 100,
    reset: false,
    messages,
    offsets: messages.map((_, i) => fromByte + i * 100),
    totalBytes: 100_000,
    endByte: 100_000,
    hasEarlier: fromByte > 0,
    ...extra,
  };
}

test("rows are keyed by their line's byte offset, so a prepended page never renames existing rows", () => {
  const tail = windowFromPage(page(1000, 3));
  const before = windowMessages(tail).map((row) => row.key);
  assert.deepEqual(before, ["1000", "1100", "1200"]);

  const grown = prependPage(tail, page(700, 3));
  assert.ok(grown);
  assert.deepEqual(windowMessages(grown).map((row) => row.key), ["700", "800", "900", "1000", "1100", "1200"]);
  // The rows that were already there are the very same objects.
  assert.equal(windowMessages(grown)[3], windowMessages(tail)[0]);
});

test("a source without offsets still gets stable, collision-free keys", () => {
  const rpc = page(0, 2, { offsets: undefined, endByte: undefined });
  const next = page(200, 2, { offsets: undefined, endByte: undefined });
  const win = appendPage(windowFromPage(rpc), next);
  assert.ok(win);
  assert.deepEqual(windowMessages(win).map((row) => row.key), ["0:0", "0:1", "200:0", "200:1"]);
  assert.equal(win.endByte, null);
});

test("tool calls are normalized like the main transcript's, whichever source sent them", () => {
  const raw = { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }] };
  const [row] = pageFromResponse({ sessionFile: "x", fromByte: 0, nextByte: 10, reset: false, messages: [raw] }).rows;
  assert.deepEqual(row.message.content[0], { type: "toolCall", toolCallId: "call_1", toolName: "read", input: { path: "a.ts" } });
});

test("a page that is not adjacent to the window is refused rather than merged", () => {
  const win = windowFromPage(page(1000, 3));
  // Earlier page that ends somewhere else, or a forward page that skips ahead.
  assert.equal(prependPage(win, page(500, 3)), null);
  assert.equal(appendPage(win, page(1400, 2)), null);
  assert.ok(prependPage(win, page(700, 3)));
  assert.ok(appendPage(win, page(1300, 2)));
});

test("a refresh that found nothing keeps the window itself, so nothing re-renders", () => {
  const win = windowFromPage(page(0, 2));
  const empty = page(200, 0);
  assert.equal(appendPage(win, empty), win);
  // …but the file's new end is still learned.
  const learned = appendPage(win, { ...empty, endByte: 250 });
  assert.notEqual(learned, win);
  assert.equal(learned.endByte, 250);
  assert.equal(learned.pages, win.pages);
  // Nothing earlier exists: prepending an empty page is a no-op as well.
  const first = windowFromPage(page(0, 2));
  assert.equal(prependPage(first, page(0, 0)), first);
});

test("earlier content and the live end are tracked from the page edges", () => {
  const win = windowFromPage(page(1000, 3, { endByte: 1300 }));
  assert.equal(hasEarlier(win), true);
  assert.equal(reachesEnd(win), true);
  const grown = appendPage(win, page(1300, 0, { endByte: 1500 }));
  assert.equal(reachesEnd(grown), false, "the file grew past what the window holds");
  assert.equal(hasEarlier(windowFromPage(page(0, 3))), false);
  assert.equal(reachesEnd(windowFromPage(page(0, 3, { endByte: undefined }))), true);
});

function windowOfPages(sizes) {
  let from = 0;
  let win = null;
  for (const size of sizes) {
    const p = page(from, size);
    win = win === null ? windowFromPage(p) : appendPage(win, p);
    from = p.nextByte;
  }
  return win;
}

test("a window over the cap drops the page farthest from the reader and keeps the rest contiguous", () => {
  const win = windowOfPages([150, 150, 150, 150]); // 600 messages, pages at 0 / 15000 / 30000 / 45000
  const trimmedAtEnd = trimWindow(win, "45000"); // reader at the newest page → the oldest go
  assert.deepEqual(trimmedAtEnd.pages.map((p) => p.fromByte), [30000, 45000]);

  const trimmedAtStart = trimWindow(win, "0"); // reader at the oldest page → the newest go
  assert.deepEqual(trimmedAtStart.pages.map((p) => p.fromByte), [0, 15000]);

  const trimmedMid = trimWindow(win, "15100"); // reader on the second page: newest goes, then the tie drops the older side
  assert.deepEqual(trimmedMid.pages.map((p) => p.fromByte), [15000, 30000]);

  for (const result of [trimmedAtEnd, trimmedAtStart]) {
    for (let i = 1; i < result.pages.length; i++) assert.equal(result.pages[i].fromByte, result.pages[i - 1].nextByte);
    assert.ok(windowMessageCount(result) <= MAX_WINDOW_MESSAGES);
  }
});

test("trimming never removes the page the reader is on, however many pages must go", () => {
  const win = windowOfPages([150, 150, 150, 150, 150, 150]); // 900 messages
  const readerKey = String(2 * 15000 + 100); // in the third page
  const trimmed = trimWindow(win, readerKey, 300);
  assert.ok(windowMessages(trimmed).some((row) => row.key === readerKey));
  assert.ok(windowMessageCount(trimmed) <= 300);
  // With the reader mid-window, both ends are fair game and the result stays one run of pages.
  for (let i = 1; i < trimmed.pages.length; i++) assert.equal(trimmed.pages[i].fromByte, trimmed.pages[i - 1].nextByte);
});

test("a reader's page survives even when it alone exceeds the cap; an unknown reader means the newest end", () => {
  const win = windowOfPages([450, 100]);
  const trimmed = trimWindow(win, "100", 400); // reader in the 450-message page
  assert.deepEqual(trimmed.pages.map((p) => p.fromByte), [0]);
  const lost = trimWindow(win, "not-a-row", 400); // reader unknown → treated as the newest end
  assert.deepEqual(lost.pages.map((p) => p.fromByte), [45000]);
});

test("a window within the cap is returned untouched", () => {
  const win = windowOfPages([100, 100, 100]);
  assert.equal(trimWindow(win, "0"), win);
});

test("tool results pair with their calls across pages and are not rows of their own", () => {
  const call = { role: "assistant", content: [{ type: "toolCall", toolCallId: "call_9", toolName: "bash", input: {} }] };
  const result = { role: "toolResult", toolCallId: "call_9", content: [{ type: "text", text: "ok" }] };
  const older = windowFromPage({ sessionFile: "x", fromByte: 0, nextByte: 100, reset: false, messages: [call], offsets: [0] });
  const both = appendPage(older, { sessionFile: "x", fromByte: 100, nextByte: 200, reset: false, messages: [result], offsets: [100] });

  const rows = windowMessages(both);
  assert.equal(toolResultsById(rows).get("call_9"), rows[1].message);
  assert.deepEqual(renderableRows(rows).map((row) => row.key), ["0"]);
  assert.equal(toolResultsById(windowMessages(older)).size, 0, "the result is simply not here yet");
});
