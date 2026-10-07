import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ESTIMATED_READ_BYTES_PER_SECOND, ESTIMATED_READ_MAX_MS, SET_BURST_GAP_MS, combinedSetName, effectiveSetName, estimatedStart, groupArtifactSets, holdsWholeBackup, olderSetOf, setFileLabel, setSaveState, shortArtifactName } = await jiti.import("./artifact-sets.ts");

const MINUTE = 60_000;
const MiB = 1024 * 1024;
const T0 = Date.parse("2026-10-06T18:00:00Z");
let counter = 0;

function output(name, createdAt, provenance, extra = {}) {
  counter += 1;
  return {
    id: `a${String(counter).padStart(3, "0")}`,
    name,
    size: 1000 + counter,
    mime: "application/octet-stream",
    sha256: String(counter).padStart(64, "0"),
    kind: "output",
    source: "device",
    createdAt,
    ...(provenance ? { provenance } : {}),
    ...extra,
  };
}

const edl = (operationId, extra = {}) => ({ operationId, deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", label: "Lenovo QUSB__BULK", ...extra });
const dumpOf = (operationId, extra = {}) => ({ operationId, deviceId: "usb-1", protocol: "edl", action: "dump", target: operationId, label: "Lenovo QUSB__BULK", ...extra });

test("everything one operation saved is one set, oldest file first, with its size and the device's name", () => {
  const files = [];
  for (let index = 0; index < 58; index += 1) files.unshift(output(`edl-1a2b-set-p${index}-part${index}.bin`, T0 + index * 20_000, edl("op-backup", { startedAt: T0 })));
  const sets = groupArtifactSets(files);
  assert.equal(sets.length, 1);
  const [set] = sets;
  assert.equal(set.count, 58);
  assert.equal(set.legacy, false);
  assert.deepEqual(set.operationIds, ["op-backup"]);
  assert.equal(set.label, "Lenovo QUSB__BULK");
  assert.equal(set.protocol, "edl");
  assert.equal(set.command, "backup");
  assert.equal(set.startedAt, T0, "when the operation began, not when its first file was saved");
  assert.equal(set.endedAt, T0 + 57 * 20_000);
  assert.equal(set.totalBytes, files.reduce((total, file) => total + file.size, 0));
  assert.equal(set.artifactIds[0], files.find((file) => file.createdAt === T0).id, "oldest first, whatever order the list came in");
  assert.equal(set.id, `set:${set.artifactIds[0]}`);
});

test("a burst of single dumps on one device is one set, and what ends it is two quiet minutes between one run's end and the next one's start", () => {
  const dump = (name, at) => output(`${name}.bin`, at, dumpOf(name, { startedAt: at }));
  const first = dump("boot", T0);
  const second = dump("system", T0 + SET_BURST_GAP_MS);
  const third = dump("vendor", T0 + SET_BURST_GAP_MS * 2 + 1);
  assert.equal(SET_BURST_GAP_MS, 2 * MINUTE);
  const sets = groupArtifactSets([third, second, first]);
  assert.equal(sets.length, 2, "exactly the gap joins; one millisecond more splits");
  assert.deepEqual(sets[0].operationIds, ["vendor"]);
  assert.deepEqual(sets[1].operationIds, ["boot", "system"]);
  assert.deepEqual(sets[1].artifactIds, [first.id, second.id]);
});

test("a read that takes longer than two minutes never splits a backup: the quiet time is measured to the next run's START", () => {
  // Each partition takes 10 minutes to read, so its file is saved 10 minutes after its operation began. The files are
  // 10 minutes apart, which the old rule (creation to creation) called two backups; the operations were back to back.
  const slow = (name, started, saved) => output(`${name}.bin`, saved, dumpOf(name, { startedAt: started }));
  const system = slow("system_b", T0, T0 + 10 * MINUTE);
  const oem = slow("oem_a", T0 + 10 * MINUTE + 20_000, T0 + 20 * MINUTE);
  const userdata = slow("userdata", T0 + 20 * MINUTE + 15_000, T0 + 30 * MINUTE);
  const [only, ...rest] = groupArtifactSets([userdata, oem, system]);
  assert.equal(rest.length, 0);
  assert.deepEqual(only.artifactIds, [system.id, oem.id, userdata.id]);
  assert.equal(only.startedAt, T0);
  assert.equal(only.endedAt, T0 + 30 * MINUTE);

  const boundary = slow("exactly-the-gap", T0 + 10 * MINUTE + SET_BURST_GAP_MS, T0 + 21 * MINUTE);
  assert.equal(groupArtifactSets([system, boundary]).length, 1, "exactly two quiet minutes between the end and the next start still joins");
  const later = slow("modem", T0 + 10 * MINUTE + SET_BURST_GAP_MS + 1, T0 + 21 * MINUTE);
  assert.equal(groupArtifactSets([system, later]).length, 2, "one millisecond more makes two backups");
});

test("a file saved before the start was recorded is placed as if it had been read at one MiB a second", () => {
  assert.equal(ESTIMATED_READ_BYTES_PER_SECOND, MiB);
  const big = output("big.bin", T0, dumpOf("big"), { size: 512 * MiB });
  assert.equal(estimatedStart(big), T0 - 512_000, "512 MiB takes 512 seconds");
  assert.equal(estimatedStart(output("tiny.bin", T0, dumpOf("tiny"), { size: 0 })), T0);
  assert.equal(ESTIMATED_READ_MAX_MS, 30 * MINUTE);
  assert.equal(estimatedStart(output("huge.bin", T0, dumpOf("huge"), { size: 4 * 1024 * MiB })), T0 - ESTIMATED_READ_MAX_MS, "a 4 GiB file is placed at most half an hour back, not 68 minutes");
  // A 4 GiB dump saved at T and an unrelated dump that ended 50 minutes earlier were two cards in 0.53 and stay two.
  const earlier = output("small.bin", T0 - 50 * MINUTE, dumpOf("small"));
  assert.equal(groupArtifactSets([earlier, output("huge.bin", T0, dumpOf("huge"), { size: 4 * 1024 * MiB })]).length, 2, "the estimate cannot swallow a run that ended long before the read began");
  assert.equal(estimatedStart({ ...big, provenance: { ...big.provenance, startedAt: T0 - 5_000 } }), T0 - 5_000, "a recorded start is used as it is");
  assert.equal(estimatedStart({ ...big, provenance: { ...big.provenance, startedAt: T0 + 5_000 } }), T0, "a start later than the file can only be a clock mistake");
});

test("the owner's tablet backup, 56 single dumps whose cards were split by long reads, is one set once the start is estimated", () => {
  // His real cards (all one device, all EDL dumps, saved before the operation start was recorded): devinfo at 6:30 PM, 51
  // small partitions finishing at 6:37, then system_b 512 MB at 6:40, oem_a 500 MB at 6:43, oem_b 500 MB at 6:47 and userdata
  // 1.1 GB at 6:51. Plus two earlier identification commands that are not dumps.
  const at = (hour, minute, second = 0) => Date.UTC(2026, 9, 6, hour, minute, second);
  const files = [];
  const dump = (name, saved, size) => files.push(output(`edl-3989044886-${name}.bin`, saved, dumpOf(name), { size }));
  dump("devinfo", at(18, 30), 1 * MiB);
  for (let index = 0; index < 51; index += 1) dump(`small${index}`, at(18, 33, 20) + index * 4_500, Math.round((1.0 * 1024 * MiB) / 51));
  dump("system_b", at(18, 40), 512 * MiB);
  dump("oem_a", at(18, 43), 500 * MiB);
  dump("oem_b", at(18, 47), 500 * MiB);
  dump("userdata", at(18, 51), 1126 * MiB);
  assert.equal(files.length, 56);
  const identification = [
    output("edl-3989044886-gpt-primary.bin", at(18, 14), edl("op-printgpt", { command: "printgpt" }), { size: 17_408 }),
    output("edl-3989044886-gpt-backup.bin", at(18, 14, 1), edl("op-printgpt", { command: "printgpt" }), { size: 16_896 }),
    ...Array.from({ length: 7 }, (_, index) => output(`edl-3989044886-check${index}.bin`, at(18, 18) + index * 1_000, edl("op-check", { command: "check" }), { size: 4096 })),
  ];

  const sets = groupArtifactSets([...identification, ...files]);
  const dumps = sets.filter((set) => set.action === "dump");
  assert.equal(dumps.length, 1, "every dump of the backup is one card");
  assert.equal(dumps[0].count, 56);
  assert.equal(dumps[0].endedAt, at(18, 51));
  assert.equal(dumps[0].totalBytes, files.reduce((total, file) => total + file.size, 0));
  assert.equal(sets.length, 3, "the identification commands are different kinds of run and stay their own cards");
  assert.deepEqual(sets.filter((set) => set.action !== "dump").map((set) => set.count).sort(), [2, 7]);

  // Without the estimate the same files are the six cards the owner saw: each long read began after the previous file was saved.
  const asSaved = files.map((file) => ({ ...file, size: 0 }));
  assert.ok(groupArtifactSets(asSaved).length > 1, "with no read time taken into account they fall apart, as they did");
});

test("a different kind of run, or another device, never joins a set, and another device in between does not split one", () => {
  const a = output("a.bin", T0, edl("op-1", { command: "printgpt" }));
  const b = output("b.bin", T0 + 10_000, edl("op-2", { command: "backup" }));
  assert.equal(groupArtifactSets([a, b]).length, 2, "exec printgpt and exec backup are different things");
  const c = output("c.bin", T0 + 20_000, edl("op-3", { deviceId: "usb-2" }));
  assert.equal(groupArtifactSets([a, b, c]).length, 3, "another device is its own set");

  const d1 = output("d1.bin", T0, { operationId: "d1", deviceId: "usb-1", protocol: "adb", action: "pull" });
  const other = output("x.bin", T0 + 30_000, { operationId: "x", deviceId: "usb-2", protocol: "adb", action: "pull" });
  const d2 = output("d2.bin", T0 + 60_000, { operationId: "d2", deviceId: "usb-1", protocol: "adb", action: "pull" });
  const sets = groupArtifactSets([d1, other, d2]);
  assert.equal(sets.length, 2);
  assert.deepEqual(sets.map((set) => set.count).sort(), [1, 2]);

  const e1 = output("e1.bin", T0, { operationId: "e1", deviceId: "usb-1", protocol: "adb", action: "pull" });
  const flash = output("f.bin", T0 + 30_000, { operationId: "f", deviceId: "usb-1", protocol: "fastboot", action: "flash" });
  const e2 = output("e2.bin", T0 + 60_000, { operationId: "e2", deviceId: "usb-1", protocol: "adb", action: "pull" });
  assert.equal(groupArtifactSets([e1, flash, e2]).length, 3, "a different run on that device in between ends the burst");
});

test("everything an agent filed under one name on one device is one set, whenever and with whatever command it was made", () => {
  const filed = (name, at, extra) => output(`${name}.bin`, at, dumpOf(name, { set: "Lenovo tablet 2026-10-06", startedAt: at, ...extra }));
  const boot = filed("boot_a", T0);
  const gpt = output("gpt.bin", T0 + 3 * 60 * MINUTE, edl("op-gpt", { command: "printgpt", set: "Lenovo tablet 2026-10-06", startedAt: T0 + 3 * 60 * MINUTE }));
  const system = filed("system_a", T0 + 5 * 60 * MINUTE);
  const unrelated = output("other.bin", T0 + 60_000, dumpOf("other"));
  const elsewhere = output("elsewhere.bin", T0 + 2_000, dumpOf("elsewhere", { deviceId: "usb-2", set: "Lenovo tablet 2026-10-06" }));
  const sets = groupArtifactSets([system, unrelated, gpt, elsewhere, boot]);
  assert.equal(sets.length, 3, "the named set, the other device's set of the same name, and the unnamed dump");
  const named = sets.find((set) => set.count === 3);
  assert.equal(named.name, "Lenovo tablet 2026-10-06");
  assert.deepEqual(named.artifactIds, [boot.id, gpt.id, system.id]);
  assert.equal(named.deviceId, "usb-1");
  assert.equal(named.label, "Lenovo QUSB__BULK");
  assert.equal(named.action, undefined, "mixed kinds say nothing about the kind");
  assert.equal(named.startedAt, T0, "its start is the first run's");
  assert.equal(sets.find((set) => set.deviceId === "usb-2").name, "Lenovo tablet 2026-10-06");
  assert.equal(sets.find((set) => set.operationIds.includes("other")).name, undefined, "an unnamed set has no name");

  const same = ["a", "b"].map((name, index) => output(`${name}.bin`, T0 + index * 90 * MINUTE, dumpOf(name, { set: "x" })));
  assert.equal(groupArtifactSets(same).length, 1, "ninety minutes apart is no reason to split a named set");
});

test("a person's own filing wins over the agent's name, and a name made up by Combine is never shown", () => {
  const agent = output("a.bin", T0, dumpOf("a", { set: "agent name" }));
  const moved = output("b.bin", T0 + 5 * 60 * MINUTE, dumpOf("b"), { setName: "agent name" });
  const [joined] = groupArtifactSets([agent, moved]);
  assert.equal(joined.count, 2);
  assert.equal(joined.name, "agent name");

  const overridden = output("o.bin", T0, dumpOf("o", { set: "agent name" }), { setName: "something else" });
  assert.equal(effectiveSetName(overridden), "something else");
  assert.equal(effectiveSetName(agent), "agent name");
  assert.equal(effectiveSetName(output("c.bin", T0, dumpOf("c"))), undefined);
  assert.equal(groupArtifactSets([overridden, agent]).length, 2, "the overridden file left the agent's set");

  const made = combinedSetName("1234");
  const one = output("one.bin", T0, dumpOf("one"), { setName: made });
  const two = output("two.bin", T0 + 4 * 60 * MINUTE, dumpOf("two"), { setName: made });
  const [pair] = groupArtifactSets([one, two]);
  assert.equal(pair.count, 2, "files filed under one made-up name are one set");
  assert.equal(pair.name, undefined, "but the name belongs to nobody to read");
  assert.ok(!/[\u0001]/.test(setFileLabel(pair)));

  const legacyA = output("edl-1-boot.bin", T0, undefined, { setName: made });
  const legacyB = output("dump-b.bin", T0 + 50 * MINUTE, undefined, { setName: made });
  const [legacySet] = groupArtifactSets([legacyA, legacyB]);
  assert.equal(legacySet.count, 2);
  assert.equal(legacySet.legacy, true);
  assert.equal(legacySet.deviceId, undefined);
});

test("the next older set of the same device is what Combine joins, and the oldest has nothing to join", () => {
  const run = (name, at, extra = {}) => output(`${name}.bin`, at, dumpOf(name, { startedAt: at, ...extra }));
  const old = run("old", T0);
  const otherDevice = run("elsewhere", T0 + 60 * MINUTE, { deviceId: "usb-2" });
  const middle = run("middle", T0 + 3 * 60 * MINUTE);
  const fresh = run("fresh", T0 + 6 * 60 * MINUTE);
  const sets = groupArtifactSets([old, otherDevice, middle, fresh]);
  assert.equal(sets.length, 4);
  const byOperation = (name) => sets.find((set) => set.operationIds.includes(name));
  assert.equal(olderSetOf(sets, byOperation("fresh")).id, byOperation("middle").id);
  assert.equal(olderSetOf(sets, byOperation("middle")).id, byOperation("old").id, "the other device's set in between is skipped");
  assert.equal(olderSetOf(sets, byOperation("old")), undefined);
  assert.equal(olderSetOf(sets, byOperation("elsewhere")), undefined, "the only set of its device");
});

/** The files one EDL backup of `chosen` of `all` saves, in order: both tables, the partitions, and the manifest it writes last. */
function backupFiles(operationId, chosen, all, at = T0, extra = {}) {
  const names = ["edl-1-set-gpt-primary.bin", ...chosen.map((name, index) => `edl-1-set-p${index}-${name}.bin`), "edl-1-set-gpt-backup.bin", "edl-1-set-0123abcd.manifest.json"];
  return names.map((name, index) => output(name, at + index * 1000, { ...edl(operationId, { startedAt: at, ...extra }), scope: { chosen, all } }));
}

test("a set says how many partitions its backup took only when it holds the whole backup; one that stopped, or lost a file, is incomplete and claims nothing more", () => {
  const all = Array.from({ length: 56 }, (_, index) => `part${index}`);
  const some = backupFiles("op-some", all.slice(0, 5), all);
  assert.equal(some.length, 8, "5 partitions, two tables and the manifest");
  assert.ok(holdsWholeBackup(some.map((file) => file.name), { chosen: all.slice(0, 5), all }));
  assert.equal(holdsWholeBackup(some.slice(0, 7).map((file) => file.name), { chosen: all.slice(0, 5), all }), false, "no manifest: the backup never finished");
  assert.equal(holdsWholeBackup(some.slice(1).map((file) => file.name), { chosen: all.slice(0, 5), all }), false, "a table removed since: not whole");
  const [five] = groupArtifactSets(some);
  assert.deepEqual(five.scope, { chosen: 5, total: 56, complete: true });
  assert.equal(setFileLabel(five), "Lenovo QUSB__BULK EDL backup 5 of 56", "a partial backup never looks like a full one in a file name");

  const [fullSet] = groupArtifactSets(backupFiles("op-full", all, all));
  assert.deepEqual(fullSet.scope, { chosen: 56, total: 56, complete: true });
  assert.equal(setFileLabel(fullSet), "Lenovo QUSB__BULK EDL backup", "a full backup keeps the plain name");

  // The cable dropped after three files: every file carries the backup's scope, but the set is not that backup.
  const [stopped] = groupArtifactSets(backupFiles("op-stopped", all, all).slice(0, 3));
  assert.deepEqual(stopped.scope, { chosen: 56, total: 56, complete: false });
  assert.equal(setFileLabel(stopped), "Lenovo QUSB__BULK EDL backup incomplete", "and its zip says so");
  const [trimmed] = groupArtifactSets(backupFiles("op-trimmed", all, all).filter((file) => !file.name.includes("-p3-")));
  assert.equal(trimmed.scope.complete, false, "a partition removed from a finished backup");

  // An agent names every step of one backup the same: a table read beside the backup takes nothing from the claim, a dump might.
  const named = (id, chosen, at) => backupFiles(id, chosen, all, at, { set: "both" });
  const [twoBackups] = groupArtifactSets([...named("op-a", all.slice(0, 3), T0), ...named("op-b", all.slice(3, 5), T0 + 10 * MINUTE)]);
  assert.deepEqual(twoBackups.scope, { chosen: 5, total: 56, complete: true }, "two backups of chosen partitions claim the union");
  const tables = output("pg.bin", T0 + 20 * MINUTE, edl("op-pg", { command: "printgpt", set: "both" }));
  const [withTables] = groupArtifactSets([...named("op-a", all.slice(0, 3), T0), tables]);
  assert.deepEqual(withTables.scope, { chosen: 3, total: 56, complete: true }, "printgpt saves no partition, so the claim stands");
  const dump = output("edl-1-modem.bin", T0 + 20 * MINUTE, dumpOf("op-dump", { set: "both" }));
  const [withDump] = groupArtifactSets([...named("op-a", all.slice(0, 3), T0), dump]);
  assert.equal(withDump.scope, undefined, "a dump in the set might hold a partition the backup did not, so the card does not say '3 of 56'");
  const [halfNamed] = groupArtifactSets([...named("op-a", all.slice(0, 3), T0), ...named("op-c", all.slice(3, 4), T0 + 30 * MINUTE).slice(0, 2)]);
  assert.deepEqual(halfNamed.scope, { chosen: 4, total: 56, complete: false }, "one unfinished backup among them makes the set incomplete");
});

test("Combine is offered the next older backup of the same device and kind of thing, never a restore's copies, a table read or another unit's files", () => {
  const run = (name, at, extra = {}) => output(`${name}.bin`, at, dumpOf(name, { startedAt: at, ...extra }));
  const old = run("old", T0);
  const restore = output("edl-1-restore-0123abcd-boot_a.pre.bin", T0 + 60 * MINUTE, edl("op-restore", { command: "restore", startedAt: T0 + 60 * MINUTE }));
  const tables = output("edl-1-gpt-primary.bin", T0 + 90 * MINUTE, edl("op-tables", { command: "printgpt", startedAt: T0 + 90 * MINUTE }));
  const fresh = run("fresh", T0 + 6 * 60 * MINUTE);
  const sets = groupArtifactSets([old, restore, tables, fresh]);
  const by = (name) => sets.find((set) => set.operationIds.includes(name));
  assert.equal(olderSetOf(sets, by("fresh")).id, by("old").id, "the restore's safety copies and the table read in between are skipped");
  assert.equal(olderSetOf(sets, by("op-restore")), undefined, "safety copies are not a backup to combine");
  assert.equal(olderSetOf(sets, by("op-tables")), undefined);

  const legacyA = output("edl-1a2b3c-set-p1-boot_a.bin", T0);
  const legacyB = output("edl-9f9f9f-set-p1-boot_a.bin", T0 + 60 * MINUTE);
  const legacyC = output("edl-1a2b3c-boot_b.bin", T0 + 3 * 60 * MINUTE);
  const plain = output("dump-x.bin", T0 + 4 * 60 * MINUTE);
  const legacy = groupArtifactSets([legacyA, legacyB, legacyC, plain]);
  const holding = (file) => legacy.find((set) => set.artifactIds.includes(file.id));
  assert.equal(holding(legacyC).unit, "1a2b3c");
  assert.equal(olderSetOf(legacy, holding(legacyC)).id, holding(legacyA).id, "files 0.53 saved are matched by the unit tag in their names");
  assert.equal(olderSetOf(legacy, holding(legacyB)), undefined, "another unit's files are never its older backup");
  assert.equal(olderSetOf(legacy, holding(plain)), undefined, "a file with no device and no unit has no older backup");
});

test("what a set is called in a file name: the agent's name when it has one, else the device and what ran", () => {
  const [plain] = groupArtifactSets([output("a.bin", T0, dumpOf("a"))]);
  assert.equal(setFileLabel(plain), "Lenovo QUSB__BULK EDL dump");
  const [pulled] = groupArtifactSets([output("a.bin", T0, { operationId: "p", deviceId: "usb-3", protocol: "adb", action: "pull" })]);
  assert.equal(setFileLabel(pulled), "ADB pull");
  const [named] = groupArtifactSets([output("a.bin", T0, dumpOf("a", { set: "Nitin tablet" }))]);
  assert.equal(setFileLabel(named), "Nitin tablet");
  const [legacy] = groupArtifactSets([output("something.bin", T0)]);
  assert.equal(setFileLabel(legacy), "Device files");
});

test("inputs are not sets, and nothing at all is not an error", () => {
  const input = output("firmware.bin", T0, undefined, { kind: "input", source: "picker" });
  assert.deepEqual(groupArtifactSets([input]), []);
  assert.deepEqual(groupArtifactSets([]), []);
});

test("sets are listed newest first, and an id survives the burst growing at its newer end", () => {
  const old = output("old.bin", T0, edl("op-old"));
  const fresh = output("fresh.bin", T0 + 60 * MINUTE, edl("op-new"));
  const [newest, oldest] = groupArtifactSets([old, fresh]);
  assert.deepEqual(newest.operationIds, ["op-new"]);
  assert.deepEqual(oldest.operationIds, ["op-old"]);

  const grown = output("fresh2.bin", T0 + 61 * MINUTE, edl("op-new"));
  const [again] = groupArtifactSets([old, fresh, grown]);
  assert.equal(again.id, newest.id);
  assert.equal(again.count, 2);
});

test("files saved before provenance existed are grouped by what their names say and by time, and say so", () => {
  const names = ["edl-1a2b3c4d-set-gpt-primary.bin", "edl-1a2b3c4d-set-p1-boot_a.bin", "edl-1a2b3c4d-set-p2-userdata.bin", "edl-1a2b3c4d-set-gpt-backup.bin", "edl-1a2b3c4d-set-deadbeef.manifest.json"];
  const backup = names.map((name, index) => output(name, T0 + index * 4 * MINUTE));
  const later = output("edl-1a2b3c4d-set-p1-boot_a.bin", T0 + 3 * 60 * MINUTE);
  const dumpA = output("edl-1a2b3c4d-boot_b.bin", T0 + 5 * 60 * MINUTE);
  const dumpB = output("edl-1a2b3c4d-system_b.bin", T0 + 5 * 60 * MINUTE + MINUTE);
  const dumpC = output("edl-1a2b3c4d-vendor_b.bin", T0 + 5 * 60 * MINUTE + 4 * MINUTE);
  const sets = groupArtifactSets([...backup, later, dumpA, dumpB, dumpC]);

  const original = sets.find((set) => set.count === 5);
  assert.ok(original, "five files four minutes apart are still one backup because their names say so");
  assert.equal(original.legacy, true);
  assert.equal(original.protocol, "edl");
  assert.equal(original.command, "backup");
  assert.equal(original.deviceId, undefined);
  assert.deepEqual(original.operationIds, []);
  assert.equal(sets.find((set) => set.artifactIds.includes(later.id)).count, 1, "a backup three hours later is another set");
  const dumps = sets.filter((set) => set.action === "dump");
  assert.deepEqual(dumps.map((set) => set.count).sort(), [1, 2], "single dumps use the two minute gap");
  assert.ok(sets.every((set) => set.legacy));
});

test("legacy files that are not Qualcomm ones group by time alone", () => {
  const sets = groupArtifactSets([output("dump-a.bin", T0), output("dump-b.bin", T0 + MINUTE), output("dump-c.bin", T0 + 10 * MINUTE)]);
  assert.deepEqual(sets.map((set) => set.count).sort(), [1, 2]);
  assert.equal(sets[0].protocol, undefined);
});

test("a legacy set and a provenance set are never merged, even side by side", () => {
  const old = output("edl-1-set-p1-boot.bin", T0);
  const fresh = output("edl-1-set-p1-boot.bin", T0 + 1000, edl("op-1"));
  const sets = groupArtifactSets([old, fresh]);
  assert.equal(sets.length, 2);
  assert.deepEqual(sets.map((set) => set.legacy).sort(), [false, true]);
});

test("whether the server holds a set is read off its members: none, some, or all, and the archive's own sizes", () => {
  const copy = (savedAt, extra = {}) => ({ saveId: "s1", archive: "/data/vault/Lenovo-EDL-backup-2026-10-06.zip", entry: "Lenovo-EDL-backup-2026-10-06/x.bin", archiveBytes: 610, originalBytes: 3800, savedAt, verified: true, ...extra });
  const members = [output("a.bin", T0, edl("op-1")), output("b.bin", T0 + 1000, edl("op-1")), output("c.bin", T0 + 2000, edl("op-1"))];
  const [set] = groupArtifactSets(members);
  assert.deepEqual(setSaveState(set, members), { state: "none" });

  const some = [{ ...members[0], server: copy(5) }, members[1], members[2]];
  assert.deepEqual(setSaveState(set, some), { state: "partial", saved: 1, total: 3 });

  const all = members.map((member, index) => ({ ...member, server: copy(10 + index) }));
  assert.deepEqual(setSaveState(set, all), { state: "saved", path: "/data/vault/Lenovo-EDL-backup-2026-10-06.zip", savedAt: 12, verified: true, files: 3, bytes: 3800, archiveBytes: 610, archives: 1 });

  const unverified = all.map((member, index) => (index === 1 ? { ...member, server: copy(11, { verified: false }) } : member));
  assert.equal(setSaveState(set, unverified).verified, false, "one unverified file means the set is not verified");

  const twoSaves = all.map((member, index) => (index === 2 ? { ...member, server: copy(99, { archive: "/data/vault/Lenovo-EDL-backup-2026-10-07.zip", archiveBytes: 70, originalBytes: 500, saveId: "s2" }) } : member));
  const split = setSaveState(set, twoSaves);
  assert.equal(split.path, "/data/vault/Lenovo-EDL-backup-2026-10-07.zip", "the newest save is the one named");
  assert.deepEqual([split.archives, split.bytes, split.archiveBytes], [2, 4300, 680], "the numbers are those of the archives that hold the set");
});

test("the part of a Qualcomm file name a person reads is the partition; other names are left alone", () => {
  assert.equal(shortArtifactName("edl-1a2b3c-set-p12-boot_a.bin"), "boot_a");
  assert.equal(shortArtifactName("edl-1a2b3c-set-gpt-primary.bin"), "gpt-primary");
  assert.equal(shortArtifactName("edl-1a2b3c-set-gpt-backup.bin"), "gpt-backup");
  assert.equal(shortArtifactName("edl-1a2b3c-set-0123abcd.manifest.json"), "manifest.json");
  assert.equal(shortArtifactName("edl-1a2b3c-boot_a.bin"), "boot_a");
  assert.equal(shortArtifactName("edl-1a2b3c-boot_a-4096+8192.bin"), "boot_a-4096+8192");
  assert.equal(shortArtifactName("edl-1a2b3c-user-area.bin"), "user-area");
  assert.equal(shortArtifactName("edl-1a2b3c-restore-0123abcd-gpt-primary.pre.bin"), "gpt-primary.pre");
  assert.equal(shortArtifactName("DCIM/photo.jpg"), "DCIM/photo.jpg");
  assert.equal(shortArtifactName("esp-flash-backup.bin"), "esp-flash-backup.bin");
});
