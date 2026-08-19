import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./zip.ts");
}

async function collectZip(entries) {
  const { generateZip } = await loadSubject();
  const chunks = [];
  for await (const chunk of generateZip(entries)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("builds an archive that python extracts back to the fixture bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-zip-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const binary = Buffer.alloc(4096);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 31) & 0xff;
  fs.writeFileSync(path.join(root, "a.txt"), "hello zip\n");
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested", "b.bin"), binary);

  const archive = await collectZip([
    { name: "a.txt", filePath: path.join(root, "a.txt") },
    { name: "nested/", mtime: new Date("2024-05-06T07:08:09") },
    { name: "nested/b.bin", filePath: path.join(root, "nested", "b.bin") },
    { name: "empty/" },
    { name: "日本語.txt", data: new TextEncoder().encode("unicode name") },
  ]);
  const zipPath = path.join(root, "out.zip");
  fs.writeFileSync(zipPath, archive);

  // End-of-central-directory record: 5 entries, directory within bounds.
  const eocd = archive.length - 22;
  assert.equal(archive.readUInt32LE(eocd), 0x06054b50);
  assert.equal(archive.readUInt16LE(eocd + 10), 5);
  const cdSize = archive.readUInt32LE(eocd + 12);
  const cdOffset = archive.readUInt32LE(eocd + 16);
  assert.equal(cdOffset + cdSize, eocd);

  // Walk the central directory: signatures and names round-trip.
  const names = [];
  let pos = cdOffset;
  for (let i = 0; i < 5; i++) {
    assert.equal(archive.readUInt32LE(pos), 0x02014b50);
    const nameLength = archive.readUInt16LE(pos + 28);
    names.push(archive.toString("utf8", pos + 46, pos + 46 + nameLength));
    pos += 46 + nameLength;
  }
  assert.deepEqual(names, ["a.txt", "nested/", "nested/b.bin", "empty/", "日本語.txt"]);

  // python3 -m zipfile -t re-reads every member and checks its CRC.
  execFileSync("python3", ["-m", "zipfile", "-t", zipPath], { stdio: "pipe" });

  // Full extraction round-trip.
  const extracted = path.join(root, "extracted");
  execFileSync("python3", ["-m", "zipfile", "-e", zipPath, extracted], { stdio: "pipe" });
  assert.equal(fs.readFileSync(path.join(extracted, "a.txt"), "utf8"), "hello zip\n");
  assert.deepEqual(fs.readFileSync(path.join(extracted, "nested", "b.bin")), binary);
  assert.equal(fs.readFileSync(path.join(extracted, "日本語.txt"), "utf8"), "unicode name");
  assert.ok(fs.statSync(path.join(extracted, "empty")).isDirectory());
});

test("rejects archives beyond the plain zip entry limit", async () => {
  const { ZipSizeLimitError } = await loadSubject();
  function* tooMany() {
    for (let i = 0; i <= 0xffff; i++) yield { name: `d${i}/` };
  }
  await assert.rejects(collectZip(tooMany()), ZipSizeLimitError);
});
