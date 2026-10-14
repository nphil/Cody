import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { DailyLimitSetting } = await jiti.import("./DailyLimitSetting.tsx");
const { PreferencesPanel, SEARCH_ENTRIES } = await jiti.import("./panels/PreferencesPanel.tsx");
const { searchSettings } = await jiti.import("./search-index.ts");
const { ShellContext, createSettingsBusy } = await jiti.import("./shell-context.tsx");
const { ALL_CAPABILITIES } = await jiti.import("../SettingsTabs.tsx");

function state(overrides) {
  const limitMinutes = overrides.limitMinutes ?? 120;
  const usedSeconds = overrides.usedSeconds ?? 0;
  const limitSeconds = limitMinutes * 60;
  return {
    enabled: true, limitMinutes, day: "2026-10-13", zone: "UTC", dayStartsAt: 0, dayEndsAt: 86400000,
    serverNow: 0, usedSeconds, extraSeconds: 0, limitSeconds, remainingSeconds: limitSeconds - usedSeconds, noticeDue: false,
    ...overrides,
  };
}

function shell(isMobile = false) {
  return {
    cwd: null,
    sessionId: null,
    engine: { id: "omp", displayName: "OMP runtime", shortName: "OMP", experimental: false },
    capabilities: ALL_CAPABILITIES,
    harnessLabel: "OMP",
    sessionModels: null,
    callbacks: { onAdvisorChange() {}, onModelsSaved() {}, onPluginsReloaded() {}, onOmpUpdateAvailabilityChange() {}, onClose() {}, selectSection() {} },
    prefs: { activityDisplayMode: "compact", setActivityDisplayMode() {}, thinkingDefaultExpanded: false, setThinkingDefaultExpanded() {}, advisorEnabled: false },
    isMobile,
    section: "general",
    sub: null,
    openSub: () => "level-1",
    closeSub() {},
    highlight: null,
    busy: createSettingsBusy(),
    portalTarget: null,
  };
}

function render(initial, isMobile = false) {
  return renderToStaticMarkup(React.createElement(
    ShellContext.Provider,
    { value: shell(isMobile) },
    React.createElement(DailyLimitSetting, {
      panelId: "general", label: "Daily time limit", description: "Your limit.", searchId: "daily-time-limit", initial,
    }),
  ));
}

/** The opening tag of the radio whose text is `text`. */
function chip(html, text) {
  const match = html.match(new RegExp(`<button[^>]*role="radio"[^>]*>${text}</button>`));
  assert.ok(match, `a "${text}" chip renders`);
  return match[0];
}

test("off: the switch is unchecked, the lengths are disabled and the line says nothing is counted", () => {
  const html = render(state({ enabled: false }));
  assert.match(html, /role="switch"[^>]*aria-checked="false"/);
  for (const text of ["1 h", "2 h", "3 h", "4 h"]) assert.match(chip(html, text), /disabled/);
  assert.match(html, /<input[^>]*disabled/);
  assert.ok(html.includes("Off, so nothing is counted."));
});

test("on with 2 h: only the 2 h chip is checked and the summary reads used of limit", () => {
  const html = render(state({ usedSeconds: 2880 }));
  assert.match(html, /role="switch"[^>]*aria-checked="true"/);
  assert.match(chip(html, "2 h"), /aria-checked="true"/);
  for (const text of ["1 h", "3 h", "4 h"]) assert.match(chip(html, text), /aria-checked="false"/);
  assert.doesNotMatch(chip(html, "2 h"), /disabled/);
  assert.ok(html.includes("Today: 48m of 2h"));
  assert.doesNotMatch(html, /<input[^>]*value="\d/);
});

test("on with 135 minutes: no chip is checked and the box shows 135", () => {
  const html = render(state({ limitMinutes: 135 }));
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1, "only the switch is checked");
  assert.match(html, /<input[^>]*value="135"/);
});

test("over the limit the line says by how much", () => {
  const html = render(state({ usedSeconds: 7200 + 600 }));
  assert.match(html, /over/);
});

test("phone: chips and the box are at least 44px tall and the box is 16px", () => {
  const html = render(state({}), true);
  assert.match(chip(html, "2 h"), /min-height:44px/);
  assert.match(html, /<input[^>]*font-size:16px/);
});

test("before the setting loads the controls wait disabled and no summary is claimed", () => {
  const html = render(null);
  assert.match(html, /role="switch"[^>]*disabled/);
  assert.match(chip(html, "2 h"), /disabled/);
  assert.doesNotMatch(html, /Today:|nothing is counted/);
});

test("Preferences carries the Daily time limit card and search finds it", () => {
  const html = renderToStaticMarkup(React.createElement(ShellContext.Provider, { value: shell() }, React.createElement(PreferencesPanel)));
  assert.ok(html.includes('data-search-id="daily-time-limit"'));
  const entry = SEARCH_ENTRIES.find((candidate) => candidate.id === "daily-time-limit");
  assert.ok(html.includes(entry.description), "the card's description is the table's description");
  for (const query of ["screen time", "daily limit", "time limit"]) {
    const hit = searchSettings(query, SEARCH_ENTRIES).find((result) => result.id === "daily-time-limit");
    assert.ok(hit, `"${query}" finds the card`);
    assert.equal(hit.tab, "general");
  }
});
