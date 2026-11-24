import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { CHAT_LIST_LIMIT, isChatSort, rankChats } = await jiti.import("./usage-chats.ts");

const chat = (id, bytes, modifiedMs) => ({ id, title: id, bytes, modifiedMs, cwd: "/p" });
const rows = [chat("mid", 50, 200), chat("big", 900, 300), chat("old", 10, 100), chat("tie-new", 50, 400)];

test("chats rank biggest first, or longest untouched first, with ties in a stable order", () => {
  assert.deepEqual(rankChats(rows, "size").map((row) => row.id), ["big", "mid", "tie-new", "old"]);
  assert.deepEqual(rankChats(rows, "oldest").map((row) => row.id), ["old", "mid", "big", "tie-new"]);
});

test("the list is capped and the input is not reordered", () => {
  const many = Array.from({ length: 100 }, (_, index) => chat(`c${index}`, index, index));
  assert.equal(rankChats(many, "size").length, CHAT_LIST_LIMIT);
  assert.equal(rankChats(many, "size", 3).length, 3);
  assert.equal(many[0].id, "c0");
  assert.equal(isChatSort("size") && isChatSort("oldest"), true);
  assert.equal(isChatSort("name"), false);
});
