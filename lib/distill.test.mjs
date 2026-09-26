import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Distill's server half: the model chain, the summary cache, the fallback
 * order and the NDJSON reducer.
 *
 * The rule most of these pin is FALL THROUGH, NEVER FAIL HARD. Distill points
 * Cody-owned selectors at an engine whose catalog and event vocabulary Cody
 * does not control, so every way an attempt can go wrong — a model the engine
 * no longer knows, a non-zero exit, an empty answer, a renamed frame type —
 * has to degrade into "try the next one" and finally into "no summary", never
 * into an error the reader sees instead of their own text.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-distill-"));
// Before the first import: these modules resolve the instance data dir at
// call time, but a module that touched it at load time would write into the
// operator's live appdata (see the checkpoint trap in AGENTS.md).
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OMP_PROFILE = "";
process.env.PI_PROFILE = "";
process.on("exit", () => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const config = await jiti.import("./distill/config.ts");
const cache = await jiti.import("./distill/cache.ts");
const prompts = await jiti.import("./distill/prompts.ts");
const runner = await jiti.import("./distill/runner.ts");
const oneShot = await jiti.import("./model-plan/one-shot.ts");

/* ------------------------------------------------------------------ chain */

test("a selector is validated syntactically and nothing more", () => {
  assert.equal(config.isValidSelector("anthropic/claude-opus-4"), true);
  assert.equal(config.isValidSelector("openai/gpt-5:high"), true);
  // Cody must not hold an opinion about which models exist: a model this
  // build has never heard of is a perfectly valid selector, because the
  // catalog belongs to the engine and changes under it.
  assert.equal(config.isValidSelector("someprovider/model-from-2027"), true);

  assert.equal(config.isValidSelector(""), false);
  assert.equal(config.isValidSelector("   "), false);
  assert.equal(config.isValidSelector("no-slash"), false);
  assert.equal(config.isValidSelector("/leading"), false);
  assert.equal(config.isValidSelector("trailing/"), false);
  assert.equal(config.isValidSelector("has space/model"), false);
  assert.equal(config.isValidSelector(42), false);
  assert.equal(config.isValidSelector(null), false);
});

test("a saved chain keeps its order, drops duplicates and survives a reread", () => {
  assert.deepEqual(config.readDistillChain(), [], "nothing configured yet");

  const stored = config.writeDistillChain([" a/one ", "b/two:high", "a/one", "c/three"]);
  assert.deepEqual(stored, ["a/one", "b/two:high", "c/three"], "order is the fallback order");
  assert.deepEqual(config.readDistillChain(), ["a/one", "b/two:high", "c/three"]);

  const file = path.join(agentDir, "cody-distill.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the chain is written 0600");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    chain: ["a/one", "b/two:high", "c/three"],
  });
});

test("a corrupt or hand-edited chain file reads as no configuration", () => {
  const file = path.join(agentDir, "cody-distill.json");
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(config.readDistillChain(), []);

  fs.writeFileSync(file, JSON.stringify({ version: 1, chain: ["ok/one", 7, "", "bad", "ok/two"] }));
  assert.deepEqual(config.readDistillChain(), ["ok/one", "ok/two"], "junk entries are skipped, not fatal");

  config.writeDistillChain([]);
  assert.deepEqual(config.readDistillChain(), []);
});

test("the write path reports a malformed selector instead of silently dropping it", () => {
  assert.deepEqual(config.validateChain(["a/one", "b/two"]), { chain: ["a/one", "b/two"] });
  assert.deepEqual(config.validateChain([]), { chain: [] });
  assert.match(config.validateChain(["a/one", "nope"]).error, /not a model selector/);
  assert.match(config.validateChain("a/one").error, /must be an array/);
  const tooMany = Array.from({ length: config.MAX_CHAIN_LENGTH + 1 }, (_, i) => `p/m${i}`);
  assert.match(config.validateChain(tooMany).error, /at most/);
});

/* ------------------------------------------------------------- truncation */

test("oversized text keeps its head and its tail with a marker between", () => {
  const head = "A".repeat(prompts.HEAD_CHARS);
  const middle = "M".repeat(50_000);
  const tail = "Z".repeat(prompts.TAIL_CHARS);
  const clamped = prompts.clampText(head + middle + tail);

  assert.equal(clamped.includes("M"), false, "the middle is what gets dropped");
  assert.ok(clamped.startsWith("A".repeat(1000)));
  assert.ok(clamped.endsWith("Z".repeat(1000)));
  assert.ok(clamped.includes(prompts.TRUNCATION_MARKER));
  assert.equal(clamped.length, prompts.HEAD_CHARS + prompts.TRUNCATION_MARKER.length + prompts.TAIL_CHARS);

  const short = "x".repeat(prompts.MAX_TEXT_CHARS);
  assert.equal(prompts.clampText(short), short, "text at the budget is untouched");
});

/** A code unit in 0xD800-0xDFFF with no partner: what a careless slice leaves
 * behind, and what a model receives as a replacement character. */
function loneSurrogateAt(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return index;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return index;
    }
  }
  return -1;
}

test("neither cut lands in the middle of a surrogate pair", () => {
  // An emoji straddling the HEAD boundary (its lead unit is the last one the
  // head would include) and another straddling the TAIL boundary (its trail
  // unit is the first one the tail would include) — the two ends fail in
  // opposite directions, so one range check cannot cover both.
  const text = `${"a".repeat(prompts.HEAD_CHARS - 1)}😀${"Q".repeat(50_000)}😀${"z".repeat(prompts.TAIL_CHARS - 1)}`;
  assert.ok(text.charCodeAt(prompts.HEAD_CHARS - 1) >= 0xd800, "fixture: head boundary is a lead surrogate");
  assert.ok(text.charCodeAt(text.length - prompts.TAIL_CHARS) >= 0xdc00, "fixture: tail boundary is a trail surrogate");

  const clamped = prompts.clampText(text);
  assert.equal(loneSurrogateAt(clamped), -1, "no half of a pair survives the cut");
  assert.equal(clamped.includes("Q"), false);
  assert.ok(clamped.startsWith("aaa"));
  assert.ok(clamped.endsWith("zzz"));

  const capped = prompts.normalizeThinkingSummary("😀".repeat(prompts.MAX_THINKING_CHARS));
  assert.equal(loneSurrogateAt(capped.slice(0, -1)), -1, "the one-line cap cuts on a pair boundary too");
});

test("a thinking summary is forced onto one line", () => {
  assert.equal(prompts.normalizeThinkingSummary('  "Reading the namer."\n'), "Reading the namer.");
  assert.equal(prompts.normalizeThinkingSummary("Summary: weighing\n  two options"), "weighing two options");
  const long = prompts.normalizeThinkingSummary(`${"word ".repeat(80)}end`);
  assert.ok(long.length <= prompts.MAX_THINKING_CHARS, `${long.length} chars`);
  assert.ok(long.endsWith("…"));
});

test("the reply prompt carries the verbosity it was asked for, thinking ignores it", () => {
  const low = prompts.buildDistillPrompt("reply", "low", "body");
  const high = prompts.buildDistillPrompt("reply", "high", "body");
  assert.match(low.systemPrompt, /1 to 3 sentences/);
  assert.match(high.systemPrompt, /half the length/);
  assert.notEqual(low.systemPrompt, high.systemPrompt);

  const thinking = prompts.buildDistillPrompt("thinking", "high", "body");
  assert.match(thinking.systemPrompt, /ONE sentence/);
  assert.equal(thinking.systemPrompt, prompts.buildDistillPrompt("thinking", undefined, "body").systemPrompt);
});

test("the material is fenced and the task is restated after it closes", () => {
  const { prompt } = prompts.buildDistillPrompt("thinking", undefined, "I need to find the bug. I will check the file next.");
  const openTag = prompt.indexOf("<assistant_reasoning>");
  const closeTag = prompt.indexOf("</assistant_reasoning>");
  const materialAt = prompt.indexOf("I need to find the bug");
  assert.ok(openTag >= 0 && closeTag > openTag, "the material has a real opening and closing tag");
  assert.ok(materialAt > openTag && materialAt < closeTag, "the material sits inside its own tag, not outside it");
  assert.match(prompt.slice(closeTag).toLowerCase(), /task/, "the task is restated only AFTER the material closes");
});

test("plain language changes the system prompt but not the material or its fence", () => {
  const normal = prompts.buildDistillPrompt("thinking", undefined, "reasoning text");
  const plain = prompts.buildDistillPrompt("thinking", undefined, "reasoning text", true);
  assert.notEqual(normal.systemPrompt, plain.systemPrompt);
  assert.match(plain.systemPrompt, /everyday words/);
  assert.equal(normal.prompt, plain.prompt, "the material and the restated task are identical either way");

  const replyNormal = prompts.buildDistillPrompt("reply", "medium", "answer text");
  const replyPlain = prompts.buildDistillPrompt("reply", "medium", "answer text", true);
  assert.notEqual(replyNormal.systemPrompt, replyPlain.systemPrompt);
  assert.match(replyPlain.systemPrompt, /not a programmer/);
  assert.match(replyPlain.systemPrompt, /never paraphrase/);
});

test("looksLikeReplyNotDescription catches the clear self-referential opens, not ordinary descriptions", () => {
  for (const bad of [
    "I don't have tools available to search the codebase, but here is my best guess.",
    "Sure, I can help with that — let me take a look.",
    "I'll check the file for you and report back.",
    "My understanding is that the bug is elsewhere.",
  ]) assert.equal(prompts.looksLikeReplyNotDescription(bad), true, bad);
  for (const good of [
    "Checking how the session namer picks its model.",
    "Reading the composer's outbox module before wiring retries.",
    "Deciding whether the cache key needs a fifth segment.",
  ]) assert.equal(prompts.looksLikeReplyNotDescription(good), false, good);
});

/* ------------------------------------------------------------------ cache */

test("the cache key is entry, block, kind, verbosity and plain vs normal", () => {
  assert.equal(cache.distillCacheKey("e1", 2, "thinking", undefined, false), "e1:2:thinking:-:-");
  assert.equal(cache.distillCacheKey("e1", undefined, "reply", "low", false), "e1:-:reply:low:-");
  assert.equal(cache.distillCacheKey("e1", 2, "thinking", undefined, true), "e1:2:thinking:-:plain");
  assert.notEqual(
    cache.distillCacheKey("e1", 2, "thinking", undefined, true),
    cache.distillCacheKey("e1", 2, "thinking", undefined, false),
    "a plain-language summary must never collide with the technical one for the same block",
  );
});

test("a stored summary comes back for its own key and no other", () => {
  const entry = { text: "short version", model: "a/one", at: 1_000 };
  cache.writeDistillCache("sess-1", cache.distillCacheKey("e1", 0, "reply", "low", false), entry);

  assert.deepEqual(cache.readDistillCache("sess-1", "e1:0:reply:low:-"), entry);
  assert.equal(cache.readDistillCache("sess-1", "e1:0:reply:high:-"), null, "verbosity is part of the key");
  assert.equal(cache.readDistillCache("sess-1", "e1:1:reply:low:-"), null, "block index is part of the key");
  assert.equal(cache.readDistillCache("sess-2", "e1:0:reply:low:-"), null, "sessions do not share a file");
  assert.equal(cache.readDistillCache("sess-1", "e1:0:reply:low:plain"), null, "plain and normal never share a cache entry");

  const file = path.join(agentDir, "cody-distill", "sess-1.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a session cache drops its oldest entries at the cap", () => {
  const total = cache.MAX_CACHE_ENTRIES + 3;
  for (let index = 0; index < total; index += 1) {
    cache.writeDistillCache("sess-cap", `e${index}:-:reply:low`, {
      text: `s${index}`,
      model: "a/one",
      at: 1_000 + index,
    });
  }
  const entries = JSON.parse(fs.readFileSync(path.join(agentDir, "cody-distill", "sess-cap.json"), "utf8")).entries;
  assert.equal(Object.keys(entries).length, cache.MAX_CACHE_ENTRIES);
  assert.equal(cache.readDistillCache("sess-cap", "e0:-:reply:low"), null, "the oldest is gone");
  assert.equal(cache.readDistillCache("sess-cap", "e2:-:reply:low"), null);
  assert.ok(cache.readDistillCache("sess-cap", `e${total - 1}:-:reply:low`), "the newest survives");
});

test("a session id that is not a plain id is never turned into a path", () => {
  cache.writeDistillCache("../escape", "e1:-:reply:low", { text: "x", model: "a/one", at: 1 });
  assert.equal(cache.readDistillCache("../escape", "e1:-:reply:low"), null);
  assert.equal(fs.existsSync(path.join(agentDir, "escape.json")), false);
});

/* ------------------------------------------------------------------ chain */

/** Records what it was asked to run and answers from a script. */
function fakeAttempt(script) {
  const calls = [];
  const attempt = async (input) => {
    calls.push(input.model);
    const step = script[calls.length - 1] ?? { error: "no more scripted answers" };
    for (const delta of step.deltas ?? []) input.onDelta(delta);
    return { text: step.text ?? null, error: step.error ?? null };
  };
  return { attempt, calls };
}

test("the chain is tried in order and the winner is reported", async () => {
  const { attempt, calls } = fakeAttempt([
    { error: "could not run omp: spawn ENOENT" },
    { text: "the summary" },
  ]);
  const result = await runner.runDistillChain({
    chain: ["a/one", "b/two"],
    kind: "reply",
    verbosity: "low",
    text: "long answer",
    attempt,
    onDelta: () => {},
  });
  assert.deepEqual(result, { ok: true, text: "the summary", model: "b/two" });
  assert.deepEqual(calls, ["a/one", "b/two"], "primary first, then the fallback");
});

test("a model the engine no longer knows falls through like any other failure", async () => {
  // Three shapes of the same event: an unknown-model exit, a non-zero exit
  // with no frames, and a run that answered nothing at all.
  const { attempt, calls } = fakeAttempt([
    { error: "omp produced no output (exit 1): unknown model \"gone/model\"" },
    { error: "omp produced no output (exit 2)" },
    { text: "   " },
    { text: "engine default won" },
  ]);
  const result = await runner.runDistillChain({
    chain: ["gone/model", "broken/one", "empty/one"],
    kind: "reply",
    verbosity: "medium",
    text: "long answer",
    attempt,
    onDelta: () => {},
  });
  assert.deepEqual(result, { ok: true, text: "engine default won", model: "" });
  assert.deepEqual(calls, ["gone/model", "broken/one", "empty/one", undefined],
    "after the last selector, the engine's own default is tried with no model at all");
});

test("a thinking answer that addresses the reader instead of describing the material falls through", async () => {
  const { attempt, calls } = fakeAttempt([
    { text: "I don't have tools available to look at that file, but here is what I would check." },
    { text: "Reading the config loader before wiring the fallback chain." },
  ]);
  const result = await runner.runDistillChain({
    chain: ["broken/model"],
    kind: "thinking",
    text: "reasoning",
    attempt,
    onDelta: () => {},
  });
  assert.deepEqual(result, { ok: true, text: "Reading the config loader before wiring the fallback chain.", model: "" });
  assert.deepEqual(calls, ["broken/model", undefined], "the self-referential answer is treated as a failed attempt, not accepted");
});

test("plain reaches the prompt the attempt receives", async () => {
  const seen = [];
  const attempt = async (input) => { seen.push(input.systemPrompt); return { text: "answer", error: null }; };
  await runner.runDistillChain({
    chain: [], kind: "reply", verbosity: "low", text: "body", attempt, onDelta: () => {}, plain: true,
  });
  assert.match(seen[0], /not a programmer/, "plain:true selects the plain-language system prompt");
});

test("an empty chain goes straight to the engine default", async () => {
  const { attempt, calls } = fakeAttempt([{ text: "default answer" }]);
  const result = await runner.runDistillChain({
    chain: [],
    kind: "reply",
    verbosity: "low",
    text: "long answer",
    attempt,
    onDelta: () => {},
  });
  assert.deepEqual(result, { ok: true, text: "default answer", model: "" });
  assert.deepEqual(calls, [undefined]);
});

test("everything failing is a value, not a throw", async () => {
  const { attempt, calls } = fakeAttempt([
    { error: "first died" },
    { error: "the model did not answer within 60s" },
  ]);
  const result = await runner.runDistillChain({
    chain: ["a/one"],
    kind: "reply",
    verbosity: "low",
    text: "long answer",
    attempt,
    onDelta: () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /did not answer within 60s/, "the last failure is what is reported");
  assert.deepEqual(calls, ["a/one", undefined]);
});

test("a thinking distill is normalized to one line by the chain", async () => {
  const { attempt } = fakeAttempt([{ text: '  "Reading the session namer\nfirst."  ' }]);
  const result = await runner.runDistillChain({
    chain: [],
    kind: "thinking",
    text: "reasoning",
    attempt,
    onDelta: () => {},
  });
  assert.deepEqual(result, { ok: true, text: "Reading the session namer first.", model: "" });
});

test("a failed attempt's deltas are not replayed by the next one", async () => {
  const { attempt } = fakeAttempt([
    { deltas: ["half a "], error: "died mid-stream" },
    { deltas: ["a completely ", "different answer"], text: "a completely different answer" },
  ]);
  const seen = [];
  const result = await runner.runDistillChain({
    chain: ["a/one"],
    kind: "reply",
    verbosity: "low",
    text: "long answer",
    attempt,
    onDelta: (delta) => seen.push(delta),
  });
  assert.deepEqual(seen, ["half a "], "the retry streams nothing; its `done` replaces what was painted");
  assert.equal(result.text, "a completely different answer");
});

test("a thinking distill streams nothing: the collapsed box gets one done", async () => {
  // The client draws a single line. Streaming the model's raw text would
  // paint a paragraph there and then snap it to the normalized sentence.
  const { attempt } = fakeAttempt([{ deltas: ["Reading ", "the namer\nand the roles"], text: "Reading the namer." }]);
  const seen = [];
  const result = await runner.runDistillChain({
    chain: [],
    kind: "thinking",
    text: "reasoning",
    attempt,
    onDelta: (delta) => seen.push(delta),
  });
  assert.deepEqual(seen, []);
  assert.equal(result.text, "Reading the namer.");
});

/* ------------------------------------------------------------------ queue */

test("two distills run at once and a queued thinking request is superseded", async () => {
  const gates = [];
  const hold = () => {
    const { promise, resolve } = Promise.withResolvers();
    gates.push(resolve);
    return promise;
  };

  const started = [];
  const slot = (key, label) => runner.withDistillSlot(key, async () => {
    started.push(label);
    await hold();
    return label;
  });

  // Slots are taken synchronously; the task bodies start a microtask later.
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const first = slot(null, "running-1");
  const second = slot(null, "running-2");
  const key = "sess:entry:0";
  const stale = slot(key, "queued-old");
  const fresh = slot(key, "queued-new");
  const other = slot("sess:entry:1", "queued-other");

  await assert.rejects(stale, (error) => error instanceof runner.DistillSupersededError);
  await tick();
  assert.deepEqual(started, ["running-1", "running-2"], "the limit is two, and nothing queued started");
  assert.deepEqual(runner.distillQueueDepth(), { running: 2, waiting: 2 });

  gates.shift()();
  gates.shift()();
  assert.equal(await first, "running-1");
  assert.equal(await second, "running-2");

  // The two survivors now hold the slots.
  await tick();
  while (gates.length) gates.shift()();
  assert.equal(await fresh, "queued-new");
  assert.equal(await other, "queued-other");
  assert.deepEqual(started, ["running-1", "running-2", "queued-new", "queued-other"]);
  assert.deepEqual(runner.distillQueueDepth(), { running: 0, waiting: 0 }, "every slot is handed back");
});

/* --------------------------------------------------- NDJSON, fail-soft */

const frame = (type, text) => JSON.stringify({
  type,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

test("streaming frames become deltas and the last turn is the answer", () => {
  const deltas = [];
  const reader = oneShot.createFrameReader((delta) => deltas.push(delta));
  reader.consume(frame("message_start", "Hel"));
  reader.consume(frame("message_update", "Hello"));
  reader.consume(frame("message_update", "Hello wor"));
  reader.consume(frame("turn_end", "Hello world"));

  assert.deepEqual(deltas, ["Hel", "lo", " wor", "ld"], "each frame carries the whole message; only the tail is new");
  assert.equal(reader.answer(), "Hello world");
});

test("unknown, renamed and malformed frames are ignored, and the answer still lands", () => {
  const deltas = [];
  const reader = oneShot.createFrameReader((delta) => deltas.push(delta));
  reader.consume("");
  reader.consume("not json at all");
  reader.consume("[]");
  reader.consume(JSON.stringify({ type: "session", sessionId: "s" }));
  reader.consume(JSON.stringify({ type: "notice", text: "hi" }));
  // A future engine renames the streaming frame, and invents a new one that
  // carries assistant-looking text.
  reader.consume(frame("message_delta_v2", "ghost text"));
  reader.consume(JSON.stringify({ type: "message_update", message: "a bare string" }));
  reader.consume(JSON.stringify({ type: "message_update", message: { role: "user", content: [] } }));
  reader.consume(frame("turn_end", "the real answer"));

  assert.deepEqual(deltas, ["the real answer"], "no delta was recognized until the terminal frame");
  assert.equal(reader.answer(), "the real answer");
  assert.equal(reader.sawFrame(), true);
});

test("a run whose every frame is unrecognized answers nothing rather than something wrong", () => {
  const reader = oneShot.createFrameReader(() => {
    throw new Error("no delta should be reported");
  });
  reader.consume(frame("turn_finished_v2", "renamed terminal frame"));
  reader.consume(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] } }));

  assert.equal(reader.sawFrame(), true, "frames arrived");
  assert.equal(reader.answer(), null, "but none of them was an answer, so the chain falls through");
});

test("message_end is the fallback when a run ends without a turn frame", () => {
  const reader = oneShot.createFrameReader();
  reader.consume(frame("message_end", "only a message"));
  assert.equal(reader.answer(), "only a message");
});

test("a rewritten message reports no delta rather than duplicated text", () => {
  const deltas = [];
  const reader = oneShot.createFrameReader((delta) => deltas.push(delta));
  reader.consume(frame("message_update", "first attempt"));
  reader.consume(frame("message_update", "something else entirely"));
  reader.consume(frame("turn_end", "something else entirely"));

  assert.deepEqual(deltas, ["first attempt"]);
  assert.equal(reader.answer(), "something else entirely", "the answer is always the whole text");
});

/* ------------------------------------------------- the real spawn path */

/** A stand-in for the engine binary: prints the frames it is told to and
 * exits with the code it is told to. Spawned exactly as omp would be, so this
 * exercises argv, the pipe and the line splitting for real. */
function fakeBin(name, body) {
  const file = path.join(agentDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

test("a streaming one-shot reports deltas as they arrive and the full text at the end", async () => {
  const bin = fakeBin("fake-omp-ok.mjs", `
    const frames = [
      { type: "session", sessionId: "x" },
      { type: "brand_new_frame_type", payload: 1 },
      ${JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Checking" }] } })},
      ${JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Checking the namer" }] } })},
      ${JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Checking the namer first." }] } })},
    ];
    for (const f of frames) process.stdout.write(JSON.stringify(f) + "\\n");
  `);

  const deltas = [];
  const result = await oneShot.runOneShotModelStreaming({
    bin,
    model: "a/one",
    systemPrompt: "sys",
    prompt: "user",
    timeoutMs: 15_000,
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(result.error, null);
  assert.equal(result.text, "Checking the namer first.");
  assert.deepEqual(deltas, ["Checking", " the namer", " first."]);
});

test("a binary that exits non-zero with no frames is an error value, never a throw", async () => {
  const bin = fakeBin("fake-omp-fail.mjs", `
    process.stderr.write("unknown model\\n");
    process.exit(1);
  `);
  const result = await oneShot.runOneShotModelStreaming({
    bin,
    model: "gone/model",
    systemPrompt: "sys",
    prompt: "user",
    timeoutMs: 15_000,
    onDelta: () => {},
  });
  assert.equal(result.text, null);
  assert.match(result.error, /exit 1.*unknown model/s);
});

test("a binary that is not there is an error value too", async () => {
  const result = await oneShot.runOneShotModelStreaming({
    bin: path.join(agentDir, "no-such-binary"),
    systemPrompt: "sys",
    prompt: "user",
    timeoutMs: 15_000,
    onDelta: () => {},
  });
  assert.equal(result.text, null);
  assert.match(result.error, /could not run omp/);
});

test("a run whose caller already walked away never starts a child", async () => {
  // An AbortSignal that fired BEFORE the listener was attached delivers no
  // event, so without an explicit check the spawn happens anyway and the
  // child holds a slot for its whole timeout.
  const marker = path.join(agentDir, "spawned.marker");
  const bin = fakeBin("fake-omp-abort.mjs", `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "spawned");
  `);
  const result = await oneShot.runOneShotModelStreaming({
    bin,
    systemPrompt: "sys",
    prompt: "user",
    timeoutMs: 15_000,
    signal: AbortSignal.abort(),
    onDelta: () => {},
  });

  assert.equal(result.text, null);
  assert.match(result.error, /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(marker), false, "no child was started");
});
