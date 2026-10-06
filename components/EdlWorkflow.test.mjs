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
const { adviseFlash, EdlBackup, EdlBackupSets, EdlCommands, EdlFlash } = await jiti.import("./devices/EdlWorkflow.tsx");
const { deviceArtifacts } = await jiti.import("../lib/devices/artifacts.ts");
const { setLocale } = await jiti.import("../lib/i18n/index.tsx");

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
