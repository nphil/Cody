# ACP engines: Hermes first, and what comes after

Status: **phase 1 done**, **phase 3 done for the turn engines** (2026-08-23)
— Hermes is a working Cody engine for chat and settings, and **Codex and
Claude Code have both moved off their per-turn transports onto ACP** (see
"Phase 3, as built" below). Phase 2 is part-built: **memory and skills are
done** (see "Phase 2c, as built"), approval prompts are still plan. omp and pi
keep `rpcUi` deliberately. Owner-approved scope (2026-08-22): chat + settings for Hermes
first, the rest planned here so it does not get dropped half-built.

## Why ACP at all

[Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research,
v0.19.0 on PyPI as of 2026-08-23) ships `hermes acp` — a stdio JSON-RPC server speaking the
[Agent Client Protocol](https://agentclientprotocol.com), already used in
production by Zed, VS Code and JetBrains. ACP is an open standard for exactly
the thing Cody does: an editor driving a coding agent.

That makes ACP a **third engine transport** worth having on its own merits,
not a Hermes-shaped special case:

- It is the only Cody transport with a real **approval channel**
  (`session/request_permission`). A per-turn CLI runs with edits
  auto-accepted because its non-interactive mode has nowhere to ask — which
  is exactly what Codex left behind by migrating.
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
`createSession()` returning an `EngineSession` (the per-turn engines).
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

Unlike a per-turn engine (one process per prompt), an ACP session is
**persistent**, which is closer to how omp already behaves. Session metadata rides the
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
  **DONE — see "Phase 2c, as built" below.**

## Phase 2c, as built — the skills surface, adapted (2026-08-23)

`capabilities.skills` is TRUE for Hermes. The existing surface — scan, toggle,
store, install — now runs against Hermes' own conventions instead of omp's,
and the parts Cody cannot express faithfully are visibly disabled rather than
faked. Everything below was verified against a real `hermes-agent` 0.19.0
install, not read off the docs.

**The layout is nested, and that is the whole reason the surface was broken.**
`lib/skills-service.ts` scanned `<root>/<name>/SKILL.md` with a one-level
`readdir`. Hermes discovers with `rglob("SKILL.md")` under
`$HERMES_HOME/skills`, and `hermes skills install --category security
1password` writes `skills/security/1password/SKILL.md` — so a flat scan found
NONE of a categorised install. `SkillScanRoot.recursive` now exists and is set
by the Hermes branch only: omp's and pi's roots sit inside repositories and
user config dirs, where a recursive walk would list every vendored,
checked-out and archived `SKILL.md` in the tree as a loaded skill. The walk
replicates Hermes' own pruning (`agent/skill_utils.iter_skill_index_files`):
`.hub`, `node_modules`, VCS and cache dirs always, and a skill package's
`references/templates/assets/scripts` only when the directory containing them
is itself a skill — so `skills/scripts/<name>` stays a legitimate category.

**Extra roots come from the engine's config**, `skills.external_dirs`,
expanded the way Hermes expands it (`~`, `${VAR}`, relative against
HERMES_HOME, existing dirs only). The bundled `optional-skills` inside the
installed package are NOT a root: they are a catalog `hermes skills install`
copies from, and Hermes loads a copy only once it is seeded into the skills
root.

**There is no project scope, so Cody stops offering one.** Hermes has one
skills root per home plus read-only external dirs. `GET /api/skills` now
reports `installScopes`, the store hides its scope selector when there is only
one, and `/api/skills/install` refuses `scope: "project"` with a reason
instead of installing globally under a project label.

**Enable/disable is config, not frontmatter — and `hermes config set` cannot
write it.** `skills.disabled` in `$HERMES_HOME/config.yaml` is a list of skill
NAMES (`agent/skill_utils.get_disabled_skill_names`); nothing in Hermes reads
`disable-model-invocation`, so the existing toggle would have reported success
and changed nothing. Writing it is awkward for the reason `hermes-settings.ts`
already documents: `hermes config set` stores one scalar per key and has no
list form, and `hermes skills config` is an interactive curses checklist. What
IS reachable is the function Hermes' own dashboard calls for this exact
action, `hermes_cli.skills_config.save_disabled_skills`, which routes through
`save_config` and keeps atomic writes, default stripping and the
managed-scope guard. Cody runs it through the venv interpreter beside the
binary — the same "ask the engine's own runtime" trick that reads
DEFAULT_CONFIG — so the SKILL.md is never rewritten. Verified round-trip:
toggling in Cody flips the Status column of `hermes skills list`, and the
`SKILL.md` is byte-identical afterwards.

When that interpreter is absent (a bare `pip install` onto PATH with no
adjacent venv), `canToggle` comes back false and the switch renders read-only
with an honest reason rather than writing a key Hermes ignores — the
`readOnly`/`readOnlyReason` pattern `OmpSchemaSettings` already uses for
unwritable list settings.

**`hermes skills install` exits 0 whether or not it installed.** This is the
trap of this phase, and it is the same shape as the version-probe traps the
Claude and Codex migrations hit. Measured, all with status 0:

- blocked by the security scanner — `Installation blocked: Blocked (community
  source + caution verdict, 2 findings). Use --force to override.`
- unresolvable identifier — `Error: Could not fetch '…' from any source.`
- success — `Installed: security/1password`

So success is read from the literal `Installed:` line, never the exit code.
`--force` is deliberately never passed: overriding a blocked security verdict
is the user's decision to make in a terminal, not Cody's.

**Identifier translation, and where it stops.** Cody's store browses skills.sh
and emits `owner/repo@slug`; Hermes addresses the same registry as
`skills-sh/owner/repo/slug` (`tools/skills_hub.SkillsShSource`, confirmed with
`hermes skills search --json`). That translation is exact and reversible, and
the inverse is used to annotate installed skills so the store shows them as
installed. Two honest limits: a `https://<domain>` well-known spec means "this
provider's whole set" to `npx skills` and nothing to Hermes, so it is refused
with a reason; and Hermes resolves a repo's skill path by trying
`<repo>/<slug>`, `<repo>/skills/<slug>`, `<repo>/.agents/skills/<slug>` and
`<repo>/.claude/skills/<slug>`, so a repo that nests deeper than that
(`anthropics/skills`, `openai/skills`) fails to fetch — Hermes' own limit, and
it surfaces as Hermes' own error text.

**Update checks stay Hermes'.** Cody's check diffs a GitHub tree hash out of
the skills.sh lock; Hermes keeps its own `content_hash` in
`<skills root>/.hub/lock.json` and its own `hermes skills check`/`update`. So
every Hermes install reports `canCheckForUpdates: false`: the per-skill Check
button hides, the footer check-all is now gated on `canCheckForUpdates` (a
strict improvement for every engine — a dead button that always answers
"unsupported" helps nobody), and the System card says checks are unavailable
instead of claiming "up to date" for a check that never ran.

**One Hermes inconsistency worth knowing.** `.hub/lock.json` is keyed by the
name resolved at INSTALL time, which is not always the frontmatter `name` a
later scan reads: a skill whose SKILL.md says `name: PDF Generator` is locked
under `pdf-generator`, and Hermes' own `hermes skills list` then reports it as
source "local". The `install_path` it also records is exact, so Cody matches
on that first and falls back to the name — which gives the user better
provenance than Hermes' own list does.

**One ungated fetch fixed on the way past.** `ChatInput` fetches `/api/skills`
to dim dormant skills in the `/` palette, with no capability check, so Claude
Code and Codex (`skills: false`) ran a full filesystem scan on every `/`
keystroke. Its props arrive through `ChatWindow` and none of them carry
capabilities, so it asks `lib/engine-capabilities.ts` instead: one memoized
`/api/info` read per page load, permissive on anything but an explicit
`false`, exactly as AppShell is.

### Not done, and why

- **`environments:` gating.** Hermes hides a skill tagged for an inactive
  runtime environment (kanban/docker/s6). Detecting those means reading
  Hermes' toolset config and container markers, and Hermes itself fails OPEN
  on a tag it does not recognise. Over-listing an s6-only skill is cosmetic;
  mis-detecting one and hiding a skill that IS loaded would be a lie, so only
  `platforms:` is replicated.
- **A Hermes-native store.** `hermes skills browse/search` reaches five
  registries Cody's store does not (official/optional, ClawHub, LobeHub,
  browse.sh, taps). Cody's store stays skills.sh-only; the rest is
  `hermes skills install` in a terminal.

## Phase 3 — migrating the existing engines, honestly

The owner's stated goal is to move omp, Claude Code and Codex onto ACP. That
is right for two of the three and **wrong for omp**:

- **Claude Code — MIGRATED** (see "Phase 3, as built"), but NOT via the
  package this spec first named.
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

- **Codex — MIGRATED** (see "Phase 3, as built"). **
  `@agentclientprotocol/codex-acp`** 1.6.2, published 2026-08-20, ~1.1M weekly
  downloads — MORE than the Claude adapter — same org, same maintainers. It
  drives `codex app-server` over JSON-RPC rather than `codex exec`, so it
  swaps a per-turn process for a persistent session. Its `sessionId` is the
  Codex thread id Cody already stores, and its usage mapping already performs
  the cached-input subtraction `codex-stream.ts` hand-rolled. Only `fork` is
  missing relative to the Claude adapter.

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

## Phase 3, as built — Codex on ACP (2026-08-23)

Codex is off `codex exec --json`. `lib/harness/codex.ts` now builds an
`AcpEngineSession` from an `AcpEngineSpec`, exactly as `hermes.ts` does, and
`lib/harness/codex-stream.ts` is deleted along with its half of
`turn-session.test.mjs` and `stream-translate.test.mjs`. `turn-session.ts`
stays: it still carries Claude Code, and `EngineCommandError` lives there.

**What the adapter actually advertises**, from a live `initialize` against
1.6.2: `loadSession: true`, `promptCapabilities {embeddedContext, image}`,
`sessionCapabilities {resume, list, close, delete, additionalDirectories}`,
`mcpCapabilities {http: true, sse: false, acp: false}`, `authMethods`
`[api-key, chat-gpt]`, and `_meta.steering.supported`. No `fork` — the one
capability the Claude adapter has and this one does not.

**Session identity carries over with no migration**, verified rather than
assumed: `session/new` returned `01a02d70-…`, and Codex wrote that turn to
`~/.codex/sessions/2026/08/23/rollout-…-01a02d70-….jsonl`. Same id space as
`thread.started.thread_id`, same directory `getSessionsDir()` already points
at. A second `AcpEngineSession` for the same Cody session id resumed the same
thread through `session/load`.

**Capability flags did not change**, and that is the honest answer: the
migration changed the transport, not the surfaces. The adapter does carry
models (`session/new` returns `availableModels`) and MCP, but Cody's model
and MCP editors are omp's, and nothing plumbs the ACP equivalents through
yet — a dropdown wired to nothing is worse than no dropdown. What DID change
without a flag: Codex can now stop mid-turn and ask, because ACP has an
approval channel and `codex exec` had nowhere to ask.

**Two binaries, one engine.** The adapter bundles `@openai/codex`, whose
platform-native package is ~296 MB. Measured: adapter alone 311 MB, adapter
plus a separately-installed `@openai/codex` 619 MB — npm shares nothing
between two globally-installed packages. So the halves are installed apart
and joined by `CODEX_PATH`: `skipNativeOptional` installs the adapter with
`--os=none --cpu=none` (311 MB → 16 MB), `installAlso` installs the Codex CLI
as its own package Cody can version, update and revert, and `engineEnv()`
points the adapter at it. 324 MB in total, with a real `codex` back on the
tools prefix `PATH` — which is what `codex login` and the SSH engine-first
profile look for.

**The health probe has to run Codex, not the adapter.** `codex-acp --version`
answers from its own bundle before it ever looks at Codex: with the native
package removed it still exits 0 reporting 1.6.2, while every chat turn dies.
That is Hermes' lesson in a second costume, so `healthArgs` is
`["cli", "-V"]`, which forwards to the real CLI through the adapter's own
resolution and fails with "Missing optional dependency
@openai/codex-linux-x64" when the halves come apart. `versionArgs` stays bare
`--version`, because THAT is the package `installSpec` names and the one the
update check compares with the registry — the two questions genuinely have
different answers here, which is why `healthArgs` exists at all.

Not `cli --version`: the adapter scans the whole argv for `--version` and
short-circuits, so `cli --version` reports the adapter again and proves
nothing.

**An ACP adapter run bare is a server, not a CLI.** `cliArgs: ["cli"]` names
the passthrough that reaches the interactive Codex CLI, so a Cody terminal
(and `codex-acp cli login`) still lands somewhere a human can type. Without
it the terminal would hand the user's keystrokes to a JSON-RPC parser.

**Authentication needs one nudge.** With `OPENAI_API_KEY` exported and
nothing else, `session/new` answers `-32000 Authentication required`: the
adapter will not reach for the key on its own. `engineEnv()` therefore
declares `DEFAULT_AUTH_REQUEST={"methodId":"api-key"}` when — and only when —
`CODEX_API_KEY`/`OPENAI_API_KEY` is actually set. A `codex login` session
needs no key and is never re-authenticated behind the user's back, because
the adapter checks whether auth is required first. `codex login` still works
as the sign-in command because `installAlso` keeps the real CLI on the tools
prefix `PATH`.

**The host-tool bridge survived.** `open_preview` / `preview_screenshot` /
`read_app_logs` reached Codex as `-c mcp_servers.…` TOML overrides on the
per-turn argv; ACP carries them properly as an `McpServerStdio` named at
`session/new`, which the adapter writes into the session's own Codex config.
Verified: Codex spawns `bin/cody-display-mcp.js` for the session and releases
it on destroy. `codexDisplayMcpArgs()` is deleted; `displayMcpAcpServer()`
replaces it. One trap, guarded: minting the capability token throws without
the server's display origin and secret, and `scripts/engine-bringup.mjs`
drives adapters with no server behind them — so the `mcpServers` hook catches
and returns an empty list. A throw there would abort `session/new`, turning a
missing Preview button into a chat that will not open.

**Usage: the hand-rolled normalization is now redundant, and is gone.**
`codex-stream.ts` subtracted `cached_input_tokens` and
`cache_write_input_tokens` out of codex's inclusive `input_tokens` so Cody's
four-field total would not double-count. The adapter does the equivalent
itself (`inputTokens - cachedInputTokens`) and reports the turn's own figures
on `PromptResponse.usage`, which `acp-session.ts` translates into one
additive `usage_event`. One fidelity note: the ACP `Usage` schema has a
`cachedWriteTokens` field but this adapter never populates it, so Codex's
cache-write tokens stay folded into `inputTokens`. The TOTAL is unchanged;
only the input/cache-write split is coarser than before.

### Costs and follow-ups, stated plainly

- **Tool chips read as sentences.** The adapter's `title` is human prose —
  the command line for a shell call, "Editing files" for an edit — and it
  publishes no tool name in `_meta`, so `toolNameMetaPath` has nothing to
  point at. The old translator mapped `command_execution` → `bash`; the ACP
  path shows the title instead.
- **`docker/entrypoint.sh` still maps `codex) _cody_bin=codex`.** That keeps
  working because `installAlso` puts `codex` back on the tools `PATH`, but
  the SSH profile now opens the Codex CLI directly rather than through the
  adapter, so it does not inherit `engineEnv()`. Worth aligning when that
  file is next touched.
- **Upgraders carry a fat adapter until they reinstall.** An instance that
  installed Codex before this change has the OLD `@openai/codex` (which
  `engineEnv()` now points at, so it is not wasted) and, on the next update,
  a slim adapter. The 324 MB figure assumes a clean prefix; re-running the
  engine card's Update action is what gets an existing instance there.

## Phase 3, as built — Claude Code on ACP (2026-08-23)

Claude Code is off `claude -p --output-format stream-json`.
`lib/harness/claude.ts` now builds an `AcpEngineSession` from an
`AcpEngineSpec`, the same shape `hermes.ts` and `codex.ts` use, and no
per-turn path remains in that file.

**What the adapter actually advertises**, from a live `initialize` against
0.70.0: `loadSession: true`, `promptCapabilities {image, embeddedContext}`,
`mcpCapabilities {http, sse}`, `sessionCapabilities {additionalDirectories,
close, delete, fork, list, resume}`, `auth.logout`, `providers`, and
`_meta.steering.supported`. `fork` is the one capability the Codex adapter
lacks.

**Session identity carries over with no migration**, verified rather than
assumed. `session/new` returned `fa7bd5d9-...`; a second `AcpEngineSession`
built for the same Cody session id resumed THAT id through `session/load`,
and `cody-engine-sessions.json` still holds the same `engineSessionId`
afterwards. Two fallbacks were exercised too, because both look identical
from the outside and only one is a bug: a session id the CLI has never heard
of, and a session that was opened but never prompted (no transcript exists to
load, so `session/load` legitimately refuses). Both fall through to
`session/new` and the chat opens - which is why the resume test has to send a
turn first, or it proves nothing.

**Capability flags did not change**, and that is the honest answer for the
same reason it was for Codex: the migration changed the transport, not the
surfaces. The adapter carries model selection as a session config option,
`setSessionMode` with five modes, `plan` and thinking - but Cody's model
picker, mode control and composer extras are built against omp's commands and
nothing plumbs the ACP equivalents through yet. What changed WITHOUT a flag:
Claude Code can now stop mid-turn and ask, because ACP has an approval
channel and `claude -p` had nowhere to ask.

**One copy of the CLI, not two.** The adapter bundles a ~309 MB
platform-native Claude CLI as an optional dependency of
`@anthropic-ai/claude-agent-sdk`, and Cody already installs and
version-manages `@anthropic-ai/claude-code`. Installing both naively is 688 MB
of which 309 MB is a duplicate - the shape of the ZFS quota exhaustion that
put the disk guards in `install.ts` there. So `skipNativeOptional` installs
the adapter without its bundle and `engineEnv()` sets
`CLAUDE_CODE_EXECUTABLE` to the CLI `installAlso` puts in the tools prefix.
Measured on a clean prefix: 379 MB total, one native binary, with `claude` and
`claude-agent-acp` both on the tools `PATH`.

**npm ignores `--omit=optional` for a global install.** This is the mechanism
note that matters, because the obvious flag silently does nothing: verified
against npm 10.9 as `--omit=optional`, as `--no-optional`, as
`NPM_CONFIG_OMIT=optional`, and through `--userconfig` - all four installed
the 309 MB package anyway (105 packages, 360 MB every time). What DOES work
globally is the platform gate: `--os=none --cpu=none` matches no package's
`os`/`cpu` field, so npm skips exactly the platform-specific optional
dependencies and nothing else (104 packages, 52 MB). That is
`SKIP_NATIVE_OPTIONAL_ARGS` in `lib/harness/install.ts`, and it is applied
per package - the CLI beside the adapter needs precisely the platform binary
the flag suppresses, so the two are separate npm invocations rather than one.

**The health probe has to run the CLI, not the adapter.** `claude-agent-acp
--version` is answered from the adapter's own `package.json` before it looks
at Claude at all, so it reports a healthy 0.70.0 with no CLI underneath -
which is exactly the state `skipNativeOptional` creates on purpose and
exactly the state a failed companion install leaves by accident. `healthArgs`
is therefore `["--cli", "--version"]`, which forwards to the CLI the adapter
would drive: verified both ways, it prints "2.1.241 (Claude Code)" when the
chain is whole and throws "Claude native binary not found ... or set
CLAUDE_CODE_EXECUTABLE" when it is not. `versionArgs` stays a bare
`--version`, because that is the package `installSpec` names and the one the
update check compares with the registry.

**The environment is computed once and used three times.**
`HarnessAdapter.engineEnv()` is merged over `process.env` for the live
session, for the post-install health probe, and for a Cody terminal - so the
CLI that gets VERIFIED is always the CLI that RUNS. It returns `{}` when
`CLAUDE_CODE_EXECUTABLE` is already exported: an operator who set it has
chosen a CLI, and Cody substituting its own would be the hardest kind of bug
to see, because everything keeps working against the wrong binary.

**Tool chips say "Bash", not "cat hello.txt".** The trap this spec recorded is
real and now handled: the adapter's `title` is human prose (the command line
for a shell call), and the tool's actual name is at
`_meta.claudeCode.toolName`. `acp-session.ts` stays engine-neutral by taking
the PATH as spec data - `toolNameMetaPath: ["claudeCode", "toolName"]` in
`claude.ts` - and resolving name from the `_meta` path, then the schema's
UNSTABLE `name`, then `title`, then `kind`. Verified against a live tool
call: the event Cody emitted carried `toolName: "Bash"`.

**The host-tool bridge survived.** `open_preview` reached Claude Code as a
`--mcp-config` blob on the per-turn argv; ACP carries it as an
`McpServerStdio` named at `session/new`, through the same
`displayMcpAcpServer()` the Codex migration also uses. One trap worth naming:
ACP discriminates a stdio server by the ABSENCE of a `type` field, and this
adapter tests `!("type" in server)` before connecting it - a well-meaning
`type: "stdio"` is not a no-op, it silently drops the server. Verified: the
descriptor starts `bin/cody-display-mcp.js`, which answers `tools/list` with
`open_preview`, and `session/new` with it attached still opens in under two
seconds.

**Usage is a turn total now, as this spec predicted.** `acp-session.ts`
translates `PromptResponse.usage` into one additive `usage_event` per turn -
`{input, output, cacheRead, cacheWrite}`, whose four fields summed to the
agent's own `totalTokens` on a live turn, so no subtraction is needed. Cost
is deliberately NOT read: ACP does not state its cost figure is per-turn, and
a cumulative number added as a delta compounds into something wrong that
looks authoritative. The `usage_update` notifications that arrive DURING a
turn are cumulative for the session and are ignored for the same reason.

**The root guard, sharpened.** The adapter allows `bypassPermissions` only
when `ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX`. Cody's container
runs as root and sets no `IS_SANDBOX`, so the guard holds and a
`permissions.defaultMode: bypassPermissions` in the user's settings is
ignored with a log line. The failure mode if something ever sets `IS_SANDBOX`
is worse than "the guard is off": the mode reaches the CLI, which refuses
`--dangerously-skip-permissions` under root, and `session/new` fails outright
with that message. Observed directly - this repo is developed inside a Claude
Code sandbox, which exports `IS_SANDBOX=yes`.

### Costs and follow-ups, stated plainly

- **No intra-turn message boundary**, as predicted. `agent_message_chunk`
  carries content and nothing else, so one turn is one bubble where the
  per-turn path rendered one per API call.
- **`get_messages` starts empty on a resumed session.** `session/load`
  restores the AGENT's context, not Cody's copy of the transcript, and the
  ACP client only banks messages it saw itself. The per-turn path behaved the
  same way, so this is not a regression - but it is why a reconnected session
  looks blank until the sidebar reads `~/.claude/projects`.
- **`turn-session.ts` and `claude-stream.ts` are now dead** for every engine:
  nothing calls `createClaudeSession` from `turn-session.ts` any more. They
  were deliberately left in place (both migrations were scoped not to delete
  them) and retiring them is one small follow-up: move `EngineCommandError`
  to an engine-neutral module, delete the two modules along with
  `turn-session.test.mjs` and `stream-translate.test.mjs`, and drop
  `TURN_SESSION_ALLOWLIST` plus the `claude-stream`/`turn-session` entries
  from `lib/architecture.test.mjs`.
- **`docker/entrypoint.sh` still maps `claude) _cody_bin=claude`.** That keeps
  working because `installAlso` puts `claude` back on the tools `PATH`, but
  the SSH profile opens the CLI directly rather than through
  `claude-agent-acp --cli`, so it does not inherit `engineEnv()`. Harmless
  for Claude (the CLI needs no pointing at itself) and worth aligning with
  `cliArgs` when that file is next touched.
- **Upgraders keep their old `@anthropic-ai/claude-code`** - which is now
  exactly the copy `engineEnv()` points at, so nothing is wasted. The
  measured 379 MB assumes a clean prefix.
- **A nested Claude Code environment makes `session/new` crawl.** With this
  dev container's full agent environment inherited (a dozen `CLAUDE_CODE_*`
  variables naming file descriptors and sockets the child never gets),
  `session/new` took 122 s instead of 1.4 s; with them stripped it is
  instant. Not attributable to any single variable by bisection, and it does
  not affect the container, which has none of them. It DOES affect the
  self-development loop: an `npm run dev` started from inside a Claude Code
  session inherits them. Strip them, or start the dev server from a plain
  shell.

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
validates the adapter.

Two checks now carry that forward and neither needs credentials:
`lib/harness/engine-transport.test.mjs` pins which engine rides which
transport with no binaries present, and `scripts/engine-bringup.mjs`
(`npm run engines:bringup`) spawns each INSTALLED engine and drives the real
handshake — `initialize` + `session/new` + `get_state` for ACP. One caveat
found while migrating Codex: its `session/new` requires authentication, so
bring-up on a Codex with no credentials reports the honest
"Authentication required" rather than a session id.

Every phase ships behind the normal gate:
`npm run typecheck && npm run lint && npm test && npm run build`, plus a real
browser pass for anything with UI.
