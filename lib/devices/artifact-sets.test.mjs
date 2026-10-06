import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SET_BURST_GAP_MS, groupArtifactSets, setSaveState, shortArtifactName } = await jiti.import("./artifact-sets.ts");

const MINUTE = 60_000;
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

test("everything one operation saved is one set, oldest file first, with its size and the device's name", () => {
  const files = [];
  for (let index = 0; index < 58; index += 1) files.unshift(output(`edl-1a2b-set-p${index}-part${index}.bin`, T0 + index * 20_000, edl("op-backup")));
  const sets = groupArtifactSets(files);
  assert.equal(sets.length, 1);
  const [set] = sets;
  assert.equal(set.count, 58);
  assert.equal(set.legacy, false);
  assert.deepEqual(set.operationIds, ["op-backup"]);
  assert.equal(set.label, "Lenovo QUSB__BULK");
  assert.equal(set.protocol, "edl");
  assert.equal(set.command, "backup");
  assert.equal(set.startedAt, T0);
  assert.equal(set.endedAt, T0 + 57 * 20_000);
  assert.equal(set.totalBytes, files.reduce((total, file) => total + file.size, 0));
  assert.equal(set.artifactIds[0], files.find((file) => file.createdAt === T0).id, "oldest first, whatever order the list came in");
  assert.equal(set.id, `set:${set.artifactIds[0]}`);
});

test("a burst of single dumps on one device is one set, and the gap that ends it is the activity feed's two minutes", () => {
  const dump = (operationId, at) => output(`${operationId}.bin`, at, { operationId, deviceId: "usb-1", protocol: "edl", action: "dump", target: operationId, label: "Lenovo" });
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

test("whether the server holds a set is read off its members: none, some, or all", () => {
  const copy = (savedAt, verified = true, folder = "/data/vault/2026-10-06-backup") => ({ saveId: "s1", path: `${folder}/x.bin`, folder, savedAt, verified });
  const members = [output("a.bin", T0, edl("op-1")), output("b.bin", T0 + 1000, edl("op-1")), output("c.bin", T0 + 2000, edl("op-1"))];
  const [set] = groupArtifactSets(members);
  assert.deepEqual(setSaveState(set, members), { state: "none" });

  const some = [{ ...members[0], server: copy(5) }, members[1], members[2]];
  assert.deepEqual(setSaveState(set, some), { state: "partial", saved: 1, total: 3 });

  const all = members.map((member, index) => ({ ...member, server: copy(10 + index) }));
  assert.deepEqual(setSaveState(set, all), { state: "saved", path: "/data/vault/2026-10-06-backup", savedAt: 12, verified: true, files: 3, bytes: set.totalBytes });

  const unverified = all.map((member, index) => (index === 1 ? { ...member, server: copy(11, false) } : member));
  assert.equal(setSaveState(set, unverified).verified, false, "one unverified file means the set is not verified");

  const twoSaves = all.map((member, index) => (index === 2 ? { ...member, server: copy(99, true, "/data/vault/2026-10-07-backup") } : member));
  assert.equal(setSaveState(set, twoSaves).path, "/data/vault/2026-10-07-backup", "the newest save is the one named");
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
