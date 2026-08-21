# Cody and agent engines

Cody is the IDE; the coding agent underneath it — the **engine** — is
swappable. The same UI ships with [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi)
as its founding, fully-featured engine, and can drive
[Pi](https://pi.dev) (omp's ancestor, over its native RPC mode),
[Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) or
[Codex](https://www.npmjs.com/package/@openai/codex) as experimental engines
today. New engines are added by implementing one adapter — the UI, accounts,
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
prefix → `PATH`.

### Experimental engines, honestly

Claude Code and Codex run **one CLI process per turn** (`claude -p
--output-format stream-json`, `codex exec --json`), translated server-side
into the event stream the UI renders. That buys a plain, reliable chat:
prompt, streamed reply, tool activity, abort. What it does not buy (yet):
forking, compaction, thinking levels, model switching from the composer,
skills/plugins/MCP management, transcript replay across server restarts, or
the agent-callable host tools (`open_file` / `open_url` / `notify` /
`preview_screenshot` / `read_app_logs` — omp's rpc-ui bridge; `open_preview`
still works via the bundled display MCP server, loopback URLs in assistant
replies still auto-open the Preview panel on every engine, and the Preview
panel's capture button screenshots the app server-side regardless of
engine) — those surfaces hide automatically via capability flags. Both engines run
non-interactively with edits auto-accepted inside the workspace (there is no
approval channel in their non-interactive modes) — treat the workspace as
theirs while a turn runs.

Authentication belongs to the engine, not Cody: run `claude` or
`codex login` once in a Cody terminal (credential state lives under the
container's persistent HOME), or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
on the container. Codex can also target local models (`--oss`,
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
tolerated. Everything else (models registry, skills, plugins, MCP, native
settings, updates) is capability-gated off.

## The seam: `lib/harness/`

- `types.ts` — the contract. `HarnessAdapter`: identity (id / display name /
  tagline / binary name), `installSpec` + `authHint` for the picker,
  binary resolution + version probing, directory layout,
  `HarnessCapabilities` flags (liveSessions, models, skills, plugins, mcp,
  nativeSettings, updates, chatExtras), and exactly one live-chat shape:
  `createSession` — the factory for turn-based engines — or `rpcUi`, the
  `RpcUiSpawn` descriptor for engines that speak the pi/omp RPC dialect.
  `EngineSession` is the session surface the app consumes; omp's
  `AgentSessionWrapper` satisfies it structurally.
- `index.ts` — the registry and `getHarness()`: persisted selection →
  `CODY_HARNESS` → omp. `selectHarness()` persists a switch.
- `state.ts` — `cody-engine.json` persistence (active engine + onboarded).
- `omp.ts` / `pi.ts` / `claude.ts` / `codex.ts` — the adapters.
- `turn-session.ts` — `TurnEngineSession`, the shared one-process-per-turn
  base; `claude-stream.ts` / `codex-stream.ts` translate each CLI's NDJSON
  into the pi event vocabulary (`agent_start`, `message_*`,
  `tool_execution_*`, `agent_end`, `notice`).
- `engine-sessions.ts` — the session index sidecar for engines that own
  their transcripts (`cody-engine-sessions.json`).
- `engine-bin.ts` / `install.ts` — binary probing, on-demand npm install
  into the tools prefix, and uninstall from it.
- `../display/engine-tools.ts` — display-tool launch configs for engines
  that speak MCP: `claudeDisplayMcpConfig()` (JSON for `--mcp-config`) and
  `codexDisplayMcpArgs()` (`-c` TOML overrides), both wrapping
  `createDisplayMcpLaunch()` (bundled `bin/cody-display-mcp.js` + internal
  endpoint + session-scoped capability token).
- API: `GET /api/engines`, `POST /api/engines/select`,
  `POST /api/engines/install`, `DELETE /api/engines/install` (admin-only
  mutations).

A capability that is `false` hides its UI surface — settings tabs, panel
cards and composer affordances — rather than breaking it. Commands an engine
cannot serve fail soft with the `unsupported` error code the UI already
tolerates.

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
3. If the engine's CLI can run a turn non-interactively with streamed JSON
   output, write a translator (`<id>-stream.ts`) and reuse
   `TurnEngineSession` — that is all Claude Code and Codex needed. An engine
   speaking the pi/omp RPC dialect gets the full live pipeline for the cost
   of an `RpcUiSpawn` descriptor — that is all Pi needed. Anything else with
   a persistent RPC mode can implement `EngineSession` directly.
4. Give it `installSpec`/`authHint` so the picker can install and explain it.
5. Wire the display tool so the engine can open Cody's Preview panel.
   Two existing shapes:
   - **Host tool** (omp): if the engine has a host-tool channel, register a
     Cody-owned `open_preview` tool at session start (omp uses
     `set_host_tools` in `lib/rpc-manager.ts`) and route its tool call to
     `publishDisplayRequest()`.
   - **Stdio MCP** (Claude Code / Codex): if the engine can load MCP servers,
     pass the bundled `bin/cody-display-mcp.js` via
     `lib/display/engine-tools.ts` — `claudeDisplayMcpConfig(sessionId)` as a
     `--mcp-config` JSON blob, or `codexDisplayMcpArgs(sessionId)` as `-c`
     TOML args (see `claude-stream.ts` / `codex-stream.ts` /
     `turn-session.ts`). The MCP server posts to `/api/internal/display`
     with the capability token minted per session — no Cody cookie needed.
   Either shape only publishes a loopback URL — an engine never picks how the
   preview renders. Cody resolves that URL into a ranked `candidates` list
   (direct real-origin iframe, then the `CODY_PREVIEW_BASE_URL` gateway, then
   the raster stream as the guaranteed floor) and the client takes the best
   rung that works.
6. Run the suite: `npm run typecheck && npm run lint && npm test`.

Cursor, Kilo Code, Cline and friends are all candidates — anything with
a headless mode and a session-resume story fits the same mold.

## Packaging with an engine

The Docker image under `docker/` ships **no engine at all** — bring your
own. Every engine, omp included, installs at runtime from the onboarding
picker (or Settings → User Accounts → Agent engine) into the persistent
tools prefix, and updates independently of the Cody image via the same
card's Update action. The image only carries the runtimes engines need
(Node, and Bun for omp).
