import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createSettingsHistory, SETTINGS_HISTORY_MARK } = await jiti.import("./useSettingsHistory.ts");

/**
 * The phone Settings stack's history contract: one entry per level, one
 * level per back gesture, refused pops re-pushed, the × button unwinding
 * everything, and entries from before this open never counted as ours.
 *
 * The fake history queues `go()` like Chromium does — the target entry is
 * fixed when `go` is called, the traversal and its popstate land in a later
 * task — so a test can observe the order the shell relies on: state first,
 * popstate afterwards, and a push issued meanwhile lands beside the entry
 * being left.
 */
function fakeHistory(initialState = null) {
  const entries = [{ state: initialState }];
  let index = 0;
  const pending = [];
  const listeners = [];
  const gos = [];
  return {
    entries,
    gos,
    get index() { return index; },
    get state() { return entries[index].state; },
    pushState(data) {
      entries.splice(index + 1);
      entries.push({ state: data });
      index += 1;
    },
    /** Chromium resolves the TARGET now and traverses later. */
    go(delta) {
      gos.push(delta);
      pending.push(Math.max(0, Math.min(entries.length - 1, index + delta)));
    },
    onPopState(listener) { listeners.push(listener); },
    /** Deliver every queued traversal, as the browser would in later tasks. */
    flush() {
      while (pending.length > 0) {
        index = Math.min(entries.length - 1, pending.shift());
        for (const listener of listeners) listener({ state: entries[index].state });
      }
    },
    /** A user gesture: back one entry (or several from the long-press list). */
    back(count = 1) {
      index = Math.max(0, index - count);
      for (const listener of listeners) listener({ state: entries[index].state });
    },
    forward() {
      index = Math.min(entries.length - 1, index + 1);
      for (const listener of listeners) listener({ state: entries[index].state });
    },
  };
}

/** A shell stand-in: `depth` is what the UI shows; `onPop` lowers it unless the level is busy. */
function harness(history, { busy = () => false, token = "t" } = {}) {
  const ui = { depth: 0, pops: 0, syncs: 0 };
  const controller = createSettingsHistory({
    history,
    token,
    onPop: () => {
      ui.pops += 1;
      if (!busy()) ui.depth = Math.max(0, ui.depth - 1);
    },
    requestSync: () => {
      ui.syncs += 1;
      controller.sync(ui.depth);
    },
  });
  history.onPopState((event) => controller.handlePopState(event));
  const show = (depth) => { ui.depth = depth; controller.sync(depth); };
  return { ui, controller, show };
}

test("opening pushes one entry and every drill-in pushes exactly one more", () => {
  const history = fakeHistory({ __NA: true });
  const { show, controller } = harness(history);
  show(1);
  assert.equal(history.entries.length, 2);
  assert.deepEqual(history.state, { cody: SETTINGS_HISTORY_MARK, depth: 1, token: "t" });
  show(2);
  show(3);
  assert.equal(history.entries.length, 4);
  assert.equal(history.state.depth, 3);
  assert.equal(controller.depth, 3);
  show(3);
  assert.equal(history.entries.length, 4, "a sync at the same depth pushes nothing");
  assert.deepEqual(history.gos, [], "and goes nowhere");
});

test("a back gesture pops exactly one level: panel → root → closed", () => {
  const history = fakeHistory(null);
  const { ui, show } = harness(history);
  show(2);
  history.back();
  assert.equal(ui.pops, 1);
  assert.equal(ui.depth, 1, "the panel gave way to the root list");
  assert.equal(history.index, 1);
  assert.deepEqual(history.gos, [], "the history already matches; nothing to unwind");
  history.back();
  assert.equal(ui.pops, 2);
  assert.equal(ui.depth, 0, "a back from the root closes");
  assert.equal(history.index, 0);
  assert.deepEqual(history.gos, []);
});

test("a multi-entry jump still pops one level, then the stack is rebuilt to match the UI", () => {
  const history = fakeHistory(null);
  const { ui, show } = harness(history);
  show(3);
  history.back(2);
  assert.equal(ui.pops, 1, "one gesture, one level, however far the browser jumped");
  assert.equal(ui.depth, 2);
  assert.equal(history.state.depth, 2, "the missing entry was pushed back so × still unwinds the right count");
  assert.equal(history.entries.length, 3);
});

test("the Back and Close buttons unwind through go() and their own popstate is not a second pop", () => {
  const history = fakeHistory(null);
  const { ui, show, controller } = harness(history);
  show(3);
  show(2);
  assert.deepEqual(history.gos, [-1]);
  history.flush();
  assert.equal(ui.pops, 0, "the popstate the controller caused is swallowed");
  assert.equal(history.state.depth, 2);
  show(1);
  history.flush();
  assert.equal(ui.pops, 0);
  controller.dispose();
  assert.deepEqual(history.gos, [-1, -1, -1], "× goes back over the whole remaining stack in one call");
  history.flush();
  assert.equal(history.index, 0);
  assert.equal(ui.pops, 0, "nothing listens after dispose");
  controller.dispose();
  assert.deepEqual(history.gos, [-1, -1, -1], "a second dispose is a no-op");
});

test("a busy level refuses the pop and the entry is pushed back so the next gesture asks again", () => {
  const history = fakeHistory(null);
  let busy = true;
  const { ui, show } = harness(history, { busy: () => busy });
  show(2);
  history.back();
  assert.equal(ui.pops, 1, "the UI was asked");
  assert.equal(ui.depth, 2, "and kept the level (the leave dialog is showing)");
  assert.equal(history.state.depth, 2, "Cancel: the entry is back on the stack");
  assert.equal(history.entries.length, 3);
  // Confirm: the UI lowers the depth itself; the history follows through go().
  busy = false;
  show(1);
  assert.deepEqual(history.gos, [-1]);
  history.flush();
  assert.equal(ui.pops, 1, "the go() popstate is not another gesture");
  assert.equal(history.state.depth, 1);
});

test("entries present at load and foreign states are not ours: they sit below the stack", () => {
  // A reload while Settings was open leaves the old state on the entry.
  const stale = { cody: SETTINGS_HISTORY_MARK, depth: 3, token: "previous-open" };
  const history = fakeHistory(stale);
  const { ui, show, controller } = harness(history);
  assert.equal(controller.depth, 0, "the stale entry is not counted");
  show(1);
  assert.equal(history.entries.length, 2, "the root pushed a fresh entry over it");
  history.back();
  assert.equal(ui.pops, 1);
  assert.equal(ui.depth, 0, "landing on the stale entry is a back past the root: close");
  assert.deepEqual(history.gos, [], "nothing is unwound after a gesture-driven close");
});

test("a forward navigation onto the stack's top is ignored", () => {
  const history = fakeHistory(null);
  const { ui, show } = harness(history);
  show(2);
  history.back();
  assert.equal(ui.depth, 1);
  history.forward();
  assert.equal(ui.pops, 1, "landing on an entry at or above the stack's top is not a back gesture");
  assert.equal(ui.depth, 1);
});

test("the Escape key mirrors a back gesture through the same sync path", () => {
  // The shell handles Escape by lowering its depth; the controller must
  // treat that exactly like a Back button (go, swallow the popstate).
  const history = fakeHistory(null);
  const { ui, show } = harness(history);
  show(3);
  show(2);
  history.flush();
  assert.equal(ui.pops, 0);
  assert.equal(history.state.depth, 2);
  assert.equal(history.entries.length, 4, "the forward entry is left to the browser");
});

test("a push asked for while a traversal is in flight waits for it, so it never lands beside the entry being left", () => {
  // Back from a hub, then a tap on another row before the traversal landed.
  const history = fakeHistory(null);
  const { ui, show } = harness(history);
  show(2);
  show(1);
  assert.deepEqual(history.gos, [-1], "the traversal is queued");
  show(2);
  assert.equal(history.entries.length, 3, "nothing pushed yet: the traversal has not landed");
  history.flush();
  assert.equal(ui.pops, 0, "the controller's own popstate is swallowed");
  assert.equal(history.entries.length, 3, "the deferred push replaced the forward entry");
  assert.equal(history.state.depth, 2, "and the stack is back at the UI's depth");
  assert.equal(history.index, 2);
  history.back();
  assert.equal(ui.pops, 1);
  assert.equal(ui.depth, 1, "a real gesture still pops one level");
});
