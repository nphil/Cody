import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * What the top bar decides before it draws anything: which machine deserves
 * the single indicator a phone has room for, how much of each machine fits in
 * the room the bar has left, and that every state a machine can be in has
 * words in every language (a missing key would ship silently as English, or as
 * the raw key itself).
 */
const jiti = createJiti(import.meta.url);
const present = await jiti.import("./present.ts");
const types = await jiti.import("./types.ts");
const store = await jiti.import("./store.ts");

const locales = Object.fromEntries(
  ["en", "ja", "zh-CN"].map((name) => [name, JSON.parse(readFileSync(join(import.meta.dirname, "../i18n/locales", `${name}.json`), "utf8"))]),
);

function machine(name, status, cpu = null, mem = null, extra = {}) {
  return {
    id: name.toLowerCase().replace(/\W+/g, "-"),
    name,
    kind: "ssh",
    status,
    reason: status === "online" ? null : "starting",
    metrics: mem === null ? null : { cpuPercent: cpu, cores: 4, load1: 1, memTotalBytes: 100, memUsedBytes: mem, memPercent: mem, at: 0 },
    ...extra,
  };
}

test("every status, every reason and every API error has real words in all three languages", () => {
  const keys = [
    ...types.MACHINE_STATUSES.map((status) => present.machineStatusKey(status)),
    ...types.MACHINE_REASONS.map((reason) => present.machineReasonKey(reason)),
    ...[
      ...Object.keys(store.MACHINE_FIELD_MESSAGES),
      "machine_duplicate_name",
      "machine_duplicate_destination",
      "too_many_machines",
      "machine_test_busy",
    ].map((code) => `errors.${code}`),
  ];
  for (const [name, dictionary] of Object.entries(locales)) {
    for (const key of keys) {
      assert.equal(typeof dictionary[key], "string", `${name} is missing ${key}`);
      assert.ok(dictionary[key].trim().length > 0, `${name} has an empty ${key}`);
    }
  }
  // A translation that is the English sentence copied across is not one.
  for (const key of keys.filter((key) => key.startsWith("machines.reason."))) {
    assert.notEqual(locales.ja[key], locales.en[key], `ja ${key} is still English`);
    assert.notEqual(locales["zh-CN"][key], locales.en[key], `zh-CN ${key} is still English`);
  }
});

test("this server's stored default name is shown in the reader's language; a chosen name is shown as typed", () => {
  const translate = (language) => (key) => locales[language][key];
  const local = { kind: "local", name: types.DEFAULT_LOCAL_MACHINE_NAME };
  assert.equal(present.machineDisplayName(local, translate("en")), "This server");
  assert.equal(present.machineDisplayName(local, translate("ja")), locales.ja["machines.defaultName"]);
  assert.notEqual(locales.ja["machines.defaultName"], "This server");
  assert.notEqual(locales["zh-CN"]["machines.defaultName"], "This server");
  // The person's own name wins, in every language.
  assert.equal(present.machineDisplayName({ kind: "local", name: "Beast" }, translate("ja")), "Beast");
  // An ssh machine named like the default is still just a name.
  assert.equal(present.machineDisplayName({ kind: "ssh", name: types.DEFAULT_LOCAL_MACHINE_NAME }, translate("ja")), "This server");
});

test("how worried to be about a machine follows the shared usage thresholds on its busier meter", () => {
  assert.equal(present.machineSeverity(machine("A", "online", 10, 20)), "normal");
  assert.equal(present.machineSeverity(machine("A", "online", 69.9, 5)), "normal");
  assert.equal(present.machineSeverity(machine("A", "online", 70, 5)), "warning");
  assert.equal(present.machineSeverity(machine("A", "online", 5, 89.9)), "warning");
  assert.equal(present.machineSeverity(machine("A", "online", 5, 90)), "error", "exactly 90 is an error here, as in the composer");
  assert.equal(present.machineSeverity(machine("A", "online", null, 40)), "normal", "no CPU figure yet: judged on memory alone");
  assert.equal(present.machineSeverity(machine("A", "offline")), "down");
  assert.equal(present.machineSeverity(machine("A", "connecting")), "pending");
  assert.equal(present.machineSeverity(machine("A", "unavailable")), "pending");
});

test("the one indicator a phone has room for goes to a machine that is down, then one that is struggling, then the busiest", () => {
  const fine = machine("Fine", "online", 10, 20);
  const busy = machine("Busy", "online", 60, 30);
  const hot = machine("Hot", "online", 95, 10);
  const down = machine("Down", "offline");
  const waiting = machine("Waiting", "connecting");
  assert.equal(present.worstMachine([fine, hot, down, busy]).name, "Down");
  assert.equal(present.worstMachine([fine, busy, hot]).name, "Hot");
  assert.equal(present.worstMachine([fine, busy]).name, "Busy", "ties in severity go to the busier meter");
  assert.equal(present.worstMachine([waiting, fine]).name, "Fine", "a machine nobody has heard from yet is the least interesting");
  assert.equal(present.worstMachine([fine, machine("Same", "online", 10, 20)]).name, "Fine", "still a tie: the earlier one");
  assert.equal(present.worstMachine([]), null);
});

const L = present.METER_LAYOUT;
const two = [machine("This server", "online", 10, 20), machine("Proxmox", "online", 10, 20)];

function need(density, machines) {
  const layout = density === "mini" && machines.length === 1 ? L.miniSingle : L[density];
  const names = machines.reduce((sum, m) => sum + Math.min(layout.nameMax, [...m.name].length * L.nameChar), 0);
  return layout.fixed * machines.length + names + layout.gap * (machines.length - 1) + layout.pad;
}

test("the richest density that fits wins, at the exact pixel", () => {
  for (const density of ["full", "compact", "mini"]) {
    const needed = Math.ceil(need(density, two));
    assert.equal(present.pickMeterDensity(two, needed, false), density, `${density} at ${needed}px`);
  }
  const mini = Math.ceil(need("mini", two));
  const compact = Math.ceil(need("compact", two));
  const full = Math.ceil(need("full", two));
  assert.equal(present.pickMeterDensity(two, full - 1, false), "compact");
  assert.equal(present.pickMeterDensity(two, compact - 1, false), "mini");
  assert.equal(present.pickMeterDensity(two, mini - 1, false), "dot");
  assert.equal(present.pickMeterDensity(two, L.dot, false), "dot");
  assert.equal(present.pickMeterDensity(two, L.dot - 1, false), "none");
});

test("two machines fit at 1280px with the right panel open: the 89px the bar really has left", () => {
  // 1280px wide, sidebar and workspace panel both open: a 477px top bar, 106px
  // between the controls and the session figures, 17px of it a divider.
  const density = present.pickMeterDensity(two, 106 - 17, false);
  assert.equal(density, "mini");
  assert.ok(need("mini", two) <= 89);
});

test("a phone never gets more than the one indicator, and only if it fits", () => {
  assert.equal(present.pickMeterDensity(two, 2000, true), "dot");
  assert.equal(present.pickMeterDensity(two, L.dot, true), "dot");
  assert.equal(present.pickMeterDensity(two, L.dot - 1, true), "none");
});

test("a single machine drops the initial: just its pair of bars", () => {
  const one = [machine("This server", "online", 10, 20)];
  assert.ok(need("mini", one) < need("mini", [one[0], one[0]]) / 2 + 1);
  assert.equal(present.pickMeterDensity(one, Math.ceil(need("mini", one)), false), "mini");
  assert.equal(present.pickMeterDensity([], 500, false), "none");
});

test("a Japanese or Chinese name takes a full em a character, so it asks for room sooner", () => {
  const latin = [machine("abcdef", "online", 1, 1)];
  const wide = [machine("あいうえおか", "online", 1, 1)];
  const room = Math.ceil(need("full", latin));
  assert.equal(present.pickMeterDensity(latin, room, false), "full");
  assert.notEqual(present.pickMeterDensity(wide, room, false), "full");
});

test("small figures read the way the bar needs them", () => {
  assert.equal(present.wholePercent(33.6), 34);
  assert.equal(present.wholePercent(-4), 0);
  assert.equal(present.wholePercent(140), 100);
  assert.equal(present.wholePercent(Number.NaN), 0);
  assert.equal(present.formatGigabytes(65667444 * 1024), "62.6");
  assert.equal(present.formatGigabytes(0), "0.0");
  assert.equal(present.formatGigabytes(-1), "0.0");
  assert.equal(present.machineInitial("  proxmox"), "P");
  assert.equal(present.machineInitial("ünraid"), "Ü");
  assert.equal(present.machineInitial("   "), "?");
});
