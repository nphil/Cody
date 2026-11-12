import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const {
  NO_NEW_BADGES,
  computeNewHomes,
  countBadged,
  isBadgedRow,
  newCountLabel,
  subViewKey,
} = await jiti.import("./settings/new-badges.ts");
const { settingHome } = await jiti.import("./settings/search-index.ts");
const { ALL_CAPABILITIES } = await jiti.import("./SettingsTabs.tsx");

const row = (key, extra = {}) => ({ key, visible: true, ...extra });
const set = (...keys) => new Set(keys);

test("a row carries the badge only when its key is new, it is on screen and a browser can use it", () => {
  const isNew = (key) => key.startsWith("new.");
  assert.equal(isBadgedRow(row("new.a"), isNew), true);
  assert.equal(isBadgedRow(row("old.a"), isNew), false, "not a new key");
  assert.equal(isBadgedRow(row("new.a", { visible: false }), isNew), false, "a row whose condition does not hold has no control");
  assert.equal(isBadgedRow({ key: "new.a" }, isNew), true, "a row without a `visible` flag is shown");
  assert.equal(isBadgedRow(row("new.a", { terminalOnly: true }), isNew), false, "terminal-only settings never badge");
});

test("counts add up only the badged rows", () => {
  const rows = [row("new.a"), row("new.b", { terminalOnly: true }), row("new.c", { visible: false }), row("old.d"), row("new.e")];
  assert.equal(countBadged(rows, (key) => key.startsWith("new.")), 2);
  assert.equal(countBadged([], () => true), 0);
  assert.equal(newCountLabel(3), "3 new");
});

test("hubs and sub-views light up where a badged key's row or card renders", () => {
  const homeOf = (key) => settingHome(key, ALL_CAPABILITIES);
  const rows = [
    row("tools.fresh"),
    row("retry.enabled"),
    row("mcp.enableProjectConfig"),
    row("retry.maxRetries"),
    row("ui.terminalOnly", { terminalOnly: true }),
    row("hidden.fresh", { visible: false }),
    row("tools.old"),
  ];
  const homes = computeNewHomes(rows, set("tools.fresh", "retry.enabled", "mcp.enableProjectConfig", "retry.maxRetries", "ui.terminalOnly", "hidden.fresh"), homeOf);
  assert.deepEqual([...homes.hubs].sort(), ["engine", "extensions", "models"]);
  assert.deepEqual([...homes.subs].sort(), [subViewKey("extensions", "mcp"), subViewKey("models", "assignments")]);

  const onlyRetry = computeNewHomes(rows, set("retry.enabled"), homeOf);
  assert.deepEqual([...onlyRetry.hubs], ["models"], "a retry key lights Models, not Behavior");
  assert.deepEqual([...onlyRetry.subs], ["models/assignments"]);

  const onlyBehavior = computeNewHomes(rows, set("tools.fresh"), homeOf);
  assert.deepEqual([...onlyBehavior.hubs], ["engine"]);
  assert.equal(onlyBehavior.subs.size, 0, "Behavior has no sub-views to light");
});

test("terminal-only and hidden settings feed no dot", () => {
  const homeOf = (key) => settingHome(key, ALL_CAPABILITIES);
  const homes = computeNewHomes([row("a", { terminalOnly: true }), row("b", { visible: false })], set("a", "b"), homeOf);
  assert.equal(homes.hubs.size, 0);
  assert.equal(homes.subs.size, 0);
});

test("a surface the engine lacks keeps its keys' dot in Behavior, where their row is", () => {
  const homeOf = (key) => settingHome(key, { ...ALL_CAPABILITIES, models: false, mcp: false });
  const homes = computeNewHomes([row("retry.enabled"), row("mcp.enableProjectConfig")], set("retry.enabled", "mcp.enableProjectConfig"), homeOf);
  assert.deepEqual([...homes.hubs], ["engine"]);
  assert.equal(homes.subs.size, 0);
});

test("nothing new means no dots, and the default context shows nothing", () => {
  const homes = computeNewHomes([row("a")], set(), () => ({ tab: "engine" }));
  assert.equal(homes.hubs.size, 0);
  assert.equal(NO_NEW_BADGES.newKeys.size, 0);
  assert.equal(NO_NEW_BADGES.isNew("anything"), false);
  assert.equal(NO_NEW_BADGES.introducedIn("anything"), null);
  assert.equal(NO_NEW_BADGES.hubsWithNew.size, 0);
  assert.equal(NO_NEW_BADGES.subsWithNew.size, 0);
  assert.doesNotThrow(() => { NO_NEW_BADGES.reportSeen("a"); NO_NEW_BADGES.reportChanged("a"); });
});
