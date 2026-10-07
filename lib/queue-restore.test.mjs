import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { inSendOrder, matchRestoredQueue, parseQueueRestore } = await jiti.import("./queue-restore.ts");

/** A ledger row as the wrapper hands it over: `text` is trimmed, `submittedText` is what omp was sent. */
const row = (clientMessageId, behavior, submittedText, extra = {}) => ({
  clientMessageId,
  behavior,
  text: submittedText.trim(),
  imageCount: 0,
  acceptedAt: 1,
  submittedText,
  ...extra,
});
const restore = (steering, followUp = []) => ({ steering, followUp, imagesDropped: false, truncated: false });
const entry = (text, images = []) => ({ text, images });
const pairs = (messages) => messages.map((message) => [message.text, message.clientMessageId]);

test("a returned message is paired with the row it was sent as: the exact text, the trimmed text, or the stand-in for a message of only pictures", () => {
  const { messages, unclaimed } = matchRestoredQueue(
    restore([entry("  padded  "), entry("tidy"), entry("[Image]", [{ type: "image", data: "x", mimeType: "image/webp" }])]),
    [row("exact", "steer", "  padded  "), row("trimmed", "steer", "tidy "), row("pictures", "steer", "", { imageCount: 1 })],
  );
  assert.deepEqual(pairs(messages), [["  padded  ", "exact"], ["tidy", "trimmed"], ["[Image]", "pictures"]]);
  assert.deepEqual(unclaimed, []);
});

test("the same words sent more than once pair up queue by queue, oldest first, each row only once", () => {
  const { messages, unclaimed } = matchRestoredQueue(
    restore([entry("go"), entry("go")], [entry("go")]),
    [row("steer-1", "steer", "go", { acceptedAt: 1 }), row("later", "follow_up", "go", { acceptedAt: 2 }), row("steer-2", "steer", "go", { acceptedAt: 3 })],
  );
  assert.deepEqual(pairs(messages), [["go", "steer-1"], ["go", "steer-2"], ["go", "later"]]);
  assert.deepEqual(unclaimed, []);
});

test("a follow-up omp promoted to a steer is still found, and a message no row accounts for still comes back", () => {
  const { messages, unclaimed } = matchRestoredQueue(
    restore([entry("promoted"), entry("sent from somewhere else")]),
    [row("was-follow-up", "follow_up", "promoted"), row("nothing-returned", "steer", "never handed back")],
  );
  assert.deepEqual(pairs(messages), [["promoted", "was-follow-up"], ["sent from somewhere else", undefined]]);
  assert.deepEqual(unclaimed.map((left) => left.clientMessageId), ["nothing-returned"], "the caller settles the row omp did not return");
});

test("what comes back is omp's own text and pictures, whatever the row says", () => {
  const picture = { type: "image", data: "webp-bytes", mimeType: "image/webp" };
  const { messages } = matchRestoredQueue(restore([entry("[Image]", [picture])]), [row("p", "steer", "", { imageCount: 1 })]);
  assert.deepEqual(messages[0], { clientMessageId: "p", acceptedAt: 1, text: "[Image]", images: [picture] });
});

test("an answer that is missing or malformed reads as nothing returned, and only a message with text and well-formed pictures counts", () => {
  const nothing = { steering: [], followUp: [], imagesDropped: false, truncated: false };
  assert.deepEqual(parseQueueRestore(undefined), nothing);
  assert.deepEqual(parseQueueRestore({ steering: "no", followUp: null }), nothing);
  const parsed = parseQueueRestore({
    steering: [{ text: "ok", images: [{ type: "image", data: "a", mimeType: "image/png" }, { data: 1 }, "junk"] }, { images: [] }, 7],
    followUp: [{ text: "later" }],
    imagesDropped: true,
    truncated: "yes",
  });
  assert.deepEqual(parsed.steering, [{ text: "ok", images: [{ type: "image", data: "a", mimeType: "image/png" }] }]);
  assert.deepEqual(parsed.followUp, [{ text: "later", images: [] }]);
  assert.equal(parsed.imagesDropped, true);
  assert.equal(parsed.truncated, false, "a flag counts only when it is exactly true");
});

test("messages from several queues are merged oldest send first, and one no row dates keeps its place behind the one before it", () => {
  const msg = (text, acceptedAt) => ({ text, images: [], ...(acceptedAt === undefined ? {} : { acceptedAt }) });
  const ordered = inSendOrder([
    [msg("steer a", 10), msg("unknown, after steer a"), msg("steer c", 30)],
    [msg("held b", 20), msg("held d", 40)],
  ]);
  assert.deepEqual(ordered.map((message) => message.text), ["steer a", "unknown, after steer a", "held b", "steer c", "held d"]);
  assert.deepEqual(inSendOrder([[msg("undated first"), msg("dated", 5)]]).map((message) => message.text), ["undated first", "dated"]);
});
