import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { sweepOmpTempFiles, OMP_TEMP_MAX_AGE_MS } = await jiti.import("./temp-files.ts");

test("only omp's own leftovers older than the age limit are swept", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-omp-temp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const old = new Date(now - OMP_TEMP_MAX_AGE_MS - 60_000);
  const make = (name, { dirEntry = false, when = old } = {}) => {
    const full = path.join(dir, name);
    if (dirEntry) {
      fs.mkdirSync(full);
      fs.writeFileSync(path.join(full, "stderr.log"), "");
    } else {
      fs.writeFileSync(full, "x".repeat(100));
    }
    fs.utimesSync(full, when, when);
  };
  make("omp-sshots-1590a6abe0b00e81.webp");
  make("omp-sshots-15902cf29737b914.png");
  make("omp-worker-stderr-2S9ZmS", { dirEntry: true });
  make("omp-sshots-1590ffffffffffff.webp", { when: new Date(now - 60_000) }); // a fresh screenshot
  make("omp-rpc-output-abc", { dirEntry: true }); // a live child's spill file: never ours to sweep
  make("lumashow-clips", { dirEntry: true }); // someone else's work
  make("notes-omp-sshots-1.webp");

  const result = await sweepOmpTempFiles(dir, OMP_TEMP_MAX_AGE_MS, now);
  assert.equal(result.removed, 3);
  assert.equal(result.bytes, 200, "file bytes are counted, directories are not");
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    "lumashow-clips",
    "notes-omp-sshots-1.webp",
    "omp-rpc-output-abc",
    "omp-sshots-1590ffffffffffff.webp",
  ]);
});

test("a missing temp dir is not an error", async () => {
  assert.deepEqual(await sweepOmpTempFiles(path.join(os.tmpdir(), "does-not-exist-cody-omp-temp")), { removed: 0, bytes: 0 });
});
