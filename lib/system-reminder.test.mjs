import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { foldSystemReminder } = await jiti.import("./system-reminder.ts");

const todoBody = [
  "<system-reminder>",
  "You stopped with 3 incomplete todo item(s):",
  "- Finish slices",
  "  - Monitor helpers",
  "- Hand to Nitin",
  "",
  "Please continue working on these tasks or mark them complete if finished.",
  "(Reminder 2/3)",
  "</system-reminder>",
].join("\n");

test("omp's todo reminder folds into a todo-reminder row with parsed details", () => {
  const row = foldSystemReminder({ content: [{ type: "text", text: todoBody }], timestamp: 5 });
  assert.equal(row.role, "custom");
  assert.equal(row.customType, "todo-reminder");
  assert.equal(row.timestamp, 5);
  assert.deepEqual(row.details, {
    count: 3,
    attempt: 2,
    max: 3,
    items: [
      { text: "Finish slices", depth: 0 },
      { text: "Monitor helpers", depth: 1 },
      { text: "Hand to Nitin", depth: 0 },
    ],
  });
});

test("another system-reminder becomes an engine note keeping its body", () => {
  const row = foldSystemReminder({ content: "<system-reminder>\nUse the edit tool for changes.\n</system-reminder>" });
  assert.equal(row.customType, "engine-note");
  assert.equal(row.content, "Use the edit tool for changes.");
  assert.equal(row.details, undefined);
});

test("a todo reminder without the attempt footer still parses", () => {
  const row = foldSystemReminder({ content: "<system-reminder>\nYou stopped with 1 incomplete todo item(s):\n- Only task\n\nPlease continue working on these tasks or mark them complete if finished.\n</system-reminder>" });
  assert.deepEqual(row.details, { count: 1, items: [{ text: "Only task", depth: 0 }] });
});

test("an ordinary developer instruction is left to the caller", () => {
  assert.equal(foldSystemReminder({ content: [{ type: "text", text: "Resume the user's latest intent." }] }), null);
  assert.equal(foldSystemReminder({ content: "Note: <system-reminder>x</system-reminder> inline mention" }), null);
});
