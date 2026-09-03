# Cody and agent engines

Cody is the IDE; the coding agent underneath it — the **engine** — is
swappable. The same UI ships with [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi)
as its founding, fully-featured engine, and can drive
[Pi](https://pi.dev) (omp's ancestor, over its native RPC mode),
[Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code),
[Codex](https://www.npmjs.com/package/@openai/codex) (over the Agent Client
Protocol) or [Hermes](https://github.com/NousResearch/hermes-agent) as
experimental engines today. New engines are added by implementing one adapter — the UI, accounts,
terminals, git surface, files, checkpoints and themes all stay.

## Picking an engine

- **Onboarding**: on a fresh instance, the first admin sees a full-screen
  engine picker right after signing in. Picking one persists the choice and
  the picker never returns.
- **Settings → User Accounts → Agent engine** (admins): shows every known
  engine with its install state, lets you install missing ones, switch the
  active engine, and uninstall engines Cody itself installed. Switching
  restarts live agent sessions; chat history and workspace files are
  untouched. Uninstall is offered only for a **managed** install (the
  resolved binary lives in Cody's tools prefix), never for the active
  engine — switch first — and never for a PATH or env-override binary,
  which belongs to the operator. Removing an engine leaves its recorded
  sessions and its own config/sign-in state on disk.
- Selection is stored in `cody-engine.json` in the instance data dir and wins
  over the `CODY_HARNESS` environment variable, which remains the deployment
  default for instances that never picked interactively.

Engines Cody installs from the picker land in a persistent npm prefix
(`CODY_TOOLS_DIR`, default `<data dir>/tools`) so they survive container
image updates. Binaries are resolved per engine: `CODY_OMP_BIN` /
`CODY_PI_BIN` / `CODY_CLAUDE_BIN` / `CODY_CODEX_BIN` override → tools
prefix → `PATH`. An engine whose ACP adapter is a different package from its
CLI has an override for each: Codex resolves `CODY_CODEX_BIN` for the
adapter and `CODY_CODEX_CLI_BIN` (or Codex's own `CODEX_PATH`) for the CLI
underneath it; Claude Code resolves `CODY_CLAUDE_BIN` for the adapter and
`CODY_CLAUDE_CLI_BIN` (or Claude's own `CLAUDE_CODE_EXECUTABLE`) for the
`claude` CLI.

### Experimental engines, honestly

**Codex** runs over the [Agent Client Protocol](https://agentclientprotocol.com):
one long-lived `codex-acp` process per session, `session/new` once and
`session/prompt` per turn. The `codex` CLI has no ACP mode, so Cody installs
the official adapter `@agentclientprotocol/codex-acp` and the Codex CLI as
two packages it can version independently, joined by `CODEX_PATH`. Because
the ACP session id IS the Codex thread id, sessions recorded under the old
per-turn transport resume unchanged.

**Claude Code** rides ACP too, on the same two-package shape: the official
adapter `@agentclientprotocol/claude-agent-acp` plus the `claude` CLI Cody
already version-managed, joined by `CLAUDE_CODE_EXECUTABLE`. The ACP session
id IS Claude Code's own session id, so sessions recorded under the old
per-turn transport resume unchanged. The per-turn transport
(`TurnEngineSession` plus a `<id>-stream.ts` translator) is the fallback for
a CLI that offers nothing better — no engine uses it today.

Either way you get a plain, reliable chat: prompt, streamed reply, tool
activity, abort. What it does not buy (yet): forking, compaction, thinking
levels, model switching from the composer, skills/plugins/MCP management,
transcript replay across server restarts, or the agent-callable host tools
(`open_file` / `open_url` / `notify` / `preview_screenshot` /
`read_app_logs` — omp's rpc-ui bridge; `open_preview` still works via the
bundled display MCP server, loopback URLs in assistant replies still
auto-open the Preview panel on every engine, and the Preview panel's capture
button screenshots the app server-side regardless of engine) — those
surfaces hide automatically via capability flags.

What ACP adds over the per-turn transport it replaced: an approval channel.
The agent can stop mid-turn and ask before a tool call, and Cody renders the
agent's own options rather than inventing Allow/Deny. A per-turn CLI has
nowhere to ask, so it runs with edits auto-accepted inside the workspace —
treat the workspace as its own while a turn runs.

Authentication belongs to the engine, not Cody: run `claude` or
`codex-acp cli login` once in a Cody terminal (credential state lives under
the container's persistent HOME), or set `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` on the container. A Cody terminal opens the active engine's
interactive CLI for you — for an ACP engine that is the adapter's passthrough
(`codex-acp cli`), never the bare binary, which is a JSON-RPC server. Codex can also target local models (`--oss`,
`model_provider` overrides in its own config), and omp's model registry
supports custom providers — local inference stays reachable on both paths.

### Pi rides the RPC pipeline, not the turn seam

Pi is omp's ancestor: `pi --mode rpc` speaks the same NDJSON dialect
(`prompt` / `steer` / `follow_up` / `abort` / `get_state` / `set_model` /
`fork` / `compact` / …) and writes the same v3 session `.jsonl`, so the pi
adapter has **no `createSession`** — it describes its CLI with an
`RpcUiSpawn` descriptor (`lib/harness/types.ts`) and reuses rpc-manager's
whole live pipeline: streaming, steering, abort, images, resume. The
descriptor states the real differences as data:

- **No `--cwd` flag** — pi silently swallows unknown flags, so the launch
  omits it and the spawn cwd carries the workspace.
- **Resume is `--session <path>`** — pi's own `--resume` is a boolean
  interactive picker; passing a path after it would become a literal prompt.
- **No ready frame** — pi prints nothing at startup, so readiness is
  `"first-response"`: `RpcProcess` writes a `get_state` immediately (it waits
  in the pipe buffer until pi attaches its stdin reader) and the response is
  the ready signal.
- **A hard command allowlist** — pi answers unknown RPC commands with an
  ID-LESS error response that can never settle the pending request, i.e. a
  silent hang. `AgentSessionWrapper` rejects anything outside the descriptor's
  `commands` set Cody-side with the `unsupported` code the UI already
  tolerates, and never sends the omp-only startup commands
  (`set_subagent_subscription`, `set_host_tools`).
- **Version on stderr** — `pi --version` prints to stderr; the probes in
  `engine-bin.ts` accept either stream on a clean exit.
- **Lazy persistence** — pi writes the session file only once the first
  assistant message exists, so a brand-new pi session appears in the sidebar
  after its first completed turn, not at creation.

Session listing follows the ACTIVE engine's `getSessionsDir()`
(`~/.pi/agent/sessions` vs `~/.omp/agent/sessions`; both honor
`PI_CODING_AGENT_DIR`, an env name omp kept from its pi ancestry), and
Cody's session reader parses pi transcripts as the "old pi files" it always
tolerated.

What pi serves is flagged per surface, not as one bundle:

- **`chatExtras: true`** — steer/follow-up, composer model switching,
  thinking levels, fork, compaction, branch navigation and the history/HTML
  export all work: the RPC commands exist in pi's dialect and the
  file-level surfaces work because pi writes real v3 transcripts (which is
  exactly what the turn engines lack).
- **`fastMode` / `advisor` / `subagents`: false** — omp protocol extras
  (`set_fast_mode`, `--advisor`, `get_subagents` + subagent frames) split out
  of chatExtras so pi's true surface can be stated. The fast-mode tier match
  would otherwise light up for pi's Anthropic models and the toggle would
  fail against the vocabulary gate.
- **`skills: true`** — `lib/skills-service.ts` scans pi's OWN discovery
  roots (`<cwd>/.pi/skills`, `.agents/skills` walked up to the git root,
  `<agent dir>/skills`, `~/.agents/skills` — no .claude/.codex/.github
  compat dirs, no managed-skills), pi honors `disable-model-invocation`, and
  Cody's installer writes `.agents/skills`, which pi loads. The Extensions &
  Tools group shows with just the sub-panels the engine serves.
- **`models: false`** but the composer model list works: `/api/models` runs
  `get_available_models` on a sessionless utility child of the ACTIVE engine
  (`utilityRpcLaunchFor`), keyed per engine in cache and in the shared
  process. pi's catalog is auth-gated by design — it lists models for
  providers with configured keys (env or its auth.json), the same set its
  own `/model` picker offers — and reasoning models get the dialect's global
  thinking levels, since pi's catalog carries no per-model efforts. Provider
  login state (`get_login_providers`) is omp-only and skipped.
- **`nativeSettings: true`** — pi's settings panel is derived from pi, like
  every other engine's. It has no settings schema and no config CLI, but the
  npm tarball ships `docs/settings.md`: every setting with its type, its
  default and a sentence of description, in regular four-column markdown
  tables under `###` headings. `lib/harness/pi-settings.ts` parses THAT at
  runtime, out of the installed package (found by walking up from the
  resolved `pi` binary to the `@mariozechner/pi-coding-agent` manifest — by
  NAME, because omp is a fork of the same package name-stem installed into a
  sibling directory), and writes back to `<pi agent dir>/settings.json`. So a
  setting pi adds upstream appears in the panel the moment the user updates
  pi, with no Cody release — the same property omp's schema and Hermes'
  DEFAULT_CONFIG give, from the only place pi states its whole surface. The
  alternative, `dist/core/settings-manager.js`, carries the same defaults in
  imperative code with no types, descriptions or grouping, which would have
  bought a hand-written key list dressed up as a pipeline.
  Because the source is prose, every step fails soft: a row that yields no
  renderable type is skipped, a missing docs file answers `schema: null` with
  a reason the panel prints, and the two documented types Cody has no control
  for — `object` (`thinkingBudgets`) and a bare `array` whose entries may be
  objects (`packages`) — are left out rather than rendered as a control that
  would destroy them on save. Writes are read → mutate → write the WHOLE
  object, so those keys and anything a newer pi added survive; dotted keys
  (`compaction.enabled`) persist nested, a `null` patch entry removes the
  override and prunes the parent it emptied, and the file's existing mode and
  trailing newline are preserved. Values are read from the GLOBAL file only —
  pi also merges a project `.pi/settings.json` over it, and that belongs to
  the repo, not the instance. Keys that only dress pi's TUI (`theme`,
  `quietStartup`, `editorPaddingX`, `terminal.*`, …) carry the existing
  `terminalOnly` chip rather than being hidden, because the same file drives
  the `pi` a user runs in a Cody terminal.
- **`configEditor: false`** — that flag is Cody's HAND-BUILT editors for
  omp's `config.yml`, which pi neither has nor reads. pi is now the engine
  that proves the two flags are different questions.
- **`mcp` / `plugins` / `updates`: false** — pi has no MCP, no plugin CLI
  Cody can drive, and updates ride the engine card's npm reinstall.

## The seam: `lib/harness/`

- `types.ts` — the contract. `HarnessAdapter`: identity (id / display name /
  tagline / binary name), `installSpec` + `authHint` for the picker,
  binary resolution + version probing, directory layout,
  `HarnessCapabilities` flags (liveSessions, models, skills, plugins, mcp,
  nativeSettings, updates, chatExtras), and exactly one live-chat shape:
  `createSession` — the factory an ACP or per-turn engine returns a session
  from — or `rpcUi`, the `RpcUiSpawn` descriptor for engines that speak the
  pi/omp RPC dialect.
  `EngineSession` is the session surface the app consumes; omp's
  `AgentSessionWrapper` satisfies it structurally. `settings` is the
  schema-driven settings pipeline (`EngineSettingsSurface`:
  `readSchema()` → `{path, schema, values, reason?}`, `write(patch)` →
  `{written, rejected, values}`), present exactly when `nativeSettings` is
  true — see below.
- `index.ts` — the registry and `getHarness()`: persisted selection →
  `CODY_HARNESS` → omp. `selectHarness()` persists a switch.
- `state.ts` — `cody-engine.json` persistence (active engine + onboarded).
- `omp.ts` / `pi.ts` / `claude.ts` / `codex.ts` / `hermes.ts` — the adapters.
- `pi-settings.ts` / `hermes-settings.ts` — the two derived settings
  pipelines behind `HarnessAdapter.settings` (pi from its shipped
  `docs/settings.md`, Hermes from its Python `DEFAULT_CONFIG` written through
  `hermes config`); omp's hangs off `lib/omp/settings-schema` +
  `settings-values`, imported by `omp.ts`, which is the one adapter allowed
  to reach into `lib/omp` (`lib/architecture.test.mjs`).
- `acp-session.ts` — `AcpEngineSession`, the engine-neutral Agent Client
  Protocol client: one long-lived stdio JSON-RPC server per session, driven
  from an `AcpEngineSpec` (binary, argv, env, MCP servers, setup hint). It
  names no engine — an engine-specific fact (where the agent hides the real
  tool name, which MCP servers to attach) reaches it as spec DATA. Hermes
  speaks ACP natively; Claude Code and Codex ride it through the
  `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`
  adapters, since neither CLI has an ACP mode of its own.
  What a session can switch is captured at `session/new` and reported as
  DATA on `get_state`: models (`availableModels`, `modelSelectable`) and
  modes (`availableModes`, `currentModeId` — Claude's Manual / Accept edits /
  Plan / Auto, Hermes' Default / Accept Edits / Don't Ask; Codex publishes
  none). `set_model` and `set_mode` switch them; `config_update` and
  `mode_changed` report the agent's own switches back.
- `provider-catalog.ts` / `provider-keys.ts` — provider API keys as
  Cody-level state: a 0600 JSON store in the instance data dir, entered once
  in Settings → API Keys & Providers and handed to EVERY engine child process
  through `engineChildEnv()` (rpc-ui spawn, ACP spawn, terminal). Every engine
  reads credentials from its environment, so one key works under all of
  them, and a spec's own entries still win (`CLAUDE_CODE_EXECUTABLE`,
  `CODEX_PATH`).
- `turn-session.ts` — `TurnEngineSession`, the shared one-process-per-turn
  base for CLIs that offer nothing better; `claude-stream.ts` translates the
  CLI's NDJSON into the pi event vocabulary (`agent_start`, `message_*`,
  `tool_execution_*`, `agent_end`, `notice`). **No engine rides this today** —
  Claude Code was the last and moved to ACP. Both modules survive only because
  `EngineCommandError` lives here; retiring them means rehoming that class
  first.
- `engine-transport.test.mjs` / `../../scripts/engine-bringup.mjs` — which
  engine rides which transport, pinned; and whether an installed engine
  actually comes up (`initialize` + `session/new` for ACP, `--mode` +
  `get_state` for rpc-ui). Neither needs credentials.
- `engine-sessions.ts` — the session index sidecar for engines that own
  their transcripts (`cody-engine-sessions.json`).
- `engine-bin.ts` / `install.ts` — binary probing, on-demand npm install
  into the tools prefix, and uninstall from it.
- `../display/engine-tools.ts` — display-tool launch descriptors for engines
  that speak MCP: `claudeDisplayMcpConfig()` (JSON for `--mcp-config`) and
  `displayMcpAcpServer()` (an ACP `McpServerStdio` for a session's
  `mcpServers`), both wrapping `createDisplayMcpLaunch()` (bundled
  `bin/cody-display-mcp.js` + internal endpoint + session-scoped capability
  token). Minting that token needs the running server's display origin and
  secret, so the ACP builder THROWS without them — an adapter's `mcpServers`
  hook catches it and returns an empty list, because a missing Preview button
  must not become a session that will not open.
- API: `GET /api/engines`, `POST /api/engines/select`,
  `POST /api/engines/install`, `DELETE /api/engines/install` (admin-only
  mutations).

A capability that is `false` hides its UI surface — settings tabs, panel
cards and composer affordances — rather than breaking it. Commands an engine
cannot serve fail soft with the `unsupported` error code the UI already
tolerates.

### Proving a turn without credentials

`scripts/mock-model-server.mjs` is a credential-free provider: OpenAI chat
completions (streamed and not), the Responses API, Anthropic Messages, plus
`/models` and `count_tokens`, answering every prompt with a reply that
contains `MOCK-TURN-OK`. Point an engine at it and `scripts/engine-turn-check.mjs`
drives a real turn through a running Cody instance's HTTP API — select the
engine, `POST /api/agent/new`, follow the event stream, then check the marker
reached the reply, the transcript and the session list. This is how every
engine in the roster was proved end to end for the release that added it,
and it is what to run after touching a transport. The per-engine wiring:

- **omp** — a provider in `models.yml` (`baseUrl`, `api: openai-completions`,
  any `apiKey`, one model); **pi** — the same shape in
  `<pi agent dir>/models.json`.
- **claude** — `ANTHROPIC_BASE_URL` in the environment.
- **codex** — `[model_providers.mock]` in `$CODEX_HOME/config.toml` with
  `wire_api = "responses"` (`"chat"` is gone since Codex 0.153) and any
  `OPENAI_API_KEY`.
- **hermes** — the `openai-api` provider with `OPENAI_BASE_URL`, and
  `model.provider` / `model.default` set through `hermes config set`,
  because Hermes with keys but no provider silently defaults to OpenRouter.

### The settings route dispatches on the ADAPTER, never on an engine id

`GET`/`PUT /api/omp-settings/schema` is engine-neutral by construction: it
gates on `requireCapability("nativeSettings")`, then reads
`harness.settings` and refuses `unsupported` when there is none. It used to
switch on ids — `active.id === "hermes" ? hermesBranch : ompBranch` — which
quietly made "no branch of mine" mean "omp's branch", and that default is
what the id-switch always costs: an engine with no case got omp's ~550-key
schema and omp's `config.yml` back under its own name, and its `PUT` wrote
omp's `config.yml` while another engine was active, reporting success. An
adapter hook cannot do that. Adding a settings pipeline to a new engine is
now: implement `EngineSettingsSurface`, hang it off the adapter, flip
`nativeSettings`. The JSON the route serves is fixed by the panel
(`components/settings/OmpSchemaSettings.tsx`) and pinned by
`lib/engine-route-guards.test.mjs`:
`{path, harness:{id,shortName}, host:{platform}, schema, values}`, or
`schema: null` plus a `reason` when the engine's declaration cannot be read —
which is an answer, not an error, since it is also what an engine that is
simply not installed yet looks like.

### omp's RPC framing is asymmetric — and images pay for it

omp's rpc-ui transport is NDJSON over stdio, one JSON object per line, capped at
1 MiB per line (`MAX_RPC_FRAME_BYTES` in `lib/omp/rpc-frame.ts`). Protocol v2
adds `rpc_chunk` records for frames above that cap, but **only in the omp → Cody
direction**: omp's own stdin reader
(`packages/coding-agent/src/modes/rpc/rpc-input.ts`) parses each line as a
complete command and has no chunk reassembly. A chunked command therefore lands
as an unknown, id-less line, the real command never materializes, no response is
ever produced, and — since `sendCommand` has no default timeout — the HTTP POST
behind it hangs forever while the chat sits on "Waiting for model…". So Cody
keeps the inbound decoder (big tool results genuinely arrive chunked) and never
chunks outbound: `encodeOutboundRpcFrame` rejects an oversized frame with
`RpcCommandError(code: "frame_too_large")`, which the agent route maps to a 400
and the composer shows as a dismissible banner.

That 1 MiB ceiling is also why `lib/image-compress.ts` exists. An attached image
travels as base64 *inside* the prompt command — omp's `ImageContent` is
`{type, data, mimeType}`, with no file-path alternative — so a phone photo
(3–8 MB, i.e. 4–11 MB base64) could never be delivered as-is. The composer
passes anything ≤600 KB of base64 through untouched (screenshots stay crisp) and
otherwise downscales to 2048px and re-encodes JPEG down a quality ladder, then
1568px, until it fits; a message whose assembled frame would still exceed
~900 KB is refused in the composer, naming the attachment to remove, rather than
being bounced by the transport. Host-tool results (a `preview_screenshot`
image, say) ride the same one-line limit, and there is no pending command to
reject — so `rpc-manager` measures every `host_tool_result` before writing it
(`guardHostToolResultFrame`) and, when it would not fit, sends a small error
result with the SAME call id instead. The engine's tool call then completes
with an honest failure rather than waiting forever on a dropped frame.
Screenshots avoid that path in the first place by capturing down a
format/size ladder (`lib/preview-screenshot.ts`).

## Adding an engine, concretely

1. Implement `HarnessAdapter` in `lib/harness/<id>.ts`; register it in
   `lib/harness/index.ts`.
2. Set capability flags honestly — every `false` hides its surface.
3. Pick a transport, in this order:
   - **ACP** if the engine (or an adapter for it) speaks the Agent Client
     Protocol — the richest of the three and the only one with an approval
     channel. It costs an `AcpEngineSpec`, no new class: that is all Hermes
     and Codex needed. Record it in `lib/harness/engine-transport.test.mjs`.
   - **rpc-ui** if it speaks the pi/omp RPC dialect — the full live pipeline
     for the cost of an `RpcUiSpawn` descriptor, which is all Pi needed.
   - **Per turn** only if neither applies: write a translator
     (`<id>-stream.ts`) and reuse `TurnEngineSession`.
   If the engine ships as an adapter plus a separate CLI, say so in the
   adapter — `installAlso`, `skipNativeOptional`, `engineEnv()`, `cliArgs`,
   `healthArgs` and `engineCli` exist for exactly that shape, and `codex.ts`
   is the worked example. `engineCli` is the one that keeps the UPDATE path
   honest: it names which `installAlso` package is the engine CLI, how to read
   the version of the CLI that will actually run, and what to call each half
   on screen. Without it the card shows the ADAPTER's version under the
   engine's name, and the update check compares only the adapter — so a CLI
   twenty releases behind reads as "up to date", forever, because the adapter
   it sits under was already current.
4. Give it `installSpec`/`authHint` so the picker can install and explain it.
5. If the engine declares its own settings anywhere Cody can read at runtime
   — a schema, a defaults table, a documented settings file — implement
   `HarnessAdapter.settings` (`EngineSettingsSurface`) and flip
   `nativeSettings`. That is the whole cost of the settings panel; the route
   dispatches on the hook and names no engine. Derive it, never hand-list
   it: the point is that a setting added upstream appears when the user
   updates the engine. `hermes-settings.ts` and `pi-settings.ts` are the two
   worked examples of deriving one from something that is not a schema.
6. Wire the display tool so the engine can open Cody's Preview panel.
   Two existing shapes:
   - **Host tool** (omp): if the engine has a host-tool channel, register a
     Cody-owned `open_preview` tool at session start (omp uses
     `set_host_tools` in `lib/rpc-manager.ts`) and route its tool call to
     `publishDisplayRequest()`.
   - **Stdio MCP** (every other engine): if the engine can load MCP servers,
     pass the bundled `bin/cody-display-mcp.js` via
     `lib/display/engine-tools.ts` — `displayMcpAcpServer(id)` from an ACP
     adapter's `mcpServers` hook (see `claude.ts` / `codex.ts`), or
     `claudeDisplayMcpConfig(sessionId)` as a `--mcp-config` JSON blob on a
     per-turn CLI's argv (`turn-session.ts`, which no engine uses now). The
     ACP descriptor must carry NO `type` field: adapters discriminate a stdio
     server by its absence and silently ignore one that has it. The MCP server
     posts to `/api/internal/display` with the capability token minted per
     session — no Cody cookie needed.
   Either shape only publishes a loopback URL — an engine never picks how the
   preview renders. Cody resolves that URL into a ranked `candidates` list
   (direct real-origin iframe, then the `CODY_PREVIEW_BASE_URL` gateway, then
   the raster stream as the guaranteed floor) and the client takes the best
   rung that works.
7. Run the suite: `npm run typecheck && npm run lint && npm test`.

Cursor, Kilo Code, Cline and friends are all candidates — anything with
a headless mode and a session-resume story fits the same mold.

## Packaging with an engine

The Docker image under `docker/` ships **no engine at all** — bring your
own. Every engine, omp included, installs at runtime from the onboarding
picker (or Settings → User Accounts → Agent engine) into the persistent
tools prefix, and updates independently of the Cody image via the same
card's Update action. The image only carries the runtimes engines need
(Node, and Bun for omp).
