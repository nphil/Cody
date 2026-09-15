import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner, QuotaPopover, buildQuotaView } = await jiti.import("./ChatInput.tsx");

const usageWindow = (overrides) => ({
  id: "anthropic:7d:opus",
  label: "Opus · weekly",
  utilization: 38,
  resetsAt: "2026-08-23T09:00:00.000Z",
  state: "ok",
  ...overrides,
});

const usageAccount = (overrides) => ({
  provider: "anthropic",
  label: "Anthropic",
  planType: "max",
  unlimited: false,
  windows: [],
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

const locales = Object.fromEntries(
  await Promise.all(["en", "ja", "zh-CN"].map(async (name) => [
    name,
    JSON.parse(await readFile(new URL(`../lib/i18n/locales/${name}.json`, import.meta.url), "utf8")),
  ])),
);

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

test("labels the queued bar by its first kind and only offers Steer for follow-ups", () => {
  const renderQueued = (queuedMessages) => renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onPromoteQueuedToSteer() {},
      isStreaming: true,
      queuedMessages,
    }),
  );

  const followUpHtml = renderQueued({
    followUp: ["Follow-up task"],
    steering: [],
  });
  assert.match(followUpHtml, />(Queued follow-up|chatInput\.queuedFollowUp)</);
  assert.match(followUpHtml, />(Steer|chatInput\.queuedSteerAction)</);

  const steerHtml = renderQueued({
    followUp: [],
    steering: ["Already prioritized task"],
  });
  assert.match(steerHtml, />(Queued steer|chatInput\.queuedSteer)</);
  assert.doesNotMatch(steerHtml, />(Steer|chatInput\.queuedSteerAction)</);
});

const ompEngine = { id: "omp", displayName: "OMP", shortName: "omp", experimental: false };

test("renders the composer ring as an absence before the first usage read lands", () => {
  // The ring gauges the plan quota, which nothing has reported yet — context
  // usage lives in the top bar and never drove this gauge.
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      engine: ompEngine,
    }),
  );

  const ring = html.match(/<button type="button" title="[^"]*"[^>]*aria-haspopup="dialog"[^>]*>.*?<\/svg>/s)?.[0];
  assert.ok(ring, "expected the quota ring button in the composer");
  // An absence has no reported-value arc or percentage.
  assert.doesNotMatch(ring, /stroke-dashoffset/);
  // Never a zero, and never a bare percentage.
  assert.doesNotMatch(ring, /(?:title|aria-label)="[^"]*\d+%/);
  // First paint is "still checking", never a verdict on the engine: nothing
  // has answered yet, so nothing may be asserted about what it reports.
  assert.match(ring, /title="(?:Usage: Checking usage…|usage\.ringUnknown)"/);
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
  // The labels disambiguate too — by position ("Primary"/"Secondary"), never
  // by the raw identity or org name the account's own label carries.
  assert.deepEqual(view.windows.map((w) => w.label), [
    "Claude · Secondary · 5-hour window",
    "Claude · Primary · 5-hour window",
  ]);
});

test("the popover lists every sibling account serving the selected model's provider, by position only", () => {
  const snapshot = usageSnapshot({
    accounts: [
      {
        provider: "anthropic",
        id: "acct-1",
        identity: "nitinphilip@gmail.com",
        label: "Anthropic (nitinphilip@gmail.com's Organization)",
        planType: "max",
        unlimited: false,
        windows: [usageWindow({
          id: "7d", label: "weekly", utilization: 100, state: "exhausted", resetsAt: "2026-09-15T00:00:00.000Z",
        })],
      },
      {
        provider: "anthropic",
        id: "acct-2",
        identity: "nathanrkx@gmail.com",
        label: "Anthropic (nathanrkx@gmail.com's Organization)",
        planType: "max",
        unlimited: false,
        windows: [usageWindow({
          id: "7d", label: "weekly", utilization: 1, state: "ok", resetsAt: "2026-09-20T00:00:00.000Z",
        })],
      },
      {
        provider: "openai-codex",
        id: "acct-3",
        identity: null,
        label: "Openai Codex",
        planType: "plus",
        unlimited: false,
        windows: [usageWindow({ id: "7d", label: "weekly", utilization: 63, state: "warning" })],
      },
    ],
  });
  const model = { provider: "anthropic", modelId: "claude-fable-5-1" };
  const view = buildQuotaView(snapshot, false, false, model);

  assert.equal(view.known, true);
  // omp already rotated onto the second (unexhausted) account; the ring
  // gauges what is actually serving, never the exhausted sibling.
  assert.equal(view.percent, 1);
  assert.equal(view.state, "ok");

  assert.equal(view.accounts.length, 2);
  assert.deepEqual(view.accounts.map((a) => a.state), ["serving", "limited"]);
  assert.deepEqual(view.accounts.map((a) => a.percent), [1, 100]);
  const limited = view.accounts.find((a) => a.state === "limited");
  assert.equal(limited.resetsAt, "2026-09-15T00:00:00.000Z");
  // Position in ORIGINAL snapshot order, never rank order — and never the
  // raw identity/org name either account actually carries.
  assert.deepEqual(view.accounts.map((a) => a.label), ["Secondary", "Primary"]);
  assert.ok(view.accounts.every((a) => !a.label.includes("@") && !a.label.includes("Organization")));

  // Both anthropic siblings are already covered above; "Other limits" keeps
  // only the other provider's window, never a duplicate of either of these.
  assert.deepEqual(view.others.map((entry) => entry.provider), ["openai-codex"]);
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

/**
 * The ring answers for ONE model.
 *
 * Quota is per provider: an exhausted week on a provider this conversation does
 * not touch cannot stop the next turn, and a ring that screams about it is
 * simply wrong. The selection rules themselves live in lib/usage/select (tested
 * there); what these pin is that the composer's view actually uses them, and
 * that what drops out of the ring stays visible somewhere.
 */

test("the ring gauges the selected model's provider, not the worst one on the box", () => {
  // The owner's live instance, exactly: Codex spent, chatting to the other one.
  const snapshot = usageSnapshot({
    accounts: [
      usageAccount({
        windows: [
          usageWindow({ id: "5h", label: "5-hour window", utilization: 7, state: "ok" }),
          usageWindow({ id: "7d", label: "weekly", utilization: 14, state: "ok" }),
        ],
      }),
      usageAccount({
        provider: "openai-codex",
        label: "Openai Codex",
        planType: "plus",
        windows: [usageWindow({ id: "7d", label: "weekly", utilization: 100, state: "exhausted" })],
      }),
    ],
  });

  // Account-wide — the reading that used to drive the ring, and misleads.
  const global = buildQuotaView(snapshot, false);
  assert.equal(global.percent, 100);
  assert.equal(global.color, "var(--status-error)");

  const view = buildQuotaView(snapshot, false, false, { provider: "anthropic", modelId: "vendor-b-2" });
  assert.equal(view.known, true);
  assert.equal(view.percent, 14);
  assert.equal(view.state, "ok");
  assert.equal(view.label, "Claude · weekly");
  // Not red, not full: the ring reports what this conversation actually spends.
  assert.equal(view.color, "var(--accent)");
  assert.notEqual(view.color, "var(--status-error)");
  // Only the windows that can stop THIS model, most binding first.
  assert.deepEqual(view.windows.map((w) => w.percent), [14, 7]);
  assert.ok(view.windows.every((w) => !w.exhausted));
  // …and the spent Codex week is still reported, just never in the ring.
  assert.deepEqual(
    view.others.map((entry) => [entry.account, entry.label, entry.percent, entry.exhausted]),
    [["Codex", "weekly", 100, true]],
  );
});

test("a window scoped to another model tier neither binds the ring nor disappears", () => {
  const snapshot = usageSnapshot({
    accounts: [usageAccount({
      windows: [
        // OMP currently marks some tiered Codex windows shared too. The tier
        // still wins: this exhausted bucket must not bind a different model.
        usageWindow({ id: "7d:tier-a", label: "Tier-a · weekly", utilization: 100, state: "exhausted", tier: "tier-a", shared: true }),
        usageWindow({ id: "5h", label: "5-hour window", utilization: 20, state: "ok" }),
      ],
    })],
  });

  const other = buildQuotaView(snapshot, false, false, { provider: "anthropic", modelId: "vendor-tier-b-1" });
  assert.equal(other.known, true);
  assert.equal(other.percent, 20);
  assert.equal(other.label, "5-hour window");
  assert.equal(other.color, "var(--accent)");
  assert.deepEqual(other.windows.map((w) => w.label), ["5-hour window"]);
  // Excluded from the gauge, not from the popover.
  assert.deepEqual(
    other.others.map((entry) => [entry.account, entry.label, entry.exhausted]),
    [["Claude", "Tier-a · weekly", true]],
  );

  // The tier's own models still see it bind, in red.
  const owned = buildQuotaView(snapshot, false, false, { provider: "anthropic", modelId: "vendor-tier-a-1" });
  assert.equal(owned.percent, 100);
  assert.equal(owned.state, "exhausted");
  assert.equal(owned.color, "var(--status-error)");
  assert.deepEqual(owned.windows.map((w) => w.percent), [100, 20]);
  // Nothing is left over, so there is no de-emphasised list to draw.
  assert.deepEqual(owned.others, []);
});

test("no quota for the provider and no quota for the model are different answers", () => {
  const metered = usageAccount({
    windows: [usageWindow({ id: "5h", label: "5-hour window", utilization: 20, state: "ok" })],
  });
  const tieredOnly = usageAccount({
    windows: [usageWindow({ id: "7d:tier-a", label: "Tier-a · weekly", utilization: 100, state: "exhausted", tier: "tier-a" })],
  });

  // 1 — no account serves this model's provider at all (a local runtime).
  const unmetered = buildQuotaView(
    usageSnapshot({ accounts: [metered] }), false, false, { provider: "llama-swap", modelId: "local-1" },
  );
  assert.equal(unmetered.known, false);
  assert.equal(unmetered.titleKey, "usage.modelUnmetered");
  assert.equal(unmetered.noteKey, "usage.modelUnmeteredNote");
  assert.equal(unmetered.scopeKey, "usage.modelUnmeteredScope");
  assert.equal(unmetered.percent, undefined);
  assert.equal(unmetered.color, "var(--text-muted)");
  // The metered provider is another account's business, and still on screen.
  assert.deepEqual(unmetered.others.map((entry) => entry.label), ["5-hour window"]);

  // 2 — the provider DOES report quota; none of it constrains this model. The
  // copy has to say that, because the quota exists and will bite another model.
  const unconstrained = buildQuotaView(
    usageSnapshot({ accounts: [tieredOnly] }), false, false, { provider: "anthropic", modelId: "vendor-tier-b-1" },
  );
  assert.equal(unconstrained.known, false);
  assert.equal(unconstrained.titleKey, "usage.modelUnconstrained");
  assert.equal(unconstrained.noteKey, "usage.modelUnconstrainedNote");
  assert.equal(unconstrained.scopeKey, "usage.modelUnconstrainedScope");
  assert.equal(unconstrained.percent, undefined);
  // Never "this engine reports no limits" — it reported one, right here.
  assert.notEqual(unconstrained.titleKey, unmetered.titleKey);
  assert.notEqual(unconstrained.titleKey, "usage.notReported");
  assert.deepEqual(
    unconstrained.others.map((entry) => [entry.label, entry.exhausted]),
    [["Tier-a · weekly", true]],
  );

  // 3 — windows that really do bind: the ordinary reading.
  const known = buildQuotaView(
    usageSnapshot({ accounts: [metered] }), false, false, { provider: "anthropic", modelId: "vendor-tier-b-1" },
  );
  assert.equal(known.known, true);
  assert.equal(known.label, "5-hour window");
  assert.equal(known.percent, 20);
  assert.deepEqual(known.others, []);

});

test("an unmetered account for the selected model reads as unmetered, not as a limit", () => {
  const view = buildQuotaView(usageSnapshot({
    accounts: [
      usageAccount({ provider: "llama-swap", label: "Llama Swap", planType: null, unlimited: true, windows: [] }),
      usageAccount({ windows: [usageWindow({ id: "5h", label: "5-hour window", utilization: 80, state: "warning" })] }),
    ],
  }), false, false, { provider: "llama-swap", modelId: "local-1" });

  assert.equal(view.known, false);
  assert.equal(view.titleKey, "usage.modelUnmetered");
  assert.equal(view.color, "var(--text-muted)");
  // The metered account next door does not colour anything here.
  assert.deepEqual(view.others.map((entry) => [entry.account, entry.percent]), [["Claude", 80]]);
});

test("the model-scoped ring keeps the shipped 70/90 thresholds and the exhausted override", () => {
  const model = { provider: "anthropic", modelId: "vendor-b-2" };
  for (const [utilization, color] of [[38, "--accent"], [64, "--accent"], [87, "--status-warning"], [96, "--status-error"]]) {
    const view = buildQuotaView(usageSnapshot({
      accounts: [usageAccount({
        windows: [usageWindow({ id: "5h", label: "5-hour window", utilization, state: utilization >= 90 ? "warning" : "ok" })],
      })],
    }), false, false, model);
    assert.equal(view.percent, utilization);
    assert.equal(view.color, `var(${color})`);
  }

  // A refused window is red at any percentage, and binds over a fuller one.
  const rejected = buildQuotaView(usageSnapshot({
    accounts: [usageAccount({
      windows: [
        usageWindow({ id: "5h", label: "5-hour window", utilization: 12, state: "exhausted" }),
        usageWindow({ id: "7d", label: "weekly", utilization: 44, state: "ok" }),
      ],
    })],
  }), false, false, model);
  assert.equal(rejected.label, "5-hour window");
  assert.equal(rejected.percent, 12);
  assert.equal(rejected.color, "var(--status-error)");
});


test("the ring's tooltip names the model it is answering for", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      model: { provider: "anthropic", modelId: "vendor-b-2" },
      modelList: [{ provider: "anthropic", modelId: "vendor-b-2", id: "vendor-b-2", name: "Vendor B2" }],
      modelNames: {},
      engine: ompEngine,
    }),
  );

  const ring = html.match(/<button type="button" title="[^"]*"[^>]*aria-haspopup="dialog"[^>]*>.*?<\/svg>/s)?.[0];
  assert.ok(ring, "expected the quota ring button in the composer");
  // Whatever it says, it says which model it is about — a ring read at a glance
  // must never be attributed to the wrong conversation.
  assert.match(ring, /title="[^"]*Vendor B2[^"]*"/);
  assert.match(ring, /aria-label="[^"]*Vendor B2[^"]*"/);
  // Still an absence before the first read lands: no reported-value arc or percentage.
  assert.doesNotMatch(ring, /stroke-dashoffset/);
  assert.doesNotMatch(ring, /(?:title|aria-label)="[^"]*\d+%/);
});
/**
 * The attach path, pinned at the seam.
 *
 * Compression itself is a canvas operation (lib/image-compress.ts, decision half
 * unit-tested in lib/image-compress.test.mjs) and cannot run here; what CAN be
 * pinned without a browser is the wiring — that every attached image goes
 * through the compressor, that a file the browser cannot decode is reported per
 * file instead of vanishing, and that nothing can be sent while an attachment is
 * still being prepared or once it would overflow one RPC frame.
 */
const composerSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("queued message deletion requires the shared accessible confirmation", () => {
  const deleteHandler = composerSource.slice(
    composerSource.indexOf("const handleQueuedDelete"),
    composerSource.indexOf("const handleQueuedSteer"),
  );
  assert.match(deleteHandler, /setQueuedDeleteTarget\(\{ text: firstQueued\.text, draftKey, queue: queuedMessages \}\)/);
  assert.doesNotMatch(deleteHandler, /onRemoveQueuedMessage\?\.\(firstQueued\.text\)/);

  const dialog = composerSource.slice(
    composerSource.indexOf("<ConfirmDialog"),
    composerSource.indexOf("{/* Hidden file input */}"),
  );
  assert.match(dialog, /open=\{activeDeleteTarget !== null\}/);
  assert.match(dialog, /chatInput\.queuedDeleteConfirmBody/);
  assert.match(dialog, /cancelLabel=\{t\("chatInput\.cancel"\)\}/);
  assert.match(dialog, /danger/);
  assert.match(dialog, /onRemoveQueuedMessage\?\.\(activeDeleteTarget\.text\)/);
});

test("every attached image goes through the compressor, and failures are named", () => {
  const attach = composerSource.slice(
    composerSource.indexOf("const processImageFiles = useCallback"),
    composerSource.indexOf("const processTextFiles = useCallback"),
  );
  assert.match(attach, /prepareImageForAttachment\(file,/);
  // Per file, never a silent drop: an undecodable photo says which one and what
  // the browser can read.
  assert.match(attach, /error instanceof UnsupportedImageError/);
  assert.match(attach, /chatInput\.imageUndecodable/);
  assert.match(attach, /chatInput\.imageReadFailed/);
  assert.match(attach, /setAttachError\(failures\.length \? failures\.join\("\\n"\) : null\)/);
  // The composer shows it is busy, and stops showing it whatever happens.
  assert.match(attach, /setPreparingImageCount\(\(count\) => count \+ imageFiles\.length\)/);
  assert.match(attach, /finally \{[\s\S]*setPreparingImageCount/);
});


test("the over-budget message names the attachment to remove", () => {
  const budget = composerSource.slice(
    composerSource.indexOf("const budgetError = useCallback"),
    composerSource.indexOf("const handleSend = useCallback"),
  );
  assert.match(budget, /checkPromptFrameBudget\(\{ message: composedMessage, images \}\)/);
  assert.match(budget, /chatInput\.attachmentsTooLargeNamed/);
  assert.match(budget, /chatInput\.attachmentsTooLarge/);
  // A text-only overflow has no attachment to blame and must not claim one.
  assert.match(budget, /if \(!verdict\.largest\) return t\("chatInput\.messageTooLarge"/);
});

test("text attachment admission shares byte and slot accounting with draft restore", () => {
  const draftRestore = composerSource.slice(
    composerSource.indexOf("function draftFilesToAttachedFiles"),
    composerSource.indexOf("function revokeImagePreview"),
  );
  assert.match(draftRestore, /selectTextAttachments\(candidates, \{ usedBytes: 0, usedSlots: 0 \}\)/);

  const freshDrop = composerSource.slice(
    composerSource.indexOf("const processTextFiles = useCallback"),
    composerSource.indexOf("const processFiles = useCallback"),
  );
  assert.match(freshDrop, /selectTextAttachments\(files, \{/);
  assert.match(freshDrop, /attachedTextFilesRef\.current\.reduce\(\(total, file\) => total \+ file\.size, 0\)/);
  assert.match(freshDrop, /pendingTextFileBytesRef\.current/);
  assert.match(freshDrop, /usedSlots: attachedTextFilesRef\.current\.length \+ pendingTextFileCountRef\.current/);
  assert.match(freshDrop, /pendingTextFileBytesRef\.current \+= textFiles\.reduce/);
  assert.match(freshDrop, /pendingTextFileBytesRef\.current -= textFiles\.reduce/);
});


test("the ring gauges the shortest healthy window; an exhausted longer one still binds", () => {
  const fiveHour = () => usageWindow({ id: "5h", label: "5-hour window", utilization: 14, windowMs: 18_000_000, resetsAt: "2026-08-18T17:00:00.000Z" });
  const healthy = buildQuotaView(usageSnapshot({
    accounts: [usageAccount({
      windows: [
        usageWindow({ id: "7d", label: "weekly", utilization: 73, state: "warning", windowMs: 604_800_000 }),
        fiveHour(),
      ],
    })],
  }), false, false, { provider: "anthropic", modelId: "claude-fable-5" });

  // The fuller week is context; the current five hours are what this turn
  // spends against, so they take the ring and the first row.
  assert.equal(healthy.percent, 14);
  assert.equal(healthy.label, "5-hour window");
  assert.deepEqual(healthy.windows.map((w) => [w.label, w.percent]), [
    ["5-hour window", 14],
    ["weekly", 73],
  ]);

  // …but a refused week stops the model whatever the 5h window says.
  const spent = buildQuotaView(usageSnapshot({
    accounts: [usageAccount({
      windows: [
        usageWindow({ id: "7d", label: "weekly", utilization: 100, state: "exhausted", windowMs: 604_800_000 }),
        fiveHour(),
      ],
    })],
  }), false, false, { provider: "anthropic", modelId: "claude-fable-5" });
  assert.equal(spent.percent, 100);
  assert.equal(spent.label, "weekly");
  assert.equal(spent.state, "exhausted");
  assert.equal(spent.color, "var(--status-error)");
});

test("the popover keeps the selected quota primary and collapses unrelated limits", () => {
  const snapshot = usageSnapshot({
    accounts: [
      usageAccount({
        planType: "max",
        resetCredits: { availableCount: 2, earliestExpiresAt: "2026-09-15T00:00:00.000Z" },
        windows: [
          usageWindow({ id: "5h", label: "5-hour window", utilization: 62, windowMs: 18_000_000, resetsAt: "2026-08-18T17:00:00.000Z" }),
          usageWindow({ id: "7d", label: "weekly", utilization: 23, windowMs: 604_800_000 }),
        ],
      }),
      usageAccount({
        provider: "openai-codex",
        label: "Openai Codex",
        planType: "plus",
        windows: [usageWindow({ id: "7d", label: "weekly", utilization: 100, state: "exhausted", windowMs: 604_800_000 })],
      }),
      usageAccount({
        provider: "google",
        label: "Google",
        planType: null,
        windows: [usageWindow({ id: "daily", label: "daily", utilization: 12, windowMs: 86_400_000 })],
      }),
    ],
  });
  const resetCredits = {
    loading: false,
    redeeming: false,
    refresh() {},
    redeem: async () => ({ outcome: "reset", accountId: "claude", creditId: "credit-1" }),
    snapshot: {
      available: true,
      fetchedAt: "2026-08-18T12:30:00.000Z",
      accounts: [{ id: "claude", label: "Claude account", availableCount: 2, canRedeem: true, credits: [{ id: "credit-1", expiresAt: "2026-09-15T00:00:00.000Z" }] }],
    },
  };
  const quota = buildQuotaView(snapshot, false, false, { provider: "anthropic", modelId: "claude-fable-5" });
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, {
      resetCredits,
      quota,
      provider: "anthropic",
      modelName: "Fable",
      now: Date.parse("2026-08-18T12:30:00.000Z"),
    }),
  );

  // The selected model's binding window stays primary and retains the raw
  // reported plan. Unrelated provider windows stay available but collapsed.
  assert.match(html, /62%/);
  assert.match(html, /max/);
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /<details open/);
  assert.match(html, /Codex · Weekly/);
  assert.match(html, /width:100%[^"]*background:var\(--status-error\)/);
  // A positive reset still exposes its account-specific expiry and action.
  assert.match(html, /Claude account/);
  assert.match(html, /<button/);
});


test("the popover expands windows used by this session and keeps unrelated limits collapsed", () => {
  const selected = { provider: "anthropic", modelId: "claude-fable-5" };
  const activeModels = [
    { provider: "anthropic", modelId: "claude-fable-5", uses: [{ kind: "main", label: "this conversation" }] },
    {
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      uses: [
        { kind: "subagent", label: "scout" },
        { kind: "fallback", label: "this conversation" },
      ],
    },
  ];
  const quota = buildQuotaView(usageSnapshot({
    accounts: [
      usageAccount({ windows: [usageWindow({ id: "anthropic:weekly", label: "weekly", utilization: 34 })] }),
      usageAccount({
        provider: "openai-codex",
        label: "Openai Codex",
        planType: "plus",
        windows: [usageWindow({ id: "codex:weekly", label: "weekly", utilization: 78, state: "warning" })],
      }),
      usageAccount({
        provider: "google",
        label: "Google",
        planType: null,
        windows: [usageWindow({ id: "google:daily", label: "daily", utilization: 91, state: "warning" })],
      }),
    ],
  }), false, false, selected, activeModels);

  assert.deepEqual(
    quota.inUse.map((entry) => [entry.provider, entry.label, entry.uses.map((use) => use.kind)]),
    [["openai-codex", "Codex · weekly", ["subagent", "fallback"]]],
  );
  assert.deepEqual(quota.others.map((entry) => entry.provider), ["google"]);

  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, {
      quota,
      provider: selected.provider,
      modelName: "Claude Fable 5",
      activeModels,
      now: Date.parse("2026-08-18T12:30:00.000Z"),
    }),
  );

  // The session-used window is a normal section, while the unrelated one is
  // still the one collapsed details group that cannot affect the selected model.
  assert.ok(html.includes("Also in use (1)"));
  assert.match(html, /Codex · Weekly/);
  assert.match(html, /Subagent scout, Fallback for this conversation/);
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<details open/);
  assert.ok(html.includes("Other limits (1) · Does not affect this model"));
  assert.match(html, /Selected model, all sessions · Also in use in this session/);
});

test("the quota primary follows Smart's actual resolved model", () => {
  const actualModel = { provider: "openai-codex", modelId: "gpt-5.6-terra" };
  const quota = buildQuotaView(usageSnapshot({
    accounts: [usageAccount({
      provider: "openai-codex",
      label: "Openai Codex",
      planType: "plus",
      windows: [usageWindow({ id: "codex:weekly", label: "weekly", utilization: 41 })],
    })],
  }), false, false, actualModel, [{
    ...actualModel,
    uses: [{ kind: "smart", label: "this conversation" }],
  }]);

  assert.equal(quota.known, true);
  assert.equal(quota.provider, "openai-codex");
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, {
      quota,
      provider: actualModel.provider,
      modelName: "GPT 5.6 Terra",
      now: Date.parse("2026-08-18T12:30:00.000Z"),
    }),
  );
  assert.ok(html.includes("GPT 5.6 Terra Usage"));
  assert.match(html, /Weekly/);
  assert.doesNotMatch(html, /Smart Usage/);
});

test("the popover retains an explicitly reported zero saved-reset balance", () => {
  const quota = buildQuotaView(usageSnapshot({
    accounts: [usageAccount({
      resetCredits: { availableCount: 0, earliestExpiresAt: null },
      windows: [usageWindow({ id: "7d", label: "weekly", windowMs: 604_800_000 })],
    })],
  }), false, false, { provider: "anthropic", modelId: "claude-fable-5" });
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, {
      resetCredits: { loading: false, redeeming: false, refresh() {}, redeem: async () => ({ outcome: "no_credit", accountId: "claude" }), snapshot: { available: true, fetchedAt: "2026-08-18T12:30:00.000Z", accounts: [{ id: "claude", label: "Claude account", availableCount: 0, canRedeem: false, credits: [] }] } },
      quota, provider: "anthropic", modelName: "Fable", now: Date.now(),
    }),
  );

  assert.match(html, /Saved resets · 0/);
  assert.match(html, /No saved resets available./);
  assert.doesNotMatch(html, /Claude account/);
});

test("the absent popover names the silence without inventing sections", () => {
  const quota = buildQuotaView(usageSnapshot({
    accounts: [usageAccount({
      windows: [usageWindow({ id: "5h", label: "5-hour window", utilization: 80, state: "warning" })],
    })],
  }), false, false, { provider: "llama-swap", modelId: "qwen3-coder" });
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, { quota, provider: "llama-swap", modelName: "Qwen3 Coder", now: Date.now() }),
  );

  // Another provider's limit remains present in the collapsed secondary section.
  assert.match(html, /<details/);
  assert.match(html, /80%/);
});


test("the quota ring is absent on an engine that reports no plan quota", () => {
  // `omp usage --json` is the only reader Cody has, and /api/usage answers
  // {available:false, reason} for every other engine — a value, not an error.
  // A ring that can only ever be an empty dashed circle is dead chrome.
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
 engine: { id: "codex", displayName: "Codex", shortName: "Codex", experimental: true },
    }),
  );

  assert.doesNotMatch(html, /aria-haspopup="dialog"/);
});

test("engine-specific composer copy names the active engine while Smart remains neutral", () => {
  const engineNamed = [
    "chatInput.smartModelHint",
    "chatInput.smartModelUnavailable",
    "chatInput.thinkingAuto",
    "chatInput.toolPresetCoreWarning",
    "chatInput.toolPresetCoreWarningNoSubagents",
    "chatInput.groupEngineBuiltin",
    "agentSession.startingAgent",
  ];
  for (const [name, dict] of Object.entries(locales)) {
    assert.equal(dict["chatInput.smartModel"], "Smart", name + ".json must keep Smart neutral");
    for (const key of engineNamed) {
      assert.ok(key in dict, name + ".json is missing " + key);
      assert.ok(dict[key].includes("{name}"), name + ".json " + key + " must name the active engine");
      assert.doesNotMatch(dict[key], /\bomp\b/i, name + ".json " + key + " still hardcodes omp");
    }
    assert.doesNotMatch(dict["errors.session_file_too_large"], /omp/i);
  }
});

test("the rpc-dialect slash builtins are offered only where the engine answers them", () => {
  // compact / reload / name / session / copy are rpc-dialect commands wearing
  // a slash; an ACP engine answers all five "unsupported". The web-native
  // prompt-composing commands need nothing from the engine and stay.
  assert.match(composerSource, /\[\.\.\.WEB_SLASH_COMMAND_DEFS, \.\.\.\(chatExtras \? RPC_SLASH_COMMAND_DEFS : \[\]\)\]/);
  // The interception set stays complete whatever the engine: a hand-typed
  // /compact must still reach the dispatcher, which answers with the engine's
  // own honest "unsupported" rather than sending prose to the model.
  assert.match(
    composerSource,
    /const CLIENT_BUILTIN_COMMAND_NAMES = new Set\(\s*\[\.\.\.WEB_SLASH_COMMAND_DEFS, \.\.\.RPC_SLASH_COMMAND_DEFS\]/,
  );
  // Smart resolves omp's model ROLES; the row follows the models capability,
  // not chatExtras, which pi has and roles it does not.
  assert.match(composerSource, /\{capabilities\.models && \(\s*<button/);
});

test("slash completion is token-aware and preserves prompt text", () => {
  assert.match(composerSource, /extractSlashQuery\(value, slashCursor\)/);
  assert.match(composerSource, /const slashQuery = slashMatch\?\.query \?\? null/);
  assert.match(composerSource, /const before = match \? value\.slice\(0, match\.start\) : ""/);
  assert.match(composerSource, /const after = match \? value\.slice\(match\.end\) : ""/);
  assert.match(composerSource, /onClick=\{\(e\) => updateInputCursor\(e\.currentTarget\)\}/);
  assert.match(composerSource, /slashCompletionApplyingRef/);
});

// ── OpenRouter's prepaid balance ────────────────────────────────────────────

/** The account snapshot GET /api/openrouter/account answers with. */
const openRouterAccount = (overrides = {}) => ({
  snapshot: {
    available: true,
    keySource: "engine",
    credits: { totalCredits: 40, totalUsage: 31.74, remaining: 8.26 },
    key: {
      label: "sk-or-v1-15f...879", usage: 31.1, usageDaily: 27.27, usageWeekly: 27.27,
      usageMonthly: 27.27, limit: null, limitRemaining: null, freeTier: false,
      expiresAt: null, isManagementKey: false,
    },
    activity: null,
    hasManagementKey: false,
    error: null,
    fetchedAt: "2026-08-20T09:00:00.000Z",
    stale: false,
    ...overrides,
  },
  loading: false,
  failed: false,
  refresh: () => {},
  refreshNow: async () => null,
});

test("an OpenRouter model is prepaid, not unmetered", () => {
  // The bug this pins: omp reports NO quota windows for openrouter (verified
  // against `omp usage --json`), so the model fell through to
  // QUOTA_MODEL_UNMETERED — "nothing it runs counts against a quota" — about
  // an account that is spending real money per token.
  const quota = buildQuotaView(
    usageSnapshot({}),
    false,
    false,
    { provider: "openrouter", modelId: "anthropic/claude-opus-5" },
  );
  assert.equal(quota.known, false, "a balance has no honest percentage to gauge");
  assert.equal(quota.titleKey, "usage.prepaidTitle");
  assert.notEqual(quota.titleKey, "usage.modelUnmetered");
});

test("a non-gateway provider with no matching window is still unmetered", () => {
  // The counterpart: the prepaid branch must not swallow the real "no account
  // serves this provider" case for, say, a local runtime.
  const quota = buildQuotaView(usageSnapshot({}), false, false, { provider: "llama-swap", modelId: "gemma4-e4b" });
  assert.equal(quota.titleKey, "usage.modelUnmetered");
});

test("the popover states the balance, the cycle and today's spend", () => {
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, {
      quota: buildQuotaView(usageSnapshot({}), false, false, { provider: "openrouter", modelId: "anthropic/claude-opus-5" }),
      openRouter: openRouterAccount(),
      provider: "openrouter",
      modelName: "Claude Opus 5",
      now: Date.parse("2026-08-20T09:05:00.000Z"),
    }),
  );
  // The dollars left are the number that predicts whether the next turn runs.
  assert.match(html, /\$8\.26/);
  // Spent-vs-purchased is captioned, so the bar cannot be read as a quota window.
  assert.match(html, /\$31\.74/);
  assert.match(html, /\$40\.00/);
  // This key's own daily spend, distinct from the account balance.
  assert.match(html, /\$27\.27/);
  // The top-up path is honest about leaving Cody: OpenRouter removed its
  // purchase API (410 Gone), so an in-app checkout would be a lie.
  assert.match(html, /openrouter\.ai/);
  assert.doesNotMatch(html, /reports no plan limits/);
});



test("the gateway balance remains visible when an active subagent uses OpenRouter", () => {
  const selected = { provider: "anthropic", modelId: "claude-fable-5" };
  const activeModels = [
    { ...selected, uses: [{ kind: "main", label: "this conversation" }] },
    {
      provider: "openrouter",
      modelId: "deepseek/deepseek-r1:free",
      uses: [{ kind: "subagent", label: "scout" }],
    },
  ];
  const quota = buildQuotaView(usageSnapshot({
    accounts: [usageAccount({ windows: [usageWindow({ id: "anthropic:weekly", label: "weekly", utilization: 34 })] })],
  }), false, false, selected, activeModels);
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, {
      quota,
      openRouter: openRouterAccount(),
      provider: selected.provider,
      modelName: "Claude Fable 5",
      activeModels,
      now: Date.parse("2026-08-20T09:05:00.000Z"),
    }),
  );

  assert.ok(html.includes("OpenRouter credits"));
  assert.ok(html.includes("$8.26"));
  assert.ok(html.includes("In use by Subagent scout"));
  assert.ok(html.includes("Selected model, all sessions · Also in use in this session"));
});

test("the popover shows no credit section without an OpenRouter model", () => {
  // Every other provider sells a subscription and has no balance; the section
  // must not appear for one.
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, {
      quota: buildQuotaView(usageSnapshot({}), false, false, { provider: "anthropic", modelId: "claude-fable-5" }),
      provider: "anthropic",
      modelName: "Claude Fable 5",
      now: Date.parse("2026-08-20T09:05:00.000Z"),
    }),
  );
  assert.doesNotMatch(html, /OpenRouter credits/);
});

test("a missing key hides the credit section instead of showing an error", () => {
  // An OpenRouter model can be selected on an instance with no readable key;
  // an error box over a working composer is worse than an absent section.
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, {
      quota: buildQuotaView(usageSnapshot({}), false, false, { provider: "openrouter", modelId: "anthropic/claude-opus-5" }),
      openRouter: openRouterAccount({ available: false, credits: null, key: null, error: { code: "no_key", message: "No OpenRouter key is configured." } }),
      provider: "openrouter",
      modelName: "Claude Opus 5",
      now: Date.parse("2026-08-20T09:05:00.000Z"),
    }),
  );
  assert.doesNotMatch(html, /OpenRouter credits/);
  assert.doesNotMatch(html, /No OpenRouter key is configured/);
});


test("renders distinct Fast status semantics without conflating metadata and engine state", async () => {
  // The control moved into the model dropdown (a click away from SSR), so the
  // semantics are pinned where they now live: the shared derivation. The one
  // rule worth a test beyond the state table is that an unavailable Fast is
  // rendered as NOTHING rather than as a disabled control that explains itself.
  const { deriveFastModeState } = await import("../lib/fast-mode-state.ts");
  const fast = (input) => deriveFastModeState({ capable: true, ...input });

  assert.equal(fast({ supported: true }), "off");
  assert.equal(fast({ enabled: true, active: true, supported: false, unavailable: true }), "unavailable");
  assert.equal(fast({ enabled: true, active: false, supported: true }), "inactive");
  assert.equal(fast({ supported: false }), "unavailable");
  assert.equal(fast({ enabled: true }), "unverified");
  assert.equal(fast({ pending: true }), "checking");
  assert.equal(deriveFastModeState({ capable: false, supported: true }), "unavailable");

  // The composer row no longer carries it.
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false, fastModeCapable: true, fastModeSupported: true, onFastModeChange() {} }),
  );
  assert.doesNotMatch(html, /data-testid="fast-mode-toggle"/);
});

test("keeps Smart model selection free of engine and model suffixes", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      capabilities: { chatExtras: true, models: true, fastMode: false, subagents: false, skills: false },
      model: { provider: "openai", modelId: "gpt-5" },
      modelNames: { "openai/gpt-5": "GPT-5" },
      isAutoModelSelection: true,
      onModelChange() {},
    }),
  );

  assert.match(html, />Smart</);
  assert.doesNotMatch(html, /Smart[^<]*[·—]/);
});
test("keeps rpc model switches available at a turn boundary and marks session-scoped pickers unavailable", () => {
  const renderStreamingPicker = (modelChangeWhileStreaming) => renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: true,
      modelChangeWhileStreaming,
      model: { provider: "test", modelId: "test-model" },
      modelList: [{ provider: "test", id: "test-model", modelId: "test-model", name: "Test model" }],
    }),
  );
  const picker = (html) => html.match(/<button(?=[^>]*title="Change model")[^>]*>/)?.[0];

  const rpcPicker = picker(renderStreamingPicker(true));
  assert.ok(rpcPicker, "expected rpc-dialect model picker");
  assert.doesNotMatch(rpcPicker, /\sdisabled(?:=|\s|>)/);

  const sessionScopedPicker = picker(renderStreamingPicker(false));
  assert.ok(sessionScopedPicker, "expected session-scoped model picker");
  assert.match(sessionScopedPicker, /\sdisabled(?:=|\s|>)/);
});

test("renders pending switch, target reasoning, and attributed fallback detail", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      onThinkingLevelChange() {},
      isStreaming: true,
      modelChangeWhileStreaming: true,
      model: { provider: "test", modelId: "test-model" },
      modelList: [{ provider: "test", id: "test-model", modelId: "test-model", name: "Test model" }],
      modelSwitchPending: { provider: "test", modelId: "next-model", name: "Next model", phase: "waiting" },
      thinkingLevel: "low",
      thinkingLevelPending: true,
      thinkingLevelTarget: "high",
      autoModelSwitch: {
        from: "Primary",
        to: "Fallback",
        reason: "rate limit",
        job: { kind: "main", roleLabelKey: "agentSession.job.default" },
      },
    }),
  );

  assert.match(html, /data-testid="model-switch-pending"/);
  assert.match(html, /title="The current step finishes first\. Your conversation context is kept\."/);
  assert.match(html, />Applying High</);
  assert.match(html, /title="This conversation requested Primary; failed: rate limit; using Fallback."/);
});
