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
  assert.equal(isThemeId("solarized-dark"), true);
  assert.equal(isThemeId("system"), false);
  assert.equal(getTheme("missing-theme").id, DEFAULT_THEME_ID);
});

test("degrades pre-catalog ids to the default instead of throwing", () => {
  // Ids stored by an earlier catalog ("canvas-light", "sky-dark", ...) are no
  // longer served; both the hook and the layout bootstrap must fall through to
  // DEFAULT_THEME_ID rather than leave the document unthemed.
  for (const retired of ["canvas-light", "paper-dark", "copper-light"]) {
    assert.equal(isThemeId(retired), false);
    assert.equal(getTheme(retired).id, DEFAULT_THEME_ID);
  }
});

test("every id carries a light/dark family pair the mode toggle can reach", () => {
  const families = new Set(THEMES.map((theme) => theme.family));
  assert.equal(families.size, 10);
  for (const family of families) {
    const pair = THEMES.filter((theme) => theme.family === family);
    assert.equal(pair.length, 2);
    // The picker labels a family once, so both modes must share the name.
    assert.equal(pair[0].name, pair[1].name);
  }
});
