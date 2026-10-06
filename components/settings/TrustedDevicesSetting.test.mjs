import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

/**
 * The Trusted devices card renders through an injected trust book (the seam
 * `initiallyLoaded` / `source` give a static render, which never runs effects),
 * the way TimeZoneSetting renders through `initial`. A click is driven by calling
 * the row function and invoking the handler it returned, since there is no DOM.
 */
const { DeviceRow, TrustedDevicesSetting, TRUSTED_DEVICES_EMPTY, forgetDevice } = await jiti.import("./TrustedDevicesSetting.tsx");
const { PreferencesPanel, PREFERENCE_CARDS, SEARCH_ENTRIES } = await jiti.import("./panels/PreferencesPanel.tsx");
const { searchSettings } = await jiti.import("./search-index.ts");
const { ShellContext, createSettingsBusy } = await jiti.import("./shell-context.tsx");
const { ALL_CAPABILITIES } = await jiti.import("../SettingsTabs.tsx");

// Mid-year, mid-day UTC: the same calendar year in every time zone.
const june2026 = Date.UTC(2026, 5, 15, 12);
const pixel = { key: "usb:18d1:PIX123", label: "Pixel 8", vendorId: 0x18d1, productId: 0x4ee7, serialNumber: "PIX123", grantedAt: june2026 };
const esp = { key: "usb:303a:ESP001", label: "ESP32-S3 <dev>", vendorId: 0x303a, serialNumber: "ESP001", grantedAt: june2026 - 86_400_000 };

function fakeSource(devices, loadError = null) {
  const list = [...devices];
  return {
    list: () => list,
    loadError,
    subscribe: () => () => {},
    refresh: async () => {},
    forget: async () => {},
  };
}

function render(source, initiallyLoaded = true) {
  return renderToStaticMarkup(React.createElement(TrustedDevicesSetting, {
    label: "Trusted devices",
    description: "Devices you let the agent control without asking again.",
    searchId: "trusted-devices",
    source,
    initiallyLoaded,
  }));
}

test("each remembered device is a row: name, USB vendor, serial, the day it was allowed, and a Forget button", () => {
  const html = render(fakeSource([pixel, esp]));
  assert.match(html, /data-search-id="trusted-devices"/);
  assert.match(html, />Pixel 8</);
  assert.match(html, />USB 18d1</);
  assert.match(html, />PIX123</);
  assert.match(html, />Allowed [^<]*2026</);
  assert.match(html, />USB 303a</);
  assert.match(html, /aria-label="Forget Pixel 8"/);
  assert.match(html, /aria-label="Forget ESP32-S3 &lt;dev&gt;"/, "a label is text, never markup");
  assert.equal((html.match(/<li\b/g) ?? []).length, 2);
  assert.ok(html.indexOf("Pixel 8") < html.indexOf("ESP32-S3"), "the list keeps the book's order");
  assert.doesNotMatch(html, /No device is remembered/);
});

test("the card can only remove trust: its one control per device is Forget", () => {
  const html = render(fakeSource([pixel, esp]));
  const buttons = [...html.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((match) => match[0]);
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.match(button, /aria-label="Forget /);
  assert.doesNotMatch(html, /<input|<select|<textarea|\bAllow\b|Remember this/);
});

test("with nothing remembered the card says so, and says where trust comes from", () => {
  const html = render(fakeSource([]));
  assert.ok(html.includes(TRUSTED_DEVICES_EMPTY));
  assert.equal(TRUSTED_DEVICES_EMPTY, "No device is remembered. The agent asks in the chat the first time it wants to control one.");
  assert.doesNotMatch(html, /<li\b|<button\b/);
});

test("before the first read has finished an empty list is not claimed to be empty", () => {
  const html = render(fakeSource([]), false);
  assert.doesNotMatch(html, /No device is remembered/);
  assert.match(html, /role="status"[^>]*>Loading…/);
});

test("a list that could not be read says why instead of claiming nothing is remembered", () => {
  const empty = render(fakeSource([], "Authentication required"));
  assert.match(empty, /role="alert"[^>]*>Could not read the remembered devices: Authentication required/);
  assert.doesNotMatch(empty, /No device is remembered/);

  // A failed re-read keeps the devices the page already knew, with the warning above them.
  const stale = render(fakeSource([pixel], "HTTP 500"));
  assert.match(stale, /Could not read the remembered devices: HTTP 500/);
  assert.match(stale, /aria-label="Forget Pixel 8"/);
});

test("pressing Forget hands that device's key to the card", () => {
  const forgotten = [];
  const row = DeviceRow({ device: pixel, first: true, busy: false, error: null, onForget: (key) => forgotten.push(key) });
  const button = findButton(row);
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.deepEqual(forgotten, [pixel.key]);
});

test("while a device is being forgotten its button is disabled and busy; a refusal is shown under that row", () => {
  const busy = renderToStaticMarkup(React.createElement(DeviceRow, { device: pixel, first: true, busy: true, error: null, onForget() {} }));
  assert.match(busy, /<button[^>]*disabled=""[^>]*aria-busy="true"|<button[^>]*aria-busy="true"[^>]*disabled=""/);

  const failed = renderToStaticMarkup(React.createElement(DeviceRow, { device: pixel, first: true, busy: false, error: "HTTP 502", onForget() {} }));
  assert.match(failed, /role="alert"[^>]*>Could not forget Pixel 8: HTTP 502/);
  assert.doesNotMatch(failed, /disabled=""/, "the person can try again");
});

test("forgetting resolves to null when the book forgets, and to the reason when it refuses", async () => {
  const seen = [];
  assert.equal(await forgetDevice(async (key) => { seen.push(key); }, pixel.key), null);
  assert.deepEqual(seen, [pixel.key]);
  assert.equal(await forgetDevice(async () => { throw new Error("Authentication required"); }, pixel.key), "Authentication required");
  assert.equal(await forgetDevice(() => Promise.reject("boom"), pixel.key), "boom");
});

/** The first <button> element in a rendered element tree. */
function findButton(node) {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child);
      if (found) return found;
    }
    return null;
  }
  if (node.type === "button") return node;
  return findButton(node.props?.children);
}

// ---------------------------------------------------------------------------
// In Preferences
// ---------------------------------------------------------------------------

function renderPanel() {
  const shell = {
    cwd: null,
    sessionId: null,
    engine: { id: "omp", displayName: "OMP runtime", shortName: "OMP", experimental: false },
    capabilities: ALL_CAPABILITIES,
    harnessLabel: "OMP",
    sessionModels: null,
    callbacks: { onAdvisorChange() {}, onModelsSaved() {}, onPluginsReloaded() {}, onOmpUpdateAvailabilityChange() {}, onClose() {}, selectSection() {} },
    prefs: { activityDisplayMode: "compact", setActivityDisplayMode() {}, thinkingDefaultExpanded: false, setThinkingDefaultExpanded() {}, advisorEnabled: false },
    isMobile: false,
    section: "general",
    sub: null,
    openSub: () => "level-1",
    closeSub() {},
    highlight: null,
    busy: createSettingsBusy(),
    portalTarget: null,
  };
  return renderToStaticMarkup(React.createElement(ShellContext.Provider, { value: shell }, React.createElement(PreferencesPanel)));
}

test("Preferences carries the Trusted devices card with the table's own words, and search finds it", () => {
  const html = renderPanel();
  const entry = SEARCH_ENTRIES.find((candidate) => candidate.id === "trusted-devices");
  assert.ok(entry, "the card is in the search entries");
  assert.equal(entry.tab, "general");
  assert.ok(html.includes('data-search-id="trusted-devices"'));
  assert.ok(html.includes(`>${entry.label}</span>`), "the card's label is the table's label");
  assert.ok(html.includes(entry.description), "the card's description is the table's description");
  assert.ok(PREFERENCE_CARDS.some((card) => card.id === "trusted-devices"));
  assert.match(entry.description, /can only remove trust/);

  for (const query of ["trusted devices", "usb", "adb", "fastboot", "forget", "revoke", "remember", "hardware"]) {
    const hit = searchSettings(query, SEARCH_ENTRIES).find((result) => result.id === "trusted-devices");
    assert.ok(hit, `"${query}" finds the Trusted devices card`);
    assert.equal(hit.tab, "general");
  }
});
