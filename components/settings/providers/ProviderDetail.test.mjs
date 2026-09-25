import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { LoginMethodCard } = await jiti.import("./ProviderDetail.tsx");

// LoginMethodCard renders one sign-in method's card: the connect/re-login
// button, an optional per-account list omp's own roster supplies, and the
// note explaining how a signed-in credential comes off (the engine's own
// TUI logout when Cody can't enumerate accounts, or omp's own rotation once
// it can). These tests pin the three-way button label, the position-based
// row title omp's stable per-credential ordering drives, and which note
// shows for which shape of `method.accounts` — the seam multi-account
// support added without touching anything `method.accounts === undefined`
// still renders.

function row(overrides) {
  return {
    id: "anthropic",
    name: "Anthropic",
    brand: "anthropic",
    group: "subscription",
    methods: [],
    connected: true,
    modelCount: 10,
    catalogIds: ["anthropic"],
    orderIds: ["anthropic"],
    ...overrides,
  };
}

function method(overrides) {
  return {
    kind: "oauth",
    state: "connected",
    loginId: "anthropic",
    name: "Anthropic",
    canLogout: true,
    winning: true,
    ...overrides,
  };
}

function account(overrides) {
  return {
    id: "1",
    label: "person@example.com",
    position: 0,
    state: "in_use",
    planType: null,
    resetsAt: null,
    canRemove: true,
    ...overrides,
  };
}

function renderCard(overrides = {}, { canEdit = true, shortName = "Claude Code", autoStart = false, onChanged = () => {} } = {}) {
  return renderToStaticMarkup(
    React.createElement(LoginMethodCard, {
      row: row(overrides.row),
      method: method(overrides.method),
      canEdit,
      shortName,
      autoStart,
      onChanged,
    }),
  );
}

test("no accounts and signed out renders Sign in with no accounts list", () => {
  const html = renderCard({ method: { state: "available", accounts: undefined } });
  assert.match(html, /Sign in/);
  assert.doesNotMatch(html, /Add account/);
  assert.doesNotMatch(html, /Add secondary account/);
  assert.doesNotMatch(html, /In use|Standby|Limited|Disabled/);
});

test("accounts undefined and signed in without canLogout shows the TUI logout note, not the rotation note", () => {
  const html = renderCard({ method: { canLogout: false, accounts: undefined } });
  assert.match(html, /Sign out from the Claude Code TUI/);
  assert.doesNotMatch(html, /rotates between these accounts/);
  assert.doesNotMatch(html, /\bSign out\b(?!\s+from)/);
});

test("accounts undefined and signed in with canLogout is unchanged: Re-login and Sign out both render", () => {
  const html = renderCard({ method: { canLogout: true, accounts: undefined } });
  assert.match(html, /Re-login/);
  assert.match(html, /\bSign out\b/);
  assert.doesNotMatch(html, /rotates between these accounts/);
});

test("credential bridge failure explains unavailable account details instead of suggesting TUI logout", () => {
  const html = renderCard({
    method: {
      canLogout: false,
      accounts: undefined,
      accountDetailsReason: "credential_list_failed: storage.listStoredCredentials is not a function",
    },
  });
  assert.match(html, /Re-login/);
  assert.match(html, /Account details unavailable\./);
  assert.match(html, /credential_list_failed: storage\.listStoredCredentials is not a function/);
  assert.doesNotMatch(html, /Sign out from the Claude Code TUI/);
});

test("exactly one account renders Add secondary account, hides Sign out, and titles the row Primary", () => {
  const html = renderCard({
    method: { canLogout: true, accounts: [account({ position: 0, label: "solo@example.com", state: "in_use" })] },
  });
  assert.match(html, /Add secondary account/);
  assert.doesNotMatch(html, /\bSign out\b/);
  assert.doesNotMatch(html, /rotates between these accounts/);
  assert.match(html, /Primary/);
  assert.match(html, /solo@example\.com/);
  assert.match(html, /In use/);
});

test("two or more accounts renders Add account, the rotation note, and both position titles", () => {
  const html = renderCard({
    method: {
      canLogout: true,
      multiAccount: true,
      accounts: [
        account({ id: "1", position: 0, label: "a@example.com", state: "in_use" }),
        account({ id: "2", position: 1, label: "b@example.com", state: "standby" }),
      ],
    },
  });
  assert.match(html, /\bAdd account\b/);
  assert.doesNotMatch(html, /Add secondary account/);
  assert.match(html, /Claude Code rotates between these accounts automatically/);
  assert.match(html, /Primary/);
  assert.match(html, /Secondary/);
  assert.match(html, /In use/);
  assert.match(html, /Standby/);
  assert.doesNotMatch(html, /\bSign out\b/);
});

test("a third account titles the row Account 3, distinct from its identity label", () => {
  const html = renderCard({
    method: {
      multiAccount: true,
      accounts: [
        account({ id: "1", position: 0, label: "a@example.com" }),
        account({ id: "2", position: 1, label: "b@example.com" }),
        account({ id: "3", position: 2, label: "third@example.com", state: "disabled" }),
      ],
    },
  });
  assert.match(html, /Account 3/);
  assert.match(html, /third@example\.com/);
  assert.match(html, /Disabled/);
});

test("a limited account with no reset time shows Limited alone", () => {
  const html = renderCard({
    method: { accounts: [account({ state: "limited", resetsAt: null })] },
  });
  assert.match(html, /Limited/);
  assert.doesNotMatch(html, /resets/);
});

test("a limited account with a reset time shows Limited . resets <time>", () => {
  const html = renderCard({
    method: { accounts: [account({ state: "limited", resetsAt: "2026-09-13T20:00:00.000Z" })] },
  });
  assert.match(html, /Limited\s*·\s*resets\s*\d/);
});

test("the remove control appears only when the account allows it and the row is editable", () => {
  const removable = renderCard({ method: { accounts: [account({ label: "a@example.com", canRemove: true })] } });
  assert.match(removable, /aria-label="Remove a@example\.com permanently"/);

  const notRemovable = renderCard({ method: { accounts: [account({ label: "a@example.com", canRemove: false })] } });
  assert.doesNotMatch(notRemovable, /aria-label="Remove/);

  const readOnly = renderCard(
    { method: { accounts: [account({ label: "a@example.com", canRemove: true })] } },
    { canEdit: false },
  );
  assert.doesNotMatch(readOnly, /aria-label="Remove/);
});

test("active accounts can be named while disabled history is separate and remove-only", () => {
  const html = renderCard({
    method: {
      canRenameAccount: true,
      accounts: [
        account({ id: "1", label: "active@example.com", state: "serving" }),
        account({ id: "2", label: "disabled@example.com", position: 1, state: "disabled" }),
      ],
    },
  });
  assert.match(html, /Disabled history/);
  assert.match(html, /disabled by Claude Code/);
  assert.match(html, /aria-label="Rename active@example\.com"/);
  assert.doesNotMatch(html, /aria-label="Rename disabled@example\.com"/);
  assert.match(html, /Remove disabled@example\.com permanently/);
});
