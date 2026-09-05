import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ProviderLoginFlow } = await jiti.import("./settings/ProviderLoginFlow.tsx");
const { ProviderDirectory } = await jiti.import("./settings/providers/ProviderDirectory.tsx");
const { ShellContext, createSettingsBusy } = await jiti.import("./settings/shell-context.tsx");
const { ALL_CAPABILITIES } = await jiti.import("./SettingsTabs.tsx");

// ProviderLoginFlow is the ONE sign-in state machine: the Providers hub's
// detail drawer and the setup wizard both render it unchanged. These tests
// pin its idle-phase rendering for an OAuth-kind and a not-yet-connected
// provider row, and — the one real behavior change from the OAuthDetail it
// was extracted from — that `canLogout: false` hides the Disconnect control
// even when signed in.

const provider = (overrides) => ({
  id: "anthropic",
  name: "Anthropic",
  authenticated: false,
  kind: "oauth",
  canLogout: true,
  ...overrides,
});

test("not-signed-in provider renders a Login control and no Disconnect button", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProviderLoginFlow, { provider: provider(), onChanged: () => {} }),
  );
  assert.match(html, /Login/);
  assert.doesNotMatch(html, /Disconnect/);
  assert.match(html, /Anthropic/);
});

test("signed in with canLogout renders Re-login and Disconnect", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProviderLoginFlow, {
      provider: provider({ authenticated: true, canLogout: true }),
      onChanged: () => {},
    }),
  );
  assert.match(html, /Re-login/);
  assert.match(html, /Disconnect/);
});

// The engine adapter's own reported `canLogout` (e.g. omp, which has no
// non-interactive logout) must hide the Disconnect action even though the
// provider IS authenticated — this is what replaced OAuthDetail's old
// "show Disconnect whenever logged in" rule.
test("signed in without canLogout hides the Disconnect button", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProviderLoginFlow, {
      provider: provider({ authenticated: true, canLogout: false }),
      onChanged: () => {},
    }),
  );
  assert.match(html, /Re-login/);
  assert.doesNotMatch(html, /Disconnect/);
});

// The hub reads /api/providers through the settings route cache in an
// effect, which a static server render never runs — this pins the pre-fetch
// shell it renders while that request is outstanding: the heading, the
// Connected section in its loading state, the Add button (disabled until the
// directory answers) and the Discovered section — and no provider rows or
// empty-state copy that would imply a response already came back.
function renderDirectory(overrides = {}) {
  const shell = {
    cwd: null,
    sessionId: null,
    engine: { id: "omp", displayName: "OMP runtime", shortName: "OMP", experimental: false },
    capabilities: ALL_CAPABILITIES,
    harnessLabel: "OMP",
    sessionModels: null,
    callbacks: { onAdvisorChange() {}, onModelsSaved() {}, onPluginsReloaded() {}, onOmpUpdateAvailabilityChange() {}, onClose() {}, selectSection() {} },
    prefs: { toolCallsDefaultCollapsed: false, setToolCallsDefaultCollapsed() {}, thinkingDefaultExpanded: false, setThinkingDefaultExpanded() {}, advisorEnabled: false },
    isMobile: false,
    section: "providers",
    sub: null,
    openSub: () => "level-1",
    closeSub() {},
    highlight: null,
    busy: createSettingsBusy(),
    portalTarget: null,
    ...overrides,
  };
  return renderToStaticMarkup(
    React.createElement(ShellContext.Provider, { value: shell }, React.createElement(ProviderDirectory)),
  );
}

test("ProviderDirectory renders its pre-fetch shell before the directory loads", () => {
  const html = renderDirectory();
  assert.match(html, />Providers</);
  assert.match(html, /How OMP reaches a model vendor/);
  assert.match(html, /Reading providers/);
  assert.match(html, /Add provider/);
  assert.match(html, /Discovered/);
  assert.doesNotMatch(html, /Signed in|Key saved in Cody|cannot answer a prompt/);
  // No drawer is open before anyone picks a row.
  assert.doesNotMatch(html, /role="dialog"/);
});

test("ProviderDirectory names the engine it serves and hides custom-endpoint copy without `models`", () => {
  const html = renderDirectory({
    engine: { id: "hermes", displayName: "Hermes", shortName: "Hermes", experimental: false },
    harnessLabel: "Hermes",
    capabilities: { ...ALL_CAPABILITIES, models: false, configEditor: false },
  });
  assert.match(html, /How Hermes reaches a model vendor/);
  assert.match(html, /Hermes takes no custom endpoints from Cody/);
});
