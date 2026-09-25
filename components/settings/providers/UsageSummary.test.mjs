import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { UsageSummary, buildUsageRows, buildOpenRouterRow } = await jiti.import("./UsageSummary.tsx");

// UsageSummary is the Providers directory's "Usage" block: one row per
// usage-reporting account, grouped by provider and ordered Primary/Secondary
// by ascending credential id, plus OpenRouter's prepaid balance where a bar
// would otherwise go. These tests pin: two accounts of the same provider
// render as two separate rows, an exhausted window is marked, the balance
// renders, and a provider Cody could not read at all produces no row of its
// own — only a footer line, and only when nothing else already covered it.

function window(overrides) {
  return {
    id: "w1",
    label: "5h window",
    utilization: 10,
    resetsAt: null,
    state: "ok",
    windowMs: 5 * 60 * 60 * 1000,
    ...overrides,
  };
}

function account(overrides) {
  return {
    provider: "anthropic",
    id: "acct-1",
    identity: "person@example.com",
    credentialId: 1,
    label: "Anthropic",
    planType: null,
    unlimited: false,
    windows: [window()],
    ...overrides,
  };
}

function fixtureAccounts() {
  return [
    account({
      provider: "anthropic",
      id: "acct-primary",
      credentialId: 1,
      windows: [window({ id: "weekly", label: "Weekly", utilization: 100, state: "exhausted", windowMs: 7 * 24 * 60 * 60 * 1000 })],
    }),
    account({
      provider: "anthropic",
      id: "acct-secondary",
      credentialId: 2,
      windows: [window({ id: "5h", label: "5h window", utilization: 18, state: "ok" })],
    }),
    account({
      provider: "openai-codex",
      id: "acct-codex",
      credentialId: 3,
      windows: [window({ id: "codex-5h", label: "5h window", utilization: 96, state: "warning" })],
    }),
    account({
      provider: "alibaba-token-plan",
      id: "acct-alibaba",
      credentialId: 4,
      windows: [window({ id: "alibaba-daily", label: "Daily", utilization: 5, state: "ok" })],
    }),
  ];
}

const openRouterSnapshot = {
  available: true,
  keySource: "cody",
  credits: { remaining: 0.09, totalUsage: 41.2, totalCredits: 41.29 },
  key: null,
  activity: null,
  hasManagementKey: false,
  error: null,
  fetchedAt: new Date().toISOString(),
  stale: false,
};

test("buildUsageRows renders both anthropic accounts as separate rows, ordered by credential id", () => {
  const rows = buildUsageRows(fixtureAccounts());
  const anthropicRows = rows.filter((row) => row.provider === "anthropic");
  assert.equal(anthropicRows.length, 2);
  assert.match(anthropicRows[0].title, /Primary/);
  assert.match(anthropicRows[1].title, /Secondary/);
});

test("buildUsageRows marks the exhausted window", () => {
  const rows = buildUsageRows(fixtureAccounts());
  const exhausted = rows.find((row) => row.key === "acct-primary");
  assert.ok(exhausted);
  assert.equal(exhausted.primary.exhausted, true);
  assert.equal(exhausted.primary.percent, 100);
});

test("buildUsageRows skips a disabled account and one with no windows", () => {
  const rows = buildUsageRows([
    account({ id: "disabled", disabled: { cause: "auth" }, windows: [window()] }),
    account({ id: "empty", windows: [] }),
  ]);
  assert.equal(rows.length, 0);
});

test("buildOpenRouterRow reports the balance and a warning tone under the low threshold", () => {
  const row = buildOpenRouterRow(openRouterSnapshot);
  assert.ok(row);
  assert.match(row.text, /\$0\.09/);
  assert.equal(row.tone, "warn");
});

test("buildOpenRouterRow renders nothing when no key is configured", () => {
  assert.equal(buildOpenRouterRow({ available: false, credits: null }), null);
  assert.equal(buildOpenRouterRow(null), null);
});

test("UsageSummary renders both Claude accounts, the OpenRouter balance, and nothing for an unavailable provider", () => {
  const html = renderToStaticMarkup(
    React.createElement(UsageSummary, {
      accounts: fixtureAccounts(),
      openRouter: openRouterSnapshot,
      unavailableProviders: [{ provider: "gemini", reason: "no key" }],
    }),
  );
  assert.match(html, /Claude · Primary/);
  assert.match(html, /Claude · Secondary/);
  assert.match(html, /Exhausted/);
  assert.match(html, /Codex/);
  assert.match(html, /Alibaba Token Plan/);
  assert.match(html, /\$0\.09 left/);
  assert.doesNotMatch(html, />Gemini</);
  assert.match(html, /Usage unavailable for Gemini/);
});

test("UsageSummary renders nothing at all when there is no usage, no balance and nothing unavailable", () => {
  const html = renderToStaticMarkup(React.createElement(UsageSummary, { accounts: [] }));
  assert.equal(html, "");
});

test("a provider already shown as a row is not repeated in the unavailable footer", () => {
  const html = renderToStaticMarkup(
    React.createElement(UsageSummary, {
      accounts: fixtureAccounts(),
      unavailableProviders: [{ provider: "anthropic", reason: "stale" }],
    }),
  );
  assert.doesNotMatch(html, /Usage unavailable/);
});

function loginCredential(id, position, label = `Account ${position + 1}`) {
  return {
    id: String(id),
    label,
    position,
    state: "standby",
    planType: null,
    resetsAt: null,
    canRemove: true,
  };
}

function loginMethod(overrides = {}) {
  return {
    kind: "oauth",
    state: "connected",
    loginId: "anthropic",
    canRenameAccount: true,
    accounts: [loginCredential(1, 0), loginCredential(2, 1)],
    winning: true,
    ...overrides,
  };
}

test("custom connection names keep provider and account-position context, with exact rename targets", () => {
  const accounts = [
    account({ id: "acct-primary", provider: "anthropic", credentialId: 1, customName: "Work account" }),
    account({ id: "acct-secondary", provider: "anthropic", credentialId: 2, customName: null }),
  ];
  const rows = buildUsageRows(accounts, [loginMethod()], true);
  assert.equal(rows[0].customName, "Work account");
  assert.deepEqual(rows[0].renameTarget, { loginId: "anthropic", accountId: "1" });
  assert.equal(rows[0].title, "Claude · Primary");
  assert.equal(rows[1].title, "Claude · Secondary");

  const html = renderToStaticMarkup(React.createElement(UsageSummary, {
    accounts,
    providerMethods: [loginMethod()],
    canRenameAccounts: true,
    onRenameAccount: async () => {},
  }));
  assert.match(html, /Work account/);
  assert.match(html, /Claude · Primary/);
  assert.match(html, /Claude · Secondary/);
  assert.match(html, /Rename connection/);
});

test("a custom name still displays without a roster, but cannot expose rename", () => {
  const html = renderToStaticMarkup(React.createElement(UsageSummary, {
    accounts: [account({ customName: "Work account" })],
  }));
  assert.match(html, /Work account/);
  assert.doesNotMatch(html, /Rename connection/);
});

test("rename requires admin access and exact provider login plus credential row id", () => {
  const base = account({ provider: "anthropic", credentialId: 1 });
  const cases = [
    { name: "non-admin", accounts: [base], methods: [loginMethod()], canEdit: false },
    { name: "missing credential id", accounts: [account({ provider: "anthropic", credentialId: null })], methods: [loginMethod()], canEdit: true },
    { name: "different login id", accounts: [base], methods: [loginMethod({ loginId: "anthropic-console" })], canEdit: true },
    { name: "different credential id", accounts: [base], methods: [loginMethod({ accounts: [loginCredential("01", 0)] })], canEdit: true },
    { name: "rename not supported", accounts: [base], methods: [loginMethod({ canRenameAccount: false })], canEdit: true },
    { name: "roster unavailable", accounts: [base], methods: [loginMethod({ accounts: undefined })], canEdit: true },
  ];

  for (const scenario of cases) {
    const row = buildUsageRows(scenario.accounts, scenario.methods, scenario.canEdit)[0];
    assert.equal(row.renameTarget, null, scenario.name);
  }
});

test("an account that only a block speaks for says so and offers Retry now; a measured one does not", () => {
  const blocked = {
    provider: "alibaba-token-plan", id: "alibaba-4", identity: null, credentialId: 4, label: "Alibaba", planType: null, unlimited: false,
    windows: [{ id: "block", label: "Blocked", utilization: 100, resetsAt: "2099-09-29T00:58:01.000Z", state: "exhausted", source: "block" }],
  };
  const measured = {
    provider: "anthropic", id: "anthropic-5", identity: null, credentialId: 5, label: "Claude", planType: null, unlimited: false,
    windows: [{ id: "7d", label: "7 days", utilization: 100, resetsAt: "2099-09-24T04:00:00.000Z", state: "exhausted" }],
  };
  const rows = buildUsageRows([blocked, measured]);
  assert.equal(rows.find((row) => row.provider === "alibaba-token-plan")?.blockedOnly, true);
  assert.equal(rows.find((row) => row.provider === "anthropic")?.blockedOnly, false);
  const html = renderToStaticMarkup(React.createElement(UsageSummary, { accounts: [blocked, measured], onRetryBlock() {} }));
  assert.match(html, /Blocked after a rejected request, not measured/);
  assert.equal((html.match(/Retry now/g) ?? []).length, 1);
  // Without an admin handler there is nothing to press.
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(UsageSummary, { accounts: [blocked] })), /Retry now/);
});
