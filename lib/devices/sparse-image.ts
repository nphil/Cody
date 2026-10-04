/**
 * Android sparse image v1 (system/core/libsparse/sparse_format.h): reading its
 * layout, the readback footprint Fastboot verification compares, and
 * `fastboot`'s automatic resparse of an image larger than the bootloader's
 * `max-download-size` into pieces that each fit one download.
 */

const SPARSE_MAGIC = 0xed26ff3a;
const SPARSE_HEADER_BYTES = 28;
const CHUNK_HEADER_BYTES = 12;
const CHUNK_RAW = 0xcac1;
const CHUNK_FILL = 0xcac2;
const CHUNK_DONT_CARE = 0xcac3;
const CHUNK_CRC32 = 0xcac4;
/** libsparse treats a plain file as 4 KiB blocks. */
const RAW_BLOCK_BYTES = 4096;

export type ImageExtent = { offset: number; length: number; dataOffset?: number; fill?: Uint8Array };
export interface ImageFootprint { length: number; sparse: boolean; extents: ImageExtent[]; skipped: number }

/** One run of blocks of the expanded image, in image order. `dataOffset` is a byte offset into the source file. */
export type SparseRun =
  | { readonly kind: "data"; readonly block: number; readonly blocks: number; readonly dataOffset: number }
  | { readonly kind: "fill"; readonly block: number; readonly blocks: number; readonly pattern: Uint8Array }
  | { readonly kind: "skip"; readonly block: number; readonly blocks: number };

export interface SparseLayout {
  readonly sparse: boolean;
  readonly blockSize: number;
  readonly blockCount: number;
  readonly runs: readonly SparseRun[];
  /** Bytes of the expanded image (a plain file's own length). */
  readonly byteLength: number;
}

/** Reads a file as the sequence of block runs it expands to. A plain file is one data run. */
export async function parseSparseLayout(image: Blob): Promise<SparseLayout> {
  const header = new DataView(await image.slice(0, SPARSE_HEADER_BYTES).arrayBuffer());
  if (header.byteLength < 4 || header.getUint32(0, true) !== SPARSE_MAGIC) {
    return {
      sparse: false,
      blockSize: RAW_BLOCK_BYTES,
      blockCount: Math.ceil(image.size / RAW_BLOCK_BYTES),
      runs: image.size === 0 ? [] : [{ kind: "data", block: 0, blocks: Math.ceil(image.size / RAW_BLOCK_BYTES), dataOffset: 0 }],
      byteLength: image.size,
    };
  }
  if (header.byteLength < SPARSE_HEADER_BYTES || header.getUint16(4, true) !== 1) throw new Error("Unsupported or truncated Android sparse image header.");
  const fileHeader = header.getUint16(8, true);
  const chunkHeader = header.getUint16(10, true);
  const blockSize = header.getUint32(12, true);
  const blockCount = header.getUint32(16, true);
  const count = header.getUint32(20, true);
  if (fileHeader < SPARSE_HEADER_BYTES || chunkHeader < CHUNK_HEADER_BYTES || !blockSize || blockSize % 4 || !Number.isSafeInteger(blockCount * blockSize)) throw new Error("Invalid Android sparse image geometry.");
  const runs: SparseRun[] = [];
  let fileOffset = fileHeader;
  let block = 0;
  for (let index = 0; index < count; index += 1) {
    const chunk = new DataView(await image.slice(fileOffset, fileOffset + chunkHeader).arrayBuffer());
    if (chunk.byteLength !== chunkHeader) throw new Error("Truncated Android sparse chunk header.");
    const type = chunk.getUint16(0, true);
    const blocks = chunk.getUint32(4, true);
    const size = chunk.getUint32(8, true);
    if (size < chunkHeader || fileOffset + size > image.size || block + blocks > blockCount) throw new Error("Android sparse chunk exceeds the image bounds.");
    const dataOffset = fileOffset + chunkHeader;
    const dataLength = size - chunkHeader;
    if (type === CHUNK_RAW && dataLength === blocks * blockSize) runs.push({ kind: "data", block, blocks, dataOffset });
    else if (type === CHUNK_FILL && dataLength === 4) runs.push({ kind: "fill", block, blocks, pattern: new Uint8Array(await image.slice(dataOffset, dataOffset + 4).arrayBuffer()) });
    else if (type === CHUNK_DONT_CARE && dataLength === 0) runs.push({ kind: "skip", block, blocks });
    else if (type === CHUNK_CRC32 && dataLength === 4 && blocks === 0) { /* Optional CRC; input integrity is bound by SHA-256. */ }
    else throw new Error("Unsupported or malformed Android sparse chunk.");
    block += blocks;
    fileOffset += size;
  }
  if (fileOffset !== image.size || block !== blockCount) throw new Error("Android sparse image length does not match its header.");
  return { sparse: true, blockSize, blockCount, runs, byteLength: blockCount * blockSize };
}

/** The byte ranges a readback can compare: data and fill runs; skipped blocks are counted, not compared. */
export async function imageFootprint(image: Blob): Promise<ImageFootprint> {
  const layout = await parseSparseLayout(image);
  if (!layout.sparse) return { length: image.size, sparse: false, extents: [{ offset: 0, length: image.size, dataOffset: 0 }], skipped: 0 };
  const extents: ImageExtent[] = [];
  let skipped = 0;
  for (const run of layout.runs) {
    const offset = run.block * layout.blockSize;
    const length = run.blocks * layout.blockSize;
    if (run.kind === "data") extents.push({ offset, length, dataOffset: run.dataOffset });
    else if (run.kind === "fill") extents.push({ offset, length, fill: run.pattern });
    else skipped += length;
  }
  return { length: layout.byteLength, sparse: true, extents, skipped };
}

type PieceItem =
  | { readonly kind: "skip"; readonly blocks: number }
  | { readonly kind: "data"; readonly blocks: number; readonly dataOffset: number }
  | { readonly kind: "fill"; readonly blocks: number; readonly pattern: Uint8Array };

/** One output file of a resparse: the chunks it carries and its exact size in bytes. */
export interface SparsePiece {
  readonly bytes: number;
  readonly items: readonly PieceItem[];
}

/**
 * Splits an image into sparse pieces that each fit `limit` bytes, as
 * `sparse_file_resparse` does for `fastboot flash`. Every piece is a complete
 * sparse file covering the whole image: blocks it does not carry are skipped
 * (DONT_CARE), so the bootloader applies the pieces one after another to the
 * same partition. Fill runs cost one small chunk however long they are; data
 * runs are cut at block boundaries.
 */
export function planSparsePieces(layout: SparseLayout, limit: number): SparsePiece[] {
  const { blockSize, blockCount } = layout;
  // One piece must hold its header, a leading skip, one data chunk with a block, and a trailing skip.
  const minimum = SPARSE_HEADER_BYTES + 3 * CHUNK_HEADER_BYTES + blockSize;
  if (!Number.isSafeInteger(limit) || limit < minimum) throw new Error(`A sparse download piece needs at least ${minimum} bytes, but the device accepts only ${limit}.`);
  const pieces: SparsePiece[] = [];
  let items: PieceItem[] = [];
  let bytes = SPARSE_HEADER_BYTES;
  let cursor = 0;
  const close = (): void => {
    if (items.length === 0) return;
    if (cursor < blockCount) {
      items.push({ kind: "skip", blocks: blockCount - cursor });
      bytes += CHUNK_HEADER_BYTES;
    }
    pieces.push({ bytes, items });
    items = [];
    bytes = SPARSE_HEADER_BYTES;
    cursor = 0;
  };
  for (const run of layout.runs) {
    if (run.kind === "skip") continue;
    let block = run.block;
    let left = run.blocks;
    let dataOffset = run.kind === "data" ? run.dataOffset : 0;
    while (left > 0) {
      const gap = block > cursor ? CHUNK_HEADER_BYTES : 0;
      if (run.kind === "fill") {
        const cost = gap + CHUNK_HEADER_BYTES + 4;
        if (bytes + cost + CHUNK_HEADER_BYTES > limit) {
          close();
          continue;
        }
        if (gap) items.push({ kind: "skip", blocks: block - cursor });
        items.push({ kind: "fill", blocks: left, pattern: run.pattern });
        bytes += cost;
        cursor = block + left;
        left = 0;
      } else {
        const fit = Math.floor((limit - bytes - CHUNK_HEADER_BYTES - gap - CHUNK_HEADER_BYTES) / blockSize);
        if (fit < 1) {
          close();
          continue;
        }
        const take = Math.min(left, fit);
        if (gap) items.push({ kind: "skip", blocks: block - cursor });
        items.push({ kind: "data", blocks: take, dataOffset });
        bytes += gap + CHUNK_HEADER_BYTES + take * blockSize;
        cursor = block + take;
        block += take;
        left -= take;
        dataOffset += take * blockSize;
        if (left > 0) close();
      }
    }
  }
  close();
  return pieces;
}

function chunkHeader(type: number, blocks: number, payloadBytes: number): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(CHUNK_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint16(0, type, true);
  view.setUint32(4, blocks, true);
  view.setUint32(8, CHUNK_HEADER_BYTES + payloadBytes, true);
  return header;
}

/** Writes one planned piece as a sparse file. Data is referenced from `image`, never copied into memory. */
export function buildSparsePiece(image: Blob, layout: SparseLayout, piece: SparsePiece): Blob {
  const header = new Uint8Array(SPARSE_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, SPARSE_MAGIC, true);
  view.setUint16(4, 1, true);
  view.setUint16(8, SPARSE_HEADER_BYTES, true);
  view.setUint16(10, CHUNK_HEADER_BYTES, true);
  view.setUint32(12, layout.blockSize, true);
  view.setUint32(16, layout.blockCount, true);
  view.setUint32(20, piece.items.length, true);
  const parts: BlobPart[] = [header];
  for (const item of piece.items) {
    if (item.kind === "skip") parts.push(chunkHeader(CHUNK_DONT_CARE, item.blocks, 0));
    else if (item.kind === "fill") parts.push(chunkHeader(CHUNK_FILL, item.blocks, 4), new Uint8Array(item.pattern));
    else {
      const wanted = item.blocks * layout.blockSize;
      const source = image.slice(item.dataOffset, item.dataOffset + Math.min(wanted, image.size - item.dataOffset));
      parts.push(chunkHeader(CHUNK_RAW, item.blocks, wanted), source);
      // Only a plain file's final partial block is short; libsparse pads it with zeros too.
      if (source.size < wanted) parts.push(new Uint8Array(wanted - source.size));
    }
  }
  const blob = new Blob(parts);
  if (blob.size !== piece.bytes) throw new Error(`Sparse piece was built with ${blob.size} bytes, expected ${piece.bytes}.`);
  return blob;
}

export interface SparseSplit {
  readonly layout: SparseLayout;
  readonly pieces: readonly SparsePiece[];
}

/** The pieces `image` needs to fit `limit`, without building them yet. */
export async function planImageSplit(image: Blob, limit: number): Promise<SparseSplit> {
  const layout = await parseSparseLayout(image);
  const pieces = planSparsePieces(layout, limit);
  if (pieces.length === 0) throw new Error("The image has no data to write.");
  return { layout, pieces };
}
