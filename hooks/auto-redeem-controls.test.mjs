import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildAutoRedeemGroups, normalizeAutoRedeemValue } = await jiti.import("./auto-redeem-controls.ts");

// The keys the 18.19.0 engine really declares (lib/harness/fixtures/omp-schema-keys.json); the installed
// 18.8.3 engine declares only the single `<group>.autoRedeem` per provider.
const NEW_ENGINE_KEYS = new Set(JSON.parse(readFileSync(new URL("../lib/harness/fixtures/omp-schema-keys.json", import.meta.url), "utf8")).keys);
const OLD_ENGINE_KEYS = new Set(["claudeResets.autoRedeem", "codexResets.autoRedeem"]);

/** A settings lookup that answers like the schema index: undefined for a key the engine does not have. */
const lookupOver = (keys, values = {}) => (key) => (keys.has(key) ? { value: values[key] } : undefined);
const both = ["anthropic", "openai-codex"];

test("the fixture really is the per-window engine and the old engine really has only the single key", () => {
  assert.equal(NEW_ENGINE_KEYS.has("claudeResets.autoRedeem"), false);
  assert.equal(NEW_ENGINE_KEYS.has("claudeResets.autoRedeemFable"), true);
  assert.equal(OLD_ENGINE_KEYS.has("claudeResets.autoRedeemFable"), false);
});

test("18.19.0: Codex gets 5-hour and weekly, Claude gets 5-hour, weekly and the separate Fable one", () => {
  const groups = buildAutoRedeemGroups(lookupOver(NEW_ENGINE_KEYS), both);
  assert.deepEqual(groups, [
    {
      provider: "anthropic",
      hasFable: true,
      controls: [
        { key: "claudeResets.autoRedeem5h", window: "5h", value: "unset" },
        { key: "claudeResets.autoRedeemWeekly", window: "weekly", value: "unset" },
        { key: "claudeResets.autoRedeemFable", window: "fable", value: "unset" },
      ],
    },
    {
      provider: "openai-codex",
      hasFable: false,
      controls: [
        { key: "codexResets.autoRedeem5h", window: "5h", value: "unset" },
        { key: "codexResets.autoRedeemWeekly", window: "weekly", value: "unset" },
      ],
    },
  ]);
});

test("18.8.3: one switch per provider, bound to the single legacy key, and no Fable switch", () => {
  const groups = buildAutoRedeemGroups(lookupOver(OLD_ENGINE_KEYS, { "claudeResets.autoRedeem": "yes" }), both);
  assert.deepEqual(groups, [
    { provider: "anthropic", hasFable: false, controls: [{ key: "claudeResets.autoRedeem", window: "all", value: "yes" }] },
    { provider: "openai-codex", hasFable: false, controls: [{ key: "codexResets.autoRedeem", window: "all", value: "unset" }] },
  ]);
});

test("a key the schema does not have is never offered", () => {
  const withoutFable = new Set([...NEW_ENGINE_KEYS].filter((key) => key !== "claudeResets.autoRedeemFable"));
  const claude = buildAutoRedeemGroups(lookupOver(withoutFable), ["anthropic"])[0];
  assert.deepEqual(claude.controls.map((control) => control.key), ["claudeResets.autoRedeem5h", "claudeResets.autoRedeemWeekly"]);
  assert.equal(claude.hasFable, false);
  const asked = [];
  buildAutoRedeemGroups((key) => { asked.push(key); return undefined; }, both);
  assert.equal(buildAutoRedeemGroups(() => undefined, both).length, 0);
  assert.ok(asked.every((key) => /^(claude|codex)Resets\.autoRedeem(5h|Weekly|Fable)?$/.test(key)));
});

test("the legacy key is ignored once the per-window keys exist", () => {
  const keys = new Set([...NEW_ENGINE_KEYS, "claudeResets.autoRedeem", "codexResets.autoRedeem"]);
  const groups = buildAutoRedeemGroups(lookupOver(keys, { "claudeResets.autoRedeem": "yes" }), both);
  assert.deepEqual(groups.map((group) => group.controls.map((control) => control.window)), [["5h", "weekly", "fable"], ["5h", "weekly"]]);
});

test("each switch shows the value the settings source reports, per window", () => {
  const values = {
    "claudeResets.autoRedeem5h": "yes",
    "claudeResets.autoRedeemWeekly": "no",
    "claudeResets.autoRedeemFable": "unset",
    "codexResets.autoRedeem5h": "no",
  };
  const [claude, codex] = buildAutoRedeemGroups(lookupOver(NEW_ENGINE_KEYS, values), both);
  assert.deepEqual(claude.controls.map((control) => control.value), ["yes", "no", "unset"]);
  assert.deepEqual(codex.controls.map((control) => control.value), ["no", "unset"]);
});

test("only the providers asked for get a group, and always in the same order", () => {
  const lookup = lookupOver(NEW_ENGINE_KEYS);
  assert.deepEqual(buildAutoRedeemGroups(lookup, ["openai-codex"]).map((group) => group.provider), ["openai-codex"]);
  assert.deepEqual(buildAutoRedeemGroups(lookup, ["openai-codex", "anthropic"]).map((group) => group.provider), ["anthropic", "openai-codex"]);
  assert.deepEqual(buildAutoRedeemGroups(lookup, ["cursor", "anthropic"]).map((group) => group.provider), ["anthropic"]);
  assert.deepEqual(buildAutoRedeemGroups(lookup, []), []);
});

test("stored values read the way omp reads them: yes, no, anything else asks first", () => {
  assert.equal(normalizeAutoRedeemValue("yes"), "yes");
  assert.equal(normalizeAutoRedeemValue(true), "yes");
  assert.equal(normalizeAutoRedeemValue("no"), "no");
  assert.equal(normalizeAutoRedeemValue(false), "no");
  assert.equal(normalizeAutoRedeemValue("unset"), "unset");
  for (const value of [undefined, null, "", "maybe", 1, 0, {}]) assert.equal(normalizeAutoRedeemValue(value), "unset");
});
