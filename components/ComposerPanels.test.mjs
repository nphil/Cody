import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ComposerPanels } = await jiti.import("./ComposerPanels.tsx");

const noop = () => {};

test("renders nothing when there are no tasks or subagents", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [],
    onSelectSubagent: noop,
  })), "");
});

test("attaches todo plan and subagent roster with live states", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [{ content: "Wire panels", status: "in_progress" }] }],
    subagents: [
      { id: "s1", agent: "scout", status: "started", task: "Map the surface", index: 0 },
      { id: "s2", agent: "worker", status: "completed", task: "Write the code", index: 1 },
    ],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));

  assert.match(html, /Tasks/);
  assert.match(html, /Wire panels/);
  assert.match(html, /Subagents/);
  assert.match(html, /scout/);
  assert.match(html, /Map the surface/);
  assert.match(html, /worker/);
  assert.match(html, /aria-label="1 running · 2 total"/);
  assert.doesNotMatch(html, />1 running · 2 total</);
});

test("panels sit in a wrapping flex row so they share horizontal space", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [{ content: "Wire panels", status: "in_progress" }] }],
    subagents: [{ id: "s1", agent: "scout", status: "started", task: "Map the surface", index: 0 }],
    onSelectSubagent: noop,
  }));

  assert.match(html, /^<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start;margin-bottom:8px">/);
  // Each panel must be allowed to shrink so an expanded sibling cannot push it off-screen.
  const shrinkable = html.match(/flex:0 1 auto;min-width:0;max-width:100%/g) ?? [];
  assert.equal(shrinkable.length, 2);
});

test("panels start collapsed with live summary in their headers", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [{ content: "Wire panels", status: "in_progress" }] }],
    subagents: [{ id: "s1", agent: "scout", status: "started", task: "Map the surface", index: 0 }],
    onSelectSubagent: noop,
  }));
  // Headers (with live counts) are visible...
  assert.match(html, /Tasks/);
  assert.match(html, /0\/1 complete/);
  assert.match(html, /Subagents/);
  assert.match(html, /aria-label="1 running · 1 total"/);
  assert.doesNotMatch(html, />1 running · 1 total</);
  // ...but both panels start collapsed: toggle headers only, no content.
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Wire panels/);
  assert.doesNotMatch(html, /Map the surface/);
});

test("live chips show current tool, telemetry, and async marker", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Map the surface",
      index: 0,
      detached: true,
      progress: {
        currentTool: "read",
        lastIntent: "Inspect foo.ts",
        tokens: 2200,
        cost: 0.0041,
        contextTokens: 8000,
        contextWindow: 32000,
        resolvedModel: "provider/gpt-x:high",
      },
    }],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));

  assert.match(html, /Map the surface/);
  assert.match(html, /read: Inspect foo\.ts/);
  assert.match(html, /data-subagent-metric="2\.2k tok"/);
  assert.match(html, /data-subagent-metric="8k\/32k ctx"/);
  assert.match(html, /data-subagent-metric="gpt-x"/);
  assert.doesNotMatch(html, />2\.2k tok</);
  assert.doesNotMatch(html, />8k\/32k ctx</);
  assert.match(html, /⤴/);
});

test("retrying chips surface retry state instead of the activity line", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{
      id: "s1",
      agent: "worker",
      status: "started",
      task: "Write the code",
      index: 0,
      progress: { retryState: { attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: "429", startedAtMs: 1 } },
    }],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));
  assert.match(html, /data-subagent-metric="retrying 2\/5"/);
  assert.doesNotMatch(html, />retrying 2\/5</);
});

test("history chips render terminal telemetry without pulsing state", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "completed",
      task: "Map the surface",
      index: 0,
      source: "history",
      progress: { status: "completed", tokens: 999000, cost: 1.23, durationMs: 360000, resolvedModel: "provider/gpt-5.6:medium" },
    }],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));
  assert.match(html, /Map the surface/);
  assert.match(html, /data-subagent-metric="999k tok"/);
  assert.match(html, /data-subagent-metric="6m"/);
  // History chips must not show the pulsing live dot.
  assert.doesNotMatch(html, /live-pulse/);
});

test("chips show agent source, nested count, and async marker", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Map the surface",
      index: 0,
      agentSource: "user",
      detached: true,
      progress: {
        lastIntent: "Inspect foo.ts",
        inflightTaskDetails: { progress: [{ id: "g1", agent: "task" }, { id: "g2", agent: "task" }] },
      },
    }],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));
  assert.match(html, /Inspect foo\.ts/);
  assert.match(html, /data-subagent-metric="user"/);
  assert.match(html, /data-subagent-metric="2 nested"/);
  assert.match(html, /⤴/);
});

test("history chips mark detached async spawns", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Async audit",
      index: 0,
      source: "history",
      detached: true,
    }],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));
  assert.match(html, /⤴/);
});


test("zero context tokens never print a null gauge", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Map the surface",
      index: 0,
      progress: { currentTool: "read", contextTokens: 0, contextWindow: 32000 },
    }],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));
  assert.doesNotMatch(html, /null/);
  assert.match(html, /read/);
});

const roster = (statuses) => statuses.map((status, index) => ({
  id: `s${index + 1}`,
  agent: `agent${index + 1}`,
  status,
  task: `Task ${index + 1}`,
  index,
}));

test("large rosters truncate to seven chips, actives first, behind Show all", () => {
  // 12 mixed agents: actives at positions 2, 5, 8, 11 (s3, s6, s9, s12).
  const subagents = roster([
    "completed", "failed", "started", "completed", "aborted", "started",
    "completed", "completed", "started", "failed", "completed", "started",
  ]);
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents,
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));

  // Header summary reflects the full roster, not the visible chips.
  assert.match(html, /aria-label="4 running · 12 total"/);
  // All four actives are visible and precede every terminal chip.
  for (const active of ["agent3", "agent6", "agent9", "agent12"]) assert.match(html, new RegExp(active));
  // The three remaining slots go to the most recent terminals (s8, s10, s11).
  for (const recent of ["agent8", "agent10", "agent11"]) assert.match(html, new RegExp(recent));
  for (const hidden of ["agent1", "agent2", "agent4", "agent5", "agent7"]) {
    assert.doesNotMatch(html, new RegExp(`${hidden}\\b`));
  }
  assert.ok(html.indexOf("agent12") < html.indexOf("agent8"), "actives render before terminals");
  assert.match(html, /Show all \(12\)/);
  assert.doesNotMatch(html, /Show fewer/);
});

test("rosters at or under the cap render every chip without a toggle", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: roster(["completed", "started", "failed", "started", "completed", "aborted", "started"]),
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));
  for (let index = 1; index <= 7; index += 1) assert.match(html, new RegExp(`agent${index}\\b`));
  assert.doesNotMatch(html, /Show all/);
  // Actives (s2, s4, s7) still sort ahead of terminals.
  assert.ok(html.indexOf("agent7") < html.indexOf("agent1"), "actives render before terminals");
});

test("selectVisibleSubagents orders stably and caps all-terminal rosters", async () => {
  const { selectVisibleSubagents } = await jiti.import("./ComposerPanels.tsx");
  const mixed = roster([
    "completed", "failed", "started", "completed", "aborted", "started",
    "completed", "completed", "started", "failed", "completed", "started",
  ]);
  // Expanded: full roster, actives first, both groups keep incoming order.
  assert.deepEqual(
    selectVisibleSubagents(mixed, true).map((subagent) => subagent.id),
    ["s3", "s6", "s9", "s12", "s1", "s2", "s4", "s5", "s7", "s8", "s10", "s11"],
  );
  // Collapsed: actives claim slots, most recent terminals fill the rest.
  assert.deepEqual(
    selectVisibleSubagents(mixed, false).map((subagent) => subagent.id),
    ["s3", "s6", "s9", "s12", "s8", "s10", "s11"],
  );
  // All-terminal rosters keep the same seven-chip cap: the most recent seven.
  const settled = roster(Array.from({ length: 10 }, () => "completed"));
  assert.deepEqual(
    selectVisibleSubagents(settled, false).map((subagent) => subagent.id),
    ["s4", "s5", "s6", "s7", "s8", "s9", "s10"],
  );
  // More actives than slots: the first seven actives win.
  const busy = roster(Array.from({ length: 9 }, () => "started"));
  assert.deepEqual(
    selectVisibleSubagents(busy, false).map((subagent) => subagent.id),
    ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
  );
});

