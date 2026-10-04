import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const presence = await jiti.import("./presence.ts");

const T0 = 1_000_000;

test("viewing is the same chat reported within the last 75 seconds", () => {
  presence.recordPresence("alice", "chat-a", T0);
  assert.equal(presence.isViewing("alice", "chat-a", T0), true);
  assert.equal(presence.isViewing("alice", "chat-a", T0 + 75_000), true, "75 s ago still counts");
  assert.equal(presence.isViewing("alice", "chat-a", T0 + 75_001), false, "76 s ago does not");
});

test("only the chat on screen is viewed, and only by the person looking", () => {
  presence.recordPresence("alice", "chat-a", T0);
  assert.equal(presence.isViewing("alice", "chat-b", T0), false);
  assert.equal(presence.isViewing("bob", "chat-a", T0), false);
});

test("a newer report replaces the older one: moving to another chat stops suppressing the first", () => {
  presence.recordPresence("alice", "chat-a", T0);
  presence.recordPresence("alice", "chat-b", T0 + 1_000);
  assert.equal(presence.isViewing("alice", "chat-a", T0 + 1_000), false);
  assert.equal(presence.isViewing("alice", "chat-b", T0 + 1_000), true);
});

test("null means looking at nothing (tab hidden or closed) and ends suppression at once", () => {
  presence.recordPresence("alice", "chat-a", T0);
  presence.recordPresence("alice", null, T0 + 1_000);
  assert.equal(presence.isViewing("alice", "chat-a", T0 + 1_000), false);
});

test("a heartbeat keeps the window open; silence closes it", () => {
  presence.recordPresence("alice", "chat-a", T0);
  presence.recordPresence("alice", "chat-a", T0 + 30_000);
  presence.recordPresence("alice", "chat-a", T0 + 60_000);
  assert.equal(presence.isViewing("alice", "chat-a", T0 + 130_000), true, "75 s after the last heartbeat");
  assert.equal(presence.isViewing("alice", "chat-a", T0 + 136_000), false);
});

test("the map holds one entry per person and drops stale ones as it goes", () => {
  presence.recordPresence("carol", "chat-c", T0);
  presence.recordPresence("dave", "chat-d", T0 + 200_000);
  const map = globalThis.__codyNotificationPresence;
  assert.equal(map.has("carol"), false, "carol's report was more than 75 s old when dave's arrived");
  assert.equal(map.has("dave"), true);
  for (let index = 0; index < 50; index += 1) presence.recordPresence("dave", `chat-${index}`, T0 + 200_000 + index);
  assert.equal([...map.keys()].filter((key) => key === "dave").length, 1);
});
