import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DEFAULT_DARK_THEME_ID, DEFAULT_THEME_ID, resolveInitialThemeId } = await jiti.import("./theme-catalog.ts");
const { themeBootstrapScript } = await jiti.import("./theme-bootstrap.ts");
const { STORAGE_KEYS } = await jiti.import("./storage-keys.ts");

test("an explicit choice always wins; otherwise the device's colour scheme decides", () => {
  assert.equal(resolveInitialThemeId("nord-dark", false), "nord-dark");
  assert.equal(resolveInitialThemeId("nord-light", true), "nord-light");
  assert.equal(resolveInitialThemeId(null, true), DEFAULT_DARK_THEME_ID);
  assert.equal(resolveInitialThemeId(null, false), DEFAULT_THEME_ID);
  // An id from a theme that no longer exists is not a choice.
  assert.equal(resolveInitialThemeId("solarized-sepia", true), DEFAULT_DARK_THEME_ID);
});

/**
 * Run the inline bootstrap the way a browser would, against fakes, and report
 * what it applied. The script is plain JS that reaches for `document`,
 * `window` and `localStorage` as globals; naming them as parameters is how
 * those globals are supplied.
 */
function boot({ accountTheme = null, stored = null, prefersDark = false, storageThrows = false } = {}) {
  const applied = { theme: null, dark: null, metaColor: null, written: null };
  const documentFake = {
    documentElement: {
      dataset: {},
      classList: { toggle: (name, on) => { if (name === "dark") applied.dark = on; } },
    },
    querySelectorAll: () => [{ setAttribute: (_, value) => { applied.metaColor = value; } }],
  };
  const storageFake = {
    getItem: () => { if (storageThrows) throw new Error("storage disabled"); return stored; },
    setItem: (_, value) => { if (storageThrows) throw new Error("storage disabled"); applied.written = value; },
  };
  const windowFake = { matchMedia: () => ({ matches: prefersDark }) };
  new Function("document", "window", "localStorage", themeBootstrapScript(accountTheme))(documentFake, windowFake, storageFake);
  applied.theme = documentFake.documentElement.dataset.theme;
  return applied;
}

test("the bootstrap applies the same precedence as resolveInitialThemeId", () => {
  // The browser's stored choice, when there is no account theme.
  assert.equal(boot({ stored: "gruvbox-dark" }).theme, "gruvbox-dark");
  // Nothing stored: the device decides — this is the phone-in-dark-mode case
  // that used to open on a white page.
  assert.equal(boot({ prefersDark: true }).theme, DEFAULT_DARK_THEME_ID);
  assert.equal(boot({ prefersDark: false }).theme, DEFAULT_THEME_ID);
  // An unknown stored id is not a choice either.
  assert.equal(boot({ stored: "no-such-theme", prefersDark: true }).theme, DEFAULT_DARK_THEME_ID);
  // And every path agrees with the TypeScript resolver.
  for (const [stored, prefersDark] of [["nord-light", true], [null, true], [null, false], ["bogus", false]]) {
    assert.equal(boot({ stored, prefersDark }).theme, resolveInitialThemeId(stored, prefersDark));
  }
});

test("the account's saved theme beats this browser's, and is copied into storage", () => {
  // A theme picked on the desktop reaching the phone is the whole point.
  const applied = boot({ accountTheme: "rosepine-dark", stored: "catppuccin-light" });
  assert.equal(applied.theme, "rosepine-dark");
  assert.equal(applied.dark, true);
  assert.equal(applied.written, "rosepine-dark", "the client store must agree with the server afterwards");
  // A saved id the catalog no longer knows is ignored, not applied.
  assert.equal(boot({ accountTheme: "retired-theme", stored: "nord-light" }).theme, "nord-light");
});

test("the bootstrap still themes the page when storage itself throws", () => {
  // Private browsing and locked-down profiles throw on localStorage access.
  // Before, one throw skipped the whole script and left the page unthemed.
  const applied = boot({ storageThrows: true, prefersDark: true });
  assert.equal(applied.theme, DEFAULT_DARK_THEME_ID);
  assert.equal(applied.dark, true);
  assert.ok(applied.metaColor, "the browser chrome colour is still set");
});

test("the storage key the bootstrap reads is the one the client store writes", () => {
  assert.ok(themeBootstrapScript(null).includes(JSON.stringify(STORAGE_KEYS.theme)));
});
