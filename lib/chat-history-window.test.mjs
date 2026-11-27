import assert from "node:assert/strict";
import test from "node:test";

const subject = await import("./chat-history-window.ts");
const {
  appendPage,
  emptyWindow,
  enforceWindow,
  estimateMessageBytes,
  idAt,
  isDetached,
  mergeTail,
  prependPage,
  windowFromContext,
} = subject;

const msg = (text) => ({ role: "user", content: text, timestamp: 1 });
const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `e${from + i}`);
const msgs = (from, to) => ids(from, to).map((id) => msg(id));

/** A server page of branch entries e<from>..e<to> out of `total`. */
function page(from, to, total) {
  return {
    messages: msgs(from, to),
    entryIds: ids(from, to),
    olderCursor: from > 1 ? `e${from}` : null,
    newerCursor: to < total ? `e${to}` : null,
    totalMessages: total,
    olderCount: from - 1,
  };
}

const roles = (window) => window.entryIds.join(",");

test("a tail page is attached and addressable by entry id", () => {
  const window = windowFromContext(page(91, 100, 100), 1);
  assert.equal(isDetached(window), false);
  assert.equal(window.meta.olderCursor, "e91");
  assert.equal(window.meta.persisted, 10);
  assert.equal(idAt(window, 0), "e91");
  assert.equal(idAt(window, 10), undefined);
});

test("a legacy full response has no cursors and no total", () => {
  const window = windowFromContext({ messages: msgs(1, 3), entryIds: ids(1, 3) }, 0);
  assert.equal(window.meta.olderCursor, null);
  assert.equal(window.meta.totalMessages, null);
  assert.equal(isDetached(window), false);
});

test("prepending an older page keeps order, moves the cursor and shifts the reader", () => {
  const tail = windowFromContext(page(91, 100, 100), 1);
  const next = prependPage(tail, page(81, 90, 100), "e91");
  assert.notEqual(typeof next, "string");
  assert.equal(roles(next), ids(81, 100).join(","));
  assert.equal(next.messages.length, 20);
  assert.equal(next.meta.olderCursor, "e81");
  assert.equal(next.meta.shift, 10);
  assert.equal(next.meta.persisted, 20);
});

test("an older page that no longer matches the cursor is stale, not applied", () => {
  const tail = windowFromContext(page(91, 100, 100), 1);
  assert.equal(prependPage(tail, page(81, 90, 100), "e85"), "stale");
});

test("overlapping page entries are dropped by id, never duplicated", () => {
  const tail = windowFromContext(page(91, 100, 100), 1);
  const next = prependPage(tail, page(86, 92, 100), "e91");
  assert.equal(roles(next), ids(86, 100).join(","));
  assert.equal(next.meta.shift, 5);
  // A page that adds nothing new cannot make progress and is refused.
  assert.equal(prependPage(tail, page(95, 99, 100), "e91"), "invalid");
});

test("the oldest page clears the older cursor", () => {
  const tail = windowFromContext(page(3, 5, 5), 1);
  const next = prependPage(tail, page(1, 2, 5), "e3");
  assert.equal(next.meta.olderCursor, null);
});

test("loading newer pages walks a detached window back to live", () => {
  let window = windowFromContext(page(11, 20, 40), 1);
  assert.equal(isDetached(window), true);
  window = appendPage(window, page(21, 30, 40), "e20");
  assert.equal(window.meta.newerCursor, "e30");
  window = appendPage(window, page(31, 40, 40), "e30");
  assert.equal(window.meta.newerCursor, null);
  assert.equal(isDetached(window), false);
  assert.equal(roles(window), ids(11, 40).join(","));
  assert.equal(appendPage(window, page(31, 40, 40), "e30"), "stale");
});

test("a detached window drops live-only messages and says live is ahead", () => {
  const window = windowFromContext(page(11, 20, 40), 1);
  const withLive = { ...window, messages: [...window.messages, msg("live")] };
  const next = enforceWindow(withLive, null);
  assert.equal(next.messages.length, 10);
  assert.equal(next.meta.liveAhead, true);
});

test("an attached window keeps live-only messages", () => {
  const window = windowFromContext(page(91, 100, 100), 1);
  const next = enforceWindow({ ...window, messages: [...window.messages, msg("live")] }, null);
  assert.equal(next.messages.length, 11);
  assert.equal(next.meta.liveAhead, false);
});

test("following readers lose the head over the cap and can load it back", () => {
  const window = windowFromContext(page(1, 40, 40), 1);
  const next = enforceWindow(window, null, { maxMessages: 20, maxBytes: 1e9 });
  assert.equal(next.messages.length, 15);
  assert.equal(next.entryIds[0], "e26");
  assert.equal(next.meta.olderCursor, "e26");
  assert.equal(next.meta.shift, -25);
  assert.equal(next.meta.newerCursor, null);
  assert.equal(next.entryIds.length, next.meta.persisted);
});

test("trimming never cuts the reader's own message and detaches when it cuts the tail", () => {
  const window = windowFromContext(page(1, 40, 40), 1);
  const next = enforceWindow(window, 5, { maxMessages: 20, maxBytes: 1e9 });
  assert.ok(next.entryIds.includes("e6"));
  // The reader's margin is kept, so the window cannot shrink to the target.
  assert.equal(next.messages.length, 18);
  // The reader is near the head, so the far (newest) end is what goes.
  assert.equal(next.entryIds[0], "e1");
  assert.equal(next.meta.olderCursor, null);
  assert.equal(next.meta.newerCursor, "e18");
  assert.equal(isDetached(next), true);
  assert.equal(next.meta.persisted, 18);
});

test("a tail is never cut through live-only messages", () => {
  const base = windowFromContext(page(1, 30, 30), 1);
  const window = { ...base, messages: [...base.messages, msg("live-a"), msg("live-b")] };
  const next = enforceWindow(window, 3, { maxMessages: 20, maxBytes: 1e9 });
  // Cutting the tail would need an identity for the new last message; the head
  // is the reader's near side, so the window cannot shrink past the margin.
  assert.ok(next.messages.includes(window.messages[3]));
  if (isDetached(next)) assert.equal(next.messages.length, next.meta.persisted);
  assert.equal(next.messages.filter((m) => m.content.startsWith("live")).length === 2 || isDetached(next), true);
});

test("the byte budget trims even under the message cap, counting stubs by preview only", () => {
  const big = (id) => ({ role: "assistant", content: [{ type: "text", text: "x".repeat(10_000), id }], timestamp: 1 });
  const stub = { role: "assistant", content: [{ type: "text", text: "preview", lazyChars: 50_000_000 }], timestamp: 1 };
  assert.ok(estimateMessageBytes(stub) < 200);
  const window = windowFromContext({ messages: Array.from({ length: 10 }, (_, i) => big(i)), entryIds: ids(1, 10), totalMessages: 10, olderCount: 0 }, 1);
  const next = enforceWindow(window, null, { maxMessages: 100, maxBytes: 50_000 });
  assert.ok(next.messages.length < 10);
  assert.equal(next.meta.olderCursor, next.entryIds[0]);
});

test("a held window the reader is reading joins an overlapping tail", () => {
  let held = windowFromContext(page(81, 120, 120), 1);
  held = prependPage(held, page(61, 80, 120), "e81");
  const tail = windowFromContext(page(101, 120, 120), 2);
  const { window, outcome } = mergeTail(held, tail, true);
  assert.equal(outcome, "merged");
  assert.equal(roles(window), ids(61, 120).join(","));
  assert.equal(window.meta.olderCursor, "e61");
  assert.equal(isDetached(window), false);
  assert.equal(window.meta.persisted, 60);
});

test("a following reader simply takes the fresh tail", () => {
  const held = windowFromContext(page(61, 100, 120), 1);
  const tail = windowFromContext(page(91, 120, 120), 2);
  const { window, outcome } = mergeTail(held, tail, false);
  assert.equal(outcome, "replaced");
  assert.equal(window, tail);
});

test("a tail that moved past the held range detaches the reader instead of tearing a gap", () => {
  const held = windowFromContext(page(1, 20, 20), 1);
  const tail = windowFromContext(page(101, 120, 120), 2);
  const { window, outcome } = mergeTail(held, tail, true);
  assert.equal(outcome, "detached");
  assert.equal(window.messages.length, 20);
  assert.equal(window.meta.newerCursor, "e20");
  assert.equal(window.meta.liveAhead, true);
  assert.equal(window.meta.totalMessages, 120);
});

test("a tail that covers the whole held range replaces it", () => {
  const held = windowFromContext(page(95, 100, 100), 1);
  const tail = windowFromContext(page(21, 100, 100), 2);
  assert.equal(mergeTail(held, tail, true).outcome, "replaced");
});

test("engine sessions page by absolute index with no entry ids", () => {
  const engine = (from, to, total) => ({
    messages: msgs(from, to),
    entryIds: [],
    olderCursor: from > 0 ? `m:${from}` : null,
    newerCursor: to < total - 1 ? `m:${to}` : null,
    totalMessages: total,
    olderCount: from,
  });
  const tail = windowFromContext(engine(50, 59, 60), 1);
  assert.equal(tail.meta.engineStart, 50);
  assert.equal(idAt(tail, 0), "m:50");
  const older = prependPage(tail, engine(40, 49, 60), "m:50");
  assert.equal(older.messages.length, 20);
  assert.equal(older.meta.engineStart, 40);
  assert.equal(older.meta.olderCursor, "m:40");
  // A page from somewhere else does not line up.
  assert.equal(prependPage(tail, engine(30, 39, 60), "m:50"), "invalid");
  // Trimming the head points the cursor at the new oldest index.
  const trimmed = enforceWindow(older, null, { maxMessages: 8, maxBytes: 1e9 });
  assert.equal(trimmed.meta.engineStart, 40 + (20 - trimmed.messages.length));
  assert.equal(trimmed.meta.olderCursor, `m:${trimmed.meta.engineStart}`);
});

test("an empty window is attached and holds nothing", () => {
  const window = emptyWindow(3);
  assert.equal(isDetached(window), false);
  assert.equal(enforceWindow(window, null), window);
});

test("live-only backlog pressure counts messages or bytes, not only message count", () => {
  const { liveOnlyUnderPressure, LIVE_ONLY_MAX_MESSAGES, LIVE_ONLY_MAX_BYTES } = subject;
  const persisted = msgs(1, 10);
  // Persisted messages never count, however many or large.
  assert.equal(liveOnlyUnderPressure(persisted, persisted.length), false);
  const small = Array.from({ length: LIVE_ONLY_MAX_MESSAGES }, () => msg("x"));
  assert.equal(liveOnlyUnderPressure([...persisted, ...small], persisted.length), false);
  assert.equal(liveOnlyUnderPressure([...persisted, ...small, msg("x")], persisted.length), true);
  // A few huge outputs are enough on their own.
  const huge = { role: "user", content: "y".repeat(LIVE_ONLY_MAX_BYTES / 2 + 1), timestamp: 1 };
  assert.equal(liveOnlyUnderPressure([...persisted, huge], persisted.length), false);
  assert.equal(liveOnlyUnderPressure([...persisted, huge, { ...huge }], persisted.length), true);
});
