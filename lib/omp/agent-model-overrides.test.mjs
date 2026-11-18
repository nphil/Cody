import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `task.agentModelOverrides` in omp's config.yml: what Settings › Models ›
 * Helper agents and the helper window's "Change model" write. Every case runs
 * on a throwaway agent folder; the real config.yml is never named.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const overrides = await jiti.import("./agent-model-overrides.ts");

/** A temporary agent folder (PI_CODING_AGENT_DIR) holding `yaml` as config.yml, or no file at all. */
function agentDir(t, yaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-overrides-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const config = path.join(dir, "config.yml");
  if (yaml !== undefined) fs.writeFileSync(config, yaml);
  return { dir, config, text: () => fs.readFileSync(config, "utf8") };
}

test("setting one agent on an empty folder creates the setting and nothing else", (t) => {
  const { config, text } = agentDir(t);
  overrides.setAgentModelOverride("heavy-task", "@default");
  assert.equal(text(), "task:\n  agentModelOverrides:\n    heavy-task: \"@default\"\n");
  assert.deepEqual(overrides.readAgentModelOverrides(), { "heavy-task": "@default" });
  assert.ok(fs.existsSync(config));
});

test("setting keeps comments, sibling settings and other agents, and replaces the same agent", (t) => {
  const { text } = agentDir(t, [
    "# my config",
    "theme: dark",
    "task:",
    "  eager: true",
    "  agentModelOverrides:",
    "    # the heavy lifter",
    "    deep-task: \"@slow\"",
    "    task: \"@task\"",
    "",
  ].join("\n"));
  overrides.setAgentModelOverride("task", "anthropic/claude-opus-5-5");
  overrides.setAgentModelOverride("heavy-task", "@default");
  const written = text();
  assert.match(written, /^# my config$/m);
  assert.match(written, /^theme: dark$/m);
  assert.match(written, /^ {2}eager: true$/m);
  assert.match(written, /# the heavy lifter/);
  assert.deepEqual(overrides.readAgentModelOverrides(), {
    "deep-task": "@slow",
    task: "anthropic/claude-opus-5-5",
    "heavy-task": "@default",
  });
});

test("clearing removes just that agent, and an emptied setting leaves no empty shell", (t) => {
  const { text } = agentDir(t, "theme: dark\ntask:\n  agentModelOverrides:\n    deep-task: \"@slow\"\n    task: \"@task\"\n");
  overrides.setAgentModelOverride("deep-task", null);
  assert.deepEqual(overrides.readAgentModelOverrides(), { task: "@task" });
  overrides.setAgentModelOverride("task", null);
  assert.equal(text(), "theme: dark\n");
  assert.deepEqual(overrides.readAgentModelOverrides(), {});
});

test("clearing an agent that has no setting does not touch the file", (t) => {
  const missing = agentDir(t);
  overrides.setAgentModelOverride("heavy-task", null);
  assert.equal(fs.existsSync(missing.config), false, "no file is created just to clear nothing");
  const body = "# untouched\ntask:\n    agentModelOverrides: {task: '@task'}\n";
  const present = agentDir(t, body);
  overrides.setAgentModelOverride("heavy-task", null);
  assert.equal(present.text(), body, "not even re-formatted");
});

test("a value that is neither a role nor one exact model is refused, and so is a bad agent name", (t) => {
  const body = "task:\n  agentModelOverrides:\n    task: \"@task\"\n";
  const { text } = agentDir(t, body);
  for (const bad of ["claude-opus", "", "@", "a b/c", "provider/", "x".repeat(300)]) {
    assert.throws(() => overrides.setAgentModelOverride("task", bad), /role such as @slow/, `refused ${JSON.stringify(bad.slice(0, 12))}`);
  }
  for (const name of ["", "../etc", "a/b", " space", "-dash"]) {
    assert.throws(() => overrides.setAgentModelOverride(name, "@slow"), /not an agent name/);
  }
  assert.equal(text(), body, "nothing was written");
});

test("a hand-written list survives every kind of write and is shown by the entries reader only", (t) => {
  agentDir(t, "task:\n  agentModelOverrides:\n    deep-task:\n      - anthropic/claude-opus-5-5\n      - openai/gpt-5\n    task: \"@task\"\n");
  assert.deepEqual(overrides.readAgentModelOverrideEntries(), {
    "deep-task": ["anthropic/claude-opus-5-5", "openai/gpt-5"],
    task: "@task",
  });
  assert.deepEqual(overrides.readAgentModelOverrides(), { task: "@task" }, "the routing reader never sees lists");
  // The routing reconcile rewrites the string entries it saw; the list it never saw must stay.
  overrides.writeAgentModelOverrides({ task: "@smol", sonic: "@smol" });
  assert.deepEqual(overrides.readAgentModelOverrideEntries(), {
    sonic: "@smol",
    task: "@smol",
    "deep-task": ["anthropic/claude-opus-5-5", "openai/gpt-5"],
  });
  overrides.setAgentModelOverride("heavy-task", "@default");
  assert.deepEqual(overrides.readAgentModelOverrideEntries()["deep-task"], ["anthropic/claude-opus-5-5", "openai/gpt-5"]);
  // Choosing something for that agent is the one thing that replaces it.
  overrides.setAgentModelOverride("deep-task", "@slow");
  assert.equal(overrides.readAgentModelOverrideEntries()["deep-task"], "@slow");
});

test("a config that is not a mapping, or not YAML, is never overwritten", (t) => {
  const list = agentDir(t, "- one\n- two\n");
  assert.throws(() => overrides.setAgentModelOverride("task", "@slow"), /must contain a YAML mapping/);
  assert.equal(list.text(), "- one\n- two\n");
  const broken = agentDir(t, "task: [unclosed\n");
  assert.throws(() => overrides.setAgentModelOverride("task", "@slow"), /not valid YAML/);
  assert.equal(broken.text(), "task: [unclosed\n");
});
