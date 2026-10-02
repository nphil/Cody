import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

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
