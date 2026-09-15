import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./chat-attachments.ts");
}

function textFile(name, type = "") {
  return { name, type };
}

test("recognizes text and markdown attachments by mime or extension", async () => {
  const { isTextAttachmentFile } = await loadSubject();

  assert.equal(isTextAttachmentFile(textFile("notes.txt", "text/plain")), true);
  assert.equal(isTextAttachmentFile(textFile("README.md", "text/markdown")), true);
  assert.equal(isTextAttachmentFile(textFile("README.MD")), true);
  assert.equal(isTextAttachmentFile(textFile("doc.markdown")), true);
  assert.equal(isTextAttachmentFile(textFile("page.mdx")), true);
  assert.equal(isTextAttachmentFile(textFile("data.json", "application/json")), true);
  assert.equal(isTextAttachmentFile(textFile("image.png", "image/png")), false);
  assert.equal(isTextAttachmentFile(textFile("noextension")), false);
});

test("composes message with attachment blocks and escapes triple backticks", async () => {
  const { composeMessageWithTextAttachments } = await loadSubject();

  assert.equal(composeMessageWithTextAttachments("hello", []), "hello");

  const result = composeMessageWithTextAttachments("  ", [
    { name: "notes.txt", mimeType: "text/plain", content: "line one", size: 8 },
  ]);
  assert.equal(
    result,
    "Attached file: notes.txt\n```text\nline one\n```",
  );

  // Content containing ``` must not break the code fence — the fence grows.
  const backticks = composeMessageWithTextAttachments("", [
    { name: "README.md", mimeType: "text/markdown", content: "```js\ncode\n```", size: 15 },
  ]);
  assert.equal(
    backticks,
    "Attached file: README.md\n````markdown\n```js\ncode\n```\n````",
  );
});

test("keeps message text above attachment blocks", async () => {
  const { composeMessageWithTextAttachments } = await loadSubject();

  const result = composeMessageWithTextAttachments("Review this", [
    { name: "a.md", mimeType: "text/markdown", content: "A", size: 1 },
    { name: "b.txt", mimeType: "text/plain", content: "B", size: 1 },
  ]);

  assert.ok(result.startsWith("Review this\n\nAttached file: a.md"));
  assert.ok(result.includes("Attached file: b.md") === false);
  assert.ok(result.includes("Attached file: b.txt"));
});

test("selects attachments under Cody's per-file, aggregate, and slot budgets", async () => {
  const {
    selectTextAttachments,
    MAX_ATTACHED_TEXT_BYTES,
    MAX_TOTAL_ATTACHED_TEXT_BYTES,
  } = await loadSubject();
  const file = (name, size) => ({ name, size });

  assert.equal(MAX_ATTACHED_TEXT_BYTES, 256 * 1024);
  assert.equal(MAX_TOTAL_ATTACHED_TEXT_BYTES, 768 * 1024);

  const accepted = selectTextAttachments(
    [file("a.txt", 256 * 1024), file("b.txt", 256 * 1024), file("c.txt", 256 * 1024)],
    { usedBytes: 0, usedSlots: 0 },
  );
  assert.deepEqual(accepted.accepted.map((candidate) => candidate.name), ["a.txt", "b.txt", "c.txt"]);
  assert.equal(accepted.tooLarge, 0);
  assert.equal(accepted.overBudget, 0);

  const perFile = selectTextAttachments([file("too-big.txt", MAX_ATTACHED_TEXT_BYTES + 1)], { usedBytes: 0, usedSlots: 0 });
  assert.deepEqual(perFile.accepted, []);
  assert.equal(perFile.tooLarge, 1);
  assert.equal(perFile.overBudget, 0);

  const aggregate = selectTextAttachments(
    [file("fits.txt", 256 * 1024), file("over.txt", 256 * 1024)],
    { usedBytes: 512 * 1024, usedSlots: 2 },
  );
  assert.deepEqual(aggregate.accepted.map((candidate) => candidate.name), ["fits.txt"]);
  assert.equal(aggregate.tooLarge, 0);
  assert.equal(aggregate.overBudget, 1);

  const slots = selectTextAttachments([file("a.txt", 1), file("b.txt", 1)], { usedBytes: 0, usedSlots: 9 });
  assert.deepEqual(slots.accepted.map((candidate) => candidate.name), ["a.txt"]);
  assert.equal(slots.tooLarge, 0);
  assert.equal(slots.overBudget, 0);
});

test("reports the text-attachment limit that caused a batch to be skipped", async () => {
  const { describeTextAttachmentSkip, formatAttachmentBytes } = await loadSubject();

  assert.equal(formatAttachmentBytes(256 * 1024), "256 KB");
  assert.equal(formatAttachmentBytes(768 * 1024), "768 KB");
  assert.equal(describeTextAttachmentSkip({ tooLarge: 0, overBudget: 0 }), null);
  assert.equal(
    describeTextAttachmentSkip({ tooLarge: 2, overBudget: 1 }),
    "2 file(s) skipped: files up to 256 KB are supported.",
  );
  assert.equal(
    describeTextAttachmentSkip({ tooLarge: 0, overBudget: 3 }),
    "3 file(s) skipped: attachments are limited to 768 KB per message.",
  );
});
