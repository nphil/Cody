import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_TERMINAL_SOFT_KEY_IDS,
  normalizeTerminalPaste,
  parseTerminalSoftKeyIds,
} = await jiti.import("./terminal-preferences.ts");

test("terminal paste normalizes line endings without adding bracketed-paste bytes", () => {
  const pasted = normalizeTerminalPaste("token-123\r\nsecond\nthird");
  assert.equal(pasted, "token-123\rsecond\rthird");
  assert.equal(pasted.includes("\x1b[200~"), false);
  assert.equal(pasted.includes("\x1b[201~"), false);
});

test("soft-key selection is validated, deduplicated, and returned in toolbar order", () => {
  assert.deepEqual(parseTerminalSoftKeyIds('["ctrl-c","tab","ctrl-c","unknown"]'), ["tab", "ctrl-c"]);
  assert.deepEqual(parseTerminalSoftKeyIds("[]"), []);
});

test("missing or malformed soft-key state uses the complete toolbar", () => {
  assert.deepEqual(parseTerminalSoftKeyIds(null), DEFAULT_TERMINAL_SOFT_KEY_IDS);
  assert.deepEqual(parseTerminalSoftKeyIds("not json"), DEFAULT_TERMINAL_SOFT_KEY_IDS);
  assert.deepEqual(parseTerminalSoftKeyIds('{"tab":true}'), DEFAULT_TERMINAL_SOFT_KEY_IDS);
});
