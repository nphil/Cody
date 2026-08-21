import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Skill discovery under the PI engine. pi reads a narrower root set than omp
 * (pi-mono package-manager.js addAutoDiscoveredResources): <cwd>/.pi/skills,
 * .agents/skills walked up to the git root, <agent dir>/skills and
 * ~/.agents/skills — no .claude/.codex/.github compat dirs and no
 * managed-skills. Listing anything else would show skills pi never loads.
 *
 * The agent dir is redirected before anything imports it, so the persisted
 * engine selection and pi's agent dir both live in this test's sandbox.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-pi-skills-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
fs.writeFileSync(
  path.join(agentDir, "cody-engine.json"),
  JSON.stringify({ version: 1, activeEngine: "pi", onboarded: true, updatedAt: new Date().toISOString() }),
);

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { discoverSkills, getSkillScanRootDirs } = await jiti.import("./skills-service.ts");

function writeSkill(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} does things.\n---\n\n# ${name}\n`);
}

function makeRepoCwd() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cody-pi-repo-"));
  fs.mkdirSync(path.join(repo, ".git"));
  const cwd = path.join(repo, "packages", "app");
  fs.mkdirSync(cwd, { recursive: true });
  return { repo, cwd };
}

test("pi scan roots mirror pi's discovery, not omp's", () => {
  const { repo, cwd } = makeRepoCwd();
  const roots = getSkillScanRootDirs(cwd);

  assert.ok(roots.includes(path.join(cwd, ".pi", "skills")), "project .pi/skills");
  assert.ok(roots.includes(path.join(cwd, ".agents", "skills")), ".agents at cwd");
  assert.ok(roots.includes(path.join(repo, ".agents", "skills")), ".agents walk-up to git root");
  assert.ok(roots.includes(path.join(agentDir, "skills")), "pi agent dir skills");
  assert.ok(roots.includes(path.join(os.homedir(), ".agents", "skills")), "user ~/.agents/skills");

  // Roots pi never reads must not be scanned: skills there would be listed
  // but never loaded by the engine.
  for (const root of roots) {
    assert.doesNotMatch(root, /\.omp[/\\]|\.claude[/\\]|\.codex[/\\]|\.github[/\\]|managed-skills/, root);
  }
  // .pi has no walk-up in pi (only the cwd), unlike omp's .omp walk.
  assert.ok(!roots.includes(path.join(repo, ".pi", "skills")), ".pi is cwd-only");
});

test("discoverSkills under pi lists .pi and .agents skills with pi source labels", async () => {
  const { repo, cwd } = makeRepoCwd();
  writeSkill(path.join(cwd, ".pi", "skills"), "project-skill");
  writeSkill(path.join(repo, ".agents", "skills"), "repo-agents-skill");
  writeSkill(path.join(agentDir, "skills"), "user-skill");
  // A .claude skill must NOT appear: pi does not read that dir.
  writeSkill(path.join(cwd, ".claude", "skills"), "claude-only-skill");

  const { skills } = await discoverSkills(cwd);
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  assert.ok(byName.has("project-skill"));
  assert.equal(byName.get("project-skill").sourceInfo.source, ".pi");
  assert.equal(byName.get("project-skill").sourceInfo.scope, "project");
  assert.ok(byName.has("repo-agents-skill"));
  assert.equal(byName.get("repo-agents-skill").sourceInfo.source, ".agents");
  assert.ok(byName.has("user-skill"));
  assert.equal(byName.get("user-skill").sourceInfo.scope, "user");
  assert.ok(!byName.has("claude-only-skill"), "pi never loads .claude skills");
});
