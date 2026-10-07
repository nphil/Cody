import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  applyBtwFrame,
  btwCopyText,
  canFollowUpBtw,
  describeBtwError,
  hasRunningBtw,
  latestBtwTurn,
  mergeBtwSnapshot,
  parseBtwRecord,
  parseBtwRecords,
  parseSideQuestionCommand,
  ompVersionHasBtw,
} = await jiti.import("./btw.ts");

const turn = (patch = {}) => ({ question: "why?", answer: "", status: "running", createdAt: 1_000, updatedAt: 1_000, ...patch });
const topic = (id, patch = {}) => ({ id, leafId: null, ...turn(), ...patch });

test("/btw is recognised only as the whole command word, with or without a question", () => {
  assert.deepEqual(parseSideQuestionCommand("/btw what does this regex do?"), { question: "what does this regex do?" });
  assert.deepEqual(parseSideQuestionCommand("  /btw   spaced out  "), { question: "spaced out" });
  assert.deepEqual(parseSideQuestionCommand("/btw\nsecond line is the question"), { question: "second line is the question" });
  assert.deepEqual(parseSideQuestionCommand("/BTW shouting"), { question: "shouting" });
  // No question is still the command: it opens the panel instead of reaching the model.
  assert.deepEqual(parseSideQuestionCommand("/btw"), { question: "" });
  assert.deepEqual(parseSideQuestionCommand("/btw   "), { question: "" });

  for (const text of ["/btwx hello", "/btw:hello", "btw hello", "please /btw this", "//btw hi", "/compact", ""]) {
    assert.equal(parseSideQuestionCommand(text), null, JSON.stringify(text));
  }
});

test("a side question streams: the first record arrives before the command answer, deltas append, the last record is the full answer", () => {
  let records = [];
  // omp writes the first btw_record BEFORE it answers the command.
  records = applyBtwFrame(records, { type: "btw_record", record: topic("a1") });
  assert.equal(records.length, 1);
  assert.equal(latestBtwTurn(records[0]).status, "running");

  records = applyBtwFrame(records, { type: "btw_delta", recordId: "a1", delta: "Because " });
  records = applyBtwFrame(records, { type: "btw_delta", recordId: "a1", delta: "of the cache." });
  assert.equal(records[0].answer, "Because of the cache.");

  // The command's own answer lands late, describing the topic as it was at the start.
  // It must not wipe what has already streamed.
  records = mergeBtwSnapshot(records, [topic("a1")]);
  assert.equal(records[0].answer, "Because of the cache.");

  records = applyBtwFrame(records, {
    type: "btw_record",
    record: topic("a1", { answer: "Because of the cache.", status: "complete", updatedAt: 2_000 }),
  });
  assert.equal(records[0].status, "complete");
  assert.equal(records[0].answer, "Because of the cache.");
  assert.equal(hasRunningBtw(records), false);
});

test("a delta for a topic the page has not heard of is dropped, and the topic's next record brings it whole", () => {
  let records = applyBtwFrame([], { type: "btw_delta", recordId: "ghost", delta: "lost" });
  assert.deepEqual(records, []);
  records = applyBtwFrame(records, {
    type: "btw_record",
    record: topic("ghost", { answer: "lost words, whole", status: "complete", updatedAt: 3_000 }),
  });
  assert.equal(records[0].answer, "lost words, whole");
});

test("a late delta never reopens a finished or cancelled answer", () => {
  const done = [topic("d", { answer: "final", status: "complete", updatedAt: 2_000 })];
  assert.equal(applyBtwFrame(done, { type: "btw_delta", recordId: "d", delta: " extra" }), done);
  const cancelled = [topic("c", { answer: "half", status: "cancelled", updatedAt: 2_000 })];
  assert.equal(applyBtwFrame(cancelled, { type: "btw_delta", recordId: "c", delta: "!" }), cancelled);
});

test("deltas of a follow-up grow the follow-up's answer, not the first turn's", () => {
  const first = topic("f", { answer: "first answer", status: "complete", updatedAt: 2_000 });
  const withFollowUp = { ...first, followUps: [turn({ question: "and then?", createdAt: 3_000, updatedAt: 3_000 })] };
  const records = applyBtwFrame([withFollowUp], { type: "btw_delta", recordId: "f", delta: "second" });
  assert.equal(records[0].answer, "first answer");
  assert.equal(records[0].followUps[0].answer, "second");
  assert.equal(latestBtwTurn(records[0]).question, "and then?");
});

test("frames that are not well-formed side-question frames leave the list untouched", () => {
  const records = [topic("x")];
  for (const frame of [
    null, "text", { type: "message_update" },
    { type: "btw_delta", recordId: "x" }, { type: "btw_delta", delta: "d" }, { type: "btw_delta", recordId: "x", delta: "" },
    { type: "btw_record" }, { type: "btw_record", record: { id: "x" } },
  ]) {
    assert.equal(applyBtwFrame(records, frame), records, JSON.stringify(frame));
  }
});

test("a history read cannot undo progress the page already has, and ends a stale 'running' when the engine says it was interrupted", () => {
  const running = topic("r", { answer: "streamed so far" });
  // Older read of the same running topic: shorter answer, the page keeps its own.
  assert.equal(mergeBtwSnapshot([running], [topic("r", { answer: "stream" })])[0].answer, "streamed so far");
  // A read that is AHEAD of the page does not grow it either: the deltas it already
  // holds may still arrive as frames, and appending them again would repeat text.
  assert.equal(mergeBtwSnapshot([running], [topic("r", { answer: "streamed so far and more" })])[0].answer, "streamed so far");
  // The topic finished while the read was in flight: finished beats running.
  const finished = topic("r", { answer: "streamed so far, done", status: "complete", updatedAt: 5_000 });
  assert.equal(mergeBtwSnapshot([running], [finished])[0].status, "complete");
  assert.equal(mergeBtwSnapshot([finished], [running])[0].status, "complete", "a stale read never reopens a finished topic");
  // The engine died mid-answer: the sidecar still says running; the history read reports interrupted.
  const interrupted = topic("r", { answer: "streamed so", status: "interrupted", updatedAt: 6_000 });
  assert.equal(mergeBtwSnapshot([running], [interrupted])[0].status, "interrupted");
});

test("a topic with more turns is further along than the same topic with fewer", () => {
  const first = topic("m", { answer: "one", status: "complete", updatedAt: 2_000 });
  const followed = { ...first, followUps: [turn({ question: "two?", createdAt: 3_000, updatedAt: 3_000 })] };
  assert.equal(mergeBtwSnapshot([first], [followed])[0].followUps.length, 1, "the follow-up's record replaces");
  assert.equal(mergeBtwSnapshot([followed], [first])[0].followUps.length, 1, "an older read cannot drop the follow-up");
});

test("topics list newest first, unseen ones are added, and none is ever removed by a snapshot", () => {
  const older = topic("old", { createdAt: 1_000, status: "complete", answer: "a", updatedAt: 1_500 });
  const newer = topic("new", { createdAt: 9_000, status: "complete", answer: "b", updatedAt: 9_500 });
  const merged = mergeBtwSnapshot([older], [newer]);
  assert.deepEqual(merged.map((record) => record.id), ["new", "old"]);
  // A snapshot that predates "new" does not remove it.
  assert.deepEqual(mergeBtwSnapshot(merged, [older]).map((record) => record.id), ["new", "old"]);
  // Equal creation time: id order, the engine's own tie-break.
  const tied = mergeBtwSnapshot([], [topic("b", { createdAt: 5 }), topic("a", { createdAt: 5 })]);
  assert.deepEqual(tied.map((record) => record.id), ["a", "b"]);
});

test("a malformed topic is dropped whole, extra fields are ignored, and one bad entry never hides the rest", () => {
  const good = topic("good");
  assert.deepEqual(parseBtwRecord({ ...good, somethingNew: 1 }), good);
  for (const bad of [
    null, [], { ...good, id: "" }, { ...good, id: "../escape" }, { ...good, status: "paused" },
    { ...good, createdAt: "yesterday" }, { ...good, leafId: 7 }, { ...good, followUps: "none" },
    { ...good, followUps: [turn(), { question: "q" }] },
  ]) {
    assert.equal(parseBtwRecord(bad), null, JSON.stringify(bad));
  }
  const parsed = parseBtwRecords([{ ...good, createdAt: 1 }, { nonsense: true }, { ...topic("other"), createdAt: 9 }, { ...good, createdAt: 2 }]);
  assert.deepEqual(parsed.map((record) => record.id), ["other", "good"], "newest first, the repeat id kept once");
  assert.deepEqual(parseBtwRecords("not an array"), []);
});

test("a follow-up is offered only after a finished answer; Copy takes the latest answer that has text", () => {
  const done = topic("c", { answer: "answer", status: "complete", updatedAt: 2_000 });
  assert.equal(canFollowUpBtw(done), true);
  for (const status of ["running", "cancelled", "error", "interrupted"]) {
    assert.equal(canFollowUpBtw({ ...done, status }), false, status);
  }
  assert.equal(btwCopyText(done), "answer");
  const withBlankFollowUp = { ...done, followUps: [turn({ answer: "  \n", status: "cancelled" })] };
  assert.equal(btwCopyText(withBlankFollowUp), "answer", "a blank latest answer falls back to the previous one");
  assert.equal(canFollowUpBtw(withBlankFollowUp), false, "follow-ups follow the latest turn, not the first");
  assert.equal(btwCopyText(topic("empty")), undefined);
  assert.equal(btwCopyText({ ...done, answer: "  keep\n  spacing\n" }), "  keep\n  spacing\n");
});

test("engine refusals map to plain-language kinds, and unknown ones keep the engine's own words", () => {
  const kind = (error) => describeBtwError(error).kind;
  assert.equal(kind(new Error("A /btw question is still running; cancel it first")), "busy");
  assert.equal(kind(new Error("No active model available for /btw.")), "no_model");
  assert.equal(kind(new Error("The /btw question was cancelled before it started")), "cancelled_early");
  assert.equal(kind(new Error("Unknown /btw topic: 01ab")), "unknown_topic");
  assert.equal(kind(new Error("btw requires a non-empty question")), "empty");
  assert.equal(kind(new Error("Could not save /btw history: disk full")), "save_failed");
  // An omp that predates the command, and an engine that has no such vocabulary.
  assert.equal(kind(new Error("Unknown command: btw")), "unsupported");
  assert.equal(kind(Object.assign(new Error("anything"), { code: "unsupported" })), "unsupported");
  assert.equal(kind(Object.assign(new Error("The engine is busy"), { code: "btw_ack_timeout" })), "timeout");

  const other = describeBtwError(new Error("provider exploded"));
  assert.equal(other.kind, "other");
  assert.equal(other.detail, "provider exploded");
  assert.equal(describeBtwError(undefined).detail, "");
});

test("a save failure shows the reason under our own sentence, not the engine's whole line twice", () => {
  const saved = describeBtwError("Could not save /btw history: ENOSPC: no space left on device");
  assert.equal(saved.kind, "save_failed");
  assert.equal(saved.detail, "ENOSPC: no space left on device");
  const lost = describeBtwError("/btw answer 159c283649af351e was not saved: BTW history conflict; it changed or was removed on disk");
  assert.equal(lost.kind, "save_failed");
  assert.equal(lost.detail, "BTW history conflict; it changed or was removed on disk");
  assert.equal(describeBtwError(undefined).key, "btw.errorOtherNoDetail", "no engine text -> the sentence that needs none");
});

test("only an omp that has /btw (18.7.0 and later) is offered side questions; an unreadable version is given the benefit of the doubt", () => {
  for (const version of ["18.7.0", "18.7.3", "18.8.0", "19.0.0", "v18.7.0", "omp/18.7.0", "18.10.0"]) {
    assert.equal(ompVersionHasBtw(version), true, version);
  }
  for (const version of ["18.4.10", "18.6.9", "17.99.0", "9.0.0"]) {
    assert.equal(ompVersionHasBtw(version), false, version);
  }
  for (const unknown of [null, undefined, "", "nightly"]) {
    assert.equal(ompVersionHasBtw(unknown), true, String(unknown));
  }
});
