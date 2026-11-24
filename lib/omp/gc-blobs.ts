import { parseJsonLoose, runOmpCli } from "./plugin-cli";

/**
 * `omp gc --blobs`: the engine's own sweep of blobs (pasted images and large
 * tool output kept outside the transcripts) that no transcript refers to any
 * more. It decides what is unreferenced, Cody only asks: dry run first
 * (`apply: false`), then `--apply`. Same shape as lib/omp/gc-strip.ts.
 */

export interface BlobSweepResult {
  /** Unreferenced blobs found (dry run) or removed (apply). */
  blobs: number;
  /** Bytes in them. */
  bytes: number;
  errors: string[];
}

const SWEEP_TIMEOUT_MS = 15 * 60_000;

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Pure parser for the JSON `omp gc --blobs --json` prints. Null when the shape is not recognised. */
export function parseBlobSweep(stdout: string, apply: boolean): BlobSweepResult | null {
  const parsed = parseJsonLoose<{ blobs?: Record<string, unknown> }>(stdout);
  const blobs = parsed?.blobs;
  if (!blobs || typeof blobs !== "object") return null;
  return {
    blobs: num(apply ? blobs.deleted : blobs.wouldDelete),
    bytes: num(blobs.bytes),
    errors: Array.isArray(blobs.errors) ? blobs.errors.filter((item): item is string => typeof item === "string").slice(0, 5) : [],
  };
}

export async function runBlobSweep(apply: boolean): Promise<BlobSweepResult> {
  const { stdout } = await runOmpCli(["gc", "--blobs", "--json", ...(apply ? ["--apply"] : [])], { timeout: SWEEP_TIMEOUT_MS });
  const result = parseBlobSweep(stdout, apply);
  if (!result) throw new Error("omp gc returned an unreadable answer");
  return result;
}
