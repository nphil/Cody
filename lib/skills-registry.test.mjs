import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// skills-registry.ts imports via the "@/" path alias, which jiti resolves only
// when it is told the project root.
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const {
  formatInstalls,
  installSpecFor,
  isValidSkillId,
  mergeRegistrySkills,
  normalizeRegistrySkill,
  skillSourceType,
  clearSkillsRegistryCache,
  getSkillDetail,
  searchSkills,
} = await jiti.import("./skills-registry.ts");

test("formatInstalls compacts counts the way the store displays them", () => {
  assert.equal(formatInstalls(0), "");
  assert.equal(formatInstalls(-5), "");
  assert.equal(formatInstalls(1), "1");
  assert.equal(formatInstalls(999), "999");
  assert.equal(formatInstalls(1500), "1.5K");
  assert.equal(formatInstalls(649061), "649.1K");
  assert.equal(formatInstalls(2_000_000), "2M");
});

test("skillSourceType splits GitHub repos from well-known domains", () => {
  assert.equal(skillSourceType("vercel-labs/skills"), "github");
  assert.equal(skillSourceType("open.feishu.cn"), "well-known");
});

test("installSpecFor produces what `npx skills add` accepts", () => {
  // GitHub skills address one skill: owner/repo@slug.
  assert.equal(installSpecFor("vercel-labs/skills", "find-skills"), "vercel-labs/skills@find-skills");
  // Well-known providers have no per-skill selector — only the provider URL.
  assert.equal(installSpecFor("open.feishu.cn", "lark-mail"), "https://open.feishu.cn");
});

test("isValidSkillId confines ids to safe upstream path segments", () => {
  assert.equal(isValidSkillId("vercel-labs/skills/find-skills"), true);
  assert.equal(isValidSkillId("open.feishu.cn/lark-mail"), true);
  assert.equal(isValidSkillId("a/b/c/d"), false);
  assert.equal(isValidSkillId("single"), false);
  assert.equal(isValidSkillId("../etc/passwd"), false);
  assert.equal(isValidSkillId("a/../b"), false);
  assert.equal(isValidSkillId("a//b"), false);
  assert.equal(isValidSkillId("a/b c/d"), false);
});

test("normalizeRegistrySkill maps the live /api/search shape", () => {
  const skill = normalizeRegistrySkill({
    id: "vercel-labs/agent-skills/vercel-react-best-practices",
    skillId: "vercel-react-best-practices",
    name: "vercel-react-best-practices",
    installs: 649061,
    source: "vercel-labs/agent-skills",
  });
  assert.ok(skill);
  assert.equal(skill.id, "vercel-labs/agent-skills/vercel-react-best-practices");
  assert.equal(skill.slug, "vercel-react-best-practices");
  assert.equal(skill.sourceType, "github");
  assert.equal(skill.package, "vercel-labs/agent-skills@vercel-react-best-practices");
  assert.equal(skill.installsLabel, "649.1K");
  assert.match(skill.url, /\/vercel-labs\/agent-skills\/vercel-react-best-practices$/);
});

test("normalizeRegistrySkill rejects junk and traversal attempts", () => {
  assert.equal(normalizeRegistrySkill(null), null);
  assert.equal(normalizeRegistrySkill("string"), null);
  assert.equal(normalizeRegistrySkill({ name: "x" }), null);
  assert.equal(normalizeRegistrySkill({ source: "a/..", skillId: "b", name: "b" }), null);
  // Missing installs is a zero, not a rejection.
  const skill = normalizeRegistrySkill({ source: "o/r", skillId: "s", name: "s" });
  assert.ok(skill);
  assert.equal(skill.installs, 0);
  assert.equal(skill.installsLabel, "");
});

test("mergeRegistrySkills dedupes by id, ranks by installs, tiebreaks by id", () => {
  const make = (id, installs) => {
    const [o, r, slug] = id.split("/");
    return normalizeRegistrySkill({ source: `${o}/${r}`, skillId: slug, name: slug, installs, id });
  };
  const merged = mergeRegistrySkills([
    [make("a/r/one", 10), make("b/r/two", 500)],
    [make("a/r/one", 25), make("c/r/three", 500)],
  ]);
  assert.deepEqual(merged.map((skill) => skill.id), ["b/r/two", "c/r/three", "a/r/one"]);
  assert.equal(merged.find((skill) => skill.id === "a/r/one").installs, 25);
});

test("searchSkills queries upstream once and serves repeats from cache", async (t) => {
  clearSkillsRegistryCache();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      searchType: "semantic",
      skills: [
        { id: "o/r/migrate", skillId: "migrate", name: "migrate", source: "o/r", installs: 42 },
        { id: "bad/../nope", skillId: "nope", name: "nope", source: "bad/..", installs: 1 },
      ],
    }), { headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    clearSkillsRegistryCache();
  });

  const first = await searchSkills("database migrations review", 50);
  assert.equal(first.searchType, "semantic");
  assert.deepEqual(first.items.map((skill) => skill.id), ["o/r/migrate"]);

  const second = await searchSkills("database migrations review", 50);
  assert.deepEqual(second.items, first.items);
  assert.equal(calls.length, 1, "second identical query must be served from cache");

  // Below the minimum query length nothing goes upstream.
  const short = await searchSkills("a", 50);
  assert.deepEqual(short.items, []);
  assert.equal(calls.length, 1);
});

test("getSkillDetail extracts frontmatter description and readme from SKILL.md", async (t) => {
  clearSkillsRegistryCache();
  const realFetch = globalThis.fetch;
  const skillMd = [
    "---",
    "name: Migration Reviewer",
    "description: Reviews database migrations for safety.",
    "---",
    "",
    "# Usage",
    "",
    "Run it before deploys.",
  ].join("\n");
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      files: [
        { path: "SKILL.md", contents: skillMd },
        { path: "examples/check.sql", contents: "select 1;" },
      ],
    }), { headers: { "content-type": "application/json" } });
  t.after(() => {
    globalThis.fetch = realFetch;
    clearSkillsRegistryCache();
  });

  const detail = await getSkillDetail("o/r/migration-reviewer");
  assert.ok(detail);
  assert.equal(detail.name, "Migration Reviewer");
  assert.equal(detail.description, "Reviews database migrations for safety.");
  assert.match(detail.readme, /^# Usage/);
  assert.equal(detail.readmeTruncated, false);
  assert.deepEqual(detail.files.map((file) => file.path), ["SKILL.md", "examples/check.sql"]);

  // Invalid ids never reach upstream.
  assert.equal(await getSkillDetail("../../etc"), null);

  // Well-known ids (two segments) have no download route: an empty, cached detail.
  const wellKnown = await getSkillDetail("open.feishu.cn/lark-mail");
  assert.ok(wellKnown);
  assert.equal(wellKnown.description, "");
  assert.deepEqual(wellKnown.files, []);
});
