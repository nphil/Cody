import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { REPIN_DISTANCE_PX, distanceFromBottom, pinnedAfterScroll } = await jiti.import("./transcript-scroll.ts");

const base = { pinned: true, top: 1000, prevTop: 1000, expectedTop: null, distance: 0, driven: false };

test("the follower's own scroll writes decide nothing, whatever the geometry says", () => {
  // Our write landed on the position we recorded: no unpin even though the
  // content has since grown and the distance reads far from the bottom.
  assert.equal(pinnedAfterScroll({ ...base, top: 900, prevTop: 1000, expectedTop: 900, distance: 500 }), true);
  assert.equal(pinnedAfterScroll({ ...base, pinned: false, top: 900, prevTop: 1000, expectedTop: 900, distance: 0 }), false);
});

test("any scroll up by the reader unpins immediately, even one pixel from the bottom", () => {
  assert.equal(pinnedAfterScroll({ ...base, top: 995, prevTop: 1000, distance: 5, driven: true }), false);
});

test("the browser clamping the position because content shrank does not drop a follower", () => {
  // A tool card collapsed at the tail: scrollTop falls with no input from the
  // reader, and the viewport still ends at the bottom.
  assert.equal(pinnedAfterScroll({ ...base, top: 940, prevTop: 1000, distance: 3, driven: false }), true);
  // Momentum carrying the reader up (the intent window long over) ends far from the bottom: unpinned.
  assert.equal(pinnedAfterScroll({ ...base, top: 400, prevTop: 700, distance: 600, driven: false }), false);
});

test("returning near the bottom pins again; scrolling down while still far away does not", () => {
  assert.equal(pinnedAfterScroll({ ...base, pinned: false, top: 960, prevTop: 900, distance: REPIN_DISTANCE_PX }), true);
  assert.equal(pinnedAfterScroll({ ...base, pinned: false, top: 960, prevTop: 900, distance: REPIN_DISTANCE_PX + 1 }), false);
  assert.equal(pinnedAfterScroll({ ...base, pinned: false, top: 500, prevTop: 450, distance: 700, driven: true }), false);
});

test("distance from the bottom is measured from the visible bottom edge", () => {
  assert.equal(distanceFromBottom({ scrollHeight: 2000, scrollTop: 1200, clientHeight: 700 }), 100);
  assert.equal(distanceFromBottom({ scrollHeight: 700, scrollTop: 0, clientHeight: 700 }), 0);
});
