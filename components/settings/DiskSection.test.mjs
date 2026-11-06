import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { DiskSection } = await jiti.import("./DiskSection.tsx");
const { SEARCH_ENTRIES } = await jiti.import("./panels/SystemPanel.tsx");

const GB = 1024 ** 3;

function area(id, usedGb, totalGb, level, extra = {}) {
  return {
    id, path: `/${id}`, totalBytes: totalGb * GB, availableBytes: (totalGb - usedGb) * GB, usedBytes: usedGb * GB,
    freeFraction: (totalGb - usedGb) / totalGb, level, ...extra,
  };
}

function payload(overrides = {}) {
  return {
    areas: [area("tmp", 120, 150, "ok"), area("data", 195, 200, "critical")],
    settings: { scratchIdleDays: 3, tmpIdleHours: 24, homeTmpIdleHours: 72, budgetPercent: 70, checkpointMaxGb: 5, checkpointMaxAgeDays: 14 },
    lastRun: { trigger: "hourly", startedAt: Date.now() - 7_200_000, finishedAt: Date.now() - 7_199_000, freedBytes: 3 * GB, removedCount: 4, removed: [], errorCount: 0 },
    largestScratch: [
      { title: "Fix the login page", bytes: 5 * GB, lastUsedAt: Date.now() - 3 * 86_400_000, live: false },
      { title: "Unknown chat", bytes: GB, lastUsedAt: Date.now(), live: true },
    ],
    checkpointBytes: 2 * GB,
    running: false,
    canEdit: true,
    ...overrides,
  };
}

const render = (initial) => renderToStaticMarkup(React.createElement(DiskSection, { initial }));

test("shows both disks used against their size, with the warning colour only where it is needed", () => {
  const html = render(payload());
  assert.match(html, /Temp space/);
  assert.match(html, /120 GB used of 150 GB · 80%/);
  assert.match(html, /195 GB used of 200 GB · 98%/);
  assert.match(html, /Almost full\. New chat turns are refused/);
  assert.equal((html.match(/var\(--status-error\)/g) ?? []).length >= 2, true, "the nearly-full disk is drawn in the error colour");
  assert.doesNotMatch(html, /Getting full/);
});

test("lists the largest scratch folders, the undo snapshot total and the last clean in plain words", () => {
  const html = render(payload());
  assert.match(html, /Largest scratch folders/);
  assert.match(html, /Fix the login page/);
  assert.match(html, /5 GB/);
  assert.match(html, /in use/, "a running chat's folder is marked, not given an age");
  assert.match(html, /Undo snapshots/);
  assert.match(html, /Last clean .*freed 3\.0 GB/);
});

test("an administrator gets the clean button and the save button; a member gets neither", () => {
  const admin = render(payload());
  assert.match(admin, /Clean idle scratch now/);
  assert.match(admin, /Save<\/button>/);
  assert.match(admin, /Delete a chat&#x27;s scratch folder after it has been idle for/);

  const member = render(payload({ canEdit: false }));
  assert.doesNotMatch(member, /Clean idle scratch now/);
  assert.doesNotMatch(member, /Save<\/button>/);
  assert.match(member, /Only an administrator can change these/);
  assert.match(member, /disabled=""/, "the numbers can be read but not edited");
});

test("a clean that is already running disables the button, and two areas on one disk show once", () => {
  const running = render(payload({ running: true }));
  assert.match(running, /Cleaning up now/);
  assert.match(running, /<button[^>]*disabled=""[^>]*aria-busy="true"/);

  const shared = render(payload({ areas: [area("tmp", 100, 200, "ok"), area("data", 100, 200, "ok", { sameFilesystemAs: "tmp" })] }));
  assert.match(shared, /Temp space and data \(one shared disk\)/);
  assert.equal((shared.match(/role="progressbar"/g) ?? []).length, 1);
});

test("before the first clean-up it says so instead of inventing numbers", () => {
  const html = render(payload({ lastRun: null, largestScratch: [], checkpointBytes: 0 }));
  assert.match(html, /Cody has not cleaned up since it started/);
  assert.match(html, /None measured yet/);
});

test("the System hub's search finds the card by the id it highlights", () => {
  const entry = SEARCH_ENTRIES.find((item) => item.id === "disk");
  assert.ok(entry);
  assert.equal(entry.tab, "system");
  assert.match(render(payload()), /data-search-id="disk"/);
});
