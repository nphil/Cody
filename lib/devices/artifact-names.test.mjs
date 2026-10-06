import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { MANIFEST_NAME, SUMS_NAME, labelSlug, safeFileName, uniqueFileNames } = await jiti.import("./artifact-names.ts");

test("a file name becomes one safe segment: no separator, drive, control character or hiding dot", () => {
  assert.equal(safeFileName("boot_a.bin"), "boot_a.bin");
  assert.equal(safeFileName("../x"), "__x");
  assert.equal(safeFileName("a/b\\c:d.bin"), "a_b_c_d.bin");
  assert.equal(safeFileName("C:\\Windows\\win.ini"), "C_Windows_win.ini");
  assert.equal(safeFileName("line\nbreak\u0000.bin"), "line_break_.bin");
  assert.equal(safeFileName(".hidden"), "_hidden");
  assert.equal(safeFileName("trailing. . "), "trailing");
  assert.equal(safeFileName("   "), "_");
  assert.equal(safeFileName(""), "file");
  assert.equal(safeFileName("データ-π.bin"), "データ-π.bin");
});

test("the names a save writes itself, and the ones Windows keeps for devices, are moved aside", () => {
  assert.equal(MANIFEST_NAME, "manifest.json");
  assert.equal(SUMS_NAME, "SHA256SUMS");
  assert.equal(safeFileName("manifest.json"), "file-manifest.json");
  assert.equal(safeFileName("MANIFEST.JSON"), "file-MANIFEST.JSON");
  assert.equal(safeFileName("SHA256SUMS"), "file-SHA256SUMS");
  assert.equal(safeFileName("sha256sums"), "file-sha256sums");
  assert.equal(safeFileName("nul.txt"), "_nul.txt");
  assert.equal(safeFileName("COM1"), "_COM1");
  assert.equal(safeFileName("console.txt"), "console.txt", "only the exact reserved words");
});

test("a long name is cut to 200 bytes between characters and keeps its extension", () => {
  const long = safeFileName(`${"é".repeat(300)}.bin`);
  assert.ok(new TextEncoder().encode(long).length <= 200);
  assert.ok(long.endsWith(".bin"));
  assert.ok(!long.includes("\ufffd"), "no character was split");
  assert.ok(new TextEncoder().encode(safeFileName("x".repeat(500))).length <= 200);
});

test("names stay unique ignoring case, in order, even after being cut or cleaned into each other", () => {
  assert.deepEqual(uniqueFileNames(["a.bin", "A.bin", "a.bin"]), ["a.bin", "A-2.bin", "a-3.bin"]);
  assert.deepEqual(uniqueFileNames(["a/b", "a\\b", "a_b"]), ["a_b", "a_b-2", "a_b-3"]);
  assert.deepEqual(uniqueFileNames(["manifest.json", "file-manifest.json"]), ["file-manifest.json", "file-manifest-2.json"]);
  const names = uniqueFileNames(Array.from({ length: 4 }, () => `${"x".repeat(300)}.bin`));
  assert.equal(new Set(names).size, 4);
  assert.ok(names.every((name) => new TextEncoder().encode(name).length <= 200));
});

test("a folder label is letters, digits, dot, dash and underscore, short, and never empty or hidden", () => {
  assert.equal(labelSlug("Lenovo QUSB__BULK EDL backup"), "Lenovo-QUSB__BULK-EDL-backup");
  assert.equal(labelSlug("  Lenovo / Smart Display: EDL backup!! "), "Lenovo-Smart-Display-EDL-backup");
  assert.equal(labelSlug("../../etc"), "etc");
  assert.equal(labelSlug("Café ☕"), "Cafe");
  assert.equal(labelSlug("☃"), "artifacts");
  assert.equal(labelSlug(""), "artifacts");
  assert.equal(labelSlug(".hidden"), "hidden");
  assert.ok(labelSlug("x".repeat(100)).length <= 48);
  assert.ok(!labelSlug("x".repeat(47) + "-----").endsWith("-"));
});
