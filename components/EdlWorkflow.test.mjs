import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * The EDL cards of the Devices panel: what each says in every language, and when its buttons may be pressed. The cards are
 * rendered for real (their first state); the decisions that depend on what the user has typed are tested as the pure
 * function the Flash card calls.
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { adviseFlash, planBackup, EdlBackup, EdlBackupSets, EdlCommands, EdlFlash } = await jiti.import("./devices/EdlWorkflow.tsx");
const { deviceArtifacts } = await jiti.import("../lib/devices/artifacts.ts");
const { setLocale } = await jiti.import("../lib/i18n/index.tsx");
const { FILTER_FROM, ROW_CAP } = await jiti.import("./devices/list-view.ts");

const locales = Object.fromEntries(
  await Promise.all(["en", "ja", "zh-CN"].map(async (name) => [name, JSON.parse(await readFile(new URL(`../lib/i18n/locales/${name}.json`, import.meta.url), "utf8"))])),
);

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const BOOT = { name: "boot_a", bytes: 64 * 512 };
const PERSIST = { name: "persist", bytes: 40 * 512 };

test("the Flash card knows when an image may be written: the partition, its size, the pad and the protected and refused names", () => {
  const advise = (name, image, pad = "none", busy = false, partitions = [BOOT, PERSIST]) => adviseFlash(name, partitions, image, pad, busy);
  assert.deepEqual(advise("", 32768), { level: "none", fit: "unknown", canFlash: false });
  assert.deepEqual(advise("boot_a", 32768), { level: "ordinary", fit: "exact", canFlash: true });
  assert.deepEqual(advise("boot_a", 32769, "ff"), { level: "ordinary", fit: "tooBig", canFlash: false }, "too big for the partition, whatever the pad");
  assert.deepEqual(advise("boot_a", 100), { level: "ordinary", fit: "needsPad", canFlash: false }, "smaller needs a choice of what fills the rest");
  assert.equal(advise("boot_a", 100, "zero").canFlash, true);
  assert.equal(advise("boot_a", 100, "ff").canFlash, true);
  assert.deepEqual(advise("persist", 20480), { level: "protected", fit: "exact", canFlash: true }, "protected: allowed, the flasher only logs a note");
  assert.deepEqual(advise("boot0", 32768), { level: "refused", fit: "unknown", canFlash: false });
  assert.equal(advise("rpmb", 32768, "zero").canFlash, false);
  assert.equal(advise("boot_a", undefined).canFlash, false, "no image chosen");
  assert.equal(advise("boot_a", 32768, "none", true).canFlash, false, "another operation is running");
  assert.deepEqual(advise("userdata", 1000, "none", false, []), { level: "ordinary", fit: "unknown", canFlash: true }, "a name typed without a partition table: the flasher decides");
});

const manager = { startUser() { throw new Error("rendering never starts an operation"); } };
const noop = () => {};
const props = (extra = {}) => ({ manager, sessionId: "panel-session", deviceId: "device-1", operations: [], input: undefined, onChooseFile: noop, ...extra });
const image = (extra = {}) => ({ id: "file-1", name: "boot.img", size: 32768, mime: "application/octet-stream", sha256: "c".repeat(64), kind: "input", source: "picker", createdAt: 1, ...extra });
const snapshot = (command, details, action = "exec") => ({ id: `op-${command}`, state: "succeeded", request: { protocol: "edl", action, command }, result: { summary: "ok", details } });

test("every EDL card renders in English, Japanese and Chinese with real words: no key left bare, no placeholder left unfilled", () => {
  const printgpt = snapshot("printgpt", { partitions: [BOOT, PERSIST] });
  const backup = snapshot("backup", { manifest: { sha256: "ab12cd34".padEnd(64, "0") }, partitions: [{}, {}], restorable: true });
  // The language only follows a switch where there is a document; on the server it is always English.
  globalThis.document = { documentElement: {} };
  try {
    for (const locale of Object.keys(locales)) {
      setLocale(locale);
      const cards = {
        commands: renderToStaticMarkup(React.createElement(EdlCommands, props())),
        backup: renderToStaticMarkup(React.createElement(EdlBackup, props({ operations: [printgpt] }))),
        sets: renderToStaticMarkup(React.createElement(EdlBackupSets, props({ operations: [backup], input: image({ name: "loader.mbn" }) }))),
        chooser: renderToStaticMarkup(React.createElement(EdlBackupSets, props({ operations: [printgpt, backup], input: image({ name: "loader.mbn" }), defaultPicked: ["boot_a"] }))),
        flash: renderToStaticMarkup(React.createElement(EdlFlash, props({ operations: [printgpt], input: image() }))),
      };
      for (const [name, html] of Object.entries(cards)) {
        assert.doesNotMatch(html, /devices\.edl\.|devices\.[a-zA-Z]+\./, `${locale}/${name}: a translation key shows`);
        assert.doesNotMatch(html, /\{[a-zA-Z]+\}/, `${locale}/${name}: a placeholder was not filled`);
      }
      const say = (key, vars = {}) => escape(locales[locale][key].replace(/\{(\w+)\}/g, (_, variable) => String(vars[variable])));
      assert.ok(cards.flash.includes(say("devices.edl.flashIntro")), `${locale}: flash intro`);
      assert.ok(cards.flash.includes(say("devices.edl.imageChosen", { name: "boot.img", size: "32.0 KiB" })), `${locale}: the image and its size`);
      assert.ok(cards.flash.includes(say("devices.edl.flashStart")) && cards.flash.includes(say("devices.edl.eraseStart")), `${locale}: flash and erase buttons`);
      assert.ok(cards.flash.includes(say("devices.edl.padFf")), `${locale}: pad choice`);
      assert.ok(cards.sets.includes(say("devices.edl.restoreIntro")), `${locale}: restore intro`);
      assert.ok(cards.sets.includes(say("devices.edl.setLast", { id: "ab12cd34", count: 2 })), `${locale}: the last set`);
      assert.ok(cards.commands.includes(say("devices.edl.untested")), `${locale}: the honest note about what has been tried`);
      assert.ok(cards.sets.includes(say("devices.edl.setPartitionsNoTable")), `${locale}: no table read yet`);
      assert.ok(cards.chooser.includes(say("devices.edl.setPartitionsTitle")) && cards.chooser.includes(say("devices.edl.setPartitionsHint")), `${locale}: the partition list and what a partial backup means`);
      assert.ok(cards.chooser.includes(say("devices.files.selectedCount", { selected: 1, total: 2, size: "32.0 KiB" })), `${locale}: the count of the whole table`);
      assert.ok(cards.chooser.includes(say("devices.edl.setStartSome", { selected: 1, total: 2 })), `${locale}: the button for some partitions`);
      assert.ok(cards.chooser.includes(say("devices.files.selectAll")) && cards.chooser.includes(say("devices.files.selectNone")), `${locale}: All and None`);
    }
  } finally {
    setLocale("en");
    delete globalThis.document;
  }
});

const buttonOf = (html, label) => {
  const match = new RegExp(`<button[^>]*>(?:(?!</button>).)*${escape(label)}`, "s").exec(html);
  assert.ok(match, `no button called ${label}`);
  return /\sdisabled(=|\s|>)/.test(match[0].slice(0, match[0].indexOf(">") + 1));
};

test("the Flash card's buttons stay disabled until there is something to write and somewhere to write it", () => {
  const empty = renderToStaticMarkup(React.createElement(EdlFlash, props()));
  assert.equal(buttonOf(empty, "Flash this partition"), true);
  assert.equal(buttonOf(empty, "Erase this partition"), true);
  assert.match(empty, /No file chosen\. Choose the image in Files &amp; backups\./);
  assert.match(empty, /To choose from a list, read the partition tables first/);

  const withImage = renderToStaticMarkup(React.createElement(EdlFlash, props({ input: image(), operations: [snapshot("printgpt", { partitions: [BOOT] })] })));
  assert.equal(buttonOf(withImage, "Flash this partition"), true, "no partition named yet");
  assert.doesNotMatch(withImage, /To choose from a list/, "the table that was read is offered");
});

test("the restore card needs the loader and a backup set from this session, and offers the newest set", () => {
  const sessionId = "panel-restore-session";
  const entries = deviceArtifacts.entries(sessionId);
  const manifest = (id, createdAt, sha) => ({ id, name: `edl-1a2b3c4d-set-${sha.slice(0, 8)}.manifest.json`, size: 10, mime: "application/json", sha256: sha, kind: "output", source: "device", createdAt, blob: new Blob(["{}"]) });
  const none = renderToStaticMarkup(React.createElement(EdlBackupSets, props({ sessionId, input: image({ name: "loader.mbn" }) })));
  assert.match(none, /No backup set in this session/);
  assert.equal(buttonOf(none, "Restore this set"), true);

  entries.set("old", manifest("old", 1, "11".repeat(32)));
  entries.set("new", manifest("new", 2, "22".repeat(32)));
  const ready = renderToStaticMarkup(React.createElement(EdlBackupSets, props({ sessionId, input: image({ name: "loader.mbn" }) })));
  assert.equal(buttonOf(ready, "Restore this set"), false);
  assert.match(ready, /Set id 22222222\./, "the newest set is the default");
  assert.ok(ready.includes(`SHA-256 ${"22".repeat(32)}`));
  assert.equal(buttonOf(ready, "Back up everything"), false);

  const noLoader = renderToStaticMarkup(React.createElement(EdlBackupSets, props({ sessionId })));
  assert.equal(buttonOf(noLoader, "Restore this set"), true, "a restore always needs the loader");
  assert.match(noLoader, /A restore always starts from the boot ROM, so choose the loader in Files &amp; backups\./);

  const running = renderToStaticMarkup(React.createElement(EdlBackupSets, props({ sessionId, input: image(), operations: [{ id: "op", state: "running", request: { protocol: "edl", action: "exec", command: "connect" } }] })));
  assert.equal(buttonOf(running, "Restore this set"), true, "not while another operation runs");
  assert.equal(buttonOf(running, "Back up everything"), true);
  entries.clear();
});

test("a backup set that cannot be restored says why, in place of the success note", () => {
  const html = renderToStaticMarkup(React.createElement(EdlBackupSets, props({
    operations: [snapshot("backup", { manifest: { sha256: "ab12cd34".padEnd(64, "0") }, partitions: [{}], restorable: false, notRestorableBecause: ["The boot ROM's public-key hash was not read.", "Another reason."] })],
  })));
  assert.match(html, /That set cannot be restored by Cody: The boot ROM&#x27;s public-key hash was not read\. Another reason\./);
  assert.doesNotMatch(html, /Last backup set:/);
});

test("what the backup asks for: everything sends no partition list, only a subset names its partitions, in the order the table lists them", () => {
  const table = ["gpt-a", "boot_a", "system_a", "userdata"];
  const everything = { action: "exec", command: "backup" };
  assert.deepEqual(planBackup(table, null).request, everything, "untouched: every partition");
  assert.deepEqual(planBackup(table, new Set(table)).request, everything, "everything ticked by hand is the same request");
  assert.equal("options" in planBackup(table, new Set(table)).request, false, "no options at all, as the card has always asked");
  const some = planBackup(table, new Set(["userdata", "boot_a"]));
  assert.deepEqual(some.request, { action: "exec", command: "backup", options: { partitions: ["boot_a", "userdata"] } }, "table order, not tick order");
  assert.deepEqual([some.kind, some.chosen, some.total], ["some", ["boot_a", "userdata"], 4]);
  const none = planBackup(table, new Set());
  assert.deepEqual([none.kind, none.request], ["none", undefined], "nothing chosen starts nothing");
  assert.equal(planBackup(table, new Set(["not-in-the-table"])).kind, "none", "a tick for a partition the table no longer lists does not count");
  assert.deepEqual([planBackup([], null).kind, planBackup([], null).request], ["all", everything], "no table read yet: a full backup");
});

const gpt = (count) => snapshot("printgpt", { partitions: Array.from({ length: count }, (_, index) => ({ index: index + 1, name: `part${index}`, bytes: (index + 1) * 1024 * 1024 })) });
const setCard = (extra = {}) => renderToStaticMarkup(React.createElement(EdlBackupSets, props({ input: image({ name: "loader.mbn" }), ...extra })));
const boxesOf = (markup) => [...markup.matchAll(/<button[^>]*role="checkbox"[^>]*>/g)].map((match) => /aria-checked="true"/.test(match[0]));

test("the backup card says to read the partition tables first, and until then still starts a full backup", () => {
  const markup = setCard();
  assert.match(markup, /Read the partition tables first \(Commands tab\) to choose partitions\./);
  assert.deepEqual(boxesOf(markup), []);
  assert.equal(buttonOf(markup, "Back up everything"), false);
});

test("once the tables are read, every partition is a checkbox with its size, all ticked, and the button is the one it always was", () => {
  const markup = setCard({ operations: [gpt(3)] });
  assert.deepEqual(boxesOf(markup), [true, true, true]);
  assert.match(markup, /part0<\/span><span class="dv-file__size">1\.0 MiB</);
  assert.match(markup, /dv-pickbar__count" role="status">3 of 3 selected · 6\.0 MiB</);
  assert.match(markup, />All<\/span>/);
  assert.match(markup, />None<\/span>/);
  assert.match(markup, /A backup of chosen partitions is still one set and one zip\. It is labelled partial and cannot be restored as a set: partitions are flashed back one at a time\./);
  assert.equal(buttonOf(markup, "Back up everything"), false);
  assert.doesNotMatch(markup, /Back up \d+ of \d+ partitions/);
  assert.doesNotMatch(markup, /Find a partition/, "a short table needs no filter box");
  assert.equal(buttonOf(setCard({ operations: [gpt(3), { id: "op", state: "running", request: { protocol: "edl", action: "exec", command: "connect" } }] }), "Back up everything"), true, "not while another operation runs");
});

test("choosing some partitions names how many on the button; choosing none leaves it disabled", () => {
  const some = setCard({ operations: [gpt(3)], defaultPicked: ["part2", "part0"] });
  assert.deepEqual(boxesOf(some), [true, false, true]);
  assert.match(some, /2 of 3 selected · 4\.0 MiB</);
  assert.equal(buttonOf(some, "Back up 2 of 3 partitions"), false);
  assert.doesNotMatch(some, />Back up everything<\/span>/);
  const none = setCard({ operations: [gpt(3)], defaultPicked: [] });
  assert.deepEqual(boxesOf(none), [false, false, false]);
  assert.match(none, /0 of 3 selected · 0 B</);
  assert.equal(buttonOf(none, "Back up 0 of 3 partitions"), true);
  assert.doesNotMatch(none, />Back up everything<\/span>/, "that button is for everything only");
});

test("a long partition table stays usable: a filter box, a first page and Show all, while All, None and the count are about every partition", () => {
  const many = FILTER_FROM + ROW_CAP + 34;
  const markup = setCard({ operations: [gpt(many)] });
  assert.equal(boxesOf(markup).length, ROW_CAP);
  assert.match(markup, new RegExp(`Show all ${many}`));
  assert.match(markup, /<label[^>]*>Find a partition<\/label>/);
  assert.match(markup, new RegExp(`${many} of ${many} selected`), "the count is of the whole table, not the rows on screen");
  const one = setCard({ operations: [gpt(many)], defaultPicked: ["part55"] });
  assert.match(one, new RegExp(`1 of ${many} selected`), "a partition off the first page is still ticked");
  assert.match(one, new RegExp(`Back up 1 of ${many} partitions`));
});

test("a partition with no name is listed and chosen as partition N, the way the backup's own record names it", () => {
  const markup = setCard({ operations: [snapshot("printgpt", { partitions: [{ index: 7, name: "", bytes: 512 }, { index: 8, name: "boot_a", bytes: 1024 }] })], defaultPicked: ["partition 7"] });
  assert.match(markup, /partition 7<\/span>/);
  assert.deepEqual(boxesOf(markup), [true, false]);
  assert.match(markup, /Back up 1 of 2 partitions/);
});
