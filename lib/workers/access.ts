import { basename } from "node:path";
import { issueDisplayCapability, workersInternalEndpoint } from "../display/capability";

/**
 * How a helper agent reaches `run_on_worker`.
 *
 * omp hands Cody's host tools to the main chat only; a helper agent (a
 * subagent) never sees them, but it does get every extension. So the tool is
 * an extension (lib/omp/extensions/cody-run-on-worker.ts) that calls Cody's
 * own /api/internal/workers route. A chat has no session id when its engine
 * starts, so the capability it is handed names the chat's scratch folder (the
 * one thing that exists at launch and is the engine's alone) instead:
 * `scratch:<folder name>`. The route turns it back into the live chat.
 */

export const SCRATCH_SESSION_PREFIX = "scratch:";

/** A scratch folder's name: lib/disk/scratch.ts makes it from random hex. */
const SCRATCH_KEY = /^[0-9a-f]{6,32}$/;

/** Longer than any engine process lives; a respawned engine is handed a new one. */
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** The scratch folder name inside a capability's `sid`, or null when it names an ordinary session. */
export function scratchKeyOf(sid: string): string | null {
  if (!sid.startsWith(SCRATCH_SESSION_PREFIX)) return null;
  const key = sid.slice(SCRATCH_SESSION_PREFIX.length);
  return SCRATCH_KEY.test(key) ? key : null;
}

/**
 * The environment an omp engine in `scratchDir` gets so its extension can call
 * the route: where it is, which chat it speaks for, and the proof. Empty when
 * this process has no internal secret or origin (anything but the running
 * server), so the extension then offers no tool.
 */
export function workersEnv(scratchDir: string): Record<string, string> {
  const key = basename(scratchDir);
  if (!SCRATCH_KEY.test(key)) return {};
  const session = `${SCRATCH_SESSION_PREFIX}${key}`;
  try {
    return {
      CODY_WORKERS_ENDPOINT: workersInternalEndpoint(),
      CODY_WORKERS_SESSION: session,
      CODY_WORKERS_TOKEN: issueDisplayCapability(session, TOKEN_TTL_MS),
    };
  } catch {
    return {};
  }
}
