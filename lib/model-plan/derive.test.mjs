import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  constrainPlanDraft,
  deriveChains,
  heuristicPlan,
  planRoleNames,
  resolveRosterModel,
  ROLE_NAMES,
  validatePlan,
} = await jiti.import("./derive.ts");
const { buildRoster } = await jiti.import("./roster.ts");

function model(selector, overrides = {}) {
  const slash = selector.indexOf("/");
  const id = selector.slice(slash + 1);
  return {
    selector,
    provider: selector.slice(0, slash),
    id,
    name: id,
    contextWindow: 200_000,
    maxTokens: 8_192,
    reasoning: true,
    thinkingEfforts: [],
    vision: false,
    local: false,
    relativeCost: 10,
    ...overrides,
  };
}

function catalogModel(provider, id, overrides = {}) {
  return {
    provider,
    id,
    name: id,
    reasoning: true,
    input: [],
    contextWindow: 200_000,
    maxTokens: 8_192,
    baseUrl: "https://models.example.test/v1",
    cost: { input: 1, output: 1 },
    ...overrides,
  };
}

const EXACT_ROSTER = [
  model("openai-codex/spark", { relativeCost: 30, vision: true, rolePriority: { slow: 0 } }),
  model("openai-codex/luna", { relativeCost: 20, vision: true, rolePriority: { slow: 1 } }),
  model("openai-codex/mini-a", { reasoning: false, relativeCost: 1, rolePriority: { smol: 0 } }),
  model("openai-codex/mini-b", { reasoning: false, relativeCost: 2, rolePriority: { smol: 1 } }),
  model("anthropic/opus", { relativeCost: 30, vision: true, rolePriority: { slow: 0 } }),
  model("anthropic/fable", { relativeCost: 20, vision: true, rolePriority: { slow: 1 } }),
  model("anthropic/sonnet", { relativeCost: 1, vision: true }),
  model("openrouter/vendor/strong", { relativeCost: 30, vision: true }),
  model("openrouter/vendor/light", { reasoning: false, relativeCost: 1 }),
];
const EXACT_LADDER = ["openai-codex", "anthropic", "openrouter"];

test("exact chains retain workload-compatible subscription siblings before gateways in both directions", () => {
  const chains = deriveChains({
    roles: { smol: "openai-codex/mini-a" },
    ladder: EXACT_LADDER,
    roster: EXACT_ROSTER,
  });
  const codexStrong = chains["openai-codex/spark"];
  const anthropicStrong = chains["anthropic/opus"];

  assert.equal(codexStrong[0], "openai-codex/luna");
  assert.deepEqual(
    codexStrong.filter((selector) => selector === "anthropic/opus" || selector === "anthropic/fable"),
    ["anthropic/fable", "anthropic/opus"],
  );
  assert.equal(codexStrong.at(-1), "openrouter/vendor/strong");
  assert.equal(anthropicStrong[0], "anthropic/fable");
  assert.deepEqual(
    anthropicStrong.filter((selector) => selector === "openai-codex/spark" || selector === "openai-codex/luna"),
    ["openai-codex/spark", "openai-codex/luna"],
  );
  assert.equal(anthropicStrong.at(-1), "openrouter/vendor/strong");
  assert.deepEqual(chains["openai-codex/mini-a"], [
    "openai-codex/mini-b",
    "anthropic/sonnet",
    "openrouter/vendor/light",
  ]);
  assert.deepEqual(chains.smol, ["openai-codex/mini-b", "anthropic/sonnet", "openrouter/vendor/light"]);
  assert.equal(chains["openai-codex/mini-a"].includes("openai-codex/mini-a"), false);
  assert.equal(chains["openai-codex/mini-a"].includes("anthropic/opus"), false);
});

test("cross-provider chains enable usage-aware fallback even when every role has one provider", () => {
  const roles = Object.fromEntries(ROLE_NAMES.map((role) => [role, "openai-codex/spark"]));
  const chains = deriveChains({ roles, ladder: EXACT_LADDER, roster: EXACT_ROSTER });
  const { plan } = validatePlan({ roles, chains }, EXACT_ROSTER);

  assert.equal(plan.usageAwareFallback, true);
  assert.equal(plan.chains.default[0], "openai-codex/luna");
  assert.deepEqual(
    plan.chains.default.filter((selector) => selector === "anthropic/opus" || selector === "anthropic/fable"),
    ["anthropic/fable", "anthropic/opus"],
  );
  assert.equal(plan.chains.default.at(-1), "openrouter/vendor/strong");
});

test("same-provider sibling routes enable usage-aware fallback", () => {
  const roster = [
    model("openai-codex/spark", { reasoning: false, relativeCost: 1, rolePriority: { smol: 0 } }),
    model("openai-codex/luna", { reasoning: false, relativeCost: 2, rolePriority: { smol: 1 } }),
  ];
  const roles = { smol: "openai-codex/spark" };
  const chains = deriveChains({ roles, ladder: ["openai-codex"], roster });
  const { plan } = validatePlan({ roles, chains }, roster);

  assert.deepEqual(chains.smol, ["openai-codex/luna"]);
  assert.equal(plan.usageAwareFallback, true);
});
test("native priority aliases ignore unknown entries and retain unlisted priced models", () => {
  const catalog = [
    catalogModel("openai-codex", "native-smol:batch", { reasoning: false, cost: { input: 40, output: 40 } }),
    catalogModel("openai-codex", "cheap-smol", { reasoning: false, cost: { input: 0.01, output: 0.01 } }),
    catalogModel("openai-codex", "native-slow", { cost: { input: 0.01, output: 0.01 } }),
    catalogModel("openai-codex", "priced-slow", { cost: { input: 40, output: 40 } }),
  ];
  const providers = [{ id: "openai-codex", name: "Codex", available: true, authenticated: true }];
  const barePlan = heuristicPlan(buildRoster(catalog, providers, {
    smol: ["missing-smol", "native-smol:batch", "openai-codex/cheap-smol"],
    slow: ["openai-codex/missing-slow", "native-slow"],
  }).models, { preferredProvider: "openai-codex" });
  const qualifiedPlan = heuristicPlan(buildRoster(catalog, providers, {
    smol: ["missing-smol", "openai-codex/native-smol:batch", "openai-codex/cheap-smol"],
    slow: ["missing-slow", "openai-codex/native-slow"],
  }).models, { preferredProvider: "openai-codex" });

  for (const plan of [barePlan, qualifiedPlan]) {
    assert.equal(plan.roles.smol, "openai-codex/native-smol:batch");
    assert.equal(plan.roles.slow, "openai-codex/native-slow");
    assert.equal(plan.roles.advisor, "openai-codex/native-slow");
    assert.equal(plan.roles.default, "openai-codex/priced-slow");
  }
});
test("task uses a balanced same-subscription tier while default uses the strongest", () => {
  const roster = [
    model("openai-codex/m1", { relativeCost: 1 }),
    model("openai-codex/m7", { relativeCost: 7 }),
    model("openai-codex/m30", { relativeCost: 30 }),
  ];
  const plan = heuristicPlan(roster, { preferredProvider: "openai-codex" });

  assert.equal(plan.roles.default, "openai-codex/m30");
  assert.equal(plan.roles.task, "openai-codex/m7");
});

test("task avoids native-smol when nonlight reasoning candidates exist", () => {
  const roster = [
    model("openai-codex/balanced", { relativeCost: 1 }),
    model("openai-codex/native-smol", { relativeCost: 7, rolePriority: { smol: 0 } }),
    model("openai-codex/strong", { relativeCost: 30 }),
  ];
  const plan = heuristicPlan(roster, { preferredProvider: "openai-codex" });
  const onlyLight = heuristicPlan([
    model("openai-codex/only-light", { reasoning: false, relativeCost: 7, rolePriority: { smol: 0 } }),
  ], { preferredProvider: "openai-codex" });

  assert.equal(plan.roles.default, "openai-codex/strong");
  assert.equal(plan.roles.task, "openai-codex/strong");
  assert.equal(onlyLight.roles.task, "openai-codex/only-light");
});
test("constraints repair gateway and oversized lightweight drafts without dropping valid same-tier routing", () => {
  const roster = [
    model("openai-codex/m1", { relativeCost: 1 }),
    model("openai-codex/m30", { relativeCost: 30 }),
    model("anthropic/m1", { relativeCost: 1 }),
    model("anthropic/m7", { relativeCost: 7 }),
    model("anthropic/m30", { relativeCost: 30 }),
    model("openrouter/vendor/m1", { relativeCost: 1 }),
    model("openrouter/vendor/m30", { relativeCost: 30 }),
  ];
  const constrained = constrainPlanDraft({
    roles: {
      default: "openrouter/vendor/m30",
      smol: "openai-codex/m30",
      task: "anthropic/m7",
    },
    ladder: ["openai-codex"],
    rationale: [],
  }, roster);
  const chains = deriveChains({
    roles: constrained.draft.roles,
    ladder: constrained.draft.ladder,
    roster,
  });

  assert.equal(constrained.draft.roles.default, "anthropic/m30");
  assert.equal(constrained.draft.roles.smol, "openai-codex/m1");
  assert.equal(constrained.draft.roles.task, "anthropic/m7");
  assert.ok(chains.default.includes("openrouter/vendor/m30"));
});

test("unassigned cheap reasoning models keep exact fallbacks at their source price tier", () => {
  const roster = [
    model("openai-codex/cheap", { relativeCost: 1 }),
    model("openai-codex/strong", { relativeCost: 30 }),
    model("anthropic/cheap", { relativeCost: 1 }),
    model("anthropic/strong", { relativeCost: 30 }),
    model("direct-api/cheap", { relativeCost: 1 }),
    model("direct-api/strong", { relativeCost: 30 }),
    model("openrouter/vendor/cheap", { relativeCost: 1 }),
    model("openrouter/vendor/strong", { relativeCost: 30 }),
    model("ollama/cheap", { local: true, relativeCost: 1 }),
    model("ollama/strong", { local: true, relativeCost: 30 }),
  ];
  const chains = deriveChains({
    roles: {},
    ladder: ["openai-codex", "anthropic", "direct-api", "openrouter", "ollama"],
    roster,
  });

  assert.deepEqual(chains["openai-codex/cheap"], [
    "anthropic/cheap",
    "direct-api/cheap",
    "openrouter/vendor/cheap",
    "ollama/cheap",
  ]);
});

test("exact cheap vision sources preserve vision-light fallbacks over assigned-role frontiers", () => {
  const roster = [
    model("anthropic/sonnet", { relativeCost: 1, vision: true }),
    model("anthropic/opus", { relativeCost: 30, vision: true }),
    model("openai-codex/light", { reasoning: false, relativeCost: 1, vision: true }),
    model("openai-codex/strong", { relativeCost: 30, vision: true }),
  ];
  const chains = deriveChains({
    roles: { task: "anthropic/sonnet", vision: "anthropic/sonnet" },
    ladder: ["anthropic", "openai-codex"],
    roster,
  });

  assert.deepEqual(chains["anthropic/sonnet"], ["openai-codex/light"]);
});
test("native slow priority orders instead of whitelisting enabled strong fallbacks", () => {
  const roster = [
    model("anthropic/source", { relativeCost: 20 }),
    model("openai-codex/native", { relativeCost: 7, rolePriority: { slow: 0 } }),
    model("openai-codex/new", { relativeCost: 30 }),
  ];
  const chains = deriveChains({
    roles: { slow: "anthropic/source" },
    ladder: ["anthropic", "openai-codex"],
    roster,
  });

  assert.deepEqual(chains.slow, ["openai-codex/native", "openai-codex/new"]);
});
test("exact default chains rank native slow targets before price and retain unranked strong fallbacks", () => {
  const roster = [
    model("codex/astra", { relativeCost: 60 }),
    model("codex/sol", { relativeCost: 24, rolePriority: { slow: 0 } }),
    model("codex/fivefive", { relativeCost: 35, rolePriority: { slow: 19 } }),
    model("codex/new", { relativeCost: 60 }),
  ];
  const chains = deriveChains({
    roles: { default: "codex/astra" },
    ladder: ["codex"],
    roster,
  });

  assert.deepEqual(chains["codex/astra"], ["codex/sol", "codex/fivefive", "codex/new"]);
});
test("a sparse source maps thinking work to a capable fallback instead of the cheapest option", () => {
  const roster = [
    model("openai-codex/only", { relativeCost: 20 }),
    model("anthropic/budget", { relativeCost: 1 }),
    model("anthropic/capable", { relativeCost: 30 }),
  ];
  const chains = deriveChains({
    roles: { default: "openai-codex/only" },
    ladder: ["openai-codex", "anthropic"],
    roster,
  });

  assert.equal(chains["openai-codex/only"].at(0), "anthropic/capable");
  assert.notEqual(chains["openai-codex/only"].at(0), "anthropic/budget");
});

test("a chat-only remote roster remains usable for regular and deliberate work", () => {
  const roster = [model("direct-api/chat", { reasoning: false, relativeCost: 1 })];
  const plan = heuristicPlan(roster);

  assert.deepEqual(
    Object.fromEntries(["default", "task", "plan", "slow", "smol", "tiny", "commit", "advisor"].map((role) => [role, plan.roles[role]])),
    {
      default: "direct-api/chat",
      task: "direct-api/chat",
      plan: "direct-api/chat",
      slow: "direct-api/chat",
      smol: "direct-api/chat",
      tiny: "direct-api/chat",
      commit: "direct-api/chat",
      advisor: "direct-api/chat",
    },
  );
  assert.equal(plan.roles.vision, undefined);
});

test("vision roles and their exact fallbacks never select a non-vision model", () => {
  const roster = [
    model("alpha/plain", { relativeCost: 20 }),
    model("alpha/vision", { reasoning: false, vision: true, relativeCost: 1 }),
    model("backup/plain", { relativeCost: 20 }),
    model("backup/vision", { reasoning: false, vision: true, relativeCost: 1 }),
  ];
  const constrained = constrainPlanDraft({
    roles: { default: "alpha/plain", vision: "alpha/plain" },
    ladder: ["alpha", "backup"],
    rationale: [],
  }, roster);
  const chains = deriveChains({
    roles: constrained.draft.roles,
    ladder: ["alpha", "backup"],
    roster,
  });

  assert.equal(constrained.draft.roles.vision, "alpha/vision");
  assert.deepEqual(chains.vision, ["backup/vision"]);
  assert.deepEqual(chains["alpha/vision"], ["backup/vision"]);
});

test("empty and local-only rosters produce safe empty or local-only routing", () => {
  const empty = heuristicPlan([]);
  const emptyChains = deriveChains({ roles: {}, ladder: [], roster: [] });
  const local = [model("ollama/chat", { local: true, reasoning: false, relativeCost: null })];
  const localPlan = heuristicPlan(local);
  const localChains = deriveChains({ roles: localPlan.roles, ladder: localPlan.ladder, roster: local });

  assert.deepEqual(empty.roles, {});
  assert.deepEqual(empty.ladder, []);
  assert.deepEqual(emptyChains, {});
  assert.equal(validatePlan({ roles: {}, chains: emptyChains }, []).plan.usageAwareFallback, false);
  assert.equal(localPlan.roles.default, "ollama/chat");
  assert.equal(localPlan.roles.slow, "ollama/chat");
  assert.equal(localPlan.roles.vision, undefined);
  assert.deepEqual(localPlan.ladder, ["ollama"]);
  assert.deepEqual(localChains, {});
  assert.equal(validatePlan({ roles: localPlan.roles, chains: localChains }, local).plan.usageAwareFallback, false);
});
test("zero-cost remote and OpenRouter models are remote while loopback models are local", () => {
  const { models } = buildRoster([
    catalogModel("free-remote", "free", { baseUrl: "https://free.example.test/v1", cost: { input: 0, output: 0 } }),
    catalogModel("remote-without-url", "free", { baseUrl: undefined, cost: { input: 0, output: 0 } }),
    catalogModel("openrouter", "vendor/free", { baseUrl: "https://openrouter.ai/api/v1", cost: { input: 0, output: 0 } }),
    catalogModel("ollama", "local", { baseUrl: undefined, baseURL: "http://127.0.0.1:11434/v1", cost: { input: 0, output: 0 } }),
  ], []);
  const bySelector = new Map(models.map((entry) => [entry.selector, entry]));
  const plan = heuristicPlan(models);

  assert.equal(bySelector.get("free-remote/free")?.local, false);
  assert.equal(bySelector.get("remote-without-url/free")?.local, false);
  assert.equal(bySelector.get("openrouter/vendor/free")?.local, false);
  assert.equal(bySelector.get("ollama/local")?.local, true);
  assert.deepEqual(plan.ladder, ["free-remote", "remote-without-url", "openrouter", "ollama"]);
});
test("plans use only models in the supplied effective roster", () => {
  const roster = [
    model("openai-codex/current", { relativeCost: 20 }),
    model("anthropic/current", { relativeCost: 20 }),
  ];
  const chains = deriveChains({
    roles: { default: "openai-codex/current" },
    ladder: ["openai-codex", "anthropic"],
    roster,
  });
  const repaired = validatePlan({
    roles: { default: "anthropic/disabled" },
    chains: { default: ["anthropic/disabled", "openai-codex/current"] },
  }, [model("openai-codex/current", { relativeCost: 20 })]);

  assert.equal(Object.hasOwn(chains, "anthropic/disabled"), false);
  assert.deepEqual(chains["openai-codex/current"], ["anthropic/current"]);
  assert.deepEqual(repaired.plan.roles, { default: "openai-codex/current" });
  assert.deepEqual(repaired.plan.chains, {});
});

test("colon-bearing model ids retain valid thinking suffixes and canonicalize duplicate fallbacks", () => {
  const roster = [
    model("remote/nova"),
    model("remote/nova:batch"),
    model("remote/literal:off"),
    model("fallback/alt"),
  ];
  const resolved = resolveRosterModel("remote/nova:batch:high", roster);
  const { plan } = validatePlan({
    roles: { default: "remote/nova:batch:high" },
    chains: {
      default: ["fallback/alt:high", "fallback/alt:high", "fallback/alt"],
    },
  }, roster);

  assert.equal(resolveRosterModel("remote/nova:batch", [model("remote/nova")]), null);
  assert.equal(resolveRosterModel("remote/nova:batch", roster)?.selector, "remote/nova:batch");
  assert.equal(resolveRosterModel("remote/literal:off", roster)?.selector, "remote/literal:off");
  assert.equal(resolved?.selector, "remote/nova:batch");
  for (const suffix of ["off", "inherit", "med", "xhi", "auto"]) {
    assert.equal(resolveRosterModel("remote/nova:batch:" + suffix, roster)?.selector, "remote/nova:batch");
  }
  assert.equal(resolveRosterModel("remote/nova:batch:unrecognized", roster), null);
  assert.equal(resolveRosterModel("remote/nova:batch:m", roster), null);
  assert.equal(resolveRosterModel("remote/nova:batch:MED", roster), null);
  assert.equal(plan.roles.default, "remote/nova:batch:high");
  assert.deepEqual(plan.chains.default, ["fallback/alt:high"]);
});

// omp 18.12.3 added the `widget` role (job widgets and captions). An older
// engine never consults modelRoles.widget, so nothing may propose or write it
// there; on a newer one it is planned like smol, a small cheap model.
const OLD_ENGINE_ROLES = ["default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor", "image", "web", "speech", "dictation", "judge"];
const NEW_ENGINE_ROLES = [...OLD_ENGINE_ROLES.slice(0, 10), "widget", ...OLD_ENGINE_ROLES.slice(10)];
const WIDGET_ROSTER = [
  model("openai-codex/big", { relativeCost: 30, vision: true, rolePriority: { slow: 0 } }),
  model("openai-codex/mini", { reasoning: false, relativeCost: 1, rolePriority: { smol: 0 } }),
];

test("planRoleNames offers widget only when the engine's live role list has it", () => {
  assert.equal(ROLE_NAMES.includes("widget"), true);
  assert.equal(planRoleNames(OLD_ENGINE_ROLES).includes("widget"), false);
  assert.deepEqual(planRoleNames(OLD_ENGINE_ROLES), ROLE_NAMES.filter((role) => role !== "widget"));
  assert.equal(planRoleNames(NEW_ENGINE_ROLES).includes("widget"), true);
  // A role the engine dropped is never offered either.
  assert.equal(planRoleNames(["default", "smol"]).includes("advisor"), false);
});

test("the heuristic plans widget like smol, and only on an engine that has it", () => {
  const newPlan = heuristicPlan(WIDGET_ROSTER, { roleNames: planRoleNames(NEW_ENGINE_ROLES) });
  assert.equal(newPlan.roles.widget, "openai-codex/mini");
  assert.equal(newPlan.roles.widget, newPlan.roles.smol);
  assert.equal(newPlan.roles.default, "openai-codex/big");
  assert.equal(newPlan.rationale.some((entry) => entry.subject === "widget"), true);

  const oldPlan = heuristicPlan(WIDGET_ROSTER, { roleNames: planRoleNames(OLD_ENGINE_ROLES) });
  assert.equal("widget" in oldPlan.roles, false);
  assert.equal(oldPlan.rationale.some((entry) => entry.subject === "widget"), false);
});

test("a widget proposal is dropped, constrained away and chain-less on an engine without the role", () => {
  const oldRoles = planRoleNames(OLD_ENGINE_ROLES);
  const draft = { roles: { default: "openai-codex/big", widget: "openai-codex/big" }, ladder: ["openai-codex"], rationale: [] };

  const constrained = constrainPlanDraft(draft, WIDGET_ROSTER, oldRoles);
  assert.equal("widget" in constrained.draft.roles, false);

  const chains = deriveChains({ roles: constrained.draft.roles, ladder: ["openai-codex"], roster: WIDGET_ROSTER, roleNames: oldRoles });
  assert.equal("widget" in chains, false);

  const validated = validatePlan({ roles: draft.roles, chains: {} }, WIDGET_ROSTER, oldRoles);
  assert.equal("widget" in validated.plan.roles, false);
  assert.equal(validated.warnings.some((warning) => warning.includes('"widget"')), true);

  const newRoles = planRoleNames(NEW_ENGINE_ROLES);
  assert.equal("widget" in validatePlan({ roles: draft.roles, chains: {} }, WIDGET_ROSTER, newRoles).plan.roles, true);
  // A flagship widget proposal is replaced by a lightweight model, as for smol.
  const flagship = constrainPlanDraft(draft, WIDGET_ROSTER, newRoles);
  assert.equal(flagship.draft.roles.widget, "openai-codex/mini");
});

test("the planner and research prompts brief widget and memory", async () => {
  const { ROLE_BRIEF_LINES } = await jiti.import("./planner.ts");
  assert.match(ROLE_BRIEF_LINES.widget, /^widget - /);
  assert.match(ROLE_BRIEF_LINES.widget, /cheap/);
  assert.match(ROLE_BRIEF_LINES.memory, /^memory - /);
});
