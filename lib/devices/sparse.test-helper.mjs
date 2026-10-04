import assert from "node:assert/strict";

/** Builds an Android sparse file: chunks are { type: "raw"|"fill"|"skip", blocks, data?, pattern? }. */
export function sparseFile(blockSize, chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.blocks, 0);
  const header = Buffer.alloc(28);
  header.writeUInt32LE(0xed26ff3a, 0);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(28, 8);
  header.writeUInt16LE(12, 10);
  header.writeUInt32LE(blockSize, 12);
  header.writeUInt32LE(total, 16);
  header.writeUInt32LE(chunks.length, 20);
  const parts = [header];
  for (const chunk of chunks) {
    const payload = chunk.type === "raw" ? chunk.data : chunk.type === "fill" ? chunk.pattern : Buffer.alloc(0);
    const head = Buffer.alloc(12);
    head.writeUInt16LE({ raw: 0xcac1, fill: 0xcac2, skip: 0xcac3 }[chunk.type], 0);
    head.writeUInt32LE(chunk.blocks, 4);
    head.writeUInt32LE(12 + payload.length, 8);
    parts.push(head, payload);
  }
  return Buffer.concat(parts);
}

/** True for a buffer that begins with the Android sparse magic. */
export function isSparse(file) {
  return file.length >= 28 && file.readUInt32LE(0) === 0xed26ff3a;
}

/**
 * A reader independent of the library under test: applies a sparse file to a
 * partition image the way a bootloader does (raw writes, fill repeats,
 * DONT_CARE leaves the bytes alone), asserting the file is well formed.
 */
export function applySparse(partition, file) {
  assert.equal(file.readUInt32LE(0), 0xed26ff3a, "sparse magic");
  assert.equal(file.readUInt16LE(4), 1);
  assert.equal(file.readUInt16LE(8), 28);
  assert.equal(file.readUInt16LE(10), 12);
  const blockSize = file.readUInt32LE(12);
  const totalBlocks = file.readUInt32LE(16);
  const chunks = file.readUInt32LE(20);
  let at = 28;
  let block = 0;
  for (let index = 0; index < chunks; index += 1) {
    const type = file.readUInt16LE(at);
    const blocks = file.readUInt32LE(at + 4);
    const total = file.readUInt32LE(at + 8);
    const payload = file.subarray(at + 12, at + total);
    if (type === 0xcac1) {
      assert.equal(payload.length, blocks * blockSize, "RAW chunk carries whole blocks");
      partition.set(payload, block * blockSize);
    } else if (type === 0xcac2) {
      assert.equal(payload.length, 4);
      for (let offset = 0; offset < blocks * blockSize; offset += 4) partition.set(payload, block * blockSize + offset);
    } else assert.equal(type, 0xcac3, "only RAW, FILL and DONT_CARE are emitted");
    block += blocks;
    at += total;
  }
  assert.equal(at, file.length, "chunks account for every byte of the file");
  assert.equal(block, totalBlocks, "chunks cover the whole image");
  return { blockSize, totalBlocks };
}

/** Deterministic pseudo-random bytes. */
export function patterned(length, seed = 1) {
  const bytes = Buffer.alloc(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = (state >> 16) & 0xff;
  }
  return bytes;
}
