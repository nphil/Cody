import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The plan keeper's server half:
 *
 *  - evidence: a task is checked off only when the model points at a log
 *    entry that really says so (by id or by a reworded task text), and a task
 *    with its own acceptance bar only when that entry shows the bar met;
 *  - real state: the check-off goes into the engine's list, is put back when
 *    the engine loses it, never overrides the agent reopening a task, and
 *    never erases what the agent changed meanwhile;
 *  - cadence: debounce, one model call at a time, at most one per interval
 *    however long the turn runs;
 *  - reading: which finished tasks fold behind a summary, which phases close
 *    to one line, and that no task is ever hidden for good or un-completed.
 *
 * The organizing rule throughout is FAIL SOFT: a run that finds nothing, a
 * check-off that cannot be proven, or every model attempt failing must all
 * leave the todo list and overlay untouched rather than guess.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-plan-keeper-"));
// Before the first import: these modules resolve the instance data dir at
// call time, but a module that touched it at load time would write into the
// operator's live appdata (see the checkpoint trap in AGENTS.md).
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OMP_PROFILE = "";
process.env.PI_PROFILE = "";
delete process.env.CODY_HARNESS;
process.on("exit", () => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const configModule = await jiti.import("./plan-keeper/config.ts");
const overlayModule = await jiti.import("./plan-keeper/overlay.ts");
const promptsModule = await jiti.import("./plan-keeper/prompts.ts");
const evidenceModule = await jiti.import("./plan-keeper/evidence.ts");
const foldModule = await jiti.import("./plan-keeper/fold.ts");
const keeperModule = await jiti.import("./plan-keeper/keeper.ts");
const modelRoles = await jiti.import("./omp/model-roles.ts");

const PHASE = "Ship the feature";
const key = (content, phase = PHASE) => foldModule.planTaskKey(phase, content);

let sessionCounter = 0;
function nextSessionId() {
  sessionCounter += 1;
  return `plan-keeper-test-${sessionCounter}`;
}

/** A phase list with one in_progress task and one pending task — the shape
 * most tests start from. */
function openPhases() {
  return [
    {
      name: PHASE,
      tasks: [
        { content: "Write the handler", status: "in_progress" },
        { content: "Wire up the route", status: "pending" },
      ],
    },
  ];
}

/** `count` tasks named "<prefix> 1".."<prefix> count" with one status. */
function tasksOf(prefix, count, status) {
  return Array.from({ length: count }, (_, index) => ({ content: `${prefix} ${index + 1}`, status }));
}

/** A stand-in for the engine's in-memory list: getTodoPhases answers what it
 * holds now, setTodoPhases replaces it (and is recorded), and `engine.set`
 * is the engine changing it on its own — the agent's `todo` call, or a
 * rebuild from the session file that drops what the keeper wrote. */
function fakeHooks(initialPhases) {
  let phases = initialPhases;
  const setCalls = [];
  const emitted = [];
  const hooks = {
    sessionId: nextSessionId(),
    getTodoPhases: async () => phases,
    setTodoPhases: async (next) => {
      phases = next;
      setCalls.push(next);
    },
    emit: (frame) => emitted.push(frame),
  };
  const engine = {
    get: () => phases,
    set: (next) => {
      phases = next;
    },
  };
  return { hooks, setCalls, emitted, engine };
}

/** Records what it was asked to run and answers from a script, one entry per
 * call — same shape as lib/distill.test.mjs's fakeAttempt. */
function fakeRunner(script) {
  const calls = [];
  const prompts = [];
  const runner = async (input) => {
    calls.push(input.model);
    prompts.push(input.prompt);
    const step = script[calls.length - 1] ?? { error: "no more scripted answers" };
    return { text: step.text ?? null, error: step.error ?? null };
  };
  return { runner, calls, prompts };
}

/** A runner whose call hangs until release() is invoked — for exercising the
 * "never concurrent" coalesce path deterministically. */
function gatedRunner(finalText) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const runner = async (input) => {
    calls.push(input.model);
    await gate;
    return { text: finalText, error: null };
  };
  return { runner, calls, release: () => release() };
}

/** Fully drains the microtask queue (setImmediate runs after every pending
 * Promise callback in Node), so an async chain with no real timers/I/O in it
 * settles up to its next genuine suspension point before an assertion. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Deterministic virtual clock: `schedule` records {fn, dueAt} instead of
 * using a real timer; `advanceBy` moves the clock, `fireDue` awaits every
 * entry currently due (in due order), including ones a fired entry itself
 * reschedules. Same injection shape as
 * lib/message-update-coalescer.test.mjs's manualScheduler, extended with a
 * mutable `now` for the model-interval rule. */
function manualClock() {
  let now = 0;
  const scheduled = [];
  let nextId = 1;
  return {
    now: () => now,
    schedule(fn, ms) {
      const id = nextId += 1;
      scheduled.push({ id, fn, dueAt: now + ms });
      return () => {
        const index = scheduled.findIndex((entry) => entry.id === id);
        if (index !== -1) scheduled.splice(index, 1);
      };
    },
    advanceBy(ms) {
      now += ms;
    },
    async fireDue() {
      for (;;) {
        const index = scheduled.findIndex((entry) => entry.dueAt <= now);
        if (index === -1) return;
        const [entry] = scheduled.splice(index, 1);
        await entry.fn();
      }
    },
    /** Move forward `ms` and run everything that comes due on the way. */
    async run(ms) {
      now += ms;
      await this.fireDue();
    },
    pendingCount: () => scheduled.length,
  };
}

let toolCallCounter = 0;
/** One finished tool call as the engine reports it: the args only on the
 * start frame, the result only on the end frame. */
function tool(keeper, toolName, args, result, isError = false) {
  toolCallCounter += 1;
  const toolCallId = `call-${toolCallCounter}`;
  keeper.notifyToolExecutionStart({ type: "tool_execution_start", toolCallId, toolName, args });
  keeper.notifyToolExecutionEnd({
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result: typeof result === "string" ? { content: [{ type: "text", text: result }] } : result,
    isError,
  });
}

/** The agent's own `todo` call: its result carries the whole list as the
 * call left it. */
function agentTodo(keeper, args, phases) {
  tool(keeper, "todo", args, { content: [{ type: "text", text: "Updated the list." }], details: { op: args.op, phases, storage: "session" } });
}

function newKeeper(phases, script, options = {}) {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const fake = fakeHooks(phases);
  const scripted = fakeRunner(script);
  const keeper = new keeperModule.PlanKeeper(fake.hooks, { runner: options.runner ?? scripted.runner, clock });
  return { keeper, clock, ...fake, ...scripted };
}

const answer = (value) => JSON.stringify(value);
const NOOP_ANSWER = '{"done":[]}';

/* -------------------------------------------------------------- config -- */

test("no config file means enabled by default", () => {
  fs.rmSync(configModule.getPlanKeeperConfigPath(), { force: true });
  assert.deepEqual(configModule.readPlanKeeperConfig(), { enabled: true });
});

test("a written config survives a reread, and a corrupt file reads as the default", () => {
  configModule.writePlanKeeperConfig({ enabled: false });
  assert.deepEqual(configModule.readPlanKeeperConfig(), { enabled: false });

  fs.writeFileSync(configModule.getPlanKeeperConfigPath(), "{not json", "utf8");
  assert.deepEqual(configModule.readPlanKeeperConfig(), { enabled: true });

  configModule.writePlanKeeperConfig({ enabled: true });
});

/* ------------------------------------------------------------- overlay -- */

test("a saved overlay comes back for its own session id and no other", () => {
  const id = nextSessionId();
  const overlay = {
    subtasks: { "Task A": [{ content: "step one", status: "pending" }] },
    autoCompleted: [key("Task Z")],
    labels: { "Task A": "A" },
    folds: { [key("Task Z")]: { summary: "Did the early work", count: 3 } },
    updatedAt: 42,
  };
  overlayModule.writePlanOverlay(id, overlay);
  assert.deepEqual(overlayModule.readPlanOverlay(id), overlay);
  assert.equal(overlayModule.readPlanOverlay(nextSessionId()), null);
});

test("an overlay written before labels and summaries existed reads with none", () => {
  const id = nextSessionId();
  const file = path.join(configModule.getPlanKeeperOverlayDir(), `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ subtasks: {}, autoCompleted: ["Task A"], updatedAt: 7 }), "utf8");
  assert.deepEqual(overlayModule.readPlanOverlay(id), { subtasks: {}, autoCompleted: ["Task A"], labels: {}, folds: {}, updatedAt: 7 });
});

test("a session id that is not a plain id is never turned into a path", () => {
  overlayModule.writePlanOverlay("../../etc/passwd", overlayModule.emptyPlanOverlay());
  assert.equal(fs.existsSync(path.join(configModule.getPlanKeeperOverlayDir(), "..", "..", "etc", "passwd.json")), false);
  assert.equal(overlayModule.readPlanOverlay("../../etc/passwd"), null);
});

test("a corrupt overlay file reads as none, not a throw", () => {
  const id = nextSessionId();
  const file = path.join(configModule.getPlanKeeperOverlayDir(), `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not json at all", "utf8");
  assert.equal(overlayModule.readPlanOverlay(id), null);
});

test("pruning drops everything the overlay holds about tasks no longer in the phases", () => {
  const overlay = {
    subtasks: { "Task A": [{ content: "step", status: "pending" }], "Task B (gone)": [{ content: "x", status: "pending" }] },
    autoCompleted: [key("Task A", "P"), key("Task A", "Other phase"), key("Task C (gone)", "P"), "Task A"],
    labels: { "Task A": "A", "Task B (gone)": "B" },
    folds: { [key("Task A", "P")]: { summary: "kept", count: 3 }, [key("Task C (gone)", "P")]: { summary: "dropped", count: 3 } },
    updatedAt: 5,
  };
  const pruned = overlayModule.prunePlanOverlay(overlay, [{ name: "P", tasks: [{ content: "Task A", status: "completed" }] }]);
  assert.deepEqual(pruned, {
    subtasks: { "Task A": overlay.subtasks["Task A"] },
    autoCompleted: [key("Task A", "P"), "Task A"],
    labels: { "Task A": "A" },
    folds: { [key("Task A", "P")]: { summary: "kept", count: 3 } },
    updatedAt: 5,
  });
});

/* ------------------------------------------------------------- prompts -- */

test("a plain JSON answer parses", () => {
  assert.deepEqual(promptsModule.parsePlanKeeperAnswer(NOOP_ANSWER), { done: [], subtasks: {}, subtasksDone: [], labels: {}, summaries: {} });
});

test("a fenced, prose-wrapped answer still parses", () => {
  const raw = 'Sure thing, here is the update:\n```json\n{"done":[{"id":"T1","entry":4,"quote":"3 passed"}],"subtasks":{"T2":["step one","step two"]},"subtasksDone":["step one"]}\n```\nLet me know if anything else changed.';
  assert.deepEqual(promptsModule.parsePlanKeeperAnswer(raw), {
    done: [{ ref: "T1", entry: 4, quote: "3 passed" }],
    subtasks: { T2: ["step one", "step two"] },
    subtasksDone: ["step one"],
    labels: {},
    summaries: {},
  });
});

test("malformed JSON and answers with no JSON object are null, not a throw", () => {
  assert.equal(promptsModule.parsePlanKeeperAnswer("{done: [oops"), null);
  assert.equal(promptsModule.parsePlanKeeperAnswer("Nothing changed since last time."), null);
});

test("subtasks, labels and summaries are capped; malformed entries and unknown fields are ignored", () => {
  const raw = answer({
    done: [{ id: "T1", entry: "#12", quote: "ok then" }, { entry: 3 }, 42, ""],
    subtasks: { T2: ["one two three four five six seven eight nine ten", "short one", "s2", "s3", "s4 (dropped, over cap)"] },
    subtasksDone: ["short one", 7],
    labels: { T3: '"Fix the login redirect on every page of the admin area."', T4: 12 },
    summaries: { G1: "Set up the project, wired the database and wrote the first three screens today" },
    somethingUnknown: "ignored",
  });
  const parsed = promptsModule.parsePlanKeeperAnswer(raw);
  assert.deepEqual(parsed.done, [{ ref: "T1", entry: 12, quote: "ok then" }], "only claims that name a task survive");
  assert.equal(parsed.subtasks.T2.length, promptsModule.MAX_SUBTASKS);
  assert.equal(parsed.subtasks.T2[0], "one two three four five six seven eight", "capped to 8 words");
  assert.deepEqual(parsed.subtasksDone, ["short one"]);
  assert.deepEqual(parsed.labels, { T3: "Fix the login redirect on every page of" }, "quotes stripped, 8 words at most");
  assert.equal(parsed.summaries.G1.split(" ").length, 10, "a summary is 10 words at most");
});

test("an answer in the older shape is still heard, but carries no proof", () => {
  const parsed = promptsModule.parsePlanKeeperAnswer('{"completed":["Write the handler"],"subtasksCompleted":["parse the body"]}');
  assert.deepEqual(parsed.done, [{ ref: "Write the handler", entry: null, quote: "" }]);
  assert.deepEqual(parsed.subtasksDone, ["parse the body"]);
});

test("the prompt lists open tasks by id under their phase, what needs a label or a summary, and a numbered log", () => {
  const open = [
    { id: "T1", key: key("Write the handler"), phase: PHASE, task: { content: "Write the handler", status: "in_progress" } },
    { id: "T2", key: key("Ask ops for the token", "Later"), phase: "Later", task: { content: "Ask ops for the token", status: "blocked", blocker: "ops is out" } },
  ];
  const { systemPrompt, prompt } = promptsModule.buildPlanKeeperPrompt({
    open,
    subtasks: { "Write the handler": [{ content: "parse the body", status: "completed" }] },
    labelIds: ["T2"],
    groups: [{ id: "G1", key: key("Set up"), phase: PHASE, tasks: ["Set up", "Add the schema", "Seed the data"] }],
    digest: [{ seq: 7, kind: "tool", at: 0, text: "bash (Running tests) => 3 passed" }],
  });
  assert.match(systemPrompt, /ONE JSON object/);
  assert.match(prompt, /\[Phase: Ship the feature\]\nT1 \(in_progress\) Write the handler\n {4}subtask \(completed\) parse the body/);
  assert.match(prompt, /\[Phase: Later\]\nT2 \(blocked\) Ask ops for the token \(blocked on: ops is out\)/);
  assert.match(prompt, /Needs a short label: T2/);
  assert.match(prompt, /Finished groups:\nG1 \(phase: Ship the feature\)\n- Set up\n- Add the schema\n- Seed the data/);
  assert.match(prompt, /Log, oldest first:\n#7 \[tool\] bash \(Running tests\) => 3 passed/);
});

/* ------------------------------------------------------------ evidence -- */

const OPEN_TASKS = [
  { id: "T1", key: key("Write the handler"), phase: PHASE, task: { content: "Write the handler", status: "in_progress" } },
  { id: "T2", key: key("Wire up the route"), phase: PHASE, task: { content: "Wire up the route", status: "pending" } },
  { id: "T3", key: key("Add tests for the settings page"), phase: PHASE, task: { content: "Add tests for the settings page", status: "pending" } },
  { id: "T4", key: key("Add tests for the profile page"), phase: PHASE, task: { content: "Add tests for the profile page", status: "pending" } },
];

test("a check-off names its task by id, by its exact text, or by a rewording that fits only one task", () => {
  const resolve = (ref) => evidenceModule.resolveClaimedTask(ref, OPEN_TASKS)?.id ?? null;
  assert.equal(resolve("T2"), "T2");
  assert.equal(resolve("t2"), "T2");
  assert.equal(resolve("2"), "T2");
  assert.equal(resolve("T2: Wire up the route"), "T2");
  assert.equal(resolve("T9"), null, "an id that is not on the list names nothing");
  assert.equal(resolve("write the handler."), "T1", "case and punctuation do not matter");
  assert.equal(resolve("Wire the route up"), "T2", "same words, different order");
  assert.equal(resolve("Wiring up the routes for the handler"), null, "half about one task, half about another");
  assert.equal(resolve("Add tests for the settings pages"), "T3", "a plural is the same task");
  assert.equal(resolve("Add tests for the page"), null, "fits two tasks equally well: names neither");
  assert.equal(resolve("Rewrite the billing module"), null);
});

test("the quoted proof has to be in the log: in the cited entry, or failing that in another one", () => {
  const digest = [
    { seq: 1, kind: "tool", at: 0, text: "bash (Running migration) => applied 1 migration" },
    { seq: 2, kind: "message", at: 0, text: "The handler is written and returns the right shape." },
  ];
  const find = (entry, quote) => evidenceModule.findEvidence({ ref: "T1", entry, quote }, digest)?.seq ?? null;
  assert.equal(find(1, "applied 1 migration"), 1);
  assert.equal(find(2, "applied 1 migration"), 1, "a miscounted entry number still finds the entry that says it");
  assert.equal(find(null, "the handler is written"), 2);
  assert.equal(find(2, "Handler is WRITTEN, and returns the right shape!"), 2, "punctuation and case are not part of a quote");
  assert.equal(find(1, "all 14 tests passed"), null, "words that are nowhere in the log prove nothing");
  assert.equal(find(1, "migration"), 1, "a single word counts in the very entry the model cited: some proof is one word long");
  assert.equal(find(1, "migrat"), null, "as a whole word only");
  assert.equal(find(2, "migration"), null, "and it is never looked for in any other entry");
  assert.equal(find(null, "migration"), null);
  assert.equal(find(1, ""), null, "no quote, no check-off");
});

test("only whole words name an acceptance bar", () => {
  for (const content of ["Verify the build", "Run the tests", "Re-test the importer", "Release v2", "Deploy to the NAS", "Publish the image", "Pass the type gate"]) {
    assert.equal(evidenceModule.isGatedTask(content), true, content);
  }
  for (const content of ["Investigate the latest gateway logs", "Delegate the navigation work", "Write the handler", "Update the attestation notes"]) {
    assert.equal(evidenceModule.isGatedTask(content), false, content);
  }
});

test("a gated task needs its own entry to show a pass or a push, with no failure in it or after it", () => {
  const entry = (seq, request, result, extra = {}) => ({ seq, kind: "tool", at: 0, tool: "bash", request, result, text: `bash (${request}) => ${result}`, ...extra });
  const passes = (evidence, digest) => evidenceModule.passesGate(evidence, digest ?? [evidence]);

  assert.equal(passes(entry(1, "Running the tests · npm test", "12 passed, 0 failed")), true, '"0 failed" is a pass');
  assert.equal(passes(entry(1, "Running the tests · npm test", "11 passed, 1 failed")), false);
  assert.equal(passes(entry(1, "Running the failing tests · npm test", "12 passed")), true, "what was asked is not what came back");
  assert.equal(passes(entry(1, "Running the tests · npm test", "12 passed", { failed: true })), false, "the engine itself reported the call as failed");
  assert.equal(passes(entry(1, "Listing files · ls", "handler.ts route.ts")), false, "no pass and no push: not proof");
  assert.equal(passes(entry(1, "Pushing · git push origin main", "To github.com:me/app.git\n   1a2b3c4..5d6e7f8  main -> main")), true, "git's own push output");
  assert.equal(passes({ seq: 1, kind: "message", at: 0, text: "Released v2.1.0 and verified the download works." }), true);

  const passed = entry(1, "Running the tests · npm test", "12 passed");
  assert.equal(passes(passed, [passed, entry(2, "Running the tests · npm test", "3 failed")]), false, "the same check failed again afterwards");
  assert.equal(passes(passed, [entry(0, "Running the tests · npm test", "3 failed"), passed]), true, "an earlier failure it has since fixed");
  assert.equal(passes(passed, [passed, entry(2, "Building the docs · npm run docs", "error: missing file")]), true, "another command failing says nothing about this one");
});

/* ---------------------------------------------------------------- fold -- */

test("completing tasks changes only their status, starts the next one, and keeps the array when nothing changes", () => {
  const phases = [{
    name: "P",
    tasks: [
      { content: "First", status: "in_progress" },
      { content: "Second", status: "blocked", blocker: "waiting on ops" },
      { content: "Third", status: "pending" },
      { content: "Dropped", status: "abandoned" },
    ],
  }];
  const next = foldModule.completeTasks(phases, new Set([key("First", "P"), key("Second", "P"), key("Dropped", "P"), key("Not on the list", "P")]));
  assert.deepEqual(next.completed, [key("First", "P"), key("Second", "P")]);
  assert.deepEqual(next.phases[0].tasks.map((task) => [task.content, task.status]), [
    ["First", "completed"],
    ["Second", "completed"],
    ["Third", "in_progress"],
    ["Dropped", "abandoned"],
  ]);
  assert.equal(phases[0].tasks[0].status, "in_progress", "the input is not modified");

  const untouched = foldModule.completeTasks(next.phases, new Set([key("First", "P")]));
  assert.equal(untouched.phases, next.phases, "nothing left to complete: the very same array comes back");
});

test("the keeper's check-offs are applied by phase and task; an entry without a phase only earns the mark", () => {
  const phases = [
    { name: "One", tasks: [{ content: "Run the tests", status: "in_progress" }] },
    { name: "Two", tasks: [{ content: "Run the tests", status: "pending" }, { content: "Ship it", status: "pending" }] },
  ];
  const overlay = { ...overlayModule.emptyPlanOverlay(), autoCompleted: [key("Run the tests", "One"), "Ship it"] };
  const shown = foldModule.applyPlanOverlay(phases, overlay);
  assert.equal(shown[0].tasks[0].status, "completed");
  assert.equal(shown[1].tasks[0].status, "in_progress", "same text in another phase is another task");
  assert.equal(shown[1].tasks[1].status, "pending", "a bare task text never completes anything");
  assert.equal(foldModule.applyPlanOverlay(phases, null), phases);
});

/** Every task of a view, in the order a reader meets them. */
function viewedTasks(view) {
  return view.phases.flatMap((phase) => phase.rows.flatMap((row) => (row.kind === "fold" ? row.tasks : [row]))).map((row) => row.task.content);
}

test("a short plan is shown as it is: nothing folded, every phase open", () => {
  const phases = [
    { name: "Build", tasks: [...tasksOf("Built", 4, "completed"), { content: "Wire it", status: "in_progress" }] },
    { name: "Check", tasks: tasksOf("Check", 3, "pending") },
  ];
  const view = foldModule.buildPlanView(phases, null);
  assert.equal(view.done, 4);
  assert.equal(view.total, 8);
  assert.deepEqual(view.phases.map((phase) => [phase.name, phase.done, phase.total, phase.current, phase.open]), [
    ["Build", 4, 5, true, true],
    ["Check", 0, 3, false, true],
  ]);
  assert.equal(view.phases.some((phase) => phase.rows.some((row) => row.kind === "fold")), false);
});

test("more than 8 finished tasks in a phase fold into runs; tasks still to do are never folded and nothing is lost", () => {
  const phases = [{
    name: "Build",
    tasks: [
      ...tasksOf("Built", 10, "completed"),
      { content: "Stuck on review", status: "blocked", blocker: "needs a reviewer" },
      { content: "Wire it", status: "in_progress" },
      ...tasksOf("Polished", 2, "completed"),
      { content: "Dropped idea", status: "abandoned" },
      ...tasksOf("Later", 3, "pending"),
    ],
  }];
  const view = foldModule.buildPlanView(phases, null);
  const rows = view.phases[0].rows;
  const folds = rows.filter((row) => row.kind === "fold");

  assert.deepEqual(folds.map((fold) => fold.tasks.length), [8], "one run of ten: a full group of eight, the two left over stay as they are");
  assert.equal(folds[0].key, key("Built 1", "Build"));
  assert.equal(folds[0].summary, null, "no summary written yet");
  for (const fold of folds) {
    assert.ok(fold.tasks.every((row) => row.task.status === "completed"), "only finished tasks are ever inside a fold");
  }
  assert.deepEqual(
    rows.filter((row) => row.kind === "task").map((row) => row.task.content),
    ["Built 9", "Built 10", "Stuck on review", "Wire it", "Polished 1", "Polished 2", "Dropped idea", "Later 1", "Later 2", "Later 3"],
    "blocked, in-progress, pending and abandoned tasks are their own rows, and so is a run too short to fold",
  );
  assert.deepEqual(viewedTasks(view), phases[0].tasks.map((task) => task.content), "every task exactly once, in its original order");
  assert.equal(view.done, 12);
});

test("a long list folds finished runs of three or more even when no phase has many", () => {
  const phases = [
    { name: "One", tasks: [...tasksOf("Done", 3, "completed"), ...tasksOf("Open", 6, "pending")] },
    { name: "Two", tasks: [...tasksOf("Did", 2, "completed"), ...tasksOf("Todo", 6, "pending")] },
  ];
  const view = foldModule.buildPlanView(phases, null);
  assert.deepEqual(view.phases[0].rows.map((row) => row.kind), ["fold", "task", "task", "task", "task", "task", "task"]);
  assert.ok(view.phases[1].rows.every((row) => row.kind === "task"), "two in a row is not worth a fold");
  assert.deepEqual(view.phases.map((phase) => phase.open), [true, false], "on a long list only the current phase starts open");
  assert.deepEqual(viewedTasks(view), phases.flatMap((phase) => phase.tasks.map((task) => task.content)));
});

test("a phase never shows more than three summaries, however much of it is finished", () => {
  const phases = [{ name: "Build", tasks: [...tasksOf("Built", 37, "completed"), { content: "Wire it", status: "in_progress" }] }];
  const view = foldModule.buildPlanView(phases, null);
  const folds = view.phases[0].rows.filter((row) => row.kind === "fold");
  assert.deepEqual(folds.map((fold) => fold.tasks.length), [16, 16, 5]);
  assert.deepEqual(folds.map((fold) => fold.settled), [true, true, false], "the last group can still grow");
  assert.deepEqual(viewedTasks(view), phases[0].tasks.map((task) => task.content));
});

test("a finished phase is one line among others, and stays open when it is the whole plan", () => {
  const done = { name: "Build", tasks: tasksOf("Built", 4, "completed") };
  const open = { name: "Check", tasks: [{ content: "Run the checks", status: "in_progress" }] };
  const both = foldModule.buildPlanView([done, open], null);
  assert.deepEqual(both.phases.map((phase) => [phase.finished, phase.open, phase.current]), [[true, false, false], [false, true, true]]);
  assert.equal(both.phases[0].rows.length, 4, "its tasks are all still there for whoever opens it");

  const alone = foldModule.buildPlanView([done], null);
  assert.deepEqual(alone.phases.map((phase) => [phase.finished, phase.open]), [[true, true]]);
});

test("labels, auto-marks and summaries decorate the view without changing the tasks", () => {
  const long = "Rework the settings page so that every toggle saves on its own and shows a spinner";
  const phases = [{ name: "Build", tasks: [...tasksOf("Built", 9, "completed"), { content: long, status: "in_progress" }] }];
  const overlay = {
    subtasks: { [long]: [{ content: "save on toggle", status: "pending" }] },
    autoCompleted: [key("Built 9", "Build"), "Built 2"],
    labels: { [long]: "Rework the settings page", "Built 1": "Built 1" },
    folds: { [key("Built 1", "Build")]: { summary: "Built the first eight parts", count: 8 } },
    updatedAt: 1,
  };
  const view = foldModule.buildPlanView(phases, overlay);
  const [fold, ninth, current] = view.phases[0].rows;
  assert.equal(fold.summary, "Built the first eight parts");
  assert.equal(fold.tasks[0].label, null, "a label that says the same as the task is not one");
  assert.equal(fold.tasks[1].autoCompleted, true, "a mark recorded before phases were still shows");
  assert.equal(ninth.autoCompleted, true);
  assert.equal(current.label, "Rework the settings page");
  assert.equal(current.task.content, long, "the task's own words stay with it");
  assert.deepEqual(current.subtasks, [{ content: "save on toggle", status: "pending" }]);

  const outdated = { ...overlay, folds: { [key("Built 1", "Build")]: { summary: "Built ten parts", count: 10 } } };
  assert.equal(foldModule.buildPlanView(phases, outdated).phases[0].rows[0].summary, null, "a summary written for more tasks than the fold holds is not shown");
  assert.doesNotThrow(() => foldModule.buildPlanView(phases, { autoCompleted: null, subtasks: null }), "a malformed overlay degrades to the bare plan");
});

test("a summary is asked for when a fold has none, has outgrown it by three tasks, or is complete and has grown", () => {
  const withDone = (count) => [{ name: "Build", tasks: [...tasksOf("Built", count, "completed"), { content: "Wire it", status: "in_progress" }, ...tasksOf("Later", 12, "pending")] }];
  const stored = (count) => ({ ...overlayModule.emptyPlanOverlay(), folds: { [key("Built 1", "Build")]: { summary: "Built the early parts", count } } });
  const asked = (phases, overlay) => foldModule.planFoldsToSummarise(phases, overlay).map((group) => [group.key, group.tasks.length]);

  assert.deepEqual(asked(withDone(2), null), [], "nothing folds yet");
  assert.deepEqual(asked(withDone(3), null), [[key("Built 1", "Build"), 3]]);
  assert.deepEqual(foldModule.planFoldsToSummarise(withDone(3), null)[0].tasks, ["Built 1", "Built 2", "Built 3"], "the model is given the tasks' own words");
  assert.deepEqual(asked(withDone(5), stored(3)), [], "two more tasks: the line it has still stands");
  assert.deepEqual(asked(withDone(6), stored(3)), [[key("Built 1", "Build"), 6]]);
  assert.deepEqual(asked(withDone(8), stored(6)), [], "full, but nothing says it is complete yet");
  assert.deepEqual(asked(withDone(9), stored(6)), [[key("Built 1", "Build"), 8]], "the run went on past it: this group is complete");
  assert.deepEqual(asked(withDone(9), stored(8)), []);
  assert.deepEqual(asked(withDone(4), stored(6)), [[key("Built 1", "Build"), 4]], "written for tasks that are no longer in it");
});

/* ------------------------------------------------------- keeper: cadence */

test("every finished tool call is logged with what it was asked and what came back, and debounces one run 2s later", async () => {
  const { keeper, clock, calls } = newKeeper(openPhases(), [{ text: NOOP_ANSWER }]);

  tool(keeper, "bash", { i: "Running migration", command: "npm run migrate" }, "applied 1 migration");
  assert.deepEqual(keeper.digestSnapshot().map((entry) => [entry.seq, entry.kind, entry.text]), [
    [1, "tool", "bash (Running migration · npm run migrate) => applied 1 migration"],
  ]);
  assert.equal(clock.pendingCount(), 1);

  await clock.run(1999);
  assert.equal(calls.length, 0, "the debounce has not elapsed yet");
  await clock.run(1);
  assert.equal(calls.length, 1);
});

test("a long result keeps its end, where the verdict is", () => {
  const { keeper } = newKeeper(openPhases(), []);
  tool(keeper, "bash", { i: "Running the suite" }, `${"compiling module\n".repeat(200)}Tests: 212 passed, 0 failed`);
  const [entry] = keeper.digestSnapshot();
  assert.ok(entry.text.length < 800, "clipped");
  assert.match(entry.text, /^bash \(Running the suite\) => compiling module/);
  assert.match(entry.text, /Tests: 212 passed, 0 failed$/);
  assert.equal(entry.result.endsWith("Tests: 212 passed, 0 failed"), true);
});

test("an eval cell is logged by its title, not by its code", () => {
  const { keeper } = newKeeper(openPhases(), []);
  tool(keeper, "eval", { language: "js", code: "const token = 'hunter2'; await run(token);", title: "Checking the sync result", timeout: 60 }, "sync completed");
  const [entry] = keeper.digestSnapshot();
  assert.equal(entry.text, "eval (Checking the sync result) => sync completed");
});

test("the engine's own background and subagent instructions are cut from a result; the work around them stays", () => {
  const { keeper } = newKeeper(openPhases(), []);
  const poll = "its output is injected into the conversation as a follow-up the moment it finishes. Do NOT poll for it (no `sleep`, `ps`, `pgrep`, `top`, `pidwait`, log tailing): every poll is a wasted turn. Do other work, or end your reply and wait to be woken.";
  tool(keeper, "bash", { i: "Building the image" }, `Step 1/9 done\nBackgrounded early to handle an incoming message; the command keeps running. Backgrounded as job bg_7 (killed once it has run 90s in total; \`timeout: 0\` disables the deadline); ${poll}`);
  tool(keeper, "bash", { i: "Running the suite" }, `Backgrounded as job bg_8; ${poll}\nWall time: 60 seconds`);
  tool(keeper, "task", { i: "Mapping the code" }, [
    "Spawned agent `Mapper` (job `Mapper`).",
    "",
    "Results auto-deliver; NEVER poll. Completely blocked? Call `wait` to receive the first settled job you started.",
    "Coordinate while peers run via `write agent://<id>` (or `agent://all` to broadcast).",
    "",
    "`completed`: subagent yielded successfully; claimed artifacts unverified.",
    "",
    "Tip: this call spawned 1 generic `task` worker.",
  ].join("\n"));
  // A notice a later engine words differently is left as it is.
  tool(keeper, "bash", { i: "Syncing" }, "Backgrounded as job bg_9, ask again later.");

  assert.deepEqual(keeper.digestSnapshot().map((entry) => entry.text), [
    "bash (Building the image) => Step 1/9 done [moved to the background as bg_7; its result comes later]",
    "bash (Running the suite) => [moved to the background as bg_8; its result comes later] Wall time: 60 seconds",
    "task (Mapping the code) => Spawned agent `Mapper` (job `Mapper`). [results come later]",
    "bash (Syncing) => Backgrounded as job bg_9, ask again later.",
  ]);
});

test("each job that reports back in one hidden message is its own entry, and an exploration report is the agent's own words", () => {
  const { keeper } = newKeeper(openPhases(), []);
  const hidden = (customType, content) => keeper.notifyCustomMessage({ role: "custom", customType, content });

  hidden("async-result", "<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n── Job Mapper (Mapper) ──\nMapped 14 files.\n── Job bg_8 (npm test) ──\n212 passed, 0 failed\n</system-notice>");
  hidden("async-result", [{ type: "text", text: "Background job bg_9 has completed.\nimage pushed" }]);
  hidden("launch-completion", "Supervised process dev-server exited with exit code 0.");
  hidden("rewind-report", "Checkpoint called and rewound. Report: the leak is in the socket pool.");
  for (const noise of ["cody-local-time", "mid-run-todo-nudge", "irc:incoming", "constructor", "toString"]) hidden(noise, "not evidence");
  keeper.notifyCustomMessage({ role: "user", customType: "async-result", content: "not a hidden message" });

  assert.deepEqual(keeper.digestSnapshot().map((entry) => [entry.seq, entry.kind, entry.text]), [
    [1, "tool", "background job => ── Job Mapper (Mapper) ── Mapped 14 files."],
    [2, "tool", "background job => ── Job bg_8 (npm test) ── 212 passed, 0 failed </system-notice>"],
    [3, "tool", "background job => Background job bg_9 has completed. image pushed"],
    [4, "tool", "background job => Supervised process dev-server exited with exit code 0."],
    [5, "message", "Checkpoint called and rewound. Report: the leak is in the socket pool."],
  ]);
});

test("triggers arriving within the debounce window coalesce into exactly one run", async () => {
  const { keeper, clock, calls } = newKeeper(openPhases(), [{ text: NOOP_ANSWER }]);

  tool(keeper, "read", { i: "Reading config" }, "ok");
  tool(keeper, "read", { i: "Reading routes" }, "ok");
  keeper.notifyMessageEnd("Both files look fine.");
  keeper.notifyTurnEnd();
  assert.equal(clock.pendingCount(), 1, "later triggers before it fires do not add a second timer");
  assert.equal(keeper.digestSnapshot().length, 3, "a turn ending is a trigger, not a log entry");

  await clock.run(2000);
  assert.equal(calls.length, 1, "still exactly one run, over the whole log");
});

test("a trigger during an in-flight run coalesces into one rerun, never a concurrent second call", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks } = fakeHooks(openPhases());
  const gate = gatedRunner(NOOP_ANSWER);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner: gate.runner, clock });

  keeper.notifyMessageEnd("Starting on the handler.");
  const first = keeper.notifyTerminalAgentEnd();
  await flush();
  assert.equal(gate.calls.length, 1, "the run started and called the model exactly once");

  keeper.notifyMessageEnd("One more thing.");
  await keeper.notifyTerminalAgentEnd();
  await flush();
  assert.equal(gate.calls.length, 1, "a trigger while running must not start a concurrent second call");

  gate.release();
  await first;
  assert.equal(clock.pendingCount(), 1, "the coalesced trigger was not dropped: a rerun is scheduled");
});

test("a long busy turn gets one model call per 30s, and evidence is judged within that of arriving", async () => {
  const phases = [{ name: PHASE, tasks: [{ content: "Write the handler", status: "in_progress" }, { content: "Wire up the route", status: "pending" }, { content: "Update the docs", status: "pending" }] }];
  const callTimes = [];
  const checkedAt = [];
  let clock;
  const runner = async (input) => {
    callTimes.push(clock.now());
    // The model reports the handler finished as soon as the log says so,
    // under whatever id that task has in this prompt.
    const task = input.prompt.match(/^(T\d+) \(\w+\) Write the handler$/m);
    const proof = input.prompt.match(/#(\d+) \[tool\] edit \(Writing the handler\) => handler written/);
    return { text: task && proof ? answer({ done: [{ id: task[1], entry: Number(proof[1]), quote: "handler written" }] }) : NOOP_ANSWER, error: null };
  };
  const made = newKeeper(phases, [], { runner });
  clock = made.clock;
  const { keeper, setCalls } = made;

  // Two minutes of an agent working without a pause: a tool finishes every 5s.
  for (let second = 0; second <= 120; second += 1) {
    if (second % 5 === 0) {
      if (second === 40) tool(keeper, "edit", { i: "Writing the handler" }, "handler written");
      else tool(keeper, "read", { i: `Reading file ${second}` }, "ok");
    }
    await clock.run(1000);
    if (setCalls.length > checkedAt.length) checkedAt.push(clock.now());
  }

  assert.deepEqual(callTimes, [2000, 32000, 62000, 92000], "the first call 2s in, then one every 30s — not one per tool call, and not none");
  assert.deepEqual(checkedAt, [62000], "the handler, finished at 40s, is checked off 22s later");
  assert.equal(setCalls[0][0].tasks[0].status, "completed");
});

test("the last pass of a turn waits for neither the debounce nor the 30s between model calls; the next turn is back on them", async () => {
  const { keeper, clock, calls, setCalls } = newKeeper(openPhases(), [
    { text: NOOP_ANSWER },
    { text: answer({ done: [{ id: "T1", entry: 2, quote: "handler is done" }] }) },
    { text: NOOP_ANSWER },
  ]);

  tool(keeper, "read", { i: "Reading config" }, "ok");
  await clock.run(2000);
  assert.equal(calls.length, 1, "mid-turn: after the debounce");

  keeper.notifyMessageEnd("The handler is done.");
  await keeper.notifyTerminalAgentEnd();
  assert.equal(calls.length, 2, "the turn is over: its last words are judged at once, not 30s after the previous call");
  assert.equal(setCalls.length, 1, "and what they prove is checked off");

  keeper.notifyListRebuilt();
  tool(keeper, "read", { i: "Reading routes" }, "ok");
  await clock.run(2000);
  assert.equal(calls.length, 2, "a new turn: 30s since the last call have not passed");
  await clock.run(27999);
  assert.equal(calls.length, 2);
  await clock.run(1);
  assert.equal(calls.length, 3);
});

test("a turn ending while a model call is in flight gets its own pass as soon as that call returns", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks } = fakeHooks(openPhases());
  const gate = gatedRunner(NOOP_ANSWER);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner: gate.runner, clock });

  tool(keeper, "read", { i: "Reading config" }, "ok");
  const first = clock.run(2000);
  await flush();
  assert.equal(gate.calls.length, 1);

  keeper.notifyMessageEnd("The handler is done.");
  await keeper.notifyTerminalAgentEnd();
  gate.release();
  await first;
  await clock.run(2000);
  assert.equal(gate.calls.length, 2, "2s after the call in flight returned, not 30s after it started");
});

test("with nothing new in the log the model is not asked again", async () => {
  const { keeper, clock, calls } = newKeeper(openPhases(), [{ text: NOOP_ANSWER }, { text: NOOP_ANSWER }]);

  keeper.notifyMessageEnd("Starting on the handler.");
  await keeper.notifyTerminalAgentEnd();
  assert.equal(calls.length, 1);

  await clock.run(60000);
  keeper.notifyTurnEnd();
  await keeper.notifyTerminalAgentEnd();
  await clock.run(60000);
  assert.equal(calls.length, 1, "it would only repeat its last answer");
});

test("a plan with nothing left to do never calls the model", async () => {
  const phases = [{ name: "P", tasks: [{ content: "already done", status: "completed" }, { content: "gave up", status: "abandoned" }] }];
  const { keeper, calls } = newKeeper(phases, [{ text: NOOP_ANSWER }]);

  keeper.notifyMessageEnd("All finished.");
  await keeper.notifyTerminalAgentEnd();
  assert.equal(calls.length, 0);
});

test("a model call that fails is tried once more for the same log, then waits for something new", async () => {
  const { keeper, clock, calls, setCalls } = newKeeper(openPhases(), [
    { error: "timed out" },
    { error: "timed out" },
    { text: answer({ done: [{ id: "T1", entry: 1, quote: "handler is written" }] }) },
  ]);

  keeper.notifyMessageEnd("The handler is written.");
  await keeper.notifyTerminalAgentEnd();
  assert.equal(calls.length, 1);
  assert.equal(clock.pendingCount(), 1, "the turn is over: nothing else would come back for this log");

  await clock.run(30000);
  assert.equal(calls.length, 2, "one more try");
  assert.equal(clock.pendingCount(), 0, "and no third on its own");

  keeper.notifyMessageEnd("Moving on to the route.");
  await clock.run(30000);
  assert.equal(calls.length, 3, "new activity gets it judged again");
  assert.equal(setCalls.length, 1, "and the proof from before the failures still counts");
});

test("disabling the keeper stops every run, but an agent reopening a task is still honoured", async () => {
  const { keeper, clock, calls, hooks } = newKeeper(openPhases(), [{ text: NOOP_ANSWER }]);
  overlayModule.writePlanOverlay(hooks.sessionId, { ...overlayModule.emptyPlanOverlay(), autoCompleted: [key("Write the handler")] });
  configModule.writePlanKeeperConfig({ enabled: false });
  try {
    tool(keeper, "bash", { i: "Running migration" }, "applied 1 migration");
    await keeper.notifyTerminalAgentEnd();
    await clock.run(60000);
    assert.equal(calls.length, 0);
    assert.equal(keeper.digestSnapshot().length, 1, "the log is still kept, for when it is switched back on");

    agentTodo(keeper, { op: "start", task: "Write the handler" }, openPhases());
    assert.deepEqual(overlayModule.readPlanOverlay(hooks.sessionId).autoCompleted, [], "the list must not go on showing it finished");
  } finally {
    configModule.writePlanKeeperConfig({ enabled: true });
  }
});

/* ----------------------------------------------------- keeper: evidence */

test("a task proven by the log is checked off in the engine's own list, marked as the keeper's, and both frames fire", async () => {
  const { keeper, clock, setCalls, emitted, hooks, prompts } = newKeeper(openPhases(), [
    { text: answer({ done: [{ id: "T1", entry: 1, quote: "handler written" }] }) },
  ]);

  tool(keeper, "edit", { i: "Writing the handler", path: "app/api/items/route.ts" }, "handler written, 42 lines");
  await keeper.notifyTerminalAgentEnd();

  assert.match(prompts[0], /T1 \(in_progress\) Write the handler\nT2 \(pending\) Wire up the route/);
  assert.match(prompts[0], /#1 \[tool\] edit \(Writing the handler · app\/api\/items\/route\.ts\) => handler written, 42 lines/);

  assert.equal(setCalls.length, 1);
  assert.deepEqual(setCalls[0][0].tasks, [
    { content: "Write the handler", status: "completed" },
    { content: "Wire up the route", status: "in_progress" },
  ], "checked off, and the next task started — exactly what the engine's own `todo done` does");

  // A real change fires BOTH frames, in this order — the payloads the
  // browser applies (see hooks/useAgentSession.ts).
  assert.deepEqual(emitted.map((frame) => frame.type), ["plan_overlay_update", "todo_auto_update"]);
  assert.deepEqual(emitted[0].overlay.autoCompleted, [key("Write the handler")]);
  assert.deepEqual(overlayModule.readPlanOverlay(hooks.sessionId).autoCompleted, [key("Write the handler")], "and it is on disk for the next reload");

  await clock.run(60000);
  assert.equal(setCalls.length, 1, "the follow-up pass finds nothing more to do");
});

test("a model that rewords the task instead of using its id still gets it checked off", async () => {
  const { keeper, setCalls } = newKeeper(openPhases(), [
    { text: answer({ done: [{ task: "Writing the handler", entry: 1, quote: "handler written" }] }) },
  ]);

  tool(keeper, "edit", { i: "Writing the handler" }, "handler written, 42 lines");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0][0].tasks[0].status, "completed");
});

test("proof that is one word long counts when the model cites the entry it is in", async () => {
  const phases = [{ name: PHASE, tasks: [{ content: "Count the lines of notes.txt into report.txt", status: "in_progress" }, { content: "Email the report", status: "pending" }] }];
  const { keeper, setCalls } = newKeeper(phases, [
    // What the real model answered for exactly this log in an end-to-end run.
    { text: answer({ done: [{ id: "T1", entry: 1, quote: "3" }, { id: "T2", entry: 7, quote: "3" }] }) },
  ]);

  tool(keeper, "bash", { i: "Counting the lines", command: "wc -l < notes.txt > report.txt && cat report.txt" }, "3\nWall time: 0.01 seconds");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 1);
  assert.deepEqual(setCalls[0][0].tasks.map((task) => task.status), ["completed", "in_progress"], "the same word against an entry that is not in the log proves nothing");
});

test("a check-off without proof in the log is refused: no quote, an invented quote, or an unknown task", async () => {
  const { keeper, setCalls, emitted } = newKeeper(openPhases(), [
    {
      text: answer({
        done: [
          "Write the handler",
          { id: "T1", entry: 1 },
          { id: "T2", entry: 1, quote: "route wired and all 9 tests pass" },
          { id: "T7", entry: 1, quote: "reading the handler" },
          { task: "Rewrite the billing module", entry: 1, quote: "reading the handler" },
        ],
      }),
    },
  ]);

  tool(keeper, "read", { i: "Reading the handler" }, "export async function GET() {}");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 0, "nothing reaches the engine");
  assert.equal(emitted.length, 0);
});

test("a subagent finishing, a background job reporting back and the agent's own words are all evidence", async () => {
  const phases = [{ name: PHASE, tasks: [
    { content: "Map the settings code", status: "in_progress" },
    { content: "Build the image", status: "pending" },
    { content: "Write the handler", status: "pending" },
    { content: "Wire up the route", status: "pending" },
  ] }];
  const { keeper, setCalls, prompts } = newKeeper(phases, [{
    text: answer({ done: [
      { id: "T1", entry: 1, quote: "Map the settings code => completed" },
      { id: "T2", entry: 2, quote: "Successfully built" },
      { id: "T3", entry: 3, quote: "handler is written" },
    ] }),
  }]);

  keeper.notifySubagentTerminal({ agent: "scout", description: "Map the settings code", status: "completed" });
  keeper.notifyCustomMessage({ role: "custom", customType: "async-result", content: [{ type: "text", text: "Background job bg_3 finished.\nSuccessfully built 4f1c2ab9" }] });
  keeper.notifyMessageEnd("The handler is written; next I will wire up the route.");
  // Hidden messages that are not a job reporting back are not evidence.
  keeper.notifyCustomMessage({ role: "custom", customType: "system-reminder", content: "Remember to update the todo list." });
  await keeper.notifyTerminalAgentEnd();

  assert.match(prompts[0], /#1 \[subagent\] Map the settings code => completed/);
  assert.match(prompts[0], /#2 \[tool\] background job => Background job bg_3 finished\. Successfully built 4f1c2ab9/);
  assert.match(prompts[0], /#3 \[message\] The handler is written/);
  assert.doesNotMatch(prompts[0], /Remember to update/);
  assert.deepEqual(setCalls[0][0].tasks.map((task) => task.status), ["completed", "completed", "completed", "in_progress"]);
});

test("the agent's own todo calls are not logged as work", async () => {
  const { keeper, prompts } = newKeeper(openPhases(), [{ text: NOOP_ANSWER }]);

  agentTodo(keeper, { op: "append", phase: PHASE, items: ["Add the changelog"] }, [{ name: PHASE, tasks: [...openPhases()[0].tasks, { content: "Add the changelog", status: "pending" }] }]);
  keeper.notifyMessageEnd("Added a task for the changelog.");
  await keeper.notifyTerminalAgentEnd();

  assert.deepEqual(keeper.digestSnapshot().map((entry) => entry.kind), ["message"]);
  assert.doesNotMatch(prompts[0], /\[tool\] todo/);
});

test("a blocked task can be checked off like any other open one", async () => {
  const phases = [{ name: PHASE, tasks: [
    { content: "Write the handler", status: "in_progress" },
    { content: "Get the API token from ops", status: "blocked", blocker: "ops is out" },
  ] }];
  const { keeper, setCalls, prompts } = newKeeper(phases, [{ text: answer({ done: [{ id: "T2", entry: 1, quote: "token saved" }] }) }]);

  tool(keeper, "bash", { i: "Saving the token ops sent" }, "token saved to the vault");
  await keeper.notifyTerminalAgentEnd();

  assert.match(prompts[0], /T2 \(blocked\) Get the API token from ops \(blocked on: ops is out\)/);
  assert.deepEqual(setCalls[0][0].tasks.map((task) => task.status), ["in_progress", "completed"]);
});

test("proof older than the task itself is not proof of it", async () => {
  const withNew = [{ name: PHASE, tasks: [...openPhases()[0].tasks, { content: "Document the handler", status: "pending" }] }];
  const { keeper, clock, setCalls, engine } = newKeeper(openPhases(), [
    { text: NOOP_ANSWER },
    { text: answer({ done: [{ id: "T3", entry: 1, quote: "handler written" }] }) },
    { text: answer({ done: [{ id: "T3", entry: 3, quote: "handler documented" }] }) },
  ]);

  tool(keeper, "edit", { i: "Writing the handler" }, "handler written");
  await keeper.notifyTerminalAgentEnd();

  // The agent adds a task AFTER that work happened.
  engine.set(withNew);
  agentTodo(keeper, { op: "append", phase: PHASE, items: ["Document the handler"] }, withNew);
  keeper.notifyMessageEnd("Now the docs.");
  await clock.run(30000);
  assert.equal(setCalls.length, 0, "the earlier entry cannot have been about a task that did not exist yet");

  tool(keeper, "edit", { i: "Documenting the handler" }, "handler documented in the README");
  await clock.run(30000);
  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0][0].tasks[2].status, "completed");
});

test("a task with its own acceptance bar is refused without a pass, while an ordinary task in the same answer completes", async () => {
  const phases = [{
    name: "Ship",
    tasks: [
      { content: "Write the migration", status: "in_progress" },
      { content: "Update the docs", status: "pending" },
      { content: "Verify the migration runs cleanly", status: "pending" },
    ],
  }];
  const { keeper, setCalls, emitted } = newKeeper(phases, [{
    text: answer({ done: [
      { id: "T1", entry: 1, quote: "applied 1 migration" },
      { id: "T3", entry: 1, quote: "applied 1 migration" },
    ] }),
  }]);

  tool(keeper, "bash", { i: "Running migration" }, "applied 1 migration");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 1);
  assert.deepEqual(setCalls[0][0].tasks.map((task) => task.status), ["completed", "in_progress", "pending"], "the gated task is left exactly as it was");
  assert.deepEqual(emitted[0].overlay.autoCompleted, [key("Write the migration", "Ship")]);
});

test("a gated task completes once its entry shows a pass, even with another command failing elsewhere in the log", async () => {
  const phases = [{ name: "Ship", tasks: [{ content: "Verify the migration runs cleanly", status: "in_progress" }] }];
  const { keeper, setCalls } = newKeeper(phases, [{ text: answer({ done: [{ id: "T1", entry: 2, quote: "3 passed, 0 failed" }] }) }]);

  tool(keeper, "bash", { i: "Linting the docs" }, "error: 2 broken links", true);
  tool(keeper, "bash", { i: "Running migration test" }, "3 passed, 0 failed");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0][0].tasks[0].status, "completed");
});

test("a gated task stays open when its entry failed, or the same check failed again afterwards", async () => {
  const phases = [{ name: "Ship", tasks: [{ content: "Verify the migration runs cleanly", status: "in_progress" }] }];

  const mixed = newKeeper(phases, [{ text: answer({ done: [{ id: "T1", entry: 1, quote: "1 passed, 1 failed" }] }) }]);
  tool(mixed.keeper, "bash", { i: "Running migration test" }, "1 passed, 1 failed");
  await mixed.keeper.notifyTerminalAgentEnd();
  assert.equal(mixed.setCalls.length, 0, "a mixed result is not a pass");

  const regressed = newKeeper(phases, [{ text: answer({ done: [{ id: "T1", entry: 1, quote: "3 passed" }] }) }]);
  tool(regressed.keeper, "bash", { i: "Running migration test", command: "npm test migration" }, "3 passed");
  tool(regressed.keeper, "bash", { i: "Running migration test", command: "npm test migration" }, "2 passed, 1 failed");
  await regressed.keeper.notifyTerminalAgentEnd();
  assert.equal(regressed.setCalls.length, 0, "it passed, then failed: it is not passing");
});

test("words that only contain an acceptance word are ordinary tasks", async () => {
  const phases = [{ name: "Look", tasks: [{ content: "Investigate the latest gateway logs", status: "in_progress" }] }];
  const { keeper, setCalls } = newKeeper(phases, [{ text: answer({ done: [{ id: "T1", entry: 1, quote: "the proxy drops idle sockets" }] }) }]);

  tool(keeper, "bash", { i: "Reading the gateway logs" }, "found it: the proxy drops idle sockets after 60s");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 1, "no pass/push needed: nothing here asks for a check");
});

/* --------------------------------------------------- keeper: real state */

test("a check-off the engine lost is put back on the next pass, without asking the model", async () => {
  const { keeper, clock, setCalls, emitted, engine, calls } = newKeeper(openPhases(), [
    { text: answer({ done: [{ id: "T1", entry: 1, quote: "handler written" }] }) },
  ]);
  tool(keeper, "edit", { i: "Writing the handler" }, "handler written");
  await keeper.notifyTerminalAgentEnd();
  await clock.run(60000);
  assert.equal(setCalls.length, 1);

  // A compaction, a restart or a rewind: the engine rebuilds its list from
  // the session file, which never had the keeper's check-off in it.
  engine.set(openPhases());
  emitted.length = 0;
  keeper.notifyTurnEnd();
  await clock.run(2000);

  assert.equal(setCalls.length, 2);
  assert.deepEqual(engine.get()[0].tasks.map((task) => task.status), ["completed", "in_progress"]);
  assert.deepEqual(emitted, [{ type: "todo_auto_update" }], "the browser is told to refetch");
  assert.equal(calls.length, 1, "no model call: this is bookkeeping, not judgement");
});

test("the agent's own completion is put back too when the engine loses it", async () => {
  const { keeper, clock, setCalls, engine, calls } = newKeeper(openPhases(), []);
  const afterDone = [{ name: PHASE, tasks: [{ content: "Write the handler", status: "completed" }, { content: "Wire up the route", status: "in_progress" }] }];

  engine.set(afterDone);
  agentTodo(keeper, { op: "done", task: "Write the handler" }, afterDone);
  await clock.run(2000);
  assert.equal(setCalls.length, 0, "the engine already has it");

  // The agent rewinds past its own todo call: the engine's list goes back.
  engine.set(openPhases());
  keeper.notifyTurnEnd();
  await clock.run(2000);

  assert.equal(setCalls.length, 1);
  assert.deepEqual(engine.get()[0].tasks.map((task) => task.status), ["completed", "in_progress"]);
  assert.equal(calls.length, 0);
});

test("a turn starting on a restarted engine gets the saved check-offs back at once, before the agent can read the list", async () => {
  // A new keeper for the same chat is all a restart leaves: the check-off is
  // in Cody's overlay, the engine's list is the one from its session file.
  const { keeper, clock, setCalls, emitted, engine, calls, hooks } = newKeeper(openPhases(), []);
  overlayModule.writePlanOverlay(hooks.sessionId, { ...overlayModule.emptyPlanOverlay(), autoCompleted: [key("Write the handler")] });

  keeper.notifyListRebuilt();
  await clock.run(0);

  assert.equal(setCalls.length, 1, "no 2s wait: the agent's first todo call may come sooner");
  assert.deepEqual(engine.get()[0].tasks.map((task) => task.status), ["completed", "in_progress"]);
  assert.deepEqual(emitted, [{ type: "todo_auto_update" }]);
  assert.equal(calls.length, 0);

  keeper.notifyListRebuilt();
  await clock.run(0);
  assert.equal(setCalls.length, 1, "nothing lost, nothing written");
});

test("a task the agent reopens stays open: the check-off is withdrawn and only newer proof can bring it back", async () => {
  const { keeper, clock, setCalls, emitted, engine, hooks } = newKeeper(openPhases(), [
    { text: answer({ done: [{ id: "T1", entry: 1, quote: "handler written" }] }) },
    { text: answer({ done: [{ id: "T1", entry: 1, quote: "handler written" }] }) },
    { text: answer({ done: [{ id: "T1", entry: 3, quote: "handler fixed" }] }) },
  ]);
  tool(keeper, "edit", { i: "Writing the handler" }, "handler written");
  await keeper.notifyTerminalAgentEnd();
  assert.deepEqual(overlayModule.readPlanOverlay(hooks.sessionId).autoCompleted, [key("Write the handler")]);

  // The agent finds the handler broken and starts it again.
  const reopened = [{ name: PHASE, tasks: [{ content: "Write the handler", status: "in_progress" }, { content: "Wire up the route", status: "pending" }] }];
  engine.set(reopened);
  emitted.length = 0;
  agentTodo(keeper, { op: "start", task: "Write the handler" }, reopened);
  assert.deepEqual(overlayModule.readPlanOverlay(hooks.sessionId).autoCompleted, [], "Cody stops claiming it at once");
  assert.deepEqual(emitted.map((frame) => frame.type), ["plan_overlay_update"]);

  keeper.notifyMessageEnd("The handler returns the wrong shape; fixing it.");
  await clock.run(30000);
  assert.equal(setCalls.length, 1, "the old proof does not complete it a second time");
  assert.equal(engine.get()[0].tasks[0].status, "in_progress");

  tool(keeper, "edit", { i: "Fixing the handler" }, "handler fixed");
  await clock.run(30000);
  assert.equal(setCalls.length, 2);
  assert.equal(engine.get()[0].tasks[0].status, "completed");
});

test("a new plan from the agent clears every check-off, even for a task with the same words", async () => {
  const { keeper, clock, setCalls, engine, hooks } = newKeeper(openPhases(), [
    { text: answer({ done: [{ id: "T1", entry: 1, quote: "handler written" }] }) },
  ]);
  tool(keeper, "edit", { i: "Writing the handler" }, "handler written");
  await keeper.notifyTerminalAgentEnd();
  assert.equal(setCalls.length, 1);

  const fresh = [{ name: PHASE, tasks: [{ content: "Write the handler", status: "in_progress" }, { content: "Something else", status: "pending" }] }];
  engine.set(fresh);
  agentTodo(keeper, { op: "init", list: [{ phase: PHASE, items: ["Write the handler", "Something else"] }] }, fresh);
  await clock.run(60000);

  assert.equal(setCalls.length, 1, "nothing is carried over into the new plan");
  assert.equal(engine.get()[0].tasks[0].status, "in_progress");
  assert.deepEqual(overlayModule.readPlanOverlay(hooks.sessionId).autoCompleted, []);
});

test("what the agent changed while the model was thinking is kept: the keeper writes onto the list as it is now", async () => {
  const made = newKeeper(openPhases(), [], {
    runner: async () => {
      // The model call takes a while; meanwhile the agent adds a task.
      const grown = [{ name: PHASE, tasks: [...made.engine.get()[0].tasks, { content: "Add the changelog", status: "pending" }] }];
      made.engine.set(grown);
      agentTodo(made.keeper, { op: "append", phase: PHASE, items: ["Add the changelog"] }, grown);
      return { text: answer({ done: [{ id: "T1", entry: 1, quote: "handler written" }] }), error: null };
    },
  });
  tool(made.keeper, "edit", { i: "Writing the handler" }, "handler written");
  await made.keeper.notifyTerminalAgentEnd();

  assert.deepEqual(made.engine.get()[0].tasks, [
    { content: "Write the handler", status: "completed" },
    { content: "Wire up the route", status: "in_progress" },
    { content: "Add the changelog", status: "pending" },
  ]);
});

test("an agent todo call landing during the keeper's write is not erased: the write is redone on top of it", async () => {
  const made = newKeeper(openPhases(), [{ text: answer({ done: [{ id: "T1", entry: 1, quote: "handler written" }] }) }]);
  const { keeper, hooks, engine, setCalls } = made;
  const write = hooks.setTodoPhases;
  let raced = false;
  hooks.setTodoPhases = async (next) => {
    if (!raced) {
      raced = true;
      // The engine ran the agent's `todo append` first; its result (the list
      // with the new task, the handler still in progress) is on the wire as
      // the keeper's older copy of the list replaces it.
      const agentsList = [{ name: PHASE, tasks: [...openPhases()[0].tasks, { content: "Add the changelog", status: "pending" }] }];
      agentTodo(keeper, { op: "append", phase: PHASE, items: ["Add the changelog"] }, agentsList);
    }
    await write(next);
  };

  tool(keeper, "edit", { i: "Writing the handler" }, "handler written");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 2, "written once on the stale copy, then again on the agent's list");
  assert.deepEqual(engine.get()[0].tasks, [
    { content: "Write the handler", status: "completed" },
    { content: "Wire up the route", status: "in_progress" },
    { content: "Add the changelog", status: "pending" },
  ], "the agent's new task and the keeper's check-off are both there");
});

test("finished and abandoned tasks are never touched, and nothing is reordered", async () => {
  const phases = [{
    name: "P",
    tasks: [
      { content: "Done already", status: "completed" },
      { content: "Abandoned idea", status: "abandoned" },
      { content: "Actually pending", status: "in_progress" },
      { content: "Later", status: "pending" },
    ],
  }];
  const { keeper, setCalls, prompts } = newKeeper(phases, [{
    text: answer({ done: [
      { task: "Done already", entry: 1, quote: "all of it is finished" },
      { task: "Abandoned idea", entry: 1, quote: "all of it is finished" },
      { id: "T1", entry: 1, quote: "all of it is finished" },
    ] }),
  }]);

  keeper.notifyMessageEnd("All of it is finished.");
  await keeper.notifyTerminalAgentEnd();

  assert.doesNotMatch(prompts[0], /Done already|Abandoned idea/, "closed tasks are not even offered to the model");
  assert.equal(setCalls.length, 1);
  assert.deepEqual(setCalls[0][0].tasks.map((task) => [task.content, task.status]), [
    ["Done already", "completed"],
    ["Abandoned idea", "abandoned"],
    ["Actually pending", "completed"],
    ["Later", "in_progress"],
  ]);
});

test("a list with nothing in progress is left alone when nothing is proven", async () => {
  const phases = [{ name: "P", tasks: [{ content: "A", status: "pending" }, { content: "B", status: "pending" }] }];
  const { keeper, setCalls, emitted } = newKeeper(phases, [{ text: NOOP_ANSWER }]);

  keeper.notifyMessageEnd("Thinking about where to start.");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 0, "which task to start is the agent's call");
  assert.equal(emitted.length, 0);
});

/* ----------------------------------- keeper: subtasks, labels, summaries */

test("subtasks are added only under the in_progress task, capped, and persisted for reload", async () => {
  const { keeper, setCalls, emitted, hooks } = newKeeper(openPhases(), [{
    text: answer({
      done: [],
      subtasks: {
        T1: ["parse the body", "validate input", "call the service", "shape the response", "one too many"],
        T2: ["ignored: not the in_progress task"],
      },
    }),
  }]);

  keeper.notifyMessageEnd("Parsing the body first.");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 0, "subtasks alone never touch the engine's todo phases");
  assert.deepEqual(emitted.map((frame) => frame.type), ["plan_overlay_update"], "no todo_auto_update: there are no new todoPhases to refetch");
  const subtasks = emitted[0].overlay.subtasks["Write the handler"];
  assert.equal(subtasks.length, 4, "capped at MAX_SUBTASKS");
  assert.deepEqual(subtasks.map((subtask) => subtask.status), ["pending", "pending", "pending", "pending"]);
  assert.equal(emitted[0].overlay.subtasks["Wire up the route"], undefined, "not the in_progress task: ignored");
  assert.deepEqual(overlayModule.readPlanOverlay(hooks.sessionId).subtasks["Write the handler"], subtasks);
});

test("subtasksDone marks matching subtasks done without touching others or un-completing", async () => {
  const { keeper, hooks } = newKeeper(openPhases(), [{ text: answer({ done: [], subtasksDone: ["parse the body", "validate input", "unknown step"] }) }]);
  overlayModule.writePlanOverlay(hooks.sessionId, {
    ...overlayModule.emptyPlanOverlay(),
    subtasks: { "Write the handler": [{ content: "parse the body", status: "pending" }, { content: "validate input", status: "completed" }] },
  });

  keeper.notifyMessageEnd("Body parsing works.");
  await keeper.notifyTerminalAgentEnd();

  assert.deepEqual(overlayModule.readPlanOverlay(hooks.sessionId).subtasks["Write the handler"], [
    { content: "parse the body", status: "completed" },
    { content: "validate input", status: "completed" },
  ]);
});

const LONG_TASK = "Internationalize the administration dashboard notification preferences subsystem";

test("a long task gets a short label once; a label for a task that was not offered is ignored", async () => {
  const phases = [{ name: PHASE, tasks: [{ content: LONG_TASK, status: "in_progress" }, { content: "Wire up the route", status: "pending" }] }];
  const { keeper, clock, prompts, hooks, setCalls, emitted } = newKeeper(phases, [
    { text: answer({ done: [], labels: { T1: "Translate the admin notification settings.", T2: "Route" } }) },
    { text: NOOP_ANSWER },
  ]);

  keeper.notifyMessageEnd("Looking at the notification settings.");
  await keeper.notifyTerminalAgentEnd();
  assert.match(prompts[0], /Needs a short label: T1\n/, "only the long task is offered");
  assert.deepEqual(overlayModule.readPlanOverlay(hooks.sessionId).labels, { [LONG_TASK]: "Translate the admin notification settings" }, "keyed by the task's own words, which stay as they are");
  assert.deepEqual(emitted.map((frame) => frame.type), ["plan_overlay_update"]);
  assert.equal(setCalls.length, 0, "a label never touches the engine's list");

  keeper.notifyMessageEnd("Found the strings.");
  await clock.run(30000);
  assert.doesNotMatch(prompts[1], /Needs a short label/, "it has its label");
});

test("a label no shorter than the task is dropped, and one that never comes is asked for twice at most", async () => {
  const phases = [{ name: PHASE, tasks: [{ content: LONG_TASK, status: "in_progress" }] }];
  const { keeper, clock, prompts, hooks } = newKeeper(phases, [
    { text: answer({ done: [], labels: { T1: LONG_TASK } }) },
    { text: NOOP_ANSWER },
    { text: NOOP_ANSWER },
  ]);

  keeper.notifyMessageEnd("Looking at the notification settings.");
  await keeper.notifyTerminalAgentEnd();
  assert.equal(overlayModule.readPlanOverlay(hooks.sessionId), null, "the task repeated back is not a label");

  keeper.notifyMessageEnd("Found the strings.");
  await clock.run(30000);
  assert.match(prompts[1], /Needs a short label: T1\n/, "asked once more");

  keeper.notifyMessageEnd("Translating them now.");
  await clock.run(30000);
  assert.doesNotMatch(prompts[2], /Needs a short label/, "then left alone: the task shows its own words");
});

test("a finished run gets its one-line summary, asked for on its own once the list settles", async () => {
  const phases = [{ name: "Build", tasks: [...tasksOf("Built", 8, "completed"), { content: "Wire it", status: "in_progress" }, { content: "Ship it", status: "pending" }] }];
  const { keeper, clock, prompts, calls, hooks, emitted, engine } = newKeeper(phases, [
    { text: answer({ done: [{ id: "T1", entry: 1, quote: "wired the parts" }] }) },
    { text: answer({ summaries: { g1: "Built the first eight parts." } }) },
  ]);

  tool(keeper, "edit", { i: "Wiring it" }, "wired the parts together");
  await keeper.notifyTerminalAgentEnd();
  assert.doesNotMatch(prompts[0], /Finished groups/, "eight finished tasks do not fold yet");
  assert.equal(engine.get()[0].tasks[8].status, "completed");

  // Nine finished now: the phase folds, and nothing else is going to happen
  // in this session to trigger the pass that would summarise it.
  emitted.length = 0;
  await clock.run(30000);
  assert.equal(calls.length, 2, "a pass of its own");
  assert.match(prompts[1], /^Open tasks:\n\(none\)\n\nFinished groups:\nG1 \(phase: Build\)\n- Built 1\n(?:- Built \d\n){7}\nLog, oldest first:\n\(nothing recorded yet\)$/, "only the group: there is nothing new to judge, so neither tasks nor log are sent again");
  assert.deepEqual(overlayModule.readPlanOverlay(hooks.sessionId).folds, { [key("Built 1", "Build")]: { summary: "Built the first eight parts", count: 8 } });
  assert.deepEqual(emitted.map((frame) => frame.type), ["plan_overlay_update"]);

  await clock.run(120000);
  assert.equal(calls.length, 2, "and it is not asked for again");
});

/* ------------------------------------------------- keeper: runner chain */

test("the model chain tries omp's smol role, then tiny, then the engine default — each a fallback for empty/failure", async () => {
  const { keeper, calls, setCalls } = newKeeper(openPhases(), [
    { error: "smol model unavailable" },
    { text: "   " }, // whitespace-only counts as empty, same failure class
    { text: answer({ done: [{ id: "T1", entry: 1, quote: "handler written" }] }) },
  ]);
  modelRoles.writeModelRoles({ smol: "vendor/smol-model", tiny: "vendor/tiny-model" });
  try {
    tool(keeper, "edit", { i: "Writing the handler" }, "handler written");
    await keeper.notifyTerminalAgentEnd();

    assert.deepEqual(calls, ["vendor/smol-model", "vendor/tiny-model", undefined]);
    assert.equal(setCalls[0][0].tasks[0].status, "completed", "the engine-default attempt's answer was applied");
  } finally {
    modelRoles.clearModelRoles();
  }
});

test("a duplicate smol/tiny selector is only tried once", async () => {
  const { keeper, calls } = newKeeper(openPhases(), [{ text: NOOP_ANSWER }]);
  modelRoles.writeModelRoles({ smol: "vendor/same-model", tiny: "vendor/same-model" });
  try {
    keeper.notifyMessageEnd("Starting on the handler.");
    await keeper.notifyTerminalAgentEnd();
    assert.deepEqual(calls, ["vendor/same-model"]);
  } finally {
    modelRoles.clearModelRoles();
  }
});

test("every model attempt failing or empty applies nothing at all", async () => {
  const { keeper, calls, setCalls, emitted, hooks } = newKeeper(openPhases(), [{ error: "spawn ENOENT" }]);

  keeper.notifyMessageEnd("The handler is written.");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(calls.length, 1);
  assert.equal(setCalls.length, 0);
  assert.equal(emitted.length, 0);
  assert.equal(overlayModule.readPlanOverlay(hooks.sessionId), null, "no overlay file was ever written");
});

test("an answer with no parseable JSON applies nothing", async () => {
  const { keeper, setCalls, emitted } = newKeeper(openPhases(), [{ text: "I looked things over and nothing needs to change." }]);

  keeper.notifyMessageEnd("The handler is written.");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 0);
  assert.equal(emitted.length, 0);
});

test("a fenced JSON answer with real evidence is applied end to end", async () => {
  const raw = '```json\n{"done":[{"id":"T1","entry":1,"quote":"handler is written"}]}\n```';
  const { keeper, setCalls } = newKeeper(openPhases(), [{ text: raw }]);

  keeper.notifyMessageEnd("The handler is written.");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls[0][0].tasks[0].status, "completed");
});

/* ---------------------------------------------------------------- wiring */

test("the session feeds the keeper every source of evidence and serves the list with its check-offs applied", () => {
  const manager = fs.readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const frames = manager.slice(manager.indexOf("private handleFrame("), manager.indexOf("private buildWebState("));
  // The args are only on the start frame and the result only on the end
  // frame, so the keeper needs both, whole.
  assert.match(frames, /case "tool_execution_start":[^}]*?notifyToolExecutionStart\(event\);/);
  assert.match(frames, /case "tool_execution_end": \{[^}]*?notifyToolExecutionEnd\(event\);/);
  assert.match(frames, /notifyMessageEnd\(text\);\s*\} else \{\s*this\.getPlanKeeper\(\)\?\.notifyCustomMessage\(event\.message\);/, "background results arrive as hidden messages");
  assert.match(frames, /case "subagent_lifecycle":[\s\S]*?notifySubagentTerminal\(/);
  assert.match(frames, /notifyTerminalAgentEnd\(\)/);
  // Each within its own case, before that case's break.
  assert.match(frames, /case "agent_start":(?:(?!break;)[\s\S])*?notifyListRebuilt\(\);/, "a turn starting");
  assert.match(frames, /case "auto_compaction_end":(?:(?!break;)[\s\S])*?notifyListRebuilt\(\);/, "the engine rebuilding its list mid-turn");

  const state = manager.slice(manager.indexOf("private buildWebState("));
  assert.match(state, /todoPhases: applyPlanOverlay\(state\.todoPhases \?\? \[\], planOverlay\)/, "a live chat");
  const route = fs.readFileSync(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /todoPhases: applyPlanOverlay\(context\.todoPhases, planOverlay\)/, "a chat read from its file, which never holds a keeper check-off");
});
