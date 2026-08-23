import { readEnv } from "../env";
import { claudeHarness } from "./claude";
import { codexHarness } from "./codex";
import { hermesHarness } from "./hermes";
import { ompHarness } from "./omp";
import { piHarness } from "./pi";
import { readEngineState, writeEngineState } from "./state";
import type { HarnessAdapter } from "./types";

export type { EngineCliPart, EngineEvent, EngineSession, EngineSessionOptions, HarnessAdapter, HarnessCapabilities, RpcUiSpawn } from "./types";

/**
 * The version a user means by this engine's NAME.
 *
 * `HarnessAdapter.getVersion()` reports the package `installSpec` names, which
 * for Claude Code and Codex is the ACP ADAPTER Cody installs to drive the
 * engine — 0.70.x and 1.x, while the CLIs themselves are on 2.1.x and 0.14x.x.
 * Showing that number under the engine's name is not a smaller truth, it is a
 * different package's version. Anything that labels a number with the engine's
 * name uses this; the adapter's own version belongs beside its own label
 * (see EngineCliPart, and the update card's per-package breakdown).
 *
 * Falls back to the installed package's version when the CLI half cannot be
 * read at all, because a half that DOES answer beats showing nothing.
 */
export async function engineOwnVersion(adapter: HarnessAdapter): Promise<string | null> {
  const [engineVersion, packageVersion] = await Promise.all([
    adapter.engineCli?.getVersion() ?? Promise.resolve(null),
    adapter.getVersion(),
  ]);
  return engineVersion ?? packageVersion;
}

const ADAPTERS: Record<string, HarnessAdapter> = {
  [ompHarness.id]: ompHarness,
  [piHarness.id]: piHarness,
  [claudeHarness.id]: claudeHarness,
  [codexHarness.id]: codexHarness,
  [hermesHarness.id]: hermesHarness,
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
