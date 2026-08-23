# ACP engines: Hermes first, and what comes after

Status: **plan** — phase 1 in progress. Owner-approved scope (2026-08-22):
chat + settings for Hermes first, the rest planned here so it does not get
dropped half-built.

## Why ACP at all

[Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research,
v0.20.x) ships `hermes acp` — a stdio JSON-RPC server speaking the
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
  (`@zed-industries/agent-client-protocol`, ESM, one dependency: `zod`), so
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

**1a. Generic ACP client** (`lib/harness/acp/`). Engine-neutral from day one:
no Hermes strings in it. Spawns the server, drives `ClientSideConnection`,
negotiates capabilities, and translates `session/update` into Cody's
`EngineEvent` vocabulary. Implements the client side Cody can honestly serve —
`fs/read_text_file` and `fs/write_text_file` against the workspace, permission
requests, and cancellation.

**1b. Hermes adapter** (`lib/harness/hermes.ts`). Capability flags set to what
is actually true, so unsupported surfaces hide rather than break. Binary
resolution follows the established ladder: `CODY_HERMES_BIN` → tools prefix →
`PATH`.

**1c. Non-npm install.** Hermes is not on npm — it installs via a curl script
or `uvx`. `lib/harness/install.ts` assumes `npm install -g --prefix`, so it
gains a second mechanism. Non-negotiable: the new path carries the same guards
the npm path just earned — measured disk preflight, stale-directory sweep, and
a post-install binary probe before reporting success.

**1d. Settings.** Cody's "All OMP Settings" tab is generated from omp's own
TypeScript schema. Hermes has no equivalent, but exposes
`hermes config get <key> --json` (and `--json` on many other subcommands), so
its settings surface is driven by the CLI instead. Includes models/providers
configuration.

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

- **Claude Code — migrate.** There is an official adapter
  (`zed-industries/claude-code-acp`). Today Cody drives it as one process per
  turn (`claude -p --output-format stream-json`), which buys no approval
  channel, no persistent session, and coarse tool reporting. ACP is a strict
  gain here.
- **Codex — assess.** Same per-turn limitation today. Depends on whether a
  maintained ACP adapter exists; verify before committing.
- **omp — do NOT migrate.** omp's `rpc-ui` gives Cody strictly more than ACP
  does: host tools (`open_preview`, `preview_screenshot`, `read_app_logs`),
  subagent lifecycle events, forking, compaction, thinking levels, steering
  and follow-up queues, and v3 `.jsonl` transcripts Cody reads directly.
  ACP has no vocabulary for most of that. Moving omp to ACP would trade the
  founding engine's best surfaces for protocol uniformity that benefits
  nobody. omp keeps `rpc-ui`; ACP is how engines that *don't* speak rpc-ui
  reach parity.

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
