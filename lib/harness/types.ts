/**
 * The seam between Cody's web UI and the coding-agent engine underneath it.
 *
 * Cody was extracted from a UI hard-wired to omp (oh-my-pi, itself a Pi fork).
 * This contract names everything the UI needs from an engine so that omp is an
 * implementation, not an assumption. A new engine (Claude Code, Codex, Pi, …)
 * is added by implementing HarnessAdapter and registering it in
 * lib/harness/index.ts — capability flags gate the UI surfaces the engine
 * cannot serve, and `createSession` supplies live chat for engines that speak
 * something other than omp's rpc-ui protocol.
 */

export interface HarnessCapabilities {
  /** Live chat via a child process (send prompts, stream events). */
  liveSessions: boolean;
  /** Model/provider management UI (models.yml-style configuration). */
  models: boolean;
  /** Skill discovery/install/update surfaces. */
  skills: boolean;
  /** Plugin management (install/list through the harness CLI). */
  plugins: boolean;
  /** Project-scoped MCP server management. */
  mcp: boolean;
  /** Native harness settings editing (config.yml-style allow-listed keys). */
  nativeSettings: boolean;
  /** Harness self-update checks and restarts. */
  updates: boolean;
  /**
   * The advanced chat affordances built against omp's protocol: thinking
   * levels, in-session model switching, forking, compaction, steering modes,
   * advisor sessions, tool presets, subagent rosters. Engines without this
   * get a plain prompt/stream/abort chat surface.
   */
  chatExtras: boolean;
}

/**
 * An event frame streamed to the browser (omp rpc-ui event vocabulary).
 *
 * Cody adds one frame to that vocabulary for engines that report their own
 * accounting instead of recording it on the messages they emit:
 * `{type: "usage_event", usage: EngineUsage}`.
 *
 * Every usage frame is a DELTA to ADD, never a running total. That is what
 * makes it safe: a turn killed after reporting still leaves the tokens it did
 * spend counted, a reconnect cannot resurrect a stale total, and no frame can
 * be counted twice. Translators must therefore never forward an engine's
 * cumulative turn total alongside the per-message figures that already sum to
 * it — see lib/harness/claude-stream.ts, where the result frame contributes
 * only the cost that has no per-message counterpart.
 */
export interface EngineEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Usage an engine reports for itself, normalized to the fields Cody sums.
 *
 * Cody's arithmetic is `total = input + output + cacheRead + cacheWrite`, so
 * each translator resolves overlapping engine fields before they arrive here:
 * Anthropic reports cache tokens beside a cache-free `input_tokens`, while
 * codex reports an `input_tokens` that already contains its cached and
 * cache-write counts. Reasoning tokens are deliberately absent — both engines
 * report them as a subset of output, so carrying them would count the same
 * tokens twice.
 */
export interface EngineUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** First-party spend in USD, when the engine reports one at all. */
  cost?: number;
}

export interface EngineSessionOptions {
  /** Cody session id — "" lets the engine mint one for a brand-new session. */
  sessionId: string;
  /** Working directory the agent operates in. */
  cwd: string;
}

/**
 * One live chat session, whatever engine drives it. This is exactly the
 * surface `AgentSessionWrapper` (lib/rpc-manager.ts) already exposes and the
 * agent API routes consume, so the omp wrapper satisfies it structurally.
 * Engines with a smaller command vocabulary throw RpcCommandError with code
 * "unsupported" from send() — the UI is built to tolerate that.
 */
export interface EngineSession {
  readonly sessionId: string;
  /** Transcript path on disk; "" when the engine owns its own storage. */
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  start(): void;
  /** Resolves once identity is known and the session accepts commands. */
  waitUntilReady(): Promise<void>;
  onEvent(listener: (event: EngineEvent) => void): () => void;
  onDestroy(cb: () => void): void;
  onIdentityChange(cb: (oldId: string, newId: string) => void): void;
  send(command: Record<string, unknown>): Promise<unknown>;
  destroy(): void;
  destroyAndWait(): Promise<void>;
  /** Resolves once an in-flight destroy finishes; null when idle. */
  destroyPromise: Promise<void> | null;
}

export interface HarnessAdapter {
  /** Stable id, also the CODY_HARNESS value that selects this adapter. */
  readonly id: string;
  /** Human name for the UI ("OMP runtime", "Claude Code"). */
  readonly displayName: string;
  /** Short brand used inline in UI copy — "All {shortName} Settings". Kept
   * separate from displayName, which reads badly mid-sentence. */
  readonly shortName: string;
  /** Binary name for hints/messages ("omp", "claude"). */
  readonly binaryName: string;
  /** One-line description for the engine picker card. */
  readonly tagline: string;
  /** Experimental engines carry a visible chip and reduced expectations. */
  readonly experimental?: boolean;
  /** npm spec for on-demand install ("@openai/codex@latest"); absent when
   * Cody cannot install this engine itself. */
  readonly installSpec?: string;
  /** How to authenticate this engine, shown in the picker and engine card
   * (e.g. "Run `claude` in a Cody terminal to sign in, or set
   * ANTHROPIC_API_KEY on the container"). */
  readonly authHint?: string;
  readonly capabilities: HarnessCapabilities;

  /** Absolute path of the installed binary, or null when not installed. */
  resolveBinary(): string | null;
  /** Version string of the installed binary ("17.3.5"), null when unknown. */
  getVersion(): Promise<string | null>;
  /** The engine's own state directory (its sessions, config, credentials). */
  getAgentDir(): string;
  /** Root directory that holds per-project session transcripts. */
  getSessionsDir(): string;
  /**
   * Live-chat factory for engines that do not speak omp's rpc-ui protocol.
   * omp itself has no createSession — rpc-manager owns its bespoke path and
   * treats the absence of this field as "use the omp pipeline".
   */
  createSession?(options: EngineSessionOptions): EngineSession;
}
