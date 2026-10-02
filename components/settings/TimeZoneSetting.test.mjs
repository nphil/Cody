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
 * The row reads GET /api/time-zone through the shared settings route cache,
 * which a static render always sees empty, so `initial` stands in for the
 * server's answer (the same seam `ModelPresets` uses). The assertions read the
 * rendered English, so a missing or mis-wired string fails here.
 */
const { TimeZoneSetting } = await jiti.import("./TimeZoneSetting.tsx");
const { PreferencesPanel, SEARCH_ENTRIES } = await jiti.import("./panels/PreferencesPanel.tsx");
const { searchSettings } = await jiti.import("./search-index.ts");
const { ShellContext, createSettingsBusy } = await jiti.import("./shell-context.tsx");
const { ALL_CAPABILITIES } = await jiti.import("../SettingsTabs.tsx");

function saved(overrides) {
  return { zone: "Asia/Tokyo", source: "explicit", explicit: "Asia/Tokyo", deviceZone: "Asia/Tokyo", serverZone: "UTC", ...overrides };
}

/** Render with this "browser" in New York. */
function render(initial) {
  const original = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    return renderToStaticMarkup(React.createElement(TimeZoneSetting, {
      panelId: "general", label: "Time zone", description: "Which clock your agents use.", searchId: "time-zone", initial,
    }));
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

test("a pinned zone is what the control shows, and the line under it says agents see that zone", () => {
  const html = render(saved());
  assert.match(html, /aria-label="Time zone"/);
  assert.match(html, />Asia\/Tokyo<\/span>/);
  assert.match(html, /Agents see Asia\/Tokyo, the zone you chose\./);
  assert.doesNotMatch(html, /Automatic/);
});

test("Automatic names the zone of this device and says the clock follows it", () => {
  const html = render(saved({ explicit: null, source: "last-seen", zone: "Asia/Tokyo" }));
  // The label and the line use the zone of THIS browser (New York here), not
  // whatever the account last reported (Tokyo).
  assert.match(html, />Automatic \(this device: America\/New_York\)<\/span>/);
  assert.match(html, /Agents see America\/New_York, the zone of this device\./);
  assert.doesNotMatch(html, /Asia\/Tokyo/);
});

test("until the setting has been read, the control waits disabled instead of claiming Automatic", () => {
  const html = render(undefined);
  assert.match(html, /<button[^>]*disabled=""/);
  assert.doesNotMatch(html, /Automatic|Agents see/);
});

test("a zone the server stored under another name still shows as the chosen one, named the way the picker lists it", () => {
  // Safari and Firefox list Asia/Kolkata; the server's runtime reports the same
  // zone as Asia/Calcutta. One row must be selected, and the line under it
  // must call the zone what the control does.
  const listed = Intl.supportedValuesOf.bind(Intl);
  Intl.supportedValuesOf = (key) => (key === "timeZone" ? listed(key).map((zone) => (zone === "Asia/Calcutta" ? "Asia/Kolkata" : zone)) : listed(key));
  try {
    const html = render(saved({ zone: "Asia/Calcutta", explicit: "Asia/Calcutta" }));
    assert.match(html, />Asia\/Kolkata<\/span>/);
    assert.match(html, /Agents see Asia\/Kolkata, the zone you chose\./);
    assert.doesNotMatch(html, /Calcutta/);
  } finally {
    Intl.supportedValuesOf = listed;
  }
});

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

test("Preferences carries the Time zone row, and dialog search finds it however it is asked for", () => {
  const html = renderPanel();
  const row = html.indexOf('data-search-id="time-zone"');
  assert.ok(row > html.indexOf('data-search-id="language"'), "the row follows Language");
  assert.ok(row < html.indexOf('data-search-id="chat-text-size"'), "and precedes Chat text size");

  // What the card says and what search shows come from two places (the
  // locale file and the card table); they must stay the same sentence.
  const entry = SEARCH_ENTRIES.find((candidate) => candidate.id === "time-zone");
  assert.ok(html.includes(`>${entry.label}</span>`), "the card's label is the table's label");
  assert.ok(html.includes(entry.description), "the card's description is the table's description");

  for (const query of ["time zone", "timezone", "clock", "travel"]) {
    const hit = searchSettings(query, SEARCH_ENTRIES).find((result) => result.id === "time-zone");
    assert.ok(hit, `"${query}" finds the Time zone row`);
    assert.equal(hit.tab, "general");
  }
});
