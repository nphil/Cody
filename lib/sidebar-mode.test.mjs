import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { INITIAL_SIDEBAR_MODE, sidebarModeReducer } = await jiti.import("./sidebar-mode.ts");

const run = (events, from = INITIAL_SIDEBAR_MODE) => events.reduce(sidebarModeReducer, from);

test("the Side Bar starts on New chat, exactly as it was before side questions moved in", () => {
  assert.deepEqual(INITIAL_SIDEBAR_MODE, { mode: "new", focusPending: false, handledToken: 0 });
});

test("flipping the switch is what chooses the view, and flipping to the same one changes nothing", () => {
  const onThisChat = run([{ type: "choose", mode: "session" }]);
  assert.equal(onThisChat.mode, "session");
  assert.equal(sidebarModeReducer(onThisChat, { type: "choose", mode: "session" }), onThisChat, "the very same state, so React skips the render");
  assert.equal(run([{ type: "choose", mode: "new" }], onThisChat).mode, "new");
});

test("a typed /btw opens This chat; a bare one also asks for the cursor", () => {
  assert.deepEqual(run([{ type: "request", token: 1, focus: false }]), { mode: "session", focusPending: false, handledToken: 1 });
  assert.deepEqual(run([{ type: "request", token: 1, focus: true }]), { mode: "session", focusPending: true, handledToken: 1 });
});

test("a request is taken once, however often it is seen again", () => {
  const taken = run([{ type: "request", token: 1, focus: true }, { type: "focused" }, { type: "choose", mode: "new" }]);
  const replayed = sidebarModeReducer(taken, { type: "request", token: 1, focus: true });
  assert.equal(replayed, taken, "the same request does not pull the person back to This chat or ask for the cursor again");
  assert.equal(sidebarModeReducer(taken, { type: "request", token: 0, focus: true }), taken, "an older one neither");
  assert.deepEqual(sidebarModeReducer(taken, { type: "request", token: 2, focus: false }), { mode: "session", focusPending: false, handledToken: 2 });
});

test("a cursor that has not landed yet survives the next request, and lands once", () => {
  const waiting = run([{ type: "request", token: 1, focus: true }, { type: "request", token: 2, focus: false }]);
  assert.equal(waiting.focusPending, true);
  const landed = sidebarModeReducer(waiting, { type: "focused" });
  assert.equal(landed.focusPending, false);
  assert.equal(sidebarModeReducer(landed, { type: "focused" }), landed);
});

test("when This chat goes away the choice and any waiting cursor go with it, but a taken request is not replayed", () => {
  const onThisChat = run([{ type: "request", token: 3, focus: true }]);
  const gone = sidebarModeReducer(onThisChat, { type: "gone" });
  assert.deepEqual(gone, { mode: "new", focusPending: false, handledToken: 3 });
  assert.equal(sidebarModeReducer(gone, { type: "gone" }), gone, "already on New chat: nothing to do");
  assert.equal(sidebarModeReducer(gone, { type: "request", token: 3, focus: true }), gone, "the old request stays taken");
});
