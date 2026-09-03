# Cody - Development Notes

> Owner workflow preferences (release discipline, delegation/token strategy,
> deployment context) live in **CLAUDE.md**; this file is the codebase map.

## Git Workflow (project rule)

`main` is the only long-lived branch and is always the latest, up-to-date state.
Commit and push directly to `main` — do not open feature branches, and delete any
that appear once their work is merged. Keep the branch list clean: `main` locally,
`origin/main` remotely, nothing else.

## Quick Start

```bash
npm run dev   # port 30178
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

The dev server needs the `omp` binary installed (on `PATH`, or set `CODY_OMP_BIN`).
All live-agent features go through it; session browsing works without it.

## Improving Cody with Cody (self-development)

Cody is developed through Cody: the agent reading this may be running inside
the app it is editing, with Cody's host tools available (`open_preview`,
`preview_screenshot`, `read_app_logs`) to see and verify its own work. This is
intended — use it. The playbook, including the do-not-kill-your-own-session
rule and how to verify on an isolated second instance, is the committed skill
`.claude/skills/improving-cody/SKILL.md` (discovered by Claude Code natively
and by omp via its `.claude` compat provider). Priorities when changing this
codebase: stability first (every push to `main` is a release), then
robustness, then flexibility — never bind engine-neutral code to one engine.

---

## Architecture

Cody never imports `@oh-my-pi/*` or `@earendil-works/*` packages (they are
Bun-only and cannot run inside Node/Next). See `DESIGN.md` for the full porting
contract.

```
Browser                Next.js Server                    omp child process
  │                        │                                    │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/       │
  ├─ GET /api/sessions/[id] reads .jsonl file directly          │
  ├─ GET /api/agent/running/events ───▶ running id SSE          │
  │                        │                                    │
  ├─ send message ─────────▶ POST /api/agent/[id]               │
  │                        │   startRpcSession() ── spawn ─────▶│ omp --mode rpc-ui
  │                        │   sendCommand({type:"prompt"}) ───▶│ (NDJSON stdio)
  │                        │                                    │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events         │
  │                        │   onFrame() ◀── event frames ──────│
  │◀── data: {...} ─────────│                                    │
```

**Session browsing** (read-only): pure-Node parsing of omp session `.jsonl`
files via `lib/session-reader.ts` — no child process involved.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` spawns
`omp --mode rpc-ui` (one process per active session) through
`lib/omp/rpc-process.ts`.

Shared foundations in `lib/omp/`:

- `paths.ts` — Node port of omp's directory resolution (`~/.omp/agent`,
  profiles, XDG, session dir slugs).
- `omp-cli.ts` — locate/probe the installed `omp` binary (`resolveOmpBin`,
  `getOmpVersion`).
- `rpc-process.ts` — process + NDJSON protocol layer (`RpcProcess`).

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  sessions/[id]/media/route.ts    GET one deferred tool-result image's bytes
  preview/screenshot/route.ts     POST server-side screenshot of a loopback URL
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any RPC command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  agent/[id]/display/route.ts     POST publish a display request | GET latest (auth-gated)
  agent/[id]/display/events/route.ts GET SSE stream of display requests (snapshot + live)
  internal/display/route.ts       POST publish from engine MCP servers (capability-token auth)
  auth/**                         omp's provider list + login flow (via RPC); every
                                   route refuses `unsupported` unless omp is active
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  git/status/route.ts             GET repo status + branch/ahead-behind for a cwd
  git/diff/route.ts               GET one file's HEAD->worktree patch
  info/route.ts                   GET server facts for the Info panel
  tasks/route.ts                  GET .cody/tasks.json (validated)
  tasks/run/route.ts              POST run a task by id into a new terminal
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel, catalogSource }
                                   dispatches on the active engine: an rpc-dialect
                                   engine's own sessionless catalog, or an empty
                                   `catalogSource:"session"` answer for ACP engines,
                                   whose models live in the session's get_state
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml (omp only)
  models-config/test/route.ts     POST test a configured model/provider (omp only)
  omp-settings/route.ts           GET/PUT omp's OWN config.yml — `configEditor`,
                                   not `nativeSettings`: Hermes and pi declare the
                                   latter for their OWN schema panels and must not
                                   land here
  omp-settings/schema/route.ts    GET the ACTIVE engine's own settings schema +
                                   values; PUT a dotted-path patch. Engine-NEUTRAL:
                                   it dispatches on HarnessAdapter.settings and
                                   refuses `unsupported` when an engine has none —
                                   never on an engine id (omp/Hermes/pi today)
  mcp/route.ts                    GET/POST/PUT/DELETE project MCP servers
  memory/route.ts                 GET the active engine's persistent memory, read-only
                                   (400 `unsupported` unless capabilities.memory)
  provider-keys/route.ts          GET the provider-key catalogue for the active
                                   engine with stored/fromEnvironment flags (never
                                   values); PUT {name,value} (admin) stores or clears
                                   one — every engine, no capability gate
  plugins/route.ts                GET/POST plugin management (shells out to `omp plugin`)
  plugins/marketplace/route.ts    GET browse configured marketplaces + catalogs | POST
                                   add/remove/update marketplace, install/uninstall/upgrade
  projects/route.ts               GET registered+discovered projects | POST add | DELETE hide
  skills/route.ts                 GET loaded skills + surface flags | PATCH enable/disable
                                  (frontmatter for omp/pi, config.yaml for Hermes)
  skills/install/route.ts         POST install through the active engine's own
                                  installer (npx skills add / hermes skills install)
  skills/store/route.ts           GET browse/search/detail | POST card descriptions (skills.sh registry)
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  omp/                 shared omp foundations (paths, CLI probe, RpcProcess,
                        marketplace.ts pure-Node catalog reader, plugin-cli.ts
                        shared `omp plugin` execFile/JSON helpers)
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  context-usage.ts     derives idle/reconnect gauge usage from persisted messages
  env.ts               readEnv(): CODY_* config with OMP_WEB_* fallback
  display/             universal display/preview surface:
    types.ts           DisplayRequestV1 + DisplayCandidate + bus event types
    validation.ts      loopback-only http(s) URL normalization (rejects credentials)
    bus.ts             globalThis per-session latest+listeners; publish/subscribe/alias
    capability.ts      HMAC session-scoped tokens (CODY_INTERNAL_DISPLAY_SECRET/ORIGIN)
    provider.ts        RasterWebProvider: puppeteer-core + system Chromium → JPEG WS stream
    native-gateway.ts  candidate ranking; optional CODY_PREVIEW_BASE_URL
                       wildcard-subdomain reverse proxy
    engine-tools.ts    bundled display-MCP launch descriptors: --mcp-config JSON for a
                       per-turn CLI, an ACP McpServerStdio for an ACP session
    access.ts          authorizeDisplaySession(): request auth for display routes
    csp.ts             buildContentSecurityPolicy(): loopback + this host's
                       private LAN/CGNAT frame-src/connect-src for proxy.ts
  engine-guard.ts      requireEngine()/requireCapability(): the SERVER half of the
                       capability rule. An omp-only route (models.yml, model roles,
                       config.yml, `omp usage`, agent.db credentials, session
                       import/archive/export) refuses 400 `unsupported` under any
                       other engine instead of answering with omp's data
  file-access.ts       allowed file roots for /api/files and worktrees
  harness/             pluggable engine seam: adapters (omp/pi/claude/codex/hermes),
                       runtime selection state, three transports (rpc-ui, ACP,
                       per-turn), session index, binary probe + on-demand install
                       (docs/harnesses.md)
    pi-settings.ts     pi's settings, derived from the settings TABLES in the
                       installed pi package's own docs/settings.md (parsed at
                       runtime, failing soft) and written back to
                       <pi agent dir>/settings.json — the read/write half of
                       pi's HarnessAdapter.settings
    hermes-settings.ts the same for Hermes, from its Python DEFAULT_CONFIG,
                       written through `hermes config`
    provider-catalog.ts the provider → environment-variable catalogue
                       (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY,
                       AWS_* for Bedrock, …) with the engines each provider is
                       offered on; `providersForEngine()` picks the subset
    provider-keys.ts   Cody-level provider credentials: a 0600 JSON store in the
                       instance data dir and `engineChildEnv()`, the ONE place
                       every engine child process (rpc-ui, ACP, terminal) gets
                       its environment from, so a key entered once works under
                       every engine
    cli-login.ts       runCliLogin(): drives an engine's OWN login command in a
                       node-pty (URL out, pasted code in, device code shown) —
                       the shared driver behind claude-login / codex-login /
                       hermes-login
    claude-login.ts    `claude auth login` / `auth status` / `auth logout`
    codex-login.ts     `codex login --device-auth` / `login status` / `logout`
    hermes-login.ts    `hermes auth add <provider> --type oauth` / `auth list`
                       / `auth logout`
    pi-login.ts        pi's pi-ai OAuth flows, run in bin/cody-pi-login.mjs (a
                       child that imports the INSTALLED pi package) and bridged
                       over JSON lines
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  permission-request.ts pure client-side readers for an ACP engine's approval
                        requests: option/request parsing off the wire and off
                        get_state, plus the defensive ToolCallUpdate summary
  pi-types.ts          local structural types for agent/RPC objects
  preview-url.ts       loopback preview URL rules: normalize/extract/probe
  preview-autoopen.ts  when an assistant-mentioned URL auto-opens the Preview panel
  preview-screenshot.ts server-side headless-Chromium capture of loopback apps
  project-ordering.ts  pure project sort/group/activity helpers (client + tests)
  project-registry.ts  on-disk managed-project registry (~/.omp/agent/projects.json)
  provider-brand.ts    provider id → product brand + which vendored mark to draw;
                       modelBrand() reads the VENDOR off a model id so gateway rows
                       (one OpenRouter key, many vendors) don't all wear one mark
  rpc-manager.ts       session registry + startRpcSession over RpcProcess
  session-namer.ts     3-4 word model-written session names: a one-shot run of the
                       ACTIVE rpc-dialect engine (omp's `tiny` role only when omp
                       is that engine; null for ACP engines), plus the pure
                       normalizer that turns its answer into a name
  session-reader.ts    session .jsonl parsing + path cache + buildSessionContext
  skills-service.ts    pure-Node skill discovery mirroring the ACTIVE engine's
                       providers (omp's list, pi's narrower one, Hermes' nested
                       tree) + getSkillsSurface(): what the surface can do here
  engine-capabilities.ts  THE client read of /api/info: capability flags, the
                       active engine's identity and its version, memoized once
                       per page load. AppShell loads it and threads
                       `capabilities` / `engine` down as props; callers off
                       that path (engineSupports) share the same request
  skills-registry.ts   client for the public skills.sh registry endpoints (the
                       same ones `npx skills` uses): category browse, fuzzy/
                       semantic search, cached SKILL.md detail extraction
  storage-keys.ts      the cody: browser-storage namespace + legacy migration
                       + engineScopedKey(): the keys that must not survive an
                       engine switch (session ids, pinned models)
  stream-tuning.ts     tunable streaming pacing/motion params: defaults, clamping,
                       CSS-var diffing, localStorage store (playground: /dev/stream-tuner)
  workspace-tasks.ts   .cody/tasks.json schema validation + grouping
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  ComposerPanels.tsx  composer-attached todo + subagent panels (collapsible, live states)
  TodoList.tsx        todo phase grid with preview/show-all (used by ComposerPanels)
  SubagentTranscriptDialog.tsx  task + final output summary dialog (wide, screen-adaptive)
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  CommandPalette.tsx  ⌘K/Ctrl+K palette (cmdk): session switch, new session, theme
  ImageLightbox.tsx   click-to-preview lightbox for chat images (ClickableImage)
  BranchNavigator.tsx in-session branch switcher
  DiffView.tsx        folding unified-diff renderer (FileViewer + GitPanel)
  GitPanel.tsx        right-panel Git tool: changed files + diffs + branch info
  TasksPanel.tsx      right-panel Tasks tool: .cody/tasks.json runner
  PreviewPanel.tsx    right-panel Preview: walks the display candidate ladder —
                      direct/gateway iframe, else the streamed surface below —
                      plus clipboard/pop-out controls and manual URL mode
  StreamedDisplay.tsx streamed-rung client: display socket + canvas + input,
                      shared by PreviewPanel and the pop-out window route
  DisplayWindow.tsx   /display/<sessionId>: the streamed surface alone, full
                      viewport, no chat chrome
  InfoPanel.tsx       right-panel Info tool: versions + workspace diagnostics
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  PermissionRequestCard.tsx one approval an ACP engine is blocked on, rendered
                      inline at the live tail of the transcript (never a modal)
  ProviderIcon.tsx    vendored brand marks (models.dev logo set + simple-icons for
                      the few it stubs); ProviderIcon = a provider, ModelIcon = a
                      model's vendor. Never hotlinked — see the note below
  ModelsConfig.tsx    modal for models/auth configuration
  McpConfig.tsx       project MCP server editor (Settings → MCP tab)
  MemoryPanel.tsx     Settings → Agent Memory: the engine's own memory documents,
                      read-only, each with its path (capability-gated)
  ProviderSignInPanel.tsx Settings → API Keys & Providers, first block: the
                      ACTIVE engine's provider sign-in rows (/api/auth/providers),
                      Sign in / Re-login / Sign out, each expanding a
                      ProviderLoginFlow; rendered for every engine with
                      `providerLogin`, admin-only controls
  ProviderLoginFlow.tsx the one sign-in state machine (SSE frames → URL + paste
                      box, device code, prompt, progress, success/error), used
                      by ProviderSignInPanel, ModelsConfig's registry tree and
                      the setup wizard
  ProviderKeysPanel.tsx Settings → API Keys & Providers, top half: per-provider
                      key cards for the ACTIVE engine (masked input, Save /
                      Clear, "Saved in Cody" / "Set on the container" chips);
                      rendered for every engine, above omp's registry editor
  PluginsConfig.tsx   modal for installed plugins; opens PluginMarketplace
  PluginMarketplace.tsx marketplace dialog: browse/search/install across
                      configured `omp` marketplaces, manage marketplaces
                      (opened from PluginsConfig and the System & Updates card)
  SkillsConfig.tsx    modal for loaded/installable skills; opens SkillsStore
  SkillsStore.tsx     skill store dialog: skills.sh browse/search/detail/install
                      (opened from SkillsConfig and the System & Updates card)
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)
  ui/                 shared primitives: Dialog/Tooltip/Collapsible, fields, toast

hooks/
  useAgentSession.ts       messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts              completion sound + browser AudioContext unlock
  useDragDrop.ts           shared drag/drop state
  useDisplayRequests.ts    display-request SSE → snapshot/live request state
  useIsMobile.ts           responsive breakpoint hook
  usePrefersReducedMotion.ts OS reduce-motion preference (SMIL-safe)
  useStreamTuning.tsx      live StreamTuning: playground context override, else the stored value
  useTheme.ts              theme state: saved per account (/api/accounts/me) and mirrored in localStorage "cody:theme"; first visit follows prefers-color-scheme

bin/
  cody-server.js           custom server; also WS upgrade for /api/display/socket
                           (stream frames + input) and native-gateway host routing;
                           mints the display capability secret at boot
  cody-display-mcp.js      bundled stdio MCP server exposing open_preview to
                           Claude/Codex engines (posts to /api/internal/display)
  cody-session-tail.js     read-only live view of a chat session for the FIRST
                           web terminal of a workspace (spawned by
                           lib/terminal-manager.ts); renders + follows the
                           session .jsonl, never writes it, q/Ctrl+C drops to
                           the login shell
```

`desktop/` is a separate top-level tree, not part of the Next.js app above:
a Tauri 2 Rust shell over WebView2, running the server inside a dedicated
WSL2 distro flattened from this image. Own CI
(`.github/workflows/desktop.yml`); full architecture in `docs/windows.md`.

---

## User accounts & auth (`lib/auth/`)

Cody has app-level user accounts: a login screen (`/login`,
`components/LoginScreen.tsx`), signed-cookie sessions, per-account profiles
(Settings → User Accounts, the first tab), and per-account chat sessions.
Accounts are **identities, not OS users** — terminals and the harness run as
the container's single user regardless of who is signed in; `UserRecord.osUser`
is a reserved seam if per-uid isolation is ever wanted.

- `lib/auth/users.ts` — JSON store at `<agent dir>/cody-accounts/accounts.json`
  (override: `CODY_ACCOUNTS_DIR`), atomic 0600 writes, scrypt password hashes
  (`lib/auth/password.ts`, node:crypto only — no new dependency). The
  env-managed bootstrap account `cody` materializes whenever `CODY_PASSWORD`
  is set; its password lives in the environment, never in the store, and it is
  always an admin. First account ever created becomes the administrator.
- `lib/auth/session.ts` — stateless HMAC-signed cookie (`cody_session`,
  30 days). Secret persisted 0600 beside the store. Revocation = bump the
  user's `tokenVersion` (password changes do this).
- `lib/auth/guard.ts` — the one "who is this request" answer: cookie first,
  then HTTP Basic with `CODY_PASSWORD` (kept for scripts/healthcheck; resolves
  to the bootstrap account). **Auth is required iff a password is set or any
  account exists** — bare `npm run dev` stays open until the first account.
- `proxy.ts` — perimeter: unauthenticated HTML → redirect `/login`, API →
  401 JSON (deliberately no `WWW-Authenticate`: it would summon the browser's
  native dialog over the login screen). Public paths: `/login`,
  `/api/accounts/{state,login,signup}`, hashed `_next` assets. The WS upgrade
  gate in `bin/cody-server.js` accepts the same two credentials.
  The cross-site guard (`lib/request-security.ts`, applied to every route)
  rejects cross-site `fetch()`/XHR and non-GET navigations (form-post CSRF)
  but ALLOWS cross-site GET/HEAD navigations — links into Cody, the preview
  gateway's iframe, detach-to-tab. Navigating is how browsers arrive
  anywhere, mutating GETs are bugs by contract, and the SameSite=Lax session
  cookie stays off cross-site iframe loads regardless. Before this exemption,
  ANY cross-site link into Cody answered a bare 403 JSON.
- Session privacy: `lib/auth/session-owners.ts` sidecar maps omp session id →
  account id (omp owns the JSONL files, so ownership cannot live inside them).
  Owned sessions are visible only to their owner (admins included); unowned
  ones (pre-account, terminal-created, orphaned by account deletion) are
  visible to all. Enforced in `resolveSessionPathOr404` (which now REQUIRES the
  request — every per-session route passes it), the SSE events route, and the
  session list. Blocked = the same 404 as missing.
- Signup policy: `CODY_ALLOW_SIGNUP=0` hides self-service signup, but the
  first HUMAN signup is always allowed and becomes the admin — the
  env-managed bootstrap account never uses up that slot. The container needs
  no password: docker/entrypoint.sh sets `CODY_REQUIRE_ACCOUNTS=1` (unless
  `CODY_ALLOW_NO_AUTH=1`), which makes `isAuthRequired()` true even with zero
  accounts, so a fresh instance shows only the first-run setup screen until
  the opener creates the admin account.

---

## Pluggable engines (`lib/harness/`)

The coding agent under the UI is a swappable **engine**: omp (founding,
full-featured), plus pi, Claude Code, Codex and Hermes (experimental). Full
architecture: `docs/harnesses.md`. The load-bearing rules:

- `getHarness()` resolves persisted selection (`cody-engine.json`) →
  `CODY_HARNESS` env → omp. `selectHarness(id)` persists a switch; the
  select route then calls `restartAllRpcSessions()`.
- **Cody-level state always lives in the instance data dir** (`lib/omp/paths`
  `getAgentDir()`): accounts, checkpoints, engine selection, session owners,
  the engine session index, the tools prefix. Never route these through the
  active adapter's `getAgentDir()` — they must survive engine switches.
- **Browser state that names an engine's things is scoped per engine.**
  `ENGINE_SCOPED_KEYS` / `engineScopedKey()` (lib/storage-keys.ts) address
  `cody:composer-models`, `cody:unread-session-ids` and
  `cody:last-open-by-project` as `<key>:<engineId>`. Session ids are the
  engine's own, and the composer's pinned-model list is an allowlist over ONE
  engine's catalog: unscoped, an omp→pi switch left the composer saying "No
  models" while `/api/models` had returned pi's whole catalog — with the
  Models settings tab hidden on pi, so there was no way to recover it. An
  unknown engine (`/api/info` still in flight) reads as "nothing stored", never
  as the unscoped key; the pre-scoping value is deliberately abandoned rather
  than adopted, because adopting it IS the bug. Everything else Cody stores
  (theme, language, panel widths, sound) belongs to the human and stays global.
- Non-omp live chat has two shapes, and `lib/harness/engine-transport.test.mjs`
  pins which engine rides which:
  - **ACP** (`acp-session.ts`) — one long-lived stdio JSON-RPC server,
    `session/new` once and `session/prompt` per turn. An engine is a data
    description (`AcpEngineSpec`), never a class. Hermes speaks it natively
    (`hermes acp`); Claude Code and Codex speak it through
    `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`
    — neither CLI has an ACP mode of its own. It is the only transport with a
    real approval channel (`session/request_permission`), which is why an ACP
    engine can stop mid-turn and ask.
  - **Per turn** (`TurnEngineSession` + a `<id>-stream.ts` translator) — one
    CLI process per prompt, NDJSON translated into the pi event vocabulary.
    NO ENGINE RIDES IT ANY MORE: Claude Code was the last, and
    `turn-session.ts`/`claude-stream.ts` are dead code kept only because
    `EngineCommandError` still lives there. Retiring them (rehome that class,
    delete both modules and their two test files, drop
    `TURN_SESSION_ALLOWLIST` from `lib/architecture.test.mjs`) is a standing
    follow-up, not a refactor to do incidentally.

  Both throw code `"unsupported"` for commands beyond
  prompt/abort/get_state/get_messages — the UI tolerates that by design — and
  both keep session metadata in `cody-engine-sessions.json`
  (`lib/harness/engine-sessions.ts`), keyed by Cody session id; ownership
  uses the same session-owners sidecar as omp.
- **An engine's binary is not always its CLI.** An ACP adapter is what Cody
  installs, probes and version-checks, while the CLI underneath is a separate
  concern — so `HarnessAdapter` states them apart: `installAlso` installs the
  CLI as its own package (Cody owns its version), `skipNativeOptional` stops
  the adapter shipping a duplicate copy, `engineEnv()` joins the two halves
  with one env table used by the live session, the post-install probe AND a
  Cody terminal, `cliArgs` names the argv that opens the interactive CLI (an
  ACP adapter run bare is a JSON-RPC server, not a TUI), and `healthArgs` is
  the probe that runs the REAL entry point. Codex is the worked example:
  `codex-acp --version` answers from its own bundle and reports healthy with
  no Codex to drive, so the install is verified with `codex-acp cli -V`;
  Claude Code is the same shape, verified with `claude-agent-acp --cli
  --version`.
- **`--omit=optional` does nothing for a global npm install.** Verified four
  ways against npm 10.9 (flag, `--no-optional`, `NPM_CONFIG_OMIT`,
  `--userconfig`): all of them installed the ~300 MB platform binary anyway.
  What works is the platform gate — `--os=none --cpu=none` matches no
  package's `os`/`cpu`, so npm skips exactly the platform-specific optional
  dependencies. That is what `skipNativeOptional` sends, and it is applied
  PER PACKAGE, because the CLI installed beside the adapter needs precisely
  the binary the flag suppresses.
- **Cody's display tools reach an ACP engine over MCP.** `open_preview` and
  friends ride `session/new`'s `mcpServers` as an `McpServerStdio`
  (`lib/display/engine-tools.ts` `displayMcpAcpServer`, wired through
  `AcpEngineSpec.mcpServers`). Two traps: the descriptor must carry NO `type`
  field (adapters discriminate stdio by its absence and silently drop a
  server that has one), and building it throws when the display secret is
  unset, so the hook catches — a failed token must cost the session its
  Preview button, never its chat.
- **An ACP tool `title` is a sentence, not a tool name.** The Claude adapter
  renders a Bash call as the command line. The real name rides in the agent's
  own `_meta`, so `AcpEngineSpec.toolNameMetaPath` names the path as DATA
  (`["claudeCode", "toolName"]`) and `acp-session.ts` stays engine-neutral —
  `lib/architecture.test.mjs` guards that seam, and the module's docstring
  promises it.
- Capability flags (`HarnessCapabilities`, including `chatExtras`) gate UI
  surfaces: a `false` **hides** the settings tab / panel card / composer
  control, it never renders a broken one. `/api/info` serves the active
  engine's capabilities to the client.
- **The client gates on the WHOLE flag set, not a hand-picked subset.**
  `AppShell` threads `capabilities` (all of them) and `engine` (identity) into
  `ChatWindow` → `ChatInput` and into `SessionSidebar`; the composer derives
  `chatExtras`/`fastMode`/`subagents` from that prop rather than receiving
  three booleans. The three-boolean version is what produced four separate
  leaks at once: with `models` and `skills` never threaded, the "Smart — OMP
  roles" row (which fetches omp's `config.yml`) rendered on pi because it was
  gated on `chatExtras`, which pi HAS. When a control needs a flag nobody
  passed yet, read it off `capabilities` — do not add a fourth boolean.
- **A few surfaces are one engine's own files, not a capability.** Session
  import writes omp's `.jsonl` layout and archive moves it with omp's gc
  layout; the routes refuse under any other engine (`requireEngine("omp", …)`)
  and the controls follow with `engine.id === OMP_ENGINE_ID`
  (components/SettingsTabs.tsx). The same is true of the composer's plan-quota
  ring: `omp usage --json` is the only reader `lib/usage` has, so `/api/usage`
  answers `{available:false, reason}` elsewhere — a VALUE, not an error — and
  the ring hides rather than rendering a permanently empty dashed circle
  (`useUsage(enabled)` also stops the 90-second poll behind it).
- **Engine-specific copy names the ACTIVE engine.** Every user-facing string
  that used to say "omp"/"OMP" now interpolates `{name}` from
  `engine.shortName` (`chatInput.smartModel*`, `.thinkingAuto`,
  `.toolPresetCoreWarning*`, `.groupEngineBuiltin`, `agentSession.startingAgent`,
  `.fallbackAppliedDetail`, `.fallbackSucceededDetail`, `info.section.engine`).
  `agentSession.startingAgent` fires on any slow first connect — i.e. exactly
  the Hermes/Codex cold start — which is why it said "Starting omp…" to a
  Hermes user. The Info panel's copyable diagnostics say
  `Engine: <shortName> <version>` for the same reason: the VALUE was always
  the active engine's, only the label lied.
- **A capability flag is a UI convenience; the ROUTE is the boundary**
  (`lib/engine-guard.ts`). Every omp-shaped endpoint used to answer 200
  whichever engine was selected — probed directly under Hermes they served
  omp's model catalog, model roles, models.yml, config.yml, login providers,
  plan quota and version, each presented as Hermes'. Some were reachable
  through the UI too, because the flag that hid them is not the flag they
  needed: Hermes declares `nativeSettings` (it has its own config) and so
  rendered omp's `config.yml` panels with a Save that wrote to a file it
  never reads; pi has `chatExtras` and so offered omp's "Smart — OMP roles"
  row and an Export that shells `omp --export`. Every such route now either
  DISPATCHES on `getHarness()` (`/api/models`, `/api/omp-version`) or on an
  ADAPTER METHOD (`/api/omp-settings/schema` → `HarnessAdapter.settings`), or
  REFUSES with 400 `{code:"unsupported"}`, which is the same answer
  `/api/memory` gives and the one the client hides on. Prefer the adapter
  method: a `getHarness()` dispatch is still a list of engine ids in
  engine-neutral code, and the id whose branch is the `else` silently becomes
  the default for every engine nobody thought about. Pinned by
  `lib/engine-route-guards.test.mjs`.
- **A launch that means "another engine" must never be spelled the same way
  as one that means "this engine".** `runUtilityCommand(cmd, ms, launch)`
  treats an absent `launch` as "spawn the installed omp", and
  `utilityRpcLaunchFor` used to return `undefined` — that same value — for
  every engine with no `rpcUi`. So `/api/models` faithfully asked omp for its
  catalog and served it as Claude Code's: 150 omp models in the composer of
  an engine that had never heard of them, which is what the owner reported.
  `utilityRpcLaunchFor` now THROWS `unsupported` for a non-rpc engine, and
  `undefined` means omp and only omp.
- **ACP models are SESSION state, not a catalog** (`AcpModelSurface` in
  `lib/harness/acp-session.ts`). There is nothing sessionless for
  `/api/models` to read, so it answers `catalogSource: "session"` with an
  empty list — empty, and deliberately NOT a `modelError`, because nothing
  broke. The models themselves are captured at `session/new`/`session/load`
  and reported through `get_state` as `{model, availableModels,
  modelSelectable}`; `set_model` switches them and emits `config_update`, the
  event Cody already treats as authoritative for the running model. TWO wire
  shapes are live at once and both are handled: `configOptions` with
  `category: "model"` + `session/set_config_option` (current spec; the Claude
  Code and Codex adapters), and the older `models: {availableModels,
  currentModelId}` + `session/set_model` + `current_model_update` (measured
  live against Hermes 0.19, which publishes no `configOptions` at all). The
  shape decides which call is made, so `acp-session.ts` still names no
  engine. Whether an agent offers models is per SESSION — it depends on the
  account the session opened with — so it is reported as data, never as a
  static capability flag that could not tell the truth about it.
- **ACP session MODES are session state the same way** (`AcpModeSurface`,
  `session/new` → `modes: {availableModes, currentModeId}`). Claude publishes
  Manual / Accept edits / Plan / Auto, Hermes Default / Accept Edits / Don't
  Ask, Codex none — and "none" is the answer for every rpc-dialect engine
  too, so the list rides `get_state` as `{availableModes, currentModeId}`
  and the composer's mode button (`ChatInput`, `data-testid`
  `agent-mode-button`) exists only while the list is non-empty. `set_mode`
  → `session/set_mode`; the agent's own `current_mode_update` and the echo of
  our call both surface as `mode_changed`. On the client the list is
  id-scoped (`sessionModes.forSession`), like `autoModelSwitch`: a list
  adopted for one session is never offered on the next, and a state fetch
  WITHOUT the field clears it — unlike models there is no global catalog to
  fall back on, so absence is the truth. `set_mode` on an engine without
  modes answers `unsupported`, and rpc-manager's default branch now says the
  same for any command Cody never mapped, instead of a bare "Unsupported
  command" that reached the client without a code.
- **Provider credentials are Cody-level state, delivered as environment**
  (`lib/harness/provider-keys.ts`). Every engine already reads its keys from
  the process environment (pi/omp env maps, Hermes `api_key_env_vars`,
  Claude `ANTHROPIC_API_KEY`, Codex `OPENAI_API_KEY`), so the store is a
  0600 JSON file in the instance data dir and `engineChildEnv()` is the one
  function every child spawn (`lib/omp/rpc-process.ts`,
  `lib/harness/acp-session.ts`, `lib/terminal-manager.ts`) builds its env
  from: process env, then stored keys, then the spec's own entries (a spec
  must be able to override — `CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`). Values
  never reach the browser; the panel gets `stored` / `fromEnvironment`
  flags. This is what the owner's "pi and Hermes didn't work" came down to:
  no credentials, and Cody dropping the error — an assistant turn ending
  with `stopReason: "error"` used to append an EMPTY bubble; it is now an
  error notice in the provider's words, with a pointer at the keys panel when
  the text smells like a 401.
- **Provider SIGN-IN is each engine's own, behind one seam**
  (`HarnessAdapter.providerLogins`: `ProviderLoginSurface` in
  `lib/harness/types.ts`, gated by `capabilities.providerLogin`). A
  subscription (Claude Pro/Max, ChatGPT, Nous Portal, GitHub Copilot, …) is a
  credential only the engine's own store may hold, and every engine has a
  login of its own that prints a URL and takes a code back — omp's rpc-ui
  extension frames, pi's pi-ai flows, `claude auth login`,
  `codex login --device-auth`, `hermes auth add`. The surface is
  `list()` → rows `{id, name, authenticated, kind: oauth|device, canLogout}`,
  `login(id, ui)` with `ui = {onUrl, onDeviceCode, onPrompt, onManualInput,
  onProgress, signal}`, optional `logout(id)`. `/api/auth/providers`,
  `/login/[provider]` (SSE + POST for the pasted value) and
  `/logout/[provider]` dispatch on it and refuse `unsupported` without it;
  the route turns the `ui` calls into the frames the panel already rendered
  for omp (`auth`, `device_code`, `prompt_request`, `progress`, `success`,
  `error`, `cancelled`) and holds a value pasted BEFORE the engine asks —
  the paste box is on screen from the first URL, and a redirect URL usually
  arrives first. `components/settings/ProviderSignInPanel.tsx` renders the
  rows on the API Keys & Providers tab for every engine, above the key
  cards; `ProviderLoginFlow.tsx` is the one state machine (extracted from
  ModelsConfig's Subscription detail, which now reuses it). Credentials
  never pass through Cody: a driver relays a URL out and a code in and reads
  the engine's answer. `/api/auth/all-providers` stays omp-only (it reads
  omp's model catalog to list configured API-key providers).
- **The composer reads whichever catalog is real.** `useAgentSession` keeps
  `modelCatalogSource` from `/api/models` and, when it says `"session"`,
  serves the composer the list it adopted off `get_state` instead (measured:
  Hermes 0.19 publishes 11). It exposes `modelSelectable` — `null` for a
  global-registry engine, where the rpc-dialect `set_model` surface
  (`chatExtras`) decides as it always did, and a boolean for a session-scoped
  one, where the SESSION decides. `ChatWindow` gates the picker on that, so no
  new capability flag was invented for something a flag cannot know. A
  session-scoped engine also seeds no `newSessionDefaultModel`: the agent
  resolves its own on `session/new` and reports it back, and the picker only
  appears once a session exists — before that there is genuinely nothing to
  choose from.
- **Agent memory is read-only, on purpose** (`capabilities.memory`,
  `HarnessAdapter.readMemory`, `/api/memory`, `components/MemoryPanel.tsx`).
  Memory is the agent's own account of what it learned, so Cody shows it and
  never writes it; each document carries its `path` precisely so the user can
  open and edit the file themselves. The flag is true only when an engine
  keeps memory AND can hand it back — Hermes today; omp keeps memory but
  exposes no read-back, so its surface stays hidden rather than empty. That is
  also why `memory` is the one flag defaulting to FALSE in
  `ALL_CAPABILITIES` (components/SettingsTabs.tsx). A document that does not
  exist yet is the normal state of a fresh install: the panel says the agent
  has not written anything here yet, never an error.
- The Docker image ships NO engine — omp included. Every engine installs
  from the picker into the persistent tools prefix (`CODY_TOOLS_DIR`,
  default `<data dir>/tools`; entrypoint puts its `bin` first on PATH), and
  the install route doubles as UPDATE (specs pin `@latest`; updating the
  active engine restarts live sessions). Binary resolution per engine:
  `CODY_<NAME>_BIN` override → tools prefix → PATH
  (`lib/harness/engine-bin.ts`; omp's probe in `lib/omp/omp-cli.ts` checks
  the tools prefix too). Selecting the already-active engine is the
  "decide later" no-op and must never require the binary.
- The onboarding picker (`components/EnginePicker.tsx`) mounts post-auth for
  admins while `cody-engine.json` is absent/un-onboarded; `/api/engines` is
  deliberately unreachable before the first account exists.
- **Engine release notes come from the version an update would install**
  (`lib/harness/package-changelog.ts`, `/api/engines/changelog`): while the
  registry knows a newer version than the installed binary, the changelog is
  pulled from the LATEST published npm tarball (fetched once per exact
  version, minimal ustar walk, registry-host-pinned) and every section newer
  than the installed version is flagged `isNew` — the installed package's own
  CHANGELOG.md can only describe the past, which is precisely the version the
  user is about to leave. A failed fetch falls back to the installed file and
  the UI says so (`source: "installed"` while an update is pending).
- **The update check follows the ECOSYSTEM, not npm** (`lib/harness/updates.ts`
  `fetchLatestPackageVersion`). npm engines are looked up on
  registry.npmjs.org (scoped names fully URL-encoded, which that registry
  accepts), Hermes on pypi.org, whose manifest nests the number under `info`
  — and whose project name is the spec WITHOUT its extras marker
  (`hermes-agent[acp]` → `hermes-agent`, since the bracketed form is install
  syntax and 404s). A wrong-registry lookup is not a loud failure: it reports
  "no update available" for the rest of the instance's life. All five specs
  were checked against the live registries.
- **An engine installed as TWO packages has TWO versions, and Cody says which
  is which** (`HarnessAdapter.engineCli`, `EngineUpdateStatus.components`).
  For Claude Code and Codex, `installSpec` names the ACP ADAPTER
  (claude-agent-acp 0.70.x, codex-acp 1.x) while `installAlso` names the CLI a
  user actually means by the engine's name (claude 2.1.x, codex 0.14x.x) —
  different number lines on different release schedules. Three rules fall out
  of that, and each one was a live bug before it was a rule:
  - **The displayed version is the ENGINE's.** Anything that labels a number
    with the engine's NAME goes through `engineOwnVersion()`
    (`lib/harness/index.ts`): the picker card and the User Accounts engine
    list (`/api/engines` `version`, with the adapter's alongside as
    `adapterVersion`), the Info panel (`/api/info` `ompVersion`), and the
    update card's headline (`EngineUpdateStatus.engineVersion`). A card
    reading "Claude Code v0.70.0" beside a `claude --version` of 2.1.241 is
    not a rounding error. `installedVersion`/`latestVersion` stay the PACKAGE
    `installSpec` names, because that is what a revert pins and what
    `verifiedVersion` measures.
  - **The update check asks BOTH registries.** `engineCli.packageName` is the
    second lookup. The adapter goes months between releases while the CLI
    ships most days, so an adapter-only comparison reports a CLI many releases
    behind as "up to date" and never offers the update that would fix it —
    measured, not hypothetical.
  - **Revert restores the PAIR.** `install-history.json` records
    `previousEngineVersion` beside `previousVersion`, and the install route
    pins both halves when the requested version matches the record. Pinning
    only the adapter while the CLI installs `@latest` reinstalls the very
    thing being reverted if the CLI was the cause. It is also why the revert
    offer survives an update that left the adapter version untouched.
  `engineCli.getVersion()` is the adapter's own `healthArgs` with `engineEnv`
  applied — the CLI that will actually run, not whatever npm last unpacked —
  so the version that gets VERIFIED is the version that gets SHOWN. Version
  probes are therefore cached per binary AND per argv
  (`lib/harness/engine-bin.ts`), and an install drops every argv's answer for
  every binary, because a cache HIT never expires and the companion CLI's bin
  name is not something the installer models.
- **`HarnessAdapter.verifiedVersion`** is the exact engine version this Cody
  build was last audited against — every adapter carries one (omp: 18.1.6,
  claude-agent-acp: 0.73.0, codex-acp: 1.8.0, pi: 0.73.1, hermes: 0.19.0).
  It is shown verbatim on the System & Updates engine card ("Built to
  vX.Y.Z", served through `/api/engines`), and its MAJOR drives the
  warnings: `checkEngineUpdates` compares it to the latest/installed
  versions (`latestBeyondVerified` / `installedBeyondVerified`) and System &
  Updates warns before — and marks after — a jump past it: core surfaces
  keep working (settings are schema-driven, unknown RPC frames are
  tolerated), but brand-new engine features may not appear in Cody until
  Cody updates. Bump the marker in the same commit as each compatibility
  audit. It is always a version of the package `installSpec` names, so for a
  two-package engine it is the ADAPTER's — which is why the notice names
  `engineCli.adapterLabel` rather than the engine's brand ("Claude Code ACP
  adapter v1.0.0", never "Claude Code v1.0.0" while Claude Code is on
  2.1.x). The CLI half crossing a major raises no notice today: Cody speaks
  to the adapter, and an ACP engine's Cody surfaces are capability-gated
  almost entirely off.
- **The seam is CI-enforced** (`lib/architecture.test.mjs`): outside
  `lib/omp/` and `lib/harness/`, importing `lib/omp/*` fails the test unless
  the file is on the in-test allowlist with a written reason, stale allowlist
  entries fail too (the list only ratchets down), and the adapter/translator
  modules (`harness/omp|claude|codex|hermes|claude-stream|acp-session`) are
  private to the seam —
  everything else goes through `@/lib/harness` or its engine-neutral
  submodules. New engine-neutral code must NOT import `lib/omp` directly;
  route it through the harness (capabilities, adapter methods, or the engine
  dispatch pattern in `app/api/sessions/route.ts`).

## Settings: schema-driven, not hand-listed

Cody renders each engine's settings from the ENGINE's own declaration, so a
setting added upstream appears without a Cody change.

- **The route is engine-neutral; the derivation is per engine.**
  `HarnessAdapter.settings` (`EngineSettingsSurface` in `lib/harness/types.ts`)
  is one pair of methods — `readSchema()` → `{path, schema, values, reason?}`
  and `write(patch)` → `{written, rejected, values}` — implemented three ways:
  omp from its TypeScript schema (`lib/harness/omp.ts`, the one adapter the
  seam lets import `lib/omp`), Hermes from its Python `DEFAULT_CONFIG`
  (`lib/harness/hermes-settings.ts`), and pi from the four-column settings
  tables in its installed package's `docs/settings.md`
  (`lib/harness/pi-settings.ts`, writing `<pi agent dir>/settings.json`).
  `/api/omp-settings/schema` gates on `nativeSettings`, reads the hook, and
  refuses `unsupported` when there is none. It used to switch on engine ids,
  which made "no branch of mine" mean "omp's branch" — every other engine got
  omp's ~550-key schema back under its own name, and its PUT wrote omp's
  `config.yml` while another engine was active, reporting success. A hook
  cannot do that. Adding the panel to an engine is now: implement the
  surface, hang it off the adapter, flip the flag.
- **Derived, never hand-listed — even when there is no schema to read.** That
  is the whole property: Hermes has no schema but has DEFAULT_CONFIG; pi has
  neither, but ships every setting's type, default and description in
  `docs/settings.md`, which is regular enough to parse (pi's
  `dist/core/settings-manager.js` carries the same defaults in imperative
  code with no types, descriptions or grouping — a hand-written key list
  dressed up as a pipeline). A prose source means failing soft at every step:
  a row that yields no renderable control is skipped, a documented `object`
  or object-bearing `array` is left out rather than rendered as a control
  that would destroy it on save, and a missing file answers `schema: null`
  plus a `reason` the panel prints — the same answer an engine that is not
  installed yet gives, which is an answer and not an error.
- **A write is read → mutate → write the WHOLE file.** pi's settings.json
  holds keys the panel never lists (`thinkingBudgets`, `packages` object
  entries, anything a newer pi added); a writer that rebuilt the file from
  the schema would delete every one of them. Dotted keys persist nested, a
  `null` patch entry is the panel's Reset and prunes the parent it empties,
  and the file's existing mode and trailing newline survive.
- `lib/omp/package-source.ts` — the shared way to read one of OMP's own source
  files out of the installed package. Bun-only imports are aliased to a
  permissive Proxy stub and jiti transpiles what is left. The stub must return
  `undefined` for `then`, or the module becomes thenable and the load hangs
  forever on an unsettled top-level await.
- `lib/omp/settings-schema.ts` — reads `<omp package>/src/config/settings-schema.ts`
  through it. There is **no settings-schema RPC command**, so it goes through the
  installed package's source. Credentials, `ui.secret` settings, and settings
  without `ui` metadata never reach the browser.
- **The model-role list is read the same way, not hand-listed**
  (`lib/omp/model-roles.ts` `getOmpModelRoleIds`, from
  `<omp package>/src/config/model-roles.ts` `MODEL_ROLE_IDS`). The vocabulary
  changes between releases — omp removed `designer` in 18.1.5 — and a frozen
  copy kept writing `modelRoles.designer` into `config.yml` for a role the
  resolver no longer had, while the plan editor kept offering it. `/api/model-roles`
  and `/api/model-plan` serve the live list as `roleNames`; the Models panels,
  the fallback-chain editor and the planner prompt all render from that, and
  `heuristicPlan`/`validatePlan` take it as an argument so a role the engine
  dropped is never assigned. `FALLBACK_MODEL_ROLE_IDS` applies only when the
  package cannot be read.
- `lib/omp/settings-values.ts` — generic read/write for any schema-declared path.
  Dotted paths persist nested (`prewalk.enabled` → `prewalk: { enabled }`), the
  form OMP's own resolver reads. Unknown paths are rejected, not written.
  `readPersistedBoolean`/`readPersistedStringList` are the side door for the
  schema-declared settings that carry no `ui` metadata: the panel must not
  render them, but their values still change what OMP does, and Cody has to
  mirror those decisions (`skills.enableClaudeUser` / `skills.enableCodexUser`
  gate which foreign user-level skill roots `lib/skills-service.ts` lists).
- `lib/omp/settings-conditions.ts` — restates OMP's value-derived `ui.condition`
  predicates so Cody hides the same rows OMP hides.
- `lib/omp/settings-surface.ts` — **the one hand-maintained list in this
  pipeline**: which settings only configure the harness's terminal UI and so do
  nothing in a browser. The schema carries no metadata for it (the harness has
  no notion of a second front end), so those rows get a "Terminal only" chip
  rather than being hidden — the same file still drives the CLI.
  `settings-surface.test.mjs` fails if a rule stops matching the installed
  schema, so an upstream rename surfaces as a test failure, not a vanished chip.
- `components/settings/OmpSchemaSettings.tsx` — the "All OMP Settings" tab.
- `lib/omp/settings-config.ts` stays: it backs the curated tabs (model registry,
  approval matrix, retry fallback chains) that deserve bespoke controls. Both
  write the same file; the dialog re-reads after each save so they stay in step.
- `jiti` must remain in `serverExternalPackages` — bundling it breaks its
  runtime file resolution.
- The panel's tab is pinned to the foot of the settings sidebar and named from
  the active harness (`HarnessAdapter.shortName`, served by the schema route),
  so switching `CODY_HARNESS` renames it rather than requiring a UI edit.
- **"Terminal only" is per engine, and deliberately not shared.**
  `lib/omp/settings-surface.ts` lists omp's keys; `PI_TERMINAL_ONLY_KEYS` in
  `lib/harness/pi-settings.ts` lists pi's. The two engines' key names only
  partly overlap, so one shared list would mislabel whichever renamed a key
  first. Both are conservative: a row is chipped only when it is clearly
  terminal chrome, and it is chipped rather than hidden because the same file
  drives the CLI the user runs in a Cody terminal.
- There is no "Native OMP" chip: it labelled the majority of rows and named a
  harness. Only the exceptions carry a chip — "Cody only" for browser-local
  preferences, "Workspace", and "Terminal only" above.

## Key Design Decisions & Traps

### Human terminal engine launch is entrypoint-scoped
- `TerminalManager.create()` launches the active engine once, then drops into
  the configured interactive shell. `continue()` restarts only that shell.
- The wrapper belongs only to browser PTYs created by the New Terminal action.
  Never move it into shell profiles or process-global environment handling:
  task runs, server subprocesses, and agent tool calls must stay plain commands.
- Container SSH auto-launch is separately guarded in
  `docker/entrypoint.sh` by `SSH_CONNECTION`, a real TTY, and
  `CODY_NO_AUTO_ENGINE`; non-interactive SSH commands must bypass it.

### RPC session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per session id, keyed in a `globalThis` registry.
- `globalThis` survives Next.js hot-reload; plain module-level Map does not.
- Idle sessions are disposed after a timeout; concurrent `startRpcSession()`
  calls must share a single start promise.

### Agent-driven Preview panel (`lib/preview-url.ts`, `lib/preview-autoopen.ts`)
- The agent reaches the Preview tab two ways. Deliberately: the `open_preview`
  host tool settles SERVER-side (rpc-manager `SERVER_HOST_TOOLS`) — it
  publishes on the display-request bus (`lib/display/bus.ts`), the panel
  auto-opens via the display SSE, and the tool result reports server-probed
  reachability back to the model. `open_url` host-tool calls carrying a
  loopback URL funnel into the same bus from the browser (a host_tool_call
  arrives outside any user gesture, so `window.open` would be
  popup-blocked). Implicitly: loopback URLs in **live**
  assistant replies (`message_end` frames only — history loads and reconnect
  hydration never trigger) are offered to `createPreviewAutoOpener`, which
  opens the panel only once a no-cors probe confirms something answers,
  retrying briefly so a still-booting dev server is not missed.
- Auto-open policy: once per (session, url) pair; explicit host-tool opens
  mark the pair handled so follow-up prose cannot re-open a panel the user
  closed; a session switch abandons pending probes. URL rules are shared in
  `normalizePreviewUrl` — loopback only (an agent may only publish its own dev
  server; candidate resolution widens it afterwards), with 0.0.0.0 / [::] /
  [::1] canonicalized to localhost.
- Every trigger — host tool, URL sniffing, manual URL bar — POSTs to
  `/api/agent/[id]/display`, so one pipeline feeds `PreviewPanel`: it consumes
  the latest `DisplayRequestV1` from `useDisplayRequests` (SSE snapshot + live
  events), and a live event both opens the panel and marks the (session, url)
  pair handled for the auto-opener.
- Host tools exist only on omp's rpc-ui protocol; every other engine gets the
  assistant-text detection path here, plus the bundled display MCP server (see
  `lib/display/` below) — as `--mcp-config` on a per-turn CLI's argv, or as an
  ACP `McpServerStdio` named at `session/new`.

### Preview screenshots (`lib/preview-screenshot.ts`)
- `preview_screenshot` is a SERVER-implemented host tool (rpc-manager
  `SERVER_HOST_TOOLS`): registered at wrapper initialize, merged into every UI
  `set_host_tools` (omp replaces the roster per call, so a reconnect
  re-register must never drop it), and settled in `handleFrame` with
  `sendFrame` — no attached browser required. The result carries the image as an
  image content block plus a text line, so vision models see their own work.
- **Every capture must fit one RPC frame.** The image rides to omp as base64
  inside a single NDJSON line (1 MiB, no outbound chunking), and a dropped
  result hangs the tool call forever — so captures walk a ladder against
  `SCREENSHOT_MAX_BYTES` (600 KiB raw ≈ 800 KiB base64): PNG at the requested
  size → WebP same size → WebP capped to 1280 long edge → WebP capped to 800.
  First rung within budget wins, so an ordinary capture stays crisp PNG; the
  extension in `--screenshot=out.<ext>` is what selects the encoder (verified on
  Chromium 151). `ScreenshotResult.mimeType` reports what was actually produced
  (sniffed from the bytes) and width/height report what was actually rendered.
  Nothing over budget is ever returned: the last rung throws
  `ScreenshotError("too_large")`, which the API maps to 413 and the host tool
  answers as a normal tool error.
- Rendering shells out to a headless Chromium in one-shot `--screenshot` mode
  (no CDP, no new dependency). Binary resolution: `CODY_CHROMIUM_BIN` →
  Playwright caches → PATH → common install paths; the Docker image bundles
  Debian chromium and pins `CODY_CHROMIUM_BIN=/usr/bin/chromium` (smoke test
  asserts it). Loopback-only via `normalizePreviewUrl` — that rule is the SSRF
  guard, do not widen it casually. `--no-sandbox` only when running as root.
- Chat display: `ToolCallBlock` renders tool-result image blocks as
  always-visible thumbnails (not behind the collapse). History loads defer
  those images (`deferMedia`) — the reader replaces each with a url-source
  block minted by `toolResultImageUrl` pointing at
  `/api/sessions/[id]/media?entryId=&index=`, which streams the bytes with
  blob resolution on. The media route MUST enumerate images with the same
  predicate the deferral used (`isDeferrableToolResultImage`) or indexes
  drift.
- The Preview panel's camera button posts `/api/preview/screenshot` and
  attaches the image to the composer via `ChatInputHandle.addFiles`, carrying
  the mime type the server actually produced (never an assumed PNG) — the
  screenshot rides the existing image-attach path into whichever engine is
  active (turn engines currently reject image prompts with
  `images_unsupported`, same as a manual attach).

### Universal display/preview surface (`lib/display/`)
- **Session-scoped request bus** (`bus.ts`): `DisplayRequestV1` per session in a
  `globalThis` map (latest + listeners, hot-reload safe). Engines that rekey a
  session mid-run (`session_info_update`) call `aliasDisplaySession(old, new)` —
  the alias chain, latest request, and listeners all move to the new id.
- **Loopback-only publication**: `validation.ts` accepts http(s) URLs on
  localhost/127.0.0.1/[::1] and rejects credentials. The preview surface is for
  dev servers the agent started, not a general browser. Resolution then
  rewrites that loopback URL into the candidates below.
- **Fidelity ladder** (`native-gateway.ts`): resolution returns
  `candidates: DisplayCandidate[]`, ranked best-fidelity-first, and the client
  uses the first one that works. There is no single `transport` any more, and
  streaming is NOT the default — it is the floor.
  1. `direct` — a real iframe against the dev server's own origin, ranked
     **local-first**: the loopback URL we were handed leads the group, then one
     candidate per non-loopback IPv4 interface (`os.networkInterfaces()`) that
     answers a probe, so a dev server bound to `0.0.0.0` is framed straight
     from the tablet over LAN/Tailscale. Highest fidelity: real DOM, real
     fonts, real input, no re-encode.
     The loopback rung is what makes a co-located install (Windows desktop
     shell, on-device Android, plain `npm run dev`) render natively with zero
     configuration and no Chromium — but it is only usable by a browser on this
     machine, so `lib/display/ladder.ts` **drops it structurally** for any
     other client. That gate cannot be a probe: a remote device probing
     `127.0.0.1` may get an opaque success from an unrelated local app and
     frame the wrong thing.
  2. `native` — the `CODY_PREVIEW_BASE_URL` wildcard-subdomain HTTP+WS reverse
     proxy. It strips credentials in BOTH directions (cookie/authorization on
     the way in, set-cookie on the way out) so the iframe never carries Cody
     credentials into the dev server and the dev server can never plant
     cookies on the preview domain — and it strips `X-Frame-Options` + the
     `frame-ancestors` directive from responses it re-serves under its token
     origin, so ANY target (a frame-guarded Cody dev server included) is
     frameable through it, like any port-forwarding preview proxy. Only
     present when configured, and only minted when a server-side cookie-less
     probe gets a 2xx (`gatewayRenderable`): an auth-gated target could at
     most render a login form whose session cookie the gateway discards — a
     dead end, so it rides the streamed rung instead. **Do NOT "fix"
     auth-gated gateway targets by passing set-cookie through** (cookie
     tossing / session fixation against Cody itself); run the dev server
     without auth instead — a bare `npm run dev` with no accounts is already
     open. Covered by `lib/native-gateway.test.mjs`.
  3. `stream` — always last, always present: a server-side Chromium
     (`CODY_CHROMIUM_BIN`, puppeteer-core, CDP screencast) renders the URL and
     ships JPEG frames + pointer/keyboard input over the
     `/api/display/socket?sessionId=` WS handled in `bin/cody-server.js`.
     Needs nothing of the client's network, so it cannot fail to be available.
- **Client-side ranking** (`lib/display/ladder.ts`): `orderDisplayCandidates()`
  is pure and shared (the panel imports it; future native clients can too). It
  encodes the three facts only the document knows — mixed content is
  hard-blocked, loopback means *this* machine, and our own hostname provably
  routes here so it outranks the rest of the direct group. Unit-tested in
  `lib/display.test.mjs`; there is deliberately no "remote mode" flag, because
  one server can serve a local webview and a remote tablet at the same time and
  each resolves correctly from the same candidate list.
- **Capability tokens** (`capability.ts`): engine-side MCP servers post to
  `/api/internal/display` with an HMAC session-scoped token.
  `CODY_INTERNAL_DISPLAY_SECRET`/`CODY_INTERNAL_DISPLAY_ORIGIN` are minted by
  `bin/cody-server.js` at boot and live only in the environment — never
  persisted.
- **Per-engine wiring**: omp gets a Cody-owned `open_preview` host tool —
  `lib/rpc-manager.ts` sends `set_host_tools` at session start, merges it into
  any browser-registered tool list, and routes the `host_tool_call` to
  `publishDisplayRequest`. Every other engine gets the bundled stdio MCP
  server (`bin/cody-display-mcp.js`) via `lib/display/engine-tools.ts` —
  `claudeDisplayMcpConfig` for a per-turn CLI's `--mcp-config`,
  `displayMcpAcpServer` for an ACP session's `mcpServers`. The ACP builder
  MINTS a capability token, so it throws when the server's internal display
  origin/secret are absent; an adapter's `mcpServers` hook must catch that and
  report an empty list. `scripts/engine-bringup.mjs` drives adapters with no
  server behind them, and a throw there aborts `session/new` — no bridge is a
  missing Preview button, a throw is a chat that will not open.
- **Client**: `hooks/useDisplayRequests.ts` subscribes to the SSE route;
  `AppShell` auto-opens the right panel in `preview` mode on live requests —
  the explicit, server-driven trigger alongside the client-side URL sniffing
  in `lib/preview-autoopen.ts` above. `PreviewPanel` then walks `candidates`
  in order and commits to the first usable rung, subject to two gates:
  - **Mixed content**: an `http:` candidate is skipped outright when the page
    is on `https:` — the browser hard-blocks it, no probe can save it.
  - **Current hostname wins**: a candidate whose `host` equals
    `window.location.hostname` moves to the front of the direct group. That
    host is provably routable from this device — it is how the page loaded.
  A `direct`/`native` rung is confirmed with a no-cors probe (an opaque
  response proves something answered; a network error falls through to the
  next rung); `stream` needs no probe.
- **The active rung is visible**: a quiet persistent badge in the subtitle bar
  plus a transient pill naming the method (Direct / Gateway / Streamed) once
  per resolved request. On the streamed rung the badge also names the CODEC —
  `Streamed · H.264` vs `Streamed · JPEG stills` — because those are the same
  rung and would otherwise look identical. A silent downgrade is the whole thing
  we are preventing, and it has two flavours now: falling to the streamed rung at
  all, and falling from video to stills inside it. If fidelity drops, the user
  sees why. The pop-out window has no subtitle bar, so it carries the same label
  in `document.title` and flashes a pill on every change.
- **Streamed-rung client** (`components/StreamedDisplay.tsx`): one implementation
  of the socket protocol, shared by the panel and the pop-out route. It presents
  two ways over one socket, with the same controls and the same geometry: JPEG
  stills and H.264. The canvas **backing store is `cssSize × devicePixelRatio`**
  (capped at 3) with the CSS box untouched, and that same factor rides every
  `resize` as `deviceScaleFactor` — the provider renders at that density, so the
  frame lands 1:1 and nothing resamples at either end. The first `resize` goes out
  on `socket.onopen`, not on `ready`: the provider reads its launch density from
  it and waits only briefly.
  - **Stills**: frames decode off-thread via `createImageBitmap` and present
    through an `ImageBitmapRenderingContext` (`transferFromImageBitmap`), which
    also skips a blit; Chromium leaves the canvas's intrinsic size alone, so the
    backing store stays authoritative. A `new Image()` + `drawImage` path covers
    engines without `createImageBitmap`, and a binary frame is accepted as a
    `Blob` or an `ArrayBuffer`.
  - **H.264 negotiation**: `hello` is answered with
    `{type:"capabilities",decoders:[…]}` — RFC 6381 strings this engine actually
    verified with `VideoDecoder.isConfigSupported`, and `[]` when it has no
    `VideoDecoder` at all, which keeps the session on stills. The probe walks
    levels DESCENDING per profile (High, Main, Constrained Baseline) and
    advertises ONE ceiling string per profile. That is deliberate: a level in a
    capability string is a ceiling and H.264 levels are nested, so the highest
    accepted level states the entire answer for that profile, and probing
    downward can never advertise a level below what the engine decodes — which
    matters because the encoder derives `level_idc` from frame size (5.0 at
    2560×1600, 5.1 at 2880×1800). Do not "simplify" it into advertising every
    string. The codec in the provider's `video` message is opaque input to
    `configure`: it is parsed from the real SPS and its level need not appear in
    the advertised list, so never require an exact match against it.
  - **H.264 frames**: one binary message is exactly one access unit. `key` vs
    `delta` comes from scanning every Annex-B start code for NAL type 5 — no AUD
    is emitted, so there is nothing else to key off — and deltas are DISCARDED
    until the first key, because a decoder handed a delta first throws and the
    throw kills the decoder, not the frame. Every IDR repeats its SPS/PPS, which
    is what lets a late joiner and a just-reset decoder recover. A decoder error
    closes the decoder, reopens it, reports `H.264 — recovering` and sends
    `{type:"keyframe"}`; four consecutive faults stop and say so rather than
    cycling keyframe requests forever. A second `hello` is authoritative: tear the
    decoder down and go back to stills, mid-stream if need be.
  - **Trap — one context kind per canvas**: `getContext` refuses a second kind
    forever, and stills hold a `bitmaprenderer` while video needs a 2d context.
    The negotiated renderer therefore keys the canvas **ELEMENT**, and each
    context is cached against the element it came from; presenting into the
    swapped-out canvas paints something nobody is showing.
  - **Trap — Annex-B means no `description`**: the WebCodecs AVC registration
    signals Annex-B by the ABSENCE of an `AVCDecoderConfigurationRecord`, so
    `configure` must be called without one. Filling it in from the `video` message
    configures the wrong format outright.
  - **Trap — close every `VideoFrame`**: in a `finally`, superseded frames
    included. A frame pins a decoder buffer, the pool is a handful deep, and
    leaking one per frame stalls the stream within a second — the classic
    WebCodecs bug, and it looks like a network fault.
  - **Trap — crop the alignment padding**: coded axes are macroblock-aligned, so
    up to 15 px of the right and bottom edge is padding, not content.
    `visibleRect` is honored first (for a provider that sets SPS cropping), then
    an axis is cropped to `round(viewport × deviceScaleFactor)` when it overshoots
    by less than a macroblock; a bigger difference is a resize the encoder has not
    caught up with and is presented whole so CSS scales it, exactly as a
    wrong-sized JPEG behaves. Crop, never letterbox, never stretch. And
    `codedWidth`/`codedHeight` on a decoded frame are no substitute for either
    bound — a decoder can report 1026 rows for a 1008-row picture.
  - **Trap — pointer space is the viewport's CSS pixels**: NOT the backing store
    and NOT the coded size. Remote input space is CSS px, so scaling by
    `canvas.width / rect.width` sends every click at `deviceScaleFactor`× too far,
    and folding in macroblock padding skews it by a few pixels that get blamed on
    everything else.
- **Clipboard bridge**: `hello.input` may advertise `"clipboard"`. Only then does
  the panel show copy/paste controls, and only then does the surface intercept
  Ctrl/Cmd+C and Ctrl/Cmd+V rather than forwarding them (every other key,
  Ctrl+A and Tab included, is forwarded untouched). Copy is a round-trip —
  `{type:"clipboard",action:"read"}` → `{type:"clipboard",text}` →
  `navigator.clipboard.writeText`; paste reads the local clipboard on the click
  gesture and sends `{type:"clipboard",action:"write",text}`, clamped to 8192
  chars to match the provider's `insertText` slice and stay inside the socket's
  64 KiB frame cap. The gate is the advertised capability, NEVER
  `renderer === "raster"` — a surface that cannot bridge the clipboard offers no
  clipboard UI, which is what keeps the protocol usable for X11/Android later.
- **Pop-out window** (`app/display/[id]/page.tsx` → `components/DisplayWindow.tsx`):
  the streamed surface at full viewport on the same authenticated socket, auth-
  gated by `proxy.ts` like any page. It follows the display SSE, so a newly
  published request re-targets it instead of going dark when the server recycles
  the provider. The point is size: a real window measures larger and reports its
  own size and density, so the remote surface renders at that size natively
  instead of being upscaled from a sidebar. Distinct from the panel's detach
  button, which hands a direct/gateway URL to the browser. Every client of a
  session shares ONE remote surface, so the panel re-asserts its own viewport
  when focus returns and the pop-out is gone.
- **CSP**: `proxy.ts` builds `Content-Security-Policy` dynamically via
  `lib/display/csp.ts`. `frame-src` and `connect-src` (the probe fetch and HMR
  sockets need the latter) allow loopback, this host's own RFC1918/CGNAT
  interface addresses on any port, and the `CODY_PREVIEW_BASE_URL` wildcard when
  configured — nothing else, since candidates are minted as raw interface IPs.
  **Trap**: CSP has no CIDR notation and permits a wildcard only as the leftmost
  label, so ranges are emitted as exact per-interface hosts — Chromium silently
  discards `http://192.168.*.*:*` as an invalid source, which would collapse
  `frame-src` and block every direct preview. Public origins stay unframeable.
  The page CSP is applied to rendered pages only, NOT `/api/` responses: the
  two HTML-serving API routes (session export, docx preview) author their own
  stricter document CSP with `frame-ancestors 'self'` so the app can iframe
  them (top-bar history panel, file viewer) — a middleware `set()` would
  clobber exactly those headers, and per spec `frame-ancestors` is also what
  overrides the global `X-Frame-Options: DENY`.
  The session-export policy additionally allows `https://cdnjs.cloudflare.com`
  in `script-src`: the exporter renders the transcript client-side with
  SRI-pinned `marked`/`highlight.js` from that CDN, and blocking it renders an
  empty transcript.
- The Docker image installs `chromium` and sets `CODY_CHROMIUM_BIN` so both
  `preview_screenshot` captures and the `stream` rung — the fallback that must
  never be missing — work out of the box.
- **Trap**: the display bus and the capability secret are process-local. A
  multi-process deployment (multiple Next.js workers or replicas) would need a
  shared store for both before display requests survive crossing processes.

### Disk exhaustion is a first-class failure (`lib/disk-space.ts`)
- The instance data dir is finite and often quota-capped (a ZFS dataset on
  Unraid appdata). When it fills, npm dies with `errno -122` — EDQUOT, which
  libuv has no name for, so npm prints "Unknown system error -122" and the
  admin sees what looks like a Cody bug. `describeDiskError()` matches the
  NUMERIC errno (-122 linux, -69 macOS) as well as EDQUOT/ENOSPC text,
  because the unnamed form is the one that actually shows up.
- Engine installs preflight both filesystems they touch — the tools prefix AND
  the npm cache (`$npm_config_cache` else `$HOME/.npm`), which are frequently
  different mounts and where the cache is the one that filled in the field.
  Unreadable free space NEVER blocks an install: unknown is not empty.
- `/api/info` serves `storage` for the agent dir and the Info panel turns the
  row warning-colored under 2 GB, so the condition is visible before it bites.
- **The preflight threshold is measured, not fixed.** npm updates a package by
  renaming the old tree aside and unpacking the new one, so an update needs
  room for BOTH. omp is ~1.4 GB installed (two ~160 MB native addons among the
  rest), which a flat 512 MB floor waved straight through into the failure it
  existed to prevent. `requiredFreeBytes()` measures the installed tree and
  demands `size + 256 MB`, falling back to the floor only for a first install
  or an unmeasurable tree.
- **An interrupted install poisons every later one.** npm leaves its
  rename-aside tree (`@scope/.name-XXXXXX`) behind, then tries to rename onto
  that exact path next time and fails `ENOTEMPTY` forever — one out-of-disk
  install permanently blocked updates on a real instance until the directory
  was deleted by hand. `cleanStaleInstallDirs()` sweeps them before every
  install, matching npm's pattern for that package only.
- **npm exiting 0 is not proof the engine runs.** A disk-full install left a
  TRUNCATED native addon that loaded fine as a file and then killed the
  process with a Bus error on every invocation — Cody had reported the engine
  as installed. Installs now probe `<binary> --version` before reporting
  success and fail with the probe's own error otherwise, which also surfaces
  the revert affordance.
- **Trap — `formatBytes` lives in `lib/format-bytes.ts`, not `disk-space.ts`.**
  The latter imports `node:fs`; a CLIENT component importing from it pulls
  `fs` into the browser bundle and fails the build with "Can't resolve 'fs'".
  Typecheck and unit tests both pass — only `next build` (or loading the page)
  catches it.

### Checkpoints must never snapshot a home directory or Cody's own state
- Shadow repos live under the AGENT dir, keyed by a hash of the workspace
  path. Two consequences bit a production instance hard:
  - A session that opened `/data/home` as its workspace grew a **3.5 GB**
    shadow repo out of `.npm`, `.gradle` and a node_modules tree — those roots
    carry no `.gitignore`, so nothing was excluded. `isUncheckpointableRoot()`
    now refuses home, filesystem roots, and the agent/data dir (which would
    otherwise feed on its own output). Refusal returns null, the established
    "no checkpoint here" answer every caller already tolerates.
  - `checkpoints.test.mjs` created workspaces in `/tmp` but the shadow repos
    followed `getAgentDir()`, so every test run inside the container leaked
    into live appdata — **465** stale `cody-ckpt-*` repos. The test now sets
    `PI_CODING_AGENT_DIR` to a temp dir BEFORE importing the module. Any test
    touching agent-dir state must do the same.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): navigates the entry tree within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### ToolCall field normalization
Sessions store toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and streaming event handling.

### Event protocol differences vs pi
omp emits no `prompt_done` / `prompt_error` / `queue_update` /
`compaction_start` / `compaction_end` events. Completion is `agent_end`
(`isTerminal !== false`), errors surface as failed RPC responses plus `notice`
events, and the queue length comes from `get_state.queuedMessageCount`.
New frame types (`turn_start/end`, `notice`, `todo_reminder`, ...) must be
handled or safely ignored.

### Approval prompts: inline, and the agent owns the buttons
- An ACP engine (`lib/harness/acp-session.ts`) can stop mid-turn and ask
  permission. The turn GENUINELY blocks on the answer, so the card is not a
  notification — it is the only way that turn ever finishes.
- Frames: `permission_request` {requestId, toolCall, options} adds a card,
  `permission_resolved` {requestId, outcome} removes it. Resolution is emitted
  for EVERY settlement — this browser, another tab, an abort, the turn ending,
  the session dying — so it is the single removal path.
  `respond_permission` answers; `{answered:false}` means it was already gone.
- **`get_state.pendingPermissions` is the reload path, and it is not optional.**
  The request event fired before the reloaded page existed, so state is the
  only place the open approval can still be found; without adopting it a
  blocked turn renders as a session that waits forever with nothing to click.
  It is adopted in `loadSession` (which needs no run in flight) AND in
  `reconcileAgentState` — there it must be read BEFORE the busy early-return,
  because a turn blocked on an approval is precisely a busy turn.
- **Render the agent's own options, in its order. `kind` is a styling hint,
  never an identity.** Hermes sends five options and TWO of them share
  `kind: "allow_always"` ("Allow for session" and "Allow always") — ACP has no
  session-scoped kind. Deduping, grouping or reordering by kind deletes a real
  grant. `optionId` is the identity (and the React key), `name` is the label
  and is passed through untranslated: it is the only thing separating two
  options that share a kind.
- Styling says two things and no more: allow vs refuse (allow_once is the one
  filled primary; refusal is the quiet secondary, because refusing is safe),
  and durable vs one-shot (`*_always` carries a "Remembered" badge and is
  never the filled button, so a lasting grant cannot be a one-click accident).
- The double-click latch is a **ref**, not the `disabled` state: two clicks
  dispatched inside one task both read the pre-render state, and `disabled`
  only reaches the DOM after React commits — measured sending three answers
  through a state-only guard.
- `toolCall` is whatever the agent sent. One engine builds a different payload
  for a shell command than for a file edit, and `title`/`kind` are both
  optional, so every field is read defensively (`lib/permission-request.ts`)
  and an unrecognised kind renders verbatim rather than as a missing i18n key.

### Long tool calls narrate themselves
- `tool_execution_update` frames are handled, not dropped: the newest text
  line a tool streams about itself lands on the running-tool state
  (`RunningToolInfo.statusText`), and `tool_execution_start` stamps
  `startedAt`. The chat status line and the pending-tool headers append that
  line plus an elapsed clock once a call runs past ~8s
  (`LONG_TOOL_THRESHOLD_MS`, ChatWindow).
- The motivating case: omp's `gh` tool `run_watch` — usually invoked as a
  `write` to the `xd://github` tool device — blocks for an entire GitHub
  Actions run while polling (3s then 15s intervals), streaming a "Watching
  GitHub Actions Run #N" snapshot per poll. Without the update wiring that
  call renders as a frozen "write xd://github" for many minutes and reads as
  a hang. Contract-tested in `hooks/useAgentSession.test.mjs`.
- **Trap — the ticking clock must not ride the crossfade.** The status line
  renders through `StatusTextCrossfade`, which re-animates on ANY text
  change; folding the per-second elapsed tick into that string made the
  whole line flicker every second. The clock renders as a plain sibling span
  (`phaseElapsed`, tabular digits); only real status changes crossfade.

### Composer model + tools controls
- **Smart model row**: the model dropdown's pinned first row ("Smart — OMP
  roles") is the labeled face of auto model selection. A NEW session with no
  explicit pick sends no `set_model`, so omp resolves `modelRoles.default`
  (the saved plan); Smart re-selects that state (`selectSmartModel()` clears
  `newSessionModel`). On a live session it resolves the configured default
  role to a concrete model client-side and pins it (omp's `set_model` RPC
  takes exact provider/model — no role aliases). Picking any named model
  pins it and OMP roles stop applying to that session's main turns.
- **Smart-ness survives the pin** (`smartPinnedModel` in useAgentSession):
  both a live Smart pick (`markSmartPinnedModel`) and the engine's own
  resolution of a Smart spawn (`pendingSmartSpawnRef`, claimed by the first
  authoritative model) record the pin as Smart's answer, id-scoped to their
  session — loads and reconciles reuse `loadSession`, so a reset there would
  wipe it mid-conversation. The composer keeps "✦ Smart · <model>" while the
  running model still matches. The Advisor indicator is ShieldCheck, never
  Sparkles: Sparkles is the Smart glyph, and an accent sparkle beside the
  model name read as "auto-picked".
- **Engine-initiated model switches wear a persistent marker**
  (`autoModelSwitch`): `retry_fallback_applied` (error and usage-aware
  routing both emit it) and any bare `model_changed` whose model differs
  from the last authoritative one set a warning chip beside the model
  control — from → to, role, and the last provider error; click re-shows the
  detail as a toast. The echo of Cody's own `set_model`
  (`lastUserModelPickRef`, 15s window) is never dressed up as an engine
  switch. The 10s fallback toast stays; the marker is what outlives it,
  clearing on the next user pick or model move.
- **Tools preset control** (composer, Wrench icon): "full" leaves omp's
  toolset alone; "default"/Core spawns omp with `--tools read,bash,edit,write`,
  which also kills the `task`, `todo`, `github` and `web_search` builtins —
  no subagents, no task lists — so the menu says so in warning color and the
  trigger tints warning when restricted. The control had been removed from
  the UI while the stored preference (`cody:tool-preset`) kept applying to
  every spawn; `lib/tool-preset-preference.ts` therefore migrates a
  restricted value back to "full" unless it was chosen through the current
  labeled control (ack marker). Never reintroduce an invisible restriction.
- Todo phases refresh on every `turn_end` (plus todo tool end and
  `todo_reminder`) — the 15s reconcile poll alone made checkoffs land in
  batches, especially when subagents did the checking.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Composer-attached panels (`components/ComposerPanels.tsx`)
- The live todo plan (`TodoList`) and the subagent roster live **pinned above
  the chat input**, not inside the scrollable message list. `ComposerPanels`
  renders both, each independently collapsible via its header row (`chevron`);
  panels start collapsed (headers always show live progress / running-summary).
  Subagent chips carry live state (pulsing dot while `started`, check/alert/ban
  for terminal states) fed by the same `subagent_lifecycle`/`subagent_progress`
  SSE frames; clicking a chip opens the transcript dialog. `TodoList` keeps a
  non-collapsible default (`collapsible` prop) for SSR tests.
- **Layout is full-width stacked rows, never fit-content side-by-side**: a
  collapsed panel is a slim full-width header bar, an expanded one the same
  bar plus body, so the two headers stay aligned in all four expansion
  states (the old wrap layout floated a collapsed chip mid-air beside a tall
  card at a different width). Subagent chips fill an equal-column grid
  (`auto-fill minmax(240px,1fr)`) instead of a ragged content-hugging wrap,
  and the show-all toggle is a footer link mirroring TodoList's "Show all
  tasks" footer. Pinned by `ComposerPanels.test.mjs`.

### Composer context gauge
- An icon-only context ring sits beside Send. It uses the accent color below
  70% usage, warning from 70%, and error from 90%.
- Clicking the ring opens its summary popover; clicking outside or pressing
  Escape closes it.
- Authoritative context usage drives the ring percentage and the
  used/available/limit values. Session token traffic and per-model rows are
  derived locally from loaded assistant-message usage; the active model is
  labeled and highlighted.
- `useAgentSession` prefers authoritative live usage when it includes a
  percentage. While idle or reconnecting, `derivePersistedContextUsage()` falls
  back to the latest assistant `contextSnapshot.promptTokens` (or
  input + cache-read + cache-write usage) divided by the active model's
  `contextWindow`, which `/api/models` deliberately projects for this purpose.
  Live usage is cleared on session load/switch so one conversation cannot leak
  a stale gauge into another; genuinely unknown usage keeps an empty ring
  mounted instead of removing the control.
- Per-model token totals include input, output, cache-read, and cache-write
  tokens.

### Subagent integration (`lib/subagent-types.ts`, `lib/subagent-history.ts`)
- **Live detail**: `subagent_progress` frames carry the full `AgentProgress`
  object — `lib/subagent-types.ts` parses it defensively into
  `SubagentInfo.progress` (current tool/intent, tokens, cost, context
  gauge, resolved model, retry state, detached flag, agentSource). The
  composer chips surface the current activity + telemetry line; retry
  (`⟳ retrying N/M`) takes precedence over the tool line. `subagent_event`
  frames also feed a bounded per-subagent activity buffer shown in the
  transcript dialog.
- **The roster is run-scoped, on purpose** (`useAgentSession`): the composer
  panel is a live view of the CURRENT run, newest activity first (actives
  lead, then settled, both newest-first — `selectVisibleSubagents`). It is
  NEVER seeded from on-disk history: run end clears it to empty and it stays
  empty (still-working detached children re-adopt themselves through their
  live frames; `mergeSubagents` refuses terminal frames for unknown ids
  outside a run so late completions cannot resurrect chips). Seeding from
  `extractSubagentHistory` is the removed design that bloated long
  conversations to 20+ stale chips — do not bring it back; past runs stay
  reachable through each task call's in-message summary (TaskResultPanel).
  `get_subagents` snapshots still rehydrate the LIVE roster after SSE
  reconnect (`refreshSubagentRoster`, wired into mount, send, and the
  reconcile poll); the `/subagents` route is now consumed only for its
  `subagentUsage` sum (`refreshSubagentUsage`).
- **On-disk history** (`lib/subagent-history.ts`, `/api/sessions/[id]/subagents*`):
  omp persists each subagent's transcript to the parent session's sibling
  artifacts dir (`<session-dir>/<subagent-id>.jsonl`) and the parent file's
  task toolResults keep `progress[]`/`results[]` snapshots
  (`extractSubagentHistory` still reads them for the route's roster payload
  and usage sum). The transcript route pages the sibling file byte-wise
  (mirroring `get_subagent_messages`, which is RPC-registry-gated and
  refuses files it doesn't know). The dialog reads only the final output —
  `<id>.md` via `?mode=completion` (bounded tail read that also works for
  transcripts beyond the 16MB paging cap) with a live `get_subagents`
  snapshot fallback for header enrichment; it never pages the raw
  transcript. Subagent ids are `[A-Za-z0-9_-]{1,80}` — the route validates
  before joining to confine reads to the sibling dir.
- **In-message task summary** (`components/MessageView.tsx` TaskResultPanel):
  the session reader allowlists a SIZE-BOUNDED subset of `task` toolResult
  details (telemetry only — no `output`/`stderr`, long text truncated to
  240 chars, `lib/session-reader.ts` `keepTaskToolResultDetails`), and
  expanded `task` tool calls render a per-subagent summary (status, agent,
  task, tokens/cost/duration/model, async marker) above the raw result text.
- **Chip extras**: agent-source labels (`user`/`project`), nested-subagent
  count (`inflightTaskDetails`/`extractedToolData.task` progress), and the
  `⤴` async marker (live `detached` flag or history `details.async`
  presence). Shared formatters live in `lib/subagent-format.ts`.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### Managed projects sidebar (`lib/project-registry.ts`, `/api/projects`)
- The sidebar lists **managed projects**: explicitly added directories (registered in
  `~/.omp/agent/projects.json`, written atomically as temp-file + rename) plus
  session-discovered ones — hidden entries excluded. Removing a project only
  marks it hidden (reversible via re-adding); hidden entries suppress session
  re-discovery.
- Registry paths are canonical `projectRoot`s: `POST` resolves worktrees to
  their main repo via `resolveProject`, and `resolveProject` returns the
  symlink-free on-disk form for plain directories so registered and
  session-discovered paths compare equal on Windows casing.
- `GET /api/projects` re-authorizes registered roots with `allowFileRoot()` —
  the in-memory browse allowlist does not survive restarts, and empty managed
  projects derive no root from sessions.
- The client sorts the merged list by most-recently-added (registration
  order), then by path for session-discovered projects
  (`lib/project-ordering.ts`); the order deliberately does NOT depend on
  session activity, so project rows never jump around while sessions refresh.
  Expanded project paths live
  in `localStorage` (`cody:expanded-projects`, see `lib/storage-keys.ts`), defaulting to only the
  active/restored project expanded, and stale keys are pruned against the
  current project list (only after the first project fetch — an empty
  still-loading list must never wipe storage).
- Each project's session tree is capped at 5 roots with a show-more toggle;
  project rows are cards matching the session items' height/margins/accent
  treatment, and the active project's worktree selector renders directly
  below its row.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/omp-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.

### Session list caching — new sessions must appear immediately
- `listAllSessions()` (sidebar, command palette) is cached twice: a 30s TTL
  list cache in `lib/session-reader.ts` plus an mtime-keyed directory walk in
  `lib/omp/session-files.ts` (`listSessionFiles`).
- The walk cache keys on the **sessions root** mtime. On Windows/NTFS a new
  `.jsonl` inside an existing project subdirectory does NOT bump the root
  mtime, so the walk stays stale indefinitely.
- `invalidateSessionListCache()` (fired on `agent_end`, `session_info_update`,
  compaction, renames) must therefore ALSO clear the walk cache via
  `invalidateSessionFileListCache()` — never add a session-mutation path that
  forgets this. Regression test: `session-reader.test.mjs`.
- **No cache fixes a file that does not exist yet.** A brand-new session has
  no `.jsonl` until its first message is *persisted* — measured at ~5s after
  `agent_start` against omp, and unbounded in principle. Until then the
  session cannot be listed from disk at all, so the sidebar's row exists only
  client-side. `retainPendingSessions()` (`lib/project-ordering.ts`) keeps
  those rows until the server list reports the same id; the sidebar
  accumulates them rather than rendering only the selected one, which is what
  makes a new session survive the user switching away mid-run. The server
  side still self-heals separately: `signalWhenSessionFileAppears()` in
  `lib/rpc-manager.ts` polls for the file after `agent_start` and re-signals
  the sidebar once it lands.

### Chat scroll-follow
- `useAgentSession` follows the conversation: the effect depends on both
  `messages` (boundaries) and `streamState` (every token batch) and throttles
  to one `requestAnimationFrame` while a run is active (`followScrollFrameRef`).
- A manual scroll-up sets `completionScrollAllowedRef = false` and disables
  following until the next prompt; `scrollUserMsgToTop` handles the
  pending-scroll after sending.
- **A completion never moves a reader.** The terminal reload replaces
  `messages` wholesale and every turn re-realizes its content-visibility
  placeholder, so a reader's kept scrollTop would land on shifted content —
  the "completion ding scrolled me way up" bug. The arming sites
  (finishPromptWithoutStream, agent_end) capture the reader's scrollTop in
  `completionScrollAnchorRef`; the terminal re-pin layout effect restores it
  pre-paint and once more a frame later (followers get pinned to the bottom
  instead, as before). A fresh user wheel/keyboard scroll always wins over
  the re-assert.
- Programmatic smooth scrolling must respect `prefers-reduced-motion`
  (`usePrefersReducedMotion` in `hooks/usePrefersReducedMotion.ts` — also the
  only way to stop SVG SMIL animations, which CSS cannot).

### MCP configuration (`lib/omp/mcp-config.ts`, `/api/mcp`, `components/McpConfig.tsx`)
- Project MCP config resolution order: `.omp/mcp.json`, `.omp/.mcp.json`,
  `mcp.json`, `.mcp.json` at the git top level (falls back to cwd for
  non-git dirs). Server definitions support `stdio`, `http`, and `sse`;
  exactly one of `command`/`url` is required and validated before any write.
- Writes are atomic (temp file + rename), preserve unrelated top-level keys
  (`disabledServers`, `$schema`, ...), and support rename via `previousName`.
- The MCP settings live in their own Settings tab (`SettingsTabs` id `"mcp"`,
  workspace-gated). Server list rows show a config-derived status dot
  (valid+enabled / disabled / invalid) — no live-connectivity probe exists in
  the RPC protocol, so failures surface as toasts (`toast.error`) from the
  editor actions, not inline text.
- The endpoint is guarded by the same allowed-root rules as `/api/files`.

### Plugins and skills
- `/api/plugins` shells out to the user's `omp plugin` CLI (`list/install/uninstall/enable/disable/upgrade`, `--json` where available) — never the Bun-only SDK. `lib/omp/plugin-cli.ts` holds the shared `execFile`/loose-JSON-parse helpers (`runOmpCli`, `parseJsonLoose`), used by both `/api/plugins` and `/api/plugins/marketplace`.
- **Plugin marketplace** (`/api/plugins/marketplace`, `lib/omp/marketplace.ts`, `components/PluginMarketplace.tsx`): browse data is a pure-Node read of `marketplaces.json` (the registry of `omp plugin marketplace add`ed catalogs, at `getMarketplacesRegistryPath()`) plus each marketplace's cached `marketplace.json` catalog (`getPluginsDir()`'s cache dir, `~` expanded) — no child process. `lib/omp/paths.ts`'s `getOmpDataRoot()` is the shared root for both (`~/.omp`, or its XDG equivalent): omp's own `DirResolver` gates XDG activation on the SAME `PI_CODING_AGENT_DIR`-override check for config-root-scoped paths (plugins, marketplaces) as for agent-scoped ones, so `getOmpDataRoot()` reuses the existing `xdgDataAgentRoot()` value rather than re-deriving a separate check — the override disables XDG resolution instance-wide, not per-category. Installed-state (which catalog plugins are already installed, at what version/scope) comes from `omp plugin list --json`, same as `/api/plugins`. Every mutation (add/remove/update marketplace, install/uninstall/upgrade a plugin) shells out to the CLI; name/id segments are validated against omp's own `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$` rule before reaching argv.
- `/api/skills` uses `lib/skills-service.ts`, a pure-Node scanner mirroring the ACTIVE engine's discovery. omp: project `.omp/skills` (walk-up), `~/.omp/agent/skills`, then the `.claude` / `.agent(s)` / `.codex` / `.github` compat dirs and managed skills. pi: a narrower set (`buildPiScanRoots`). Hermes: `buildHermesScanRoots` — see below.
- **The scan is one level deep for every engine but Hermes.** omp's and pi's roots sit inside repos and user config dirs, so a recursive walk there would list every vendored, checked-out or archived `SKILL.md` as a loaded skill. `SkillScanRoot.recursive` is set only by the Hermes branch, whose engine really does `rglob("SKILL.md")`.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives. Hermes is the exception (below) and never has its `SKILL.md` rewritten.
- `/api/skills/install` shells through `npx skills add ... --agent universal`, which installs into the ecosystem-standard `.agents/skills` dirs omp reads; project installs run with the selected cwd. Hermes installs through its own CLI instead (below).
- **Hermes' skills, on Hermes' terms** (`lib/harness/hermes-skills.ts`, verified against 0.19.0). Its roots are `$HERMES_HOME/skills` plus `skills.external_dirs` from its `config.yaml`, each walked recursively — `hermes skills install --category security 1password` writes `skills/security/1password/SKILL.md`, and categories nest further. The walk prunes what Hermes prunes (`.hub`, `node_modules`, VCS/cache dirs, and a skill package's `references/templates/assets/scripts`, the last only when the containing dir is itself a skill). Enable/disable is `skills.disabled` in `config.yaml`, a list of skill NAMES — Hermes never reads the frontmatter key omp honours — and Cody writes it by running Hermes' OWN `skills_config.save_disabled_skills` through the venv interpreter beside the binary, the same "ask the engine's runtime" trick `hermes-settings.ts` uses (`hermes config set` stores scalars only and cannot write a list; `hermes skills config` is a curses checklist). A `platforms:` mismatch hides a skill, as it does in Hermes; `environments:` (kanban/docker/s6) is deliberately NOT replicated, because mis-detecting it would hide a skill that IS loaded. Provenance comes from `<skills root>/.hub/lock.json`, matched on `install_path` first because Hermes keys that ledger by the name it resolved at install time, which is not always the frontmatter `name`.
- **`hermes skills install` exits 0 whether or not it installed.** Verified: a security-scan block prints "Installation blocked: …" and an unresolvable identifier prints "Error: Could not fetch …", both with status 0. `installHermesSkill` therefore reads success from a literal `Installed: <path>` line, and never passes `--force` (that overrides a blocked verdict, which is the user's call in a terminal). Cody's store spec `owner/repo@slug` becomes Hermes' `skills-sh/owner/repo/slug`; a `https://<domain>` whole-provider bundle has no Hermes equivalent and is refused with a reason.
- **The surface reports what it can do.** `GET /api/skills` returns `installScopes` and `canToggle` beside the skills. Hermes has one skills root per home and no project scope, so its store hides the scope selector and `/api/skills/install` refuses `scope: "project"`; Cody's update check diffs a GitHub tree hash from the skills.sh lock, which Hermes' own hashes cannot answer, so every Hermes install reports `canCheckForUpdates: false`, the per-skill Check button and the footer check-all both hide, and the System card says checks are unavailable rather than "up to date".
- **The composer's skill lookup is capability-gated.** `ChatInput` fetches `/api/skills` to dim dormant skills in the `/` palette; it reads `capabilities.skills` off the flag set AppShell threads down. Without that gate, Claude Code and Codex (`skills: false`) ran a full filesystem scan on every `/` keystroke.
- The skill store (`components/SkillsStore.tsx`, `/api/skills/store`, `lib/skills-registry.ts`) talks to skills.sh's public endpoints — `/api/search` (fuzzy for one word, semantic over descriptions for phrases) and `/api/download/{owner}/{repo}/{slug}` for SKILL.md details. The documented `/api/v1/*` surface needs a Vercel OIDC token, so browse views are category-seeded searches, never a scraped ranking. Well-known (non-GitHub) sources install as whole-provider bundles (`https://<domain>`) because the CLI has no per-skill selector for them; the UI says so.

### Update notifications (`/api/omp-update`, `/api/app-update`)
- Automatic in-app self-updating has been removed in favor of explicit user notifications and manual terminal commands.
- `GET /api/app-update` returns `updateAvailable`, the exact terminal command, and `managedBy` naming the channel that ships to this deployment. A container install (detected via `/.dockerenv`) is compared against the latest `nphil/Cody` GitHub release and updated with `docker pull ghcr.io/nphil/cody:latest`; anything else queries the npm registry for `@nphil/cody` and uses the detected install manager (`bun` vs `npm` via `detectInstallMethod`), e.g. `npm install -g @nphil/cody` or `bun add -g @nphil/cody`.
- `POST /api/omp-update` (`action: "check"`) runs `omp update --check` and returns `updateAvailable` plus `updateCommand: "omp update"`.
- `POST /api/omp-update` (`action: "restart"`) restarts active OMP sessions after a manual CLI update.
- Notifications in `AppShell` and settings cards in `SettingsConfig` present the update notification alongside copyable terminal update commands.

### Model orchestration: roles, plans, chains, resets
- **omp's out-of-the-box behavior is the baseline.** With no `modelRoles` in
  config.yml, omp resolves each role from built-in priority lists
  (src/priority.json: `smol`/`slow`/`designer` chains; `tiny` reuses smol,
  `advisor` reuses slow; everything else follows the default model). "Reset to
  OMP defaults" therefore DELETES overrides rather than writing anything:
  `DELETE /api/model-roles` (drops `modelRoles`), `DELETE /api/omp-settings`
  `{sections:["retry"]}` (whole retry block), `DELETE /api/model-plan` (only
  what a plan writes: roles + `retry.fallbackChains` + `usageAwareFallback`,
  keeping unrelated retry tuning). Deletion allow-lists live in
  `lib/omp/settings-config.ts` (`RESETTABLE_SECTIONS`/`RESETTABLE_PATHS`).
- **Config reaches live sessions via restart, not osmosis.** An omp child
  reads config.yml once at spawn (only subagent preflight reloads it), so
  plan-apply and every reset call `restartIdleRpcSessions()` (rpc-manager):
  idle children are destroyed and reconnect on demand with the new config;
  running turns are never killed and finish on the old one. Responses carry
  `{restarted, active}` and the UI toasts say so.
- **Ladder tiering** (`lib/model-plan/derive.ts`): the heuristic plan ranks
  providers direct → gateway → local. A gateway (OpenRouter-style aggregator)
  is detected from evidence, not a brand list — most of its model ids are
  themselves vendor-prefixed (`openrouter/anthropic/claude-…`), so
  `gatewayProviders()` flags providers where >half the ids contain a slash.
  `bestAvailableModel` shares the tiering so a gateway's rebadged frontier
  model never drives main turns while a direct subscription exists; the
  provider already assigned to the `default` role leads its tier
  (`preferredProvider`, passed by the model-plan route). Enabled-model
  curation applies automatically: the roster comes from
  `get_available_models`, which omp already filters by `enabledModels`.
- **Fallback switches announce themselves**: omp's `retry_fallback_applied`
  ({from, to, role}) and `retry_fallback_succeeded` ({model, role}) frames
  surface as toasts in `useAgentSession` (i18n `agentSession.fallback*`).
- **Trap — `patchSection` in SettingsConfig.tsx** must spread the SECTION
  (`base?.[key]`), never the whole settings object; the whole-object spread
  filled config.yml sections with junk top-level keys after the first save.
- **omp 17.4 compaction**: `compaction.strategy`/`remoteEnabled` no longer
  exist upstream — `compaction.methodOrder` (ordered preference list)
  replaced them. `settings-config.ts` reads legacy keys through omp's own
  migration mapping and deletes them when writing `methodOrder`.
- Retry/fallback UI lives in `components/settings/RetryFallbackPanel.tsx`
  (see its module comment for the never-persist-an-empty-chain rule).

### Auth and model config
- Auth flows go through RPC commands (`get_login_providers`, `login`) against the omp child process; credentials live in omp's `agent.db` (SQLite) which Cody never touches directly.
- The Models panel reads and writes `models.yml` in the omp agent directory (`~/.omp/agent/models.yml`, `.yaml` fallback).
- API-key status endpoints must never return the raw key.

### RPC transport limit — the utility process MUST negotiate v2
- omp's NDJSON transport caps one logical frame at 1 MiB. At protocol **v1** it
  cannot chunk, so it replaces any oversized reply with a failed response
  carrying `"RPC response exceeded the transport limit"`. Protocol **v2**
  chunks (`lib/omp/rpc-frame.ts`, reassembled by `RpcProcess`).
- `get_available_models` grows with the provider catalog: measured 502 models /
  1,058,841 bytes on a real install (466 from a single OpenRouter key) — just
  over the limit. The session path always negotiated; `lib/omp/rpc-utility.ts`
  did not, so `/api/models` failed and the composer showed a bare "Model error"
  banner with an empty list. **Both** `startProcess` and
  `runIsolatedUtilityCommand` now negotiate; `rpc-utility.test.mjs` guards it.
  Engines that do not advertise v2 are never sent the command, so a restricted
  dialect (pi) still starts.

### Model curation (`enabledModels`) — omp filters, Cody does not
- omp owns the allow-list: `get_available_models` is already filtered by
  `enabledModels` (omp `session/model-controls.ts`), and entries are **glob
  patterns** matched against `provider/modelId` and bare ids. Cody MUST NOT
  re-filter — a second dialect of the same setting would disagree with omp on
  any hand-written pattern. What `/api/models` returns IS the effective set, so
  the Composer picker, the ten role selects, and fallback chains all shrink for
  free (measured: 502 models → 18, and 5,020 role `<option>` elements → 200).
- **Trap**: because omp filters, a restricted read cannot see what it excluded,
  so curation would be a dead end — no way to find the other 464 OpenRouter
  models to re-add one. `/api/models?catalog=full` therefore runs a throwaway
  utility process with `PI_CONFIG_FILES` pointing at an overlay containing
  `enabledModels: []` (omp's own `--config` layering). The user's `config.yml`
  is never written. `--models` does NOT work for this: it only scopes Ctrl+P
  cycling, while `getAvailableModels()` reads the setting directly.
- Only the curation panel requests the full catalog, and only on mount. The
  main UI never carries it.
- UI shape (`components/ModelsConfig.tsx`): one summary row per provider
  (`openrouter — None of 466 enabled`) plus a per-provider dialog with search,
  bulk enable/disable of the current matches, a rendered-row cap
  (`CURATION_VISIBLE_LIMIT`, so DOM size is constant), and a single PUT on
  confirm. Turning the restriction ON seeds only in-use models
  (`seedAllowList`) — seeding the whole catalog is what wrote hundreds of
  entries into `config.yml` and then demanded hundreds of un-checks.
- A provider whose every model is de-selected keeps its row and stays openable
  (`summarizeProviderCuration` counts totals from the full catalog, enabled
  from the effective list), so switching a provider off is always reversible.
  Pure helpers + tests: `lib/model-allow-list.ts`.

### Brand marks (`components/ProviderIcon.tsx`, `lib/provider-brand.ts`)
- Marks are **vendored path data, never hotlinked**. The composer's model picker
  has to draw identically on a home LAN with no route to the internet, and a
  remote logo that fails to load is exactly the "the icons disappeared" bug this
  replaced. Source is models.dev's own logo set
  (`https://models.dev/logos/<provider>.svg`) — the catalog Cody already reads
  model metadata from. **Trap**: models.dev answers 200 with a generic sparkle
  placeholder for providers it has no mark for (Claude, Ollama, Qwen, Together,
  Fireworks...), so a new mark must be eyeballed, not just fetched; the three
  Cody needs come from simple-icons (CC0) instead.
- Every mark keeps its **source viewBox** (the set mixes 24- and 40-unit grids)
  rather than being rescaled by hand — the browser scales a viewBox for free and
  rewriting Bézier coordinates risks silent distortion. simple-icons draws
  edge-to-edge on a 24 grid while models.dev sits padded inside a 40 grid, so the
  simple-icons marks carry a widened viewBox (`-3 -3 30 30`) to match the optical
  weight of the rest. Detail that turns to mush at 13px is a bug, not a mark:
  prefer a simpler source over a faithful-but-illegible one.
- **`ProviderIcon` is a provider; `ModelIcon` is a model's VENDOR.** A gateway is
  not a vendor — every model behind one OpenRouter key reports
  `provider: "openrouter"`, so keying rows off the provider paints one identical
  mark down hundreds of rows. `modelBrand()` reads the vendor off the model id,
  by explicit prefix (`anthropic/claude-sonnet-4`) then by family name
  (`gpt-…`, `qwen…`), and only then falls back to the provider. That fallback
  order is also what gives a local runtime's models real marks: `llama-swap`
  is an unknown provider, but its `gemma4-*` / `qwen3.5-*` models still draw
  Gemini and Qwen.
- An unmapped provider draws a neutral `Bot`, never a broken image. Adding a
  provider is two edits: an id → brand entry in `lib/provider-brand.ts` and the
  mark in `BRAND_MARKS`. Tests: `lib/provider-brand.test.mjs`.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

## omp Session File Format (v3)

Location: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"title","v":1,"title":"...","source":"...","updatedAt":"...","pad":"   ..."}   ← fixed 256-byte slot
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"...","modelId":"...","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
```

- Line 1 is a fixed-width 256-byte padded title slot, rewritable in place.
  Old pi files may lack it — the `{"type":"session"}` header is then line 1.
- Entries form a tree via `(id, parentId)`. Additional entry types
  (`title_change`, `session_init`, `mode_change`, `ttsr_injection`, ...) must
  be tolerated by readers.
- Large payloads (images) are externalized to the content-addressed blob store
  at `~/.omp/agent/blobs` and referenced from entries.

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## Design Tokens & UI Kit (`app/globals.css`, `components/ui/`)

Warm-paper (light) / warm-ember (dark) palettes; every text/background pair is
WCAG AA-verified (measured ratios noted in `globals.css` comments). Components
must consume these variables — no hardcoded colors.

```
color:  --bg --bg-panel --bg-hover --bg-selected --border --bg-subtle
        --text --text-muted --text-dim
        --accent --accent-strong --accent-hover   (links / filled buttons / hover)
        --user-bg --tool-bg
type:   --font-serif (display headings, class .display-serif)  --font-mono
shape:  --radius-control (8) --radius-card (12) --radius-modal (16)
depth:  --shadow-card --shadow-pop --shadow-modal
motion: --dur-fast (150ms) --dur-med (220ms) --dur-slow (320ms) --ease-out-warm
```

`components/ui/` holds the shared primitives (built on `@base-ui/react`):
`primitives.tsx` (Dialog/Tooltip/Collapsible), `field.tsx` (form fields +
ConfirmDialog), `toast.tsx` (`toast.success/error/info`, mounted in AppShell).
Icons come from `lucide-react` — do not add new inline SVGs. The command
palette (`components/CommandPalette.tsx`, ⌘K/Ctrl+K) is built on `cmdk`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
