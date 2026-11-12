import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TodoList } = await jiti.import("./TodoList.tsx");

test("renders live todo phases, task states, and blockers", () => {
  const html = renderToStaticMarkup(React.createElement(TodoList, {
    phases: [{
      id: "phase-1",
      name: "Implementation",
      tasks: [
        { id: "task-1", content: "Trace todo state", status: "completed" },
        { id: "task-2", content: "Render task list", status: "in_progress" },
        { id: "task-3", content: "Verify in browser", status: "blocked", blocker: "Server unavailable" },
      ],
    }],
  }));

  assert.match(html, /Implementation/);
  assert.match(html, /Trace todo state/);
  assert.match(html, /Render task list/);
  assert.match(html, /Verify in browser/);
  assert.match(html, /Blocked: Server unavailable/);
  assert.match(html, /1\/3 complete/);
});

test("renders nothing when no todo list exists", () => {
  assert.equal(renderToStaticMarkup(React.createElement(TodoList, { phases: [] })), "");
  assert.equal(renderToStaticMarkup(React.createElement(TodoList)), "");
});

test("counts only completed tasks and never hides one that is still to do", () => {
  const html = renderToStaticMarkup(React.createElement(TodoList, {
    phases: [{
      name: "Tasks",
      tasks: [
        { content: "One", status: "completed" },
        { content: "Two", status: "abandoned" },
        { content: "Three", status: "pending" },
        { content: "Four", status: "pending" },
        { content: "Five", status: "pending" },
        { content: "Six", status: "pending" },
      ],
    }],
  }));

  assert.match(html, /1\/6 complete/);
  assert.match(html, />Six</, "the whole plan is there, with no preview to expand first");
  assert.doesNotMatch(html, /<button/, "and nothing to press to see it");
});

/** The opening tag of every phase, in order. */
function phaseTags(html) {
  return [...html.matchAll(/<details[^>]*data-testid="todo-phase"[^>]*>/g)].map((match) => match[0]);
}

const done = (prefix, count) => Array.from({ length: count }, (_, index) => ({ content: `${prefix} ${index + 1}`, status: "completed" }));

test("each phase is a heading with its own count: a finished one is a closed line, the current one is open", () => {
  const html = renderToStaticMarkup(React.createElement(TodoList, {
    phases: [
      { name: "Build", tasks: done("Built", 4) },
      { name: "Check", tasks: [{ content: "Run the checks", status: "in_progress" }, { content: "Write it up", status: "pending" }] },
    ],
  }));

  const tags = phaseTags(html);
  assert.equal(tags.length, 2);
  assert.doesNotMatch(tags[0], /\sopen=/, "the finished phase is one line");
  assert.match(tags[1], /\sopen=/, "the phase being worked on is open");
  assert.match(html, />Build<\/span>.*?>4\/4<\/span><\/summary>/s);
  assert.match(html, />Check<\/span>.*?>0\/2<\/span><\/summary>/s);
  assert.match(html, /4\/6 complete/);
  assert.match(html, />Built 3</, "a closed phase still holds its tasks for whoever opens it");
});

test("the task being worked on is the one marked as the current step", () => {
  const html = renderToStaticMarkup(React.createElement(TodoList, {
    phases: [{ name: "Check", tasks: [{ content: "Done", status: "completed" }, { content: "Run the checks", status: "in_progress" }, { content: "Write it up", status: "pending" }] }],
  }));

  const current = [...html.matchAll(/<div[^>]*aria-current="step"[^>]*>/g)].map((match) => match[0]);
  assert.equal(current.length, 1);
  assert.match(current[0], /aria-label="In progress: Run the checks"/);
  assert.match(current[0], /border-accent/, "set apart by the accent, not by a new colour");
  assert.match(current[0], /font-medium/);
});

test("a long run of finished tasks folds behind one finished line, with every task still inside it", () => {
  const phases = [{ name: "Build", tasks: [...done("Built", 9), { content: "Wire it", status: "in_progress" }, { content: "Ship it", status: "pending" }] }];
  const bare = renderToStaticMarkup(React.createElement(TodoList, { phases }));
  const folds = [...bare.matchAll(/<details data-testid="todo-fold".*?<\/details>/gs)].map((match) => match[0]);
  assert.equal(folds.length, 1);
  assert.match(folds[0], /8 finished tasks/, "until the keeper has written a line, the fold says what it is");
  for (let index = 1; index <= 8; index += 1) assert.match(folds[0], new RegExp(`>Built ${index}<`), "the tasks themselves are kept, not replaced");
  assert.doesNotMatch(folds[0], /Built 9|Wire it|Ship it/, "nothing outside the run, and never a task still to do");
  assert.match(bare, />Built 9<.*>Wire it<.*>Ship it</s, "the rest of the phase follows in its own order");
  assert.match(bare, /9\/11 complete/, "a fold never changes the count");

  const summarised = renderToStaticMarkup(React.createElement(TodoList, {
    phases,
    overlay: { subtasks: {}, autoCompleted: [], labels: {}, folds: { "Build\u0000Built 1": { summary: "Built the first eight parts", count: 8 } }, updatedAt: 1 },
  }));
  assert.match(summarised, /Built the first eight parts.*8 tasks/s);
  assert.doesNotMatch(summarised, /8 finished tasks/);
  assert.doesNotMatch(summarised, /planKeeper\./, "no raw translation keys leak into markup");
});

test("a short label stands in for a long task, whose own words are the tooltip and one tap away", () => {
  const long = "Rework the settings page so that every toggle saves on its own and shows a spinner";
  const html = renderToStaticMarkup(React.createElement(TodoList, {
    phases: [{ name: "Build", tasks: [{ content: long, status: "in_progress" }] }],
    overlay: { subtasks: {}, autoCompleted: [], labels: { [long]: "Rework the settings page" }, folds: {}, updatedAt: 1 },
  }));

  assert.match(html, />Rework the settings page</);
  assert.match(html, new RegExp(`<summary title="${long}"`));
  assert.match(html, new RegExp(`data-testid="todo-original"[^>]*>${long}<`));
  assert.match(html, new RegExp(`aria-label="In progress: ${long}"`), "a screen reader hears the task itself");

  const plain = renderToStaticMarkup(React.createElement(TodoList, { phases: [{ name: "Build", tasks: [{ content: long, status: "in_progress" }] }] }));
  assert.doesNotMatch(plain, /todo-original/, "without a label the task simply shows its own words");
});

test("collapsible mode collapses to a toggle header and expands again", () => {
  const phases = [{ name: "Tasks", tasks: [{ content: "Wire panels", status: "in_progress" }] }];
  const collapsedHtml = renderToStaticMarkup(React.createElement(TodoList, {
    phases,
    collapsible: true,
    defaultExpanded: false,
  }));
  assert.match(collapsedHtml, /aria-expanded="false"/);
  assert.doesNotMatch(collapsedHtml, /Wire panels/);
  const expandedHtml = renderToStaticMarkup(React.createElement(TodoList, {
    phases,
    collapsible: true,
    defaultExpanded: true,
  }));
  assert.match(expandedHtml, /aria-expanded="true"/);
  assert.match(expandedHtml, /Wire panels/);
});
