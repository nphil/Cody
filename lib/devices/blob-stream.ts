import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Crc32 } from "./crc32";

/** Incremental SHA-256; no whole-file ArrayBuffer, including on Android. */
export async function hashBlob(blob: Blob): Promise<string> {
  const hash = sha256.create();
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return bytesToHex(hash.digest());
      hash.update(next.value);
    }
  } finally { reader.releaseLock(); hash.destroy(); }
}

/**
 * SHA-256 and CRC-32 of the same bytes in ONE pass. The CRC is what a ZIP entry stores, so recording it when a file
 * is saved means "Download all" starts at once instead of reading every byte again first.
 */
export async function hashBlobWithCrc(blob: Blob): Promise<{ sha256: string; crc32: number }> {
  const hash = sha256.create();
  const crc = new Crc32();
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return { sha256: bytesToHex(hash.digest()), crc32: crc.digest() };
      hash.update(next.value);
      crc.update(next.value);
    }
  } finally { reader.releaseLock(); hash.destroy(); }
}
