import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * What every agent of a main chat reads about scratch space and the disk
 * budget (lib/omp/extensions/cody-disk-budget.ts). omp loads that file under
 * Bun with no Cody imports, so it repeats a few constants of lib/disk; these
 * tests run both on the same inputs so the copies cannot drift, and drive the
 * real handlers the way omp does, over a made-up disk and a clock of the
 * test's own.
 */
const root = mkdtempSync(join(tmpdir(), "cody-disk-budget-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const extension = await jiti.import("./extensions/cody-disk-budget.ts");
const status = await jiti.import("../disk/status.ts");
const gate = await jiti.import("../disk/gate.ts");
const display = await jiti.import("../message-display.ts");
const gateExtension = await jiti.import("./extensions/cody-homelabber-gate.ts");
const contextExtension = await jiti.import("./extensions/cody-context-budget.ts");
const { buildSessionContext } = await jiti.import("../session-reader.ts");

const GiB = 1024 ** 3;
const MINUTE = 60_000;
const TOTALS = { "/fake/tmp": 150 * GiB, "/fake/data": 200 * GiB };
const AREAS = JSON.stringify([{ id: "tmp", path: "/fake/tmp" }, { id: "data", path: "/fake/data" }]);
const SCRATCH = "/fake/tmp/cs/ab12cd34ef56";

/** A made-up disk: each area's share free, a clock, and a count of how often the disk was read. */
function world({ tmp = 0.5, data = 0.5, scratch = SCRATCH, areas = AREAS } = {}) {
  const w = {
    now: 1_000_000,
    free: { "/fake/tmp": tmp, "/fake/data": data },
    reads: 0,
    measured: [],
    size: { bytes: 6.2 * GiB, partial: false },
  };
  w.deps = {
    env: { CODY_DISK_AREAS: areas, ...(scratch ? { CODY_SCRATCH: scratch } : {}) },
    statfs: (path) => {
      w.reads += 1;
      if (!(path in w.free)) throw new Error(`ENOENT: no such file or directory, statfs '${path}'`);
      const blocks = TOTALS[path];
      return { bsize: 1, blocks, bavail: Math.round(blocks * w.free[path]) };
    },
    now: () => w.now,
    measure: (dir) => {
      w.measured.push(dir);
      return w.size;
    },
  };
  w.advance = (ms) => { w.now += ms; };
  return w;
}

/** One agent session loading the extension: what it registered, handler by handler. */
function load(factory) {
  const handlers = {};
  factory({ on: (event, handler) => { (handlers[event] ??= []).push(handler); } });
  return handlers;
}

const main = { agent: { kind: "main" } };
const sub = { agent: { kind: "sub" } };

/**
 * One prompt, the way omp runs it: every `before_agent_start` handler in turn,
 * each given the conversation so far (`entries`) and each allowed ONE message.
 * A `systemPrompt` in any result would be a replaced prompt, which makes omp
 * re-announce its whole tool list as a user message: never.
 */
function prompt(handlers, ctx = main, entries = []) {
  const results = handlers.before_agent_start.map((handler) => handler({ systemPrompt: ["base policy"] }, { ...ctx, sessionManager: { getBranch: () => entries } }));
  for (const result of results) assert.equal("systemPrompt" in result, false, "no system-prompt change, ever");
  const messages = results.flatMap((result) => (result.message ? [result.message] : []));
  return {
    messages,
    rule: messages.find((message) => message.customType === extension.DISK_RULE_CUSTOM_TYPE),
    message: messages.find((message) => message.customType === extension.DISK_LOW_CUSTOM_TYPE),
  };
}

/** A conversation as omp keeps it: what a prompt's handlers return is stored as `custom_message` entries, which the next prompt's handlers read back. */
function chat(handlers, ctx = main) {
  const entries = [];
  return {
    entries,
    prompt() {
      const result = prompt(handlers, ctx, entries);
      for (const message of result.messages) entries.push({ type: "custom_message", id: `m${entries.length}`, ...message });
      return result;
    },
    /** A compaction folds what came before it into a summary. */
    compact() {
      entries.push({ type: "compaction", id: `c${entries.length}`, summary: "…" });
    },
  };
}

const toolResult = (handlers, ctx = main) => handlers.tool_result?.[0]({ toolName: "bash" }, ctx);

// ---------------------------------------------------------------------------
// Pinned to the server's own numbers
// ---------------------------------------------------------------------------

test("the free-space lines, the levels and the hidden line's type are the ones the server uses", () => {
  assert.equal(extension.DISK_LOW_FREE_FRACTION, status.DISK_LOW_FREE_FRACTION);
  assert.equal(extension.DISK_CRITICAL_FREE_FRACTION, status.DISK_CRITICAL_FREE_FRACTION);
  for (const fraction of [0, 0.01, 0.0499, 0.05, 0.0501, 0.1, 0.1499, 0.15, 0.1501, 0.5, 1]) {
    assert.equal(extension.levelFor(fraction), status.levelForFreeFraction(fraction), `${fraction} free`);
  }

  assert.equal(extension.DISK_LOW_CUSTOM_TYPE, gate.DISK_LOW_CUSTOM_TYPE);
  assert.equal(extension.DISK_RULE_CUSTOM_TYPE, "cody-disk-rule");
  for (const type of [extension.DISK_LOW_CUSTOM_TYPE, extension.DISK_RULE_CUSTOM_TYPE]) {
    // The transcript never shows either hidden message, on any path that asks the one predicate ...
    assert.equal(display.isHiddenFromTranscript({ role: "custom", customType: type }), true, type);
    // ... and only them: not a neighbour's type, and not a message that merely carries the type.
    assert.equal(display.isHiddenFromTranscript({ role: "custom", customType: `${type}-x` }), false, type);
    assert.equal(display.isHiddenFromTranscript({ role: "user", customType: type }), false, type);
  }
});

test("the hidden lines leave no trace in a transcript that is reloaded", () => {
  const user = (id, parentId, text) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: text } });
  const assistant = (id, parentId, text) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text }] } });
  const hiddenLine = (id, parentId, customType, content) => ({ type: "custom_message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", customType, content, display: false });
  const without = buildSessionContext([user("u1", null, "first"), assistant("a1", "u1", "reply one"), user("u2", "a1", "second"), assistant("a2", "u2", "reply two")]);
  for (const [customType, content, words] of [
    [extension.DISK_LOW_CUSTOM_TYPE, "Disk space is low: temp space (/tmp) has 10% free (15 GB of 150 GB).", "Disk space is low"],
    [extension.DISK_RULE_CUSTOM_TYPE, "Scratch and disk budget (every session and subagent follows this independently):\n- Throwaway files go in `$TMPDIR`.", "Scratch and disk budget"],
  ]) {
    const withLine = buildSessionContext([user("u1", null, "first"), hiddenLine("d1", "u1", customType, content), assistant("a1", "d1", "reply one"), user("u2", "a1", "second"), assistant("a2", "u2", "reply two")]);
    assert.deepEqual(withLine.entryIds, ["u1", "a1", "u2", "a2"], customType);
    assert.deepEqual(withLine.messages.map((message) => message.role), without.messages.map((message) => message.role), customType);
    assert.equal(JSON.stringify(withLine.messages).includes(words), false, customType);
  }
});

test("reading an area gives the same answer as the server's own reading of the same numbers", () => {
  for (const share of [1, 0.5, 0.1501, 0.15, 0.1499, 0.05, 0.0499, 0.01, 0]) {
    const totalBytes = 150 * GiB;
    const availableBytes = Math.round(totalBytes * share);
    const area = { id: "tmp", path: "/fake/tmp" };
    const [mine] = extension.readAreas([area], () => ({ bsize: 1, blocks: totalBytes, bavail: availableBytes }));
    const [theirs] = status.readDiskAreas(() => ({ totalBytes, availableBytes }), [area]);
    assert.deepEqual(
      { totalBytes: mine.totalBytes, availableBytes: mine.availableBytes, freeFraction: mine.freeFraction, level: mine.level },
      { totalBytes: theirs.totalBytes, availableBytes: theirs.availableBytes, freeFraction: theirs.freeFraction, level: theirs.level },
      `${share} free`,
    );
  }
});

test("an area that cannot be read, or has no size, is left out: unknown space is not empty space", () => {
  const areas = [{ id: "tmp", path: "/fake/tmp" }, { id: "data", path: "/fake/data" }, { id: "x", path: "/nowhere" }];
  const readings = extension.readAreas(areas, (path) => {
    if (path === "/fake/data") return { bsize: 4096, blocks: 0, bavail: 0 };
    if (path === "/nowhere") throw new Error("ENOENT");
    return { bsize: 4096n, blocks: 1000n, bavail: 400n };
  });
  assert.deepEqual(readings.map((reading) => [reading.id, reading.freeFraction, reading.level]), [["tmp", 0.4, "ok"]], "bigint statfs works too");
});

test("CODY_DISK_AREAS is read as the list of {id, path} Cody wrote, and anything else is no areas at all", () => {
  assert.deepEqual(extension.parseAreas(AREAS), [{ id: "tmp", path: "/fake/tmp" }, { id: "data", path: "/fake/data" }]);
  for (const raw of [undefined, "", "not json", "{}", "null", "42", JSON.stringify("tmp")]) assert.deepEqual(extension.parseAreas(raw), [], String(raw));
  assert.deepEqual(
    extension.parseAreas(JSON.stringify([{ id: "tmp", path: "/a" }, { id: "no-path" }, { path: "/no-id" }, { id: "empty", path: "" }, null, "x", { id: 1, path: "/b" }])),
    [{ id: "tmp", path: "/a" }],
    "a damaged entry is skipped, not trusted",
  );
  const many = JSON.stringify(Array.from({ length: 50 }, (_, index) => ({ id: `a${index}`, path: `/p${index}` })));
  assert.equal(extension.parseAreas(many).length, 8, "bounded");
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

const EXPECTED_RULE = [
  "Scratch and disk budget (every session and subagent follows this independently):",
  "- Throwaway files go in your scratch folder, `$CODY_SCRATCH` (it is also `$TMPDIR`). Cody deletes it once the chat has been idle for a few days. Never put anything bigger than a log file in a bare `/fake/tmp/<name>`.",
  "- The budgets are hard limits shared by every session: temp space (`/fake/tmp`) is 150 GB in total and data space (`/fake/data`) is 200 GB in total. When one is full, every session's builds fail. These figures are current: they override any remembered or older figure about `/tmp` or disk sizes.",
  "- Reuse ONE cargo target directory per repo or worktree. Never create a new `*-target` directory per attempt or per review, and never copy a whole repo or stage tree into `/tmp` more than once.",
  "- When the work is finished, delete build output, staged copies, screenshots, recordings and test temp dirs. Tests must use self-cleaning temp dirs (`tmp_path`, `TempDir`, `mkdtemp` plus cleanup).",
  "- Before a big build or copy, run `df -h /fake/tmp /fake/data`. If free space is under 15%, clean up first.",
  "- Toolchains, SDKs and shared virtualenvs go under `$HOME/.cache` or `$HOME/toolchains`, never in scratch.",
  "- Never open, read, search or copy the engine's own data files (`agent.db` and the files beside it in the engine's data folder) with your read, search or eval tools: that can damage the saved logins. Inspect a copy made by a separate `sqlite3` process, or ask the user to use Settings.",
].join("\n");

test("the rule says where scratch is, what the budgets are, and the habits that keep a disk from filling", () => {
  const w = world();
  const handlers = load(extension.createDiskBudget(w.deps));
  const { rule } = prompt(handlers);
  assert.equal(rule.content, EXPECTED_RULE);
  assert.deepEqual(rule, { customType: "cody-disk-rule", content: EXPECTED_RULE, display: false, attribution: "agent" }, "a hidden message for the model, from the engine");
});

test("a chat with a data scratch dir is told to use it for tests that need temp space on the code's disk, and the text stays fixed", () => {
  const w = world();
  w.deps.env.CODY_DATA_SCRATCH = "/fake/data/cody-data-scratch/ab12cd34ef56";
  const rule = prompt(load(extension.createDiskBudget(w.deps))).rule.content;
  const sentence = "- Tests that need temp space on the same disk as the code use `$CODY_DATA_SCRATCH` (Cody deletes it with the chat), never `~/tmp`, `/data/home/tmp` or another fixed folder.";
  assert.equal(rule, EXPECTED_RULE.replace("\n- The budgets", `\n${sentence}\n- The budgets`));
  assert.equal(prompt(load(extension.createDiskBudget(world().deps))).rule.content, EXPECTED_RULE, "without one the rule never names a variable that is not there");
});

test("the figures in the rule come from the disks, and none of it is one machine's own", () => {
  const w = world({ areas: JSON.stringify([{ id: "tmp", path: "/var/tmp" }, { id: "data", path: "/srv/cody data's" }, { id: "cache", path: "/fake/data" }]) });
  w.free["/var/tmp"] = 0.5;
  w.free["/srv/cody data's"] = 0.5;
  TOTALS["/var/tmp"] = 8.4 * GiB;
  TOTALS["/srv/cody data's"] = 1000 * GiB;
  const rule = prompt(load(extension.createDiskBudget(w.deps))).rule.content;
  assert.match(rule, /temp space \(`\/var\/tmp`\) is 8\.4 GB in total, data space \(`\/srv\/cody data's`\) is 1000 GB in total and the `cache` disk \(`\/fake\/data`\) is 200 GB in total\./);
  assert.match(rule, /in a bare `\/var\/tmp\/<name>`/);
  assert.match(rule, /run `df -h \/var\/tmp '\/srv\/cody data'\\''s' \/fake\/data`\./, "a path with a space or a quote in it is safe to paste");
  assert.doesNotMatch(rule, /\/data\/home|nateshome|unraid|\d+ ?G\b(?!B)/i, "no deployment hard-coded, no figure that is not a GB figure read from the disk");
});

test("with no scratch folder the rule says to use the temp folder and to clean up after oneself, not that Cody will", () => {
  const rule = prompt(load(extension.createDiskBudget(world({ scratch: "" }).deps))).rule.content;
  assert.match(rule, /^- Throwaway files go in `\$TMPDIR`; delete them yourself when you are done\./m);
  assert.doesNotMatch(rule, /CODY_SCRATCH|Cody deletes it/);
});

test("with no areas to read the rule still stands, without figures it cannot know", () => {
  for (const areas of ["not json", "[]", undefined]) {
    const w = world({ areas });
    if (areas === undefined) delete w.deps.env.CODY_DISK_AREAS;
    const rule = prompt(load(extension.createDiskBudget(w.deps))).rule.content;
    assert.match(rule, /^Scratch and disk budget/);
    assert.match(rule, /the data folder are each a capped quota/);
    assert.match(rule, /If free space is under 15%, clean up first\./);
    assert.doesNotMatch(rule, / GB in total/, String(areas));
  }
});

test("every agent is given the rule once while its conversation holds it, and again once it does not", () => {
  const handlers = load(extension.createDiskBudget(world().deps));
  assert.deepEqual(Object.keys(handlers), ["before_agent_start", "turn_start"], "no tool hook at load: omp's speculative task launch stays on while every disk is healthy");
  assert.equal(handlers.before_agent_start.length, 2, "the rule and the low-disk line: omp takes one message from each handler");

  for (const ctx of [main, sub]) {
    const conversation = chat(handlers, ctx);
    assert.equal(conversation.prompt().rule.content, EXPECTED_RULE);
    assert.deepEqual(conversation.prompt().messages, [], "the next prompt of the same conversation: present once, not twice");

    conversation.compact();
    assert.equal(conversation.prompt().rule.content, EXPECTED_RULE, "a compaction folded it into a summary: given again");
    assert.deepEqual(conversation.prompt().messages, []);
  }
});

test("other words under the rule's type, a neighbour's note, or a conversation that cannot be read: the rule is given", () => {
  const handlers = load(extension.createDiskBudget(world().deps));
  const note = (content, customType = extension.DISK_RULE_CUSTOM_TYPE) => ({ type: "custom_message", id: "n", customType, content, display: false });
  assert.equal(prompt(handlers, main, [note(EXPECTED_RULE)]).rule, undefined);
  assert.equal(prompt(handlers, main, [note("an older rule")]).rule.content, EXPECTED_RULE, "the figures of another process: the rule in force follows the old one");
  assert.equal(prompt(handlers, main, [note("an older rule"), note(EXPECTED_RULE)]).rule, undefined, "the newest note of the type decides");
  assert.equal(prompt(handlers, main, [note(EXPECTED_RULE), note("an older rule")]).rule.content, EXPECTED_RULE);
  assert.equal(prompt(handlers, main, [note(EXPECTED_RULE, extension.DISK_LOW_CUSTOM_TYPE)]).rule.content, EXPECTED_RULE, "a neighbour's type is not the rule");
  for (const ctx of [{}, { agent: { kind: "sub" } }, { sessionManager: {} }, { sessionManager: { getBranch: () => "not a list" } }, { sessionManager: { getBranch: () => { throw new Error("closed"); } } }]) {
    assert.equal(handlers.before_agent_start[0]({}, ctx).message.content, EXPECTED_RULE, JSON.stringify(ctx));
  }
});

test("the rule is the same text for the whole process, whatever the disks do after the first prompt", () => {
  const w = world();
  const factory = extension.createDiskBudget(w.deps);
  const first = prompt(load(factory)).rule.content;
  TOTALS["/fake/tmp"] = 80 * GiB; // a quota lowered while the process runs
  try {
    w.advance(10 * MINUTE);
    assert.equal(prompt(load(factory)).rule.content, first, "a second agent of the same process reads the same words");
    assert.equal(prompt(load(extension.createDiskBudget(w.deps))).rule.content === first, false, "a new process reads the new figure");
  } finally {
    TOTALS["/fake/tmp"] = 150 * GiB;
  }
});

test("the three extensions that give a note once per live context decide whether it is live the same way", () => {
  const TYPE = "cody-test-note";
  const BODY = "the words";
  const note = (content = BODY, customType = TYPE) => ({ type: "custom_message", id: "n", customType, content, display: false });
  const turn = { type: "message", id: "u", message: { role: "user", content: "carry on" } };
  const cases = [
    ["no branch entries", [], false],
    ["the note is there", [note()], true],
    ["and there is more after it", [note(), turn, turn], true],
    ["other words under the type", [note("other words")], false],
    ["the newest note of the type has the words", [note("other words"), note()], true],
    ["the newest note of the type has other words", [note(), note("other words")], false],
    ["a neighbour's note", [note(BODY, "cody-other-note")], false],
    ["a compaction after it", [note(), turn, { type: "compaction", id: "c" }], false],
    ["a note after the compaction", [note(), { type: "compaction", id: "c" }, note(), turn], true],
    ["a reset boundary after it", [note(), { type: "reset_boundary", id: "r" }], false],
    ["a note after the reset boundary", [note(), { type: "reset_boundary", id: "r" }, note()], true],
    ["entries that are not notes after it", [note(), null, 3, "x", { type: "custom_message" }, { id: "no type" }], true],
    ["content that is not text", [{ ...note(), content: [{ type: "text", text: BODY }] }], false],
    ["a note without content", [{ type: "custom_message", id: "n", customType: TYPE }], false],
  ];
  const copies = { disk: extension.noteIsLive, gate: gateExtension.noteIsLive, context: contextExtension.noteIsLive };
  for (const [name, noteIsLive] of Object.entries(copies)) {
    assert.equal(typeof noteIsLive, "function", name);
    for (const [what, branch, expected] of cases) {
      assert.equal(noteIsLive({ sessionManager: { getBranch: () => branch } }, TYPE, BODY), expected, `${name}: ${what}`);
    }
    // A branch that cannot be read is "not there": a repeated note costs little, a missing rule costs more.
    for (const ctx of [{}, { sessionManager: {} }, { sessionManager: { getBranch: () => undefined } }, { sessionManager: { getBranch: () => "not a list" } }, { sessionManager: { getBranch: () => { throw new Error("closed"); } } }]) {
      assert.equal(noteIsLive(ctx, TYPE, BODY), false, `${name}: ${JSON.stringify(ctx)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The notes
// ---------------------------------------------------------------------------

test("on a healthy disk nobody is told anything and no tool hook is ever added", () => {
  const w = world({ tmp: 0.5, data: 0.15 }); // exactly at the low line is not low
  const handlers = load(extension.createDiskBudget(w.deps));
  for (let turn = 0; turn < 5; turn += 1) {
    const result = prompt(handlers);
    assert.equal(result.message, undefined);
    handlers.turn_start[0]({}, main);
    w.advance(2 * MINUTE);
  }
  assert.equal(handlers.tool_result, undefined);
});

test("a low disk gives the main agent one hidden line with its prompt, naming the disk, its free space and its own scratch", () => {
  const w = world({ tmp: 0.1 });
  const handlers = load(extension.createDiskBudget(w.deps));
  const { message } = prompt(handlers);

  assert.equal(message.customType, "cody-disk-low");
  assert.equal(message.display, false, "never a bubble");
  assert.equal(message.attribution, "agent", "an engine note, not something the user said");
  assert.deepEqual(message.details, { level: "low", areas: [{ id: "tmp", freeFraction: 0.1 }] });
  assert.equal(
    message.content,
    "Disk space is low: temp space (/fake/tmp) has 10% free (15 GB of 150 GB). Your scratch folder ($CODY_SCRATCH) holds 6.2 GB. Clean up now: delete build output, staged copies, screenshots, recordings and test temp dirs you no longer need.",
  );
  assert.deepEqual(w.measured, [SCRATCH], "it is this session's own scratch that was measured");
});

test("a main agent on a low disk is given the rule and the line, one message each, the rule first", () => {
  const w = world({ tmp: 0.1 });
  const conversation = chat(load(extension.createDiskBudget(w.deps)));
  assert.deepEqual(conversation.prompt().messages.map((message) => message.customType), ["cody-disk-rule", "cody-disk-low"]);
  w.advance(16 * MINUTE);
  assert.deepEqual(conversation.prompt().messages.map((message) => message.customType), ["cody-disk-low"], "the rule was given; the disk is still low and it is time to say so again");
});

test("a critical disk says that Cody has stopped new work, and tells the agent what to do about it", () => {
  const w = world({ tmp: 0.5, data: 0.03 });
  const { message } = prompt(load(extension.createDiskBudget(w.deps)));
  assert.equal(message.details.level, "critical");
  assert.equal(
    message.content,
    "Disk space is critically low: data space (/fake/data) has 3% free (6 GB of 200 GB), and Cody has stopped starting new work. Your scratch folder ($CODY_SCRATCH) holds 6.2 GB. Stop large builds and copies and delete what you no longer need now, then tell the user what you removed.",
  );
});

test("when both disks are low both are named, the fuller one first, and the worse level decides the wording", () => {
  const w = world({ tmp: 0.12, data: 0.04 });
  const { message } = prompt(load(extension.createDiskBudget(w.deps)));
  assert.match(message.content, /^Disk space is critically low: data space \(\/fake\/data\) has 4% free \(8 GB of 200 GB\) and temp space \(\/fake\/tmp\) has 12% free \(18 GB of 150 GB\), and Cody has stopped/);
  assert.deepEqual(message.details.areas.map((area) => area.id), ["data", "tmp"]);
});

test("the scratch size says 'at least' when the walk had to stop, and the sentence is left out when there is no scratch folder", () => {
  const w = world({ tmp: 0.1 });
  w.size = { bytes: 3 * GiB, partial: true };
  assert.match(prompt(load(extension.createDiskBudget(w.deps))).message.content, /holds at least 3 GB\./);

  w.size = { bytes: 40 * 1024 * 1024, partial: false };
  assert.match(prompt(load(extension.createDiskBudget(w.deps))).message.content, /holds 40 MB\./, "a small folder is told in MB");

  const noScratch = world({ tmp: 0.1, scratch: "" });
  const { message } = prompt(load(extension.createDiskBudget(noScratch.deps)));
  assert.doesNotMatch(message.content, /scratch folder/);
  assert.deepEqual(noScratch.measured, [], "and nothing is walked");
});

test("subagents get the rule but not the hidden line, and still learn of a low disk from their tool results", () => {
  const w = world({ tmp: 0.1 });
  const handlers = load(extension.createDiskBudget(w.deps));
  const result = prompt(handlers, sub);
  assert.deepEqual(result.messages.map((message) => message.customType), ["cody-disk-rule"], "the rule, and nothing else");
  assert.equal(result.message, undefined, "no hidden line in a subagent's transcript");

  const note = toolResult(handlers, sub);
  assert.match(note.additionalContext, /^Disk space is low: temp space \(\/fake\/tmp\) has 10% free/);
  assert.deepEqual(Object.keys(note), ["additionalContext"], "context for the next request only: the tool's own result is not touched");
});

test("a note goes out at most every 15 minutes while a disk is low and every 5 while it is critical, from either place", () => {
  const w = world({ tmp: 0.1 });
  const handlers = load(extension.createDiskBudget(w.deps));
  assert.ok(prompt(handlers).message, "with the prompt");
  assert.equal(toolResult(handlers), undefined, "the tool call right after is not told again");

  w.advance(14 * MINUTE);
  assert.equal(toolResult(handlers), undefined, "not within 15 minutes");
  assert.equal(prompt(handlers).message, undefined, "nor with another prompt");

  w.advance(1 * MINUTE);
  assert.ok(toolResult(handlers).additionalContext, "at 15 minutes it is told again");
  assert.equal(prompt(handlers).message, undefined, "and the prompt that follows shares that clock");

  // Getting worse is told at once, however recent the last note.
  w.free["/fake/tmp"] = 0.03;
  w.advance(1 * MINUTE);
  const worse = toolResult(handlers);
  assert.match(worse.additionalContext, /^Disk space is critically low/);
  w.advance(4 * MINUTE);
  assert.equal(toolResult(handlers), undefined, "then every 5 minutes at most while critical");
  w.advance(1 * MINUTE);
  assert.match(toolResult(handlers).additionalContext, /^Disk space is critically low/);

  // Getting better is not an alarm: back to low, the slower clock applies, counted from the last note.
  w.free["/fake/tmp"] = 0.1;
  w.advance(5 * MINUTE);
  assert.equal(toolResult(handlers), undefined, "low again, five minutes after a critical note: not yet");
  w.advance(10 * MINUTE);
  assert.match(toolResult(handlers).additionalContext, /^Disk space is low:/, "fifteen minutes after it");
  w.advance(14 * MINUTE);
  assert.equal(toolResult(handlers), undefined, "and then it waits another 15");
});

test("each agent has its own clock, so a subagent that was never told is told", () => {
  const w = world({ tmp: 0.1 });
  const factory = extension.createDiskBudget(w.deps);
  const parent = load(factory);
  const child = load(factory);
  assert.ok(prompt(parent).message);
  assert.equal(toolResult(parent), undefined);
  prompt(child, sub);
  assert.ok(toolResult(child, sub), "the parent's note was not the subagent's");
});

test("the disk is read at most once a minute, however many prompts and tool calls there are", () => {
  const w = world({ tmp: 0.1 });
  const handlers = load(extension.createDiskBudget(w.deps));
  prompt(handlers);
  const afterRule = w.reads;
  for (let call = 0; call < 50; call += 1) {
    toolResult(handlers);
    handlers.turn_start[0]({}, main);
    w.advance(1_000);
  }
  // 50 seconds on: the rule's one reading, and the one probe, and nothing more.
  assert.equal(w.reads, afterRule, "nothing was read again inside the minute");

  w.advance(15_000);
  toolResult(handlers);
  assert.equal(w.reads, afterRule + 2, "a minute on, one more look at the two areas");
});

test("a disk that fills in the middle of a long turn is noticed at its next turn, and one that clears stops being mentioned", () => {
  const w = world({ tmp: 0.5 });
  const handlers = load(extension.createDiskBudget(w.deps));
  assert.equal(prompt(handlers).message, undefined);
  assert.equal(handlers.tool_result, undefined);

  // Hours of one turn later: no new prompt, but the turn goes on.
  w.advance(3 * 60 * MINUTE);
  w.free["/fake/tmp"] = 0.1;
  handlers.turn_start[0]({}, main);
  assert.equal(handlers.tool_result.length, 1, "added now, once a disk has been seen low");
  assert.match(toolResult(handlers).additionalContext, /^Disk space is low/);
  handlers.turn_start[0]({}, main);
  assert.equal(handlers.tool_result.length, 1, "and only once");

  // Room is made: after the next look the hook says nothing.
  w.free["/fake/tmp"] = 0.6;
  w.advance(16 * MINUTE);
  assert.equal(toolResult(handlers), undefined);
});

test("a handler that cannot read anything never throws into the agent", () => {
  const w = world({ tmp: 0.1 });
  w.deps.statfs = () => { throw new Error("EIO"); };
  const handlers = load(extension.createDiskBudget(w.deps));
  const result = prompt(handlers);
  assert.equal(result.message, undefined);
  assert.match(result.rule.content, /^Scratch and disk budget/, "the rule still stands");
  assert.equal(handlers.tool_result, undefined);
});

test("the extension omp loads registers its two hooks and is a plain factory", () => {
  assert.equal(typeof extension.default, "function");
  assert.deepEqual(Object.keys(load(extension.default)), ["before_agent_start", "turn_start"]);
});

// ---------------------------------------------------------------------------
// Measuring a scratch folder
// ---------------------------------------------------------------------------

test("a folder is measured by its files' sizes, a hard link once, symlinks are never followed, and nothing unreadable is an error", () => {
  const dir = join(root, "measured");
  mkdirSync(join(dir, "a", "deep"), { recursive: true });
  mkdirSync(join(dir, "empty"));
  writeFileSync(join(dir, "one.bin"), randomBytes(300 * 1024));
  writeFileSync(join(dir, "a", "two.bin"), randomBytes(200 * 1024));
  writeFileSync(join(dir, "a", "deep", "three.bin"), randomBytes(100 * 1024));
  // The same file under two names is one file's worth.
  writeFileSync(join(dir, "a", "linked-1.bin"), randomBytes(50 * 1024));
  linkSync(join(dir, "a", "linked-1.bin"), join(dir, "empty", "linked-2.bin"));
  // A link to something big outside the folder must not be counted, nor walked into.
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "big.bin"), randomBytes(8 * 1024 * 1024));
  symlinkSync(outside, join(dir, "link-to-dir"));
  symlinkSync(join(outside, "big.bin"), join(dir, "link-to-file"));

  const size = extension.measureFolder(dir);
  assert.equal(size.partial, false);
  const files = (300 + 200 + 100 + 50) * 1024;
  const links = Buffer.byteLength(outside) + Buffer.byteLength(join(outside, "big.bin"));
  assert.equal(size.bytes, files + links, "the four files, once each, and the two links as the links they are, not the 8 MB behind them");

  assert.deepEqual(extension.measureFolder(join(root, "never-made")), { bytes: 0, partial: false });
});

test("a walk stops at its entry bound, and at its time bound, and then says 'at least'", () => {
  const dir = join(root, "crowded");
  mkdirSync(dir);
  for (let index = 0; index < 1100; index += 1) writeFileSync(join(dir, `f${index}`), "x");

  const whole = extension.measureFolder(dir);
  assert.equal(whole.partial, false);
  assert.ok(whole.bytes > 0);

  const few = extension.measureFolder(dir, { maxEntries: 10, maxMs: 60_000 });
  assert.equal(few.partial, true, "ten entries of eleven hundred");
  assert.ok(few.bytes <= whole.bytes);

  // A clock that jumps five seconds each time it is asked: past a one-second budget at the first check.
  let clock = 0;
  const late = extension.measureFolder(dir, { maxEntries: 1_000_000, maxMs: 1_000 }, () => (clock += 5_000));
  assert.equal(late.partial, true);

  // The real bounds are the ones the plan names.
  assert.equal(extension.SCRATCH_WALK_MAX_ENTRIES, 200_000);
});
