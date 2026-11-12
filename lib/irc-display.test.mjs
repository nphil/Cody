import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ircSender, ircTags, parentIrcAsCustomMessage, readParentIrc } = await jiti.import("./irc-display.ts");

test("a parent steer shows its plain text, not the model-facing wrapper", () => {
  const message = {
    role: "user",
    content: '<irc from="parent" agent="Fixer">\nPlease stop\n</irc>',
    parentIrc: { from: "main", body: "Please stop" },
    timestamp: 5,
  };
  assert.deepEqual(readParentIrc(message), { from: "main", body: "Please stop" });
  const card = parentIrcAsCustomMessage(message);
  assert.equal(card.customType, "irc:incoming");
  assert.equal(card.content, "Please stop");
  assert.equal(card.display, true);
  assert.equal(card.timestamp, 5);
  assert.deepEqual(card.details, { from: "main", message: "Please stop", fromParent: true, plainBody: true });
});

test("a user message from an older engine, or with a malformed field, stays an ordinary message", () => {
  assert.equal(parentIrcAsCustomMessage({ role: "user", content: "hi" }), null);
  assert.equal(parentIrcAsCustomMessage({ role: "user", content: "hi", parentIrc: { from: "x" } }), null);
  assert.equal(parentIrcAsCustomMessage({ role: "user", content: "hi", parentIrc: "x" }), null);
});

test("tags follow the engine's flags and are empty for older engines", () => {
  assert.deepEqual(ircTags({ id: "1", from: "a", message: "m" }), []);
  assert.deepEqual(ircTags(undefined), []);
  assert.deepEqual(ircTags({ progress: true, broadcast: true, replyTo: "abc" }), ["progress", "broadcast", "reply"]);
  assert.deepEqual(ircTags({ progress: false, replyTo: "" }), []);
});

test("sender comes from the details only when present", () => {
  assert.equal(ircSender({ from: "Auditor" }), "Auditor");
  assert.equal(ircSender({ from: "" }), null);
  assert.equal(ircSender(null), null);
});
