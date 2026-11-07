import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { HelperMemoryView } = await jiti.import("./HelperMemoryCard.tsx");
const memory = await jiti.import("./helper-memory.ts");

const TODAY = { task: "20%", scout: "20%", reviewer: "20%", "security-reviewer": "20%", sonic: "20%", luna: "20%", "heavy-task": "20%", "deep-task": "30%" };

function render(overrides, notesOn = false) {
  return renderToStaticMarkup(React.createElement(HelperMemoryView, { overrides, notesOn, onOverrides() {}, onNotes() {} }));
}

/** The text of the radio that is selected. */
const selectedMode = (html) => html.match(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*>([^<]*)<\/button>/)?.[1];

test("today's config reads as 20% of the window, with deep-task's 30% under Advanced", () => {
  const html = render(TODAY);
  assert.equal(selectedMode(html), "% of the model&#x27;s window");
  assert.match(html, /Helper agents&#x27; memory limit/);
  assert.match(html, /<details>/, "Advanced is collapsed");
  assert.doesNotMatch(html, /<details open/);
  for (const agent of memory.HELPER_AGENTS) assert.match(html, new RegExp(`aria-label="Limit for ${agent}"`));
  assert.match(html, /aria-label="Limit size"[^>]*>[^<]*(?:<[^>]*>)*[^<]*20%/, "the shared size shows");
  assert.match(html, /30%/, "deep-task shows its own value");
  assert.equal((html.match(/Same as above/g) ?? []).length, 7, "the seven others follow the shared limit");
  assert.match(html, /Applies to all chats, not only helpers\./);
  assert.match(html, /Notes that survive a summary \(off\)/);
});

test("fixed tokens and 'same as my chats' read back faithfully, and the notes switch shows its state", () => {
  const tokens = render({ task: 200000, scout: 200000, sonic: 200000 }, true);
  assert.equal(selectedMode(tokens), "Fixed tokens");
  assert.match(tokens, /200k tokens/);
  assert.match(tokens, /Notes that survive a summary \(on\)/);
  assert.match(tokens, /aria-checked="true"[^>]*aria-label="Notes that survive a summary"|aria-label="Notes that survive a summary"[^>]*aria-checked="true"/);

  const inherit = render({});
  assert.equal(selectedMode(inherit), "Same as my chats");
  assert.doesNotMatch(inherit, /aria-label="Limit size"/, "no size to pick when helpers follow the chats");

  // Only deep-task has a value: the shared choice is still "same as my chats".
  assert.equal(selectedMode(render({ "deep-task": "30%" })), "Same as my chats");
});

test("reading: the shared limit is the one most ordinary helpers have, an agent apart from it shows its own, a missing one follows the chats", () => {
  const state = memory.readHelperState({ ...TODAY, scout: 150000, luna: null, "future-agent": "5%" });
  assert.deepEqual(state.shared, { mode: "percent", value: 20 });
  assert.deepEqual(state.agents.scout, { mode: "tokens", value: 150000 });
  assert.deepEqual(state.agents["deep-task"], { mode: "percent", value: 30 });
  assert.equal(state.agents.luna, "inherit");
  assert.equal(state.agents.task, "same");
  assert.equal(memory.readHelperState({}).mode, "inherit");
});

test("writing the shared limit sets every known helper, keeps deep-task's own value and every unknown entry", () => {
  const before = { ...TODAY, "future-agent": "5%", other: 70000, nulled: null };
  const after = memory.withSharedLimit(before, { mode: "percent", value: 15 });
  assert.deepEqual(after, { ...before, task: "15%", scout: "15%", reviewer: "15%", "security-reviewer": "15%", sonic: "15%", luna: "15%", "heavy-task": "15%" });
  assert.equal(after["deep-task"], "30%");
  assert.equal(before.task, "20%", "the map it was given is not changed");

  const tokens = memory.withSharedLimit(before, { mode: "tokens", value: 200000 });
  assert.equal(tokens.task, 200000);
  assert.equal(tokens["deep-task"], "30%");
  assert.equal(tokens["future-agent"], "5%");

  // Setting an agent that has no entry yet fills it in as well.
  assert.equal(memory.withSharedLimit({ "future-agent": "5%" }, { mode: "percent", value: 25 }).luna, "25%");
});

test("'Same as my chats' removes the known helpers' entries, keeping a deep-task value set in Advanced and unknown agents", () => {
  const after = memory.withSharedLimit({ ...TODAY, "future-agent": "5%" }, null);
  assert.deepEqual(after, { "deep-task": "30%", "future-agent": "5%" });
  assert.deepEqual(memory.withSharedLimit({ ...TODAY, "deep-task": "20%" }, null), {}, "deep-task that followed the shared value goes too");
});

test("writing one helper's own value touches only that helper, and 'same as above' puts it back on the shared limit", () => {
  const own = memory.withAgentLimit(TODAY, "scout", { mode: "tokens", value: 100000 });
  assert.deepEqual(own, { ...TODAY, scout: 100000 });
  assert.equal(memory.readHelperState(own).shared.value, 20, "one helper apart does not move the shared limit");
  assert.deepEqual(memory.withAgentLimit(own, "scout", "same"), TODAY);
  assert.deepEqual(memory.withAgentLimit(TODAY, "luna", "inherit").luna, undefined);
  // The shared limit then changes: the helper with its own value keeps it.
  assert.equal(memory.withSharedLimit(own, { mode: "percent", value: 40 }).scout, 100000);
  assert.deepEqual(memory.withAgentLimit({}, "deep-task", "same"), {});
});

test("the card's choices and the search entry", async () => {
  assert.deepEqual(memory.PERCENT_CHOICES, [10, 15, 20, 25, 30, 40, 50]);
  assert.deepEqual(memory.TOKEN_CHOICES, [100000, 150000, 200000, 300000]);
  assert.deepEqual(memory.limitChoices("percent", 12.5), [10, 12.5, 15, 20, 25, 30, 40, 50], "a hand-edited value stays selectable");
  assert.equal(memory.parseOverride("0%"), null);
  assert.equal(memory.parseOverride("101%"), null);
  assert.equal(memory.parseOverride(1.5), null);
  assert.deepEqual(memory.parseChoiceId(memory.choiceId({ mode: "tokens", value: 300000 })), { mode: "tokens", value: 300000 });

  const { SEARCH_ENTRIES } = await jiti.import("./recommended-cards.ts");
  const entry = SEARCH_ENTRIES.find((candidate) => candidate.id === memory.HELPER_MEMORY_SEARCH_ID);
  assert.equal(entry.label, "Helper agents' memory limit");
  assert.equal(entry.needsCapability, "configEditor");
  assert.equal(entry.tab, "engine");
  assert.match(renderToStaticMarkup(React.createElement(HelperMemoryView, { overrides: {}, notesOn: false, onOverrides() {}, onNotes() {} })), new RegExp(`data-search-id="${memory.HELPER_MEMORY_SEARCH_ID}"`));
});
