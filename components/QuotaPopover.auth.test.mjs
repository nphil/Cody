import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

// What the quota popover says about omp 18.19.0's richer `omp usage --json`
// (routing policy, idle 5-hour window, unit amounts, failed refresh, logins it
// could not read, saved-reset details) and that the installed 18.8.3's plainer
// output renders exactly as it always did. The fixtures are real output of
// both engines; everything here is engine-independent.

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { QuotaPopover, buildQuotaView, modelLimitReached } = await jiti.import("./QuotaPopover.tsx");
const { AutoSpendControls } = await jiti.import("./QuotaAutoSpend.tsx");
const { parseOmpUsageOutput } = await jiti.import("../lib/usage/omp-usage.ts");
const { buildAutoRedeemGroups } = await jiti.import("../hooks/auto-redeem-controls.ts");
const { withOutdatedReadings } = await jiti.import("../lib/usage/reading-age.ts");

const fixture = (name) => parseOmpUsageOutput(readFileSync(new URL(`../lib/usage/fixtures/${name}.json`, import.meta.url), "utf8"));
const NEW_ENGINE_KEYS = new Set(JSON.parse(readFileSync(new URL("../lib/harness/fixtures/omp-schema-keys.json", import.meta.url), "utf8")).keys);
const OLD_ENGINE_KEYS = new Set(["claudeResets.autoRedeem", "codexResets.autoRedeem"]);

const NOW = Date.parse("2026-11-12T08:30:00.000Z");
const FABLE = { provider: "anthropic", modelId: "claude-fable-5" };

const render = (props) => renderToStaticMarkup(
  React.createElement(QuotaPopover, { provider: "anthropic", modelName: "Fable", now: NOW, ...props }),
);
/** What the owner reads: tags gone, every kind of space a plain one. */
const readable = (html) => html.replace(/<[^>]+>/g, "·").replace(/&#x27;/g, "'").replace(/\s/g, " ").replace(/·+/g, "·");
const testIds = (html) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((match) => match[1]);

const usageWindow = (overrides) => ({
  id: "anthropic:7d",
  label: "weekly",
  utilization: 30,
  resetsAt: "2026-11-15T20:00:00.000Z",
  state: "ok",
  windowMs: 604_800_000,
  ...overrides,
});
const usageAccount = (overrides) => ({
  provider: "anthropic",
  label: "Anthropic",
  planType: "max",
  unlimited: false,
  windows: [usageWindow()],
  ...overrides,
});
const usageSnapshot = (overrides) => ({
  available: true,
  accounts: [usageAccount()],
  fetchedAt: "2026-11-12T08:29:00.000Z",
  stale: false,
  ...overrides,
});
const withAnthropic = (snapshot, patch) => ({
  ...snapshot,
  accounts: snapshot.accounts.map((account) => (account.provider === "anthropic" ? { ...account, ...patch } : account)),
});

/* ───────────────────────── routing policy (AU-05) ───────────────────────── */

test("18.19.0: a login's routing policy is one line under the hero, with the full sentences on its tooltip", () => {
  const quota = buildQuotaView(fixture("omp-18.19.0-usage-plan"), false, false, FABLE);
  assert.equal(quota.known, true);
  assert.equal(quota.policy?.priority, 2);
  assert.equal(quota.showPriority, true);

  const html = render({ quota });
  assert.match(readable(html), /Priority 2 · Keeps 15% in reserve · eligible/);
  const tooltip = html.match(/data-testid="quota-account-policy"[^>]*title="([^"]*)"/)?.[1] ?? "";
  assert.match(tooltip, /omp tries the login with the higher number first/);
  assert.match(tooltip, /This reserve is set for this login/);
  assert.match(tooltip, /70% left/);
});

test("18.8.3: with no policy in the output the popover shows no policy line", () => {
  const quota = buildQuotaView(fixture("omp-18.8.3-usage-plan"), false, false, FABLE);
  assert.equal(quota.known, true);
  assert.equal(quota.policy, undefined);
  assert.doesNotMatch(render({ quota }), /quota-account-policy/);
});

/* ───────────────────── idle 5-hour window (AU-06) ───────────────────── */

test("18.19.0: a login with no live 5-hour window says it starts with the next message", () => {
  const quota = buildQuotaView(fixture("omp-18.19.0-usage-no-claude-session"), false, false, FABLE);
  assert.equal(quota.fiveHourIdle, true);
  const html = render({ quota });
  assert.match(readable(html), /5-hour window starts with your next message/);
  assert.match(html, /data-testid="quota-five-hour-idle"[^>]*title="No session is open on this login/);
});

test("the idle note is for an idle window only: a live 5-hour window and the 18.8.3 output show none", () => {
  for (const name of ["omp-18.19.0-usage-plan", "omp-18.8.3-usage-plan", "omp-18.8.3-usage-no-claude-session"]) {
    const quota = buildQuotaView(fixture(name), false, false, FABLE);
    assert.equal(quota.fiveHourIdle, undefined, name);
    assert.doesNotMatch(render({ quota }), /quota-five-hour-idle/, name);
  }
});

/* ───────────────────── amounts in dollars and credits (AU-07) ───────────────────── */

test("18.19.0: a credit spend cap reads '40 of 100 credits' although it has no window length", () => {
  const snapshot = fixture("omp-18.19.0-usage-codex-spend-cap");
  const quota = buildQuotaView(snapshot, false, false, { provider: "openai-codex", modelId: "gpt-5.6-terra" });
  assert.equal(quota.known, true);
  assert.equal(quota.percent, 40);
  assert.deepEqual(quota.windows[0].amount, { unit: "credits", used: 40, limit: 100 });
  assert.equal(quota.windows[0].windowMs ?? null, null);

  const text = readable(render({ quota, provider: "openai-codex", modelName: "GPT 5.6" }));
  assert.match(text, /40% Used/);
  assert.match(text, /Credit spend cap · 40 of 100 credits · Resets /);
});

test("a window that measures dollars shows them next to the percentage", () => {
  const cursor = (modelId) => buildQuotaView(usageSnapshot({
    accounts: [{
      provider: "cursor",
      label: "Cursor",
      planType: "pro",
      unlimited: false,
      windows: [
        { id: "cursor:usd:individual-auto", label: "Auto + Composer (weekly)", utilization: 25, resetsAt: "2026-11-15T00:00:00.000Z", state: "ok", windowMs: 604_800_000, amount: { unit: "usd", used: 5, limit: 20 } },
        { id: "cursor:usd:individual-api", label: "Prepaid credits", utilization: 70, resetsAt: "2026-12-01T00:00:00.000Z", state: "ok", windowMs: null, amount: { unit: "usd", used: 14, limit: 20 } },
      ],
    }],
  }), false, false, { provider: "cursor", modelId });

  // AU-04: Cursor's two pools are two limits; each model reads the pool it spends.
  const own = cursor("composer-2.5");
  assert.equal(own.percent, 25);
  assert.equal(own.label, "Auto + Composer (weekly)");
  assert.match(readable(render({ quota: own, provider: "cursor", modelName: "Composer" })), /Auto \+ Composer \(weekly\) · \$5 of \$20/);

  const prepaid = cursor("claude-opus-5");
  assert.equal(prepaid.percent, 70);
  assert.equal(prepaid.label, "Prepaid credits");
  const prepaidText = readable(render({ quota: prepaid, provider: "cursor", modelName: "Opus" }));
  assert.match(prepaidText, /Prepaid credits · \$14 of \$20/);
  // The pool this model does not spend is listed, not hidden and not the hero.
  assert.match(prepaidText, /Auto \+ Composer \(weekly\)·25%/);
});

test("a window with no amount keeps the plain line it always had", () => {
  const quota = buildQuotaView(fixture("omp-18.8.3-usage-plan"), false, false, FABLE);
  assert.equal(quota.windows.every((entry) => entry.amount === undefined), true);
  assert.doesNotMatch(readable(render({ quota })), / of \$?\d+/);
});

/* ───────────────── a refresh that failed, an old reading, unread logins ───────────────── */

test("a failed refresh names the time of the numbers and the time it failed, never 'updated just now'", () => {
  const snapshot = {
    ...fixture("omp-18.19.0-usage-plan"),
    fetchedAt: "2026-11-12T07:00:00.000Z",
    refreshFailed: { at: "2026-11-12T08:25:00.000Z", reason: "omp usage timed out" },
  };
  const quota = buildQuotaView(snapshot, false, false, FABLE);
  assert.deepEqual(quota.refreshFailed, { at: "2026-11-12T08:25:00.000Z", reason: "omp usage timed out", readAt: "2026-11-12T07:00:00.000Z" });

  const text = readable(render({ quota }));
  // The fixture times are fixed, so once the real clock passes their day the label gains a weekday.
  assert.match(text, /Numbers from (?:\w{3} )?\d{1,2}:\d{2} [AP]M · refresh failed at (?:\w{3} )?\d{1,2}:\d{2} [AP]M/);
  assert.doesNotMatch(text, /Updated /);
  // While a new read is in flight the footer says so instead.
  assert.match(readable(render({ quota, refreshing: true })), /Reading…/);
});

test("a good read has no failure on its view and the footer keeps its age", () => {
  const quota = buildQuotaView(fixture("omp-18.19.0-usage-plan"), false, false, FABLE);
  assert.equal(quota.refreshFailed, undefined);
  assert.equal(quota.unreported, undefined);
  assert.match(readable(render({ quota })), /Updated /);
});

test("an account carried over from an earlier read says when its numbers are from", () => {
  const snapshot = withAnthropic(fixture("omp-18.19.0-usage-plan"), { windowsStaleSince: "2026-11-12T06:00:00.000Z" });
  const quota = buildQuotaView(snapshot, false, false, FABLE);
  assert.equal(quota.windowsStaleSince, "2026-11-12T06:00:00.000Z");
  const html = render({ quota });
  assert.match(readable(html), /Quota as of (?:\w{3} )?\d{1,2}:\d{2} [AP]M/);
  assert.match(html, /data-testid="quota-windows-as-of"[^>]*title="The newest read did not include this account/);
});

test("logins omp could not read are counted in one line, by provider and never by identity", () => {
  const base = fixture("omp-18.19.0-usage-plan");
  const two = buildQuotaView({ ...base, unreportedAccounts: [{ provider: "anthropic" }, { provider: "openai-codex" }] }, false, false, FABLE);
  assert.deepEqual(two.unreported, { count: 2, providers: ["anthropic", "openai-codex"] });
  const html = render({ quota: two });
  assert.match(readable(html), /omp could not read the quota of 2 signed-in accounts/);
  assert.match(html, /data-testid="quota-unreported"[^>]*title="[^"]*\(Claude and Codex\)/);

  const one = buildQuotaView({ ...base, unreportedAccounts: [{ provider: "anthropic" }] }, false, false, FABLE);
  assert.match(readable(render({ quota: one })), /omp could not read the quota of 1 signed-in account(?!s)/);

  assert.doesNotMatch(render({ quota: buildQuotaView(base, false, false, FABLE) }), /quota-unreported/);
});

/* ───────────────────── logins that cannot serve at all (unavailable) ───────────────────── */

test("a provider whose every login was turned off says so, with no sign-in offered", () => {
  const snapshot = withAnthropic(fixture("omp-18.19.0-usage-plan"), { disabled: { cause: "disabled by an operator" }, windows: [] });
  const quota = buildQuotaView(snapshot, false, false, FABLE);
  assert.equal(quota.known, false);
  assert.equal(quota.titleKey, "usage.disabledTitle");
  assert.equal(quota.signedOut, undefined);

  const text = readable(render({ quota }));
  assert.match(text, /omp turned off every login for this provider/);
  assert.doesNotMatch(text, /Sign in again/);
});

test("a provider whose login ended is told to sign in again, and only that one", () => {
  const cause = 'oauth refresh failed: OAuthError: anthropic token refresh failed: 400 {"error":{"type":"invalid_grant","message":"Refresh token expired"}}';
  const snapshot = withAnthropic(fixture("omp-18.19.0-usage-plan"), { disabled: { cause }, windows: [] });
  const quota = buildQuotaView(snapshot, false, false, FABLE);
  assert.equal(quota.known, false);
  assert.deepEqual(quota.signedOut, { provider: "anthropic" });

  const text = readable(render({ quota }));
  assert.match(text, /Every account for this provider lost its login/);
  assert.match(text, /Sign in again/);
});

test("the model picker marks a spent model only, never one whose logins are signed out or turned off", () => {
  const base = fixture("omp-18.19.0-usage-plan");
  const off = withAnthropic(base, { disabled: { cause: "disabled by an operator" }, windows: [] });
  assert.equal(modelLimitReached(off, "omp", "anthropic", "claude-fable-5"), null);

  const spent = withAnthropic(base, {
    windows: [usageWindow({ id: "anthropic:7d", label: "weekly", utilization: 100, state: "exhausted", resetsAt: "2026-11-15T20:00:00.000Z" })],
  });
  assert.deepEqual(modelLimitReached(spent, "omp", "anthropic", "claude-fable-5"), { resetsAt: "2026-11-15T20:00:00.000Z" });
  assert.equal(modelLimitReached(base, "omp", "anthropic", "claude-fable-5"), null);
});

test("with no model chosen yet, logins that are all unusable still say so instead of reporting no limits", () => {
  const off = buildQuotaView(usageSnapshot({ accounts: [usageAccount({ id: "only", windows: [], disabled: { cause: "disabled by an operator" } })] }), false, false);
  assert.equal(off.known, false);
  assert.equal(off.titleKey, "usage.disabledTitle");
  assert.equal(off.signedOut, undefined);

  const cause = 'oauth refresh failed: invalid_grant {"message":"Refresh token expired"}';
  const ended = buildQuotaView(usageSnapshot({ accounts: [usageAccount({ id: "only", windows: [], disabled: { cause } })] }), false, false);
  assert.equal(ended.known, false);
  assert.deepEqual(ended.signedOut, { provider: "anthropic" });
});

/* ───────────────────────── a limited login's row ───────────────────────── */

test("a limited login's row explains the fallback on its tooltip, and never shows a '{time}' placeholder", () => {
  const siblings = (resetsAt) => usageSnapshot({
    accounts: [
      usageAccount({ id: "a", windows: [usageWindow({ utilization: 100, state: "exhausted", resetsAt })] }),
      usageAccount({ id: "b", windows: [usageWindow({ utilization: 20 })] }),
    ],
  });

  const timed = render({ quota: buildQuotaView(siblings("2026-11-15T20:00:00.000Z"), false, false, FABLE) });
  assert.match(readable(timed), /Limited · resets /);
  assert.match(timed, /title="This login hit its limit\. If no other login can serve, omp stays on a fallback model until the reported reset\."/);

  const untimed = readable(render({ quota: buildQuotaView(siblings(null), false, false, FABLE) }));
  assert.match(untimed, /Primary·Limited·/);
  assert.doesNotMatch(untimed, /\{time\}/);
});

/* ───────────────────── saved resets: expiry, what they clear, partial lists ───────────────────── */

const resetCredits = (credits, snapshotExtra = {}) => ({
  loading: false,
  redeeming: false,
  refresh() {},
  redeem: async () => ({ outcome: "reset", accountId: "claude", creditId: "c1" }),
  snapshot: {
    available: true,
    fetchedAt: "2026-11-12T08:29:00.000Z",
    accounts: [{ id: "claude", label: "Claude account", provider: "anthropic", position: 0, availableCount: credits.length, canRedeem: true, credits }],
    ...snapshotExtra,
  },
});

test("a saved reset close to its end gets an 'Expires soon' tag on the section and on its own line", () => {
  const quota = buildQuotaView(usageSnapshot(), false, false, FABLE);
  const html = render({
    quota,
    resetCredits: resetCredits([
      { id: "c1", expiresAt: "2026-11-13T08:30:00.000Z", clears: ["anthropic:5h", "anthropic:7d"] },
      { id: "c2", expiresAt: "2026-12-30T12:00:00.000Z", clears: ["anthropic:7d:fable"] },
    ]),
  });
  const text = readable(html);

  assert.match(html, /data-testid="saved-resets-expires-soon"/);
  assert.equal(testIds(html).filter((id) => id === "saved-reset-expires-soon").length, 1, "only the credit that is close to its end is tagged");
  assert.equal(testIds(html).filter((id) => id === "saved-reset-credit").length, 2);
  // Close to now a weekday and time say it; weeks away a date does.
  assert.match(text, /Expires [A-Z][a-z]{2} \d{2}:\d{2} [AP]M/);
  assert.match(text, /Expires Dec 30/);
  assert.match(text, /Clears: 5-hour and weekly/);
  assert.match(text, /Clears: Fable weekly/);
});

test("saved resets far from their end carry no tag, and an ended one says it ended", () => {
  const quota = buildQuotaView(usageSnapshot(), false, false, FABLE);
  const later = render({ quota, resetCredits: resetCredits([{ id: "c1", expiresAt: "2026-12-30T12:00:00.000Z" }]) });
  assert.doesNotMatch(later, /saved-resets-expires-soon|saved-reset-expires-soon/);
  assert.doesNotMatch(later, /saved-reset-clears/, "a credit that names nothing it clears shows no 'Clears' line");

  const ended = readable(render({ quota, resetCredits: resetCredits([{ id: "c1", expiresAt: "2026-11-10T12:00:00.000Z" }]) }));
  assert.match(ended, /Expired [A-Z][a-z]{2} \d{2}:\d{2} [AP]M/);
});

test("a provider whose saved resets could not be listed is named, so a short list is not read as 'none'", () => {
  const quota = buildQuotaView(usageSnapshot(), false, false, FABLE);
  const partial = render({ quota, resetCredits: resetCredits([{ id: "c1", expiresAt: "2026-12-30T12:00:00.000Z" }], { failedProviders: ["openai-codex"] }) });
  assert.match(readable(partial), /Could not check saved resets for Codex\. The list may be missing some\./);
  assert.match(partial, /data-testid="saved-reset-partial"/);

  const whole = render({ quota, resetCredits: resetCredits([{ id: "c1", expiresAt: "2026-12-30T12:00:00.000Z" }]) });
  assert.doesNotMatch(whole, /saved-reset-partial/);
});

/* ───────────────────── automatic spending of saved resets ───────────────────── */

const lookupOver = (keys, values = {}) => (key) => (keys.has(key) ? { value: values[key] } : undefined);
const asKeys = (html) => testIds(html).filter((id) => id.startsWith("auto-spend-") && id !== "auto-spend-fable-note");
const identity = (key) => key;

test("18.19.0: one switch per limit, Claude's Fable launch resets included and explained as separate", () => {
  const groups = buildAutoRedeemGroups(lookupOver(NEW_ENGINE_KEYS), ["anthropic", "openai-codex"]);
  const html = renderToStaticMarkup(React.createElement(AutoSpendControls, { groups, t: identity, onChange() {} }));
  assert.deepEqual(asKeys(html).filter((id) => id.includes("Resets.")), [
    "auto-spend-claudeResets.autoRedeem5h",
    "auto-spend-claudeResets.autoRedeemWeekly",
    "auto-spend-claudeResets.autoRedeemFable",
    "auto-spend-codexResets.autoRedeem5h",
    "auto-spend-codexResets.autoRedeemWeekly",
  ]);
  assert.match(html, /data-testid="auto-spend-fable-note"/);
});

test("18.8.3: the single legacy switch per provider and no Fable note, so nothing is offered that the engine ignores", () => {
  const groups = buildAutoRedeemGroups(lookupOver(OLD_ENGINE_KEYS, { "claudeResets.autoRedeem": "yes" }), ["anthropic", "openai-codex"]);
  const html = renderToStaticMarkup(React.createElement(AutoSpendControls, { groups, t: identity, onChange() {} }));
  assert.deepEqual(asKeys(html).filter((id) => id.includes("Resets.")), [
    "auto-spend-claudeResets.autoRedeem",
    "auto-spend-codexResets.autoRedeem",
  ]);
  assert.doesNotMatch(html, /auto-spend-fable-note/);
});

test("an engine that declares no automatic-spend setting gets no switches at all", () => {
  const groups = buildAutoRedeemGroups(lookupOver(new Set()), ["anthropic", "openai-codex"]);
  assert.equal(renderToStaticMarkup(React.createElement(AutoSpendControls, { groups, t: identity, onChange() {} })), "");
});

test("the popover shows no switches before the settings schema has loaded", () => {
  const quota = buildQuotaView(usageSnapshot(), false, false, FABLE);
  const html = render({ quota, resetCredits: resetCredits([{ id: "c1", expiresAt: "2026-12-30T12:00:00.000Z" }]) });
  assert.doesNotMatch(html, /data-testid="auto-spend"/);
});

/* ───────── a reading omp measured long ago (real 18.8.3 and 18.19.0 reads of one agent directory) ───────── */

// Both fixtures are the same agent directory read by the two engines. The
// Primary Claude login's usage fetch was answered with HTTP 429 and its saved
// report was five days old; 18.8.3 kept printing it, with its own old
// `fetchedAt`. 18.19.0 read the Primary live and the Secondary from headers.
const STALE_READ = "omp-18.8.3-usage-stale-primary";
const LIVE_READ = "omp-18.19.0-usage-primary-fresh";
const PRIMARY_ID = "00000000-0000-4000-8000-0000000000a1";
const SECONDARY_ID = "00000000-0000-4000-8000-0000000000b1";
const readAt = (name) => JSON.parse(readFileSync(new URL(`../lib/usage/fixtures/${name}.json`, import.meta.url), "utf8")).generatedAt;
/** What the server hands the browser: the parsed read, aged at `now`. */
const aged = (name, now = readAt(name)) => withOutdatedReadings(fixture(name), now);
const loginOnly = (snapshot, id) => ({ ...snapshot, accounts: snapshot.accounts.filter((account) => account.id === id) });

test("18.8.3: a login whose saved report is five days old shows no number, only when it was measured", () => {
  const now = readAt(STALE_READ);
  const quota = buildQuotaView(aged(STALE_READ), false, false, FABLE);
  // The ring follows the login that has a current reading: the Secondary's weekly window.
  assert.equal(quota.known, true);
  assert.equal(quota.label, "Claude · Secondary · weekly");
  assert.equal(quota.percent, 22);
  const primary = quota.accounts.find((account) => account.key === PRIMARY_ID);
  assert.deepEqual(
    { noReading: primary.noReading, outdated: primary.outdated, measuredAt: primary.measuredAt, percent: primary.percent, resetsAt: primary.resetsAt, state: primary.state },
    { noReading: true, outdated: true, measuredAt: "2026-11-07T10:20:47.993Z", percent: 0, resetsAt: null, state: "standby" },
  );

  const text = readable(render({ quota, now }));
  assert.match(text, /Primary·Standby·—·Out of date · measured 5d ago/);
  assert.match(text, /Secondary·In use·22%/);
  // The numbers of the five-day-old report (5-hour 1%, weekly 55%) appear nowhere.
  assert.doesNotMatch(text, /\b55%|Primary·Standby·1%/);
  assert.deepEqual(testIds(render({ quota, now })).filter((id) => id === "quota-reading-outdated"), ["quota-reading-outdated"]);
});

test("18.8.3: when that login is the only one, the ring is blank and says the reading is out of date", () => {
  const now = readAt(STALE_READ);
  const quota = buildQuotaView(loginOnly(aged(STALE_READ), PRIMARY_ID), false, false, FABLE);
  assert.equal(quota.known, false);
  assert.equal(quota.titleKey, "usage.outdatedTitle");
  assert.equal(quota.outdatedSince, "2026-11-07T10:20:47.993Z");
  assert.equal(quota.signedOut, undefined);

  const text = readable(render({ quota, now }));
  assert.match(text, /too old to show as current/);
  assert.match(text, /Out of date · measured 5d ago/);
  // A blank ring is not "0%" and not "unmetered".
  assert.doesNotMatch(text, /\d+% Used|\b55%|unmetered|does not report plan limits/i);
});

test("a reading still inside half an hour carries no out-of-date mark, whichever engine printed it", () => {
  for (const name of [LIVE_READ, "omp-18.19.0-usage-plan", "omp-18.8.3-usage-plan"]) {
    const snapshot = aged(name);
    assert.equal(snapshot.accounts.some((account) => account.outdated), false, name);
    const html = render({ quota: buildQuotaView(snapshot, false, false, FABLE), now: readAt(name) });
    assert.doesNotMatch(html, /quota-reading-outdated|Out of date/, name);
  }
});

test("18.19.0: a report built from the last response's headers is marked once it is half an hour old, and the live one is not", () => {
  const now = Date.parse("2026-11-12T16:20:00.000Z");
  const quota = buildQuotaView(aged(LIVE_READ, now), false, false, FABLE);
  const secondary = quota.accounts.find((account) => account.key === SECONDARY_ID);
  const primary = quota.accounts.find((account) => account.key === PRIMARY_ID);
  assert.equal(secondary.outdated, true);
  assert.equal(secondary.measuredAt, "2026-11-12T15:45:41.358Z");
  assert.equal(secondary.percent, 21, "its windows have not reset, so the last known number stays, marked");
  assert.equal(primary.outdated, undefined, "measured 20 minutes before this moment: still current");

  const text = readable(render({ quota, now }));
  assert.match(text, /Secondary·Standby·21%·Out of date · measured 34m ago/);
});

test("an out-of-date number that still binds stays on the hero, dimmed, with its age on its own line", () => {
  const now = Date.parse("2026-11-12T16:20:00.000Z");
  const quota = buildQuotaView(loginOnly(aged(LIVE_READ, now), SECONDARY_ID), false, false, FABLE);
  assert.equal(quota.known, true);
  assert.equal(quota.outdated, true);
  assert.equal(quota.measuredAt, "2026-11-12T15:45:41.358Z");
  assert.equal(quota.percent, 21);

  const html = render({ quota, now });
  assert.match(readable(html), /Fable·21% Used·Weekly · Out of date · Resets /);
  assert.match(html, /data-testid="quota-reading-outdated"[^>]*title="omp could not refresh this account&#x27;s usage/);
  assert.match(readable(html), /Out of date · measured 34m ago/);
  assert.match(html, /opacity:0\.6/);
});

test("both engines' Fable weekly window keeps its own scope, reset time and percentage next to the weekly one", () => {
  const fableWindows = (name, id) => fixture(name).accounts.find((account) => account.id === id).windows.filter((window) => window.tier === "fable");
  assert.deepEqual(fableWindows(LIVE_READ, PRIMARY_ID).map((window) => [window.utilization, window.resetsAt]), [[70, "2026-11-17T13:00:00.420Z"]]);
  assert.deepEqual(fableWindows(STALE_READ, SECONDARY_ID).map((window) => [window.utilization, window.resetsAt]), [[8, "2026-11-19T04:00:00.354Z"]]);
  // The Fable model is gauged against the Fable meter as well as the plan windows; Opus is not.
  const live = aged(LIVE_READ);
  const fable = buildQuotaView(live, false, false, FABLE);
  assert.deepEqual(fable.windows.map((window) => window.percent).sort((a, b) => b - a), [95, 70, 3], "weekly, Fable weekly and 5-hour of the login in use");
  const text = readable(render({ quota: fable, now: readAt(LIVE_READ) }));
  assert.match(text, /Claude · Primary · Fable · Weekly·70%· Resets /);
  const opus = buildQuotaView(live, false, false, { provider: "anthropic", modelId: "claude-opus-5" });
  assert.equal(opus.windows.some((window) => /fable/i.test(window.label)), false, "a Fable meter does not bind an Opus model");
});
