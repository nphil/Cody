# Cody and agent engines

Cody is the IDE; the coding agent underneath it — the **engine** — is
swappable. The same UI ships with [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi)
as its founding, fully-featured engine, and can drive
[Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) or
[Codex](https://www.npmjs.com/package/@openai/codex) as experimental engines
today. New engines are added by implementing one adapter — the UI, accounts,
terminals, git surface, files, checkpoints and themes all stay.

## Picking an engine

- **Onboarding**: on a fresh instance, the first admin sees a full-screen
  engine picker right after signing in. Picking one persists the choice and
  the picker never returns.
- **Settings → User Accounts → Agent engine** (admins): shows every known
  engine with its install state, lets you install missing ones and switch the
  active engine. Switching restarts live agent sessions; chat history and
  workspace files are untouched.
- Selection is stored in `cody-engine.json` in the instance data dir and wins
  over the `CODY_HARNESS` environment variable, which remains the deployment
  default for instances that never picked interactively.

Engines Cody installs from the picker land in a persistent npm prefix
(`CODY_TOOLS_DIR`, default `<data dir>/tools`) so they survive container
image updates. Binaries are resolved per engine: `CODY_OMP_BIN` /
`CODY_CLAUDE_BIN` / `CODY_CODEX_BIN` override → tools prefix → `PATH`.

### Experimental engines, honestly

Claude Code and Codex run **one CLI process per turn** (`claude -p
--output-format stream-json`, `codex exec --json`), translated server-side
into the event stream the UI renders. That buys a plain, reliable chat:
prompt, streamed reply, tool activity, abort. What it does not buy (yet):
forking, compaction, thinking levels, model switching from the composer,
skills/plugins/MCP management, transcript replay across server restarts, or
the agent-callable host tools (`open_file` / `open_url` / `open_preview` /
`notify` — omp's rpc-ui bridge; loopback URLs in assistant replies still
auto-open the Preview panel on every engine) — those surfaces hide
automatically via capability flags. Both engines run
non-interactively with edits auto-accepted inside the workspace (there is no
approval channel in their non-interactive modes) — treat the workspace as
theirs while a turn runs.

Authentication belongs to the engine, not Cody: run `claude` or
`codex login` once in a Cody terminal (credential state lives under the
container's persistent HOME), or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
on the container. Codex can also target local models (`--oss`,
`model_provider` overrides in its own config), and omp's model registry
supports custom providers — local inference stays reachable on both paths.

## The seam: `lib/harness/`

- `types.ts` — the contract. `HarnessAdapter`: identity (id / display name /
  tagline / binary name), `installSpec` + `authHint` for the picker,
  binary resolution + version probing, directory layout,
  `HarnessCapabilities` flags (liveSessions, models, skills, plugins, mcp,
  nativeSettings, updates, chatExtras), and `createSession` — the live-chat
  factory for engines that do not speak omp's rpc-ui protocol.
  `EngineSession` is the session surface the app consumes; omp's
  `AgentSessionWrapper` satisfies it structurally.
- `index.ts` — the registry and `getHarness()`: persisted selection →
  `CODY_HARNESS` → omp. `selectHarness()` persists a switch.
- `state.ts` — `cody-engine.json` persistence (active engine + onboarded).
- `omp.ts` / `claude.ts` / `codex.ts` — the adapters.
- `turn-session.ts` — `TurnEngineSession`, the shared one-process-per-turn
  base; `claude-stream.ts` / `codex-stream.ts` translate each CLI's NDJSON
  into the pi event vocabulary (`agent_start`, `message_*`,
  `tool_execution_*`, `agent_end`, `notice`).
- `engine-sessions.ts` — the session index sidecar for engines that own
  their transcripts (`cody-engine-sessions.json`).
- `engine-bin.ts` / `install.ts` — binary probing and on-demand npm install
  into the tools prefix.
- API: `GET /api/engines`, `POST /api/engines/select`,
  `POST /api/engines/install` (admin-only mutations).

A capability that is `false` hides its UI surface — settings tabs, panel
cards and composer affordances — rather than breaking it. Commands an engine
cannot serve fail soft with the `unsupported` error code the UI already
tolerates.

## Adding an engine, concretely

1. Implement `HarnessAdapter` in `lib/harness/<id>.ts`; register it in
   `lib/harness/index.ts`.
2. Set capability flags honestly — every `false` hides its surface.
3. If the engine's CLI can run a turn non-interactively with streamed JSON
   output, write a translator (`<id>-stream.ts`) and reuse
   `TurnEngineSession` — that is all Claude Code and Codex needed. An engine
   with a persistent RPC mode comparable to omp's can implement
   `EngineSession` directly instead.
4. Give it `installSpec`/`authHint` so the picker can install and explain it.
5. Run the suite: `npm run typecheck && npm run lint && npm test`.

Cursor, Kilo Code, Cline, Pi and friends are all candidates — anything with
a headless mode and a session-resume story fits the same mold.

## Packaging with an engine

The Docker image under `docker/` ships **no engine at all** — bring your
own. Every engine, omp included, installs at runtime from the onboarding
picker (or Settings → User Accounts → Agent engine) into the persistent
tools prefix, and updates independently of the Cody image via the same
card's Update action. The image only carries the runtimes engines need
(Node, and Bun for omp).
