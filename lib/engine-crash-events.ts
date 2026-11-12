import type { EngineCrashNotice } from "./engine-crash";

/**
 * Who hears that a chat's engine stopped on its own. The running-sessions
 * stream (app/api/agent/running/events) forwards each one to every open page,
 * so the pop-up shows whichever chat that page is looking at.
 *
 * The listeners live on `globalThis`: the wrapper that publishes runs in the
 * Next bundle and the boot resume in the custom server, and they are separate
 * module instances (same reason as the running-session listeners).
 */

export interface EngineCrashEvent {
  sessionId: string;
  /** The chat's title when the server knows it; the page falls back to its own session list. */
  title: string | null;
  notice: EngineCrashNotice;
}

type Listener = (event: EngineCrashEvent) => void;

declare global {
  var __codyEngineCrashListeners: Set<Listener> | undefined;
}

function listeners(): Set<Listener> {
  if (!globalThis.__codyEngineCrashListeners) globalThis.__codyEngineCrashListeners = new Set();
  return globalThis.__codyEngineCrashListeners;
}

export function subscribeEngineCrashes(listener: Listener): () => void {
  const set = listeners();
  set.add(listener);
  return () => { set.delete(listener); };
}

export function publishEngineCrash(event: EngineCrashEvent): void {
  for (const listener of [...listeners()]) {
    try {
      listener(event);
    } catch {
      // One closed stream must not stop the others hearing it.
    }
  }
}
