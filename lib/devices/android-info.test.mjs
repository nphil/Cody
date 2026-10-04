import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { UPDATE_IMAGES, checkRequirements, parseAndroidInfo } = await jiti.import("./android-info.ts");
const { classifyProtectedRegionName } = await jiti.import("./hardware-safety.ts");

const answers = (variables) => async (name) => variables[name];

test("requirement lines parse the way fastboot's ParseRequirementLine reads them", () => {
  const info = parseAndroidInfo([
    "require board=alpha|beta | gamma",
    "board=delta",
    "reject product=bad",
    "require-for-product:gamma version-bootloader=istanbul|constantinople",
    "require partition-exists=vendor",
    "this line is nonsense",
    "",
  ].join("\r\n"));
  assert.deepEqual(info.requirements.map(({ name, product, invert, options }) => ({ name, product, invert, options })), [
    { name: "product", product: undefined, invert: false, options: ["alpha", "beta", "gamma"] },
    { name: "product", product: undefined, invert: false, options: ["delta"] },
    { name: "product", product: undefined, invert: true, options: ["bad"] },
    { name: "version-bootloader", product: "gamma", invert: false, options: ["istanbul", "constantinople"] },
    { name: "partition-exists", product: undefined, invert: false, options: ["vendor"] },
  ]);
  assert.deepEqual(info.syntaxErrors, ["this line is nonsense"]);
});

test("a requirement is met by an equal value or a trailing-star prefix, and reject inverts it", async () => {
  const info = parseAndroidInfo("require board=cronos\nrequire version-bootloader=1.0|1.1*\nreject serialno=BLOCKED*\n");
  const outcomes = await checkRequirements(info, "cronos", answers({ product: "cronos", "version-bootloader": " 1.1b ", serialno: "OK123" }));
  assert.deepEqual(outcomes.map((outcome) => outcome.met), [true, true, true]);

  const wrong = await checkRequirements(info, "x", answers({ product: "tablet", "version-bootloader": "2.0", serialno: "BLOCKED9" }));
  assert.deepEqual(wrong.map((outcome) => outcome.met), [false, false, false]);
  assert.match(wrong[0].detail, /device product is 'tablet'; the package requires 'cronos'/);
  assert.match(wrong[1].detail, /requires '1\.0' or '1\.1\*'/);
  assert.match(wrong[2].detail, /rejects 'BLOCKED\*'/);
});

test("a variable the bootloader will not report fails its requirement, and product-specific lines apply only to that product", async () => {
  const info = parseAndroidInfo("require version-baseband=9\nrequire-for-product:other version-bootloader=1\nrequire-for-product:cronos version-bootloader=1\n");
  const outcomes = await checkRequirements(info, "cronos", answers({ "version-bootloader": "1" }));
  assert.equal(outcomes[0].met, false);
  assert.match(outcomes[0].detail, /would not report version-baseband/);
  assert.equal(outcomes[1].met, true);
  assert.match(outcomes[1].detail, /applies only to other/);
  assert.equal(outcomes[2].met, true);
});

test("partition-exists needs the device to know the partition at all", async () => {
  const info = parseAndroidInfo("require partition-exists=vendor_dlkm\n");
  assert.equal((await checkRequirements(info, "x", answers({ "has-slot:vendor_dlkm": "no" })))[0].met, true);
  assert.equal((await checkRequirements(info, "x", answers({ "has-slot:vendor_dlkm": "yes" })))[0].met, true);
  const missing = await checkRequirements(info, "x", answers({}));
  assert.equal(missing[0].met, false);
  assert.match(missing[0].detail, /does not have the required partition vendor_dlkm/);
});

test("the update image table puts boot-critical partitions before operating-system ones and names no extras", () => {
  const partitions = UPDATE_IMAGES.map((image) => image.partition);
  assert.ok(partitions.indexOf("boot") < partitions.indexOf("system"));
  assert.ok(partitions.indexOf("vbmeta") < partitions.indexOf("vendor"));
  assert.ok(partitions.indexOf("vendor_boot") < partitions.indexOf("odm"));
  for (const extra of ["bootloader", "radio", "cache", "super", "userdata"]) assert.equal(partitions.includes(extra), false, `${extra} is not flashed by update`);
  assert.equal(UPDATE_IMAGES.find((image) => image.file === "dt.img").partition, "dts");
  assert.equal(new Set(partitions).size, partitions.length);
  // A package can never reach a protected partition, so an update needs no per-partition protected override.
  for (const partition of partitions) {
    for (const slotted of [partition, `${partition}_a`, `${partition}_b`]) {
      assert.equal(classifyProtectedRegionName(slotted), undefined, `${slotted} is not a protected region`);
      assert.doesNotMatch(slotted, /^(?:rpmb|gpt|pgpt|sgpt|boot[01]|mmcblk\d+boot[01])(?:[_:-].*)?$/i);
    }
  }
});
