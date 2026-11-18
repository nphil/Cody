import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The rows behind Settings › Models › Helper agents (lib/helper-agents.ts) and
 * the selector rules the page and the routes share (lib/agent-model-selector.ts).
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const agents = await jiti.import("./helper-agents.ts");
const selectors = await jiti.import("./agent-model-selector.ts");

const definition = (name, origin, model = [], extra = {}) => ({ name, description: `${name} helper`, origin, model, ...extra });

test("one row per agent name: highest precedence first, alphabetical, stale settings still listed", () => {
  const rows = agents.buildHelperRoster(
    [
      definition("task", "bundled"),
      definition("deep-task", "user", ["@slow"], { path: "/agent/agents/deep-task.md" }),
      definition("deep-task", "project", ["@default"], { path: "/p/.omp/agents/deep-task.md", projectRoot: "/p" }),
      definition("heavy-task", "project", ["@default"], { projectRoot: "/p" }),
    ],
    { ghost: "@slow", task: "@task" },
    { task: "@task", sonic: "@smol" },
  );
  assert.deepEqual(rows.map((row) => row.name), ["deep-task", "ghost", "heavy-task", "task"]);
  const [deep, ghost, heavy, task] = rows;
  assert.deepEqual(deep.definitions.map((entry) => entry.origin), ["project", "user"]);
  assert.equal(deep.builtIn, false);
  assert.equal(deep.setting, null);
  assert.deepEqual({ ...ghost, definitions: ghost.definitions.length }, { name: "ghost", description: "", builtIn: false, definitions: 0, setting: "@slow", codyDefault: null });
  assert.equal(heavy.codyDefault, null);
  assert.equal(task.builtIn, true);
  assert.equal(task.setting, "@task");
  assert.equal(task.codyDefault, "@task");
});

test("an agent named like an object property gets no setting it does not have, and unusable names get no row", () => {
  const rows = agents.buildHelperRoster([definition("constructor", "user"), definition("toString", "user")], JSON.parse('{"__proto__": "@slow", "bad name": "@slow"}'), {});
  assert.deepEqual(rows.map((row) => row.name), ["constructor", "toString"]);
  for (const row of rows) {
    assert.equal(row.setting, null);
    assert.equal(row.codyDefault, null);
  }
});

test("what an agent runs on, and why: the setting, then its file, then the chat that starts it", () => {
  const status = (setting, ...files) => agents.helperModelStatus({ setting, definitions: files.map((model) => definition("x", "user", model)) });
  assert.deepEqual(status("@slow", ["@task"]), { source: "setting", varies: false, selector: selectors.parseAgentModelSelector("@slow"), list: null });
  assert.deepEqual(status(["a/b", "c/d"]).list, ["a/b", "c/d"]);
  assert.equal(status(null, ["@slow"]).source, "file");
  assert.equal(status(null, ["@slow"]).selector.role, "slow");
  // A file that says nothing, or `default`, follows the chat that starts the helper; `@task` is a role of its own and does not.
  for (const model of [[], ["default"], ["@default"], ["*"], ["pi/default"]]) assert.equal(status(null, model).source, "chat", JSON.stringify(model));
  assert.equal(status(null, ["@task"]).source, "file");
  assert.equal(status(null, ["default", "x/y"]).source, "file", "a list is a choice, even if it starts with default");
  assert.equal(status(null).source, "chat", "no file at all");
});

test("files that disagree are flagged; files that say the same thing, or nothing, are not", () => {
  const varies = (...models) => agents.helperModelStatus({ setting: null, definitions: models.map((model) => definition("x", "user", model)) }).varies;
  assert.equal(varies(["@default"], ["@slow"]), true);
  assert.equal(varies(["@slow"], ["@slow"]), false);
  assert.equal(varies(["@default"], []), false, "both follow the chat");
  assert.equal(varies(["@slow"], []), true);
});

const models = [
  { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { provider: "mock", id: "model-a", name: "Mock A" },
];
const input = { roleNames: ["default", "slow", "smol", "task", "plan"], roles: { slow: "anthropic/claude-opus-5-5", smol: "anthropic/claude-opus-5-5:high" }, models };

test("role choices show the model each role points at, offer only roles the engine has, and keep one already in use", () => {
  const choices = agents.helperRoleChoices(input, "memory");
  assert.deepEqual(choices.map((choice) => choice.selector), ["@default", "@slow", "@smol", "@task", "@plan", "@memory"]);
  assert.equal(choices.find((choice) => choice.role === "slow").model, "Claude Opus 5.5");
  assert.equal(choices.find((choice) => choice.role === "smol").model, "Claude Opus 5.5 · high");
  assert.equal(choices.find((choice) => choice.role === "task").model, null, "no explicit model: the engine's own choice");
  assert.deepEqual(agents.helperRoleChoices({ ...input, roleNames: [] }).map((choice) => choice.role), [...agents.HELPER_ROLE_CHOICES], "an unreadable vocabulary offers the usual roles");
  assert.deepEqual(agents.helperRoleChoices(input, "slow").map((choice) => choice.role), ["default", "slow", "smol", "task", "plan"], "no duplicate");
});

test("exact-model choices are sorted by provider then name, and every choice has a plain name", () => {
  assert.deepEqual(agents.helperModelChoices(input), [
    { selector: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic" },
    { selector: "mock/model-a", label: "Mock A", provider: "mock" },
  ]);
  assert.equal(agents.describeHelperSelector("@slow", input), "Slow (Claude Opus 5.5)");
  assert.equal(agents.describeHelperSelector("@task", input), "Task");
  assert.equal(agents.describeHelperSelector("mock/model-a", input), "Mock A");
  assert.equal(agents.describeHelperSelector("unknown/model", input), "unknown/model");
});

test("a selector is a role, one exact model, or custom; only the first two can be written", () => {
  const read = selectors.parseAgentModelSelector;
  assert.deepEqual(read(" @slow "), { kind: "role", selector: "@slow", role: "slow" });
  assert.deepEqual(read("anthropic/claude-opus-5-5:high"), { kind: "model", selector: "anthropic/claude-opus-5-5:high", provider: "anthropic", modelId: "claude-opus-5-5:high" });
  for (const custom of ["opus", "@", "@1x", "a b/c", "/x", "provider/"]) assert.equal(read(custom)?.kind, "custom", custom);
  for (const none of [undefined, null, 4, "", "   "]) assert.equal(read(none), null);
  assert.equal(selectors.writableAgentModelSelector("@slow"), "@slow");
  assert.equal(selectors.writableAgentModelSelector("a/b"), "a/b");
  assert.equal(selectors.writableAgentModelSelector("opus"), null);
  assert.equal(selectors.roleSelector("task"), "@task");
  assert.ok(selectors.isAgentName("heavy-task") && selectors.isAgentName("a.b_c") && !selectors.isAgentName("../x") && !selectors.isAgentName("-x") && !selectors.isAgentName(""));
});

test("a Select value stands for a role, one exact model or a hand-written value, and reads back as the selector to write", () => {
  assert.equal(agents.helperValue("@slow"), "r:slow");
  assert.equal(agents.helperValue("anthropic/claude-opus-5-5:high"), "m:anthropic/claude-opus-5-5:high");
  assert.equal(agents.helperValue("opus, sonnet"), "c:opus, sonnet");
  assert.equal(agents.helperValue("   "), null);
  assert.equal(agents.helperSelectorOf("r:slow"), "@slow");
  assert.equal(agents.helperSelectorOf("m:mock/model-a"), "mock/model-a");
  assert.equal(agents.helperSelectorOf("c:opus"), null, "a hand-written value writes nothing of its own");
  assert.equal(agents.helperSelectorOf(agents.HELPER_RESET_VALUE), null);
});

test("option groups: reset first, then the roles with their models, then every exact model; the value in use always stays in the list", () => {
  const groups = agents.helperOptionGroups({ ...input, reset: "Reset to Cody's default: Task" });
  assert.deepEqual(groups.map((group) => group.label), ["Reset", "Roles (recommended)", "One exact model (no fallback chain)"]);
  assert.deepEqual(groups[0].options, [{ value: "reset", label: "Reset to Cody's default: Task" }]);
  assert.deepEqual(groups[1].options.map((option) => option.value), ["r:default", "r:slow", "r:smol", "r:task", "r:plan"]);
  assert.equal(groups[1].options.find((option) => option.value === "r:slow").description, "Claude Opus 5.5. Keeps the role's fallback chain.");
  assert.equal(groups[1].options.find((option) => option.value === "r:task").description, "The engine's own choice for this role.");
  assert.deepEqual(groups[2].options.map((option) => option.value), ["m:anthropic/claude-opus-5-5", "m:mock/model-a"]);

  const offered = (current) => agents.helperOptionGroups({ ...input, current }).flatMap((group) => group.options.map((option) => option.value));
  assert.ok(offered("@memory").includes("r:memory"), "a role outside the usual ones");
  assert.ok(offered("anthropic/claude-opus-5-5:high").includes("m:anthropic/claude-opus-5-5:high"), "a model with a reasoning level");
  assert.ok(offered("gone/model").includes("m:gone/model"), "a model that is no longer listed");
  assert.ok(offered("opus, sonnet").includes("c:opus, sonnet"), "a list written by hand");
  assert.ok(!offered("@slow").includes("c:@slow"));

  assert.deepEqual(agents.helperOptionGroups({ ...input, models: [] }).map((group) => group.label), ["Roles (recommended)"], "no empty group");
  const words = { ...agents.ENGLISH_HELPER_WORDS, groupRoles: "R", roleModel: (model) => `m=${model}` };
  const spoken = agents.helperOptionGroups({ ...input, words });
  assert.equal(spoken[0].label, "R");
  assert.equal(spoken[0].options.find((option) => option.value === "r:slow").description, "m=Claude Opus 5.5");
});

test("Reset is offered only where there is a setting to undo, and says where it goes back to", () => {
  const row = (extra) => ({ name: "x", description: "", builtIn: false, definitions: [], setting: null, codyDefault: null, ...extra });
  assert.equal(agents.helperCanReset(row()), false);
  assert.equal(agents.helperCanReset(row({ setting: "@slow" })), true);
  assert.equal(agents.helperCanReset(row({ setting: "@task", codyDefault: "@task" })), false, "already at Cody's default");
  assert.equal(agents.helperCanReset(row({ setting: ["a/b", "c/d"], codyDefault: "@task" })), true);
  assert.equal(agents.helperResetLabel(row(), input), null);
  assert.equal(agents.helperResetLabel(row({ setting: "@slow", codyDefault: "@task" }), input), "Reset to Cody's default: Task");
  assert.equal(agents.helperResetLabel(row({ setting: "@smol", definitions: [definition("x", "user", ["@slow"])] }), input), "Reset to the agent file's choice: Slow (Claude Opus 5.5)");
  assert.equal(agents.helperResetLabel(row({ setting: "@smol", definitions: [definition("x", "user", ["@default"])] }), input), "Reset: use the model of the chat that starts it");
  assert.equal(agents.helperResetLabel(row({ setting: "@smol" }), input), "Remove this setting (no agent file uses it)");
});
