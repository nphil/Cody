import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { crc32 as nodeCrc32 } from "node:zlib";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { Crc32, crc32 } = await jiti.import("./crc32.ts");

test("the CRC-32 of the standard check string is the published value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("every length and every split agrees with zlib, so slice-by-8 and its tail cannot drift", () => {
  const bytes = randomBytes(70_001);
  for (const length of [1, 7, 8, 9, 15, 16, 17, 63, 64, 65, 255, 256, 4095, 65_536, 70_001]) {
    assert.equal(crc32(bytes.subarray(0, length)), nodeCrc32(bytes.subarray(0, length)), `length ${length}`);
  }
  for (const cut of [1, 3, 8, 13, 1000, 30_000]) {
    const incremental = new Crc32().update(bytes.subarray(0, cut)).update(bytes.subarray(cut)).digest();
    assert.equal(incremental, nodeCrc32(bytes), `split at ${cut}`);
  }
});

test("a digest can be read in the middle of a stream and the stream carries on", () => {
  const bytes = randomBytes(5000);
  const crc = new Crc32().update(bytes.subarray(0, 2000));
  assert.equal(crc.digest(), nodeCrc32(bytes.subarray(0, 2000)));
  assert.equal(crc.update(bytes.subarray(2000)).digest(), nodeCrc32(bytes));
});

test("a value with its top bit set stays an unsigned number", () => {
  const found = [];
  for (let seed = 0; seed < 64 && found.length < 3; seed += 1) {
    const value = crc32(new Uint8Array([seed, seed + 1, seed + 2]));
    if (value > 0x7fffffff) found.push(value);
  }
  assert.ok(found.length > 0 && found.every((value) => Number.isInteger(value) && value > 0x7fffffff && value <= 0xffffffff));
});
