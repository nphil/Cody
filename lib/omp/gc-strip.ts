import { parseJsonLoose, runOmpCli } from "./plugin-cli";

/**
 * `omp gc --strip`: drop provider replay data (thinking signatures, encrypted
 * reasoning, cached native responses) from chats idle for a while. Chats still
 * resume on any model; only same-provider reply caching is lost. The flag
 * arrived in omp 18.18.2; an older engine rejects it as an unknown option, which
 * is reported here as `supported: false`, never as a failure.
 */

export interface ReplayStripResult {
  supported: boolean;
  /** Transcripts that have replay data to strip (dry run) or were considered (apply). */
  candidates: number;
  /** Transcripts actually rewritten; 0 on a dry run. */
  stripped: number;
  /** Bytes of replay data found (dry run) or removed (apply). */
  bytes: number;
  skippedLive: number;
  errors: string[];
}

const UNSUPPORTED: ReplayStripResult = { supported: false, candidates: 0, stripped: 0, bytes: 0, skippedLive: 0, errors: [] };
// Stripping rewrites every idle transcript, which can take minutes on a big history.
const STRIP_TIMEOUT_MS = 15 * 60_000;

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Pure parser for the JSON `omp gc --strip --json` prints. Null when the shape is not recognised. */
export function parseStripResult(stdout: string): ReplayStripResult | null {
  const parsed = parseJsonLoose<{ strip?: Record<string, unknown> }>(stdout);
  const strip = parsed?.strip;
  if (!strip || typeof strip !== "object") return null;
  return {
    supported: true,
    candidates: num(strip.wouldStrip),
    stripped: num(strip.stripped),
    bytes: num(strip.bytes),
    skippedLive: num(strip.skippedLive),
    errors: Array.isArray(strip.errors) ? strip.errors.filter((item): item is string => typeof item === "string").slice(0, 5) : [],
  };
}

/** Preview (`apply: false`) or perform (`apply: true`) the strip with omp's own default idle age. */
export async function runReplayStrip(apply: boolean): Promise<ReplayStripResult> {
  try {
    const { stdout } = await runOmpCli(["gc", "--strip", "--json", ...(apply ? ["--apply"] : [])], { timeout: STRIP_TIMEOUT_MS });
    const result = parseStripResult(stdout);
    if (!result) throw new Error("omp gc returned an unreadable answer");
    return result;
  } catch (error) {
    // The error text is cut to its last 600 characters, which can lose the
    // "Unknown option" head, so ask the engine whether it knows the flag.
    if (!(await engineKnowsStrip())) return UNSUPPORTED;
    throw error;
  }
}

async function engineKnowsStrip(): Promise<boolean> {
  try {
    const { stdout } = await runOmpCli(["gc", "--help"], { timeout: 30_000 });
    return stdout.includes("--strip");
  } catch {
    return true;
  }
}
