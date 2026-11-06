import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * The low-disk gate, on numbers the test makes up: no real disk is filled and
 * none is asked. What is pinned is what a person would notice — which fullness
 * refuses a new turn, what the refusal says, and that a disk nobody can read
 * never locks anyone out.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const gate = await jiti.import("./gate.ts");
const status = await jiti.import("./status.ts");

after(() => gate.configureDiskGateForTests(null));

const GiB = 1024 ** 3;
const TOTAL = 200 * GiB;
/** Whole percents of a 200 GiB disk, in exact bytes: 200 GiB divides by 100. */
const percent = (p) => (TOTAL / 100) * p;

/** A disk of 200 GiB with `available` bytes free, whichever path is asked. */
const everywhere = (available) => () => ({ totalBytes: TOTAL, availableBytes: available });

/** Per-area numbers (`undefined`: that area cannot be read), keyed by where each area really lives. */
function byArea({ tmp, data }) {
  const paths = Object.fromEntries(status.diskAreaPaths().map(({ id, path }) => [path, id]));
  const free = { tmp, data };
  return (dir) => (free[paths[dir]] === undefined ? null : { totalBytes: TOTAL, availableBytes: free[paths[dir]] });
}

function gateFor(probe, now = () => 0) {
  gate.configureDiskGateForTests({ probe, now });
  return gate.checkDiskForNewTurn();
}

test("only a disk under the critical line refuses a new turn; a merely low one still lets everything through", () => {
  // The lines themselves are whole percents, which is what lets this stay in exact bytes.
  assert.equal(status.DISK_CRITICAL_FREE_FRACTION, 0.05);
  assert.equal(status.DISK_LOW_FREE_FRACTION, 0.15);

  assert.equal(gateFor(everywhere(percent(50))), null, "half free");
  assert.equal(gateFor(everywhere(percent(15))), null, "exactly at the low line: not low yet");
  assert.equal(gateFor(everywhere(percent(15) - 1)), null, "low: agents are told to clean up, nobody is refused");
  assert.equal(gateFor(everywhere(percent(5))), null, "exactly at the critical line: still only low");

  assert.equal(gateFor(everywhere(percent(5) - 1))?.code, "disk_full", "one byte under it");
  assert.equal(gateFor(everywhere(0))?.code, "disk_full", "completely full");
});

test("the refusal names which disk is full, how full, and how to clean it, in words a person can use", () => {
  const tmp = gateFor(byArea({ tmp: 3 * GiB, data: percent(75) }));
  assert.equal(tmp.area.id, "tmp");
  assert.match(tmp.message, /^The server's temporary disk space is almost full \(1% free: 3\.0 GB of 200 GB\)/);

  const data = gateFor(byArea({ tmp: percent(75), data: 6 * GiB }));
  assert.equal(data.area.id, "data");
  assert.match(data.message, /^The server's data disk space is almost full \(3% free: 6\.0 GB of 200 GB\)/);

  for (const { message } of [tmp, data]) {
    assert.match(message, /Cody is not starting new work/, "says what happened");
    assert.match(message, /Press Clean idle scratch now in Settings → System → Disk space/, "names the button that cleans");
    assert.match(message, /tell a running agent to delete its scratch files/, "and the other way");
    assert.match(message, /then send again\.$/, "and what to do next");
    assert.ok(message.length <= 300, `short enough for a scheduled message's reason (${message.length} characters)`);
    assert.doesNotMatch(message, /statfs|EDQUOT|ENOSPC|errno|quota|\//, "no jargon, no raw paths");
  }

  assert.match(gateFor(everywhere(0)).message, /\(under 1% free: 0 B of 200 GB\)/, "a disk with nothing free never reads as 0%");
  assert.match(gateFor(everywhere(Math.floor(TOTAL * 0.0499))).message, /\(4% free:/, "4.99% is 4%, never 5%");
});

test("when both disks are critical the fuller one is named, and a healthy one is never blamed", () => {
  assert.equal(gateFor(byArea({ tmp: 8 * GiB, data: 2 * GiB })).area.id, "data");
  assert.equal(gateFor(byArea({ tmp: 2 * GiB, data: 8 * GiB })).area.id, "tmp");
  assert.equal(gateFor(byArea({ tmp: percent(50), data: 2 * GiB })).area.id, "data", "temp space is fine");
  assert.equal(gateFor(byArea({ tmp: percent(50), data: percent(75) })), null);
});

test("a disk that cannot be read never blocks anyone: unknown space is not empty space", () => {
  assert.equal(gateFor(() => null), null, "no statfs at all");
  assert.equal(gateFor(() => ({ totalBytes: 0, availableBytes: 0 })), null, "a filesystem that reports no size");
  assert.equal(gateFor(() => { throw new Error("EIO"); }), null, "a reading that blows up");
  // One disk unreadable does not hide the other one being full.
  assert.equal(gateFor(byArea({ tmp: 1 * GiB, data: undefined }))?.area.id, "tmp");
});

test("a reading is reused for five seconds, so a burst of sends reads the disk once", () => {
  let reads = 0;
  let free = 1 * GiB;
  let clock = 1_000_000;
  const probe = () => {
    reads += 1;
    return { totalBytes: TOTAL, availableBytes: free };
  };
  gate.configureDiskGateForTests({ probe, now: () => clock });

  assert.equal(gate.checkDiskForNewTurn()?.code, "disk_full");
  const afterFirst = reads;
  assert.ok(afterFirst >= 1);

  free = percent(50); // room is made at once ...
  clock += 4_999;
  assert.equal(gate.checkDiskForNewTurn()?.code, "disk_full", "... but a reading under five seconds old still stands");
  assert.equal(reads, afterFirst, "and cost no new read");

  clock += 1;
  assert.equal(gate.checkDiskForNewTurn(), null, "at five seconds the disk is read again and the way is open");
  assert.ok(reads > afterFirst);

  const settled = reads;
  clock += 1_000;
  free = 1 * GiB; // ... and the other way round
  assert.equal(gate.checkDiskForNewTurn(), null);
  assert.equal(reads, settled);
  clock += 4_000;
  assert.equal(gate.checkDiskForNewTurn()?.code, "disk_full");

  // A clock that steps backwards does not freeze an old answer.
  free = percent(50);
  clock -= 60_000;
  assert.equal(gate.checkDiskForNewTurn(), null);
});

test("only a message that starts work is refused: a steer or an interrupt into a running turn still goes through", () => {
  const starts = gate.commandStartsNewWork;
  const table = [
    // [command, chat running, starts new work]
    [{ type: "prompt" }, false, true],
    [{ type: "prompt", streamingBehavior: "steer" }, false, true],
    [{ type: "prompt", streamingBehavior: "followUp" }, false, true],
    [{ type: "prompt", streamingBehavior: "steer" }, true, false],
    [{ type: "prompt", streamingBehavior: "followUp" }, true, true],
    [{ type: "prompt" }, true, true],
    [{ type: "follow_up" }, false, true],
    [{ type: "follow_up" }, true, true],
    [{ type: "steer" }, true, false],
    [{ type: "steer" }, false, true],
    [{ type: "abort_and_prompt" }, true, false],
    [{ type: "abort_and_prompt" }, false, true],
    // Everything else is not a message at all.
    [{ type: "abort" }, true, false],
    [{ type: "abort" }, false, false],
    [{ type: "bash", command: "df -h" }, false, false],
    [{ type: "set_model" }, false, false],
    [{ type: "get_state" }, true, false],
    [{}, false, false],
  ];
  for (const [command, running, expected] of table) {
    assert.equal(starts(command, running), expected, `${JSON.stringify(command)} while ${running ? "running" : "idle"}`);
  }
});
