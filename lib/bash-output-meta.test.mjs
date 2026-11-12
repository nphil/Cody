import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { bashOutputNotes } = await jiti.import("./bash-output-meta.ts");

// Shapes captured from real `get_messages` bashExecution entries (omp 18.8.3 and 18.19.0).
const MIDDLE = {
  truncation: {
    direction: "middle", truncatedBy: "middle", totalLines: 200000, totalBytes: 1288895, outputLines: 8707, outputBytes: 51218,
    headRange: { start: 1, end: 4317 }, tailRange: { start: 195613, end: 200000 }, elidedBytes: 1237701, elidedLines: 191295,
  },
};
const COLUMNS = { limits: { columnTruncated: { maxColumn: 768, unit: "bytes" } } };

test("an output cut from the middle reports lines and bytes", () => {
  assert.deepEqual(bashOutputNotes(MIDDLE), [{ kind: "middle", lines: 191295, bytes: 1237701 }]);
});

test("a middle cut without elided counts falls back to total minus kept", () => {
  const notes = bashOutputNotes({ truncation: { direction: "middle", truncatedBy: "middle", totalLines: 100, totalBytes: 5000, outputLines: 40, outputBytes: 2000 } });
  assert.deepEqual(notes, [{ kind: "middle", lines: 60, bytes: 3000 }]);
});

test("lines cut at the per-line cap report the cap and its unit", () => {
  assert.deepEqual(bashOutputNotes(COLUMNS), [{ kind: "columns", max: 768, unit: "bytes" }]);
  assert.deepEqual(bashOutputNotes({ limits: { columnTruncated: { maxColumn: 500, unit: "chars", lines: { first: 1, last: 3 } } } }), [{ kind: "columns", max: 500, unit: "chars" }]);
  // A session written before the unit was recorded.
  assert.deepEqual(bashOutputNotes({ limits: { columnTruncated: { maxColumn: 768 } } }), [{ kind: "columns", max: 768, unit: "bytes" }]);
});

test("a head or tail cut reports how many lines are shown", () => {
  assert.deepEqual(bashOutputNotes({ truncation: { direction: "tail", truncatedBy: "lines", totalLines: 500, outputLines: 200, totalBytes: 9000, outputBytes: 4000 } }), [{ kind: "shown", shown: 200, total: 500 }]);
});

test("the output minimizer's rewrite names its filter and sizes (omp 18.17+)", () => {
  assert.deepEqual(bashOutputNotes({ minimized: { filter: "git", inputBytes: 123289, outputBytes: 3277, artifactId: "7" } }), [{ kind: "minimized", filter: "git", inputBytes: 123289, outputBytes: 3277 }]);
  assert.deepEqual(bashOutputNotes({ minimized: {} }), [{ kind: "minimized", filter: null, inputBytes: null, outputBytes: null }]);
});

test("notes keep omp's order when several apply", () => {
  const notes = bashOutputNotes({ ...MIDDLE, ...COLUMNS, minimized: { filter: "chain", inputBytes: 10, outputBytes: 5 } });
  assert.deepEqual(notes.map((note) => note.kind), ["middle", "columns", "minimized"]);
});

test("nothing to say, or data that is not a report, gives no notes", () => {
  for (const meta of [undefined, null, "x", 7, [], {}, { truncation: null }, { truncation: { direction: "middle" } }, { truncation: { direction: "tail", outputLines: 5, totalLines: 5 } }, { limits: { columnTruncated: { maxColumn: -1 } } }, { limits: { columnTruncated: "wide" } }]) {
    assert.deepEqual(bashOutputNotes(meta), [], JSON.stringify(meta));
  }
});
