import { readEnv } from "../env";
import { claudeHarness } from "./claude";
import { codexHarness } from "./codex";
import { ompHarness } from "./omp";
import { piHarness } from "./pi";
import { readEngineState, writeEngineState } from "./state";
import type { HarnessAdapter } from "./types";

export type { EngineEvent, EngineSession, EngineSessionOptions, HarnessAdapter, HarnessCapabilities, RpcUiSpawn } from "./types";

const ADAPTERS: Record<string, HarnessAdapter> = {
  [ompHarness.id]: ompHarness,
  [piHarness.id]: piHarness,
  [claudeHarness.id]: claudeHarness,
  [codexHarness.id]: codexHarness,
};

export function listHarnesses(): HarnessAdapter[] {
  return Object.values(ADAPTERS);
}

export function getHarnessById(id: string): HarnessAdapter | undefined {
  return ADAPTERS[id.trim().toLowerCase()];
}

/**
 * The active engine. Precedence: the persisted runtime selection (an admin
 * picked it in onboarding or Settings) → CODY_HARNESS env → omp.
 *
 * A persisted id this build no longer knows falls back silently — a stale
 * state file must not brick the server after a downgrade. An unknown env
 * value still fails loudly: a typo in deployment config should never look
 * like a healthy omp instance.
 */
export function getHarness(): HarnessAdapter {
  const persisted = readEngineState().activeEngine;
  if (persisted) {
    const adapter = ADAPTERS[persisted];
    if (adapter) return adapter;
  }
  const requested = (readEnv("HARNESS") ?? ompHarness.id).trim().toLowerCase();
  const adapter = ADAPTERS[requested];
  if (!adapter) {
    const known = Object.keys(ADAPTERS).join(", ");
    throw new Error(`Unknown CODY_HARNESS "${requested}" (known harnesses: ${known})`);
  }
  return adapter;
}

/**
 * Persist a new active engine (and mark onboarding done). Validation only —
 * the caller (the /api/engines/select route) owns the side effects that need
 * other modules: checking the binary is installed and restarting live
 * sessions so nothing keeps running on the old engine.
 */
export function selectHarness(id: string): HarnessAdapter {
  const adapter = getHarnessById(id);
  if (!adapter) {
    const known = Object.keys(ADAPTERS).join(", ");
    throw new Error(`Unknown engine "${id}" (known engines: ${known})`);
  }
  writeEngineState({ activeEngine: adapter.id, onboarded: true });
  return adapter;
}
