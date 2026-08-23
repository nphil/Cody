import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Skill discovery under the HERMES engine. Hermes reads a narrower root set
 * than omp and a DEEPER one: `$HERMES_HOME/skills` plus the
 * `skills.external_dirs` from its config.yaml, each walked recursively
 * (agent/skill_utils.iter_skill_index_files), because
 * `hermes skills install --category <c>` nests a skill at
 * `skills/<c>/<name>/SKILL.md`. Cody's flat one-level readdir found none of
 * those, so this pins the walk, the exclusions, and the two other places
 * Hermes disagrees with omp: enable/disable lives in `skills.disabled` in
 * config.yaml, and a `platforms:` mismatch hides a skill entirely.
 *
 * The Cody agent dir is redirected before anything imports it, so the
 * persisted engine selection lives in this test's sandbox.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-hermes-state-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
fs.writeFileSync(
  path.join(agentDir, "cody-engine.json"),
  JSON.stringify({ version: 1, activeEngine: "hermes", onboarded: true, updatedAt: new Date().toISOString() }),
);

const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), "cody-hermes-home-"));
process.env.HERMES_HOME = hermesHome;
const skillsRoot = path.join(hermesHome, "skills");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { discoverSkills, getSkillScanRootDirs, loadSkillsWithInstallInfo } =
  await jiti.import("./skills-service.ts");

function writeSkill(dir, name, extraFrontmatter = "") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} does things.\n${extraFrontmatter}---\n\n# ${name}\n`,
  );
}

function writeConfig(body) {
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), body);
}

test("hermes scan roots are its own skills dir plus configured external dirs", () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "cody-hermes-ext-"));
  writeConfig(`skills:\n  external_dirs:\n    - ${external}\n    - /nonexistent/never/created\n`);

  const roots = getSkillScanRootDirs(os.homedir());
  assert.deepEqual(roots, [skillsRoot, external], "own root first, then existing external dirs");

  // Roots Hermes never reads must not be scanned, and there is no project
  // scope at all: nothing may be derived from the workspace.
  for (const root of roots) {
    assert.doesNotMatch(root, /\.omp[/\\]|\.claude[/\\]|\.codex[/\\]|\.github[/\\]|\.agents[/\\]|managed-skills/, root);
  }
  writeConfig("skills: {}\n");
});

test("discoverSkills walks category folders, which a flat scan would miss", async () => {
  writeSkill(path.join(skillsRoot, "flat-skill"), "flat-skill");
  writeSkill(path.join(skillsRoot, "security", "nested-skill"), "nested-skill");
  writeSkill(path.join(skillsRoot, "ops", "deploy", "deep-skill"), "deep-skill");

  const { skills } = await discoverSkills(os.homedir());
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  assert.ok(byName.has("flat-skill"), "one level, as `hermes skills install` writes with no --category");
  assert.ok(byName.has("nested-skill"), "skills/<category>/<name>/SKILL.md");
  assert.ok(byName.has("deep-skill"), "categories nest further than one level");
  assert.equal(byName.get("nested-skill").sourceInfo.source, ".hermes");
  assert.equal(byName.get("nested-skill").sourceInfo.scope, "user");
  assert.equal(
    byName.get("deep-skill").filePath,
    path.join(skillsRoot, "ops", "deploy", "deep-skill", "SKILL.md"),
  );
});

test("the walk prunes what Hermes prunes", async () => {
  // Hermes' own install bookkeeping, and the dependency/VCS dirs in
  // EXCLUDED_SKILL_DIRS.
  writeSkill(path.join(skillsRoot, ".hub", "quarantine", "quarantined"), "quarantined");
  writeSkill(path.join(skillsRoot, "vendor", "node_modules", "pkg"), "vendored");
  // A support dir INSIDE a skill package holds documentation, not a skill.
  writeSkill(path.join(skillsRoot, "host-skill"), "host-skill");
  writeSkill(path.join(skillsRoot, "host-skill", "references", "archived"), "archived-copy");
  // ...but a CATEGORY named `scripts` is a real category: the pruning rule
  // only bites when the containing directory is itself a skill.
  writeSkill(path.join(skillsRoot, "scripts", "category-skill"), "category-skill");

  const { skills } = await discoverSkills(os.homedir());
  const names = new Set(skills.map((skill) => skill.name));

  assert.ok(!names.has("quarantined"), ".hub is Hermes' own bookkeeping");
  assert.ok(!names.has("vendored"), "node_modules is never a skill root");
  assert.ok(!names.has("archived-copy"), "references/ inside a skill is documentation");
  assert.ok(names.has("host-skill"));
  assert.ok(names.has("category-skill"), "a category may legitimately be named scripts");
});

test("enable/disable reads skills.disabled, not the SKILL.md frontmatter", async () => {
  // omp's key must have no effect here: Hermes never reads it, so honouring
  // it would report a skill as off that the engine still loads.
  writeSkill(path.join(skillsRoot, "toggle-skill"), "toggle-skill", "disable-model-invocation: true\n");
  writeSkill(path.join(skillsRoot, "config-off"), "config-off");
  writeConfig("skills:\n  disabled:\n    - config-off\n");

  const { skills } = await discoverSkills(os.homedir());
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  assert.equal(byName.get("toggle-skill").disableModelInvocation, false, "frontmatter key is inert for Hermes");
  assert.equal(byName.get("config-off").disableModelInvocation, true, "skills.disabled is the answer");
  writeConfig("skills: {}\n");
});

test("a platforms mismatch hides the skill, as it does in Hermes", async () => {
  const otherPlatform = process.platform === "win32" ? "linux" : "windows";
  writeSkill(path.join(skillsRoot, "wrong-os"), "wrong-os", `platforms: [${otherPlatform}]\n`);
  writeSkill(path.join(skillsRoot, "right-os"), "right-os", "platforms: [linux, macos, windows]\n");

  const { skills } = await discoverSkills(os.homedir());
  const names = new Set(skills.map((skill) => skill.name));
  assert.ok(!names.has("wrong-os"), "Hermes would not load it, so Cody must not list it");
  assert.ok(names.has("right-os"));
});

test("install provenance comes from Hermes' .hub/lock.json, not the skills.sh lock", async () => {
  writeSkill(path.join(skillsRoot, "document", "pdf-generator"), "pdf-generator");
  fs.mkdirSync(path.join(skillsRoot, ".hub"), { recursive: true });
  fs.writeFileSync(
    path.join(skillsRoot, ".hub", "lock.json"),
    JSON.stringify({
      version: 1,
      installed: {
        "pdf-generator": {
          source: "skills.sh",
          identifier: "skills-sh/jwynia/agent-skills/pdf-generator",
          install_path: "document/pdf-generator",
          content_hash: "sha256:abc123",
          metadata: { source_url: "https://example.invalid/SKILL.md" },
        },
      },
    }),
  );

  const { skills } = await loadSkillsWithInstallInfo(os.homedir());
  const install = skills.find((skill) => skill.name === "pdf-generator")?.install;

  assert.ok(install, "a hub-installed skill carries provenance");
  // The store compares this against its own `owner/repo@slug` specs.
  assert.equal(install.package, "jwynia/agent-skills@pdf-generator");
  assert.equal(install.skillsShUrl, "https://skills.sh/jwynia/agent-skills/pdf-generator");
  assert.equal(install.versionHash, "abc123");
  // Cody's update check diffs a GitHub tree hash from the skills.sh lock;
  // Hermes tracks its own and checks it with `hermes skills check`.
  assert.equal(install.canCheckForUpdates, false);
});
