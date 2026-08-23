# ACP engines: Hermes first, and what comes after

Status: **phase 1 done** (2026-08-23) — Hermes is a working Cody engine for
chat and settings. Phases 2 and 3 are still plan. Owner-approved scope
(2026-08-22): chat + settings for Hermes first, the rest planned here so it
does not get dropped half-built.

## Why ACP at all

[Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research,
v0.19.0 on PyPI as of 2026-08-23) ships `hermes acp` — a stdio JSON-RPC server speaking the
[Agent Client Protocol](https://agentclientprotocol.com), already used in
production by Zed, VS Code and JetBrains. ACP is an open standard for exactly
the thing Cody does: an editor driving a coding agent.

That makes ACP a **third engine transport** worth having on its own merits,
not a Hermes-shaped special case:

- It is the only Cody transport with a real **approval channel**
  (`session/request_permission`). Claude Code and Codex run with edits
  auto-accepted because their non-interactive modes have nowhere to ask.
- Any future ACP agent becomes a Cody engine for free.
- There is an official, Node-friendly TypeScript SDK
  (`@agentclientprotocol/sdk`, ESM, zero dependencies — the older
  `@zed-industries/agent-client-protocol` name is deprecated), so
  Cody does not hand-roll JSON-RPC framing or schema validation. This matters:
  Cody cannot import omp's own packages at all (Bun-only), so a
  plain-Node protocol library is a genuine advantage.

## The protocol, as verified

JSON-RPC 2.0 as newline-delimited JSON over stdio. `protocolVersion` 1.
Property keys `camelCase`, discriminators `snake_case`, absolute paths,
1-based lines.

Client → Agent: `initialize`, `authenticate`, `session/new`,
`session/prompt`, `session/cancel` (notification), `session/load`
(gated by the `loadSession` capability), `session/set_mode`, `logout`.

Agent → Client: `session/update` (notification), `session/request_permission`,
`fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|release|
wait_for_exit|kill`, `elicitation/create`.

`session/update` variants: `UserMessageChunk`, `AgentMessageChunk`,
`AgentThoughtChunk`, `ToolCall`, `ToolCallUpdate`, `Plan`.

## How it fits Cody's existing seam — no core changes

`HarnessAdapter` already has two shapes: an `rpcUi` descriptor (omp, pi) and
`createSession()` returning an `EngineSession` (Claude Code, Codex).
**ACP engines implement `createSession()`.** The existing interface fits
without modification:

| `EngineSession` member | ACP mapping |
| --- | --- |
| `start()` / `isAlive()` / `destroy()` | one long-lived `hermes acp` child process |
| `waitUntilReady()` | `initialize` handshake completes |
| `onIdentityChange` | the id returned by `session/new` replaces Cody's placeholder |
| `onEvent` | translated `session/update` notifications |
| `send(command)` | `prompt` → `session/prompt`, `abort` → `session/cancel`; everything else throws `unsupported` |
| `sessionFile` | `""` — Hermes owns its storage (SQLite, below) |

Unlike Claude/Codex (one process per turn), an ACP session is **persistent**,
which is closer to how omp already behaves. Session metadata rides the
existing `cody-engine-sessions.json` sidecar and the session-owners sidecar,
exactly as the turn engines do.

## Phase 1 — chat and settings (approved, in progress)

**1a. Generic ACP client** (`lib/harness/acp-session.ts`) — DONE. Engine-neutral from day one:
no Hermes strings in it. Spawns the server, drives the SDK's `ClientApp`,
negotiates capabilities, and translates `session/update` into Cody's
`EngineEvent` vocabulary. Implements the client side Cody can honestly serve —
`fs/read_text_file` and `fs/write_text_file` against the workspace, permission
requests, and cancellation.

**1b. Hermes adapter** (`lib/harness/hermes.ts`) — DONE. Capability flags set
to what is actually true, so unsupported surfaces hide rather than break.
Binary resolution follows the established ladder: `CODY_HERMES_BIN` → tools
prefix → `PATH`.

Two things only a real install could have taught us, both now pinned by tests:
the ACP server lives behind an extras marker, so the spec is
`hermes-agent[acp]` and a plain `hermes-agent` installs fine and then exits
"ACP dependencies not installed"; and the adapter probes `hermes acp
--version` rather than a bare `--version`.

That second one is worth stating precisely, because an earlier note here got
it wrong: `hermes --version` does NOT report the Python version. It prints a
multi-line banner whose first line carries the real version, and the probe's
leftmost-match reads it correctly. The reason to probe the subcommand is
better than that: `hermes acp --version` runs the ACP entry point, so it fails
when the extra is missing. A bare `--version` succeeds either way — which
means it would report a healthy install of an engine whose every chat turn
then dies. `app/api/engines/install/route.ts` verifies through the adapter's
`versionArgs` for exactly this reason.

**1c. Non-npm install** — DONE. Hermes is not on npm. `lib/harness/install.ts`
gained a second mechanism, `installVia: "uv"`, running `uv tool install
--force` with `UV_TOOL_DIR`/`UV_TOOL_BIN_DIR`/`UV_CACHE_DIR` pointed inside
the same persistent tools prefix npm installs into — so a PyPI engine
survives a container replacement exactly as an npm one does, and lands its
binary on the same `PATH`. `uv` is now in the image (`docker/Dockerfile`).
The new path carries every guard the npm path earned: measured disk
preflight, stale-directory sweep, and a post-install binary probe before
reporting success. The update check is ecosystem-aware too — PyPI's
`info.version` rather than npm's `dist-tags.latest`.

**1d. Settings** (`lib/harness/hermes-settings.ts`) — DONE, but **not** the
way this plan first said. `hermes config get --json` returns *values*, and a
panel built from values can only ever show settings the user already set —
the opposite of the property that makes Cody's omp panel worth having.

What it does instead: Hermes declares every setting and its default in
`hermes_cli.config.DEFAULT_CONFIG`, a nested Python dict. Cody reads THAT, by
invoking the venv interpreter `uv tool install` places beside the binary —
the same trick as reading omp's TypeScript schema through jiti: ask the
engine's own runtime. 553 settings in 53 groups, including models and
providers. Hermes adds a setting upstream, Cody shows it, with no Cody
release.

`DEFAULT_CONFIG` carries no UI metadata, so the module derives only what it
honestly can (a label from the key, a control from the default's type) and
invents nothing. Writes go through `hermes config set`, never by editing the
YAML: the CLI owns validation, coercion and config migration, and a file Cody
wrote behind its back is one Hermes can then refuse to load. The schema is
memoized against the venv's mtime, so a `--force` reinstall at the same path
re-reads rather than serving the old version's settings.

Panel reuse was total — `app/api/omp-settings/schema/route.ts` dispatches on
the active harness and returns the same shape, so `OmpSchemaSettings.tsx`
renders Hermes with no engine-specific code. It did expose one latent bug:
the row fell back to printing the setting key as its description, harmless
while every setting had one (omp's do) and duplicated on every row for
Hermes, which declares none.

## Phase 2 — the Hermes-specific features worth having

Owner-selected: **permissions, memory, skills**. Explicitly out of scope:
bots and the messaging gateway (Telegram/Discord/Slack/…) — real Hermes
features, but not IDE-shaped, and Cody is an IDE.

- **Approval prompts.** `session/request_permission` rendered as in-chat
  approve/deny. This is new capability for Cody, not a port of something
  existing.
- **Memory browser.** Hermes keeps persistent memory that grows across
  sessions — the thing that makes it Hermes.
- **Skills.** Hermes writes and refines its own skills. Cody already has a
  skills surface built for omp; it gets adapted rather than duplicated.

## Phase 3 — migrating the existing engines, honestly

The owner's stated goal is to move omp, Claude Code and Codex onto ACP. That
is right for two of the three and **wrong for omp**:

- **Claude Code — migrate**, but NOT via the package this spec first named.
  `@zed-industries/claude-code-acp` is **deprecated on npm across all 73
  versions** ("renamed to @agentclientprotocol/claude-agent-acp"), last
  published 2026-02-17, and its GitHub repo 301-redirects to the new org.
  The live package is **`@agentclientprotocol/claude-agent-acp`** — 0.70.0
  published 2026-08-18, ~1.0M weekly downloads, published by the same three
  maintainers as `@agentclientprotocol/sdk`, which Cody already depends on.
  Verified by a real handshake, it advertises `loadSession`,
  `session/request_permission`, `agent_thought_chunk`, `plan`, model selection
  as a config option, `promptCapabilities {image, embeddedContext}`,
  `setSessionMode`, session fork/list/delete/close, terminals, steering, and
  opt-in nested subagent transcripts.

  The ACP `sessionId` IS Claude Code's own session id — the same value Cody
  already stores as `engineSessionId` and passes to `--session-id`/`--resume`
  — so no migration of stored ids is needed.

  Two real fidelity costs, both accepted deliberately:
  - **No intra-turn message boundary.** `agent_message_chunk` carries content
    and nothing else, so the only boundary is the turn. Today Cody renders one
    bubble per API call within a turn.
  - **Per-call token granularity becomes a turn total.** `PromptResponse.usage`
    is also marked UNSTABLE in the ACP schema, so it may move.

  And one trap: the adapter's tool `title` is a human SENTENCE
  ("npm run typecheck"), not a tool name; the real name is in
  `_meta.claudeCode.toolName`. The standard `name` field is marked UNSTABLE.

- **Codex — migrate.** The assessment resolves cleanly: **
  `@agentclientprotocol/codex-acp`** 1.6.2, published 2026-08-20, ~1.1M weekly
  downloads — MORE than the Claude adapter — same org, same maintainers. It
  drives `codex app-server` over JSON-RPC rather than `codex exec`, so it
  swaps a per-turn process for a persistent session. Its `sessionId` is the
  Codex thread id Cody already stores, and its usage mapping already performs
  the cached-input subtraction `codex-stream.ts` hand-rolls today. Only `fork`
  is missing relative to the Claude adapter.

  The `codex` CLI itself does NOT speak ACP: zero occurrences of "acp" in its
  subcommand enum, no acp crate, nothing in its README or changelog. ACP for
  Codex runs through the adapter, and there is no sign that changes.

  Every other candidate is a downstream fork of the official adapter, or dead
  (`acp-claude-code` and `@mrtkrcm/acp-claude-code` were last published
  2025-09 and are ~12 months stale). `@zed-industries/*codex*` does not exist.

- **Both adapters bundle their engine.** Claude's pulls ~309 MB of native
  binary as a platform-specific optional dependency; installing it naively
  would duplicate a CLI Cody already manages and blow through the disk
  preflight the ZFS incident earned. Both honour an override —
  `CLAUDE_CODE_EXECUTABLE` and `CODEX_PATH` — which keeps engine version
  management in Cody's hands and is the path to take.

- **A root guard worth knowing.** The Claude adapter offers a
  `bypassPermissions` permission option only when
  `ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX`. Cody's container runs
  as root with no `USER` directive, so the guard holds — unless something sets
  `IS_SANDBOX`, which defeats it. Worth an assertion in the smoke contract.
- **omp — keep rpc-ui, but the margin is narrower than first written.**
  An earlier draft of this spec claimed ACP "has no vocabulary" for omp's
  best surfaces. That was wrong, and reading omp 18's own
  `src/modes/acp/` corrects it. Over ACP omp advertises and implements:
  `agent_thought_chunk` (thinking IS carried), `sessionCapabilities`
  `{list, fork, resume, close}` (forking IS carried), `loadSession`,
  `mcpCapabilities` `{http, sse}`, `promptCapabilities`
  `{embeddedContext, image}`, `setSessionMode`, model listing and selection
  through session config options, steering, and compaction.

  What is genuinely absent over ACP, verified by grep across that directory:
  - **Subagent telemetry.** No subagent mapping exists at all, so Cody's
    composer subagent roster and transcript dialog would go dark.
  - **Cody's host-tool bridge.** `set_host_tools` (`open_preview`,
    `preview_screenshot`, `read_app_logs`) is an rpc-ui mechanism with no ACP
    equivalent. MCP is the partial substitute — it is already how Claude and
    Codex get `open_preview` — so this is recoverable, not lost.
  - **Fine-grained `get_state`.** `queuedMessageCount`, `todoPhases`,
    fast-mode and the context gauge have no direct ACP analogue; `plan`
    updates and config options cover part of it.

  Session `.jsonl` transcripts are written by omp regardless of transport, so
  history browsing is NOT a casualty — an earlier claim here that it was is
  also withdrawn.

  Net: rpc-ui remains the richer path for omp and there is no reason to move
  the founding engine off it today, but the gap is subagents plus a tool
  bridge, not a chasm. Worth revisiting once Claude Code has migrated and the
  ACP path has real mileage.
- **pi — no change.** pi already rides the same rpc pipeline as omp via
  `--mode rpc`, which is strictly richer than what a per-turn seam gives.
  Whether pi also speaks ACP has not been verified and does not matter: there
  is nothing to gain by moving it off the dialect Cody already drives.

The end state is therefore three transports, each because it earns its place:
`rpcUi` for the omp dialect, `acp` for the open standard, and the per-turn
`createSession` fallback for CLIs that offer nothing better.

## Known friction

- **Sessions are SQLite, not JSONL.** Hermes stores conversations in
  `~/.hermes/state.db` (FTS5). Cody's sidebar reads omp's `.jsonl` files
  directly, so Hermes sessions cannot use that path. Options: `hermes sessions
  list --json` / `export --json`, or treat them as engine-owned like
  Claude/Codex sessions. Decide in 1b.
- **Two checkpoint systems.** Hermes has its own shadow-git checkpoints
  (`~/.hermes/checkpoints`, `/rollback`); Cody has `lib/checkpoints.ts`. They
  must not both snapshot the same workspace — pick one per engine.
- **Hermes is broader than a coding agent.** Autonomous routines, bots and a
  16-platform gateway are core to it and largely meaningless inside an IDE.
  Capability flags decide what Cody shows; the answer is not "everything".
- **Install surface.** A curl-to-bash installer is a different trust and
  failure model than `npm install`. It needs the disk guards, and it should
  never run unattended without the admin asking for it.

## Verification

omp ships its own ACP mode (`--mode acp`), so the generic client can be
exercised against a known-good ACP server **before Hermes is installed
anywhere** — protocol bugs surface without a second moving part. Hermes then
validates the adapter. Every phase ships behind the normal gate:
`npm run typecheck && npm run lint && npm test && npm run build`, plus a real
browser pass for anything with UI.
