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
  auth/**                         provider list, login/logout, API keys (via RPC)
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  git/status/route.ts             GET repo status + branch/ahead-behind for a cwd
  git/diff/route.ts               GET one file's HEAD->worktree patch
  info/route.ts                   GET server facts for the Info panel
  tasks/route.ts                  GET .cody/tasks.json (validated)
  tasks/run/route.ts              POST run a task by id into a new terminal
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml
  models-config/test/route.ts     POST test a configured model/provider
  omp-settings/route.ts           GET/PUT native config.yml settings (allow-listed)
  omp-settings/schema/route.ts    GET omp's own settings schema + values; PUT a dotted-path patch
  mcp/route.ts                    GET/POST/PUT/DELETE project MCP servers
  plugins/route.ts                GET/POST plugin management (shells out to `omp plugin`)
  projects/route.ts               GET registered+discovered projects | POST add | DELETE hide
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/store/route.ts           GET browse/search/detail | POST card descriptions (skills.sh registry)
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  omp/                 shared omp foundations (paths, CLI probe, RpcProcess)
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
    engine-tools.ts    bundled display-MCP launch config for Claude (JSON) / Codex (TOML)
    access.ts          authorizeDisplaySession(): request auth for display routes
    csp.ts             buildContentSecurityPolicy(): loopback + this host's
                       private LAN/CGNAT frame-src/connect-src for proxy.ts
  file-access.ts       allowed file roots for /api/files and worktrees
  harness/             pluggable engine seam: adapters (omp/claude/codex), runtime
                       selection state, turn-based sessions + stream translators,
                       session index, binary probe + on-demand install (docs/harnesses.md)
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for agent/RPC objects
  preview-url.ts       loopback preview URL rules: normalize/extract/probe
  preview-autoopen.ts  when an assistant-mentioned URL auto-opens the Preview panel
  preview-screenshot.ts server-side headless-Chromium capture of loopback apps
  project-ordering.ts  pure project sort/group/activity helpers (client + tests)
  project-registry.ts  on-disk managed-project registry (~/.omp/agent/projects.json)
  rpc-manager.ts       session registry + startRpcSession over RpcProcess
  session-reader.ts    session .jsonl parsing + path cache + buildSessionContext
  skills-service.ts    pure-Node skill discovery mirroring omp's providers
  skills-registry.ts   client for the public skills.sh registry endpoints (the
                       same ones `npx skills` uses): category browse, fuzzy/
                       semantic search, cached SKILL.md detail extraction
  storage-keys.ts      the cody: browser-storage namespace + legacy migration
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
  ModelsConfig.tsx    modal for models/auth configuration
  McpConfig.tsx       project MCP server editor (Settings → MCP tab)
  PluginsConfig.tsx   modal for installed plugins
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
  useTheme.ts              theme state (localStorage key "omp-theme")

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
full-featured), Claude Code and Codex (experimental, turn-based). Full
architecture: `docs/harnesses.md`. The load-bearing rules:

- `getHarness()` resolves persisted selection (`cody-engine.json`) →
  `CODY_HARNESS` env → omp. `selectHarness(id)` persists a switch; the
  select route then calls `restartAllRpcSessions()`.
- **Cody-level state always lives in the instance data dir** (`lib/omp/paths`
  `getAgentDir()`): accounts, checkpoints, engine selection, session owners,
  the engine session index, the tools prefix. Never route these through the
  active adapter's `getAgentDir()` — they must survive engine switches.
- Non-omp live chat: `TurnEngineSession` spawns one CLI process per turn
  (`claude -p --output-format stream-json` / `codex exec --json`), and
  `claude-stream.ts`/`codex-stream.ts` translate NDJSON into the pi event
  vocabulary. Commands beyond prompt/abort/get_state/get_messages throw code
  `"unsupported"` — the UI tolerates that by design. Session metadata for
  these engines lives in `cody-engine-sessions.json`
  (`lib/harness/engine-sessions.ts`), keyed by Cody session id; ownership
  uses the same session-owners sidecar as omp.
- Capability flags (`HarnessCapabilities`, including `chatExtras`) gate UI
  surfaces: a `false` **hides** the settings tab / panel card / composer
  control, it never renders a broken one. `/api/info` serves the active
  engine's capabilities to the client.
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
- **The seam is CI-enforced** (`lib/architecture.test.mjs`): outside
  `lib/omp/` and `lib/harness/`, importing `lib/omp/*` fails the test unless
  the file is on the in-test allowlist with a written reason, stale allowlist
  entries fail too (the list only ratchets down), and the adapter/translator
  modules (`harness/omp|claude|codex|*-stream`) are private to the seam —
  everything else goes through `@/lib/harness` or its engine-neutral
  submodules. New engine-neutral code must NOT import `lib/omp` directly;
  route it through the harness (capabilities, adapter methods, or the engine
  dispatch pattern in `app/api/sessions/route.ts`).

## Settings: schema-driven, not hand-listed

Cody renders OMP's settings from OMP's own schema, so a setting added upstream
appears without a Cody change.

- `lib/omp/settings-schema.ts` — reads `<omp package>/src/config/settings-schema.ts`.
  There is **no settings-schema RPC command**, so it goes through the installed
  package's source. That file imports Bun-only siblings, so every import is
  aliased to a permissive Proxy stub and jiti transpiles it. The stub must return
  `undefined` for `then`, or the module becomes thenable and the load hangs
  forever on an unsettled top-level await. Credentials, `ui.secret` settings, and
  settings without `ui` metadata never reach the browser.
- `lib/omp/settings-values.ts` — generic read/write for any schema-declared path.
  Dotted paths persist nested (`prewalk.enabled` → `prewalk: { enabled }`), the
  form OMP's own resolver reads. Unknown paths are rejected, not written.
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
- Host tools exist only on omp's rpc-ui protocol; turn engines (Claude Code /
  Codex) get the assistant-text detection path here, plus `open_preview` via
  the bundled display MCP server (see `lib/display/` below).

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
  `publishDisplayRequest`. Claude/Codex get the bundled stdio MCP server
  (`bin/cody-display-mcp.js`) via `lib/display/engine-tools.ts` —
  `--mcp-config` JSON for Claude, `-c` TOML args for Codex.
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
- **Roster hydration**: `get_subagents` snapshots (which carry progress)
  rehydrate the roster after SSE reconnect (`refreshSubagentRoster`, wired
  into mount, send, and the reconcile poll). Terminal subagents vanish from
  the RPC registry — history fills that gap.
- **On-disk history** (`lib/subagent-history.ts`, `/api/sessions/[id]/subagents*`):
  omp persists each subagent's transcript to the parent session's sibling
  artifacts dir (`<session-dir>/<subagent-id>.jsonl`) and the parent file's
  task toolResults keep `progress[]`/`results[]` snapshots. Cody recovers
  the roster from disk (`extractSubagentHistory`, result fields win over the
  mid-run snapshot), so past/finished runs show in the composer panel after a
  reload. The transcript route pages the sibling file byte-wise (mirroring
  `get_subagent_messages`, which is RPC-registry-gated and refuses files it
  doesn't know). The dialog reads only the final output — `<id>.md` via
  `?mode=completion` (bounded tail read that also works for transcripts
  beyond the 16MB paging cap) with a live `get_subagents` snapshot fallback
  for header enrichment; it never pages the raw transcript. Subagent ids are
  `[A-Za-z0-9_-]{1,80}` — the route validates before joining to confine reads
  to the sibling dir.
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
- `/api/plugins` shells out to the user's `omp plugin` CLI (`list/install/uninstall/enable/disable/upgrade`, `--json` where available) — never the Bun-only SDK.
- `/api/skills` uses `lib/skills-service.ts`, a pure-Node scanner mirroring omp's discovery order: project `.omp/skills` (walk-up), `~/.omp/agent/skills`, then the `.claude` / `.agent(s)` / `.codex` / `.github` compat dirs and managed skills.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent universal`, which installs into the ecosystem-standard `.agents/skills` dirs omp reads; project installs run with the selected cwd.
- The skill store (`components/SkillsStore.tsx`, `/api/skills/store`, `lib/skills-registry.ts`) talks to skills.sh's public endpoints — `/api/search` (fuzzy for one word, semantic over descriptions for phrases) and `/api/download/{owner}/{repo}/{slug}` for SKILL.md details. The documented `/api/v1/*` surface needs a Vercel OIDC token, so browse views are category-seeded searches, never a scraped ranking. Well-known (non-GitHub) sources install as whole-provider bundles (`https://<domain>`) because the CLI has no per-skill selector for them; the UI says so.

### Update notifications (`/api/omp-update`, `/api/app-update`)
- Automatic in-app self-updating has been removed in favor of explicit user notifications and manual terminal commands.
- `GET /api/app-update` returns `updateAvailable`, the exact terminal command, and `managedBy` naming the channel that ships to this deployment. A container install (detected via `/.dockerenv`) is compared against the latest `nphil/Cody` GitHub release and updated with `docker pull ghcr.io/nphil/cody:latest`; anything else queries the npm registry for `@nphil/cody` and uses the detected install manager (`bun` vs `npm` via `detectInstallMethod`), e.g. `npm install -g @nphil/cody` or `bun add -g @nphil/cody`.
- `POST /api/omp-update` (`action: "check"`) runs `omp update --check` and returns `updateAvailable` plus `updateCommand: "omp update"`.
- `POST /api/omp-update` (`action: "restart"`) restarts active OMP sessions after a manual CLI update.
- Notifications in `AppShell` and settings cards in `SettingsConfig` present the update notification alongside copyable terminal update commands.

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
