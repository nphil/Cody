/**
 * Failures the engine seam raises, in a module that is only that.
 *
 * This used to live in turn-session.ts, which was the per-turn transport. When
 * Claude Code and Codex moved to ACP nothing used that transport any more, and
 * an engine-neutral error type was the only thing keeping ~950 lines of dead
 * code reachable. Part of the engine-neutral public surface, like types.ts and
 * engine-bin.ts: the agent API routes import it directly to map a failure onto
 * an HTTP response.
 */

/**
 * Cody-side failure with a stable snake_case code, forwarded by the agent API
 * routes as `{error, code}` exactly like rpc-manager's WebRpcError. Defined
 * here rather than reused from there on purpose: lib/harness must not depend
 * on lib/rpc-manager.
 *
 * `code: "unsupported"` is the load-bearing one — an engine whose vocabulary
 * lacks a command throws it, and the UI is built to hide that surface rather
 * than render it broken.
 */
export class EngineCommandError extends Error {
  readonly command: string;
  readonly code: string;

  constructor(command: string, message: string, code: string) {
    super(message);
    this.name = "EngineCommandError";
    this.command = command;
    this.code = code;
  }
}
