import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The Providers hub files every id of the engine's roster under exactly one
 * group. The roster is omp's own `/login` list (70 entries at 18.1.10,
 * checked in as lib/harness/fixtures/omp-login-providers.json); an entry
 * upstream adds lands under "Other" rather than vanishing, and this test is
 * what turns that into a named failure so the tables get the new id.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const groups = await jiti.import("./settings/providers/provider-groups.ts");
const fixture = JSON.parse(readFileSync(new URL("../lib/harness/fixtures/omp-login-providers.json", import.meta.url), "utf8"));
const ids = fixture.providers.map((provider) => provider.id);

test("the checked-in omp roster is the 70-entry list the tables were written against", () => {
  assert.equal(ids.length, 70);
  assert.equal(new Set(ids).size, 70, "roster ids are unique");
});

test("every roster id lands in exactly one named group, none under Other", () => {
  const unplaced = [];
  for (const id of ids) {
    const group = groups.groupForProviderId(id);
    assert.ok(groups.GROUP_ORDER.includes(group), `${id}: ${group} is not a group`);
    if (group === "other") unplaced.push(id);
  }
  assert.deepEqual(unplaced, [], "roster ids without a group (add them to provider-groups.ts)");
});

test("the classification tables are disjoint except for the gateway-over-key rule", () => {
  const tables = {
    subscription: groups.SUBSCRIPTION_IDS,
    key: groups.KEY_IDS,
    gateway: groups.GATEWAY_IDS,
    local: groups.LOCAL_IDS,
    search: groups.SEARCH_TOOL_IDS,
  };
  const names = Object.keys(tables);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const overlap = [...tables[names[i]]].filter((id) => tables[names[j]].has(id));
      // OpenRouter takes a key AND is a router; the router wins the group.
      const allowed = new Set(names[i] === "key" && names[j] === "gateway" ? ["openrouter"] : []);
      assert.deepEqual(overlap.filter((id) => !allowed.has(id)), [], `${names[i]} ∩ ${names[j]}`);
    }
  }
  assert.equal(groups.groupForProviderId("openrouter"), "gateway");
});

test("a sample of ids reads the way a user would file them", () => {
  assert.equal(groups.groupForProviderId("anthropic"), "subscription");
  assert.equal(groups.groupForProviderId("github-copilot"), "subscription");
  assert.equal(groups.groupForProviderId("deepseek"), "key");
  assert.equal(groups.groupForProviderId("vercel-ai-gateway"), "gateway");
  assert.equal(groups.groupForProviderId("ollama"), "local");
  assert.equal(groups.groupForProviderId("tavily"), "search");
  assert.equal(groups.groupForProviderId("never-heard-of-it"), "other");
});

test("a joined row is a subscription when any of its sign-ins is one, and a custom endpoint always custom", () => {
  // Anthropic: Claude Pro/Max sign-in plus ANTHROPIC_API_KEY → Subscriptions.
  assert.equal(groups.groupForRow({ id: "anthropic", loginIds: ["anthropic"] }), "subscription");
  // Bedrock: key only → API key.
  assert.equal(groups.groupForRow({ id: "bedrock", loginIds: [] }), "key");
  // OpenRouter: the router rule wins even though its sign-in is a key entry.
  assert.equal(groups.groupForRow({ id: "openrouter", loginIds: ["openrouter"] }), "gateway");
  assert.equal(groups.groupForRow({ id: "mock", custom: true }), "custom");
  // An unknown row id falls through to its first placed login id.
  assert.equal(groups.groupForRow({ id: "unknown-row", loginIds: ["exa"] }), "search");
});

test("variants point at a card that is also a roster id, and popular ids are known", () => {
  for (const [variant, canonical] of Object.entries(groups.PROVIDER_VARIANTS)) {
    assert.notEqual(variant, canonical);
    assert.ok(ids.includes(variant) || ["openai-codex-device", "xai-oauth", "zai-coding-plan", "google-antigravity", "minimax-code-cn"].includes(variant), `${variant} is not in the roster`);
    assert.ok(ids.includes(canonical), `${canonical} (card for ${variant}) is not in the roster`);
  }
  assert.ok(groups.POPULAR_ORDER.length > 0);
  assert.equal(groups.popularityRank("anthropic"), 0);
  assert.equal(groups.popularityRank("unknown"), groups.POPULAR_ORDER.length);
});
