process.env.TZ = "UTC";
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import puppeteer from "puppeteer-core";
import { createJiti } from "jiti";

/**
 * The Devices panel at the widths it really has (a 300 px panel, a 320 px phone, the 360 px sidebar, 480 px): the server-rendered markup of
 * the activity and the files (a named partial backup the server holds, in the mode where its files are checkboxes, the
 * question before two backups are combined, and a 56-partition list to choose from), laid out by a real browser with the
 * app's own stylesheet. Nothing may scroll sideways and every control must be a full-size target, with every disclosure
 * open. Skipped where there is no Chromium.
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { NeedsYou, LiveJobs } = await jiti.import("./devices/ActivityFeed.tsx");
const { HistoryJobRow } = await jiti.import("./devices/JobCard.tsx");
const { ArtifactPanel } = await jiti.import("./devices/ArtifactPanel.tsx");
const { SetCard, CombineConfirm } = await jiti.import("./devices/ArtifactSetCard.tsx");
const { EdlBackupSets } = await jiti.import("./devices/EdlWorkflow.tsx");
const { groupActivity, activityView } = await jiti.import("../lib/devices/activity-groups.ts");
const { groupArtifactSets } = await jiti.import("../lib/devices/artifact-sets.ts");

const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
let counter = 0;
function operation(over = {}) {
  counter += 1;
  const { request, ...rest } = over;
  const createdAt = over.createdAt ?? NOW - 400_000 + counter * 1_000;
  return { id: `op-${counter}`, sessionId: "s", origin: "agent", state: "succeeded", createdAt, updatedAt: createdAt + 800, output: [], events: [], result: { summary: "ok" }, request: { protocol: "edl", action: "dump", deviceId: "usb-1", target: `partition_with_a_rather_long_name_${counter}`, ...request }, ...rest };
}
const dumped = (index) => operation({ request: { target: `vendor_boot_${index}` }, progress: { phase: "read", completed: 8 * MB, total: 8 * MB, at: NOW } });
const context = { manager: { cancel() {} }, now: NOW, locale: "en", showDevice: true, deviceLabel: () => "Lenovo QUSB__BULK (a long device name)", connected: () => true, planFor: () => undefined, filesOf: () => ({ setId: "set:x", count: 58, bytes: 3.5 * 1024 * MB }), openDetails() {}, showFiles() {}, acknowledge() {} };

function markup() {
  const finished = Array.from({ length: 58 }, (_, index) => dumped(index));
  const broken = [...finished.slice(0, 20), operation({ request: { target: "vendor_b" }, state: "failed", error: "The device stopped answering: a read timed out after ten seconds, so nothing was saved from this partition.", result: undefined })];
  const pinned = activityView([{ deviceId: "usb-1", entries: groupActivity([...broken, operation({ state: "awaiting-trust", result: undefined })], { now: NOW }) }], { now: NOW, acknowledged: new Set() }).needsYou;
  const running = [dumped(100), dumped(101), { ...operation({ request: { target: "system_a" }, state: "running", result: undefined, createdAt: NOW - 20_000, updatedAt: NOW }), progress: { phase: "read", completed: 40 * MB, total: 800 * MB, at: NOW, message: "Reading" }, events: [] }];
  const live = activityView([{ deviceId: "usb-1", entries: groupActivity(running, { now: NOW }) }], { now: NOW, acknowledged: new Set() }).live;
  const job = groupActivity(finished, { now: NOW + 60_000 }).find((entry) => entry.kind === "job");
  const artifacts = [
    ...finished.map((op, index) => ({ id: `file-${index}`, name: `edl-3989044886-vendor_boot_${index}.bin`, size: 8 * MB, mime: "x", sha256: "ab".repeat(32), kind: "output", source: "device", createdAt: NOW + index, provenance: { operationId: op.id, deviceId: "usb-1", protocol: "edl", action: "dump", target: `vendor_boot_${index}`, label: "Lenovo QUSB__BULK (a long device name)" } })),
    { id: "in-1", name: "prog_emmc_firehose_8953_ddr_with_a_long_name.mbn", size: 1_258_291, mime: "x", sha256: "ee".repeat(32), kind: "input", source: "picker", createdAt: NOW },
  ];
  const set = groupArtifactSets(artifacts)[0];
  const names = finished.map((op, index) => `vendor_boot_${index}`);
  const saved = artifacts.map((artifact) => (artifact.kind === "input" ? artifact : {
    ...artifact,
    provenance: { ...artifact.provenance, set: "tablet-2026-10-07-before-the-update", scope: { chosen: names.slice(0, 5), all: names } },
    server: { saveId: "s", archive: "/srv/cody-device-artifacts/Lenovo-QUSB__BULK-a-long-device-name-tablet-2026-10-07-before-the-update.zip", entry: "tablet/vendor_boot_0.bin", archiveBytes: 610 * MB, originalBytes: 3.8 * 1024 * MB, savedAt: NOW, verified: true },
  }));
  const partitionTable = { id: "gpt", state: "succeeded", request: { protocol: "edl", action: "exec", command: "printgpt", deviceId: "usb-1" }, result: { summary: "ok", details: { partitions: Array.from({ length: 56 }, (_, index) => ({ index: index + 1, name: `partition_with_a_rather_long_name_${index}`, bytes: (index + 1) * 8 * MB })) } } };
  return renderToStaticMarkup(React.createElement("div", null,
    React.createElement(NeedsYou, { items: pinned, ctx: context }),
    React.createElement(LiveJobs, { jobs: live, ctx: context }),
    React.createElement(HistoryJobRow, { job, ctx: { ...context, now: NOW + 60_000 }, defaultOpen: true }),
    React.createElement(ArtifactPanel, {
      sessionId: "s", library: { artifacts, sets: groupArtifactSets(artifacts), inputs: artifacts.filter((a) => a.kind === "input"), transfers: [], error: null },
      selectedInputId: null, onSelectInput() {}, deviceLabel: () => "L", verifiedBy: () => true, busySetIds: new Set(), onDetails() {}, reveal: { setId: set.id, token: 1 }, acknowledged: new Set(), acknowledge() {},
    }),
    React.createElement(SetCard, {
      sessionId: "s", set: groupArtifactSets(saved)[0], older: set, artifacts: saved, transfers: [], deviceName: "L", busy: false, selectedInputId: null, onSelectInput() {}, onDetails() {}, verifiedBy: () => true,
      acknowledged: new Set(), acknowledge() {}, locale: "en", defaultSelecting: true, defaultSelected: saved.slice(0, 3).map((artifact) => artifact.id),
    }),
    React.createElement(CombineConfirm, { files: 3, older: set, olderTitle: "L · Backup set", locale: "en", locked: false, onConfirm() {}, onKeep() {} }),
    React.createElement(EdlBackupSets, { manager: { startUser() {} }, sessionId: "s-edl", deviceId: "usb-1", operations: [partitionTable], input: undefined, onChooseFile() {}, defaultPicked: names.slice(0, 5).map((_, index) => `partition_with_a_rather_long_name_${index}`) }),
  ));
}

test("at 300, 320, 360 and 480 px nothing scrolls sideways, nothing sticks out of the panel, and every control is a full-size target", { timeout: 120_000 }, async (t) => {
  const executablePath = process.env.CODY_CHROMIUM_BIN || (process.platform === "linux" ? "/usr/bin/chromium" : undefined);
  if (!executablePath || !existsSync(executablePath)) {
    t.skip("requires Chromium: set CODY_CHROMIUM_BIN or install /usr/bin/chromium");
    return;
  }
  const stylesheet = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const body = markup();
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  try {
    for (const width of [300, 320, 360, 480]) {
      const page = await browser.newPage();
      await page.setViewport({ width: width + 16, height: 900 });
      const screen = `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>${stylesheet}\n.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style></head><body style="margin:0;background:var(--bg);color:var(--text);font:13px system-ui,sans-serif"><div id="panel" style="box-sizing:border-box;width:${width}px;padding:12px;display:flex;flex-direction:column;gap:14px">${body}</div></body></html>`;
      await page.setContent(screen, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.querySelectorAll("details").forEach((element) => { element.open = true; }));
      const report = await page.evaluate(() => {
        const panel = document.getElementById("panel");
        const edge = panel.getBoundingClientRect().right + 0.5;
        const sticking = [];
        const small = [];
        for (const element of panel.querySelectorAll("*")) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          if (element.closest("[popover]") || element.closest(".sr-only")) continue;
          if (box.right > edge) sticking.push(`${element.tagName.toLowerCase()}.${String(element.className).slice(0, 30)} ends ${Math.round(box.right - edge)}px past the panel`);
          if (element.matches("button, summary, input:not([type=hidden]):not([hidden])") && box.height < 43.5) small.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)}" is ${Math.round(box.height)}px tall`);
        }
        return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, sticking: sticking.slice(0, 5), small: small.slice(0, 5) };
      });
      assert.ok(report.scrollWidth <= report.innerWidth, `${width}px: the page scrolls sideways (${report.scrollWidth} > ${report.innerWidth})`);
      assert.deepEqual(report.sticking, [], `${width}px: something sticks out of the panel`);
      assert.deepEqual(report.small, [], `${width}px: a control is smaller than 44px`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
