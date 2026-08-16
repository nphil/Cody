import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_THEME_ID,
  THEMES,
  getAlternateTheme,
  getTheme,
  isThemeId,
} = await jiti.import("../lib/theme-catalog.ts");

test("ships twenty balanced light and dark themes", () => {
  assert.equal(THEMES.length, 20);
  assert.equal(THEMES.filter((theme) => theme.mode === "light").length, 10);
  assert.equal(THEMES.filter((theme) => theme.mode === "dark").length, 10);
  assert.equal(new Set(THEMES.map((theme) => theme.id)).size, THEMES.length);
});

test("pairs each theme with its same-family opposite mode", () => {
  for (const theme of THEMES) {
    const alternate = getAlternateTheme(theme.id);
    assert.equal(alternate.family, theme.family);
    assert.notEqual(alternate.mode, theme.mode);
  }
});

test("validates stored ids and falls back to Cody's default", () => {
  assert.equal(isThemeId("sky-dark"), true);
  assert.equal(isThemeId("system"), false);
  assert.equal(getTheme("missing-theme").id, DEFAULT_THEME_ID);
});
