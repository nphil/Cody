import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { parseOmpUsageOutput } = await jiti.import("./omp-usage.ts");
const {
  EXPIRES_SOON_MS,
  creditExpiryState,
  describeAccountPolicy,
  describeCreditClears,
  describeWindowAmount,
  formatCreditDate,
  isFiveHourIdle,
  providerUsesPriority,
} = await jiti.import("./quota-copy.ts");
const { translate } = await jiti.import("../i18n/index.tsx");

// Real `omp usage --json` output, 18.19.0 and the installed 18.8.3.
const fixture = (name) => parseOmpUsageOutput(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const claude = (snapshot) => snapshot.accounts.find((account) => account.provider === "anthropic");
const codex = (snapshot) => snapshot.accounts.find((account) => account.provider === "openai-codex");

const policy = (overrides = {}) => ({
  priority: null,
  reservePct: null,
  reserveSource: null,
  reclaimAbovePct: null,
  state: "eligible",
  remainingPct: null,
  ...overrides,
});

test("the policy line from a real 18.19.0 account: priority, reserve, state", () => {
  const account = claude(fixture("omp-18.19.0-usage-plan"));
  const copy = describeAccountPolicy(account.policy, translate);
  assert.equal(copy.line, "Priority 2 · Keeps 15% in reserve · eligible");
  assert.match(copy.detail, /Priority 2: omp tries the login with the higher number first\./);
  assert.match(copy.detail, /keeps 15% of this login's quota back/);
  assert.match(copy.detail, /This reserve is set for this login\./);
  assert.match(copy.detail, /comes back here once this one has 80% left\./);
  assert.match(copy.detail, /70% left\.$/);
});

test("an engine that prints no policy (18.8.3) gets no policy line", () => {
  const snapshot = fixture("omp-18.8.3-usage-plan");
  for (const account of snapshot.accounts) assert.equal(describeAccountPolicy(account.policy, translate), null);
});

test("a policy that only says 'eligible' or 'unknown' with the default priority says nothing", () => {
  assert.equal(describeAccountPolicy(policy({ priority: 0, reservePct: 0 }), translate), null);
  assert.equal(describeAccountPolicy(policy({ state: "unknown", remainingPct: 12 }), translate), null);
  assert.equal(describeAccountPolicy(undefined, translate), null);
  assert.equal(describeAccountPolicy(null, translate), null);
});

test("states that matter always get a line, in plain words", () => {
  assert.equal(describeAccountPolicy(policy({ state: "inside-reserve" }), translate).line, "inside its reserve");
  assert.equal(describeAccountPolicy(policy({ state: "exhausted" }), translate).line, "exhausted");
  assert.equal(
    describeAccountPolicy(policy({ reservePct: 12.5, reserveSource: "global", state: "inside-reserve" }), translate).line,
    "Keeps 12.5% in reserve · inside its reserve",
  );
  const global = describeAccountPolicy(policy({ reservePct: 10, reserveSource: "global" }), translate);
  assert.equal(global.line, "Keeps 10% in reserve · eligible");
  assert.match(global.detail, /This reserve is the default for every login\./);
});

test("a priority of 0 is named only next to a sibling that has one", () => {
  assert.equal(describeAccountPolicy(policy({ priority: 0, reservePct: 20 }), translate).line, "Keeps 20% in reserve · eligible");
  assert.equal(
    describeAccountPolicy(policy({ priority: 0, reservePct: 20 }), translate, { showPriority: true }).line,
    "Priority 0 · Keeps 20% in reserve · eligible",
  );
  const accounts = [
    { provider: "anthropic", policy: policy({ priority: 2 }) },
    { provider: "anthropic", policy: policy({ priority: 0 }) },
    { provider: "openai-codex", policy: policy({ priority: 0 }) },
  ];
  assert.equal(providerUsesPriority(accounts, "anthropic"), true);
  assert.equal(providerUsesPriority(accounts, "openai-codex"), false);
  assert.equal(providerUsesPriority([{ provider: "anthropic" }], "anthropic"), false);
});

// `translate()` reads the page language, which a Node process does not have, so
// the other two languages are exercised through their own dictionaries.
const translatorFor = (name) => {
  const dictionary = JSON.parse(readFileSync(new URL(`../i18n/locales/${name}.json`, import.meta.url), "utf8"));
  return (key, vars) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, variable) => (vars && variable in vars ? String(vars[variable]) : match));
};

test("the policy, amount and clear lines are translated", () => {
  const own = policy({ priority: 2, reservePct: 15, reserveSource: "override" });
  const ja = translatorFor("ja");
  const zh = translatorFor("zh-CN");
  assert.equal(describeAccountPolicy(own, ja).line, "優先度 2 · 15% を予備として確保 · 利用可能");
  assert.equal(describeAccountPolicy(own, zh).line, "优先级 2 · 保留 15% 作为备用 · 可用");
  assert.equal(describeWindowAmount({ unit: "credits", used: 40, limit: 100 }, "ja", ja), "40 / 100 クレジット");
  assert.equal(describeWindowAmount({ unit: "usd", used: 3.2, limit: 10 }, "zh-CN", zh), "$3.20 / $10");
  assert.equal(describeCreditClears(["anthropic:7d:fable", "anthropic:5h"], "ja", ja), "解除される上限: Fable の週間、5時間");
  assert.equal(describeCreditClears(["anthropic:5h", "anthropic:7d"], "zh-CN", zh), "可清除：5 小时和每周");
});

test("a Claude account with no session open has an idle 5-hour window; one that reports it does not", () => {
  const idle = fixture("omp-18.19.0-usage-no-claude-session");
  assert.deepEqual(claude(idle).inactiveGates, ["5h"]);
  assert.equal(isFiveHourIdle(claude(idle)), true);
  assert.equal(isFiveHourIdle(codex(idle)), false);
  assert.equal(isFiveHourIdle(claude(fixture("omp-18.19.0-usage-plan"))), false);
  // 18.8.3 prints no gate list: the bar is just missing and nothing can be said about why.
  assert.equal(isFiveHourIdle(claude(fixture("omp-18.8.3-usage-no-claude-session"))), false);
});

test("a stale gate list never hides a 5-hour bar that is really there", () => {
  const fiveHour = { id: "anthropic:5h", label: "5-hour window", windowMs: 18_000_000 };
  assert.equal(isFiveHourIdle({ inactiveGates: ["5h"], windows: [fiveHour] }), false);
  assert.equal(isFiveHourIdle({ inactiveGates: ["5h"], windows: [{ id: "x", label: "x", windowMs: 18_000_000 }] }), false);
  assert.equal(isFiveHourIdle({ inactiveGates: ["5h"], windows: [{ id: "anthropic:7d", label: "weekly", windowMs: 604_800_000 }] }), true);
  assert.equal(isFiveHourIdle({ inactiveGates: [], windows: [] }), false);
  assert.equal(isFiveHourIdle({ windows: [] }), false);
});

test("a Codex credit spend cap shows 'used of limit credits' next to its percent", () => {
  const spend = codex(fixture("omp-18.19.0-usage-codex-spend-cap")).windows.find((window) => window.id === "openai-codex:spend-cap");
  assert.equal(spend.windowMs, null);
  assert.equal(describeWindowAmount(spend.amount, "en", translate), "40 of 100 credits");
});

test("money amounts read as dollars: whole numbers bare, fractions with cents", () => {
  assert.equal(describeWindowAmount({ unit: "usd", used: 3.2, limit: 10 }, "en", translate), "$3.20 of $10");
  assert.equal(describeWindowAmount({ unit: "usd", used: 0, limit: 25 }, "en", translate), "$0 of $25");
  assert.equal(describeWindowAmount({ unit: "usd", used: 12.345, limit: 50 }, "en", translate), "$12.35 of $50");
  assert.equal(describeWindowAmount({ unit: "USD", used: 3, limit: null }, "en", translate), "$3 used");
  assert.equal(describeWindowAmount({ unit: "usd", used: null, limit: 100 }, "en", translate), "$100 limit");
});

test("credit and unknown-unit amounts, and amounts with nothing in them", () => {
  assert.equal(describeWindowAmount({ unit: "credits", used: 1250.5, limit: 5000 }, "en", translate), "1,250.5 of 5,000 credits");
  assert.equal(describeWindowAmount({ unit: "credits", used: 40, limit: null }, "en", translate), "40 credits used");
  assert.equal(describeWindowAmount({ unit: "tokens", used: 5, limit: 10 }, "en", translate), "5 of 10 tokens");
  assert.equal(describeWindowAmount({ unit: "usd", used: null, limit: null }, "en", translate), null);
  assert.equal(describeWindowAmount(undefined, "en", translate), null);
  assert.equal(describeWindowAmount(null, "en", translate), null);
});

test("a saved reset is 'soon' within 48 hours, 'later' beyond, 'past' once gone", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const at = (offsetMs) => new Date(now + offsetMs).toISOString();
  assert.equal(EXPIRES_SOON_MS, 48 * 3_600_000);
  assert.equal(creditExpiryState(at(EXPIRES_SOON_MS), now), "soon");
  assert.equal(creditExpiryState(at(60_000), now), "soon");
  assert.equal(creditExpiryState(at(EXPIRES_SOON_MS + 1000), now), "later");
  assert.equal(creditExpiryState(at(0), now), "past");
  assert.equal(creditExpiryState(at(-3_600_000), now), "past");
  assert.equal(creditExpiryState(null, now), null);
  assert.equal(creditExpiryState(undefined, now), null);
  assert.equal(creditExpiryState("not a date", now), null);
});

test("what a saved reset clears, from the limit ids omp lists", () => {
  assert.equal(describeCreditClears(["anthropic:5h", "anthropic:7d"], "en", translate), "Clears: 5-hour and weekly");
  assert.equal(describeCreditClears(["anthropic:7d:fable", "anthropic:5h"], "en", translate), "Clears: Fable weekly and 5-hour");
  assert.equal(
    describeCreditClears(["anthropic:5h", "anthropic:7d", "anthropic:7d:fable"], "en", translate),
    "Clears: 5-hour, weekly, and Fable weekly",
  );
  assert.equal(describeCreditClears(["openai-codex:primary"], "en", translate), "Clears: 5-hour");
  assert.equal(describeCreditClears(["openai-codex:secondary", "openai-codex:primary"], "en", translate), "Clears: weekly and 5-hour");
});

test("limit ids Cody cannot name are skipped; nothing nameable means no line", () => {
  assert.equal(describeCreditClears(["anthropic:5h", "mystery:thing"], "en", translate), "Clears: 5-hour");
  assert.equal(describeCreditClears(["anthropic:5h", "anthropic:5h"], "en", translate), "Clears: 5-hour");
  assert.equal(describeCreditClears(["mystery:thing", "", 7], "en", translate), null);
  assert.equal(describeCreditClears([], "en", translate), null);
  assert.equal(describeCreditClears(undefined, "en", translate), null);
  assert.equal(describeCreditClears(null, "en", translate), null);
});

test("a saved reset's end is a clock time today, a weekday within six days, a plain date beyond", () => {
  // Built from local-time parts so the cases hold in any timezone; the spaces
  // are normalised because newer ICU puts a narrow no-break space before PM.
  const plain = (text) => text?.replace(/\s/g, " ") ?? null;
  const now = new Date(2026, 10, 12, 9, 0).getTime();
  const at = (...parts) => new Date(...parts).toISOString();

  assert.equal(plain(formatCreditDate(at(2026, 10, 12, 18, 20), "en-US", now)), "06:20 PM");
  assert.equal(plain(formatCreditDate(at(2026, 10, 14, 9, 0), "en-US", now)), "Sat 09:00 AM");
  // Weeks away, "Tue 12:00 PM" would not say which Tuesday.
  assert.equal(formatCreditDate(at(2026, 11, 29, 12, 0), "en-US", now), "Dec 29");
  // A date already gone reads the same way; the caller adds "Expired".
  assert.equal(plain(formatCreditDate(at(2026, 10, 10, 12, 0), "en-US", now)), "Tue 12:00 PM");
});

test("a saved reset without a usable end date has no date to write", () => {
  const now = Date.parse("2026-11-12T09:00:00.000Z");
  assert.equal(formatCreditDate(null, "en-US", now), null);
  assert.equal(formatCreditDate(undefined, "en-US", now), null);
  assert.equal(formatCreditDate("not a date", "en-US", now), null);
});
