import { readEnv } from "../env";
import { ompHarness } from "./omp";
import type { HarnessAdapter } from "./types";

export type { HarnessAdapter, HarnessCapabilities } from "./types";

const ADAPTERS: Record<string, HarnessAdapter> = {
  [ompHarness.id]: ompHarness,
};

/**
 * The active harness, selected by CODY_HARNESS (default "omp"). Unknown values
 * fail loudly at startup rather than silently running the wrong stack —
 * a misconfigured deployment should never look like a healthy omp one.
 */
export function getHarness(): HarnessAdapter {
  const requested = (readEnv("HARNESS") ?? ompHarness.id).trim().toLowerCase();
  const adapter = ADAPTERS[requested];
  if (!adapter) {
    const known = Object.keys(ADAPTERS).join(", ");
    throw new Error(`Unknown CODY_HARNESS "${requested}" (known harnesses: ${known})`);
  }
  return adapter;
}
