import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createSideQuestionsBridge } = await jiti.import("./useSideQuestionsBridge.ts");

/** The bridge never looks inside what it carries, so a tagged object stands in for a chat's side questions. */
const state = (name) => ({ name });

function watch(bridge) {
  const seen = [];
  const stop = bridge.subscribe(() => seen.push(bridge.getSnapshot()));
  return { seen, stop };
}

test("holds nothing until a chat publishes", () => {
  assert.equal(createSideQuestionsBridge().getSnapshot(), null);
});

test("a publish reaches every subscriber, and an identical republish is silent", () => {
  const bridge = createSideQuestionsBridge();
  const first = watch(bridge);
  const second = watch(bridge);
  const value = state("a");

  bridge.publish("chat-a", value);
  bridge.publish("chat-a", value);

  assert.deepEqual(first.seen, [value]);
  assert.deepEqual(second.seen, [value]);
  assert.equal(bridge.getSnapshot(), value, "the snapshot keeps one identity between changes");
});

test("a chat that publishes again replaces its own state", () => {
  const bridge = createSideQuestionsBridge();
  const { seen } = watch(bridge);
  const before = state("before");
  const after = state("after");

  bridge.publish("chat-a", before);
  bridge.publish("chat-a", after);

  assert.deepEqual(seen, [before, after]);
  assert.equal(bridge.getSnapshot(), after);
});

test("the chat that was replaced cannot withdraw the new chat's state, whichever order they finish in", () => {
  const bridge = createSideQuestionsBridge();
  const next = state("b");
  bridge.publish("chat-a", state("a"));
  bridge.publish("chat-b", next);
  const { seen } = watch(bridge);

  bridge.release("chat-a");
  assert.equal(bridge.getSnapshot(), next);
  assert.deepEqual(seen, [], "a release that is not the publisher's changes nothing and tells nobody");

  bridge.release("chat-b");
  assert.equal(bridge.getSnapshot(), null);
  assert.deepEqual(seen, [null]);
});

test("a release with nothing published is silent", () => {
  const bridge = createSideQuestionsBridge();
  const { seen } = watch(bridge);
  bridge.release("chat-a");
  assert.deepEqual(seen, []);
});

test("an unsubscribed listener hears nothing more, and one that leaves while being told does not hide the change from the rest", () => {
  const bridge = createSideQuestionsBridge();
  const quiet = watch(bridge);
  quiet.stop();
  const heard = [];
  const stopSelf = bridge.subscribe(() => { heard.push("leaver"); stopSelf(); });
  const stayer = watch(bridge);

  bridge.publish("chat-a", state("a"));
  bridge.publish("chat-a", state("b"));

  assert.deepEqual(quiet.seen, []);
  assert.deepEqual(heard, ["leaver"]);
  assert.equal(stayer.seen.length, 2);
});
