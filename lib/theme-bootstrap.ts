import { STORAGE_KEYS } from "./storage-keys";
import { DEFAULT_DARK_THEME_ID, DEFAULT_THEME_ID, THEMES } from "./theme-catalog";

/**
 * The inline script that applies a theme BEFORE first paint, so neither the
 * page nor the browser chrome flashes the wrong palette.
 *
 * It runs before React and before any module code, so it cannot import
 * resolveInitialThemeId — it restates the same precedence by hand, and
 * lib/theme-catalog.test.mjs evaluates this string against fakes to prove the
 * two never drift:
 *
 *   1. the signed-in account's saved theme, rendered into the page by the
 *      server (a choice made on the desktop reaches the phone);
 *   2. this browser's stored choice;
 *   3. the device's colour scheme, so a phone in dark mode never opens on a
 *      white page.
 *
 * A storage failure (private mode, a locked-down profile) must still land on
 * step 3 rather than leaving the page unthemed, so localStorage is read inside
 * its own try. When the account theme is used it is also written into storage,
 * which keeps the client-side theme store agreeing with the server.
 */
export function themeBootstrapScript(accountTheme: string | null): string {
  const themes = JSON.stringify(Object.fromEntries(THEMES.map(({ id, mode, preview }) => [id, { mode, background: preview.background }])));
  const key = JSON.stringify(STORAGE_KEYS.theme);
  const account = JSON.stringify(accountTheme);
  return [
    "(function(){",
    `var d=document,m=${themes},s=${account},t=null;`,
    // Step 1 needs no storage; step 2 does, and must not take step 3 down with it.
    `if(s&&m[s]){t=s}else{try{t=localStorage.getItem(${key})}catch(e){}}`,
    `if(!m[t]){t=(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?${JSON.stringify(DEFAULT_DARK_THEME_ID)}:${JSON.stringify(DEFAULT_THEME_ID)}}`,
    "try{",
    "d.documentElement.dataset.theme=t;",
    'd.documentElement.classList.toggle("dark",m[t].mode==="dark");',
    `d.querySelectorAll('meta[name="theme-color"]').forEach(function(e){e.setAttribute("content",m[t].background)});`,
    "}catch(e){}",
    `if(s&&m[s]){try{localStorage.setItem(${key},s)}catch(e){}}`,
    "})();",
  ].join("");
}
