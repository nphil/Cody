import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const {
  deriveUsageWindowState,
  parseOmpUsagePayload,
  parseOmpUsageOutput,
  USAGE_EXHAUSTED_THRESHOLD,
  USAGE_WARNING_THRESHOLD,
} = await jiti.import("./omp-usage.ts");
const {
  modelMatchesTier,
  selectBindingWindow,
  selectBindingWindowForModel,
  selectWindowsForModel,
} = await jiti.import("./select.ts");
const { getUsageSnapshot, markStale, resetUsageCache, USAGE_CACHE_TTL_MS } = await jiti.import("./cache.ts");
const { USAGE_ACTIVE_INTERVAL_MS, USAGE_BACKGROUND_INTERVAL_MS } = await jiti.import("../../hooks/useUsage.ts");

const FIVE_HOUR_RESET = 1_760_000_000_000;
const SEVEN_DAY_RESET = 1_760_100_000_000;

/** Trimmed but structurally faithful `omp usage --json` payload: Anthropic with
 * a 5h window plus tier-split 7d buckets, and Codex with a planType. */
function ompPayload() {
  return {
    generatedAt: 1_759_900_000_000,
    reports: [
      {
        provider: "anthropic",
        fetchedAt: 1_759_899_000_000,
        limits: [
          {
            id: "anthropic:5h",
            label: "Claude 5 Hour",
            scope: { provider: "anthropic", windowId: "5h", shared: true },
            window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: FIVE_HOUR_RESET },
            amount: { used: 14, unit: "percent", usedFraction: 0.14, remainingFraction: 0.86 },
            status: "ok",
          },
          {
            id: "anthropic:7d",
            label: "Claude 7 Day",
            scope: { provider: "anthropic", windowId: "7d", shared: true },
            window: { id: "7d", label: "7 Day", resetsAt: SEVEN_DAY_RESET },
            amount: { unit: "percent", usedFraction: 0.73 },
            status: "ok",
          },
          {
            id: "anthropic:7d:fable",
            label: "Claude 7 Day (Fable)",
            scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
            window: { id: "7d", label: "7 Day", resetsAt: SEVEN_DAY_RESET },
            amount: { unit: "percent", usedFraction: 1 },
            status: "exhausted",
          },
        ],
        metadata: { endpoint: "https://example.invalid/usage", email: "owner@example.invalid" },
      },
      {
        provider: "openai-codex",
        fetchedAt: 1_759_899_500_000,
        limits: [
          {
            id: "openai-codex:secondary",
            label: "7 Days",
            scope: { provider: "openai-codex", windowId: "7d" },
            window: { id: "7d", label: "7 Days", resetsAt: SEVEN_DAY_RESET + 86_400_000 },
            amount: { unit: "percent", usedFraction: 1 },
            status: "exhausted",
          },
        ],
        metadata: { planType: "plus", allowed: false, limitReached: true },
      },
    ],
    accountsWithoutUsage: [{ provider: "google", type: "oauth" }],
    disabledCredentials: [],
    capacity: { anthropic: [{ window: "7d", accounts: 1, usedAccounts: 0.73, remainingAccounts: 0.27 }] },
  };
}

test("maps a realistic omp payload into a usage snapshot", () => {
  const snapshot = parseOmpUsagePayload(ompPayload());

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.fetchedAt, new Date(1_759_900_000_000).toISOString());
  assert.equal(snapshot.accounts.length, 2);

  const [anthropic, codex] = snapshot.accounts;
  assert.equal(anthropic.provider, "anthropic");
  assert.equal(anthropic.label, "Anthropic");
  assert.equal(anthropic.planType, null);
  assert.equal(anthropic.unlimited, false);
  assert.deepEqual(anthropic.windows, [
    {
      id: "anthropic:5h",
      label: "5-hour window",
      utilization: 14,
      resetsAt: new Date(FIVE_HOUR_RESET).toISOString(),
      state: "ok",
      // The engine's own durationMs, not the "5h" id, is the span of record.
      windowMs: 18_000_000,
      tier: null,
      shared: true,
    },
    {
      id: "anthropic:7d",
      label: "weekly",
      utilization: 73,
      resetsAt: new Date(SEVEN_DAY_RESET).toISOString(),
      state: "warning",
      // No durationMs in the payload: the span is read off the "7d" id.
      windowMs: 604_800_000,
      tier: null,
      shared: true,
    },
    {
      id: "anthropic:7d:fable",
      label: "Fable · weekly",
      utilization: 100,
      resetsAt: new Date(SEVEN_DAY_RESET).toISOString(),
      state: "exhausted",
      windowMs: 604_800_000,
      tier: "fable",
      shared: false,
    },
  ]);

  assert.equal(codex.provider, "openai-codex");
  assert.equal(codex.label, "Openai Codex");
  assert.equal(codex.planType, "plus");
  assert.equal(codex.windows[0].state, "exhausted");
});

test("labels a second account for the same provider with its own identity", () => {
  const payload = ompPayload();
  payload.reports.push({
    ...payload.reports[0],
    metadata: { email: "work@example.invalid", orgName: "Work Org" },
  });
  const snapshot = parseOmpUsagePayload(payload);
  const anthropic = snapshot.accounts.filter((account) => account.provider === "anthropic");

  assert.equal(anthropic.length, 2);
  assert.equal(anthropic[0].label, "Anthropic (owner@example.invalid)");
  assert.equal(anthropic[1].label, "Anthropic (Work Org)");
});

test("derives utilization from used/limit and from inverted remaining", () => {
  const snapshot = parseOmpUsagePayload({
    reports: [
      {
        provider: "github-copilot",
        limits: [
          {
            id: "copilot:premium",
            label: "Premium requests",
            scope: { provider: "github-copilot", windowId: "monthly" },
            window: { id: "monthly", label: "Monthly" },
            amount: { used: 75, limit: 300, unit: "requests" },
          },
          {
            id: "copilot:chat",
            label: "Chat",
            scope: { provider: "github-copilot" },
            amount: { remainingFraction: 0.25, unit: "requests" },
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    snapshot.accounts[0].windows.map((window) => [window.label, window.utilization, window.state]),
    [
      ["monthly", 25, "ok"],
      ["Chat", 75, "warning"],
    ],
  );
});

test("treats unmetered buckets as unlimited instead of pristine quota", () => {
  const snapshot = parseOmpUsagePayload({
    reports: [
      {
        provider: "github-copilot",
        limits: [
          { id: "copilot:chat", label: "Chat", amount: { unit: "requests" }, notes: ["Unlimited"] },
          { id: "copilot:completions", label: "Completions", amount: { unit: "requests" }, notes: ["Unlimited"] },
        ],
      },
    ],
  });

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.accounts[0].unlimited, true);
  assert.deepEqual(snapshot.accounts[0].windows, []);
});

test("keeps an exhausted window that reports no measurable amount", () => {
  const snapshot = parseOmpUsagePayload({
    reports: [
      {
        provider: "minimax",
        limits: [{ id: "minimax:1h", label: "Text", window: { id: "1h" }, amount: {}, status: "exhausted" }],
      },
    ],
  });

  assert.equal(snapshot.accounts[0].windows[0].utilization, 100);
  assert.equal(snapshot.accounts[0].windows[0].state, "exhausted");
});

test("keeps the scope a window was reported under, not just its label", () => {
  // The label folds the tier into display copy ("Fable · weekly"); matching a
  // window against the selected model needs the scope itself back.
  const anthropic = parseOmpUsagePayload(ompPayload()).accounts[0];

  assert.deepEqual(
    anthropic.windows.map((w) => [w.id, w.tier, w.shared]),
    [
      ["anthropic:5h", null, true],
      ["anthropic:7d", null, true],
      ["anthropic:7d:fable", "fable", false],
    ],
  );
});

test("a hostile or absent scope reads as untiered and unshared", () => {
  const snapshot = parseOmpUsagePayload({
    reports: [
      {
        provider: "anthropic",
        limits: [
          { id: "string-scope", scope: "nope", amount: { usedFraction: 0.1 } },
          { id: "junk-fields", scope: { tier: 7, shared: "yes" }, amount: { usedFraction: 0.1 } },
          { id: "no-scope", amount: { usedFraction: 0.1 } },
          { id: "mixed-case", scope: { tier: "  OPUS  ", shared: true }, amount: { usedFraction: 0.1 } },
        ],
      },
    ],
  });

  assert.deepEqual(
    snapshot.accounts[0].windows.map((w) => [w.id, w.tier, w.shared]),
    [
      ["string-scope", null, false],
      ["junk-fields", null, false],
      ["no-scope", null, false],
      // Tiers are normalized on the way in so matching never has to re-trim.
      ["mixed-case", "opus", true],
    ],
  );
});

test("malformed and empty payloads degrade to unavailable without throwing", () => {
  const cases = [
    [undefined, "undefined payload"],
    [null, "null payload"],
    ["not json", "string payload"],
    [42, "number payload"],
    [[], "array payload"],
    [{}, "missing reports"],
    [{ reports: "nope" }, "non-array reports"],
    [{ reports: [] }, "no reports"],
    [{ reports: [null, 7, "x"] }, "junk reports"],
    [{ reports: [{ provider: "anthropic" }] }, "report without limits"],
    [{ reports: [{ provider: "anthropic", limits: [{ id: "a", amount: {} }] }] }, "limit without amounts"],
    [{ reports: [{ limits: [{ id: "a", amount: { usedFraction: 0.5 } }] }] }, "report without provider"],
  ];

  for (const [payload, description] of cases) {
    const snapshot = parseOmpUsagePayload(payload);
    assert.equal(snapshot.available, false, description);
    assert.deepEqual(snapshot.accounts, [], description);
    assert.equal(snapshot.stale, false, description);
    assert.equal(typeof snapshot.reason, "string", description);
    assert.ok(!Number.isNaN(Date.parse(snapshot.fetchedAt)), description);
  }
});

test("survives hostile field types inside an otherwise good report", () => {
  const snapshot = parseOmpUsagePayload({
    generatedAt: "not-a-number",
    reports: [
      {
        provider: "anthropic",
        fetchedAt: Number.NaN,
        limits: [
          { id: 12, label: null, scope: "nope", window: [], amount: { usedFraction: 0.8 }, status: 5 },
          { id: "anthropic:5h", amount: { usedFraction: "0.9" }, window: { resetsAt: "later" } },
        ],
        metadata: { planType: 7 },
      },
    ],
  });

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.accounts[0].planType, null);
  assert.equal(snapshot.accounts[0].windows.length, 1);
  assert.equal(snapshot.accounts[0].windows[0].utilization, 80);
  assert.equal(snapshot.accounts[0].windows[0].resetsAt, null);
  assert.ok(!Number.isNaN(Date.parse(snapshot.fetchedAt)));
});

test("a label that sanitizes down to nothing still names its window", () => {
  // Control characters are not whitespace, so they survive readString and only
  // vanish inside sanitizeLabel — long after the "quota" fallback was already
  // consumed. An empty label renders the headline as a bare percentage naming
  // nothing, so the fallback has to outlive sanitizing.
  const snapshot = parseOmpUsagePayload({
    reports: [
      {
        provider: "\u0001\u0002",
        limits: [
          { id: "blank-label", label: "\u0007\u0007", amount: { usedFraction: 0.42 } },
          { id: "blank-window-label", window: { id: "\u0001", label: "\u0002" }, amount: { usedFraction: 0.1 } },
        ],
      },
    ],
  });

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.accounts[0].windows.length, 2);
  for (const window of snapshot.accounts[0].windows) {
    assert.notEqual(window.label.trim(), "", "every window carries a name");
    assert.equal(window.label, "quota");
  }
  assert.notEqual(snapshot.accounts[0].label.trim(), "", "every account carries a name");
  assert.equal(snapshot.accounts[0].label, "account");
});

test("the client poll cadence outlives the server cache TTL", () => {
  // Polling exactly at the TTL means every poll lands on a just-expired entry:
  // stale-while-revalidate then fires on every other tick forever and the
  // footer alternates "updated <1 min ago" / "may be out of date" while showing
  // last minute's numbers.
  assert.ok(
    USAGE_ACTIVE_INTERVAL_MS > USAGE_CACHE_TTL_MS,
    `active poll (${USAGE_ACTIVE_INTERVAL_MS}ms) must outlive the cache TTL (${USAGE_CACHE_TTL_MS}ms)`,
  );
  assert.ok(USAGE_BACKGROUND_INTERVAL_MS > USAGE_ACTIVE_INTERVAL_MS);
});

test("raw stdout that is not JSON degrades to unavailable", () => {
  assert.equal(parseOmpUsageOutput("").available, false);
  assert.equal(parseOmpUsageOutput("   ").reason, "omp usage returned no output");
  assert.equal(parseOmpUsageOutput("No credentials found\n").reason, "omp usage returned malformed JSON");
  assert.equal(parseOmpUsageOutput(undefined).available, false);
  assert.equal(parseOmpUsageOutput(JSON.stringify(ompPayload())).available, true);
});

test("thresholds break at exactly 70 and exactly 100", () => {
  assert.equal(USAGE_WARNING_THRESHOLD, 70);
  assert.equal(USAGE_EXHAUSTED_THRESHOLD, 100);

  assert.equal(deriveUsageWindowState(0), "ok");
  assert.equal(deriveUsageWindowState(69.99), "ok");
  assert.equal(deriveUsageWindowState(70), "warning");
  assert.equal(deriveUsageWindowState(99.99), "warning");
  assert.equal(deriveUsageWindowState(100), "exhausted");
  assert.equal(deriveUsageWindowState(140), "exhausted");
  // An engine-reported exhaustion outranks the percentage.
  assert.equal(deriveUsageWindowState(3, "exhausted"), "exhausted");
  assert.equal(deriveUsageWindowState(3, "rejected"), "exhausted");
  // Cody's thresholds outrank the engine's laxer grading.
  assert.equal(deriveUsageWindowState(75, "ok"), "warning");
  assert.equal(deriveUsageWindowState(Number.NaN), "ok");
});

test("threshold boundaries hold through the payload mapping", () => {
  const boundaries = parseOmpUsagePayload({
    reports: [
      {
        provider: "anthropic",
        limits: [
          { id: "just-under", amount: { usedFraction: 0.6999 } },
          { id: "exactly-70", amount: { usedFraction: 0.7 } },
          { id: "just-under-100", amount: { usedFraction: 0.9999 } },
          { id: "exactly-100", amount: { usedFraction: 1 } },
          { id: "overage", amount: { usedFraction: 1.4 } },
        ],
      },
    ],
  });

  assert.deepEqual(
    boundaries.accounts[0].windows.map((window) => [window.utilization, window.state]),
    [
      [69.99, "ok"],
      [70, "warning"],
      [99.99, "warning"],
      [100, "exhausted"],
      [100, "exhausted"],
    ],
  );
});

function window(overrides) {
  return { id: "w", label: "w", utilization: 0, resetsAt: null, state: "ok", ...overrides };
}

function account(id, windows) {
  return { provider: id, label: id, planType: null, unlimited: false, windows };
}

test("selectBindingWindow returns null when there is nothing to bind", () => {
  assert.equal(selectBindingWindow([]), null);
  assert.equal(selectBindingWindow([account("a", [])]), null);
});

test("selectBindingWindow ranks exhaustion above everything else", () => {
  const exhausted = window({ id: "exhausted", utilization: 12, state: "exhausted" });
  const warning = window({ id: "warning", utilization: 95, state: "warning" });
  const ok = window({ id: "ok", utilization: 96, state: "ok" });

  const picked = selectBindingWindow([account("a", [ok, warning]), account("b", [exhausted])]);
  assert.equal(picked.window.id, "exhausted");
  assert.equal(picked.account.provider, "b");

  // Below exhaustion, the badge alone decides nothing: the fuller window
  // binds whichever tone it carries, because a warning refuses no work.
  const withoutExhausted = selectBindingWindow([account("a", [ok, warning])]);
  assert.equal(withoutExhausted.window.id, "ok");
});

test("selectBindingWindow breaks a same-state tie on the highest utilization", () => {
  const lower = window({ id: "lower", utilization: 72, state: "warning" });
  const higher = window({ id: "higher", utilization: 88, state: "warning" });
  assert.equal(selectBindingWindow([account("a", [lower, higher])]).window.id, "higher");
  assert.equal(selectBindingWindow([account("a", [higher, lower])]).window.id, "higher");
});

test("selectBindingWindow breaks a utilization tie on the soonest reset", () => {
  const later = window({ id: "later", utilization: 80, state: "warning", resetsAt: "2026-08-20T00:00:00.000Z" });
  const sooner = window({ id: "sooner", utilization: 80, state: "warning", resetsAt: "2026-08-19T00:00:00.000Z" });
  assert.equal(selectBindingWindow([account("a", [later, sooner])]).window.id, "sooner");
  assert.equal(selectBindingWindow([account("a", [sooner, later])]).window.id, "sooner");
});

test("selectBindingWindow sorts missing and unparseable resets last", () => {
  const dated = window({ id: "dated", utilization: 80, state: "warning", resetsAt: "2026-08-20T00:00:00.000Z" });
  const undated = window({ id: "undated", utilization: 80, state: "warning", resetsAt: null });
  const garbled = window({ id: "garbled", utilization: 80, state: "warning", resetsAt: "soon-ish" });

  assert.equal(selectBindingWindow([account("a", [undated, dated])]).window.id, "dated");
  assert.equal(selectBindingWindow([account("a", [garbled, dated])]).window.id, "dated");
  // Two unusable resets stay tied, so the first one encountered wins.
  assert.equal(selectBindingWindow([account("a", [undated, garbled])]).window.id, "undated");
  assert.equal(selectBindingWindow([account("a", [garbled, undated])]).window.id, "garbled");
});

test("selectBindingWindow is stable across accounts on a full tie", () => {
  const first = window({ id: "first", utilization: 90, state: "warning", resetsAt: "2026-08-19T00:00:00.000Z" });
  const second = window({ id: "second", utilization: 90, state: "warning", resetsAt: "2026-08-19T00:00:00.000Z" });
  const picked = selectBindingWindow([account("a", [first]), account("b", [second])]);
  assert.equal(picked.window.id, "first");
  assert.equal(picked.account.provider, "a");
});

test("selectBindingWindow picks the binding window of a real snapshot", () => {
  const snapshot = parseOmpUsagePayload(ompPayload());
  const picked = selectBindingWindow(snapshot.accounts);
  // Two windows sit at 100% exhausted over the same span, so the soonest
  // reset decides.
  assert.equal(picked.account.provider, "anthropic");
  assert.equal(picked.window.id, "anthropic:7d:fable");
});

test("a healthy shorter window outranks a fuller longer one", () => {
  // The owner's steady state: the week fills long before the current five
  // hours do, and the ring must gauge what this turn is spending against.
  const fiveHour = window({ id: "5h", utilization: 14, windowMs: 5 * 3_600_000, resetsAt: "2026-08-19T18:00:00.000Z" });
  const weekly = window({ id: "7d", utilization: 73, state: "warning", windowMs: 7 * 86_400_000, resetsAt: "2026-08-23T09:00:00.000Z" });
  const model = { provider: "anthropic", modelId: "claude-fable-5" };

  for (const windows of [[fiveHour, weekly], [weekly, fiveHour]]) {
    assert.equal(selectBindingWindow([account("a", windows)]).window.id, "5h");
    assert.equal(selectBindingWindowForModel([account("anthropic", windows)], model).window.id, "5h");
  }

  // …but a refused week stops the model no matter how fresh the 5h window is.
  const spentWeek = { ...weekly, utilization: 100, state: "exhausted" };
  for (const windows of [[fiveHour, spentWeek], [spentWeek, fiveHour]]) {
    assert.equal(selectBindingWindow([account("a", windows)]).window.id, "7d");
    assert.equal(selectBindingWindowForModel([account("anthropic", windows)], model).window.id, "7d");
  }
});

test("a window with an unknown span sorts after any known one", () => {
  // A window that will not say how long it lasts cannot claim to be the
  // near-term one — however full it is.
  const known = window({ id: "known", utilization: 10, windowMs: 7 * 86_400_000 });
  const unknown = window({ id: "unknown", utilization: 90, windowMs: null });
  for (const windows of [[known, unknown], [unknown, known]]) {
    assert.equal(selectBindingWindow([account("a", windows)]).window.id, "known");
  }
});

/**
 * The owner's real `omp usage --json`, trimmed to the fields Cody reads: Codex
 * spent to the last request while Anthropic sits nearly untouched. Codex is
 * listed first so nothing passes by accident of ordering.
 */
function productionPayload() {
  return {
    generatedAt: 1_759_900_000_000,
    reports: [
      {
        provider: "openai-codex",
        limits: [
          {
            id: "openai-codex:primary",
            label: "7 Days",
            scope: { provider: "openai-codex", windowId: "7d", shared: true },
            window: { id: "7d", label: "7 Days", resetsAt: SEVEN_DAY_RESET },
            amount: { used: 100, limit: 100, unit: "percent" },
            status: "exhausted",
          },
        ],
        metadata: { planType: "plus" },
      },
      {
        provider: "anthropic",
        limits: [
          {
            id: "anthropic:5h",
            scope: { provider: "anthropic", windowId: "5h", shared: true },
            window: { id: "5h", resetsAt: FIVE_HOUR_RESET },
            amount: { used: 14, limit: 100, unit: "percent" },
            status: "ok",
          },
          {
            id: "anthropic:7d",
            scope: { provider: "anthropic", windowId: "7d", shared: true },
            window: { id: "7d", resetsAt: SEVEN_DAY_RESET },
            amount: { used: 7, limit: 100, unit: "percent" },
            status: "ok",
          },
          {
            id: "anthropic:7d:fable",
            scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
            window: { id: "7d", resetsAt: SEVEN_DAY_RESET },
            amount: { used: 9, limit: 100, unit: "percent" },
            status: "ok",
          },
        ],
        metadata: { planType: null },
      },
    ],
  };
}

function productionAccounts() {
  return parseOmpUsagePayload(productionPayload()).accounts;
}

test("a model is scoped to its own provider, not the worst provider on the box", () => {
  // The shipped bug: chatting to Anthropic at 7-14% showed a spent ring
  // because a different provider's subscription was exhausted.
  const accounts = productionAccounts();
  assert.equal(selectBindingWindow(accounts).window.id, "openai-codex:primary");

  const picked = selectWindowsForModel(accounts, { provider: "anthropic", modelId: "claude-fable-5" });
  assert.equal(picked.account.provider, "anthropic");
  // Most binding first: the 5h span, then the two weeklies on utilization
  // (9% > 7%) — all of them below any threshold.
  assert.deepEqual(picked.windows.map((w) => w.id), ["anthropic:5h", "anthropic:7d:fable", "anthropic:7d"]);

  const binding = selectBindingWindowForModel(accounts, { provider: "anthropic", modelId: "claude-fable-5" });
  assert.equal(binding.account.provider, "anthropic");
  assert.equal(binding.window.id, "anthropic:5h");
  assert.equal(binding.window.utilization, 14);
  assert.equal(binding.window.state, "ok");
});

test("the exhausted window still binds the model it actually limits", () => {
  const accounts = productionAccounts();
  const binding = selectBindingWindowForModel(accounts, { provider: "openai-codex", modelId: "gpt-5.5" });

  assert.equal(binding.account.provider, "openai-codex");
  assert.equal(binding.window.id, "openai-codex:primary");
  assert.equal(binding.window.utilization, 100);
  assert.equal(binding.window.state, "exhausted");
});

test("a tiered window binds its own tier and no other", () => {
  const payload = productionPayload();
  payload.reports[1].limits.push({
    id: "anthropic:7d:opus",
    scope: { provider: "anthropic", windowId: "7d", tier: "opus" },
    window: { id: "7d", resetsAt: SEVEN_DAY_RESET },
    amount: { used: 100, limit: 100, unit: "percent" },
    status: "exhausted",
  });
  const accounts = parseOmpUsagePayload(payload).accounts;

  const sonnet = selectWindowsForModel(accounts, { provider: "anthropic", modelId: "claude-sonnet-5" });
  assert.deepEqual(sonnet.windows.map((w) => w.id), ["anthropic:5h", "anthropic:7d"]);
  // The spent tier belongs to another model; it must not colour this ring.
  assert.equal(selectBindingWindowForModel(accounts, { provider: "anthropic", modelId: "claude-sonnet-5" }).window.state, "ok");

  const opus = selectWindowsForModel(accounts, { provider: "anthropic", modelId: "claude-opus-4-5" });
  assert.deepEqual(opus.windows.map((w) => w.id), ["anthropic:7d:opus", "anthropic:5h", "anthropic:7d"]);
  assert.equal(selectBindingWindowForModel(accounts, { provider: "anthropic", modelId: "claude-opus-4-5" }).window.id, "anthropic:7d:opus");
});

test("modelMatchesTier matches whole tokens only", () => {
  for (const [modelId, tier] of [
    ["claude-fable-5", "fable"],
    ["claude-opus-4-5", "opus"],
    ["claude-opus", "opus"],
    ["opus-4-5", "opus"],
    ["opus", "opus"],
    ["CLAUDE-OPUS-4-5", "OPUS"],
    ["claude-opus-4-5", "  opus  "],
    ["claude.mythos.5", "mythos"],
    // The first occurrence is glued to a letter; the scan has to keep looking.
    ["opusx-opus-5", "opus"],
  ]) {
    assert.equal(modelMatchesTier(modelId, tier), true, `${modelId} ~ ${tier}`);
  }

  for (const [modelId, tier] of [
    // A tier must not bleed into a longer word that merely starts with it.
    ["claude-opusx", "opus"],
    ["claude-xopus", "opus"],
    ["claude-opus45", "opus"],
    ["claude-sonnet-5", "opus"],
    ["claude-haiku-4-5", "fable"],
    ["", "opus"],
    ["claude-opus-4-5", ""],
    ["claude-opus-4-5", "   "],
  ]) {
    assert.equal(modelMatchesTier(modelId, tier), false, `${modelId} !~ ${tier}`);
  }
});

test("a provider that reports no usage at all yields no quota, not someone else's", () => {
  const accounts = productionAccounts();
  // llama-swap runs locally and never reports a limit.
  assert.equal(selectWindowsForModel(accounts, { provider: "llama-swap", modelId: "qwen3-coder" }), null);
  assert.equal(selectBindingWindowForModel(accounts, { provider: "llama-swap", modelId: "qwen3-coder" }), null);
});

test("no selected model means no ring at all", () => {
  const accounts = productionAccounts();
  for (const model of [null, undefined, {}, { provider: "", modelId: "x" }, { provider: "   ", modelId: "x" }]) {
    assert.equal(selectWindowsForModel(accounts, model), null);
    assert.equal(selectBindingWindowForModel(accounts, model), null);
  }
  assert.equal(selectWindowsForModel([], { provider: "anthropic", modelId: "claude-fable-5" }), null);
});

test("provider matching ignores case and stray whitespace", () => {
  const accounts = productionAccounts();
  const picked = selectWindowsForModel(accounts, { provider: " Anthropic ", modelId: "claude-fable-5" });
  assert.equal(picked.account.provider, "anthropic");
  assert.equal(picked.windows.length, 3);
});

test("two subscriptions on one provider: the tighter one is the honest answer", () => {
  const roomy = account("anthropic", [window({ id: "roomy", utilization: 20, state: "ok", shared: true })]);
  const tight = account("anthropic", [window({ id: "tight", utilization: 95, state: "warning", shared: true })]);

  for (const accounts of [[roomy, tight], [tight, roomy]]) {
    const binding = selectBindingWindowForModel(accounts, { provider: "anthropic", modelId: "claude-fable-5" });
    assert.equal(binding.window.id, "tight");
  }
});

test("an account whose only windows belong to other tiers reports nothing binding", () => {
  const accounts = [
    account("anthropic", [window({ id: "anthropic:7d:opus", tier: "opus", utilization: 100, state: "exhausted" })]),
  ];
  const model = { provider: "anthropic", modelId: "claude-haiku-4-5" };

  // The provider is known, so the account still comes back — but with nothing
  // that constrains this model, which is not the same as "quota unavailable".
  const picked = selectWindowsForModel(accounts, model);
  assert.equal(picked.account.provider, "anthropic");
  assert.deepEqual(picked.windows, []);
  assert.equal(selectBindingWindowForModel(accounts, model), null);
});

test("an account that does constrain the model outranks a sibling that does not", () => {
  const tiered = account("anthropic", [window({ id: "other-tier", tier: "opus", utilization: 100, state: "exhausted" })]);
  const applicable = account("anthropic", [window({ id: "applicable", utilization: 30, state: "ok", shared: true })]);

  for (const accounts of [[tiered, applicable], [applicable, tiered]]) {
    assert.equal(selectBindingWindowForModel(accounts, { provider: "anthropic", modelId: "claude-haiku-4-5" }).window.id, "applicable");
  }
});

test("selecting for a model never reorders the snapshot it read", () => {
  const accounts = productionAccounts();
  const before = accounts[1].windows.map((w) => w.id);
  selectWindowsForModel(accounts, { provider: "anthropic", modelId: "claude-fable-5" });
  assert.deepEqual(accounts[1].windows.map((w) => w.id), before);
});

function snapshotFor(reason) {
  return { available: true, accounts: [account(reason, [window({ id: reason })])], fetchedAt: reason, stale: false };
}

test("cache collapses concurrent callers into one underlying read", async () => {
  resetUsageCache();
  let loads = 0;
  let finish;
  const load = () => {
    loads += 1;
    return new Promise((resolve) => { finish = resolve; });
  };

  const callers = [
    getUsageSnapshot({ load }),
    getUsageSnapshot({ load }),
    getUsageSnapshot({ load }),
    getUsageSnapshot({ load }),
  ];
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(loads, 1);

  finish(snapshotFor("first"));
  const results = await Promise.all(callers);
  for (const result of results) assert.equal(result.fetchedAt, "first");
  assert.equal(loads, 1);
});

test("cache serves a warm entry without re-reading", async () => {
  resetUsageCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return snapshotFor("warm");
  };

  const first = await getUsageSnapshot({ load });
  const second = await getUsageSnapshot({ load });
  assert.equal(loads, 1);
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(second.stale, false);
  assert.ok(USAGE_CACHE_TTL_MS >= 60_000);
});

test("cache refreshes once maxAgeMs has passed and serves the stale entry meanwhile", async () => {
  resetUsageCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return snapshotFor(`read-${loads}`);
  };

  await getUsageSnapshot({ load });
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Expired against maxAgeMs: the caller gets the previous value flagged stale
  // while the refresh runs behind it.
  const served = await getUsageSnapshot({ maxAgeMs: 1, load });
  assert.equal(served.fetchedAt, "read-1");
  assert.equal(served.stale, true);
  assert.equal(loads, 2);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const refreshed = await getUsageSnapshot({ load });
  assert.equal(refreshed.fetchedAt, "read-2");
  assert.equal(refreshed.stale, false);
  assert.equal(loads, 2);
});

test("markStale forces the next read to refresh", async () => {
  resetUsageCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return snapshotFor(`turn-${loads}`);
  };

  await getUsageSnapshot({ load });
  assert.equal(loads, 1);

  markStale();
  const served = await getUsageSnapshot({ load });
  assert.equal(served.stale, true);
  assert.equal(served.fetchedAt, "turn-1");
  assert.equal(loads, 2);

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await getUsageSnapshot({ load })).fetchedAt, "turn-2");
  assert.equal(loads, 2);
});

test("cache backs off after a failed read instead of respawning per caller", async () => {
  resetUsageCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { available: false, accounts: [], fetchedAt: "never", stale: false, reason: "omp binary not found" };
  };

  const first = await getUsageSnapshot({ load });
  assert.equal(first.available, false);
  assert.equal(first.reason, "omp binary not found");

  // Even a caller demanding fresh data must not break the backoff.
  const second = await getUsageSnapshot({ maxAgeMs: 0, load });
  assert.equal(second.available, false);
  assert.equal(loads, 1);
});

test("a throwing loader still resolves to an unavailable snapshot", async () => {
  resetUsageCache();
  const snapshot = await getUsageSnapshot({ load: async () => { throw new Error("spawn exploded"); } });
  assert.equal(snapshot.available, false);
  assert.match(snapshot.reason, /spawn exploded/);
  assert.deepEqual(snapshot.accounts, []);
});

test("awaitFresh waits for the refresh instead of reporting a stale entry", async () => {
  resetUsageCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { available: true, accounts: [account("gen" + loads, [window({ id: "w" })])], fetchedAt: "gen" + loads, stale: false };
  };

  const first = await getUsageSnapshot({ load });
  assert.equal(first.fetchedAt, "gen1");
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Expired entry + awaitFresh: the caller gets the NEW read, not the old one
  // flagged stale. `stale` must mean "could not refresh", not "aged out" —
  // otherwise a poller slower than the TTL warns "out of date" every time.
  const served = await getUsageSnapshot({ maxAgeMs: 1, awaitFresh: true, load });
  assert.equal(served.fetchedAt, "gen2");
  assert.equal(served.stale, false);
  assert.equal(loads, 2);
});

test("awaitFresh falls back to the last good entry, flagged stale, when the refresh fails", async () => {
  resetUsageCache();
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls === 1) {
      return { available: true, accounts: [account("good", [window({ id: "w" })])], fetchedAt: "good", stale: false };
    }
    throw new Error("omp vanished");
  };

  await getUsageSnapshot({ load });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const served = await getUsageSnapshot({ maxAgeMs: 1, awaitFresh: true, load });
  assert.equal(served.fetchedAt, "good", "last good numbers still served");
  assert.equal(served.stale, true, "and only now is stale an honest claim");
});
