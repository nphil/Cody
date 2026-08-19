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

test("renders the composer ring as an absence before the first usage read lands", () => {
  // The ring gauges the plan quota, which nothing has reported yet — context
  // usage lives in the top bar and never drove this gauge.
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
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
  // The labels disambiguate too — under the brand name the owner knows the
  // subscription by, never the raw provider id.
  assert.deepEqual(view.windows.map((w) => w.label), [
    "Claude (Work Org) · 5-hour window",
    "Claude (personal@example.invalid) · 5-hour window",
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
        usageWindow({ id: "7d:tier-a", label: "Tier-a · weekly", utilization: 100, state: "exhausted", tier: "tier-a" }),
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

  // Three outcomes, three distinct sentences, in every locale Cody ships.
  for (const [name, dict] of Object.entries(locales)) {
    const headlines = [dict["usage.modelUnmetered"], dict["usage.modelUnconstrained"], dict["usage.notReported"]];
    assert.equal(new Set(headlines).size, 3, `${name} must tell the three absences apart`);
    const notes = [dict["usage.modelUnmeteredNote"], dict["usage.modelUnconstrainedNote"], dict["usage.notReportedNote"]];
    assert.equal(new Set(notes).size, 3, `${name} must explain them differently`);
  }
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

test("every quota string the model-scoped ring needs ships in all three locales", () => {
  const added = [
    "usage.modelScope",
    "usage.modelUnconstrained", "usage.modelUnconstrainedNote", "usage.modelUnconstrainedScope",
    "usage.modelUnmetered", "usage.modelUnmeteredNote", "usage.modelUnmeteredScope",
    "usage.notForThisModel", "usage.notForThisModelNote", "usage.notForThisModelRow",
    "usage.ringDetailsModel", "usage.ringModel", "usage.ringModelUnknown", "usage.titleForModel",
  ];
  for (const key of added) {
    for (const [name, dict] of Object.entries(locales)) {
      assert.equal(typeof dict[key], "string", `${name} is missing ${key}`);
      assert.ok(dict[key].trim().length > 0, `${name} leaves ${key} empty`);
    }
    // Real translations, not English copied across. The row template is
    // punctuation and placeholders only, so it is the same in every language.
    if (key !== "usage.notForThisModelRow") {
      assert.notEqual(locales.ja[key], locales.en[key], `ja must translate ${key}`);
      assert.notEqual(locales["zh-CN"][key], locales.en[key], `zh-CN must translate ${key}`);
    }
  }
  // A translation that drops a placeholder renders a sentence naming nothing.
  for (const [name, dict] of Object.entries(locales)) {
    for (const key of ["usage.ringModel", "usage.ringDetailsModel"]) {
      for (const placeholder of ["{model}", "{label}", "{percent}"]) {
        assert.ok(dict[key].includes(placeholder), `${name} dropped ${placeholder} from ${key}`);
      }
    }
    assert.ok(dict["usage.ringModelUnknown"].includes("{model}"));
    assert.ok(dict["usage.ringModelUnknown"].includes("{reason}"));
    assert.ok(dict["usage.titleForModel"].includes("{model}"));
    assert.ok(dict["usage.notForThisModelRow"].includes("{account}"));
    assert.ok(dict["usage.notForThisModelRow"].includes("{window}"));
  }
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
    }),
  );

  const ring = html.match(/<button type="button" title="[^"]*"[^>]*aria-haspopup="dialog"[^>]*>.*?<\/svg>/s)?.[0];
  assert.ok(ring, "expected the quota ring button in the composer");
  // Whatever it says, it says which model it is about — a ring read at a glance
  // must never be attributed to the wrong conversation.
  assert.match(ring, /title="[^"]*Vendor B2[^"]*"/);
  assert.match(ring, /aria-label="[^"]*Vendor B2[^"]*"/);
  // Still an absence before the first read lands: no arc, no percentage.
  assert.match(ring, /stroke-dasharray="2\.5 3\.5"/);
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

test("nothing is sent while an attachment is still being prepared or over budget", () => {
  const send = composerSource.slice(
    composerSource.indexOf("const handleSend = useCallback"),
    composerSource.indexOf("const slashQuery"),
  );
  assert.match(send, /if \(preparingImageCount > 0\) return;/);
  assert.match(send, /const tooLarge = budgetError\(composedMessage, attachedImages\);/);
  assert.match(send, /setAttachError\(tooLarge\)/);
  // The guard runs BEFORE the message leaves the composer.
  assert.ok(send.indexOf("const tooLarge") < send.indexOf("onSend(composedMessage"));

  // The send button cannot be clicked into the same race.
  assert.match(composerSource, /disabled=\{preparingImageCount > 0 \|\| \(!value\.trim\(\)/);
  // The attach affordance itself is what reports the work in progress.
  assert.match(composerSource, /preparingImageCount > 0 \? t\("chatInput\.imagePreparing"\)/);
  assert.match(composerSource, /preparingImageCount > 0 \? \(\s*\n\s*<Loader2/);
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

test("the ring keeps the geometry and the arc it shipped with", () => {
  // The gauge changed subject (the selected model, not the whole box); it did
  // not change shape. Every number here is load-bearing for how it draws.
  assert.match(composerSource, /const RING_CIRCUMFERENCE = 2 \* Math\.PI \* 9\.5;/);
  const button = composerSource.slice(
    composerSource.indexOf("title={quotaRingTitle}"),
    composerSource.indexOf("{contextPopoverOpen && ("),
  );
  assert.match(button, /width: 28,\s+height: 28,/);
  assert.match(button, /color: quota\.color,/);
  assert.match(button, /<svg width="26" height="26" viewBox="0 0 26 26"/);
  assert.match(button, /r="9\.5" fill="none" stroke="var\(--border\)" strokeWidth="2\.5"/);
  assert.match(button, /strokeDasharray=\{quota\.known \? undefined : RING_ABSENT_DASH\}/);
  assert.match(button, /stroke="currentColor" strokeWidth="2\.5" strokeLinecap="round"/);
  assert.match(button, /strokeDasharray=\{RING_CIRCUMFERENCE\}/);
  assert.match(button, /strokeDashoffset=\{RING_CIRCUMFERENCE \* \(1 - quota\.percent \/ 100\)\}/);
  assert.match(button, /transform="rotate\(-90 13 13\)"/);
  assert.match(button, /<circle cx="13" cy="13" r="2" fill="currentColor" opacity="0\.72" \/>/);
  // The arc still only exists when there is something to report.
  assert.match(button, /\{quota\.known && \(/);
});

test("a new conversation refreshes usage; switching models only re-filters the cache", () => {
  // One `omp usage --json` already carries every provider and tier, so the
  // cached snapshot answers for whichever model is selected. Exactly two things
  // may ask for a read: opening the popover, and moving to another session.
  assert.match(composerSource, /useEffect\(\(\) => \{\s*refreshUsage\(\);\s*\}, \[draftKey, refreshUsage\]\);/);
  assert.equal(composerSource.match(/refreshUsage\(\)/g).length, 2);

  const quotaMemo = composerSource.slice(
    composerSource.indexOf("const quotaProvider = model?.provider;"),
    composerSource.indexOf("const quotaPercentText"),
  );
  assert.match(quotaMemo, /buildQuotaView\(/);
  assert.match(quotaMemo, /\[usageSnapshot, usageLoading, usageFailed, quotaProvider, quotaModelId\]/);
  // A model switch must recompute, never fetch.
  assert.doesNotMatch(quotaMemo, /refreshUsage/);
});

test("the popover answers for the selected model and still shows what it excluded", () => {
  const quotaSection = composerSource.slice(
    composerSource.indexOf("function QuotaBar"),
    composerSource.indexOf("const THINKING_LEVEL_DESC_KEYS"),
  );
  // Headline: brand mark, the model it is about, the window it is quoting.
  assert.match(quotaSection, /<ProviderIcon/);
  assert.match(quotaSection, /usage\.titleForModel", \{ model: modelName \}/);
  assert.match(quotaSection, /\{quota\.known \? quota\.label : t\(quota\.titleKey\)\}/);
  // Every OTHER constraining window: the binding one lives in the headline
  // and is filtered out of the list rather than repeated as its first row.
  assert.match(quotaSection, /entry\.label !== quota\.label \|\| entry\.resetsAt !== quota\.resetsAt/);
  // The de-emphasised list of everything the ring is not gauging.
  assert.match(quotaSection, /quota\.others\.length > 0/);
  assert.match(quotaSection, /quota\.others\.map\(/);
  assert.match(quotaSection, /t\("usage\.notForThisModel"\)/);
  assert.match(quotaSection, /usage\.notForThisModelRow", \{ account: entry\.account, window: entry\.label \}/);
  assert.match(quotaSection, /t\("usage\.notForThisModelNote"\)/);
  // Both lists render through the same row component: one designed system,
  // and the excluded rows keep real bars rather than shrinking to a footnote.
  assert.match(quotaSection, /quota\.windows\.filter\([\s\S]*?\.map\(\(entry\) => \([\s\S]*?<QuotaWindowRow/);
  assert.match(quotaSection, /quota\.others\.map\(\(entry\) => \([\s\S]*?<QuotaWindowRow/);
  // De-emphasised tone for the bar — except exhaustion, which stays red.
  assert.match(quotaSection, /color=\{entry\.exhausted \? "var\(--status-error\)" : "var\(--text-dim\)"\}/);
  // The footer says whose limits these are.
  assert.match(quotaSection, /modelName \? t\("usage\.modelScope"\) : t\("usage\.accountWide"\)/);
  // The context/token/models readouts left with the top bar — nothing in the
  // composer renders them anymore.
  assert.doesNotMatch(composerSource, /chatInput\.contextUsage/);
  assert.doesNotMatch(composerSource, /chatInput\.tokenTraffic/);
  assert.doesNotMatch(composerSource, /chatInput\.modelsUsed/);
  assert.doesNotMatch(composerSource, /Section 2/);
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

test("the rendered popover keeps only quota content, branded and barred", () => {
  const snapshot = usageSnapshot({
    accounts: [
      usageAccount({
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
  const quota = buildQuotaView(snapshot, false, false, { provider: "anthropic", modelId: "claude-fable-5" });
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, {
      quota,
      provider: "anthropic",
      modelName: "Fable",
      now: Date.parse("2026-08-18T12:30:00.000Z"),
    }),
  );

  // Quota only: the context and token readouts belong to the top bar now.
  assert.doesNotMatch(html, /Context usage/);
  assert.doesNotMatch(html, /token traffic/i);
  assert.doesNotMatch(html, /Models used/);
  // Header: brand mark + "Usage · <model>" + the binding number (5h, 62%).
  assert.match(html, /Usage · Fable/);
  assert.match(html, /fill="currentColor"/);
  assert.match(html, />62%</);
  // Never the raw provider id or the corporate name — the owner runs Claude.
  assert.doesNotMatch(html, /anthropic/i);
  assert.match(html, /Codex — weekly/);
  assert.match(html, /Gemini — daily/);
  // Every excluded row carries a real bar in the shared geometry: the spent
  // Codex week stays red at full volume, the healthy Gemini day is dimmed.
  assert.match(html, /Not counted for this model/);
  assert.match(html, /width:100%[^"]*background:var\(--status-error\)/);
  assert.match(html, /width:12%[^"]*background:var\(--text-dim\);opacity:0\.55/);
  // …including their reset times, exactly like the primary rows.
  assert.ok(html.match(/resets/g).length >= 3, "excluded rows keep their reset lines");
  // The footer scopes the reading to the selected model.
  assert.match(html, /For the selected model/);
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

  // No reading: an em dash where the number would be, never a fake 0%.
  assert.match(html, />—</);
  assert.match(html, /No plan limits for this provider/);
  // The metered account next door stays visible — branded, with its bar.
  assert.match(html, /Claude — 5-hour window/);
  assert.match(html, /width:80%/);
  assert.doesNotMatch(html, /anthropic/i);
});
