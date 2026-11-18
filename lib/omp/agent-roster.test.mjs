import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ompTestPackageBin } from "./omp-test-package.mjs";

/**
 * Which helper agents omp can start (lib/omp/agent-roster.ts): its agent files
 * found the way omp finds them, and its built-in agents listed by asking omp.
 * Everything runs on throwaway folders; the real agent folder is never named.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const roster = await jiti.import("./agent-roster.ts");
const ompCli = await jiti.import("./omp-cli.ts");

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-roster-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const agentText = (name, description, model) =>
  ["---", `name: ${name}`, `description: ${description}`, ...(model === undefined ? [] : [`model: ${model}`]), "---", "", "You are a helper.", ""].join("\n");

test("an agent file counts only when omp would load it", () => {
  const parse = roster.parseAgentFile;
  assert.deepEqual(parse(agentText("deep-task", "Slow thinker", '"@slow"')), { name: "deep-task", description: "Slow thinker", model: ["@slow"] });
  assert.deepEqual(parse(agentText("x", "d", "anthropic/a, openai/b")).model, ["anthropic/a", "openai/b"], "a comma list");
  assert.deepEqual(parse("---\nname: x\ndescription: d\nmodel:\n  - a/b\n  - c/d\n---\n").model, ["a/b", "c/d"], "a YAML list");
  assert.deepEqual(parse(agentText("x", "d")).model, [], "no model: at all");
  assert.equal(parse("\uFEFF" + agentText("x", "d"))?.name, "x", "a byte-order mark is fine");
  assert.equal(parse("---\r\nname: x\r\ndescription: d\r\n---\r\nbody")?.name, "x", "Windows line endings");
  assert.equal(parse("---\nname: x\ndescription: line one\n  line two\n---\n")?.description, "line one line two");
  assert.equal(parse(`---\nname: x\ndescription: ${"w ".repeat(400)}\n---\n`).description.length, 300, "long descriptions are cut");
  assert.equal(parse("no frontmatter"), null);
  assert.equal(parse("---\nname: x\n---\n"), null, "a description is required");
  assert.equal(parse("---\ndescription: d\n---\n"), null, "a name is required");
  assert.equal(parse("---\nname: 7\ndescription: d\n---\n"), null, "the name must be text");
  assert.equal(parse("---\nname: x\ndescription: d: e: [\n---\n"), null, "broken YAML");
  for (const reserved of ["main", "sub", "Main", "SUB"]) assert.equal(parse(agentText(reserved, "d")), null, `${reserved} is reserved`);
  for (const bad of ["has space", "../up", "a/b", "-lead"]) assert.equal(parse(agentText(`"${bad}"`, "d")), null, `${bad} cannot be written into config.yml`);
});

test("a folder of agents: only .md files, sorted, size-capped, bad files skipped", (t) => {
  const dir = folder(t);
  put(path.join(dir, "b-agent.md"), agentText("b-agent", "B"));
  put(path.join(dir, "a-agent.md"), agentText("a-agent", "A", '"@smol"'));
  put(path.join(dir, "notes.txt"), agentText("not-md", "ignored"));
  put(path.join(dir, "broken.md"), "---\nname: [\n---\n");
  put(path.join(dir, "huge.md"), agentText("huge", "too big") + "x".repeat(300 * 1024));
  fs.mkdirSync(path.join(dir, "folder.md"));
  const found = roster.readAgentDirectory(dir, "project", "/the/project");
  assert.deepEqual(found.map((entry) => entry.name), ["a-agent", "b-agent"]);
  assert.deepEqual(found[0], { name: "a-agent", description: "A", model: ["@smol"], origin: "project", path: path.join(dir, "a-agent.md"), projectRoot: "/the/project" });
  assert.deepEqual(roster.readAgentDirectory(path.join(dir, "missing"), "user"), []);
  const bundled = roster.readAgentDirectory(dir, "bundled");
  assert.ok(bundled.every((entry) => !("path" in entry)), "a built-in's temporary file path is never exposed");
});

test("the project folder is the nearest .omp/agents above the chat's folder, and .claude/agents is not used", (t) => {
  const root = folder(t);
  const project = path.join(root, "game");
  put(path.join(project, ".omp", "agents", "heavy-task.md"), agentText("heavy-task", "Heavy", '"@default"'));
  put(path.join(root, "other", ".claude", "agents", "claude-only.md"), agentText("claude-only", "Not a helper agent here"));
  fs.mkdirSync(path.join(project, "src", "deep"), { recursive: true });
  fs.mkdirSync(path.join(root, "other", "src"), { recursive: true });
  assert.equal(roster.nearestProjectAgentDir(path.join(project, "src", "deep")), path.join(project, ".omp", "agents"));
  assert.equal(roster.nearestProjectAgentDir(project), path.join(project, ".omp", "agents"));
  assert.equal(roster.nearestProjectAgentDir(path.join(root, "other", "src")), null);
  // A nearer folder shadows a farther one, as omp does.
  put(path.join(project, "src", ".omp", "agents", "inner.md"), agentText("inner", "Inner"));
  assert.equal(roster.nearestProjectAgentDir(path.join(project, "src", "deep")), path.join(project, "src", ".omp", "agents"));
});

test("custom agents: the user folder (moved in omp 18.18.8) and each distinct project folder", (t) => {
  const root = folder(t);
  const agentDir = path.join(root, "agent");
  const home = path.join(root, "home");
  const project = path.join(root, "lgtv");
  put(path.join(agentDir, "agents", "deep-task.md"), agentText("deep-task", "Slow", '"@slow"'));
  put(path.join(home, ".omp", "agent", "agents", "old-place.md"), agentText("old-place", "Before 18.18.8"));
  put(path.join(project, ".omp", "agents", "heavy-task.md"), agentText("heavy-task", "Heavy", '"@default"'));
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  const search = { agentDir, home, projectRoots: [project, path.join(project, "src"), path.join(root, "nowhere")], engineVersion: "18.22.2" };
  const now = roster.discoverCustomAgents(search);
  assert.deepEqual(now.map((entry) => `${entry.origin}:${entry.name}`), ["user:deep-task", "project:heavy-task"], "two roots in one project give one folder");
  assert.equal(now[1].projectRoot, project);
  const before = roster.discoverCustomAgents({ ...search, engineVersion: "18.18.7" });
  assert.deepEqual(before.map((entry) => entry.name), ["old-place", "heavy-task"], "an older omp reads the user folder from its old place");
  assert.equal(roster.discoverCustomAgents({ ...search, engineVersion: null })[0].name, "deep-task", "an unknown version counts as current");
});

test("the one-time switch needs an omp that announces helpers before they start; an unreadable version does not qualify", () => {
  const atLeast = ompCli.versionAtLeast;
  assert.equal(atLeast("18.22.2", roster.SPAWN_HOOK_SINCE), true);
  assert.equal(atLeast("18.19.0", roster.SPAWN_HOOK_SINCE), true);
  assert.equal(atLeast("18.20.1", roster.SPAWN_HOOK_SINCE), true);
  assert.equal(atLeast("18.18.9", roster.SPAWN_HOOK_SINCE), false);
  assert.equal(atLeast("18.8.3", roster.SPAWN_HOOK_SINCE), false, "compared as numbers, not text");
  assert.equal(atLeast(null, roster.SPAWN_HOOK_SINCE), false);
});

/** A stand-in omp: answers --version, and `agents unpack --dir D` writes what `files` says into D, noting what it saw. */
function fakeOmp(t, { files = {}, exitCode = 0 } = {}) {
  const dir = folder(t);
  const seen = path.join(dir, "seen.txt");
  const count = path.join(dir, "unpack-count");
  const bin = path.join(dir, "omp");
  const writes = Object.entries(files)
    .map(([name, text]) => `printf '%s' '${text.replace(/'/g, "'\\''")}' > "$out/${name}"`)
    .join("\n");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "omp/18.22.2"; exit 0; fi
echo run >> "${count}"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--dir" ]; then out="$2"; shift; fi
  shift
done
printf 'HOME=%s\\nAGENT=%s\\nCONFIG_DIR=%s\\nOUT=%s\\n' "$HOME" "$PI_CODING_AGENT_DIR" "$PI_CONFIG_DIR" "$out" > "${seen}"
mkdir -p "$out"
${writes}
exit ${exitCode}
`,
    { mode: 0o755 },
  );
  const runs = () => (fs.existsSync(count) ? fs.readFileSync(count, "utf8").trim().split("\n").length : 0);
  const saw = () => Object.fromEntries(fs.readFileSync(seen, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  return { bin, runs, saw };
}

test("the built-in agents come from asking omp, under a throwaway home that is removed afterwards", { skip: process.platform === "win32" }, async (t) => {
  const previousConfigDir = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = "inherited-setting";
  t.after(() => {
    if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = previousConfigDir;
  });
  const omp = fakeOmp(t, {
    files: {
      "task.md": agentText("task", "General helper"),
      "sonic.md": agentText("sonic", "Quick helper", '"@smol"'),
      "init.md": "no frontmatter: not an agent",
    },
  });
  const result = await roster.unpackBundledAgents(omp.bin);
  assert.equal(result.error, null);
  assert.deepEqual(result.agents.map((entry) => entry.name), ["sonic", "task"]);
  assert.ok(result.agents.every((entry) => entry.origin === "bundled" && !("path" in entry)));
  const saw = omp.saw();
  assert.notEqual(saw.HOME, os.homedir(), "not the real home");
  assert.ok(saw.HOME.startsWith(os.tmpdir()) && saw.AGENT.startsWith(os.tmpdir()), "a throwaway home and agent folder");
  assert.equal(saw.CONFIG_DIR, "", "an inherited PI_* setting cannot point it at the real config");
  assert.equal(fs.existsSync(path.dirname(saw.OUT)), false, "the throwaway folder is gone");
});

test("a listing that fails or comes back empty says why, and lists nothing", { skip: process.platform === "win32" }, async (t) => {
  const failing = await roster.unpackBundledAgents(fakeOmp(t, { exitCode: 3 }).bin);
  assert.deepEqual(failing.agents, []);
  assert.match(failing.error, /./);
  const empty = await roster.unpackBundledAgents(fakeOmp(t).bin);
  assert.deepEqual(empty, { agents: [], error: "omp wrote no built-in agents" });
  const missing = await roster.unpackBundledAgents(path.join(os.tmpdir(), "no-such-omp-binary"));
  assert.deepEqual(missing.agents, []);
  assert.match(missing.error, /ENOENT|no-such-omp-binary/);
});

test("the built-in list is asked for once per omp, and a failure is not asked again straight away", { skip: process.platform === "win32" }, async (t) => {
  const previousBin = process.env.CODY_OMP_BIN;
  t.after(() => {
    if (previousBin === undefined) delete process.env.CODY_OMP_BIN;
    else process.env.CODY_OMP_BIN = previousBin;
    ompCli.invalidateOmpCliCache();
    roster.clearBundledAgentsCache();
  });
  const good = fakeOmp(t, { files: { "task.md": agentText("task", "General helper") } });
  process.env.CODY_OMP_BIN = good.bin;
  ompCli.invalidateOmpCliCache();
  roster.clearBundledAgentsCache();
  const [first, second] = [await roster.bundledAgents(), await roster.bundledAgents()];
  assert.deepEqual(first.agents.map((entry) => entry.name), ["task"]);
  assert.equal(second, first, "the second call is answered from the cache");
  assert.equal(good.runs(), 1, "listed once");

  const bad = fakeOmp(t, { exitCode: 1 });
  process.env.CODY_OMP_BIN = bad.bin;
  ompCli.invalidateOmpCliCache();
  roster.clearBundledAgentsCache();
  const failed = await roster.bundledAgents();
  assert.notEqual(failed.error, null);
  await roster.bundledAgents();
  assert.equal(bad.runs(), 1, "a failure within the minute is not retried");
});

test("the engine installed here lists the agents omp ships", { skip: ompTestPackageBin() === null && "no omp available" }, async () => {
  const result = await roster.unpackBundledAgents(ompTestPackageBin());
  if (result.error !== null) return; // an omp too old to unpack its agents: the page says so instead of guessing
  const names = result.agents.map((entry) => entry.name);
  for (const expected of ["task", "reviewer", "scout"]) assert.ok(names.includes(expected), `${expected} in ${names.join(", ")}`);
  assert.ok(result.agents.every((entry) => entry.description !== "" && entry.origin === "bundled"));
});
