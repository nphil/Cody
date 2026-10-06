/**
 * CRC-32 (IEEE 802.3, the one ZIP stores), incremental and browser-safe.
 *
 * The browser has no CRC-32 of its own, and a ZIP entry carries one. Slice-by-8
 * keeps a multi-gigabyte pass to seconds rather than minutes on a tablet, and
 * the class takes one chunk at a time so a caller never holds a whole file.
 */

const POLYNOMIAL = 0xedb88320;

/** Eight 256-entry tables laid end to end: table k answers "the CRC of byte b followed by k zero bytes". */
const TABLES: Uint32Array = (() => {
  const tables = new Uint32Array(256 * 8);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? POLYNOMIAL ^ (value >>> 1) : value >>> 1;
    tables[index] = value >>> 0;
  }
  for (let index = 0; index < 256; index += 1) {
    let value = tables[index]!;
    for (let table = 1; table < 8; table += 1) {
      value = tables[value & 0xff]! ^ (value >>> 8);
      tables[table * 256 + index] = value >>> 0;
    }
  }
  return tables;
})();

export class Crc32 {
  private state = 0xffffffff;

  update(bytes: Uint8Array): this {
    const tables = TABLES;
    const length = bytes.length;
    let state = this.state;
    let index = 0;
    for (; index + 8 <= length; index += 8) {
      const low = (bytes[index]! | (bytes[index + 1]! << 8) | (bytes[index + 2]! << 16) | (bytes[index + 3]! << 24)) ^ state;
      const high = bytes[index + 4]! | (bytes[index + 5]! << 8) | (bytes[index + 6]! << 16) | (bytes[index + 7]! << 24);
      state = tables[1792 + (low & 0xff)]! ^ tables[1536 + ((low >>> 8) & 0xff)]! ^ tables[1280 + ((low >>> 16) & 0xff)]! ^ tables[1024 + (low >>> 24)]!
        ^ tables[768 + (high & 0xff)]! ^ tables[512 + ((high >>> 8) & 0xff)]! ^ tables[256 + ((high >>> 16) & 0xff)]! ^ tables[high >>> 24]!;
    }
    for (; index < length; index += 1) state = tables[(state ^ bytes[index]!) & 0xff]! ^ (state >>> 8);
    this.state = state >>> 0;
    return this;
  }

  /** The CRC of everything given so far, as an unsigned 32-bit number. Safe to call more than once. */
  digest(): number {
    return (this.state ^ 0xffffffff) >>> 0;
  }
}

export function crc32(bytes: Uint8Array): number {
  return new Crc32().update(bytes).digest();
}
