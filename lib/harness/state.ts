import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "../omp/paths";

/**
 * Persisted engine selection. `cody-engine.json` lives in the instance data
 * dir next to cody-accounts — deliberately NOT under the active engine's own
 * directory, because this file must survive switching engines.
 *
 * Resolution precedence is persisted choice → CODY_HARNESS env → omp
 * (see getHarness in lib/harness/index.ts). A stale file naming an engine
 * this build no longer knows must not brick the server, so consumers treat
 * unknown persisted ids as "fall back", unlike an unknown env value which
 * still fails loudly (a typo in deployment config should be seen).
 */

export interface EngineState {
  version: 1;
  /** Active engine id, or null when nothing was ever selected. */
  activeEngine: string | null;
  /** True once the onboarding picker ran (or an admin picked in Settings). */
  onboarded: boolean;
  updatedAt: string;
}

const EMPTY_STATE: EngineState = { version: 1, activeEngine: null, onboarded: false, updatedAt: "" };

let cache: { state: EngineState; mtimeMs: number } | null = null;

export function getEngineStatePath(): string {
  return path.join(getAgentDir(), "cody-engine.json");
}

export function readEngineState(): EngineState {
  const file = getEngineStatePath();
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    cache = null;
    return EMPTY_STATE;
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.state;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<EngineState>;
    const state: EngineState = {
      version: 1,
      activeEngine: typeof parsed.activeEngine === "string" && parsed.activeEngine ? parsed.activeEngine : null,
      onboarded: parsed.onboarded === true,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
    cache = { state, mtimeMs };
    return state;
  } catch {
    // Unreadable state must never take the server down; the env/default
    // resolution below it still yields a working engine.
    return EMPTY_STATE;
  }
}

export function writeEngineState(next: Partial<Pick<EngineState, "activeEngine" | "onboarded">>): EngineState {
  const current = readEngineState();
  const state: EngineState = {
    version: 1,
    activeEngine: next.activeEngine !== undefined ? next.activeEngine : current.activeEngine,
    onboarded: next.onboarded !== undefined ? next.onboarded : current.onboarded,
    updatedAt: new Date().toISOString(),
  };
  const file = getEngineStatePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  cache = null;
  return state;
}

/** Whether the one-time engine onboarding step should still be offered.
 * Instances that predate engine selection (no state file) count as
 * not-onboarded on purpose: the picker shows once after upgrade, an admin
 * confirms (or switches), and the choice is persisted. */
export function isEngineOnboarded(): boolean {
  return readEngineState().onboarded && existsSync(getEngineStatePath());
}

/** Test hook — state is mtime-cached and tests swap the agent dir. */
export function clearEngineStateCache(): void {
  cache = null;
}
