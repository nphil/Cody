import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { applySparse, patterned, sparseFile } from "./sparse.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildSparsePiece, imageFootprint, parseSparseLayout, planImageSplit, planSparsePieces } = await jiti.import("./sparse-image.ts");

const BLOCK = 4096;
const SENTINEL = 0xee;

async function piecesOf(image, limit) {
  const split = await planImageSplit(image, limit);
  return { split, files: split.pieces.map((piece) => ({ piece, blob: buildSparsePiece(image, split.layout, piece) })) };
}

test("a plain image over the limit becomes sparse pieces that each fit and together rewrite the whole image", async () => {
  const raw = patterned(10 * BLOCK + 100);
  const limit = 28 + 3 * 12 + 3 * BLOCK; // three data blocks per piece after the overhead
  const { split, files } = await piecesOf(new Blob([raw]), limit);
  assert.equal(split.layout.sparse, false);
  assert.equal(files.length, 4, "11 blocks at 3 per piece");
  const partition = new Uint8Array(11 * BLOCK).fill(SENTINEL);
  for (const { piece, blob } of files) {
    assert.ok(blob.size <= limit, `piece of ${blob.size} bytes exceeds ${limit}`);
    assert.equal(blob.size, piece.bytes);
    const geometry = applySparse(partition, Buffer.from(await blob.arrayBuffer()));
    assert.deepEqual(geometry, { blockSize: BLOCK, totalBlocks: 11 });
  }
  assert.deepEqual(Buffer.from(partition.subarray(0, raw.length)), raw);
  assert.deepEqual([...partition.subarray(raw.length)], new Array(11 * BLOCK - raw.length).fill(0), "the final partial block is zero-padded, as libsparse does");
});

test("every piece is itself a valid sparse file whose layout the library can read back", async () => {
  const raw = patterned(7 * BLOCK);
  const { split, files } = await piecesOf(new Blob([raw]), 28 + 3 * 12 + 2 * BLOCK);
  for (const { blob } of files) {
    const layout = await parseSparseLayout(blob);
    assert.equal(layout.sparse, true);
    assert.equal(layout.blockCount, split.layout.blockCount);
    assert.equal(layout.byteLength, 7 * BLOCK);
    await imageFootprint(blob);
  }
});

test("a sparse image keeps its holes: skipped blocks are never touched, fills stay one small chunk", async () => {
  const image = sparseFile(BLOCK, [
    { type: "raw", blocks: 4, data: patterned(4 * BLOCK, 2) },
    { type: "skip", blocks: 6 },
    { type: "fill", blocks: 1000, pattern: Buffer.from([1, 2, 3, 4]) },
    { type: "skip", blocks: 3 },
    { type: "raw", blocks: 5, data: patterned(5 * BLOCK, 3) },
    { type: "skip", blocks: 2 },
  ]);
  const limit = 28 + 3 * 12 + 2 * BLOCK;
  const { split, files } = await piecesOf(new Blob([image]), limit);
  assert.ok(files.length >= 4, "RAW runs are cut at the limit");
  const fillPieces = split.pieces.filter((piece) => piece.items.some((item) => item.kind === "fill"));
  assert.equal(fillPieces.length, 1, "a fill covering 1000 blocks is carried once, not split");
  const total = 4 + 6 + 1000 + 3 + 5 + 2;
  const partition = new Uint8Array(total * BLOCK).fill(SENTINEL);
  for (const { blob } of files) {
    assert.ok(blob.size <= limit);
    applySparse(partition, Buffer.from(await blob.arrayBuffer()));
  }
  const expected = new Uint8Array(total * BLOCK).fill(SENTINEL);
  expected.set(patterned(4 * BLOCK, 2), 0);
  for (let offset = 0; offset < 1000 * BLOCK; offset += 4) expected.set([1, 2, 3, 4], 10 * BLOCK + offset);
  expected.set(patterned(5 * BLOCK, 3), (10 + 1000 + 3) * BLOCK);
  assert.deepEqual(partition, expected);
});

test("pieces follow image order, never overlap, and never carry the same block twice", async () => {
  const image = sparseFile(BLOCK, [
    { type: "skip", blocks: 2 },
    { type: "raw", blocks: 9, data: patterned(9 * BLOCK, 4) },
    { type: "fill", blocks: 3, pattern: Buffer.from([9, 9, 9, 9]) },
    { type: "raw", blocks: 2, data: patterned(2 * BLOCK, 5) },
  ]);
  const { split } = await piecesOf(new Blob([image]), 28 + 3 * 12 + 4 * BLOCK);
  const carried = [];
  for (const piece of split.pieces) {
    let cursor = 0;
    for (const item of piece.items) {
      if (item.kind !== "skip") carried.push([cursor, item.blocks]);
      cursor += item.blocks;
    }
    assert.equal(cursor, 16, "each piece describes the whole image");
  }
  let next = 2; // the leading hole is never carried
  for (const [start, blocks] of carried) {
    assert.equal(start, next, "carried runs are contiguous, in image order, with no block repeated");
    next = start + blocks;
  }
  assert.equal(next, 16);
});

test("an image that already fits is a single piece, and an image of nothing but holes has no data to flash", async () => {
  const { files } = await piecesOf(new Blob([patterned(3 * BLOCK)]), 1 << 20);
  assert.equal(files.length, 1);
  await assert.rejects(planImageSplit(new Blob([sparseFile(BLOCK, [{ type: "skip", blocks: 8 }])]), 1 << 20), /no data to write/);
});

test("a download limit too small to carry one block is refused rather than looping", async () => {
  const image = new Blob([patterned(2 * BLOCK)]);
  await assert.rejects(planImageSplit(image, 28 + 3 * 12 + BLOCK - 1), /needs at least 4160 bytes/);
  await assert.rejects(planImageSplit(image, Number.NaN), /needs at least/);
  const exact = await planImageSplit(image, 28 + 3 * 12 + BLOCK);
  assert.equal(exact.pieces.length, 2, "exactly one block of room per piece still progresses");
  assert.ok(exact.pieces.every((piece) => piece.bytes <= 28 + 3 * 12 + BLOCK));
});

test("random sparse layouts always split into pieces that fit and rewrite exactly the carried blocks", async () => {
  let state = 12345;
  const next = (bound) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state >> 8) % bound;
  };
  for (let round = 0; round < 40; round += 1) {
    const blockSize = [512, 1024, 4096][next(3)];
    const chunks = [];
    for (let index = 0, count = 1 + next(8); index < count; index += 1) {
      const blocks = 1 + next(40);
      const kind = ["raw", "fill", "skip"][next(3)];
      chunks.push(kind === "raw" ? { type: "raw", blocks, data: patterned(blocks * blockSize, round * 31 + index) } : kind === "fill" ? { type: "fill", blocks, pattern: Buffer.from([next(256), next(256), next(256), next(256)]) } : { type: "skip", blocks });
    }
    if (chunks.every((chunk) => chunk.type === "skip")) continue;
    const image = sparseFile(blockSize, chunks);
    const limit = 28 + 3 * 12 + blockSize * (1 + next(12));
    const { files } = await piecesOf(new Blob([image]), limit);
    const total = chunks.reduce((sum, chunk) => sum + chunk.blocks, 0);
    const expected = new Uint8Array(total * blockSize).fill(SENTINEL);
    let block = 0;
    for (const chunk of chunks) {
      if (chunk.type === "raw") expected.set(chunk.data, block * blockSize);
      else if (chunk.type === "fill") for (let offset = 0; offset < chunk.blocks * blockSize; offset += 4) expected.set(chunk.pattern, block * blockSize + offset);
      block += chunk.blocks;
    }
    const partition = new Uint8Array(total * blockSize).fill(SENTINEL);
    for (const { blob } of files) {
      assert.ok(blob.size <= limit, `round ${round}: piece ${blob.size} > ${limit}`);
      applySparse(partition, Buffer.from(await blob.arrayBuffer()));
    }
    assert.deepEqual(partition, expected, `round ${round}`);
  }
});

test("planSparsePieces takes a layout directly so the pieces can be counted before any is built", async () => {
  const layout = await parseSparseLayout(new Blob([patterned(5 * BLOCK)]));
  const pieces = planSparsePieces(layout, 28 + 3 * 12 + 2 * BLOCK);
  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces.map((piece) => piece.items.filter((item) => item.kind === "data").reduce((sum, item) => sum + item.blocks, 0)), [2, 2, 1]);
});
