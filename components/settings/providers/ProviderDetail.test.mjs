import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { LoginMethodCard, KeyMethodCard, planRemoval, describeRemoval, isEnvironmentOnly, runRemoval, reportRemoval } = await jiti.import("./ProviderDetail.tsx");
// Off the browser `translate` answers in English straight from en.json, so the
// helpers are fed the real English copy instead of a second hard-coded copy.
const { translate: t, translatePlural: tn } = await jiti.import("../../../lib/i18n/index.tsx");

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
  assert.match(removable, /aria-label="Remove a@example\.com"/);

  const notRemovable = renderCard({ method: { accounts: [account({ label: "a@example.com", canRemove: false })] } });
  assert.doesNotMatch(notRemovable, /aria-label="Remove/);

  const readOnly = renderCard(
    { method: { accounts: [account({ label: "a@example.com", canRemove: true })] } },
    { canEdit: false },
  );
  assert.doesNotMatch(readOnly, /aria-label="Remove/);
});

// ── Removal honesty: nothing stored, environment-only, whole-provider Remove ──

const decoded = (html) => html.replaceAll("&#x27;", "'");

test("the not-stored note appears for a connected sign-in with an empty account list, and only then", () => {
  const empty = decoded(renderCard({ method: { canLogout: false, accounts: [] } }));
  assert.ok(empty.includes(t("providerRemoval.notStoredNote", { shortName: "Claude Code" })));
  assert.doesNotMatch(empty, /\bSign out\b/);

  const unknown = decoded(renderCard({ method: { canLogout: false, accounts: undefined } }));
  assert.doesNotMatch(unknown, /Not stored in/);

  const signedOut = decoded(renderCard({ method: { state: "available", accounts: [] } }));
  assert.doesNotMatch(signedOut, /Not stored in/);

  const withAccount = decoded(renderCard({ method: { accounts: [account()] } }));
  assert.doesNotMatch(withAccount, /Not stored in/);
});

function keyRow(variable) {
  return {
    kind: "key",
    state: "connected",
    winning: true,
    variables: [{ name: "OPENROUTER_API_KEY", label: "API key", secret: true, stored: false, fromEnvironment: false, ...variable }],
  };
}

function renderKeys(variable) {
  return decoded(renderToStaticMarkup(React.createElement(KeyMethodCard, { method: keyRow(variable), canEdit: true, shortName: "omp", onSaved: () => {} })));
}

test("a key set only in the server's environment says so, says where to remove it, and has no Clear button", () => {
  const html = renderKeys({ fromEnvironment: true });
  assert.ok(html.includes(t("providerRemoval.statusServer")));
  assert.ok(html.includes(t("providerRemoval.removeItThere")));
  assert.doesNotMatch(html, /Set on the container/);
  assert.doesNotMatch(html, />Clear</);
  assert.doesNotMatch(html, /Use container value/);
});

test("a key saved in Cody keeps its Clear button and none of the environment-only wording", () => {
  const html = renderKeys({ stored: true });
  assert.match(html, /Saved in Cody/);
  assert.match(html, />Clear</);
  assert.ok(!html.includes(t("providerRemoval.removeItThere")));
  assert.ok(!html.includes(t("providerRemoval.statusServer")));
});

function openRouterRow(variable, extra = {}) {
  return row({ id: "openrouter", name: "OpenRouter", modelCount: 5, methods: [keyRow(variable)], ...extra });
}

test("planRemoval counts stored accounts, stored key names, a custom endpoint and environment leftovers", () => {
  const plan = planRemoval(row({
    methods: [
      method({ loginId: "anthropic", name: "Claude", accounts: [account({ id: "1" }), account({ id: "2" })] }),
      keyRow({ stored: true, fromEnvironment: true }),
      { kind: "custom", state: "connected", winning: false },
    ],
  }));
  assert.equal(plan.accountCount, 2);
  assert.deepEqual(plan.logins, [{ loginId: "anthropic", name: "Claude", accounts: 2 }]);
  assert.deepEqual(plan.storedNames, ["OPENROUTER_API_KEY"]);
  assert.equal(plan.custom, true);
  assert.deepEqual(plan.environmentNames, ["OPENROUTER_API_KEY"]);
  assert.equal(plan.removable, true);
});

test("planRemoval keeps a connected sign-in with a sign-out and drops one nobody can sign out of", () => {
  const signedIn = planRemoval(row({ methods: [method({ accounts: undefined, canLogout: true })] }));
  assert.equal(signedIn.removable, true);
  assert.equal(signedIn.accountCount, 0);
  assert.equal(signedIn.logins.length, 1);

  const fromEnvironment = planRemoval(row({ methods: [method({ accounts: [], canLogout: false })] }));
  assert.equal(fromEnvironment.removable, false);
  assert.deepEqual(fromEnvironment.logins, []);

  const notSignedIn = planRemoval(row({ methods: [method({ state: "available", accounts: undefined })] }));
  assert.equal(notSignedIn.removable, false);
});

test("describeRemoval names what goes and what stays", () => {
  const plan = planRemoval(row({
    name: "OpenRouter",
    methods: [
      method({ loginId: "openrouter", name: "OpenRouter", accounts: [account({ id: "1" }), account({ id: "2" })] }),
      keyRow({ stored: true, fromEnvironment: true }),
    ],
  }));
  assert.equal(
    describeRemoval(plan, t, tn),
    [
      tn("providerRemoval.signOutAccounts", 2, { name: "OpenRouter" }),
      tn("providerRemoval.forgetKeys", 1, { names: "OPENROUTER_API_KEY" }),
      t("providerRemoval.serverLeftover"),
    ].join(" "),
  );
  const description = describeRemoval(plan, t, tn);
  assert.match(description, /2 OpenRouter accounts/);
  assert.match(description, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(description, /models\.yml|stored accounts|environment/);
  const custom = planRemoval(row({ name: "Mine", modelCount: 1, methods: [{ kind: "custom", state: "connected", winning: true }] }));
  assert.equal(describeRemoval(custom, t, tn), tn("providerRemoval.removeEndpoint", 1, { name: "Mine" }));
  assert.match(describeRemoval(custom, t, tn), /Mine and its 1 model\b/);
  const several = planRemoval(row({ name: "Mine", modelCount: 3, methods: [{ kind: "custom", state: "connected", winning: true }] }));
  assert.match(describeRemoval(several, t, tn), /Mine and its 3 models\b/);
});

test("nothing to remove gives no Remove row, and an environment-only key gives the informational row", () => {
  const nothing = planRemoval(openRouterRow({}));
  assert.equal(nothing.removable, false);
  assert.equal(isEnvironmentOnly(nothing), false);
  assert.equal(describeRemoval(nothing, t, tn), "");

  const environmentOnly = planRemoval(openRouterRow({ fromEnvironment: true }));
  assert.equal(environmentOnly.removable, false);
  assert.equal(isEnvironmentOnly(environmentOnly), true);

  assert.equal(isEnvironmentOnly(planRemoval(openRouterRow({ stored: true, fromEnvironment: true }))), false);
});

function fakeSteps(overrides = {}) {
  const calls = [];
  return {
    calls,
    steps: {
      signOut: async (loginId) => { calls.push(`signOut:${loginId}`); return { removed: true, active: 0 }; },
      clearKey: async (name) => { calls.push(`clearKey:${name}`); },
      deleteEndpoint: async () => { calls.push("deleteEndpoint"); },
      ...overrides,
    },
  };
}

test("runRemoval signs out, then clears keys, then deletes the endpoint, and reports leftovers", async () => {
  const plan = planRemoval(row({
    name: "OpenRouter",
    methods: [
      method({ loginId: "openrouter", name: "OpenRouter", accounts: [account()] }),
      keyRow({ stored: true, fromEnvironment: true }),
      { kind: "custom", state: "connected", winning: false },
    ],
  }));
  const { calls, steps } = fakeSteps({ signOut: async (loginId) => { calls.push(`signOut:${loginId}`); return { removed: true, active: 2 }; } });
  const outcome = await runRemoval(plan, steps, t);
  assert.deepEqual(calls, ["signOut:openrouter", "clearKey:OPENROUTER_API_KEY", "deleteEndpoint"]);
  assert.equal(outcome.failure, null);
  assert.equal(outcome.active, 2);
  assert.deepEqual(outcome.leftover, ["OPENROUTER_API_KEY"]);
  const report = reportRemoval(outcome, "OpenRouter", t, tn);
  assert.equal(report.kind, "removed");
  assert.equal(report.title, t("providerRemoval.removedTitle", { name: "OpenRouter" }));
  assert.ok(report.description.includes(tn("providerRemoval.stillOnServer", 1, { names: "OPENROUTER_API_KEY" })));
  assert.ok(report.description.includes(t("providerRemoval.activeChat")));
  assert.equal(report.close, false);
});

test("runRemoval closes the drawer only when nothing is left behind", async () => {
  const plan = planRemoval(row({ name: "OpenRouter", methods: [keyRow({ stored: true })] }));
  const outcome = await runRemoval(plan, fakeSteps().steps, t);
  const report = reportRemoval(outcome, "OpenRouter", t, tn);
  assert.equal(report.kind, "removed");
  assert.equal(report.description, undefined);
  assert.equal(report.close, true);
});

test("runRemoval stops at the first failure and says what was and was not removed", async () => {
  const plan = planRemoval(row({
    name: "OpenRouter",
    methods: [
      method({ loginId: "openrouter", name: "OpenRouter", accounts: [account()] }),
      keyRow({ stored: true }),
      { kind: "custom", state: "connected", winning: false },
    ],
  }));
  const { calls, steps } = fakeSteps({ clearKey: async () => { throw new Error("The key store is locked."); } });
  const outcome = await runRemoval(plan, steps, t);
  assert.deepEqual(calls, ["signOut:openrouter"]);
  assert.equal(outcome.failure, t("providerRemoval.failForget", { name: "OPENROUTER_API_KEY", reason: "The key store is locked." }));
  const report = reportRemoval(outcome, "OpenRouter", t, tn);
  assert.equal(report.kind, "failed");
  assert.equal(report.title, t("providerRemoval.partlyRemoved", { name: "OpenRouter" }));
  assert.ok(report.description.includes(outcome.failure));
  assert.ok(report.description.includes(t("providerRemoval.doneSoFar", { list: t("providerRemoval.doneSignedOut", { name: "OpenRouter" }) })));
  assert.equal(report.close, false);

  const first = await runRemoval(plan, fakeSteps({ signOut: async () => { throw new Error("Sign-out is not supported."); } }).steps, t);
  assert.deepEqual(first.done, []);
  const firstReport = reportRemoval(first, "OpenRouter", t, tn);
  assert.equal(firstReport.kind, "failed");
  assert.equal(firstReport.title, t("providerRemoval.removeFailed", { name: "OpenRouter" }));
  assert.ok(firstReport.description.includes(t("providerRemoval.failSignOut", { name: "OpenRouter", reason: "Sign-out is not supported." })));
  assert.ok(firstReport.description.includes(t("providerRemoval.nothingRemoved")));
  assert.equal(firstReport.close, false);
});

test("runRemoval with every sign-in answering removed:false reports nothing to remove, not a success", async () => {
  const plan = planRemoval(row({ name: "Anthropic", methods: [method({ accounts: [account()] })] }));
  const outcome = await runRemoval(plan, fakeSteps({ signOut: async () => ({ removed: false, active: 0 }) }).steps, t);
  const report = reportRemoval(outcome, "Anthropic", t, tn);
  assert.equal(report.kind, "nothing");
  assert.equal(report.title, t("providerRemoval.nothingToRemove"));
  assert.ok(report.description.includes(t("providerRemoval.nothingSaved", { name: "Anthropic" })));
  assert.equal(report.close, false);
});

test("an environment-only leftover keeps the drawer open and names the variables", async () => {
  const plan = planRemoval(row({ name: "OpenRouter", methods: [keyRow({ stored: true, fromEnvironment: true })] }));
  const report = reportRemoval(await runRemoval(plan, fakeSteps().steps, t), "OpenRouter", t, tn);
  assert.equal(report.kind, "removed");
  assert.equal(report.close, false);
  assert.match(report.description, /OPENROUTER_API_KEY/);
});

// en, ja and zh-CN must each carry every providerRemoval.* key with the same
// {variables}: a missing one would ship as English (or as the bare key) in a
// toast the owner reads.
test("en, ja and zh-CN define every providerRemoval key with the same variables", () => {
  const load = (name) => JSON.parse(fs.readFileSync(new URL(`../../../lib/i18n/locales/${name}.json`, import.meta.url), "utf8"));
  const locales = { en: load("en"), ja: load("ja"), "zh-CN": load("zh-CN") };
  const variables = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
  const keys = Object.keys(locales.en).filter((key) => key.startsWith("providerRemoval."));
  assert.ok(keys.length > 0);
  // A plural pair may differ on {count} (English drops it from `.one`), so
  // compare each key against its own English text, and pairs as a union.
  const baseOf = (key) => key.replace(/\.(one|other)$/, "");
  const union = (data, base) => variables([data[`${base}.one`], data[`${base}.other`]].filter(Boolean).join(" "));
  for (const key of keys) {
    for (const name of ["ja", "zh-CN"]) {
      const text = locales[name][key];
      assert.equal(typeof text, "string", `${name} is missing ${key}`);
      assert.ok(text.length > 0, `${name} has an empty ${key}`);
      if (/\.(one|other)$/.test(key)) assert.deepEqual(union(locales[name], baseOf(key)), union(locales.en, baseOf(key)), `${name} ${key}`);
      else assert.deepEqual(variables(text), variables(locales.en[key]), `${name} ${key}`);
    }
  }
  for (const name of ["ja", "zh-CN"]) {
    const extra = Object.keys(locales[name]).filter((key) => key.startsWith("providerRemoval.") && !(key in locales.en));
    assert.deepEqual(extra, [], `${name} has providerRemoval keys en does not`);
  }
});
