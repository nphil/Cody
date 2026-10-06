import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  HardwareSafetyError,
  bindIntrinsicFlashSafety,
  parseFlashSafety,
  runVerifiedFlash,
  sha256Blob,
} = await jiti.import("./hardware-safety.ts");

const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function protections(overrides = {}) {
  return { preloader: "absent", lk: "absent", tee: "absent", fuses: "absent", bootloader: "absent", "spi-boot": "absent", unknown: "absent", ...overrides };
}

function layout(overrides = {}) {
  return {
    protocol: "esp",
    chip: "ESP32",
    storage: "spi",
    protections: protections({ "spi-boot": "present" }),
    regions: [
      { name: "boot", offset: 0, length: 0x1000, protection: "spi-boot" },
      { name: "app", offset: 0x1000, length: 0x1000 },
    ],
    ...overrides,
  };
}

function request(overrides = {}) {
  return { protocol: "esp", action: "flash", target: "app", offset: 0x1000, sha256: SHA256_ABC, ...overrides };
}

function plan(overrides = {}) {
  return {
    protocol: "esp",
    chip: "ESP32",
    region: "app",
    offset: 0x1000,
    eraseOffset: 0x1000,
    eraseLength: 3,
    layout: layout(),
    ...overrides,
  };
}

function context(input, confirmations) {
  return {
    transport: {
      kind: "serial",
      async read() { return null; },
      async write() { throw new Error("safety guard must not write transport directly"); },
    },
    signal: new AbortController().signal,
    progress() {},
    input,
    async save() { return "backup-file"; },
    async confirm(risk) { confirmations.push(risk); },
  };
}

test("hashes Blob firmware", async () => {
  assert.equal(await sha256Blob(new Blob(["abc"])), SHA256_ABC);
});

test("rejects caller-supplied layouts and protection maps", () => {
  assert.throws(() => parseFlashSafety({ safety: { layout: layout() } }), HardwareSafetyError);
  assert.throws(() => parseFlashSafety({ protections: protections() }), HardwareSafetyError);
  assert.deepEqual(parseFlashSafety({ expectedChip: "ESP32", protectedOverride: "allow-spi-boot" }), {
    expectedChip: "ESP32", protectedOverride: "allow-spi-boot",
  });
  assert.deepEqual(parseFlashSafety({ protectedOverride: "allow-unknown" }), {
    protectedOverride: "allow-unknown",
  });
});
test("binds only exact detected plans to the request", () => {
  assert.throws(() => bindIntrinsicFlashSafety(request({ offset: 0 }), {}, plan()), /target and offset/);
  assert.throws(() => bindIntrinsicFlashSafety(request(), { expectedChip: "ESP8266" }, plan()), /does not match detected/);
  assert.throws(() => bindIntrinsicFlashSafety(request(), {}, plan({ eraseOffset: 0, eraseLength: 3 })), /allow-spi-boot/);
});
test("requires the exact unknown override for an intrinsically unclassified range", () => {
  const unknownLayout = layout({
    protections: protections({ "spi-boot": "present", unknown: "present" }),
    regions: [
      { name: "boot", offset: 0, length: 0x1000, protection: "spi-boot" },
      { name: "app", offset: 0x1000, length: 0x1000, protection: "unknown" },
    ],
  });
  const unknownPlan = plan({ layout: unknownLayout });
  assert.throws(() => bindIntrinsicFlashSafety(request(), {}, unknownPlan), /allow-unknown/);
  const safety = bindIntrinsicFlashSafety(request(), { protectedOverride: "allow-unknown" }, unknownPlan);
  assert.equal(safety.region, "app");
});

test("names unknown target topology in confirmation", async () => {
  const confirmations = [];
  const unknownLayout = layout({
    protections: protections({ "spi-boot": "present", unknown: "present" }),
    regions: [
      { name: "boot", offset: 0, length: 0x1000, protection: "spi-boot" },
      { name: "app", offset: 0x1000, length: 0x1000, protection: "unknown" },
    ],
  });
  const safety = bindIntrinsicFlashSafety(request(), { protectedOverride: "allow-unknown" }, plan({ layout: unknownLayout }));
  const input = new Blob(["abc"]);
  await runVerifiedFlash({
    request: request(), context: context(input, confirmations), safety, backup: "unknown-backup", programImage: input,
    async write() {}, async readback() { return input; },
  });
  assert.equal(confirmations[0].details, 'Unclassified esp target "app": role and topology are unknown.');
  assert.equal("protectedOverride" in confirmations[0], false, "the request named the override; the declared risk asks nobody to type one");
});
test("binds a contiguous factory footprint across intrinsic regions only with its exact override", () => {
  const factoryRequest = request({ target: "factory", offset: 0 });
  const factoryPlan = plan({ region: "factory", offset: 0, eraseOffset: 0, eraseLength: 0x1001 });
  assert.throws(() => bindIntrinsicFlashSafety(factoryRequest, {}, factoryPlan), /allow-spi-boot/);
  assert.equal(
    bindIntrinsicFlashSafety(factoryRequest, { protectedOverride: "allow-spi-boot" }, factoryPlan).eraseLength,
    0x1001,
  );
});

test("requires a bound plan and complete erase image before confirmation", async () => {
  const confirmations = [];
  const raw = { protocol: "esp", chip: "ESP32", region: "app", offset: 0x1000, eraseOffset: 0x1000, eraseLength: 3, layout: layout() };
  await assert.rejects(
    runVerifiedFlash({ request: request(), context: context(new Blob(["abc"]), confirmations), safety: raw, backup: "backup", programImage: new Blob(["abc"]), async write() {}, async readback() { return new Blob(["abc"]); } }),
    /must be bound/,
  );
  const safety = bindIntrinsicFlashSafety(request(), {}, plan());
  await assert.rejects(
    runVerifiedFlash({ request: request(), context: context(new Blob(["abc"]), confirmations), safety, backup: "backup", programImage: new Blob(["ab"]), async write() {}, async readback() { return new Blob(["ab"]); } }),
    /complete intrinsic erase footprint/,
  );
  assert.deepEqual(confirmations, []);
});

test("confirms, writes, and verifies the full intrinsic erase footprint exactly once", async () => {
  const input = new Blob(["abc"]);
  const confirmations = [];
  const safety = bindIntrinsicFlashSafety(request(), {}, plan());
  let writes = 0;
  const result = await runVerifiedFlash({
    request: request(), context: context(input, confirmations), safety, backup: "full-footprint-backup",
    programImage: input,
    async write(image, approval) { writes += 1; assert.equal(image, input); assert.equal(approval.offset, 0x1000); assert.equal(approval.payloadOffset, 0x1000); },
    async readback() { return input; },
  });
  assert.equal(writes, 1);
  assert.deepEqual(confirmations, [{ action: "flash", target: "app", sha256: SHA256_ABC, offset: 0x1000, length: 3, programSha256: SHA256_ABC, programOffset: 0x1000, programLength: 3, backup: "full-footprint-backup" }]);
  assert.equal(result.verified, true);
});

test("readback mismatch after a write is never verified", async () => {
  const input = new Blob(["abc"]);
  const safety = bindIntrinsicFlashSafety(request(), {}, plan());
  let writes = 0;
  await assert.rejects(
    runVerifiedFlash({
      request: request(), context: context(input, []), safety, backup: "full-footprint-backup", programImage: input,
      async write() { writes += 1; }, async readback() { return new Blob(["bad"]); },
    }),
    /SHA-256 does not match/,
  );
  assert.equal(writes, 1);
});
