import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { fakeProcess } from "./fake-proc.test-helper.mjs";

/**
 * The flat sweep's own rules. This file runs with a PATH that has no `find`
 * (set before anything is imported), which is the machine the walk-only
 * fallback exists for; lib/disk/janitor.test.mjs covers the same rules on a
 * machine that has one.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cody-sweep-test-"));
const emptyBin = path.join(base, "empty-bin");
fs.mkdirSync(emptyBin);
// Resolved now, before PATH is emptied: the test makes a named pipe with it.
const mkfifo = process.env.PATH.split(path.delimiter).map((dir) => path.join(dir, "mkfifo")).find((candidate) => fs.existsSync(candidate));
assert.ok(mkfifo, "mkfifo is available");
process.env.PATH = emptyBin;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PathMentions } = await jiti.import("./mentions.ts");
const { collectSweepCandidates, sweepCandidates, looksLikeTestLeftover, readLivePids } = await jiti.import("./sweep.ts");
const { findRecentChange } = await jiti.import("./walk.ts");

after(() => fs.rmSync(base, { recursive: true, force: true }));

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Everything made in this test is "old" at this time, ten days after it was made. */
const now = Date.now() + 10 * DAY;

let counter = 0;
function root(entries = {}) {
  const dir = path.join(base, `root-${counter++}`);
  fs.mkdirSync(dir);
  for (const [name, bytes] of Object.entries(entries)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 1));
  }
  return dir;
}

const rootFor = (dir, extra = {}) => ({ path: dir, idleMs: 24 * HOUR, reason: "tmp-idle", directoriesOnly: false, ...extra });
const nothing = () => new PathMentions([]);
const context = (extra = {}) => ({ now, dryRun: false, deadline: Date.now() + 60_000, processes: nothing(), transcripts: nothing(), ...extra });

test("this machine has no find, so the walk alone decides", async () => {
  assert.equal(await findRecentChange(base, 0), "unsupported");

  const dir = root({ "quiet/a.bin": 300, "busy/deep/new.bin": 50, "busy/old.bin": 40 });
  const fresh = new Date(now - HOUR);
  fs.utimesSync(path.join(dir, "busy", "deep", "new.bin"), fresh, fresh);

  const { candidates } = await collectSweepCandidates([rootFor(dir)], { now, protectedPaths: [] });
  const { swept, errors } = await sweepCandidates(candidates, context());

  assert.deepEqual(errors, []);
  assert.deepEqual(swept.map((entry) => [path.basename(entry.removal.path), entry.removal.bytes]), [["quiet", 300]]);
  assert.equal(fs.existsSync(path.join(dir, "quiet")), false);
  assert.equal(fs.existsSync(path.join(dir, "busy", "deep", "new.bin")), true, "something inside changed an hour ago");
});

test("only plain old files and folders are candidates: no dot-entries, links, pipes, or entries changed lately", async () => {
  const dir = root({ "old-dir/x": 1, "old-file": 1, ".dotted/x": 1 });
  fs.symlinkSync(dir, path.join(dir, "a-link"));
  execFileSync(mkfifo, [path.join(dir, "a-pipe")]);
  fs.mkdirSync(path.join(dir, "fresh-dir"));
  const fresh = new Date(now - HOUR);
  fs.utimesSync(path.join(dir, "fresh-dir"), fresh, fresh);

  // Everything above was made just now, ten days before `now`; only fresh-dir was written an hour before it.
  const { candidates } = await collectSweepCandidates([rootFor(dir)], { now, protectedPaths: [] });
  assert.deepEqual(candidates.map((candidate) => candidate.name).sort(), ["old-dir", "old-file"]);

  const dirsOnly = await collectSweepCandidates([rootFor(dir, { directoriesOnly: true })], { now, protectedPaths: [] });
  assert.deepEqual(dirsOnly.candidates.map((candidate) => candidate.name), ["old-dir"], "files are left alone in a directories-only root");
});

test("an entry that is, or contains, a protected path is never a candidate", async () => {
  const dir = root({ "state/agent/data": 1, "plain/x": 1 });
  const { candidates } = await collectSweepCandidates([rootFor(dir)], { now, protectedPaths: [path.join(dir, "state", "agent")] });
  assert.deepEqual(candidates.map((candidate) => candidate.name), ["plain"]);
});

test("a folder that changed between the listing and the removal is left alone", async () => {
  const dir = root({ "quiet/a.bin": 5 });
  const { candidates } = await collectSweepCandidates([rootFor(dir)], { now, protectedPaths: [] });
  fs.writeFileSync(path.join(dir, "quiet", "added-since"), "x"); // changes the folder's own times, still "old" by `now`

  const { swept } = await sweepCandidates(candidates, context());
  assert.deepEqual(swept, []);
  assert.equal(fs.existsSync(path.join(dir, "quiet", "added-since")), true);
});

test("a process or a transcript naming an entry keeps it; a dry run removes nothing", async () => {
  const dir = root({ "used/a": 1, "named/a": 1, "idle/a": 7 });
  const { candidates } = await collectSweepCandidates([rootFor(dir)], { now, protectedPaths: [] });
  const processes = new PathMentions([{ path: dir }]);
  processes.addPath(path.join(dir, "used", "work"));
  const transcripts = new PathMentions([{ path: dir }]);
  transcripts.addText(`ls ${dir}/named/`);

  const dry = await sweepCandidates(candidates, context({ processes, transcripts, dryRun: true }));
  assert.deepEqual(dry.swept.map((entry) => path.basename(entry.removal.path)), ["idle"]);
  assert.equal(fs.existsSync(path.join(dir, "idle")), true, "dry run");

  const real = await sweepCandidates(candidates, context({ processes, transcripts }));
  assert.deepEqual(real.swept.map((entry) => path.basename(entry.removal.path)), ["idle"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["named", "used"]);
});

test("a command that starts after the checks and before the removal still keeps its folder, and an unreadable second look removes nothing", async () => {
  const dir = root({ "late-use/a": 1, "idle/a": 7 });
  const { candidates } = await collectSweepCandidates([rootFor(dir)], { now, protectedPaths: [] });
  const late = new PathMentions([{ path: dir }]);
  late.addPath(path.join(dir, "late-use", "bin"));
  let looks = 0;
  const refresh = async () => {
    looks += 1;
    return { processes: late, transcripts: nothing() };
  };

  const first = await sweepCandidates(candidates, context({ refresh }));
  assert.equal(looks, 1, "one more look, after the checks");
  assert.deepEqual(first.swept.map((entry) => path.basename(entry.removal.path)), ["idle"]);
  assert.equal(fs.existsSync(path.join(dir, "late-use")), true);

  const other = root({ "idle/a": 7 });
  const again = await collectSweepCandidates([rootFor(other)], { now, protectedPaths: [] });
  const blind = await sweepCandidates(again.candidates, context({ refresh: async () => null }));
  assert.deepEqual(blind.swept, []);
  assert.equal(fs.existsSync(path.join(other, "idle")), true);

  const failing = await sweepCandidates(again.candidates, context({ refresh: async () => { throw new Error("proc vanished"); } }));
  assert.deepEqual(failing.swept, [], "a second look that throws is treated as unreadable");
});

test("a deadline that has passed leaves everything for the next run", async () => {
  const dir = root({ "idle/a": 7 });
  const { candidates } = await collectSweepCandidates([rootFor(dir)], { now, protectedPaths: [] });
  const { swept } = await sweepCandidates(candidates, context({ deadline: Date.now() - 1 }));
  assert.deepEqual(swept, []);
  assert.equal(fs.existsSync(path.join(dir, "idle")), true);
});

test("a root that cannot be read is skipped, not an error", async () => {
  const { candidates } = await collectSweepCandidates([rootFor(path.join(base, "no-such-root"))], { now, protectedPaths: [] });
  assert.deepEqual(candidates, []);
});

test("the leftover name matcher: a stale pid in the name or a mkdtemp suffix, and nothing else", () => {
  const live = new Set([4242, 31337]);
  const leftover = (name, pids = live) => looksLikeTestLeftover(name, pids);
  for (const name of [
    "lumashow-ui-test-123456-abc",
    "lumashow-ui-test-1234567-abc",
    "lumashow-ui-test-123-abc",
    "run.98765.out",
    "paneldim-a1B2c3",
    "paneldim.a1B2c3",
    "x-9z8y7x",
    "paneldim-123456",
  ]) assert.equal(leftover(name), true, name);
  for (const name of [
    "kestrel-research",
    "wildlife-venv",
    "notes-2026",
    "notes-2026-final",
    "build",
    "lumashow-ui-test-4242-abc",
    "lumashow-ui-test-31337",
    "report-12",
    "report-12345678",
    "abc123456def",
    "backup-alphab",
    "backup-123456a1",
    "-a1B2c3",
    "paneldim-abcdef",
    "paneldim-a1B2c",
    "paneldim-a1B2c3d",
  ]) assert.equal(leftover(name), false, name);
  assert.equal(leftover("lumashow-ui-test-4242-123456-abc"), true, "one live pid does not excuse another stale number");
  assert.equal(leftover("lumashow-ui-test-123456-abc", null), false, "with no process table a number is never judged stale");
  assert.equal(leftover("paneldim-a1B2c3", null), true, "the suffix shape needs no process table");
});

test("the live pids come from the process table, and an unreadable table is null", async () => {
  const proc = path.join(base, "fake-proc");
  fakeProcess(proc, 4242, {});
  fakeProcess(proc, 17, {});
  assert.deepEqual([...(await readLivePids(proc))].sort((a, b) => a - b), [17, 4242], "only numeric entries (not net/)");
  assert.equal(await readLivePids(path.join(base, "no-proc")), null);
  assert.equal(await readLivePids(null), null);
});

test("leftover-shaped directories of a root are examined after the shorter window; files, other names and a longer window are not", async () => {
  const live = new Set([4242]);
  const dir = root({
    "lumashow-ui-test-123456-abc/a": 1,
    "paneldim-a1B2c3/a": 1,
    "kestrel-research/a": 1,
    "notes-2026/a": 1,
    "live-test-4242-xyz/a": 1,
    "stale-123456.log": 1,
  });
  const sixHours = 6 * HOUR;
  const at = now - 10 * DAY + 12 * HOUR; // everything above is 12 hours old
  const homeRoot = rootFor(dir, { idleMs: 72 * HOUR, reason: "home-tmp-idle", directoriesOnly: true, leftover: { idleMs: sixHours, livePids: live } });

  const short = await collectSweepCandidates([homeRoot], { now: at, protectedPaths: [] });
  assert.deepEqual(short.candidates.map((candidate) => candidate.name).sort(), ["lumashow-ui-test-123456-abc", "paneldim-a1B2c3"]);
  assert.ok(short.candidates.every((candidate) => candidate.idleMs === sixHours));

  const later = await collectSweepCandidates([homeRoot], { now: now + 70 * HOUR, protectedPaths: [] });
  assert.equal(later.candidates.length, 5, "after 72 hours the ordinary rule takes every directory, whatever its name");
  assert.equal(later.candidates.find((candidate) => candidate.name === "kestrel-research").idleMs, 72 * HOUR);

  const longer = await collectSweepCandidates([{ ...homeRoot, leftover: { idleMs: 100 * HOUR, livePids: live } }], { now: at, protectedPaths: [] });
  assert.deepEqual(longer.candidates, [], "a leftover window longer than the root's own never delays anything");

  const noLeftoverRule = await collectSweepCandidates([rootFor(dir, { idleMs: 72 * HOUR })], { now: at, protectedPaths: [] });
  assert.deepEqual(noLeftoverRule.candidates, [], "a root without the rule keeps its window for every name");

  // A leftover-shaped directory is judged by its own shorter window all the way to removal.
  const { swept } = await sweepCandidates(short.candidates, context({ now: at }));
  assert.deepEqual(swept.map((entry) => path.basename(entry.removal.path)).sort(), ["lumashow-ui-test-123456-abc", "paneldim-a1B2c3"]);
  assert.equal(fs.existsSync(path.join(dir, "kestrel-research")), true);
});
