import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * The three locales must move in lockstep (CLAUDE.md: en + ja + zh-CN, all
 * three, real translations). translate() falls back key → en → key, so a
 * missing translation ships silently as English; this test turns that drift
 * into a failure at commit time instead.
 */

const dir = path.join(import.meta.dirname, "locales");
const locales = ["en", "ja", "zh-CN"].map((name) => ({
  name,
  data: JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8")),
}));
const [en, ...others] = locales;

function placeholders(text) {
  return new Set([...String(text).matchAll(/\{[a-zA-Z0-9_]+\}/g)].map((match) => match[0]));
}

test("every locale declares exactly the same keys", () => {
  const enKeys = Object.keys(en.data).sort();
  for (const { name, data } of others) {
    assert.deepEqual(Object.keys(data).sort(), enKeys, `${name}.json key set differs from en.json`);
  }
});

test("translations use only the placeholders their key declares", () => {
  for (const key of Object.keys(en.data)) {
    // A plural form may legitimately differ on {count} — English drops it in
    // ".one" ("1 command") where CJK keeps the numeral — so plural keys are
    // checked against the union of their own .one/.other placeholders.
    const plural = key.match(/^(.*)\.(one|other)$/);
    const allowed = plural
      ? new Set([
          ...placeholders(en.data[`${plural[1]}.one`] ?? ""),
          ...placeholders(en.data[`${plural[1]}.other`] ?? ""),
        ])
      : placeholders(en.data[key]);
    for (const { name, data } of others) {
      if (!(key in data)) continue; // key-set parity already failed above
      const used = placeholders(data[key]);
      for (const placeholder of used) {
        assert.ok(allowed.has(placeholder), `${name}.json "${key}" uses ${placeholder}, which en.json does not declare`);
      }
      if (!plural) {
        for (const placeholder of allowed) {
          assert.ok(used.has(placeholder), `${name}.json "${key}" is missing ${placeholder}`);
        }
      }
    }
  }
});
