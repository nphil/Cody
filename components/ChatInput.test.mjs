import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner, buildQuotaView } = await jiti.import("./ChatInput.tsx");

const usageWindow = (overrides) => ({
  id: "anthropic:7d:opus",
  label: "Opus · weekly",
  utilization: 38,
  resetsAt: "2026-08-23T09:00:00.000Z",
  state: "ok",
  ...overrides,
});

const usageSnapshot = (overrides) => ({
  available: true,
  accounts: [{
    provider: "anthropic",
    label: "Anthropic",
    planType: "max",
    unlimited: false,
    windows: [usageWindow()],
  }],
  fetchedAt: "2026-08-18T12:00:00.000Z",
  stale: false,
  ...overrides,
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  // en.json is assembled from locale parts; before assembly the key renders as-is.
  assert.match(html, /(Model error|chatInput\.modelError)/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      modelError: "Invalid models.json schema",
      modelList: [],
      modelNames: {},
    }),
  );

  assert.match(html, />(No models|chatInput\.noModels)</);
  assert.match(html, /title="(No available models|chatInput\.noAvailableModels)"/);
});


test("renders goal, planning, and advisor indicators at the composer", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      model: { provider: "test", modelId: "model" },
      modelList: [{ provider: "test", modelId: "model", id: "model", name: "Test model" }],
      modelNames: {},
      activeGoal: { objective: "Ship the active goal bar", startedAt: 0 },
      activePlan: { objective: "Plan the implementation" },
      advisorEnabled: true,
    }),
  );

  assert.match(html, /Ship the active goal bar/);
  assert.match(html, /(Planning in progress|chatInput\.planningInProgress)/);
  assert.match(html, /(Advisor enabled|chatInput\.advisorEnabled)/);
});

test("renders the composer ring as an absence before the first usage read lands", () => {
  // Context usage no longer drives the ring — the top bar owns that readout,
  // and the ring gauges the plan quota, which nothing has reported yet.
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      contextUsage: { percent: 95, tokens: 95_000, contextWindow: 100_000 },
    }),
  );

  const ring = html.match(/<button type="button" title="[^"]*"[^>]*aria-haspopup="dialog"[^>]*>.*?<\/svg>/s)?.[0];
  assert.ok(ring, "expected the quota ring button in the composer");
  // An absence: dashed track, muted, and no arc element at all.
  assert.match(ring, /stroke-dasharray="2\.5 3\.5"/);
  assert.match(ring, /color:var\(--text-muted\)/);
  assert.doesNotMatch(ring, /stroke-dashoffset/);
  // Never a zero, and never a bare percentage.
  assert.doesNotMatch(ring, /(?:title|aria-label)="[^"]*\d+%/);
  // First paint is "still checking", never a verdict on the engine: nothing
  // has answered yet, so nothing may be asserted about what it reports.
  assert.match(ring, /title="(?:Plan usage — Checking plan usage…|usage\.ringUnknown)"/);
  assert.doesNotMatch(ring, /Not reported by this engine/);
  assert.doesNotMatch(ring, /does not report plan limits/);
});

test("buildQuotaView reports the binding window, its label, and the shipped thresholds", () => {
  for (const [utilization, color] of [[38, "--accent"], [64, "--accent"], [87, "--status-warning"], [96, "--status-error"]]) {
    const view = buildQuotaView(usageSnapshot({
      accounts: [{
        provider: "anthropic",
        label: "Anthropic",
        planType: "max",
        unlimited: false,
        windows: [usageWindow({ utilization, state: utilization >= 90 ? "warning" : "ok" })],
      }],
    }), false);

    assert.equal(view.known, true);
    assert.equal(view.percent, utilization);
    assert.equal(view.color, `var(${color})`);
    // The headline always names its window — never a bare percentage.
    assert.equal(view.label, "Opus · weekly");
  }
});

test("buildQuotaView orders every window by utilization and flags exhaustion", () => {
  const view = buildQuotaView(usageSnapshot({
    accounts: [{
      provider: "anthropic",
      label: "Anthropic",
      planType: "max",
      unlimited: false,
      windows: [
        usageWindow({ id: "5h", label: "5-hour window", utilization: 71 }),
        usageWindow({ id: "7d:fable", label: "Fable · weekly", utilization: 100, state: "exhausted" }),
        usageWindow({ id: "7d:sonnet", label: "Sonnet · weekly", utilization: 44 }),
      ],
    }],
  }), false);

  assert.equal(view.known, true);
  assert.deepEqual(view.windows.map((w) => w.percent), [100, 71, 44]);
  assert.deepEqual(view.windows.map((w) => w.exhausted), [true, false, false]);
  // The exhausted window binds even though another could be fuller.
  assert.equal(view.label, "Fable · weekly");
});

test("buildQuotaView keys every window uniquely across accounts on one provider", () => {
  // Two subscriptions on the same provider: window ids are unique only WITHIN
  // an account, so the raw ids collide. Duplicate React keys freeze the second
  // account's row when the list is re-sorted on the next refresh.
  const twoAccounts = [
    {
      provider: "anthropic",
      label: "Anthropic (personal@example.invalid)",
      planType: "max",
      unlimited: false,
      windows: [usageWindow({ id: "anthropic:5h", label: "5-hour window", utilization: 20 })],
    },
    {
      provider: "anthropic",
      label: "Anthropic (Work Org)",
      planType: "max",
      unlimited: false,
      windows: [usageWindow({ id: "anthropic:5h", label: "5-hour window", utilization: 55 })],
    },
  ];
  const view = buildQuotaView(usageSnapshot({ accounts: twoAccounts }), false);

  assert.equal(view.known, true);
  assert.equal(view.windows.length, 2);
  assert.equal(new Set(view.windows.map((w) => w.key)).size, 2, "window keys must be unique");
  // The labels disambiguate too, so the two rows are also visually distinct.
  assert.deepEqual(view.windows.map((w) => w.label), [
    "Anthropic (Work Org) · 5-hour window",
    "Anthropic (personal@example.invalid) · 5-hour window",
  ]);
});

test("buildQuotaView paints an exhausted low-percentage window as exhausted", () => {
  // omp reports status "rejected" at 12% used: the provider is refusing work
  // on this window regardless of the number, so it binds AND it must not be
  // accent-coloured next to its own red "Exhausted" badge.
  const view = buildQuotaView(usageSnapshot({
    accounts: [{
      provider: "anthropic",
      label: "Anthropic",
      planType: "max",
      unlimited: false,
      windows: [
        usageWindow({ id: "5h", label: "5-hour window", utilization: 12, state: "exhausted" }),
        usageWindow({ id: "7d", label: "weekly", utilization: 44, state: "ok" }),
      ],
    }],
  }), false);

  assert.equal(view.known, true);
  assert.equal(view.label, "5-hour window");
  assert.equal(view.percent, 12);
  assert.equal(view.state, "exhausted");
  assert.equal(view.color, "var(--status-error)");

  const binding = view.windows.find((entry) => entry.label === "5-hour window");
  assert.equal(binding.exhausted, true);
  assert.equal(binding.state, "exhausted");
  assert.equal(binding.color, "var(--status-error)", "the row's percentage must match its badge");
  // A merely-warning window keeps the warning tone even when it reads low.
  const warned = buildQuotaView(usageSnapshot({
    accounts: [{
      provider: "openai-codex",
      label: "Openai Codex",
      planType: "plus",
      unlimited: false,
      windows: [usageWindow({ id: "7d", label: "weekly", utilization: 5, state: "warning" })],
    }],
  }), false);
  assert.equal(warned.color, "var(--status-warning)");
});

test("buildQuotaView distinguishes never-read from the engine reporting nothing", () => {
  // Pre-first-fetch: a read is out and nothing has come back.
  const checking = buildQuotaView(null, true);
  assert.equal(checking.known, false);
  assert.equal(checking.titleKey, "usage.checking");
  assert.equal(checking.noteKey, null);
  // The footer must not contradict the headline with "No quota signal".
  assert.equal(checking.scopeKey, "usage.checkingScope");

  // Transport failure (502, restarting server) and the settled never-loaded
  // state: Cody does not know, and says exactly that.
  for (const absent of [buildQuotaView(null, false, true), buildQuotaView(null, false, false), buildQuotaView(null, true, true)]) {
    assert.equal(absent.known, false);
    assert.equal(absent.titleKey, "usage.unavailableTitle");
    assert.equal(absent.noteKey, "usage.unavailableNote");
    assert.equal(absent.scopeKey, "usage.unavailableScope");
    // Never the claim that the engine reports no limits — nothing established that.
    assert.notEqual(absent.titleKey, "usage.notReported");
    assert.notEqual(absent.scopeKey, "usage.noQuotaSignal");
    assert.equal(absent.percent, undefined);
  }

  // Only an actual answer from the engine may say the engine reports nothing.
  const answered = buildQuotaView(usageSnapshot({ available: false, accounts: [] }), false, true);
  assert.equal(answered.titleKey, "usage.notReported");
  assert.equal(answered.scopeKey, "usage.noQuotaSignal");
});

test("buildQuotaView distinguishes unlimited, unreported, and still-loading", () => {
  const unlimited = buildQuotaView(usageSnapshot({
    accounts: [{ provider: "local", label: "Local", planType: null, unlimited: true, windows: [] }],
  }), false);
  assert.equal(unlimited.known, false);
  assert.equal(unlimited.titleKey, "usage.unlimitedTitle");
  assert.equal(unlimited.scopeKey, "usage.unlimited");

  const unreported = buildQuotaView(usageSnapshot({ available: false, accounts: [], reason: "the engine exposes no usage endpoint" }), false);
  assert.equal(unreported.known, false);
  assert.equal(unreported.titleKey, "usage.notReported");
  assert.equal(unreported.reason, "the engine exposes no usage endpoint");

  // A machine reason code must not leak into the popover as prose.
  const coded = buildQuotaView(usageSnapshot({ available: false, accounts: [], reason: "engine_unsupported" }), false);
  assert.equal(coded.reason, null);

  const loading = buildQuotaView(null, true);
  assert.equal(loading.known, false);
  assert.equal(loading.titleKey, "usage.checking");
  assert.equal(loading.noteKey, null);

  for (const view of [unlimited, unreported, coded, loading]) {
    // An absence has no percentage to render, so nothing can print 0%.
    assert.equal(view.percent, undefined);
    assert.equal(view.color, "var(--text-muted)");
  }
});