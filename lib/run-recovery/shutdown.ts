/**
 * Whether this server is going down on purpose.
 *
 * A run still in flight when a chat's engine closes is either abandoned (the
 * chat was deleted, the engine switched, the person pressed Stop) or
 * interrupted (the server is stopping and the engine dies with it). The
 * run journal (lib/run-recovery) keeps its entry only for the second kind, and
 * the only way to tell them apart at close time is this flag: it is raised
 * BEFORE any session is destroyed, by bin/cody-server.js's `shutdown` and by
 * the registry's SIGTERM/SIGINT/exit cleanup in lib/rpc-manager.ts.
 *
 * Import-free on purpose: both of those callers run it first thing, and it
 * lives on `globalThis` because the custom server and the Next bundle hold
 * separate module instances of every file.
 */

declare global {
  var __codyServerShuttingDown: boolean | undefined;
}

export function markServerShuttingDown(): void {
  globalThis.__codyServerShuttingDown = true;
}

export function isServerShuttingDown(): boolean {
  return globalThis.__codyServerShuttingDown === true;
}
