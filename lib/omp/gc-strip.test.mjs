import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/** `omp gc --strip` parsing and the real engine's answer on an empty agent dir. */
const root = mkdtempSync(join(tmpdir(), "cody-gc-strip-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(() => rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseStripResult, runReplayStrip } = await jiti.import("./gc-strip.ts");
const { resolveOmpBin } = await jiti.import("./omp-cli.ts");

test("the strip summary is read from omp's JSON", () => {
  const out = JSON.stringify({ apply: true, strip: { scanned: 9, skippedLive: 1, wouldStrip: 4, stripped: 3, records: 20, bytes: 2048, errors: ["x", 7] } });
  assert.deepEqual(parseStripResult(`note\n${out}`), { supported: true, candidates: 4, stripped: 3, bytes: 2048, skippedLive: 1, errors: ["x"] });
  assert.equal(parseStripResult("{}"), null);
  assert.equal(parseStripResult("nope"), null);
});

test("the installed engine previews, or is reported as too old", async () => {
  const version = execFileSync(resolveOmpBin(), ["--version"], { encoding: "utf8" }).match(/(\d+)\.(\d+)\.(\d+)/);
  const knowsStrip = Number(version[1]) > 18 || (Number(version[1]) === 18 && (Number(version[2]) > 18 || (Number(version[2]) === 18 && Number(version[3]) >= 2)));
  const result = await runReplayStrip(false);
  assert.equal(result.supported, knowsStrip);
  if (knowsStrip) assert.equal(result.candidates, 0);
});
