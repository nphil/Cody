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
  /**
   * The model/provider MANAGEMENT editor (models.yml-style configuration):
   * the Models & Auth panel, the provider list, the roles planner, the
   * unrestricted catalog. omp-only today.
   *
   * It is NOT the composer's model PICKER, and conflating the two costs a
   * release: pi reports false here and still serves its own 119-model catalog
   * from `/api/models`, while every ACP engine offers models per SESSION.
   * Which models a session can pick is therefore reported as DATA, never as a
   * flag — `/api/models` says `catalogSource: "global" | "session"`, and an
   * ACP session's `get_state` carries `{model, availableModels,
   * modelSelectable}` discovered at `session/new`. A static flag could not
   * tell the truth about it anyway: what an ACP agent offers depends on the
   * account it opened the session with, so the same adapter can honestly
   * answer differently on two machines.
   */
  models: boolean;
  /** Skill discovery/install/update surfaces. */
  skills: boolean;
  /** Plugin management (install/list through the harness CLI). */
  plugins: boolean;
  /** Project-scoped MCP server management. */
  mcp: boolean;
  /** Native harness settings editing (config.yml-style allow-listed keys). */
  nativeSettings: boolean;
  /**
   * Cody has HAND-BUILT editors for this engine's own config file — the
   * Safety, AI Model Defaults and Agent & Intelligence tabs, which read and
   * write omp's config.yml through /api/omp-settings.
   *
   * Distinct from `nativeSettings`, which is the schema-DRIVEN panel any
   * engine can have by declaring its settings. Hermes has the latter and not
   * the former: conflating them put three tabs of omp's controls on a Hermes
   * install, where every Save wrote a file Hermes never reads.
   */
  configEditor: boolean;
  /** Harness self-update checks and restarts. */
  updates: boolean;
  /**
   * The advanced chat affordances shared by the pi/omp RPC dialect: thinking
   * levels, in-session model switching, forking, branch navigation, history
   * export, compaction, steering modes, tool presets. Engines without this
   * get a plain prompt/stream/abort chat surface.
   */
  chatExtras: boolean;
  /** Priority fast mode (`set_fast_mode`) — omp-only; pi's dialect lacks it. */
  fastMode: boolean;
  /** Advisor sessions (`--advisor` spawn flag) — omp-only. */
  advisor: boolean;
  /** Subagent rosters/progress (`get_subagents`, subagent frames) — omp-only. */
  subagents: boolean;
  /** The engine keeps persistent memory across sessions AND can hand Cody its
   * contents to display (see `readMemory`). A flag on its own is not enough:
   * omp has memory too, but exposes no way to read it back, so it stays
   * false and the surface stays hidden rather than empty. */
  memory: boolean;
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
 * it: the ACP translator contributes one additive frame per turn from
 * `PromptResponse.usage`, never a running total alongside it.
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

/** One document of an engine's persistent memory. */
export interface MemoryDocument {
  /** Stable id within the engine ("memory", "user"). */
  id: string;
  /** Human label for the section heading. */
  label: string;
  /** One clause on what this document is for, from the engine's own docs. */
  description: string;
  /** Absolute path, shown so the user can find and edit it themselves. */
  path: string;
  /** Raw contents; "" when the file does not exist yet. */
  content: string;
  /** False when the file is absent — a fresh install, not an error. */
  exists: boolean;
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

/**
 * How to spawn and drive an engine that speaks the pi/omp NDJSON RPC dialect
 * (one JSON object per line over stdio). omp and its ancestor pi share the
 * protocol but differ in CLI surface and in which commands exist; this
 * descriptor states those differences as data so rpc-manager stays one
 * pipeline. Engines with `createSession` (turn-based CLIs) never use it.
 */
export interface RpcUiSpawn {
  /** Value passed to `--mode` ("rpc-ui" for omp, "rpc" for pi). */
  readonly mode: string;
  /** Flag that opens a session file deterministically ("--resume" for omp,
   * "--session" for pi — pi's own --resume is a boolean picker). */
  readonly resumeFlag: string;
  /** Whether the CLI accepts `--cwd <dir>`. pi has no such flag (unknown
   * flags are silently swallowed); it inherits the spawn cwd instead. */
  readonly supportsCwdFlag: boolean;
  /** Whether `--advisor` exists (omp-only). */
  readonly supportsAdvisor: boolean;
  /** Whether `set_host_tools` / `host_tool_call` exist in the protocol. */
  readonly hostTools: boolean;
  /** Whether `set_subagent_subscription` / subagent frames exist. */
  readonly subagentEvents: boolean;
  /**
   * How the child signals readiness. omp prints `{type:"ready"}` before
   * accepting commands; pi prints nothing and simply starts reading stdin —
   * its readiness signal is the response to the first command, which sits
   * safely in the pipe buffer until pi attaches its reader.
   */
  readonly readiness: "ready-frame" | "first-response";
  /**
   * Engine RPC command vocabulary, when it is a strict subset of omp's.
   * Commands outside the set are rejected Cody-side with code "unsupported"
   * (which the UI tolerates by design) instead of being written to the
   * child — pi answers unknown commands with an id-less error response that
   * can never settle the pending request, i.e. a silent hang. Absent means
   * unrestricted (omp).
   */
  readonly commands?: ReadonlySet<string>;
}

/**
 * The two halves of an engine Cody installs as TWO packages: the ACP adapter
 * `installSpec` names, and the engine CLI from `installAlso` that the adapter
 * drives. Present only when those are different things.
 *
 * It exists because every number Cody already had was the ADAPTER's — the
 * version probe, the registry comparison, the revert pin, the
 * `verifiedVersion` marker — and none of them is the number a user means by
 * "Claude Code". A
 * card reading "Claude Code v0.70.0" beside a `claude --version` of 2.1.241
 * is not a rounding error, it is the wrong package. Naming both halves makes
 * the display honest AND gives the update check the second registry name it
 * needs: an adapter-only comparison reports a CLI twenty releases behind as
 * "up to date", forever.
 */
export interface EngineCliPart {
  /** What `installSpec` itself is, wherever its version is shown —
   * "Claude Code ACP adapter". Also the subject of the `verifiedVersion`
   * notice, whose major belongs to this package and not to the CLI. */
  readonly adapterLabel: string;
  /** The CLI underneath, wherever ITS version is shown — "Claude Code CLI". */
  readonly label: string;
  /** Which `installAlso` package the CLI comes from — the registry name for
   * the second half of the update check. */
  readonly packageName: string;
  /**
   * Version of the CLI that will ACTUALLY run: the adapter's own health argv
   * with `engineEnv` applied, not whatever npm last unpacked. Null when it
   * cannot be read — which is exactly the state a half-finished update leaves
   * behind, so the caller must render it as unknown rather than as absent.
   */
  getVersion(): Promise<string | null>;
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
  /** Package spec for on-demand install ("@openai/codex@latest",
   * "hermes-agent[acp]"); absent when Cody cannot install this engine. */
  readonly installSpec?: string;
  /** Which package manager installs `installSpec`. Defaults to npm, which is
   * what every engine used before Hermes — a Python program on PyPI. */
  readonly installVia?: "npm" | "uv";
  /**
   * Further packages the engine cannot run without, installed into the same
   * prefix by the same job (npm only, one invocation each so per-package
   * flags stay per-package). Pin them `@latest` like `installSpec`: every
   * install IS the update path, and a stale companion is the same broken
   * engine as a stale primary.
   *
   * Claude Code is the case: what Cody installs is the ACP adapter, and what
   * the adapter drives is the `claude` CLI, which the adapter can bundle but
   * Cody would rather own (see `skipNativeOptional`).
   */
  readonly installAlso?: readonly string[];
  /**
   * The engine CLI half of a two-package install — see EngineCliPart. Absent
   * for every engine whose `installSpec` IS the engine (omp, pi, hermes), and
   * absent is what tells the update check and the UI there is one version to
   * report rather than two.
   */
  readonly engineCli?: EngineCliPart;
  /**
   * Install `installSpec` WITHOUT its platform-gated optional dependencies —
   * the mechanism by which an adapter that bundles a ~300 MB copy of a CLI
   * Cody already installs stops shipping the second copy.
   *
   * npm's `--omit=optional` is silently ignored by `npm install -g` (verified
   * against npm 10.9 in every spelling: flag, NPM_CONFIG_OMIT, userconfig).
   * What does work globally is the platform gate: `--os=none --cpu=none`
   * matches no `os`/`cpu` field, so npm skips exactly the platform-specific
   * optional dependencies and nothing else. The engine must then be told
   * where the real binary is — see `engineEnv`.
   */
  readonly skipNativeOptional?: boolean;
  /** Args that make the binary print its version. Defaults to ["--version"].
   * Hermes needs ["acp", "--version"]: its plain --version prints a report
   * whose lines include the PYTHON version, which a first-match scan would
   * happily report as the engine's. */
  readonly versionArgs?: readonly string[];
  /**
   * Args that prove the engine's REAL entry point runs, for the post-install
   * verification. Defaults to `versionArgs` — for most engines the two
   * questions have one answer.
   *
   * They come apart when the version Cody must REPORT and the code path Cody
   * must EXERCISE live in different places. Codex is the case: Cody installs
   * the ACP adapter, so the version the update check compares with the
   * registry is the adapter's (`--version`) — but the adapter answers that
   * from its own bundle before it ever touches Codex, and npm resolves the
   * platform-native Codex binary on a best-effort basis. A bare probe would
   * bless an install that reports a healthy adapter and dies on every turn.
   * `["cli", "-V"]` runs the Codex the adapter would drive, and fails loudly
   * when it is missing.
   */
  readonly healthArgs?: readonly string[];
  /**
   * Argv that opens this engine's INTERACTIVE CLI, when a bare invocation is
   * not it. Defaults to none — `omp`, `claude` and `codex` all start their own
   * TUI when run with no arguments.
   *
   * ACP adapters do not: run bare, they are JSON-RPC servers reading stdin, so
   * a Cody terminal launching one would swallow the user's keystrokes as
   * malformed protocol frames. `@agentclientprotocol/codex-acp` forwards
   * `cli <args>` to the real Codex CLI, which is what a terminal — and the
   * `codex-acp cli login` in its authHint — actually wants.
   */
  readonly cliArgs?: readonly string[];
  /**
   * Environment this engine needs in order to find its own parts, merged over
   * `process.env` everywhere Cody runs it: the live session, the post-install
   * health probe, and a Cody terminal. One source, three uses — so the engine
   * that gets VERIFIED is always the engine that RUNS.
   *
   * A function, not a table: it resolves paths at call time, so an engine
   * installed (or moved) after the server booted is found without a restart.
   * It is merged OVER `process.env` at every call site, so an implementation
   * that must not overrule an operator's own export omits that key itself —
   * a deliberate `CLAUDE_CODE_EXECUTABLE` on the container is a choice Cody
   * has no business quietly reversing.
   */
  engineEnv?(): Record<string, string>;
  /** Exact engine version this Cody build was last audited against — the
   * marker for "what version of the engine was Cody built to". Its MAJOR
   * drives the System & Updates warnings: when the registry offers — or the
   * user has installed — a later major, the card warns that new engine
   * features may not surface in Cody yet (schema-driven surfaces keep
   * working; bespoke ones lag). The full string is shown on the engine's
   * update card. Bump it in the same commit as each compatibility audit.
   * Absent = never warn, nothing shown.
   *
   * It is a version of the package `installSpec` names, always. For a
   * two-package engine that is the ADAPTER's version (0.x for
   * claude-agent-acp, 1.x for codex-acp) and not the CLI's (2.x, 0.x) — two
   * unrelated number lines. `engineCli.adapterLabel` is what the notice names
   * for exactly that reason: "Claude Code v1.0.0 is a newer major release"
   * would be read as a claim about the CLI, which is a different package
   * moving at a different pace. */
  readonly verifiedVersion?: string;
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
   * Live-chat factory for engines that do not speak the pi/omp RPC dialect.
   * Exactly one of `createSession` / `rpcUi` must be present: turn-based
   * engines implement createSession; rpc-dialect engines describe their CLI
   * with rpcUi and ride rpc-manager's pipeline.
   */
  createSession?(options: EngineSessionOptions): EngineSession;
  /** RPC-dialect spawn descriptor (omp, pi). See RpcUiSpawn. */
  readonly rpcUi?: RpcUiSpawn;
  /**
   * The engine's persistent memory, as documents to display. Present only
   * when `capabilities.memory` is true.
   *
   * Read-only on purpose. Memory is the agent's own account of what it has
   * learned; a user editing it through Cody would be rewriting the engine's
   * notes behind its back, and every engine curates it differently. Showing
   * it answers the question users actually have — "what does it think it
   * knows about me?" — without pretending Cody owns the file.
   */
  readMemory?(): MemoryDocument[];
}
