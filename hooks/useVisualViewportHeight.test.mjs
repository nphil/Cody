import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { keyboardAwareHeight, KEYBOARD_MIN_INSET } = await jiti.import("./useVisualViewportHeight.ts");

test("a soft keyboard shrinks the app to what is actually visible", () => {
  // iPhone 14 Pro: 852px layout viewport, the keyboard covers ~336px.
  assert.equal(keyboardAwareHeight(516, 852), 516);
  assert.equal(keyboardAwareHeight(516.4, 852), 516, "CSS gets a whole pixel");
});

test("browser chrome moving is not a keyboard", () => {
  // Safari's toolbar collapsing on scroll, or a URL bar animating, changes
  // the visual viewport by tens of pixels; 100dvh already follows that, and
  // sizing to it here would make the app twitch on every scroll.
  assert.equal(keyboardAwareHeight(852, 852), null);
  assert.equal(keyboardAwareHeight(852 - KEYBOARD_MIN_INSET + 1, 852), null);
  assert.equal(keyboardAwareHeight(852 - KEYBOARD_MIN_INSET, 852), 852 - KEYBOARD_MIN_INSET);
});

test("a platform that resizes the layout viewport itself is left alone", () => {
  // Android Chrome shrinks innerHeight with the keyboard, so the two heights
  // agree and there is nothing for this to correct.
  assert.equal(keyboardAwareHeight(516, 516), null);
  assert.equal(keyboardAwareHeight(Number.NaN, 852), null);
});
