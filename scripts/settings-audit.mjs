#!/usr/bin/env node
/**
 * Browser audit of the Settings dialog on a running Cody instance, at a
 * desktop and a phone viewport (spec §15). Playwright drives a Chromium.
 *
 * usage:
 *   node scripts/settings-audit.mjs --base http://127.0.0.1:30182 --cookie <cody_session value> \
 *        [--engine omp] [--out /tmp/settings-audit] [--playwright <dir>] [--chromium <path>]
 *
 *   --base       the instance's origin (no trailing slash).
 *   --cookie     a signed-in `cody_session` cookie value (POST /api/accounts/login
 *                or /signup returns one in Set-Cookie).
 *   --engine     select this engine first (POST /api/engines/select); without
 *                it the instance's active engine is audited as it is.
 *   --out        directory for screenshots and report.json (default ./settings-audit).
 *   --playwright a directory holding node_modules/playwright-core, or the
 *                package directory itself, when the repo has no playwright-core
 *                (it is not a dependency; $PLAYWRIGHT_CORE works too).
 *   --chromium   Chromium executable; default: the newest
 *                $PLAYWRIGHT_BROWSERS_PATH (or /opt/pw-browsers)/chromium-*\/chrome-linux/chrome.
 *
 * What it asserts, per viewport (1440x900; 390x844 with hasTouch + isMobile):
 *   - Settings opens; the rail rows and their ids are recorded (registry order)
 *   - every hub and every sub-view (`settings-subtab-*`) opens and is screenshotted
 *   - no element is wider than the viewport on any screen
 *   - phone: every focusable text input/select/textarea has a computed font-size
 *     of at least 16px (iOS zoom); every button target is at least 44x44
 *     (switches are 36x20 by design inside a full-card label and are exempt);
 *     the root rows are at least 52px; "‹ Settings" and × are 44x44
 *   - phone: a synthetic popstate (history.back()) pops exactly one level
 *     (hub → root list, root → closed); Escape does the same
 *   - never a second top-level [role=dialog] while a level is pushed
 *   - search: the results are one role=listbox, ArrowDown/Enter open a result
 *     with its highlight, Escape restores the rail
 *   - no console errors, page errors, or 5xx responses while it runs
 *
 * Prints a JSON summary (also written to <out>/report.json) and exits 1 on any
 * failed assertion, 2 on a setup problem.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => {
  if (arg.startsWith("--")) pairs.push([arg.slice(2), all[index + 1]?.startsWith("--") || all[index + 1] === undefined ? "true" : all[index + 1]]);
  return pairs;
}, []));

const BASE = (args.base ?? "").replace(/\/$/, "");
const COOKIE = args.cookie;
const ENGINE = args.engine;
const OUT = path.resolve(args.out ?? "settings-audit");
if (!BASE || !COOKIE) {
  console.error("usage: node scripts/settings-audit.mjs --base <url> --cookie <value> [--engine <id>] [--out <dir>]");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

/* ---------- Playwright + Chromium resolution ---------- */

async function loadPlaywright() {
  const candidates = [];
  const hint = args.playwright ?? process.env.PLAYWRIGHT_CORE;
  if (hint) {
    candidates.push(path.join(hint, "node_modules", "playwright-core", "index.mjs"));
    candidates.push(path.join(hint, "index.mjs"));
  }
  const require = createRequire(import.meta.url);
  try {
    candidates.push(path.join(path.dirname(require.resolve("playwright-core/package.json")), "index.mjs"));
  } catch {
    // not a dependency of this repo; the hint above must supply it
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  console.error(`playwright-core not found (tried ${candidates.join(", ") || "nothing"}); pass --playwright <dir>`);
  process.exit(2);
}

function findChromium() {
  if (args.chromium) return args.chromium;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!fs.existsSync(root)) return undefined;
  const builds = fs.readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const build of builds) {
    const executable = path.join(root, build, "chrome-linux", "chrome");
    if (fs.existsSync(executable)) return executable;
  }
  return undefined;
}

/* ---------- HTTP helpers ---------- */

const H = { Cookie: `cody_session=${COOKIE}`, "Content-Type": "application/json" };
const parse = async (response) => {
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: text.slice(0, 300) }; }
};
const get = (route) => fetch(`${BASE}${route}`, { headers: H }).then(parse);
const post = (route, body) => fetch(`${BASE}${route}`, { method: "POST", headers: H, body: JSON.stringify(body ?? {}) }).then(parse);

/* ---------- report ---------- */

const report = { base: BASE, engine: null, capabilities: null, problems: [], notes: [], desktop: {}, phone: {}, screenshots: [] };
const fail = (message) => { report.problems.push(message); console.error(`FAIL ${message}`); };
const note = (message) => { report.notes.push(message); };
let shot = 0;
async function screenshot(page, label) {
  const file = path.join(OUT, `${String(++shot).padStart(2, "0")}-${label}.png`);
  await page.screenshot({ path: file }).catch((error) => note(`screenshot ${label}: ${error.message.slice(0, 80)}`));
  report.screenshots.push(file);
  return file;
}

/* ---------- in-page probes ---------- */

/** Elements of the Settings dialog wider than the viewport. Scoped to the
 * dialog: the app behind it keeps off-screen panels laid out on purpose. */
const WIDER_THAN_VIEWPORT = () => {
  const limit = window.innerWidth + 1;
  const offenders = [];
  const shell = document.querySelector(".settings-shell");
  const root = shell?.closest('[role="dialog"]') ?? shell;
  if (!root) return offenders;
  for (const element of root.querySelectorAll("*")) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.width > limit || rect.right > limit + 4) {
      const id = element.id ? `#${element.id}` : "";
      const cls = element.className && typeof element.className === "string" ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
      offenders.push(`${element.tagName.toLowerCase()}${id}${cls} ${Math.round(rect.width)}px (right ${Math.round(rect.right)})`);
      if (offenders.length >= 5) break;
    }
  }
  return offenders;
};

/** Phone targets: every visible button inside the settings shell must be at
 * least 44x44, except switches (36x20 inside a full-card label by design). */
const SMALL_TARGETS = () => {
  const shell = document.querySelector(".settings-shell");
  if (!shell) return [];
  const offenders = [];
  for (const button of shell.querySelectorAll('button, [role="button"], [role="option"], a[href]')) {
    if (button.getAttribute("role") === "switch") continue;
    const rect = button.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    // Off-screen (scrolled) rows are still laid out; measure them anyway.
    if (rect.width < 44 || rect.height < 44) {
      const label = button.getAttribute("aria-label") ?? button.textContent?.trim().slice(0, 30) ?? "";
      const host = button.closest("[data-settings-host]")?.getAttribute("data-settings-host") ?? "shell";
      offenders.push(`${host}: "${label}" ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }
  }
  return offenders;
};

/** Phone inputs: computed font-size under 16px zooms iOS Safari on focus. */
const SMALL_INPUTS = () => {
  const shell = document.querySelector(".settings-shell");
  if (!shell) return [];
  const offenders = [];
  for (const field of shell.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, textarea')) {
    const rect = field.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const size = parseFloat(getComputedStyle(field).fontSize);
    if (size < 16) {
      const label = field.getAttribute("aria-label") ?? field.getAttribute("placeholder") ?? field.id ?? field.tagName.toLowerCase();
      const host = field.closest("[data-settings-host]")?.getAttribute("data-settings-host") ?? "shell";
      offenders.push(`${host}: "${label}" ${size}px`);
    }
  }
  return offenders;
};

/** Top-level dialogs: base-ui portals every Dialog to <body>, so a nested
 * one shows up as a second popup with no dialog ancestor. */
const TOP_LEVEL_DIALOGS = () => [...document.querySelectorAll('[role="dialog"]')].filter((element) => !element.parentElement?.closest('[role="dialog"]')).length;

const SETTINGS_OPEN = () => Boolean(document.querySelector(".settings-shell"));

/* ---------- main ---------- */

const { chromium } = await loadPlaywright();
const executablePath = findChromium();
if (!executablePath) note("no bundled Chromium found; using Playwright's default");

await post("/api/engines/setup-complete").catch(() => {});
const info = await get("/api/info");
if (info.status !== 200) {
  console.error(`GET /api/info answered ${info.status}: is the cookie valid?`, info.body);
  process.exit(2);
}
if (ENGINE && info.body?.engine?.id !== ENGINE) {
  const selected = await post("/api/engines/select", { id: ENGINE });
  if (selected.status !== 200) note(`engine select ${ENGINE} answered ${selected.status}: auditing ${info.body?.engine?.id ?? "the active engine"} instead`);
  else await new Promise((resolve) => setTimeout(resolve, 1500));
}
const active = await get("/api/info");
report.engine = active.body?.engine ?? null;
report.capabilities = active.body?.capabilities ?? null;

const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });

async function openPage(context, label) {
  const page = await context.newPage();
  // A 404 from an optional route (a hub whose route the engine lacks) is
  // by design: the rail renders nothing for it. Everything else is a failure.
  page.on("console", (message) => { if (message.type() === "error" && !/favicon|hot-update|fonts\.g|status of 404/.test(message.text())) fail(`[${label} console] ${message.text().slice(0, 200)}`); });
  page.on("pageerror", (error) => fail(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  page.on("response", (response) => { if (response.status() >= 500) fail(`[${label} http ${response.status()}] ${response.url().slice(-80)}`); });
  // `load`, not `networkidle`: the app polls its workspace tree, so the
  // network never idles. A dev server also full-reloads the page once its
  // first compile lands, which destroys the execution context under any
  // probe in flight; settle until three seconds pass without a navigation.
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 }).catch((error) => note(`${label}: goto: ${error.message.slice(0, 80)}`));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let navigated = false;
    const onNavigate = (frame) => { if (frame === page.mainFrame()) navigated = true; };
    page.on("framenavigated", onNavigate);
    await page.waitForTimeout(3000);
    page.off("framenavigated", onNavigate);
    if (!navigated) break;
  }
  await page.waitForSelector('button[aria-label="Settings"]', { timeout: 30000 }).catch(() => fail(`${label}: no Settings button after load`));
  const skip = page.getByRole("button", { name: /skip setup/i });
  if (await skip.count().catch(() => 0) > 0) { await skip.first().click().catch(() => {}); await page.waitForTimeout(500); note(`${label}: setup wizard skipped`); }
  return page;
}

async function openSettings(page, label) {
  const button = page.locator('button[aria-label="Settings"]').first();
  await button.click({ timeout: 15000 });
  // The first open on a dev server compiles the shell and its hubs.
  await page.waitForSelector(".settings-shell", { timeout: 60000 });
  await page.waitForTimeout(1200);
  if (!(await page.evaluate(SETTINGS_OPEN))) fail(`${label}: Settings did not open`);
}

async function checkScreen(page, label, { phone }) {
  const wide = await page.evaluate(WIDER_THAN_VIEWPORT);
  if (wide.length > 0) fail(`${label}: wider than the viewport: ${wide.join(" | ")}`);
  const dialogs = await page.evaluate(TOP_LEVEL_DIALOGS);
  if (dialogs !== 1) fail(`${label}: ${dialogs} top-level dialogs (expected the Settings dialog alone)`);
  if (phone) {
    const inputs = await page.evaluate(SMALL_INPUTS);
    if (inputs.length > 0) fail(`${label}: inputs under 16px: ${inputs.join(" | ")}`);
    const targets = await page.evaluate(SMALL_TARGETS);
    if (targets.length > 0) fail(`${label}: targets under 44px: ${targets.slice(0, 8).join(" | ")}${targets.length > 8 ? ` (+${targets.length - 8})` : ""}`);
  }
}

const box = async (locator) => { const b = await locator.boundingBox().catch(() => null); return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null; };

/* ---------- desktop ---------- */
async function auditDesktop() {
  const label = "desktop";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await context.addCookies([{ name: "cody_session", value: COOKIE, url: BASE }]);
  const page = await openPage(context, label);
  const D = report.desktop;
  D.historyLengthBefore = await page.evaluate(() => history.length);
  await openSettings(page, label);
  D.historyLengthAfterOpen = await page.evaluate(() => history.length);
  if (D.historyLengthAfterOpen !== D.historyLengthBefore) fail(`${label}: opening Settings pushed history (${D.historyLengthBefore} → ${D.historyLengthAfterOpen}); the desktop pushes nothing`);
  D.rows = await page.locator('.settings-rail [role="tab"][id^="settings-tab-"]').evaluateAll((elements) => elements.map((element) => ({
    id: element.id.replace("settings-tab-", ""),
    label: element.querySelector("div > div")?.textContent?.trim() ?? "",
    status: element.querySelector("div > div:nth-child(2)")?.textContent?.trim() ?? null,
  })));
  D.eyebrows = await page.locator('.settings-rail > div > div[aria-hidden="true"]').evaluateAll((elements) => elements.map((element) => element.textContent.trim()));
  await screenshot(page, "desktop-open");
  await checkScreen(page, `${label} open`, { phone: false });
  D.panels = {};
  for (const row of D.rows) {
    await page.locator(`#settings-tab-${row.id}`).click({ timeout: 10000 }).catch((error) => fail(`${label}: click ${row.id}: ${error.message.slice(0, 80)}`));
    // A hub's module loads on first open (and compiles, on a dev server):
    // wait for its tabpanel, then let its routes answer.
    await page.locator(`#settings-panel-${row.id}`).waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(row.id === "system" || row.id === "providers" || row.id === "models" ? 3000 : 1200);
    const selected = await page.locator(`#settings-tab-${row.id}`).getAttribute("aria-selected");
    const tabpanel = await page.locator(`#settings-panel-${row.id}`).count();
    const subtabs = await page.locator(`[data-settings-host="${row.id}"] [id^="settings-subtab-"]`).evaluateAll((elements) => elements.map((element) => element.id.replace("settings-subtab-", "")));
    D.panels[row.id] = { selected, tabpanel, subtabs };
    if (selected !== "true") fail(`${label} ${row.id}: rail row not selected`);
    if (tabpanel !== 1) fail(`${label} ${row.id}: expected one #settings-panel-${row.id}, found ${tabpanel}`);
    await screenshot(page, `desktop-${row.id}`);
    await checkScreen(page, `${label} ${row.id}`, { phone: false });
    for (const sub of subtabs) {
      await page.locator(`#settings-subtab-${sub}`).click({ timeout: 5000 }).catch((error) => fail(`${label}: subtab ${sub}: ${error.message.slice(0, 80)}`));
      await page.waitForTimeout(1500);
      const subpanel = await page.locator(`#settings-subpanel-${sub}`).count();
      if (subpanel !== 1) fail(`${label} ${row.id}/${sub}: expected one #settings-subpanel-${sub}, found ${subpanel}`);
      await screenshot(page, `desktop-${row.id}-${sub}`);
      await checkScreen(page, `${label} ${row.id}/${sub}`, { phone: false });
    }
  }
  // The status lines again, now that every hub's routes have answered.
  D.rowsAfter = await page.locator('.settings-rail [role="tab"][id^="settings-tab-"]').evaluateAll((elements) => elements.map((element) => ({
    id: element.id.replace("settings-tab-", ""),
    status: element.querySelector("div > div:nth-child(2)")?.textContent?.trim() ?? null,
  })));
  // Search: listbox, keyboard, highlight, Escape restores the rail.
  const search = page.locator('input[aria-label="Search settings"]');
  await search.fill("theme");
  await page.waitForTimeout(500);
  D.search = {};
  D.search.listbox = await page.locator('[role="listbox"]').count();
  D.search.options = await page.locator('[role="listbox"] [role="option"]').evaluateAll((elements) => elements.slice(0, 5).map((element) => element.textContent.trim().slice(0, 50)));
  D.search.railHidden = (await page.locator(".settings-rail").count()) === 0;
  D.search.chips = await page.locator('.settings-search-chips button').evaluateAll((elements) => elements.map((element) => element.textContent.trim()));
  await screenshot(page, "desktop-search");
  if (D.search.listbox !== 1) fail(`${label}: search results are not one listbox (${D.search.listbox})`);
  if (!D.search.railHidden) fail(`${label}: the rail is still there while a query is typed`);
  if (D.search.options.length === 0) fail(`${label}: "theme" found nothing`);
  await search.press("ArrowDown");
  D.search.focusOnList = await page.evaluate(() => document.activeElement?.getAttribute("role") === "listbox");
  if (!D.search.focusOnList) fail(`${label}: ArrowDown from the field did not focus the listbox`);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  D.search.highlighted = await page.locator('[data-search-id="theme"]').evaluate((element) => getComputedStyle(element).boxShadow !== "none").catch(() => null);
  D.search.resultsPersist = (await page.locator('[role="listbox"]').count()) === 1;
  if (D.search.highlighted !== true) fail(`${label}: the Theme card is not highlighted after Enter (${D.search.highlighted})`);
  if (!D.search.resultsPersist) fail(`${label}: the results did not persist after opening one`);
  await screenshot(page, "desktop-search-jump");
  await page.locator('[role="listbox"]').focus();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  D.search.railBack = (await page.locator(".settings-rail").count()) === 1;
  D.search.stillOpen = await page.evaluate(SETTINGS_OPEN);
  if (!D.search.railBack) fail(`${label}: Escape in the results did not restore the rail`);
  if (!D.search.stillOpen) fail(`${label}: Escape in the results closed Settings`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  D.closedOnEscape = !(await page.evaluate(SETTINGS_OPEN));
  if (!D.closedOnEscape) fail(`${label}: Escape at the rail did not close Settings`);
  await context.close();
}

/* ---------- phone ---------- */
async function auditPhone() {
  const label = "phone";
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  await context.addCookies([{ name: "cody_session", value: COOKIE, url: BASE }]);
  const page = await openPage(context, label);
  const P = report.phone;
  P.historyLengthBefore = await page.evaluate(() => history.length);
  await openSettings(page, label);
  await page.waitForSelector(".settings-mobile-stack", { timeout: 15000 });
  await page.waitForTimeout(800);
  P.historyLengthAfterOpen = await page.evaluate(() => history.length);
  if (P.historyLengthAfterOpen !== P.historyLengthBefore + 1) fail(`${label}: opening Settings should push one entry (${P.historyLengthBefore} → ${P.historyLengthAfterOpen})`);
  P.rootRows = await page.locator(".settings-mobile-row").evaluateAll((elements) => elements.map((element) => ({ id: element.id.replace("settings-tab-", ""), h: Math.round(element.getBoundingClientRect().height) })));
  P.searchFontSize = await page.locator('input[aria-label="Search settings"]').evaluate((element) => getComputedStyle(element).fontSize);
  P.searchBarHeight = await box(page.locator(".settings-mobile-search"));
  P.searchAutofocused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Search settings");
  P.closeBox = await box(page.locator('button[aria-label="Close settings"]').first());
  await screenshot(page, "phone-root");
  await checkScreen(page, `${label} root`, { phone: true });
  if (P.rootRows.some((row) => row.h < 52)) fail(`${label}: root rows under 52px: ${JSON.stringify(P.rootRows)}`);
  if (parseFloat(P.searchFontSize) < 16) fail(`${label}: root search field is ${P.searchFontSize}`);
  if (P.searchAutofocused) fail(`${label}: the root search field autofocused (the keyboard would cover the list)`);
  if (!P.searchBarHeight || P.searchBarHeight.h !== 48) fail(`${label}: root search bar is ${JSON.stringify(P.searchBarHeight)}, expected 48px`);
  if (!P.closeBox || P.closeBox.w < 44 || P.closeBox.h < 44) fail(`${label}: root close button ${JSON.stringify(P.closeBox)}`);

  P.panels = {};
  for (const row of P.rootRows) {
    await page.locator(`#settings-tab-${row.id}`).click({ timeout: 10000 }).catch((error) => fail(`${label}: tap ${row.id}: ${error.message.slice(0, 80)}`));
    await page.locator(`#settings-panel-${row.id}`).waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(row.id === "system" || row.id === "providers" || row.id === "models" ? 3000 : 1200);
    const back = page.locator('button[aria-label="Back to Settings"]');
    const entry = {
      title: await page.locator(".settings-mobile-stack header div").nth(1).textContent().catch(() => null),
      back: await box(back),
      close: await box(page.locator('button[aria-label="Close settings"]').nth(1)),
      historyLength: await page.evaluate(() => history.length),
      subtabs: await page.locator(`[data-settings-host="${row.id}"] [id^="settings-subtab-"]`).evaluateAll((elements) => elements.map((element) => ({ id: element.id.replace("settings-subtab-", ""), w: Math.round(element.getBoundingClientRect().width), h: Math.round(element.getBoundingClientRect().height) }))),
    };
    P.panels[row.id] = entry;
    if (!entry.back || entry.back.h < 44 || entry.back.w < 44) fail(`${label} ${row.id}: back button ${JSON.stringify(entry.back)}`);
    if (!entry.close || entry.close.h < 44 || entry.close.w < 44) fail(`${label} ${row.id}: close button ${JSON.stringify(entry.close)}`);
    if (entry.historyLength !== P.historyLengthAfterOpen + 1) fail(`${label} ${row.id}: drilling in should push one entry (${P.historyLengthAfterOpen} → ${entry.historyLength})`);
    await screenshot(page, `phone-${row.id}`);
    await checkScreen(page, `${label} ${row.id}`, { phone: true });
    for (const sub of entry.subtabs) {
      await page.locator(`#settings-subtab-${sub.id}`).click({ timeout: 5000 }).catch((error) => fail(`${label}: subtab ${sub.id}: ${error.message.slice(0, 80)}`));
      await page.waitForTimeout(1500);
      await screenshot(page, `phone-${row.id}-${sub.id}`);
      await checkScreen(page, `${label} ${row.id}/${sub.id}`, { phone: true });
    }
    if (entry.subtabs.length > 1) {
      const total = entry.subtabs.reduce((sum, sub) => sum + sub.w, 0);
      if (total < 300) fail(`${label} ${row.id}: segmented control is ${total}px wide on a 390px phone (expected full width)`);
    }
    // Back through the button: root again, history unwound by one.
    await back.click({ timeout: 5000 }).catch((error) => fail(`${label}: back from ${row.id}: ${error.message.slice(0, 80)}`));
    await page.waitForTimeout(600);
    const rootVisible = await page.locator(".settings-mobile-row").first().isVisible().catch(() => false);
    if (!rootVisible) fail(`${label} ${row.id}: Back did not return to the root list`);
  }

  // History: a synthetic popstate pops exactly one level.
  await page.locator("#settings-tab-general").click();
  await page.waitForTimeout(1200);
  P.history = {};
  await page.evaluate(() => history.back());
  await page.waitForTimeout(700);
  P.history.rootAfterBack = await page.locator(".settings-mobile-row").first().isVisible().catch(() => false);
  P.history.openAfterBack = await page.evaluate(SETTINGS_OPEN);
  if (!P.history.rootAfterBack || !P.history.openAfterBack) fail(`${label}: history.back() from a hub should land on the root list (root ${P.history.rootAfterBack}, open ${P.history.openAfterBack})`);
  await page.evaluate(() => history.back());
  await page.waitForTimeout(700);
  P.history.closedAfterSecondBack = !(await page.evaluate(SETTINGS_OPEN));
  P.history.lengthAfterClose = await page.evaluate(() => history.length);
  if (!P.history.closedAfterSecondBack) fail(`${label}: history.back() from the root should close Settings`);
  P.history.urlUnchanged = (await page.evaluate(() => location.href)).startsWith(BASE);
  if (!P.history.urlUnchanged) fail(`${label}: the back gesture left the app`);

  // Escape mirrors the gesture: hub → root, root → closed; × unwinds.
  await openSettings(page, label);
  await page.locator("#settings-tab-general").click();
  await page.waitForTimeout(1000);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  P.escape = { rootAfterEscape: await page.locator(".settings-mobile-row").first().isVisible().catch(() => false), openAfterEscape: await page.evaluate(SETTINGS_OPEN) };
  if (!P.escape.rootAfterEscape || !P.escape.openAfterEscape) fail(`${label}: Escape from a hub should land on the root list (${JSON.stringify(P.escape)})`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  P.escape.closedAfterSecond = !(await page.evaluate(SETTINGS_OPEN));
  if (!P.escape.closedAfterSecond) fail(`${label}: Escape at the root should close Settings`);
  const before = await page.evaluate(() => history.length);
  await openSettings(page, label);
  await page.locator("#settings-tab-general").click();
  await page.waitForTimeout(1000);
  await page.locator('button[aria-label="Close settings"]').nth(1).click();
  await page.waitForTimeout(800);
  P.close = { closed: !(await page.evaluate(SETTINGS_OPEN)), stillInApp: (await page.evaluate(() => location.href)).startsWith(BASE), historyDelta: (await page.evaluate(() => history.length)) - before };
  if (!P.close.closed) fail(`${label}: × did not close Settings`);
  if (!P.close.stillInApp) fail(`${label}: × navigated away`);

  // Phone search: results replace the root list; Back from a hub returns to them.
  await openSettings(page, label);
  await page.locator('input[aria-label="Search settings"]').fill("theme");
  await page.waitForTimeout(500);
  P.search = { listbox: await page.locator('[role="listbox"]').count(), rowsHidden: (await page.locator(".settings-mobile-row").first().isVisible().catch(() => false)) === false };
  await screenshot(page, "phone-search");
  await checkScreen(page, `${label} search`, { phone: true });
  if (P.search.listbox !== 1) fail(`${label}: phone search results are not one listbox`);
  if (!P.search.rowsHidden) fail(`${label}: the root list is still visible under the results`);
  const first = page.locator('[role="listbox"] [role="option"]').first();
  if (await first.count() > 0) {
    await first.click();
    await page.waitForTimeout(900);
    await screenshot(page, "phone-search-jump");
    await page.locator('button[aria-label="Back to Settings"]').click();
    await page.waitForTimeout(600);
    P.search.resultsAfterBack = (await page.locator('[role="listbox"]').count()) === 1;
    if (!P.search.resultsAfterBack) fail(`${label}: Back from the hub did not return to the results`);
  } else {
    fail(`${label}: "theme" found nothing on the phone`);
  }
  await context.close();
}

for (const [label, run] of [["desktop", auditDesktop], ["phone", auditPhone]]) {
  try {
    await run();
  } catch (error) {
    fail(`${label}: aborted: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200)}`);
  }
}

await browser.close();
report.ok = report.problems.length === 0;
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
