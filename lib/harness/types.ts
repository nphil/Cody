/**
 * The seam between Cody's web UI and the coding-agent harness underneath it.
 *
 * Cody was extracted from a UI hard-wired to omp (oh-my-pi, itself a Pi fork).
 * This contract names everything the UI needs from a harness so that omp is an
 * implementation, not an assumption. A new harness (Pi, or any agent with a
 * comparable session model) is added by implementing HarnessAdapter and
 * registering it in lib/harness/index.ts — and by porting the routes that the
 * coupling map in docs/harnesses.md still lists as omp-specific.
 */

export interface HarnessCapabilities {
  /** Live chat via an RPC child process (send prompts, stream events). */
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
}

export interface HarnessAdapter {
  /** Stable id, also the CODY_HARNESS value that selects this adapter. */
  readonly id: string;
  /** Human name for the UI ("OMP runtime", "Pi"). */
  readonly displayName: string;
  /** Short brand used inline in UI copy — "All {shortName} Settings". Kept
   * separate from displayName, which reads badly mid-sentence. */
  readonly shortName: string;
  /** Binary name for hints/messages ("omp", "pi"). */
  readonly binaryName: string;
  readonly capabilities: HarnessCapabilities;

  /** Absolute path of the installed binary, or null when not installed. */
  resolveBinary(): string | null;
  /** Version string of the installed binary ("17.3.5"), null when unknown. */
  getVersion(): Promise<string | null>;
  /** The harness's agent state directory (sessions, config, skills). */
  getAgentDir(): string;
  /** Root directory that holds per-project session transcripts. */
  getSessionsDir(): string;
}
