import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { QuotaPopover, buildQuotaView } = await jiti.import("./QuotaPopover.tsx");

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

/* ─────────────────────────── buildQuotaView (pure) ─────────────────────────── */

test("buildQuotaView reports the binding window, its label, and the shipped thresholds", () => {
  for (const [utilization, color] of [[38, "--accent"], [64, "--accent"], [87, "--status-warning"], [96, "--status-error"]]) {
    const view = buildQuotaView(usageSnapshot({
      accounts: [{
        provider: "anthropic",
        label: "Anthropic",
        planType: "max",
        unlimited: false,
        windows: [usageWindow({ utilization })],
      }],
    }), false);
    assert.equal(view.known, true);
    assert.equal(view.percent, utilization);
    assert.equal(view.color, `var(${color})`);
    assert.equal(view.label, "Opus · weekly");
    assert.equal(view.planType, "max");
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
        usageWindow({ id: "a", label: "5-hour window", utilization: 20 }),
        usageWindow({ id: "b", label: "weekly", utilization: 90, state: "exhausted" }),
      ],
    }],
  }), false);
  assert.equal(view.known, true);
  assert.deepEqual(view.windows.map((w) => w.percent), [90, 20]);
  assert.equal(view.windows[0].exhausted, true);
  assert.equal(view.windows[1].exhausted, false);
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

test("buildQuotaView lists every sibling account serving the selected model's provider, by position only, with each account's own position", () => {
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
  assert.deepEqual(view.accounts.map((a) => a.state), ["in_use", "limited"]);
  assert.deepEqual(view.accounts.map((a) => a.percent), [1, 100]);
  const limited = view.accounts.find((a) => a.state === "limited");
  assert.equal(limited.resetsAt, "2026-09-15T00:00:00.000Z");
  // Position in ORIGINAL snapshot order, never rank order — and never the
  // raw identity/org name either account actually carries.
  assert.deepEqual(view.accounts.map((a) => a.label), ["Secondary", "Primary"]);
  assert.ok(view.accounts.every((a) => !a.label.includes("@") && !a.label.includes("Organization")));
  // Each row's raw position, so the popover can match a saved-reset account
  // to it without guessing from the display label.
  assert.deepEqual(view.accounts.map((a) => a.position), [1, 0]);

  // Both anthropic siblings are already covered above; "Other limits" keeps
  // only the other provider's window, never a duplicate of either of these.
  assert.deepEqual(view.others.map((entry) => entry.provider), ["openai-codex"]);
});

// The reported bug, end to end: the conversation's replies come from Primary
// (41% of its 5-hour window) while Secondary sits idle at 0%. The ring used to
// gauge Secondary and label it "Serving next"; it must follow the account omp
// recorded for this conversation.
test("the ring and the account list follow the account this conversation is on", () => {
  const snapshot = usageSnapshot({
    accounts: [
      usageAccount({ id: "primary", windows: [usageWindow({ id: "anthropic:5h", label: "5-hour window", utilization: 41, resetsAt: "2026-09-25T04:00:00.000Z" })] }),
      usageAccount({ id: "secondary", windows: [usageWindow({ id: "anthropic:5h", label: "5-hour window", utilization: 0, resetsAt: null })] }),
    ],
    sessionAccounts: { anthropic: { accountId: "primary", since: "2026-09-25T02:12:29.130Z" } },
  });
  const model = { provider: "anthropic", modelId: "claude-opus-5-5" };
  const view = buildQuotaView(snapshot, false, false, model);

  assert.equal(view.percent, 41);
  assert.match(view.label, /Primary/);
  assert.deepEqual(view.accounts.map((a) => [a.label, a.state]), [["Primary", "in_use"], ["Secondary", "standby"]]);
  assert.equal(view.accountsBasis, "session");

  // A conversation that has not used Claude yet says so instead of claiming
  // an account: its first request is routed on headroom.
  const unused = buildQuotaView({ ...snapshot, sessionAccounts: {} }, false, false, model);
  assert.equal(unused.accountsBasis, "expected");
  assert.equal(unused.accounts[0].label, "Secondary");
});

// The Kestrel report: omp recorded the pin, but Cody could not match it to an
// account (its credential read failed after an engine update). The
// conversation HAS used Claude, so a headroom guess — the idle sibling at 0%
// — is the one wrong answer; the account that last served a request stands in.
test("a pin Cody cannot match falls back to the account that last served, never to headroom", () => {
  const snapshot = usageSnapshot({
    accounts: [
      usageAccount({ id: "primary", lastServedAt: "2026-10-01T23:32:37.290Z", windows: [usageWindow({ id: "anthropic:5h", label: "5-hour window", utilization: 42, resetsAt: "2026-10-02T01:20:00.000Z" })] }),
      usageAccount({ id: "secondary", lastServedAt: null, windows: [usageWindow({ id: "anthropic:5h", label: "5-hour window", utilization: 0, resetsAt: null })] }),
    ],
    sessionAccounts: { anthropic: { accountId: null, since: "2026-10-01T20:28:49.614Z" } },
  });
  const view = buildQuotaView(snapshot, false, false, { provider: "anthropic", modelId: "claude-opus-5-5" });

  assert.equal(view.percent, 42);
  assert.match(view.label, /Primary/);
  assert.deepEqual(view.accounts.map((a) => [a.label, a.state]), [["Primary", "in_use"], ["Secondary", "standby"]]);
  assert.equal(view.accountsBasis, "recent");
});

test("buildQuotaView paints an exhausted low-percentage window as exhausted", () => {
  // omp reports status "rejected" at 12% used: the provider is refusing work
  // on this window regardless of the number, so it binds AND it must not be
  // accent-coloured next to its own red state.
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
  assert.equal(binding.color, "var(--status-error)", "the row's percentage must match its state");
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
 * there); what these pin is that the view actually uses them, and that what
 * drops out of the ring stays visible somewhere.
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

test("a block-sourced window carries its own honesty through every window shape", () => {
  const view = buildQuotaView(usageSnapshot({
    accounts: [usageAccount({
      windows: [usageWindow({ id: "block", label: "blocked", utilization: 100, state: "exhausted", resetsAt: "2099-09-29T00:58:01.000Z", source: "block" })],
    })],
  }), false, false, { provider: "anthropic", modelId: "claude-fable-5" });
  assert.equal(view.known, true);
  assert.equal(view.blocked, true);
  assert.equal(view.windows[0].blocked, true);

  // A measured reading never claims to be a block.
  const measured = buildQuotaView(usageSnapshot({
    accounts: [usageAccount({ windows: [usageWindow({ utilization: 50 })] })],
  }), false, false, { provider: "anthropic", modelId: "claude-fable-5" });
  assert.equal(measured.blocked, false);
});

/* ─────────────────────────── OpenRouter's prepaid balance ─────────────────────────── */

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

test("the popover states the balance, the cycle and today's spend, embedded in the hero", () => {
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

test("the gateway balance remains visible in Also in use when an active subagent spends it", () => {
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

  assert.match(html, /Also in use \(1\)/);
  assert.ok(html.includes("OpenRouter credits"));
  assert.ok(html.includes("$8.26"));
  assert.ok(html.includes("In use by Subagent scout"));
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
  assert.doesNotMatch(html, /Also in use/);
});

test("a missing key hides the credit section instead of showing an error, or a phantom Also-in-use header", () => {
  // An OpenRouter model can be active on an instance with no readable key; an
  // error box (or an empty "Also in use" section) over a working composer is
  // worse than an absent one.
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, {
      quota: buildQuotaView(usageSnapshot({}), false, false, { provider: "anthropic", modelId: "claude-fable-5" }),
      openRouter: openRouterAccount({ available: false, credits: null, key: null, error: { code: "no_key", message: "No OpenRouter key is configured." } }),
      provider: "anthropic",
      modelName: "Claude Fable 5",
      now: Date.parse("2026-08-20T09:05:00.000Z"),
    }),
  );
  assert.doesNotMatch(html, /OpenRouter credits/);
  assert.doesNotMatch(html, /No OpenRouter key is configured/);
  assert.doesNotMatch(html, /Also in use/);
});

/* ─────────────────────────── The redesigned popover ─────────────────────────── */

test("the popover keeps the selected quota as the hero and collapses everything unrelated", () => {
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
        provider: "openai-codex", label: "Openai Codex", planType: "plus",
        windows: [usageWindow({ id: "7d", label: "weekly", utilization: 100, state: "exhausted", windowMs: 604_800_000 })],
      }),
      usageAccount({
        provider: "google", label: "Google", planType: null,
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

  // The hero: the selected model's own binding window and its raw reported plan.
  assert.match(html, /62% Used/);
  assert.match(html, /Reported plan · max/);
  // The account's OTHER window is a compact secondary line right underneath.
  assert.match(html, /Claude · Weekly<\/span><span[^>]*>23%/);
  // A single account for this provider: no Accounts section to disambiguate.
  assert.doesNotMatch(html, />Accounts</);
  // Unrelated providers (Codex, Gemini) and the saved reset stay present but
  // collapsed — never promoted into the always-visible hero.
  assert.match(html, /Other limits · 2/);
  assert.match(html, /Saved resets · 2/);
  const otherLimitsIndex = html.indexOf("Other limits");
  const firstHiddenAfter = html.indexOf('hidden=""', otherLimitsIndex);
  assert.ok(firstHiddenAfter > -1 && firstHiddenAfter < html.indexOf("Codex", otherLimitsIndex));
  assert.match(html, /Claude account/);
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

  // The session-used window is a normal, always-visible row...
  assert.ok(html.includes("Also in use (1)"));
  assert.match(html, /Codex · Weekly/);
  assert.match(html, /Subagent scout, Fallback for this conversation/);
  // ...while the unrelated one sits in the one collapsed "Other limits" group
  // that cannot affect the selected model.
  assert.ok(html.includes("Other limits · 1"));
  const otherLimitsIndex = html.indexOf("Other limits");
  assert.ok(html.indexOf('hidden=""', otherLimitsIndex) < html.indexOf("Gemini", otherLimitsIndex));
});

test("the hero follows Smart's actual resolved model, without ever naming Smart", () => {
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
  assert.ok(html.includes("GPT 5.6 Terra"));
  assert.match(html, /Weekly/);
  assert.doesNotMatch(html, /Smart/);
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
  assert.match(html, /No saved resets available\./);
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

  // The engine's own explanation for the silence renders...
  assert.match(html, /provider reports no plan limits/);
  // ...and another provider's limit remains present, in the one disclosure.
  assert.match(html, /Other limits · 1/);
  assert.match(html, />80%</);
});

/* ─────────────────────────── The rebuilt hierarchy's own behaviours ─────────────────────────── */

test("the accounts list offers a reset action only on a limited row that actually has a matching saved credit", () => {
  const snapshot = usageSnapshot({
    sessionAccounts: { anthropic: { accountId: "primary", since: "2026-09-25T02:12:29.130Z" } },
    accounts: [
      usageAccount({ id: "primary", windows: [usageWindow({ utilization: 41, state: "ok", resetsAt: null })] }),
      usageAccount({ id: "secondary", label: "Anthropic Work", windows: [usageWindow({ utilization: 100, state: "exhausted", resetsAt: "2026-09-15T00:00:00.000Z" })] }),
      usageAccount({ id: "tertiary", label: "Anthropic Third", windows: [usageWindow({ utilization: 100, state: "exhausted", resetsAt: "2026-09-15T00:00:00.000Z" })] }),
    ],
  });
  const resetCredits = {
    loading: false,
    redeeming: false,
    refresh() {},
    redeem: async () => ({ outcome: "reset" }),
    snapshot: {
      available: true,
      fetchedAt: "2026-08-18T12:30:00.000Z",
      // Only the SECOND account (position 1) has a redeemable credit.
      accounts: [{ id: "acct-secondary", label: "Anthropic Work", provider: "anthropic", position: 1, availableCount: 1, canRedeem: true, credits: [{ id: "credit-1", expiresAt: "2026-09-15T00:00:00.000Z" }] }],
    },
  };
  const quota = buildQuotaView(snapshot, false, false, { provider: "anthropic", modelId: "claude-fable-5" });
  assert.equal(quota.accounts.length, 3);
  assert.deepEqual(quota.accounts.map((a) => a.state), ["in_use", "limited", "limited"]);

  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, { resetCredits, quota, provider: "anthropic", modelName: "Fable", now: Date.now() }),
  );
  // Two "Use reset" actions total: the account row for the account that has a
  // credit, and that same account's own row in the Saved resets disclosure —
  // never a third for the equally-limited sibling with no credit.
  assert.equal((html.match(/Use reset/g) ?? []).length, 2);
});

test("the accounts basis explanation lives in the info tooltip, never rendered inline", () => {
  const snapshot = usageSnapshot({
    sessionAccounts: { anthropic: { accountId: "primary", since: "2026-09-25T02:12:29.130Z" } },
    accounts: [
      usageAccount({ id: "primary", windows: [usageWindow({ utilization: 20 })] }),
      usageAccount({ id: "secondary", windows: [usageWindow({ utilization: 5 })] }),
    ],
  });
  const quota = buildQuotaView(snapshot, false, false, { provider: "anthropic", modelId: "claude-fable-5" });
  assert.equal(quota.accountsBasis, "session");
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, { quota, provider: "anthropic", modelName: "Fable", now: Date.now() }),
  );
  // The explanation renders through a tooltip portal, which SSR never emits —
  // so the once-always-visible paragraph cannot leak into the primary layout.
  assert.doesNotMatch(html, /last reply came from/);
  assert.match(html, /About account selection/);
});

test("the hero shows the most-constrained applicable window, with every other one compact underneath", () => {
  const quota = buildQuotaView(usageSnapshot({
    accounts: [usageAccount({
      windows: [
        usageWindow({ id: "7d", label: "weekly", utilization: 100, state: "exhausted", windowMs: 604_800_000, resetsAt: "2026-08-25T00:00:00.000Z" }),
        usageWindow({ id: "5h", label: "5-hour window", utilization: 14, windowMs: 18_000_000, resetsAt: "2026-08-18T17:00:00.000Z" }),
      ],
    })],
  }), false, false, { provider: "anthropic", modelId: "claude-fable-5" });
  assert.equal(quota.label, "weekly");
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, { quota, provider: "anthropic", modelName: "Fable", now: Date.parse("2026-08-18T12:30:00.000Z") }),
  );
  // The headline number and hero meta line both name the binding window...
  assert.match(html, /100% Used/);
  assert.match(html, /Weekly/);
  // ...and the other one is still visible, just as a compact secondary line.
  assert.match(html, /5-hour window/);
  assert.match(html, />14%</);
});

test("a saved reset for an unrelated provider stays inside the collapsed disclosure, never promoted", () => {
  const quota = buildQuotaView(usageSnapshot({
    accounts: [usageAccount({ windows: [usageWindow({ id: "7d", label: "weekly", utilization: 20 })] })],
  }), false, false, { provider: "anthropic", modelId: "claude-fable-5" });
  const resetCredits = {
    loading: false,
    redeeming: false,
    refresh() {},
    redeem: async () => ({ outcome: "reset" }),
    snapshot: {
      available: true,
      fetchedAt: "2026-08-18T12:30:00.000Z",
      accounts: [{ id: "codex", label: "Codex account", provider: "openai-codex", position: 0, availableCount: 1, canRedeem: true, credits: [{ id: "credit-1", expiresAt: "2026-09-15T00:00:00.000Z" }] }],
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(QuotaPopover, { resetCredits, quota, provider: "anthropic", modelName: "Fable", now: Date.parse("2026-08-18T12:30:00.000Z") }),
  );
  assert.match(html, /Saved resets · 1/);
  // Present — the disclosure keeps its content mounted while collapsed, so
  // the row is discoverable — but marked hidden and never promoted into the
  // always-visible hero, Accounts, or Also-in-use sections.
  const hiddenIndex = html.indexOf('hidden=""');
  const codexIndex = html.indexOf("Codex");
  assert.ok(hiddenIndex !== -1 && codexIndex !== -1, "expected both a collapsed panel and the unrelated credit's row");
  assert.ok(hiddenIndex < codexIndex, "the unrelated credit must live inside the collapsed panel");
});
