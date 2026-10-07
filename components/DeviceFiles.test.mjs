process.env.TZ = "UTC";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * Files & backups, rendered for real. What a device made is listed as SETS: one card per run, with the three things to do
 * with all of it; a backup of 58 partitions is one collapsed card, and opened it is a dense list with a filter, a first page,
 * partition names for labels and a menu per file. What the person added is a short group of its own.
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ArtifactPanel } = await jiti.import("./devices/ArtifactPanel.tsx");
const { FileRow, orderFiles, fileMenuItems } = await jiti.import("./devices/ArtifactSetCard.tsx");
const { menuStep } = await jiti.import("./devices/RowMenu.tsx");
const { FILTER_FROM, ROW_CAP, narrow } = await jiti.import("./devices/list-view.ts");
const { fileLabel, latestTransfer, setKind, transferText, verifiedText } = await jiti.import("./devices/set-text.ts");
const { groupArtifactSets } = await jiti.import("../lib/devices/artifact-sets.ts");
const { setLocale } = await jiti.import("../lib/i18n/index.tsx");

const locales = Object.fromEntries(
  await Promise.all(["en", "ja", "zh-CN"].map(async (name) => [name, JSON.parse(await readFile(new URL(`../lib/i18n/locales/${name}.json`, import.meta.url), "utf8"))])),
);
const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const html = (element) => renderToStaticMarkup(element);

const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 9, 6, 18, 31, 0);
const sha = (index) => index.toString(16).padStart(2, "0").repeat(32);

function output(index, over = {}) {
  return {
    id: `file-${index}`,
    name: `edl-3989044886-part${index}.bin`,
    size: 2 * MB,
    mime: "application/octet-stream",
    sha256: sha(index),
    kind: "output",
    source: "device",
    createdAt: NOW + index * 1_000,
    provenance: { operationId: `op-${index}`, deviceId: "usb-1", protocol: "edl", action: "dump", target: `part${index}`, label: "Lenovo QUSB__BULK" },
    ...over,
  };
}
const input = (name, over = {}) => ({ id: `in-${name}`, name, size: 1_258_291, mime: "application/octet-stream", sha256: "ee".repeat(32), kind: "input", source: "picker", createdAt: NOW - 5_000, ...over });
const library = (artifacts, transfers = []) => ({ artifacts, sets: groupArtifactSets(artifacts), inputs: artifacts.filter((artifact) => artifact.kind === "input"), transfers, error: null });
const backup = Array.from({ length: 58 }, (_, index) => output(index));

const noop = () => {};
function panel(artifacts, over = {}) {
  const state = over.library ?? library(artifacts, over.transfers ?? []);
  return html(React.createElement(ArtifactPanel, {
    sessionId: "session-files",
    library: state,
    selectedInputId: over.selectedInputId ?? null,
    onSelectInput: noop,
    deviceLabel: () => "Lenovo QUSB__BULK",
    verifiedBy: over.verifiedBy ?? (() => undefined),
    busySetIds: over.busy ?? new Set(),
    onDetails: noop,
    reveal: over.reveal,
    acknowledged: over.acknowledged ?? new Set(),
    acknowledge: noop,
  }));
}
const hex64 = /[0-9a-f]{64}/;

test("a backup of 58 partitions is ONE collapsed card: its name, when, how many, how big, and the actions for all of it", () => {
  const markup = panel(backup, { verifiedBy: () => true });
  assert.equal((markup.match(/<article class="dv-set"/g) ?? []).length, 1);
  assert.match(markup, /dv-set__title">Lenovo QUSB__BULK · Backups</);
  assert.match(markup, /dv-set__meta">Oct 6, 06:31 PM · 58 files · 116 MB</);
  assert.match(markup, /All 58 verified/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, />Download all<\/span>/);
  assert.match(markup, />Save to server<\/span>/);
  assert.doesNotMatch(markup, /class="dv-file"/, "no file is listed until the card is opened");
  const text = markup.replace(/<[^>]*>/g, " ");
  assert.doesNotMatch(text, hex64, "no hash on a collapsed card");
  assert.doesNotMatch(text, /edl-3989044886-/, "no raw file name either");
  assert.doesNotMatch(text, /file-\d+/, "and no id");
});

test("opened, it is a dense list: partition names, sizes, a filter and sort for a long set, a first page and the rest on request", () => {
  const set = groupArtifactSets(backup)[0];
  const markup = panel(backup, { reveal: { setId: set.id, token: 1 }, verifiedBy: (id) => id !== "op-3" });
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /<label[^>]*>Find a file<\/label>/);
  assert.match(markup, /role="radiogroup"[^>]*aria-label="Sort files"/);
  for (const sort of ["As saved", "Name", "Size"]) assert.match(markup, new RegExp(`role="radio"[^>]*>(?:(?!</button>).)*${sort}`, "s"));
  assert.equal((markup.match(/<li class="dv-file"/g) ?? []).length, ROW_CAP, "a first page");
  assert.match(markup, /Show all 58/);
  assert.match(markup, /dv-file__name" title="edl-3989044886-part0\.bin">part0</, "the partition is the label; the file name is a tooltip");
  assert.match(markup, /dv-file__size">2\.0 MB</);
  assert.match(markup, /57 of 58 verified/);
  assert.doesNotMatch(markup, hex64, "still no hash in the list");
});

test("a short set has no filter and no first-page cut", () => {
  const few = Array.from({ length: FILTER_FROM }, (_, index) => output(index));
  const set = groupArtifactSets(few)[0];
  const markup = panel(few, { reveal: { setId: set.id, token: 1 } });
  assert.equal((markup.match(/<li class="dv-file"/g) ?? []).length, FILTER_FROM);
  assert.doesNotMatch(markup, /Find a file|Sort files|Show all/);
});

test("every file has a menu with every action the big card had, and the row itself holds none of them", () => {
  const set = groupArtifactSets(backup)[0];
  const markup = panel(backup, { reveal: { setId: set.id, token: 1 } });
  const first = markup.slice(markup.indexOf('<li class="dv-file"'), markup.indexOf("</li>", markup.indexOf('<li class="dv-file"')));
  assert.match(first, /aria-label="Actions for part0"[^>]*aria-haspopup="menu"|aria-haspopup="menu"[^>]*aria-label="Actions for part0"/);
  assert.match(first, /role="menu"[^>]*popover="auto"/);
  const labels = [...first.matchAll(/role="menuitem"[^>]*>(?:<span[^>]*>.*?<\/span>)?<span>([^<]+)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ["Download", "Copy SHA-256", "Copy id", "Use as input", "Details", "Remove"]);
  assert.match(first, /style="color:var\(--status-error\)"[^>]*>(?:(?!<\/button>).)*Remove/s, "Remove is marked as the dangerous one");
  assert.equal((first.match(/<button/g) ?? []).length, 1 + 6, "the ⋯ button and its six items; the row has no button of its own");
});

test("what the person added is its own short group, with Use and the same menu minus Use as input", () => {
  const markup = panel([...backup, input("prog_emmc_firehose_8953_ddr.mbn"), input("boot.img", { size: 4096 })], { selectedInputId: "in-boot.img" });
  const group = markup.slice(markup.indexOf('aria-label="Your files"'));
  assert.match(group, /Your files · 2/);
  assert.match(group, /prog_emmc_firehose_8953_ddr\.mbn/);
  assert.match(group, />Use input<\/span>/);
  assert.match(group, />Selected<\/span>/);
  assert.match(group, /id="device-files-choose"/, "the button the other tabs send the person to");
  assert.doesNotMatch(group.slice(group.indexOf("<ul")), /Use as input/, "the row's Use is the way to select an input");
  assert.equal((markup.match(/<article class="dv-set"/g) ?? []).length, 1, "inputs are not a set");
});

test("a set the server holds says so and where, with its check; a half-saved one says how many", () => {
  const saved = backup.map((file) => ({ ...file, server: { saveId: "s1", path: `/srv/b/${file.name}`, folder: "/srv/b", savedAt: NOW + 5_000, verified: true } }));
  const markup = panel(saved);
  assert.match(markup, /Saved to the server/);
  assert.match(markup, /<code title="\/srv\/b">\/srv\/b<\/code>/);
  assert.match(markup, /checked on the server/);
  const half = backup.map((file, index) => (index < 20 ? { ...file, server: { saveId: "s1", path: "/srv/b/x", folder: "/srv/b", savedAt: NOW, verified: true } } : file));
  assert.match(panel(half), /20 of 58 on the server/);
});

test("while a transfer runs the card shows its line, its bar and a Cancel; the actions wait", () => {
  const set = groupArtifactSets(backup)[0];
  const transfer = { id: "t1", kind: "save", setId: set.id, artifactIds: set.artifactIds, label: "x", state: "running", progress: { phase: "uploading", done: 12, total: 58, bytes: 41, totalBytes: 100 }, startedAt: NOW, origin: "agent" };
  const markup = panel(backup, { transfers: [transfer] });
  assert.match(markup, /role="status"[^>]*>(?:(?!<\/div>).)*Saving to the server… 12 of 58 files · 41%/s);
  assert.match(markup, /role="progressbar"[^>]*aria-valuenow="41"/);
  assert.match(markup, />Cancel<\/span>/);
  assert.doesNotMatch(markup, />Download all<\/span>/, "no second transfer on top of the first");
  assert.equal(latestTransfer([transfer], set)?.id, "t1");
  assert.equal(latestTransfer([{ ...transfer, setId: undefined, artifactIds: ["unrelated"] }], set), undefined);
});

test("a transfer that failed stays on the card until it is acknowledged, in the engine's own words", () => {
  const set = groupArtifactSets(backup)[0];
  const failed = { id: "t2", kind: "save", setId: set.id, artifactIds: set.artifactIds, label: "x", state: "failed", progress: { phase: "uploading", done: 1, total: 58, bytes: 1, totalBytes: 100 }, startedAt: NOW, endedAt: NOW + 1, origin: "user", error: { code: "disk-full", message: "The server has only 1.2 GB free; this backup needs 3.5 GB." } };
  const open = panel(backup, { transfers: [failed] });
  assert.match(open, /role="alert"[^>]*>(?:(?!<\/div>).)*The server has only 1\.2 GB free; this backup needs 3\.5 GB\./s);
  assert.match(open, />Got it<\/span>/);
  assert.doesNotMatch(panel(backup, { transfers: [failed], acknowledged: new Set(["t2"]) }), /role="alert"/);
});

const { runningTransfer } = await jiti.import("./devices/set-text.ts");
const saveJob = (set, over) => ({ id: "j", kind: "save", setId: set.id, artifactIds: set.artifactIds, label: "x", state: "running", progress: { phase: "uploading", done: 12, total: 58, bytes: 41, totalBytes: 100 }, startedAt: NOW, origin: "user", ...over });

test("a transfer that was cancelled says so on the card, and what is kept, until it is acknowledged", () => {
  const set = groupArtifactSets(backup)[0];
  const save = panel(backup, { transfers: [saveJob(set, { id: "c-save", state: "cancelled", endedAt: NOW + 1 })] });
  assert.match(save, /role="status"[^>]*>(?:(?!<\/div>).)*Saving to the server was cancelled\. What already arrived is kept; Save to server carries on from there\./s);
  assert.match(save, />Got it<\/span>/);
  assert.match(save, />Download all<\/span>/, "a cancelled transfer no longer holds the card");
  assert.match(panel(backup, { transfers: [saveJob(set, { id: "c-zip", kind: "download", state: "cancelled", endedAt: NOW + 1 })] }), /The download was cancelled\. No file was written\./);
  assert.doesNotMatch(panel(backup, { transfers: [saveJob(set, { id: "c-save", state: "cancelled" })], acknowledged: new Set(["c-save"]) }), /was cancelled/);
});

test("while a transfer of the set runs, taking one file out of it is as locked as taking the set out", () => {
  const t = (key) => locales.en[key] ?? key;
  const actions = { sessionId: "s", selectedInputId: null, onSelectInput: noop, onDetails: noop, onRemove: noop, flash: noop };
  const items = (locked) => fileMenuItems(backup[1], actions, t, { input: false, locked });
  assert.equal(items(true).find((item) => item.id === "remove").disabled, true);
  assert.notEqual(items(false).find((item) => item.id === "remove").disabled, true);
  assert.notEqual(items(undefined).find((item) => item.id === "remove").disabled, true);
  assert.ok(items(true).filter((item) => item.id !== "remove").every((item) => item.disabled !== true), "downloading, copying and details stay available");
});

test("a confirmation that was already open when a transfer began cannot be used to take the file away", () => {
  const actions = { sessionId: "s", selectedInputId: null, onSelectInput: noop, onDetails: noop, onRemove: noop, flash: noop };
  const markup = html(React.createElement(FileRow, { artifact: backup[3], verified: true, actions, confirming: true, locked: true, onCancelRemove: noop, onConfirmRemove: noop }));
  assert.match(markup, /<button[^>]*disabled=""[^>]*title="Wait until it has finished"[^>]*>(?:(?!<\/button>).)*Remove/s);
  assert.match(markup, />Keep<\/span>/);
  assert.doesNotMatch(html(React.createElement(FileRow, { artifact: backup[3], verified: true, actions, confirming: true, onCancelRemove: noop, onConfirmRemove: noop })), /disabled=""/);
});

test("an older transfer that is still running keeps the card locked even after a newer one has finished", () => {
  const set = groupArtifactSets(backup)[0];
  const older = saveJob(set, { id: "old", state: "running", startedAt: NOW });
  const newer = saveJob(set, { id: "new", kind: "download", state: "succeeded", startedAt: NOW + 5, endedAt: NOW + 6 });
  assert.equal(runningTransfer([older, newer], set)?.id, "old");
  assert.equal(latestTransfer([older, newer], set)?.id, "new");
  assert.equal(runningTransfer([newer], set), undefined);
  const markup = panel(backup, { transfers: [older, newer] });
  assert.match(markup, />Cancel<\/span>/);
  assert.doesNotMatch(markup, />Download all<\/span>/, "no second transfer on top of the first");
});

test("while the backup is still being made, nothing is offered that would take half of it", () => {
  const set = groupArtifactSets(backup)[0];
  const markup = panel(backup, { busy: new Set([set.id]) });
  assert.match(markup, /<button[^>]*disabled=""[^>]*title="Wait until it has finished"[^>]*>(?:(?!<\/button>).)*Download all/s);
  assert.match(markup, /<button[^>]*disabled=""[^>]*title="Wait until it has finished"[^>]*>(?:(?!<\/button>).)*Save to server/s);
});

test("removing a file asks first, with the file's name and size, and the safe choice is Keep", () => {
  const actions = { sessionId: "s", selectedInputId: null, onSelectInput: noop, onDetails: noop, onRemove: noop, flash: noop };
  const markup = html(React.createElement(FileRow, { artifact: backup[3], verified: true, actions, confirming: true, onCancelRemove: noop, onConfirmRemove: noop }));
  assert.match(markup, /Remove part3 \(2\.0 MB\) from this browser\? This cannot be undone\./);
  assert.match(markup, />Remove<\/span>/);
  assert.match(markup, />Keep<\/span>/);
});

test("the menu of a file offers Use as input for an output and stops offering it once chosen", () => {
  const t = (key) => locales.en[key] ?? key;
  const actions = { sessionId: "s", selectedInputId: "file-1", onSelectInput: noop, onDetails: noop, onRemove: noop, flash: noop };
  assert.deepEqual(fileMenuItems(backup[1], actions, t, { input: false }).map((item) => item.label), ["Download", "Copy SHA-256", "Copy id", "Stop using as input", "Details", "Remove"]);
  assert.deepEqual(fileMenuItems(backup[2], actions, t, { input: false }).map((item) => item.label).includes("Use as input"), true);
  assert.equal(fileMenuItems(backup[2], actions, t, { input: true }).some((item) => item.id === "use"), false);
});

test("files are ordered as asked: as made, by name with numbers in order, or the biggest first", () => {
  const files = [output(10, { size: 5 }), output(2, { size: 50 }), output(1, { size: 500 })];
  assert.deepEqual(orderFiles(files, "order").map((file) => fileLabel(file)), ["part10", "part2", "part1"]);
  assert.deepEqual(orderFiles(files, "name").map((file) => fileLabel(file)), ["part1", "part2", "part10"]);
  assert.deepEqual(orderFiles(files, "size").map((file) => file.size), [500, 50, 5]);
  assert.deepEqual(files.map((file) => file.size), [5, 50, 500], "the set's own order is not disturbed");
});

test("a long list is cut to a first page unless asked for; a typed filter shows every match, whatever the cap", () => {
  const items = Array.from({ length: 58 }, (_, index) => `part${index}`);
  const named = (item) => item;
  assert.deepEqual({ rows: narrow(items, { query: "", showAll: false, nameOf: named }).rows.length, capped: narrow(items, { query: "", showAll: false, nameOf: named }).capped }, { rows: ROW_CAP, capped: true });
  assert.equal(narrow(items, { query: "", showAll: true, nameOf: named }).rows.length, 58);
  assert.equal(narrow(items.slice(0, ROW_CAP), { query: "", showAll: false, nameOf: named }).capped, false);
  const found = narrow(items, { query: " PART5 ", showAll: false, nameOf: named });
  assert.equal(found.rows.length, 9, "part5 and part50-part57, all of them, not a first page of them");
  assert.equal(found.hidden, 49);
  assert.deepEqual(narrow(items, { query: "zzz", showAll: false, nameOf: named }).rows, []);
});

test("arrow keys move through a menu, wrap around, and Home and End jump; any other key is not a menu key", () => {
  assert.equal(menuStep("ArrowDown", -1, 4), 0);
  assert.equal(menuStep("ArrowDown", 3, 4), 0, "wraps");
  assert.equal(menuStep("ArrowUp", 0, 4), 3, "wraps");
  assert.equal(menuStep("ArrowUp", -1, 4), 3);
  assert.equal(menuStep("Home", 2, 4), 0);
  assert.equal(menuStep("End", 0, 4), 3);
  assert.equal(menuStep("a", 0, 4), null);
  assert.equal(menuStep("ArrowDown", -1, 0), null, "an empty menu has nowhere to go");
});

test("what a set is, and how a transfer and a verification read", () => {
  const sets = groupArtifactSets([
    ...backup.slice(0, 2),
    output(70, { provenance: { operationId: "op-70", deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", label: "L" }, createdAt: NOW + 900_000 }),
    output(80, { provenance: { operationId: "op-80", deviceId: "usb-1", protocol: "adb", action: "pull", target: "/sdcard/a", label: "L" }, createdAt: NOW + 1_800_000 }),
  ]);
  assert.deepEqual(sets.map(setKind).sort(), ["backupSet", "dumps", "pulled"]);
  const en = (key, vars = {}) => locales.en[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
  const transfer = { id: "t", kind: "download", artifactIds: ["a"], label: "x", state: "running", progress: { phase: "writing", done: 3, total: 10, bytes: 0, totalBytes: 0 }, startedAt: NOW, origin: "user" };
  assert.equal(transferText(transfer, en), "Packing the zip… 3 of 10 files · 30%", "files count when no size is known");
  assert.equal(verifiedText(58, 0, en, (key, count) => en(`${key}.${count === 1 ? "one" : "other"}`, { count })), null);
  assert.equal(verifiedText(58, 40, en, () => ""), "40 of 58 verified");
});

test("every card and line of the files list reads in English, Japanese and Chinese with real words", () => {
  globalThis.document = { documentElement: {} };
  try {
    const set = groupArtifactSets(backup)[0];
    const saved = backup.map((file) => ({ ...file, server: { saveId: "s1", path: "/srv/b/x", folder: "/srv/b", savedAt: NOW, verified: true } }));
    const running = { id: "t1", kind: "save", setId: set.id, artifactIds: set.artifactIds, label: "x", state: "running", progress: { phase: "verifying", done: 12, total: 58, bytes: 41, totalBytes: 100 }, startedAt: NOW, origin: "agent" };
    const failed = { ...running, id: "t2", state: "failed", error: { code: "unknown", message: "boom" } };
    for (const locale of Object.keys(locales)) {
      setLocale(locale);
      const say = (key, vars = {}) => escape(locales[locale][key].replace(/\{(\w+)\}/g, (_, variable) => String(vars[variable])));
      const cards = {
        collapsed: panel([...backup, input("loader.mbn")], { verifiedBy: () => true }),
        open: panel(backup, { reveal: { setId: set.id, token: 1 } }),
        saved: panel(saved),
        running: panel(backup, { transfers: [running] }),
        failed: panel(backup, { transfers: [failed] }),
      };
      for (const [name, markup] of Object.entries(cards)) {
        assert.doesNotMatch(markup, /devices\.files\.[a-zA-Z.]+|devices\.items\.[a-zA-Z.]+|devices\.problem\.[a-zA-Z]+/, `${locale}/${name}: a translation key shows`);
        assert.doesNotMatch(markup, /\{[a-zA-Z]+\}/, `${locale}/${name}: a placeholder was not filled`);
      }
      assert.ok(cards.collapsed.includes(say("devices.files.downloadAll")) && cards.collapsed.includes(say("devices.files.saveToServer")), `${locale}: bulk actions`);
      assert.ok(cards.collapsed.includes(say("devices.files.verifiedAll.other", { count: 58 })), `${locale}: verified`);
      assert.ok(cards.collapsed.includes(say("devices.files.kind.dumps")) && cards.collapsed.includes(say("devices.files.inputs")), `${locale}: kind and inputs`);
      assert.ok(cards.open.includes(say("devices.files.filter")) && cards.open.includes(say("devices.files.sortLabel")) && cards.open.includes(say("devices.files.showAll", { count: 58 })), `${locale}: list tools`);
      assert.ok(cards.open.includes(say("devices.files.copySha")) && cards.open.includes(say("devices.files.useAsInput")), `${locale}: menu`);
      assert.ok(cards.saved.includes(say("devices.files.savedToServer")), `${locale}: saved`);
      assert.ok(cards.running.includes(say("devices.files.phase.verifying")), `${locale}: running phase`);
      assert.ok(cards.failed.includes(say("devices.problem.gotIt")), `${locale}: acknowledge`);
    }
  } finally {
    setLocale("en");
    delete globalThis.document;
  }
});
