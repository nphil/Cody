import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  hermesExternalSkillDirs,
  hermesPackageForIdentifier,
  hermesSkillIdentifier,
  hermesSkillMatchesPlatform,
  installHermesSkill,
  readHermesDisabledSkills,
  readHermesSkillLock,
} = await jiti.import("./hermes-skills.ts");

/** A stand-in for the `hermes` binary that ignores its argv, prints captured
 * 0.19.0 output, and exits the way the real one does. */
let fakeCount = 0;
function fakeHermes(dir, body) {
  const file = path.join(dir, `fake-hermes-${fakeCount++}.mjs`);
  fs.writeFileSync(
    file,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(body)});\nprocess.exit(0);\n`,
    { mode: 0o755 },
  );
  return file;
}

test("a Cody store spec becomes the identifier Hermes' registry uses", () => {
  // `hermes skills search --json` reports skills.sh entries as
  // skills-sh/<owner>/<repo>/<slug>; Cody's store produces owner/repo@slug.
  assert.equal(hermesSkillIdentifier("jwynia/agent-skills@pdf-generator"), "skills-sh/jwynia/agent-skills/pdf-generator");
  assert.equal(hermesSkillIdentifier("  anthropics/skills@pdf  "), "skills-sh/anthropics/skills/pdf");
  // A direct SKILL.md URL is already a Hermes identifier (its UrlSource).
  assert.equal(hermesSkillIdentifier("https://example.com/skills/foo/SKILL.md"), "https://example.com/skills/foo/SKILL.md");
  // A whole-provider bundle is not: `npx skills add https://<domain>` installs
  // a provider's entire set, which Hermes has no way to express.
  assert.equal(hermesSkillIdentifier("https://example.com"), null);
  assert.equal(hermesSkillIdentifier("no-at-sign"), null);
  assert.equal(hermesSkillIdentifier("too/many/segments@slug"), null);
  assert.equal(hermesSkillIdentifier(""), null);
});

test("the identifier maps back to the spec the store compares against", () => {
  assert.equal(hermesPackageForIdentifier("skills-sh/jwynia/agent-skills/pdf-generator"), "jwynia/agent-skills@pdf-generator");
  // Hermes' other registries have no skills.sh equivalent, and inventing one
  // would make an unrelated store row read as installed.
  assert.equal(hermesPackageForIdentifier("browse-sh/uspto.gov/search-patents-nwh84a"), null);
  assert.equal(hermesPackageForIdentifier("1password"), null);
});

test("install success is read from the output, because the exit code is always 0", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-hermes-install-"));

  // Verified against hermes-agent 0.19.0: all three of these exit 0.
  const blocked = fakeHermes(dir, [
    "Fetching: official/security/1password",
    "Running security scan...",
    "Decision: BLOCKED — Blocked (community source + caution verdict, 2 findings).",
    "",
    "Installation blocked: Blocked (community source + caution verdict, 2 findings).",
    "",
  ].join("\n"));
  const missing = fakeHermes(dir, "Fetching: skills-sh/openai/skills/pdf\nError: Could not fetch 'skills-sh/openai/skills/pdf' from any source.\n");
  const ok = fakeHermes(dir, "Fetching: skills-sh/jwynia/agent-skills/pdf-generator\nInstalled: document/pdf-generator\nFiles: SKILL.md, tools.md\n");

  const run = (script) => installHermesSkill(script, "skills-sh/owner/repo/slug");

  assert.equal((await run(blocked)).ok, false, "a blocked install is not a success");
  assert.equal((await run(missing)).ok, false, "an unresolvable identifier is not a success");
  const installed = await run(ok);
  assert.equal(installed.ok, true);
  assert.equal(installed.installed, "document/pdf-generator");
});

test("external skill dirs are expanded the way Hermes expands them", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cody-hermes-fakehome-"));
  const hermesHome = path.join(home, ".hermes");
  fs.mkdirSync(path.join(hermesHome, "skills"), { recursive: true });
  const tilde = path.join(home, "shared-skills");
  const relative = path.join(hermesHome, "extra");
  fs.mkdirSync(tilde);
  fs.mkdirSync(relative);
  process.env.CODY_TEST_SKILLS_DIR = tilde;

  fs.writeFileSync(
    path.join(hermesHome, "config.yaml"),
    [
      "skills:",
      "  external_dirs:",
      "    - ~/shared-skills",
      "    - extra",
      "    - ${CODY_TEST_SKILLS_DIR}",
      "    - /definitely/not/here",
      "    - skills",
      "",
    ].join("\n"),
  );

  try {
    // ~ and ${VAR} expand, a relative entry resolves against HERMES_HOME, a
    // missing dir is dropped, duplicates collapse, and the local skills dir is
    // skipped because it is already the primary root.
    assert.deepEqual(hermesExternalSkillDirs(hermesHome, home), [tilde, relative]);
  } finally {
    delete process.env.CODY_TEST_SKILLS_DIR;
  }
});

test("disabled names tolerate the scalar form Hermes accepts", () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), "cody-hermes-cfg-"));
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), "skills:\n  disabled: lone-skill\n");
  assert.deepEqual([...readHermesDisabledSkills(hermesHome)], ["lone-skill"]);

  fs.writeFileSync(path.join(hermesHome, "config.yaml"), "skills:\n  disabled:\n    - a\n    - b\n");
  assert.deepEqual([...readHermesDisabledSkills(hermesHome)].sort(), ["a", "b"]);

  // No config yet is the normal state of a fresh install.
  fs.rmSync(path.join(hermesHome, "config.yaml"));
  assert.equal(readHermesDisabledSkills(hermesHome).size, 0);
});

test("platform gating mirrors Hermes' own alias table", () => {
  assert.equal(hermesSkillMatchesPlatform(undefined, "linux"), true, "no list means every platform");
  assert.equal(hermesSkillMatchesPlatform([], "linux"), true);
  assert.equal(hermesSkillMatchesPlatform(["macos"], "darwin"), true);
  assert.equal(hermesSkillMatchesPlatform(["windows"], "win32"), true);
  assert.equal(hermesSkillMatchesPlatform(["macos"], "linux"), false);
  // A bare scalar is a one-element list, not a set of characters.
  assert.equal(hermesSkillMatchesPlatform("linux", "linux"), true);
});

test("an absent or malformed hub lock is empty, never a throw", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-hermes-lock-"));
  assert.equal(readHermesSkillLock(root).size, 0);
  fs.mkdirSync(path.join(root, ".hub"));
  fs.writeFileSync(path.join(root, ".hub", "lock.json"), "{ not json");
  assert.equal(readHermesSkillLock(root).size, 0);
});
