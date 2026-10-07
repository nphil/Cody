process.env.TZ = "UTC";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * The Devices panel's activity, rendered for real. A backup of 58 partitions is ONE card while it runs and ONE line
 * afterwards; whatever needs the person is pinned first and a failure stays there until it is acknowledged; nothing
 * technical (a hash, an id, a log, JSON) is written out in the feed, yet all of it is one tap away in the detail sheet.
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { NeedsYou, LiveJobs, History } = await jiti.import("./devices/ActivityFeed.tsx");
const { DetailSheet } = await jiti.import("./devices/DetailSheet.tsx");
const { DeviceCard } = await jiti.import("./devices/DeviceCard.tsx");
const { groupActivity, activityView } = await jiti.import("../lib/devices/activity-groups.ts");
const { setLocale } = await jiti.import("../lib/i18n/index.tsx");

const locales = Object.fromEntries(
  await Promise.all(["en", "ja", "zh-CN"].map(async (name) => [name, JSON.parse(await readFile(new URL(`../lib/i18n/locales/${name}.json`, import.meta.url), "utf8"))])),
);

const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const html = (element) => renderToStaticMarkup(element);

let counter = 0;
function operation(over = {}) {
  counter += 1;
  const { request, ...rest } = over;
  const createdAt = over.createdAt ?? NOW - 3_600_000 + counter * 1_000;
  return {
    id: `op-${counter}`,
    sessionId: "session-a",
    origin: "agent",
    state: "succeeded",
    createdAt,
    updatedAt: over.updatedAt ?? createdAt + 1_500,
    output: [],
    events: [],
    result: { summary: "ok" },
    request: { protocol: "edl", action: "dump", deviceId: "usb-1", target: `part${counter}`, ...request },
    ...rest,
  };
}
const dumped = (name, over = {}) => operation({ request: { target: name }, progress: { phase: "read", completed: MB, total: MB, at: NOW }, result: { summary: `Read ${name}`, verified: true, sha256: "ab".repeat(32), fileId: `file-${name}`, details: { partition: name } }, ...over });
const recent = (name) => dumped(name, { createdAt: NOW - 90_000 + counter * 500 });
const read = (command, over = {}) => operation({ request: { protocol: "fastboot", action: "exec", command, target: undefined }, ...over });

/** A dump in flight at `completed` of `total` bytes, moving `perSecond`. */
function dumping(target, total, completed, perSecond) {
  const events = [];
  for (let step = 0; step <= 8; step += 1) {
    const at = NOW - (8 - step) * 1000;
    events.push({ sequence: step + 1, at, type: "progress", progress: { phase: "read", completed: Math.max(0, completed - (8 - step) * perSecond), total, at } });
  }
  return operation({ request: { target }, state: "running", result: undefined, createdAt: NOW - 20_000, updatedAt: NOW, progress: { phase: "read", completed, total, at: NOW, message: `Reading ${target}` }, events });
}

const cancelled = [];
const manager = { cancel(id) { cancelled.push(id); }, sendUser() {} };
const baseContext = (over = {}) => ({
  manager,
  now: NOW,
  locale: "en",
  showDevice: false,
  deviceLabel: () => "Lenovo QUSB__BULK",
  connected: () => true,
  planFor: () => undefined,
  filesOf: () => undefined,
  openDetails() {},
  showFiles() {},
  acknowledge() {},
  ...over,
});
const viewOf = (operations, over = {}) => activityView([{ deviceId: "usb-1", entries: groupActivity(operations, { now: NOW }) }], { now: NOW, acknowledged: new Set(), timeZone: "UTC", ...over });

const binding = { action: "fastboot command", target: "reboot-bootloader", backup: "Not applicable: reboot changes mode.", details: "Switch device mode; reconnect after USB re-enumerates." };
const counting = (releaseAt, over = {}) => operation({ state: "countdown", result: undefined, riskDeclared: true, request: { protocol: "fastboot", action: "exec", command: "reboot-bootloader", target: undefined }, countdown: { startedAt: releaseAt - 30_000, releaseAt, binding }, ...over });
const waiting = (over = {}) => operation({ state: "awaiting-trust", result: undefined, ...over });
const failedDump = (name) => dumped(name, { state: "failed", error: "The device stopped answering: a read timed out.", result: undefined });
const hex64 = /[0-9a-f]{64}/;

/** Everything the feed shows for a finished backup of 58 partitions plus a running one, a question and a failure. */
function feedMarkup(ctx = baseContext()) {
  const names = Array.from({ length: 58 }, (_, index) => `part${index}`);
  const view = viewOf([...names.map((name) => dumped(name)), read("getvar product"), read("getvar serialno")]);
  return html(React.createElement(React.Fragment, null,
    React.createElement(NeedsYou, { items: viewOf([waiting(), failedDump("vendor_b")]).needsYou, ctx }),
    React.createElement(LiveJobs, { jobs: viewOf([recent("a"), recent("b"), dumping("c", 80 * MB, 40 * MB, MB)]).live, ctx }),
    React.createElement(History, { groups: view.history, ctx, timeZone: "UTC" }),
  ));
}

test("what needs the person is pinned first, in order: a countdown, then the question in the chat, then a failure", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const items = viewOf([failedDump("vendor_b"), waiting({ request: { target: "boot_a" } }), counting(NOW + 30_000)]).needsYou;
  const markup = html(React.createElement(NeedsYou, { items, ctx: baseContext() }));
  assert.match(markup, /<h3[^>]*>Needs you · 3<\/h3>/);
  const order = ["Starting in 30 s", "Waiting for your answer", "Back up vendor_b"].map((text) => markup.indexOf(text));
  assert.ok(order.every((index) => index > 0) && order[0] < order[1] && order[1] < order[2], `order ${order}`);
  assert.equal((markup.match(/<section class="dv-need[ "]/g) ?? []).length, 3, "three rows exist; two are shown and the third is folded");
  assert.ok(markup.indexOf('<details class="dv-more">') < markup.lastIndexOf("Back up vendor_b"), "the third is inside the fold");
  assert.match(markup, /<details class="dv-more">\s*<summary[^>]*>1 more needs you<\/summary>/);
  assert.equal(html(React.createElement(NeedsYou, { items: [], ctx: baseContext() })), "", "nothing needs the person: nothing is drawn");
});

test("a command counting down shows its exact action, a live countdown and one Cancel that stops it", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const markup = html(React.createElement(NeedsYou, { items: viewOf([counting(NOW + 30_000)]).needsYou, ctx: baseContext() }));
  assert.match(markup, /Starting in 30 s/);
  assert.match(markup, /<code>fastboot command - reboot-bootloader<\/code>/);
  assert.match(markup, /Nothing has been sent yet\./);
  assert.equal((markup.match(/Cancel, don&#x27;t send/g) ?? []).length, 1, "one Cancel");
  assert.match(markup, /min-height:44px/, "a full-size touch target");
  assert.doesNotMatch(markup, /Cancel operation/);
});

test("commands held behind the one question in the chat are ONE row that says how many, and can be cancelled without answering", () => {
  const items = viewOf([waiting({ request: { target: "a" } }), waiting({ request: { target: "b" } }), waiting({ request: { target: "c" } })]).needsYou;
  assert.equal(items.length, 1);
  const markup = html(React.createElement(NeedsYou, { items, ctx: baseContext() }));
  assert.match(markup, /Waiting for your answer/);
  assert.match(markup, /The agent wants to control this device\. Answer the question in the chat to let it start\./);
  assert.match(markup, /3 commands are waiting/);
  assert.match(markup, /Cancel the 3 waiting commands/);
  assert.doesNotMatch(markup, /Starting in/);
});

test("a failure is pinned with the reason and the two things to do, and goes only when acknowledged", () => {
  const names = Array.from({ length: 58 }, (_, index) => `part${index}`);
  const broken = names.map((name) => (name === "part30" ? failedDump(name) : dumped(name)));
  const pinned = viewOf(broken);
  assert.deepEqual(pinned.needsYou.map((item) => item.kind), ["problem"]);
  const markup = html(React.createElement(NeedsYou, { items: pinned.needsYou, ctx: baseContext({ showDevice: true }) }));
  assert.match(markup, /Back up 58 partitions/);
  assert.match(markup, /Failed · Lenovo QUSB__BULK/);
  assert.match(markup, /1 failed, 57 done\. First: part30 — The device stopped answering: a read timed out\./);
  assert.match(markup, /aria-label="Details of Back up 58 partitions"/);
  assert.match(markup, />Got it<\/span>/);
  assert.equal(pinned.history.length, 0, "it is not also in the history");
  const acknowledged = viewOf(broken, { acknowledged: new Set([broken[30].id]) });
  assert.deepEqual(acknowledged.needsYou, []);
  assert.match(html(React.createElement(History, { groups: acknowledged.history, ctx: baseContext(), timeZone: "UTC" })), /1 failed/, "still listed, still marked failed");
});

test("a backup that is running is ONE card: what it is, how far, how long is left, what it is on, with Details and Cancel", () => {
  const table = [{ name: "a", bytes: 10 * MB }, { name: "b", bytes: 10 * MB }, { name: "c", bytes: 10 * MB }, { name: "d", bytes: 80 * MB }, { name: "e", bytes: 100 * MB }];
  const ops = [recent("a"), recent("b"), recent("c"), dumping("d", 80 * MB, 60 * MB, MB)];
  const job = viewOf(ops).live[0];
  const markup = html(React.createElement(LiveJobs, { jobs: [job], ctx: baseContext({ planFor: () => table }) }));
  assert.equal((markup.match(/<article/g) ?? []).length, 1, "one card for four operations");
  assert.match(markup, />Back up partitions<\/h4>/, "a run in progress has no count to give");
  assert.match(markup, /3 of 5 partitions · about 3 min left/);
  assert.match(markup, /role="progressbar"[^>]*aria-valuenow="30"/);
  assert.match(markup, />63 MB of 210 MB</, "the bar says what it measures");
  assert.match(markup, /Now: d · 75%/);
  assert.match(markup, /aria-label="Cancel d"/);
  assert.match(markup, /aria-label="Details of Back up partitions"/);
  assert.match(markup, /aria-expanded="false"[^>]*>(?:(?!<\/button>).)*>Partitions<\/span>/s, "its items are one tap away, closed, under the unit word: a second count next to '3 of 5' would read as a mistake");
  assert.doesNotMatch(markup, /4 items|4 partitions/, "no count on the toggle");
  assert.doesNotMatch(markup, /<pre|<code|SHA|"partition"/, "no log, no hash, no JSON in the card");
});

test("a job that has no whole to measure against follows the item in flight and makes no promise about the end", () => {
  const job = viewOf([recent("a"), recent("b"), dumping("c", 100 * MB, 50 * MB, MB)]).live[0];
  const markup = html(React.createElement(LiveJobs, { jobs: [job], ctx: baseContext() }));
  assert.match(markup, /2 partitions so far/);
  assert.match(markup, />50%</, "the bar is the partition in flight");
  assert.doesNotMatch(markup, /min left|of \d+ partitions/);
});

test("fifty-eight finished dumps are ONE line of history, closed, with its size, time taken and clock time and nothing technical", () => {
  const markup = feedMarkup(baseContext({ filesOf: () => ({ setId: "set:x", count: 58, bytes: 3.5 * 1024 * MB }) }));
  const history = markup.slice(markup.indexOf('aria-label="History"'));
  assert.equal((history.match(/<details class="dv-row"[^>]*data-job/g) ?? []).length, 1, "one job row");
  assert.doesNotMatch(history.match(/<details class="dv-row"[^>]*data-job[^>]*>/)[0], /\sopen/, "closed");
  assert.match(history, /dv-row__title">Back up 58 partitions</);
  assert.match(history, /3\.5 GB · \d+ s · \d{1,2}:\d{2} [AP]M/);
  assert.doesNotMatch(history, hex64);
  assert.doesNotMatch(history, /file-part\d|"partition"|<pre/);
  assert.match(history, /<details class="dv-day" open="" data-day="2026-10-06">/, "today is open");
  assert.match(history, /Agent ran 2 fastboot commands/, "the two reads are a line of their own");
});

test("opening a finished backup lists its items: a filter and a first page, the rest on request, each row one tap from its details", () => {
  const markup = feedMarkup(baseContext({ filesOf: () => ({ setId: "set:x", count: 58, bytes: 1000 }) }));
  const row = markup.slice(markup.indexOf('<div class="dv-row__body">'));
  assert.match(row, /<label[^>]*>Find an item<\/label>/);
  assert.equal((row.slice(0, row.indexOf("Show all 58")).match(/class="ui-focus-ring dv-item"/g) ?? []).length, 12, "twelve rows, then the rest on request");
  assert.match(row, /Show all 58/);
  assert.match(row, /dv-item__name">part0<\/span>/);
  assert.match(row, /58 files/, "the way to the files it saved");
});

test("a burst of routine commands is one line, closed, whose rows open each command's details", () => {
  const reads = ["product", "serialno", "secure", "unlocked", "current-slot", "slot-count", "version"].map((name) => read(`getvar ${name}`, { result: { summary: `${name} value` } }));
  const markup = html(React.createElement(History, { groups: viewOf(reads).history, ctx: baseContext(), timeZone: "UTC" }));
  assert.match(markup, /Agent ran 7 fastboot commands/);
  assert.match(markup, /7 ok/);
  assert.equal((markup.match(/<button[^>]*aria-label="Details of getvar /g) ?? []).length, 7);
  assert.match(markup, /product value/);
  assert.doesNotMatch(markup, /<details class="dv-row"[^>]*data-burst[^>]*\sopen/);
  const mixed = html(React.createElement(History, { groups: viewOf([read("getvar a"), read("getvar b", { state: "failed", error: "No such variable", result: undefined })]).history, ctx: baseContext(), timeZone: "UTC" }));
  assert.match(mixed, /1 ok · 1 failed|1 ok.*1 failed/);
  assert.match(mixed, /No such variable/);
  const single = html(React.createElement(History, { groups: viewOf([read("getvar product", { result: { summary: "panther" } })]).history, ctx: baseContext(), timeZone: "UTC" }));
  assert.match(single, /Agent ran fastboot getvar product/);
  assert.doesNotMatch(single, /1 ok/, "one command that worked is its icon and its answer, not a tally");
});

test("history is grouped by device when there are several, and by day with only today open", () => {
  const day = (days, name, deviceId = "usb-1") => dumped(name, { request: { target: name, deviceId }, createdAt: NOW - days * 86_400_000, updatedAt: NOW - days * 86_400_000 + 5_000 });
  const view = activityView([
    { deviceId: "usb-1", entries: groupActivity([day(1, "b"), day(0, "a")], { now: NOW }) },
    { deviceId: "usb-2", entries: groupActivity([day(0, "c", "usb-2")], { now: NOW }) },
  ], { now: NOW, acknowledged: new Set(), timeZone: "UTC" });
  const markup = html(React.createElement(History, { groups: view.history, ctx: baseContext({ showDevice: true, deviceLabel: (id) => (id === "usb-1" ? "Lenovo QUSB__BULK" : "Pixel 7"), connected: (id) => id === "usb-1" }), timeZone: "UTC" }));
  assert.match(markup, /<h4[^>]*>Lenovo QUSB__BULK<\/h4>/);
  assert.match(markup, /<h4[^>]*>Pixel 7 \(disconnected\)<\/h4>/);
  assert.match(markup, /<details class="dv-day" open="" data-day="2026-10-06">/);
  assert.match(markup, /<details class="dv-day" data-day="2026-10-05">/, "yesterday is closed but counted");
  assert.match(markup, />Yesterday<\/span><span class="dv-day__count">1 entry/);
  assert.equal((markup.match(/Lenovo QUSB__BULK/g) ?? []).length, 1, "the device is named once, as the heading, not again on every row under it");
  const single = html(React.createElement(History, { groups: viewOf([dumped("a")]).history, ctx: baseContext(), timeZone: "UTC" }));
  assert.doesNotMatch(single, /dv-history__name/, "one device: no device heading");
});

// ---- the detail sheet ------------------------------------------------------------------------------------------------

const detail = (subject, operations, extra = {}) => {
  const entries = groupActivity(operations, { now: NOW });
  const jobs = new Map(entries.filter((entry) => entry.kind === "job").map((job) => [job.id, job]));
  return html(React.createElement(DetailSheet, { subject, jobs, operations, artifacts: [], ctx: baseContext(), onSubject() {}, onClose() {}, ...extra }));
};

test("one operation's detail holds everything raw: its result, what it declared, both numbers, the log and the JSON", () => {
  const lines = Array.from({ length: 5 }, (_, index) => ({ at: NOW, line: `Reading block ${index}`, kind: "log" }));
  const op = dumped("boot_a", {
    output: lines,
    events: [{ sequence: 1, at: NOW, type: "declared", declared: { action: "edl dump", target: "boot_a", backup: "Not applicable: read-only.", details: "Read sectors 34-97." } }],
  });
  const markup = detail({ kind: "job", jobId: op.id }, [op]);
  assert.match(markup, /role="dialog"[^>]*aria-labelledby="([^"]+)"/);
  const id = /aria-labelledby="([^"]+)"/.exec(markup)[1];
  assert.match(markup, new RegExp(`<h3 id="${id.replace(/[$]/g, "\\$")}"[^>]*>Back up boot_a</h3>`));
  assert.doesNotMatch(markup, /aria-label="Back"|aria-label="All \d+ items"/, "one operation on its own has nothing to go back to: one close control, not two");
  assert.match(markup, /aria-label="Close details"/);
  assert.match(markup, /Read boot_a/);
  assert.match(markup, /Verified: Yes/);
  assert.ok(markup.includes("ab".repeat(32)), "the full SHA-256");
  assert.ok(markup.includes("file-boot_a"), "the file id");
  assert.match(markup, /<code>edl dump - boot_a<\/code>/);
  assert.match(markup, /<pre class="dv-log"[^>]*>Reading block 0\nReading block 1/);
  assert.match(markup, /Raw result/);
  assert.match(markup, /&quot;partition&quot;: &quot;boot_a&quot;/);
  assert.match(markup, /aria-label="Copy SHA-256"/);
  assert.doesNotMatch(markup, /<pre[^>]*(max-height|overflow)/, "no scroll box inside the sheet's own scroll");
});

test("a run of operations opens as its items, and an item opens with a way back to all of them", () => {
  const ops = Array.from({ length: 20 }, (_, index) => dumped(`part${index}`));
  const overview = detail({ kind: "job", jobId: ops[0].id }, ops, { ctx: baseContext({ filesOf: () => ({ setId: "set:x", count: 20, bytes: 20 * MB }) }) });
  assert.match(overview, /<h3[^>]*>Back up 20 partitions<\/h3>/);
  assert.match(overview, /20 files/);
  assert.equal((overview.match(/class="ui-focus-ring dv-item"/g) ?? []).length, 12);
  assert.doesNotMatch(overview, /dv-log/, "the log of one item is not the overview");
  const item = detail({ kind: "job", jobId: ops[0].id, operationId: ops[7].id }, ops);
  assert.match(item, /<h3[^>]*>part7<\/h3>/);
  assert.match(item, /aria-label="All 20 items"/);
  assert.match(item, /Read part7/);
});

test("a file's detail names where it came from, which backup it is part of, and the archive and entry the server holds it in; a thing that is gone says so", () => {
  const all = Array.from({ length: 56 }, (_, index) => `part${index}`);
  const provenance = { operationId: "op-9", deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", target: "boot_a", label: "Lenovo QUSB__BULK", scope: { chosen: all.slice(0, 5), all } };
  const artifact = { id: "file-1", name: "edl-1-set-p3-boot_a.bin", size: 64 * MB, mime: "application/octet-stream", sha256: "cd".repeat(32), kind: "output", source: "device", createdAt: NOW, provenance, server: { saveId: "s1", archive: "/srv/backups/lenovo-2026-10-06.zip", entry: "lenovo-2026-10-06/edl-1-set-p3-boot_a.bin", archiveBytes: 20 * MB, originalBytes: 64 * MB, savedAt: NOW, verified: true } };
  const sheet = (artifacts, artifactId = "file-1") => html(React.createElement(DetailSheet, { subject: { kind: "file", artifactId }, jobs: new Map(), operations: [], artifacts, ctx: baseContext(), onSubject() {}, onClose() {} }));
  const markup = sheet([artifact]);
  assert.match(markup, /<h3[^>]*>boot_a<\/h3>/, "the partition, not the file name");
  assert.ok(markup.includes("cd".repeat(32)) && markup.includes("file-1") && markup.includes("edl-1-set-p3-boot_a.bin"));
  assert.match(markup, /Part of<\/dt><dd[^>]*>Lenovo QUSB__BULK · Backup · 5 of 56 partitions<\/dd>/, "the same title the card has");
  assert.match(markup, /On the server<\/dt><dd[^>]*><code>\/srv\/backups\/lenovo-2026-10-06\.zip<\/code> · checked on the server<\/dd>/, "the archive, not a folder");
  assert.match(markup, /Inside the archive<\/dt><dd[^>]*><code>lenovo-2026-10-06\/edl-1-set-p3-boot_a\.bin<\/code><\/dd>/);
  const unsaved = sheet([{ ...artifact, server: undefined }]);
  assert.doesNotMatch(unsaved, /On the server|Inside the archive/);
  assert.match(unsaved, /Part of/);
  assert.doesNotMatch(sheet([{ ...artifact, id: "in-1", kind: "input", source: "picker", provenance: undefined, server: undefined }], "in-1"), /Part of/, "firmware the person added is in no backup");
  const gone = detail({ kind: "job", jobId: "nope" }, []);
  assert.match(gone, /No longer listed/);
  globalThis.document = { documentElement: {} };
  try {
    for (const locale of Object.keys(locales)) {
      setLocale(locale);
      const translated = sheet([artifact]);
      assert.doesNotMatch(translated, /devices\.fact\.|devices\.files\.|\{[a-zA-Z]+\}/, `${locale}: a key shows or a placeholder is unfilled`);
      for (const key of ["devices.fact.backup", "devices.fact.onServer", "devices.fact.inArchive"]) assert.ok(translated.includes(escape(locales[locale][key])), `${locale}: ${key}`);
      assert.ok(translated.includes(escape(locales[locale]["devices.files.scopePartial.other"].replace("{chosen}", "5").replace("{count}", "56"))), `${locale}: the backup's title`);
    }
  } finally {
    setLocale("en");
    delete globalThis.document;
  }
});

// ---- the structure of the whole feed ------------------------------------------------------------------------------------

test("the feed is built from native controls, each named; nothing scrolls inside it and nothing is a bare box with a click", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const markup = feedMarkup();
  const buttons = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.ok(buttons.length > 10);
  for (const [, attributes, inner] of buttons) {
    const name = /aria-label="([^"]+)"/.exec(attributes)?.[1] ?? inner.replace(/<[^>]*>/g, "").trim();
    assert.ok(name.length > 0, `a button has no name: ${attributes}`);
  }
  assert.doesNotMatch(markup, /<(?!button)\w+[^>]*\srole="button"/, "no div pretending to be a button");
  assert.doesNotMatch(markup, /tabindex="[1-9]/, "no positive tab order");
  assert.doesNotMatch(markup, /overflow(-y)?:\s*(auto|scroll)|max-height/, "no scroll box or clipped box in the feed");
  assert.doesNotMatch(markup, /<pre/, "no log in the feed");
  assert.doesNotMatch(markup, hex64, "no hash in the feed");
  for (const [, attributes] of markup.matchAll(/<(?:summary|button|input)\b([^>]*)>/g)) {
    assert.doesNotMatch(attributes, /style="[^"]*(?<!min-)width:\s*[3-9]\d\dpx/, "no fixed width that a narrow panel cannot hold");
  }
});

test("every control that opens something says what it opens and whether it is open", () => {
  const markup = feedMarkup();
  for (const [, attributes] of markup.matchAll(/<button\b([^>]*aria-expanded[^>]*)>/g)) {
    assert.match(attributes, /aria-expanded="(true|false)"/);
    assert.match(attributes, /aria-controls="[^"]+"/);
  }
  assert.match(markup, /<h3[^>]*>Needs you · 2<\/h3>/);
});

// ---- the device card keeps its trust surface --------------------------------------------------------------------------

function trustManager(levels, operations = []) {
  return {
    trustLevel: (deviceId) => levels[deviceId] ?? "none",
    subscribeTrust: () => () => {},
    withdrawTrust: async () => { throw new Error("rendering never forgets"); },
    snapshots: () => operations,
    subscribe: () => () => {},
    cancel() { throw new Error("rendering never cancels"); },
    sendUser() {},
    status() { return undefined; },
  };
}
const device = (over = {}) => ({
  id: "usb-1", kind: "usb", label: "Lenovo Smart Display", vendorId: 0x17ef, productId: 0x7435, serialNumber: "UNIT1", open: false,
  protocolCandidates: [{ protocol: "adb", interfaceNumber: 0, alternateSetting: 0 }],
  ...over,
});
const deviceCard = (level, over = {}, operations = []) => html(React.createElement(DeviceCard, {
  sessionId: "panel-session", manager: trustManager({ "usb-1": level, ...over.levels }, operations), device: device(over.device), activity: undefined, operations,
  selectedInputId: null, input: undefined, onChooseFile() {}, onDisconnect() {},
}));

test("a device card shows how far the device is trusted, with Forget when it can be taken back, and nothing when the agent has not asked", () => {
  const remembered = deviceCard("remembered");
  assert.match(remembered, />Trusted<\/span>/);
  assert.ok(remembered.includes(`title="${escape(locales.en["deviceTrust.chipRememberedHint"])}"`));
  assert.match(remembered, /<button[^>]*aria-label="Forget Lenovo Smart Display[^"]*"[^>]*>(?:(?!<\/button>).)*>Forget<\/span>/s);
  assert.match(deviceCard("session"), />Trusted for now<\/span>/);
  const declined = deviceCard("declined");
  assert.match(declined, />Agent blocked<\/span>/);
  assert.doesNotMatch(declined, />Forget<\/span>/);
  assert.doesNotMatch(deviceCard("none"), /Trusted|Agent blocked|Forget|deviceTrust\./);
  assert.doesNotMatch(deviceCard("remembered", { device: { kind: "ble", protocolCandidates: undefined, services: [] } }), />Trusted<\/span>|Forget/);
});

test("the device card no longer carries the activity: the title chips follow the operations, and the card holds only the device's actions", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  assert.match(deviceCard("none", {}, [waiting()]), />Waiting for your answer<\/span><\/span>/);
  assert.match(deviceCard("none", {}, [counting(Date.now() + 10_000)]), />Starting soon<\/span><\/span>/);
  assert.match(deviceCard("none", {}, [operation({ state: "running", result: undefined })]), />Running<\/span><\/span>/);
  const busy = deviceCard("none", {}, [dumped("a"), dumped("b"), failedDump("c")]);
  assert.doesNotMatch(busy, /aria-label="Activity"|Earlier activity|dv-job|dv-row/);
});

test("the Terminal tab holds the terminal only: no shell grant button stands above it", () => {
  const markup = deviceCard("session");
  const start = markup.search(/id="[^"]*-panel-terminal"/);
  assert.ok(start >= 0, "the device offers a Terminal tab");
  const rest = markup.slice(start + 4);
  const next = rest.search(/id="[^"]*-panel-/);
  const panel = next < 0 ? rest : rest.slice(0, next);
  assert.match(panel, /Start terminal|Start/i);
  assert.doesNotMatch(panel, /aria-pressed|shell access|Allow shell|Revoke/i);
});

// ---- languages ---------------------------------------------------------------------------------------------------------

test("the feed reads in English, Japanese and Chinese with real words: no key left bare, no placeholder unfilled", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  globalThis.document = { documentElement: {} };
  try {
    for (const locale of Object.keys(locales)) {
      setLocale(locale);
      const say = (key, vars = {}) => escape(locales[locale][key].replace(/\{(\w+)\}/g, (_, variable) => String(vars[variable])));
      const names = Array.from({ length: 58 }, (_, index) => `part${index}`);
      const pinned = html(React.createElement(NeedsYou, { items: viewOf([failedDump("vendor_b"), waiting(), counting(NOW + 30_000)]).needsYou, ctx: baseContext() }));
      const live = html(React.createElement(LiveJobs, { jobs: viewOf([recent("a"), recent("b"), dumping("c", 80 * MB, 40 * MB, MB)]).live, ctx: baseContext() }));
      const past = html(React.createElement(History, { groups: viewOf([...names.map((name) => dumped(name)), read("getvar a"), read("getvar b")]).history, ctx: baseContext({ filesOf: () => ({ setId: "x", count: 58, bytes: 1000 }) }), timeZone: "UTC" }));
      const sheet = detail({ kind: "job", jobId: "none" }, []);
      for (const [name, markup] of Object.entries({ pinned, live, past, sheet })) {
        assert.doesNotMatch(markup, /devices\.[a-zA-Z]+\.?[a-zA-Z.]*|deviceTrust\.[a-zA-Z]+/, `${locale}/${name}: a translation key shows`);
        assert.doesNotMatch(markup, /\{[a-zA-Z]+\}/, `${locale}/${name}: a placeholder was not filled`);
      }
      assert.ok(pinned.includes(say("devices.needsYou")), `${locale}: needs you`);
      assert.ok(pinned.includes(say("deviceTrust.countdownTitle", { seconds: 30 })), `${locale}: countdown`);
      assert.ok(pinned.includes(say("devices.problem.gotIt")), `${locale}: got it`);
      assert.ok(pinned.includes(say("devices.attention.waiting.other", { count: 1 })) || pinned.includes(say("devices.attention.waiting.one", { count: 1 })), `${locale}: waiting`);
      assert.ok(live.includes(say("devices.job.dumpSeriesLive")), `${locale}: live title`);
      assert.ok(live.includes(say("devices.jobMeta.partitionsSoFar.other", { count: 2 })), `${locale}: so far`);
      assert.ok(live.includes(say("devices.jobDetails")) && live.includes(say("devices.jobCancel")), `${locale}: card buttons`);
      assert.ok(past.includes(say("devices.job.dumpSeries.other", { count: 58 })), `${locale}: finished title`);
      assert.ok(past.includes(say("devices.day.today")), `${locale}: today`);
      assert.ok(past.includes(say("devices.burstTitle.other", { count: 2, protocol: "fastboot" })), `${locale}: burst`);
      assert.ok(sheet.includes(say("devices.sheet.gone")), `${locale}: sheet`);
    }
  } finally {
    setLocale("en");
    delete globalThis.document;
  }
});
