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
const { ProviderSignInPanel } = await jiti.import("./settings/ProviderSignInPanel.tsx");

// ProviderLoginFlow is the ONE sign-in state machine shared by OMP's own
// Models & Auth panel and the cross-engine Sign in section
// (ProviderSignInPanel); these tests pin its idle-phase rendering for both
// an OAuth-kind and a not-yet-connected provider row, and — the one real
// behavior change from the OAuthDetail it was extracted from — that
// `canLogout: false` hides the Disconnect control even when signed in.

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

// ProviderSignInPanel fetches its own data in an effect, which a static
// server render never runs — this pins the pre-fetch shell it renders while
// that request is outstanding: a heading (with the generic fallback name,
// since no /api/auth/providers response has arrived yet) and no provider
// rows or empty-state copy that would imply a response already came back.
test("ProviderSignInPanel renders its heading shell before data loads", () => {
  const html = renderToStaticMarkup(React.createElement(ProviderSignInPanel));
  assert.match(html, /Provider sign-in for the active engine/);
  assert.doesNotMatch(html, /Signed in|Not signed in/);
});
