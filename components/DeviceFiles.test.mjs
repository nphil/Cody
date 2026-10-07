process.env.TZ = "UTC";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * Files & backups, rendered for real. What a device made is listed as SETS: one card per run, with the things to do with
 * all of it; a backup of 58 partitions is one collapsed card, and opened it is a dense list with a filter, a first page,
 * partition names for labels and a menu per file. A card says how much of the device a backup took, can be combined with
 * the older backup, and can turn its list into checkboxes to download or save only some files. What the person added is a
 * short group of its own.
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ArtifactPanel } = await jiti.import("./devices/ArtifactPanel.tsx");
const { FileRow, SetCard, CombineConfirm, orderFiles, fileMenuItems } = await jiti.import("./devices/ArtifactSetCard.tsx");
const { menuStep } = await jiti.import("./devices/RowMenu.tsx");
const { FILTER_FROM, ROW_CAP, narrow } = await jiti.import("./devices/list-view.ts");
const { chosenIn, selectAll, selectNone, toggle } = await jiti.import("./devices/selection.ts");
const { downloadedText, fileLabel, latestTransfer, savedText, scopeText, selectionLabel, selectionText, setKind, setTitle, transferText, verifiedText } = await jiti.import("./devices/set-text.ts");
const { groupArtifactSets } = await jiti.import("../lib/devices/artifact-sets.ts");
const { labelSlug } = await jiti.import("../lib/devices/artifact-names.ts");
const { setLocale } = await jiti.import("../lib/i18n/index.tsx");
const { whenText } = await jiti.import("./devices/job-text.ts");

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

/** What `t` and `tn` say in one language, for the pure text helpers: the same templates the panel fills in. */
const words = (locale) => ({
  t: (key, vars = {}) => locales[locale][key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name])),
  tn: (key, count, vars = {}) => locales[locale][`${key}.${count === 1 ? "one" : "other"}`].replace(/\{(\w+)\}/g, (_, name) => String({ count, ...vars }[name])),
});
const partitions = (count) => Array.from({ length: count }, (_, index) => `part${index}`);
/** The files of ONE EDL backup on one device, as the backup command saves them; `provenance` adds to or overrides what they record. */
const backupFiles = (count, provenance = {}, over = {}) => Array.from({ length: count }, (_, index) => output(index, {
  provenance: { operationId: "op-backup", deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", target: `part${index}`, label: "Lenovo QUSB__BULK", ...provenance },
  ...over,
}));
/** The files of ONE EDL backup of `chosen` of `all` partitions, whole: both tables, the partitions, and the manifest the backup writes last. */
const wholeBackup = (chosen, all, provenance = {}) => [
  ...["edl-1-set-gpt-primary.bin", ...chosen.map((name, index) => `edl-1-set-p${index}-${name}.bin`), "edl-1-set-gpt-backup.bin", "edl-1-set-0123abcd.manifest.json"].map((name, index) => output(index, {
    name,
    provenance: { operationId: "op-backup", deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", label: "Lenovo QUSB__BULK", scope: { chosen, all }, ...provenance },
  })),
];
/** An older backup of 2 files and a newer one of 3 on one device, and one more on another device. */
function twoBackups() {
  const made = (prefix, count, operationId, deviceId, at) => Array.from({ length: count }, (_, index) => output(index, {
    id: `${prefix}-${index}`,
    createdAt: at + index * 1_000,
    provenance: { operationId, deviceId, protocol: "edl", action: "exec", command: "backup", target: `${prefix}${index}`, label: deviceId === "usb-1" ? "Lenovo QUSB__BULK" : "Other tablet" },
  }));
  const artifacts = [...made("old", 2, "op-old", "usb-1", NOW - 3_600_000), ...made("new", 3, "op-new", "usb-1", NOW), ...made("far", 1, "op-far", "usb-2", NOW - 7_200_000)];
  const sets = groupArtifactSets(artifacts);
  const startingWith = (id) => sets.find((set) => set.artifactIds[0] === id);
  return { artifacts, older: startingWith("old-0"), newer: startingWith("new-0"), stranger: startingWith("far-0") };
}
const titleOf = (markup) => /class="dv-set__title">([^<]*)</.exec(markup)?.[1];
/** One set's card out of a panel's markup. */
const cardOf = (markup, set) => markup.split("<article ").find((part) => part.includes(`data-set="${set.id}"`)) ?? "";
const buttonTag = (markup, label) => (new RegExp(`<button[^>]*>(?:(?!</button>).)*${escape(label)}`, "s").exec(markup) ?? [])[0];
const menuItemTag = (markup, label) => (new RegExp(`<button[^>]*role="menuitem"[^>]*>(?:(?!</button>).)*${escape(label)}`, "s").exec(markup) ?? [])[0];
const isDisabled = (tag) => /\sdisabled(=|\s|>)/.test(tag.slice(0, tag.indexOf(">") + 1));
/** One set card on its own, for what the panel does not pass through: opened, choosing files. */
const cardFor = (files, over = {}) => html(React.createElement(SetCard, {
  sessionId: "session-files", set: groupArtifactSets(files)[0], artifacts: files, transfers: [], deviceName: "Lenovo QUSB__BULK", busy: false, selectedInputId: null,
  onSelectInput: noop, onDetails: noop, verifiedBy: () => undefined, acknowledged: new Set(), acknowledge: noop, locale: "en", ...over,
}));

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

test("a set the server holds says so in one line, with what packing did to it, and where; a half-saved one says how many", () => {
  const copy = { saveId: "s1", archive: "/srv/b/lenovo-2026-10-06.zip", entry: "lenovo-2026-10-06/part0.bin", archiveBytes: 41 * MB, originalBytes: 116 * MB, savedAt: NOW + 5_000, verified: true };
  const markup = panel(backup.map((file) => ({ ...file, server: copy })));
  assert.match(markup, /Saved · 1 file · 116 MB → 41 MB</);
  assert.match(markup, /<code title="\/srv\/b\/lenovo-2026-10-06\.zip">\/srv\/b\/lenovo-2026-10-06\.zip<\/code>/);
  assert.match(markup, /checked on the server/);
  const half = panel(backup.map((file, index) => (index < 20 ? { ...file, server: copy } : file)));
  assert.match(half, /20 of 58 on the server/);
  assert.doesNotMatch(half, /Saved · /);
});

test("a finished download says which zip it wrote and what packing did to the size", () => {
  const set = groupArtifactSets(backup)[0];
  const done = { id: "d1", kind: "download", setId: set.id, artifactIds: set.artifactIds, label: "x", state: "succeeded", progress: { phase: "writing", done: 58, total: 58, bytes: 100, totalBytes: 100 }, startedAt: NOW, endedAt: NOW + 5, origin: "user", result: { fileName: "lenovo-20261006-1831.zip", files: 58, bytes: 116 * MB, archiveBytes: 41 * MB, method: "file-picker" } };
  assert.match(panel(backup, { transfers: [done] }), /Downloaded as lenovo-20261006-1831\.zip · 116 MB → 41 MB</);
  assert.doesNotMatch(panel(backup, { transfers: [{ ...done, state: "failed", result: undefined, error: { code: "unknown", message: "boom" } }] }), /Downloaded as/);
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
  assert.equal(items(true).find((item) => item.id === "remove").title, "Wait until it has finished", "and says why, like the other locked controls");
  assert.equal(items(false).find((item) => item.id === "remove").title, undefined);
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

test("a transfer over the files of two sets (an agent saving everything) locks both cards, so neither can be removed from under it", () => {
  const { artifacts, older, newer, stranger } = twoBackups();
  const everything = { id: "all", kind: "save", artifactIds: [...older.artifactIds, ...newer.artifactIds], label: "Device files", state: "running", progress: { phase: "uploading", done: 1, total: 5, bytes: 1, totalBytes: 5 }, startedAt: NOW, origin: "agent" };
  const markup = panel(artifacts, { transfers: [everything] });
  for (const [set, name] of [[older, "the older set"], [newer, "the newer set"]]) {
    const card = cardOf(markup, set);
    assert.match(card, />Cancel<\/span>/, `${name} shows the transfer`);
    assert.doesNotMatch(card, />Download all<\/span>/, `${name} offers no second transfer`);
    assert.equal(isDisabled(menuItemTag(card, "Remove set…")), true, `${name} cannot be removed while the transfer reads its files`);
  }
  const untouched = cardOf(markup, stranger);
  assert.match(untouched, />Download all<\/span>/, "a set the transfer does not read is free");
  assert.equal(isDisabled(menuItemTag(untouched, "Remove set…")), false);
  assert.equal(runningTransfer([everything], older)?.id, "all");
  assert.equal(latestTransfer([everything], older), undefined, "but the note about the last transfer stays the set's own: a transfer of everything is not this set's download");
});

test("the Remove set question is held like the other controls while a transfer runs, and a question asked about an earlier list of files is dropped when the set changes", () => {
  const set = groupArtifactSets(backup)[0];
  const asked = { what: "remove", members: set.artifactIds };
  const free = cardFor(backup, { defaultAsked: asked });
  assert.match(free, /Remove 58 files from this browser\?/);
  assert.equal(isDisabled(buttonTag(free, "Remove")), false);
  const held = cardFor(backup, { defaultAsked: asked, transfers: [saveJob(set)] });
  assert.doesNotMatch(held, /from this browser\?/, "a transfer that began after the question was asked takes its place: nothing can be removed from under it");
  assert.match(held, />Cancel<\/span>/);
  const busy = cardFor(backup, { defaultAsked: asked, busy: true });
  assert.match(busy, /Remove 58 files from this browser\?/);
  assert.equal(isDisabled(buttonTag(busy, "Remove")), true, "the job that is still making the files holds the question, like every other control");
  assert.match(buttonTag(busy, "Remove"), /title="Wait until it has finished"/);
  assert.equal(isDisabled(buttonTag(busy, "Keep")), false);
  // The job added a file since the question was asked: the question was about 58 files, the card now lists 59.
  const grown = cardFor([...backup, output(99)], { defaultAsked: asked });
  assert.doesNotMatch(grown, /from this browser\?/, "a question about an earlier list is not answered about files the person never saw");
  assert.match(grown, />Download all<\/span>/, "the card is back to its actions");
});

test("while the backup is still being made, nothing is offered that would take half of it", () => {
  const set = groupArtifactSets(backup)[0];
  const markup = panel(backup, { busy: new Set([set.id]) });
  assert.match(markup, /<button[^>]*disabled=""[^>]*title="Wait until it has finished"[^>]*>(?:(?!<\/button>).)*Download all/s);
  assert.match(markup, /<button[^>]*disabled=""[^>]*title="Wait until it has finished"[^>]*>(?:(?!<\/button>).)*Save to server/s);
  const removal = menuItemTag(markup, "Remove set…");
  assert.equal(isDisabled(removal), true, "and the set cannot be removed from under the job that is making it");
  assert.match(removal, /title="Wait until it has finished"/);
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

test("the sentences for what a backup took, what the server holds and what a download wrote", () => {
  const en = words("en");
  assert.equal(scopeText({ chosen: 56, total: 56, complete: true }, 59, en.tn), "Full backup · 56 partitions");
  assert.equal(scopeText({ chosen: 1, total: 1, complete: true }, 4, en.tn), "Full backup · 1 partition");
  assert.equal(scopeText({ chosen: 5, total: 56, complete: true }, 8, en.tn), "Backup · 5 of 56 partitions");
  assert.equal(scopeText({ chosen: 56, total: 56, complete: false }, 3, en.tn), "Incomplete backup · 3 files", "a backup the set does not hold whole never reads as a full one");
  assert.equal(scopeText({ chosen: 5, total: 56, complete: false }, 1, en.tn), "Incomplete backup · 1 file");
  const saved = { state: "saved", path: "/srv/b/lenovo.zip", savedAt: NOW, verified: true, files: 56, bytes: 3.8 * 1024 ** 3, archiveBytes: 610 * MB, archives: 1 };
  assert.equal(savedText(saved, en.t, en.tn), "Saved · 1 file · 3.8 GB → 610 MB", "the whole save is one archive: one file");
  assert.equal(savedText({ ...saved, bytes: 5 * 1024 ** 3, archiveBytes: 700 * MB, archives: 2 }, en.t, en.tn), "Saved · 2 files · 5.0 GB → 700 MB", "saved in two groups: two archives");
  const job = { id: "d", kind: "download", artifactIds: ["a"], label: "x", state: "succeeded", progress: { phase: "writing", done: 1, total: 1, bytes: 1, totalBytes: 1 }, startedAt: NOW, endedAt: NOW + 1, origin: "user", result: { fileName: "lenovo-20261006-1831.zip", files: 56, bytes: 3.8 * 1024 ** 3, archiveBytes: 610 * MB, method: "file-picker" } };
  assert.equal(downloadedText(job, en.t), "Downloaded as lenovo-20261006-1831.zip · 3.8 GB → 610 MB");
  assert.equal(downloadedText({ ...job, state: "running", result: undefined }, en.t), undefined, "nothing was written yet");
  assert.equal(downloadedText({ ...job, kind: "save", result: { saveId: "s", archive: "/srv/a.zip", archiveBytes: 1, files: 1, bytes: 1, verified: true, resumed: false } }, en.t), undefined, "a save is told on the card by its saved line");
  assert.equal(selectionText(3, 58, "6.0 MB", en.t), "3 of 58 selected · 6.0 MB");
});

test("a backup says how much of the device it took: Full backup, or K of N, so a partial one cannot pass for a whole one", () => {
  const all = partitions(56);
  const full = panel(wholeBackup(all, all));
  assert.equal(titleOf(full), "Lenovo QUSB__BULK · Full backup · 56 partitions");
  const stopped = panel(backupFiles(3, { scope: { chosen: all, all } }));
  assert.equal(titleOf(stopped), "Lenovo QUSB__BULK · Incomplete backup · 3 files", "three files of a backup of 56, without its manifest, are a backup that stopped: never a full one");
  assert.doesNotMatch(stopped, /Full backup/);
  const trimmed = panel(wholeBackup(all, all).slice(1));
  assert.equal(titleOf(trimmed), "Lenovo QUSB__BULK · Incomplete backup · 58 files", "a whole backup minus one file is not whole");
  const part = panel(wholeBackup(all.slice(0, 5), all));
  assert.equal(titleOf(part), "Lenovo QUSB__BULK · Backup · 5 of 56 partitions");
  assert.doesNotMatch(part, /Full backup/);
  // One sentence names the card for a screen reader, in its menu and over its list.
  assert.match(part, /<article class="dv-set" aria-label="Lenovo QUSB__BULK · Backup · 5 of 56 partitions"/);
  assert.match(part, /aria-label="More actions for Lenovo QUSB__BULK · Backup · 5 of 56 partitions"/);
  assert.match(cardFor(wholeBackup(all.slice(0, 5), all), { defaultOpen: true }), /aria-label="Files in Lenovo QUSB__BULK · Backup · 5 of 56 partitions"/);
  assert.equal(setTitle(groupArtifactSets(wholeBackup(all, all))[0], "Lenovo now", words("en").t, words("en").tn), "Lenovo QUSB__BULK · Full backup · 56 partitions", "the name the files recorded wins over the device's name now");
  assert.equal(titleOf(panel(backupFiles(3))), "Lenovo QUSB__BULK · Backup set", "no scope, no name: what made it, as before");
});

test("a set an agent named leads with that name and keeps the partitions it took on a second line; a name a person made up by combining is never shown", () => {
  const all = partitions(56);
  const named = panel(wholeBackup(all.slice(0, 5), all, { set: "tablet-2026-10-07" }));
  assert.equal(titleOf(named), "Lenovo QUSB__BULK · tablet-2026-10-07");
  assert.match(named, /class="dv-set__title">[^<]*<\/span><span class="dv-set__scope">Backup · 5 of 56 partitions<\/span><span class="dv-set__meta"/);
  const plain = panel(backupFiles(3, { set: "tablet-2026-10-07" }));
  assert.equal(titleOf(plain), "Lenovo QUSB__BULK · tablet-2026-10-07");
  assert.doesNotMatch(plain, /dv-set__scope/, "nothing to say about partitions");
  const joined = panel(backupFiles(3, {}, { setName: "\u0001combined-1" }));
  assert.equal(titleOf(joined), "Lenovo QUSB__BULK · Backup set");
  assert.doesNotMatch(joined, /combined-1/);
});

test("Combine with the older backup is offered only where there is an older backup of the same device, before Remove set", () => {
  const { artifacts, older, newer, stranger } = twoBackups();
  const markup = panel(artifacts);
  const labels = (part) => [...part.matchAll(/role="menuitem"[^>]*>(?:<span[^>]*>.*?<\/span>)?<span>([^<]+)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(labels(cardOf(markup, newer)), ["Combine with the older backup…", "Remove set…"]);
  assert.deepEqual(labels(cardOf(markup, older)), ["Remove set…"], "nothing is older on this device");
  assert.deepEqual(labels(cardOf(markup, stranger)), ["Remove set…"], "another device's backup is not its older backup");
  assert.equal(isDisabled(menuItemTag(markup, "Combine with the older backup…")), false);
});

test("Combine waits while either backup is being sent or is still being made, and says why like the other locked controls", () => {
  const { artifacts, older, newer } = twoBackups();
  const sending = (set, over = {}) => ({ id: `t-${set.id}`, kind: "download", setId: set.id, artifactIds: set.artifactIds, label: "x", state: "running", progress: { phase: "writing", done: 1, total: 2, bytes: 1, totalBytes: 2 }, startedAt: NOW, origin: "user", ...over });
  const combine = (over) => menuItemTag(cardOf(panel(artifacts, over), newer), "Combine with the older backup…");
  for (const [why, over] of [
    ["this backup is being sent", { transfers: [sending(newer)] }],
    ["the older backup is being sent", { transfers: [sending(older)] }],
    ["this backup is still being made", { busy: new Set([newer.id]) }],
    ["the older backup is still being made", { busy: new Set([older.id]) }],
  ]) {
    assert.equal(isDisabled(combine(over)), true, why);
    assert.match(combine(over), /title="Wait until it has finished"/, why);
  }
  assert.equal(isDisabled(combine({ transfers: [sending(older, { state: "succeeded", endedAt: NOW + 1 })] })), false, "a transfer that is over holds nothing");
  assert.equal(isDisabled(combine({ busy: new Set(["set:somewhere-else"]) })), false);
});

test("combining asks first: which files join which and what it makes, and the safe choice, Keep, has the focus", () => {
  const [olderSet] = groupArtifactSets(backupFiles(51, {}, { createdAt: NOW - 3_600_000 }));
  const confirm = (props = {}) => html(React.createElement(CombineConfirm, { files: 3, older: olderSet, olderTitle: "Lenovo QUSB__BULK · Backup set", locale: "en", locked: false, onConfirm: noop, onKeep: noop, ...props }));
  const markup = confirm();
  assert.match(markup, /<p>3 files will join Lenovo QUSB__BULK · Backup set \([^)]+, 51 files\)\. The two become one card and one zip file\.<\/p>/, "the question names the backup it would join, with its date and size");
  assert.match(markup, />Combine<\/span>/);
  assert.match(markup, /autofocus=""[^>]*>(?:(?!<\/button>).)*Keep/s);
  assert.match(confirm({ files: 1, older: groupArtifactSets(backupFiles(1))[0] }), /<p>1 file will join Lenovo QUSB__BULK · Backup set \([^)]+, 1 file\)\./);
  assert.equal(isDisabled(buttonTag(markup, "Combine")), false);
  const held = confirm({ locked: true });
  assert.equal(isDisabled(buttonTag(held, "Combine")), true, "a transfer that began after the question was asked holds it");
  assert.match(buttonTag(held, "Combine"), /title="Wait until it has finished"/);
  assert.equal(isDisabled(buttonTag(held, "Keep")), false);
});

test("opened, a set offers Select files; choosing turns every row into a checkbox with All, None and a count of the whole set", () => {
  const opened = cardFor(backup, { defaultOpen: true });
  assert.match(opened, />Select files<\/span>/);
  assert.doesNotMatch(opened, /role="checkbox"/);
  assert.match(opened, />Download all<\/span>/);

  const choosing = cardFor(backup, { defaultSelecting: true, defaultSelected: ["file-1", "file-2", "file-30", "gone"] });
  const boxes = [...choosing.matchAll(/<button[^>]*role="checkbox"[^>]*>/g)].map((match) => match[0]);
  assert.equal(boxes.length, ROW_CAP, "the first page, as before");
  assert.equal((choosing.match(/<li class="dv-file dv-file--pick"/g) ?? []).length, ROW_CAP);
  assert.deepEqual(boxes.slice(0, 4).map((tag) => /aria-checked="true"/.test(tag)), [false, true, true, false]);
  assert.match(choosing, /dv-pickbar__count" role="status">3 of 58 selected · 6\.0 MB</, "file-30 is off the first page and still counts; a file that is not in the set does not");
  assert.match(choosing, />All<\/span>/);
  assert.match(choosing, />None<\/span>/);
  assert.match(choosing, /Show all 58/);
  assert.match(choosing, /<label[^>]*>Find a file<\/label>/);
  assert.match(choosing, /role="radiogroup"[^>]*aria-label="Sort files"/);
  assert.match(choosing, /aria-label="Actions for part0"/, "each row keeps its menu");
  assert.doesNotMatch(choosing, />Select files<\/span>/, "already choosing");
  assert.equal((cardFor([output(0)], { defaultOpen: true }).match(/Select files/g) ?? []).length, 0, "one file is not a choice");
});

test("while choosing, the bulk actions are Download selected and Save selected, waiting for a choice and for the backup to be whole", () => {
  const none = cardFor(backup, { defaultSelecting: true });
  assert.match(none, /0 of 58 selected · 0 B/);
  assert.equal(isDisabled(buttonTag(none, "Download selected")), true);
  assert.equal(isDisabled(buttonTag(none, "Save selected")), true);
  assert.equal(isDisabled(buttonTag(none, "Done")), false);
  assert.doesNotMatch(none, />Download all<\/span>|>Save to server<\/span>/, "the defaults are back only when the choosing is over");
  const some = cardFor(backup, { defaultSelecting: true, defaultSelected: ["file-3"] });
  assert.equal(isDisabled(buttonTag(some, "Download selected")), false);
  assert.equal(isDisabled(buttonTag(some, "Save selected")), false);
  const making = cardFor(backup, { defaultSelecting: true, defaultSelected: ["file-3"], busy: true });
  for (const label of ["Download selected", "Save selected"]) {
    assert.equal(isDisabled(buttonTag(making, label)), true);
    assert.match(buttonTag(making, label), /title="Wait until it has finished"/);
  }
  const set = groupArtifactSets(backup)[0];
  const sending = { id: "t", kind: "save", setId: set.id, artifactIds: ["file-3"], label: "x", state: "running", progress: { phase: "uploading", done: 0, total: 1, bytes: 1, totalBytes: 2 }, startedAt: NOW, origin: "user" };
  const running = cardFor(backup, { defaultSelecting: true, defaultSelected: ["file-3"], transfers: [sending] });
  assert.match(running, />Cancel<\/span>/, "a transfer of some of the files holds the card as one of all of them does");
  assert.doesNotMatch(running, />Download selected<\/span>/);
});

test("choosing files: tick, All, None, and what is left once files are gone, as pure functions", () => {
  const ids = ["a", "b", "c", "d"];
  const one = toggle(selectNone(), "c");
  assert.deepEqual([...one], ["c"]);
  assert.deepEqual([...toggle(one, "c")], [], "ticking again unticks");
  assert.deepEqual([...one], ["c"], "a choice is never changed in place");
  assert.deepEqual(chosenIn(ids, toggle(toggle(one, "d"), "a")), ["a", "c", "d"], "in the list's own order, not the order they were ticked");
  assert.deepEqual(chosenIn(ids, selectAll(ids)), ids, "All is every id of the list it is given, not the rows on screen");
  assert.deepEqual(chosenIn(ids, selectNone()), []);
  assert.deepEqual(chosenIn(["b", "c"], new Set(["a", "b", "x"])), ["b"], "a file that was removed or combined away drops out by itself");
});

test("a selection's label says it is a selection and stays short, because it ends up in a file name", () => {
  const [set] = groupArtifactSets(backupFiles(3));
  assert.equal(selectionLabel(set, 3), "Lenovo QUSB__BULK EDL backup (3 files)");
  assert.equal(selectionLabel(set, 1), "Lenovo QUSB__BULK EDL backup (1 file)");
  const [partial] = groupArtifactSets(wholeBackup(partitions(5), partitions(56)));
  assert.equal(selectionLabel(partial, 2), "Lenovo QUSB__BULK EDL backup 5 of 56 (2 files)", "a partial backup keeps saying so");
  const [stopped] = groupArtifactSets(backupFiles(3, { scope: { chosen: partitions(5), all: partitions(56) } }));
  assert.equal(selectionLabel(stopped, 2), "Lenovo QUSB__BULK EDL backup incomplete (2 files)", "and so does one that stopped part-way");
  const [named] = groupArtifactSets(wholeBackup(partitions(5), partitions(56), { set: "tablet ".repeat(12).trim() }));
  const long = selectionLabel(named, 12);
  assert.ok(long.endsWith(" 5 of 56 (12 files)"), long);
  assert.ok(labelSlug(long).endsWith("-5-of-56-12-files"), `the whole suffix survives the file name: ${labelSlug(long)}`);
});

test("every card and line of the files list reads in English, Japanese and Chinese with real words", () => {
  globalThis.document = { documentElement: {} };
  try {
    const set = groupArtifactSets(backup)[0];
    const copy = { saveId: "s1", archive: "/srv/b/x.zip", entry: "x/part0.bin", archiveBytes: 41 * MB, originalBytes: 116 * MB, savedAt: NOW, verified: true };
    const saved = backup.map((file) => ({ ...file, server: copy }));
    const running = { id: "t1", kind: "save", setId: set.id, artifactIds: set.artifactIds, label: "x", state: "running", progress: { phase: "verifying", done: 12, total: 58, bytes: 41, totalBytes: 100 }, startedAt: NOW, origin: "agent" };
    const failed = { ...running, id: "t2", state: "failed", error: { code: "unknown", message: "boom" } };
    const downloaded = { ...running, id: "t3", kind: "download", state: "succeeded", endedAt: NOW + 1, result: { fileName: "lenovo-20261006-1831.zip", files: 58, bytes: 116 * MB, archiveBytes: 41 * MB, method: "file-picker" } };
    const all = partitions(56);
    const twin = twoBackups();
    for (const locale of Object.keys(locales)) {
      setLocale(locale);
      const { tn } = words(locale);
      const say = (key, vars = {}) => escape(locales[locale][key].replace(/\{(\w+)\}/g, (_, variable) => String(vars[variable])));
      const cards = {
        collapsed: panel([...backup, input("loader.mbn")], { verifiedBy: () => true }),
        open: panel(backup, { reveal: { setId: set.id, token: 1 } }),
        saved: panel(saved),
        running: panel(backup, { transfers: [running] }),
        failed: panel(backup, { transfers: [failed] }),
        downloaded: panel(backup, { transfers: [downloaded] }),
        full: panel(wholeBackup(all, all)),
        partial: panel(wholeBackup(all.slice(0, 5), all, { set: "tablet-2026-10-07" })),
        stopped: panel(backupFiles(3, { scope: { chosen: all, all } })),
        combine: panel(twin.artifacts),
        confirm: html(React.createElement(CombineConfirm, { files: 3, older: groupArtifactSets(backupFiles(51))[0], olderTitle: "Lenovo QUSB__BULK · Backup set", locale, locked: false, onConfirm: noop, onKeep: noop })),
        choosing: cardFor(backup, { defaultSelecting: true, defaultSelected: ["file-1", "file-2"] }),
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
      assert.ok(cards.open.includes(say("devices.files.selectFiles")), `${locale}: the way into choosing files`);
      assert.ok(cards.saved.includes(say("devices.files.savedLine", { files: tn("devices.files.count", 1), original: "116 MB", archive: "41 MB" })), `${locale}: saved, with what packing did`);
      assert.ok(cards.running.includes(say("devices.files.phase.verifying")), `${locale}: running phase`);
      assert.ok(cards.failed.includes(say("devices.problem.gotIt")), `${locale}: acknowledge`);
      assert.ok(cards.downloaded.includes(say("devices.files.downloaded", { name: "lenovo-20261006-1831.zip", original: "116 MB", archive: "41 MB" })), `${locale}: downloaded, with what packing did`);
      assert.ok(cards.full.includes(say("devices.files.scopeFull.other", { count: 56 })), `${locale}: a full backup`);
      assert.ok(cards.partial.includes(say("devices.files.scopePartial.other", { count: 56, chosen: 5 })), `${locale}: a partial backup, on the second line of a named one`);
      assert.ok(cards.combine.includes(say("devices.files.combineWithOlder")), `${locale}: combine`);
      assert.ok(cards.confirm.includes(escape(say("devices.files.combineConfirm", { these: tn("devices.files.count", 3), title: "Lenovo QUSB__BULK · Backup set", when: whenText(NOW + 50_000, locale), older: tn("devices.files.count", 51) }))) && cards.confirm.includes(say("devices.files.combine")), `${locale}: the question before combining`);
      assert.ok(cards.choosing.includes(say("devices.files.selectedCount", { selected: 2, total: 58, size: "4.0 MB" })), `${locale}: the count`);
      for (const key of ["selectAll", "selectNone", "downloadSelected", "saveSelected", "selectDone"]) assert.ok(cards.choosing.includes(say(`devices.files.${key}`)), `${locale}: ${key}`);
    }
  } finally {
    setLocale("en");
    delete globalThis.document;
  }
});
