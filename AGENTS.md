# Cody - Development Notes

> Owner workflow preferences (release discipline, delegation/token strategy,
> deployment context) live in **CLAUDE.md**; this file is the codebase map.

> **This file is a map, not the manual** — it loads into every chat. It keeps the architecture, the File Map and,
> per area, the rules whose breach already caused a bug. The full original text of each section is in
> `docs/agents/<topic>.md`, named on that block's `Details:` line: open it before changing that area. New or
> changed rules go in full into that file, with one short line here; list new files in the File Map.

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
Tests: `npm test` (`scripts/test.mjs`) — runs the whole suite under a private
`TMPDIR` that is deleted afterwards, because many tests `mkdtemp` and never
remove what they made (one run used to leave ~50 dirs in `/tmp`). Add new test
globs to its `SUITES` list.
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

Every path, one line each; the full descriptions are in `docs/agents/file-map.md`.

```
app/api/
  sessions/route.ts  GET list sessions
  sessions/[id]/route.ts  GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= leaf context
  sessions/[id]/export/route.ts  GET export HTML
  sessions/[id]/media/route.ts  GET deferred tool-result image
  sessions/[id]/scheduled/route.ts  GET/POST scheduled messages
  sessions/[id]/scheduled/[itemId]/route.ts  PATCH/DELETE item
  sessions/[id]/scheduled/[itemId]/send-now/route.ts  POST send now
  sessions/[id]/btw/route.ts  GET /btw topics (omp only)
  preview/screenshot/route.ts  POST loopback URL screenshot
  agent/new/route.ts  POST start agent
  agent/[id]/route.ts  GET state / POST RPC command
  agent/[id]/events/route.ts  GET SSE stream
  agent/[id]/recover-model/route.ts  POST reopen chat, model gone
  agent/running/events/route.ts  GET SSE running session ids
  agent/[id]/display/route.ts  POST/GET display request (auth-gated)
  agent/[id]/display/events/route.ts  GET SSE display requests
  sidebar-chats/route.ts  GET sidebar chats
  sidebar-chats/[id]/route.ts  DELETE sidebar chat
  internal/display/route.ts  POST engine MCP display (internal/*: capability-token auth)
  internal/scheduled/route.ts  POST ACP scheduling tools
  internal/messaging/route.ts  POST ACP send_to_chat
  internal/model-switch/route.ts  POST ACP switch_model
  auth/**  omp login flow via RPC; `unsupported` unless omp
  cwd/validate/route.ts  POST validate cwd
  cwd/browse/route.ts  GET list subdirectories
  cwd/mkdir/route.ts  POST create folder
  default-cwd/route.ts  POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts  GET file for viewer
  git/status/route.ts  GET repo status
  git/diff/route.ts  GET one file's patch
  info/route.ts  GET Info panel facts
  todo/route.ts  GET/POST .cody/todo.json
  tasks/route.ts  GET .cody/tasks.json
  tasks/run/route.ts  POST run task in terminal
  home/route.ts  GET home directory
  models/route.ts  GET models; ?catalog=full omp only
  models/new/route.ts  GET never-shown models; ?cached=1 no spawn
  models/seen/route.ts  GET/POST seen ledger (POST admin)
  models/visibility/route.ts  GET/PUT model hide/pin; instanceHidden not on omp
  models-config/route.ts  GET/PUT models.yml (omp only; settleProviderChange)
  models-config/test/route.ts  POST test model (omp only)
  omp-settings/route.ts  GET/PUT omp config.yml (configEditor)
  omp-settings/schema/route.ts  GET/PUT engine-neutral settings schema
  settings-seen/route.ts  GET/POST new engine settings
  mcp/route.ts  GET/POST/PUT/DELETE MCP servers
  homelabber/route.ts  GET HomeLabber origin (CODY_HOMELABBER_URL)
  provider-keys/route.ts  GET key catalogue / PUT key (admin)
  providers/route.ts  GET Providers hub list; ?cached=1 no spawn
  providers/verify/route.ts  POST Check models (admin, not ACP)
  providers/enable/route.ts  POST clear disabledProviders (omp only)
  plugins/route.ts  GET/POST plugins (`omp plugin`)
  plugins/marketplace/route.ts  GET/POST marketplaces, installs
  projects/route.ts  GET/POST/DELETE projects
  skills/route.ts  GET skills / PATCH enable
  skills/install/route.ts  POST install (npx skills add)
  skills/store/route.ts  GET/POST skills.sh store
  worktrees/route.ts  GET/POST/DELETE git worktrees
  forge/route.ts  GET code hosts, tokens redacted / PUT/DELETE admin
  forge/[id]/test/route.ts  POST test connection
  distill/route.ts  POST SSE summary (canAccessSession)
  distill/config/route.ts  GET/PUT Distill model chain (not ACP)
  notifications/route.ts  GET/PUT push settings
  notifications/test/route.ts  POST test push
  notifications/presence/route.ts  POST chat tab shows
  notifications/action/route.ts  POST PUBLIC ntfy button (signed token)
  daily-limit/route.ts  GET/PUT daily time limit
  daily-limit/beat/route.ts  POST active-use stretch
  machines/route.ts  GET/PUT metered machines (PUT admin)
  machines/stream/route.ts  GET SSE machine status
  machines/test/route.ts  POST ssh sample (admin)
  machines/worker-check/route.ts  POST read a worker's /etc/cody-worker.json over ssh (admin)
  internal/workers/route.ts  POST ACP run_on_worker (ndjson progress; capability-token auth)
  statistics/route.ts  GET usage stats / ?session=
  ../statistics/page.tsx  Statistics page
  disk/route.ts  GET disk meters; POST clean, PUT (admin)
  engine-db/route.ts  GET status / POST check|repair of omp's agent.db (admin, omp only)
  claude-credits/route.ts  GET/PUT/DELETE Claude backup keys (omp, admin)
lib/
  omp/  shared omp foundations: paths, CLI probe, RpcProcess, marketplace.ts, plugin-cli.ts, isolated-agent-dir.ts, homelabber-base.ts, cody-launch-defaults.ts (+ .yml layers), gc-strip.ts (omp gc --strip), services.ts (omp ps)
  claude-credits.ts  browser-safe Claude API credits types/selectors; server half omp/claude-credits.ts, omp/claude-credits-store.ts, omp/claude-credits-overlay.ts, routing/credits-cover.ts
  agent-client.ts  typed fetch helper for /api/agent
  time-zone.ts  pure zone rules: resolveTimeZone, formatLocalTime, describeLocalNow
  time-zone-prefs.ts  server only: stored zones, zoneForMessage, ownerTimeZone
  tool-time.ts  formatToolTime(): how host tools write a time
  notifications/  ntfy push; catalog.ts browser-safe, server only: store.ts, recipients.ts, presence.ts, observer.ts, compose.ts, dispatch.ts, ntfy.ts, tokens.ts, answer.ts, quota-watch.ts
  device-time-zone.ts  browser: deviceTimeZoneField()
  daily-limit/  daily time limit; pure: active-time.ts, ledger.ts, state.ts, view.ts; store.ts server only
  draft-store.ts  composer drafts: memory plus sessionStorage text
  homelabber-approval.ts  pure half of HomeLabber approvals in chat
  image-compress.ts  browser-side image batch preparation
  image-attachments.ts  server validation of base64 image payloads
  context-usage.ts  idle/reconnect gauge usage from messages
  env.ts  readEnv(): CODY_* config with OMP_WEB_* fallback
  display/  universal display/preview surface
    types.ts  DisplayRequestV1, DisplayCandidate, bus events
    validation.ts  loopback http(s) URL normalization
    bus.ts  per-session latest+listeners; publish/subscribe/alias
    capability.ts  HMAC session-scoped display/to-do tokens
    provider.ts  RasterWebProvider: puppeteer-core JPEG WS stream
    native-gateway.ts  candidate ranking; CODY_PREVIEW_BASE_URL proxy
    engine-tools.ts  display/to-do MCP launch descriptors
    access.ts  authorizeDisplaySession()
    csp.ts  buildContentSecurityPolicy() for proxy.ts
  forge/  code hosts: GitHub and Gitea
    config.ts  cody-forge.json: hosts, tokens, update source
    client.ts  fetch-based client over both hosts
    tool.ts  `forge` host tool (omp only; lib/rpc-manager.ts, bin/cody-display-mcp.js)
  disk/  disk hygiene: scratch.ts, janitor.ts, sweep.ts, walk.ts, transcripts.ts, mentions.ts, gate.ts, status.ts, settings.ts; no `@/`
  machines/  top-bar meters + worker state; browser-safe types.ts/present.ts; server only proc.ts, ssh.ts, store.ts, sampler.ts, jobs.ts (job counts + checks on globalThis); no `@/` (bin/cody-server.js)
  workers/  `run_on_worker`: tool.ts (definition + runOnWorker), run.ts (one job), scheduler.ts (FIFO queue), placement.ts, health.ts (check + monitor), facts.ts, files.ts, tarball.ts, transfer.ts, execute.ts, remote.ts, shell.ts (the ssh seam), output.ts, progress.ts, local.ts, format.ts, live.ts, types.ts; no `@/`; tests use local-shell.mjs
  engine-guard.ts  requireEngine()/requireCapability(): omp-only routes 400
  file-access.ts  allowed file roots for /api/files and worktrees
  distill/  Distill server half
    config.ts  cody-distill.json: fallback chain
    prompts.ts  prompts, head/tail clamp, thinking normalizer
    cache.ts  finished summaries per session
    runner.ts  engine support, fallback chain, queue
  distill-preferences.ts  browser-local Distill preferences
  harness/  pluggable engine seam: adapters, transports, probe/install (docs/harnesses.md)
    housekeeping.ts  hourly cleanup: lib/disk/janitor.ts, lib/omp/temp-files.ts
    pi-settings.ts  pi settings from its docs/settings.md; HarnessAdapter.settings
    provider-catalog.ts  provider → env-var catalogue; providersForEngine()
    provider-keys.ts  Cody provider credentials store; engineChildEnv()
    cli-login.ts  runCliLogin(): engine login in node-pty
    claude-login.ts  `claude auth` login/status/logout
    codex-login.ts  `codex login` device auth/status/logout
    omp-credentials.ts  omp credentials via bin/cody-omp-credentials.mjs; lib/omp/provider-login.ts
    omp-claude-credits.ts  Claude API keys in omp store; bin/cody-omp-claude-credits.mjs
    pi-login.ts  pi OAuth flows via bin/cody-pi-login.mjs
    login-channel.ts  FIFO channel for pasted sign-in values
  file-paths.ts  client/server path encoding helpers
  markdown.ts  shared markdown helpers
  message-rate.ts  the one output-token throughput computation
  model-display.ts  display-only model-label formatter
  npx.ts  npx runner for skill install
  permission-request.ts  client readers for ACP approval requests
  pi-types.ts  structural types for agent/RPC objects
  preview-url.ts  loopback preview URL normalize/extract/probe
  preview-autoopen.ts  when a mentioned URL auto-opens Preview
  preview-screenshot.ts  server-side Chromium capture of loopback apps
  project-ordering.ts  pure project sort/group/activity helpers
  page-wake.ts  one debounced "page woke up" event (visible/focus/pageshow/online/resume/clock jump)
  live-stream.ts  EventSource that reopens after refusal/silence; reopen() on wake
  sidebar-prefs.ts  sidebar prefs parse/serialize + PrefStore
  on-demand-mcp/  load-on-demand registry + small MCP client (extension-side, Node built-ins only)
  omp/on-demand-mcp.ts, omp/on-demand-chats.ts  on-demand registry store; per-chat computer flag
  omp/extensions/cody-on-demand-mcp.ts  `load_tools` extension
  omp/engine-db.ts  engine database health service (check, guarded repair, push)
  usage/reading-age.ts  age of a usage reading from omp's own fetchedAt
  project-registry.ts  managed-project registry (projects.json)
  provider-brand.ts  provider id → brand/mark; modelBrand()
  provider-directory.ts / provider-directory-server.ts  Providers hub rows; composeProviderDirectory is server-only
  provider-state.ts  settleProviderChange: forget provider caches; called by providers/enable
  model-allow-list.ts  omp `enabledModels` helpers; modelKey()/providerGlob()
  model-catalog-full.ts  unrestricted omp catalog (`/api/models?catalog=full`)
  model-catalog-seen.ts  "seen" ledger for new models
  settings-new-keys.ts  pure Settings "New" badge rules
  settings-seen.ts  Settings "New" ledger
  settings-new-reporter.ts  browser batching/dwell for New reports
  model-visibility.ts  hidden/pinned models, admin and per user
  models-effective.ts  curated catalog loader; flags `unpriced` rows
  models-dev.ts  the one models.dev reader (hourly cache)
  model-price-fill.ts  fills models.dev prices into models.yml
  composer-model-visibility.ts  browser mirror of the visibility file
  rpc-manager.ts  session registry, host tools, startRpcSession; isolated sidebar chats
  session-tools.ts  cross-session tools: list_sessions, session_status, read_session
  session-acquire.ts  live engine session for unattended work; SessionUnavailableError
  run-recovery/  unattended-run recovery: supervisor.ts journal.ts judge.ts limits.ts text.ts notify.ts shutdown.ts; token-burn guard: burn-detect.ts burn-trail.ts burn-guard.ts
  scheduled/  scheduled send; browser-safe: types.ts client.ts ui.ts sync.ts; server: store.ts service.ts scheduler.ts delivery.ts quota.ts tools.ts notify.ts access.ts
  chat-messages/  chat-to-chat messaging: types.ts registry.ts header.ts delivery.ts tools.ts
  sidebar-context-tools.ts  sidebar workspace tools + session tools
  sidebar-context-budget.ts  per-tool-result size cap for small model windows
  session-active-models.ts  models in use in the current run (quota popup)
  session-namer.ts  model-written session names; omp tiny role only
  session-reader.ts  session .jsonl parsing, resolveSessionPath, listAllSessions
  btw.ts  /btw side questions, pure + browser-safe
  btw-history.ts  server-only reader of omp's btw-history sidecar
  sidebar-mode.ts  Side Bar view state reducer, browser-safe
  skills-service.ts  skill discovery per active engine; getSkillsSurface()
  engine-capabilities.ts  client read of /api/info: capabilities, engine
  skills-registry.ts  client for the skills.sh registry
  storage-keys.ts  cody: storage namespace; engineScopedKey()
  thinking-level-labels.ts  reasoning-level to label-key map
  project-todo.ts  .cody/todo.json schema + mutation (human panel only)
  workspace-tasks.ts  .cody/tasks.json validation + grouping
  tool-presets.ts  PRESET_NONE/DEFAULT/FULL, getPresetFromTools()
  transcript-anchor.ts  reader-pin anchor by transcript identity
  transcript-scroll.ts  pin/unpin and row-anchor scroll rules
  subagent-transcript.ts  bounded page window of the subagent transcript
  types.ts  shared TypeScript types
  normalize.ts  normalizeToolCalls() field-name fix
  worktree.ts  project/worktree resolution, git worktree ops
  statistics/  Statistics page server half; scan.ts, indexer.ts, joblog.ts, oneshot.ts, query.ts, days.ts, sunburst.ts, workers.ts, test-helpers.mjs (plus access/billing/labels/paths/present/rates/request/service/store/types)
  usage/  quota readers; client-merge.ts (browser keeps last good), credential-health.ts (ended logins), last-good.ts (server keeps last good), quota-copy.ts (plain words), reading-age.ts (how old a reading is, when it is out of date)
  model-switch/  agent-requested model switch: resolve.ts (pure), switch.ts, tool.ts
  engine-crash.ts / engine-crash-events.ts / engine-crash-host.ts / engine-crash-log.ts  why an engine stopped on its own; who hears it; cgroup facts; the chat's crash line
  model-presets/roster-check.ts  exact-id check against omp's live roster
  plan-keeper/fold.ts  the plan as a person reads it (checked, summarised, current phase)
  scheduled/model-ui.ts  Send menu "Model" row logic, no React
  notifications/signed-out.ts  notice for an ended provider login
  ask-result.ts  `ask` call/result normalised for the transcript card
  bash-output-meta.ts  omp's meta for cut-down shell output
  extension-title.ts  dock header + body text from a multi-line engine prompt (`extensionPrompt`)
  helper-memory-limit.ts  how big a helper's history may grow (browser- and Bun-safe)
  irc-display.ts  parent-to-subagent IRC messages shown plainly
  task-call-preview.ts  counted phrases for the task-call preview
components/
  AppShell.tsx  layout, URL state, tabs
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx  chat composition + completion sound
  ChatInput.tsx  input bar + model/thinking controls
  SendPill.tsx  Send button; ▾ opens ScheduleMenu
  ScheduleMenu.tsx  send now / quota reset / send-at menu
  ScheduledBar.tsx  scheduled messages bar
  DailyLimitRing.tsx  daily-limit ring + shared glyph
  DailyLimitNotice.tsx  "limit reached" bar
  SidebarChatPanel.tsx  Side Bar shell; images via lib/image-compress.ts
  SidebarSideQuestions.tsx  Side Bar "This chat" view (/btw)
  ComposerPanels.tsx  goal/todo/subagent panels
  GoalPanel.tsx  Goal row of ComposerPanels
  TodoList.tsx  todo phase grid
  SubagentTranscriptDialog.tsx  subagent dialog + steer footer
  SubagentTranscript.tsx  transcript section of that dialog
  MessageView.tsx  one message
  HomelabberApproval.tsx  approval index, useApprovalCard
  CommandPalette.tsx  ⌘K palette (cmdk)
  ImageLightbox.tsx  chat image lightbox
  BranchNavigator.tsx  branch switcher
  DiffView.tsx  unified-diff renderer
  GitPanel.tsx  right-panel Git tool
  todo/
    TodoPanel.tsx  right-panel To-do UI
    TodoItemRow.tsx  memo'd row
    TodoQuickAdd.tsx  top-bar quick add
    useTodoDocument.ts  /api/todo hook
  TasksPanel.tsx  runner for .cody/tasks.json
  PreviewPanel.tsx  right-panel Preview (iframe or stream)
  StreamedDisplay.tsx  streamed-display client
  DisplayWindow.tsx  /display/<sessionId> pop-out
  InfoPanel.tsx  right-panel Info tool
  ChatMinimap.tsx  scroll minimap
  MarkdownBody.tsx  markdown renderer
  InputDock.tsx  non-modal question panel (`ask` walk; one scroll area, sticky buttons)
  ExtensionDialog.tsx  extension select/input requests; lib/ask-walk.ts
  PermissionRequestCard.tsx  ACP approval card in InputDock
  ProviderIcon.tsx  vendored brand marks; never hotlinked
  ModelsConfig.tsx  models.yml editors; in settings/providers/ProviderDetail
  McpConfig.tsx  MCP server editor
  PluginsConfig.tsx  Plugins settings; opens PluginMarketplace
  PluginMarketplace.tsx  marketplace dialog
  SkillsConfig.tsx  Skills settings; opens SkillsStore
  SkillsStore.tsx  skills.sh dialog
  FileExplorer.tsx  sidebar file tree
  FileViewer.tsx  file tab content
  TabBar.tsx  Chat + file tabs
  SettingsTabs.tsx  shared types/constants only
  SettingsConfig.tsx  entry to settings/SettingsShell
  settings/EngineDbSection.tsx  System "Engine database" card (/api/engine-db)
  settings/  Settings dialog ("Settings shell")
    registry.ts  SETTINGS_SECTIONS hub table
    shell-context.tsx  useSettingsShell/useSettingsOpener
    SettingsShell.tsx  dialog, search, leave guard
    SettingsSidebar.tsx / MobileStack.tsx  rail; phone stack
    SettingsSearch.tsx / search-index.ts  search UI + index
    Drawer.tsx  nested-surface primitive
    Directory.tsx  sectioned-row-list primitive
    DangerZone.tsx  destructive-row block
    SaveStatus.tsx  per-hub save indicator
    SegmentedControl.tsx  switch control
    primitives.tsx  NativeSetting, SettingsHighlightContext
    new-badges.ts  "New" badge logic
    EngineRoster.tsx  engine install/update; mode="pick"
    AccountSettings.tsx / AccessTokensSection.tsx / account-controls.tsx  Account hub
    SystemUpdates.tsx  Cody update card
    RetryFallbackPanel.tsx / ModelPlanPanel.tsx  retry chain; plan wizard
    ProviderLoginFlow.tsx  sign-in state machine (SSE)
    panels/  one file per hub, exports SEARCH_ENTRIES
    providers/  Providers hub: ProviderDetail, ClaudeCreditsSection
    models/  Models hub: ModelCatalog, DistillAssignment
    engine/  Behavior hub: RecommendedSettings, SchemaSettingsList
    DiskSection.tsx  System Disk card (/api/disk)
    MachinesSection.tsx  System Machines card (/api/machines); "Use as worker" switch + Check worker
    ServicesSection.tsx  System Services card (omp ps background processes)
    ReplayDataRow.tsx  System Disk "Old chat data" row (omp gc --strip)
    engine/list-draft.ts  list-setting text box to saved list, no React
  machines/  top-bar meters: MachineMeters.tsx, MachinesPanel.tsx (running jobs per worker); machineDisplayName (lib/machines/present.ts)
  statistics/  Statistics page parts: StatisticsPage, ControlsBar, ChartSection, Sunburst, Timeline, Summary, Insights, DeepDive, NodeDetail, StatsTable, Breadcrumb, BottomSheet, Segmented, StatisticsStates, parts.tsx, statistics-css.ts, statistics-query.ts, useStatisticsData.ts
  AskResultPanel.tsx  answers of an `ask` call in the card
  NoticeActions.tsx  buttons under a notice-shelf message
  QuotaAutoSpend.tsx  "spend saved resets automatically" switches in the quota popover
  ScheduleModelPicker.tsx  Send menu's model view
  engine-crash-toast.ts  pop-up for an `engine_crashed` frame
  ui/  shared primitives: Dialog, Tooltip, toast
hooks/
  useSettingsData.ts  Settings route cache (useSettingsRoutes)
  useConfigWriter.ts  sole writer of omp config.yml; useNativeSettings
  useSchemaIndex.ts  indexed engine settings schema; Behavior + search
  useSettingsNewKeys.ts  "New" badge seen/changed reporters
  useModelCatalog.ts  Settings Models row shape
  useLocalAiScan.ts  client for /api/local-ai
  useSettingsHistory.ts  phone settings stack in browser history
  useAgentSession.ts  messages, streaming, SSE, fork
  claude-credits-notices.ts  pure plan-limit to API-credits notices
  useAudio.ts  completion sound, AudioContext unlock
  useDragDrop.ts  shared drag/drop state
  useDisplayRequests.ts  display-request SSE to request state
  usePageWake.ts  run a callback when the page wakes
  useStoredPref.ts  stored flags / id sets over sidebar-prefs
  useMachineMeters.ts  machines SSE page-wide store
  useDailyLimit.ts  daily limit store; useDailyLimitTracker
  useNotificationPresence.ts  POST /api/notifications/presence
  useScheduledMessages.ts  scheduled messages; lib/scheduled/sync.ts
  useSideQuestions.ts  chat's /btw topics; one memoised object
  useSideQuestionsBridge.ts  /btw topics bridge to Side Bar
  useDistill.ts  client store over POST /api/distill
  useIsMobile.ts  responsive breakpoint hook
  useSubagentTranscript.ts  subagent transcript data window
  useTranscriptScroll.ts  follow, reader anchor, edge auto-load
  usePrefersReducedMotion.ts  OS reduce-motion preference
  useTheme.ts  theme state, saved per account
  agent-model-switch.ts  page side of the switch_model tool
  auto-redeem-controls.ts  which auto-spend switches the quota popover offers
  credential-notices.ts  omp's no-sign-in / saved-reset messages as plain facts
  useEngineVersion.ts  active engine version from /api/info
  useHelperLimitConfig.ts  config.yml slice for helper history size
bin/
  cody-server.js  custom server; /api/display/socket WS upgrade
  cody-engine-db.mjs  check/repair omp's agent.db in its own process
  cody-display-mcp.js  stdio MCP server for Claude/Codex engines (incl. run_on_worker → /api/internal/workers)
  cody-pi-login.mjs  pi sign-in helper for lib/harness/pi-login.ts
  cody-omp-credentials.mjs  omp credential list/remove under Bun; never a token
  cody-omp-auth-api.mjs  AuthStorage surface for omp Bun helpers
  cody-omp-claude-credits.mjs  list/add Claude API keys (stdin key)
  cody-session-tail.js  read-only session view; lib/terminal-manager.ts
  cody-omp-reset-cli.mjs  spends a saved reset via `omp usage reset`
```

`desktop/` is a separate top-level tree, not part of the Next.js app above:
a Tauri 2 Rust shell over WebView2, running the server inside a dedicated
WSL2 distro flattened from this image. Own CI
(`.github/workflows/desktop.yml`); full architecture in `docs/windows.md`.

---

## User accounts & auth (`lib/auth/`)
- Accounts are identities, not OS users; `guard.ts` is the one "who is this request" answer; auth required iff password set or any account exists.
- `lib/request-security.ts` blocks cross-site fetch/XHR but ALLOWS cross-site GET/HEAD navigations (else any link into Cody got 403).
- Pass the request to `resolveSessionPathOr404` in every per-session route — owned sessions are owner-only, even admins (else 404).
Details: docs/agents/accounts-auth.md

## Pluggable engines (`lib/harness/`)
- Engine-neutral code never imports `lib/omp/*`; go through `@/lib/harness` (CI: `lib/architecture.test.mjs`); prefer an adapter method over `getHarness()` id branches.
- Capability flags only hide UI; the ROUTE is the boundary (`lib/engine-guard.ts`): use an adapter method or refuse 400 `unsupported`, else omp's data is served as another engine's.
- Transports: omp rpc-ui; ACP (`acp-session.ts`, `AcpEngineSpec` data; Claude Code/Codex; only one with approvals). Per-turn (`turn-session.ts`) is dead code.
- Cody state lives in the instance `getAgentDir()`, never the adapter's; engine-named browser keys use `engineScopedKey()`.
- Two-package engines (ACP adapter + CLI): show `engineOwnVersion()`, check both registries, revert pins both. After login/key removal call `settleProviderChange`.
- `undefined` launch means omp only (`utilityRpcLaunchFor` throws for non-rpc engines) — else omp's models showed as Claude Code's. ACP models/modes are session state.
Details: docs/agents/engines.md

## Settings shell (`components/settings/`)
- `registry.ts` `SETTINGS_SECTIONS` is the source of truth; gate visibility only in `getVisibleSections`/`getVisibleSubViews`, never in a panel.
- Never open a second `Dialog` in a hub — use `Drawer.tsx`/`Directory.tsx`/`DangerZone.tsx` (breaks Escape/focus).
- `useConfigWriter.ts` is the one config.yml writer; `useSettingsData.ts` caches `unsupported` so nothing retries.
- New models stay visible only with all 3: seen ledger (`lib/model-catalog-seen.ts`), `provider/**` globs, hide-set (`lib/model-visibility.ts`).
- `tools.approval.extension` auto-approve never answers provider safety-check or restricted-folder prompts.
Details: docs/agents/settings.md

## Settings: schema-driven, not hand-listed
- Settings come from the ENGINE's declaration via `HarnessAdapter.settings` (`readSchema()`/`write(patch)`); never switch on engine ids — it wrote omp's `config.yml` for others.
- Never hand-list keys; pi is parsed from its `docs/settings.md`; writes are read→mutate→write the WHOLE file.
- `package-source.ts` reads omp source via jiti: stub must return `undefined` for `then` (else hangs); keep `jiti` in `serverExternalPackages`.
- Schema tests MUST run on a REAL omp (`CODY_OMP_BIN`) — they once all skipped.
Details: docs/agents/settings.md

## Key Design Decisions & Traps

### Sidebar chat: a tiny baseline, context on demand, sized for a local GPU
- Small LOCAL models: "hi" once sent 133,559 tokens (AGENTS.md + MCP schemas), now ~726; no omp flag, so need BOTH `sidebarBareCwd()` and `sidebarAgentDir()` (empty `mcp.json`).
- `this.cwd` is the bare dir; real workspace is `WrapperEngineContext.contextCwd`. Budget every tool result (`lib/sidebar-context-budget.ts`); unknown window = SMALLEST.
- System prompt must say the model has NO context yet and must ask.
Details: docs/agents/sidebar-chat.md

### Never reproduce a provider's safety text
- Never write a provider's refusal wording into memory or injected files (`CLAUDE.md`, `RULES.md`) — it returns in later prompts and makes sessions refuse at turn one.
- Paraphrase or name the stop reason/error code; DELETE stored text; tests assert SHAPE, never the wording.
Details: docs/agents/ground-rules.md

### Cody is meant to be SHARED — never ship the owner's environment
- Never hardcode this deployment (hosts, `/data/agent`, registry, MCP servers); use env vars with defaults or a first-run step.
- Never seed config with a provider the user lacks (`seedPayAsYouGoPricesOnce`); a `models.yml` entry without endpoint/models is an OVERRIDE.
- Use Cody's own messages (`isOmpBinMissing`), not engine CLI advice.
- Verify on an EMPTY agent dir, no engine, no credentials.
Details: docs/agents/ground-rules.md

### Human terminal engine launch is entrypoint-scoped
- Engine wrapper only on New Terminal browser PTYs (`TerminalManager.create()`); never in shell profiles/global env — tasks, servers, tool calls stay plain.
- SSH auto-launch guarded in `docker/entrypoint.sh` (`SSH_CONNECTION`, TTY, `CODY_NO_AUTO_ENGINE`).
- Terminal omp pins `update.auto: false` (no self-update).
Details: docs/agents/session-runtime.md

### RPC session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per id in a `globalThis` registry; concurrent `startRpcSession()` share one promise and wait for a RETIRING child (`waitForRetiringChild`) — else a 2nd child split a chat.
- Every awaited ack bounded (`PROMPT_ACK_TIMEOUT_MS`); on timeout recycle child, answer `session_unresponsive` — else `session_busy` forever.
- Never forward a client `sessionId` to a fresh spawn (`/api/agent/new` strips it).
- Live session can MOVE to a new id/file (`notice` `session-persistence`): copy owner/preset state, never rename; re-key once (`noteIdentityChange`).
Details: docs/agents/session-runtime.md

### Push notifications (`lib/notifications/`)
- Answer buttons post a signed token to PUBLIC `/api/notifications/action`; one request/answer/recipient, once; route rebuilds the command from the pending request, never the token.
- A button can only grant ONCE: `toolApprovalSelect` offers only once/deny rows, `cleanUiAnswer` re-checks; never session-wide or ACP `*_always`.
- `observeEvents` is NOT a listener — a permanent listener keeps children alive and hangs host tools.
- Traps: no `@/` imports (bare jiti); state on `globalThis`; ntfy calls fire-and-forget, 10 s timeout, never follow redirects.
Details: docs/agents/notifications.md

### Time zones: the device that sent the message decides (`lib/time-zone.ts`, `lib/time-zone-prefs.ts`)
- Zone = browser that sent THIS message; `resolveTimeZone`: chosen > sender > last-seen > server `TZ` > UTC. Compare canonical names (`normalizeTimeZone`), not raw strings.
- Child `TZ` set only in `engineChildEnv(extra, { timeZone })`; a running process can't change it, so `alignSessionTimeZone` restarts it, never mid-turn.
- omp gets time via hidden `cody-local-time` tail message, never a system-prompt edit (breaks prompt cache); ACP engines: `TZ` + idle respawn only.
- Hide via `isHiddenFromTranscript`; entry readers must use `entryToUiMessage`.
Details: docs/agents/time-and-limits.md

### Agent-driven Preview panel (`lib/preview-url.ts`, `lib/preview-autoopen.ts`)
- Every trigger POSTs `/api/agent/[id]/display`; URLs must pass `normalizePreviewUrl` (loopback only).
- Auto-open once per (session, url); only live `message_end` frames, never history/hydration — so a closed panel doesn't reopen.
Details: docs/agents/display-preview.md

### Preview screenshots (`lib/preview-screenshot.ts`)
- Every capture must fit one RPC frame (1 MiB NDJSON, a dropped result hangs the tool): ladder vs `SCREENSHOT_MAX_BYTES` PNG→WebP→1280→800, else `ScreenshotError("too_large")`.
- Loopback-only via `normalizePreviewUrl` is the SSRF guard — never widen.
- Media route must enumerate images with `isDeferrableToolResultImage` or indexes drift.
Details: docs/agents/display-preview.md

### Universal display/preview surface (`lib/display/`)
- Fidelity ladder `candidates`: `direct` (loopback rung dropped by `ladder.ts` for other clients, never by probe) > `native` gateway > `stream` (always last).
- Do NOT fix auth-gated gateway targets by passing set-cookie through — session fixation.
- CSP (`csp.ts`): no CIDR, emit exact per-interface hosts; not applied to `/api/` responses.
- H.264 traps: `configure` without `description`; close every `VideoFrame`; crop padding; pointer space is CSS px.
- Bus and capability secret are process-local; `displayMcpAcpServer` throws without secret — adapter must catch (a throw aborts `session/new`).
- `.cody/todo.json` is human-only; no agent path.
Details: docs/agents/display-preview.md

### The shared browser (`lib/display/shared-browser.ts`)
- `shared_browser` hands the agent the DevTools endpoint of the Chromium the human watches; published `mode: "stream"` (one candidate), never auto.
- Raster, never H.264 — H.264 can degrade into a different Chromium, stranding the agent's endpoint.
Details: docs/agents/display-preview.md

### Cross-session awareness (`lib/session-tools.ts`)
- Resolve sessions by exact id, then name substring; several matches return candidates, never a guess — a wrong guess is undetectable.
- Snapshot-only; phase from `getLiveSessionPhases()`, never RPC to the other child — it may be wedged and hang the asker.
- Ownership: `filterSessionsForUser`/`canAccessSession`; no recorded owner → `user: null` + `restrictToUnowned`.
- `send_to_chat` (main chats only): `next_step` (default) = steer, `after_turn` = held follow-up; 20 sends/10 min; ACP via `/api/internal/messaging`, trusting `capability.sid` only.
Details: docs/agents/automation.md

### Scheduled messages (`lib/scheduled/`)
- Due message = ordinary user turn via `delivery.ts`; stable `sched-<id>[-<n>]` id; claimed `pending`→`sending` first, removed only once chat STARTED it.
- Queued ≠ delivered: held follow-up dies with engine loss/restart (2 lost 2026-10-08); queued send stays `sending`, `checkHandedOver` asks the ledger.
- Create NEVER calls a model; `putChatOnModel` switches at delivery; a refused switch fails the message, never sent elsewhere.
- No `@/` under `lib/scheduled/`; `scheduler.ts` imports `delivery.ts` lazily; Send is `aria-disabled`, not `disabled` (long press).
Details: docs/agents/automation.md

### Machine meters in the top bar (`lib/machines/`, `components/machines/`)
- Sample only while someone watches (`GET /api/machines/stream`); live state is a page-wide store, never `AppShell` state.
- `checkMachineDestination` is a WHITELIST (value feeds ssh argv and a shell line); remote command is constant `SAMPLE_COMMAND`.
- Never add `-n` to ssh or give its stdin to anything outliving the server — Cody holds that pipe; EOF kills the far loop, even on SIGKILL.
- Errors only a person can fix retry every 5 min (login loops get Cody banned); sampler on `globalThis`; no `@/` in `lib/machines/`.
Details: docs/agents/usage-monitoring.md

### Workers: heavy jobs on other machines (`lib/workers/`, `lib/machines/`)
- `run_on_worker` copies the project to an ssh machine switched on as a worker (Settings › Machines › "Use as worker"), runs the command there niced, streams output as tool progress, copies the named `results` back and deletes the copy. Definition lives ONLY in `lib/workers/tool.ts`; `bin/cody-display-mcp.js` repeats it for ACP and `bin/cody-display-mcp.test.mjs` fails on drift.
- A worker = ssh destination + `/etc/cody-worker.json` + writable `/srv/cody-work`; facts go through `checkWorkerFacts`, never trusted raw. Same ssh rules as the meters: whitelisted destination, constant/`shQuote`d remote commands, NEVER `-n`; the job's ssh stdin is the far side's dead-man's switch.
- Only the exit marker proves a command ended. No start marker = never ran (next worker); start but no exit = dropped: rerun ONCE elsewhere or here, second loss = error. Never report a half result as success.
- Results come back through Cody's own tar reader (`tarball.ts`): regular files/dirs under the named `results` paths only; never `..`, absolute, `.git` or a link out.
- One FIFO queue per server (`globalThis.__codyWorkerScheduler`); busy + `fallbackLocal` (default true) runs here and says so. No `@/` under `lib/workers/`.
Details: docs/agents/workers.md

### Statistics page (`lib/statistics/`, `components/statistics/`, `app/statistics/`)
- Index `cody-statistics/index.json` is derived state; rows and read offsets share one file so a crash never counts bytes twice.
- Subscription = "Plan · estimate"; unknown price = tokens + "Price unknown", never 0 (`billing.ts`, prices learnt in `rates.ts`).
- `access.ts`: only own chats, others' answer 404; `service.ts` never throws; chart needs its `StatsTable.tsx` twin.
Details: docs/agents/usage-monitoring.md

### Overnight runs: stalls, crashes and restarts carry on (`lib/run-recovery/`)
- `superviseRun` observes only (`observeEvents`/`onClose`) — `onDestroy`/`onIdentityChange` are the registry's; state on `globalThis.__codyRunRecovery`.
- Journal entry kept on close only for server shutdown, engine crash or supervisor recycle; max 3 recoveries per chat in 12 h.
- Verdicts: overdue tool (omp only), no frame 10 min + `get_state` unanswered 10 more, no progress 60 min; `tool_execution_update` must never create a tracker entry.
- `CODY_RUN_RECOVERY=0` disables; wedged tools: Docker pids limit — check `/sys/fs/cgroup/pids.events` first.
Details: docs/agents/automation.md

### Token burn: loops and cache storms are stopped (`lib/run-recovery/burn-*.ts`)
- `watchForTokenBurn` (beside `superviseRun`, omp main chats only) observes only; state on `globalThis.__codyBurnGuard`; frames are its clock (one look per 20 s), no timer.
- It reads transcripts, not frames: the chat's `.jsonl` and every helper `.jsonl` under `<session>/`; last 8 MB, re-read when size/mtime/inode changed (omp rewrites the file to stamp a compaction).
- Verdicts (`BURN_LIMITS`): `stuck` 5 useless compactions in a row within 60 requests, `churn` 6 within 12, `rate` 8 requests paying full price for 100k+ tokens in 10 min; evidence under 3 min old, newer than the watch and the last Stop.
- Helper: `cancel_subagent` + steer note; main: `abort` (stays stopped); 3 helpers in 60 min or an uncancellable one still burning stops the run. Chat line = engine-crash row, reason `token_burn` (never `engine_exit`); push = `error`.
- `CODY_BURN_GUARD=0` disables. The numbers were fitted on every transcript on the server (20 of 2,493 stopped): replay before changing one. Helper compaction limits are token counts (200000; deep-task 300000), never percentages; `compaction.experimentalContextManagement` stays off.
Details: docs/agents/automation.md

### Browser-hosted hardware (`lib/devices/`)
- Trust: ONE chat-card permission per device (`answerTrust`; key = USB vendor id + serial); no tool/option/frame grants it, trust PUT refuses `Authorization`; raw tools skip it. Never reuse/widen a grant across sessions; a new USB mode = fresh grant.
- Writes: never replay one after disconnect/cancel/mode change; `context.confirm` only declares risk; ACK/CRC/progress is never readback proof; unknown readback = write once + UNVERIFIED; timeout = unknown completion.
- Boundaries: never burn eFuses or write EDL boot0/boot1/rpmb or table-overlapping partitions; protected ESP/DFU/STM32/STK500 ranges need exact `allow-bootloader`/`allow-spi-boot`; MTK, CMSIS-DAP, UF2 not shipped.
- ADB forward/reverse: "Host" = Cody server `127.0.0.1` only, never LAN; server verifies rules (`riskDeclared`, 16/session); one device listen address = one rule.
- Operations: changing an operation tool means editing `DEVICE_OPERATION_TOOLS` AND `bin/cody-display-mcp.js`; pop-ups only via `noticeForOperation` (news, not progress); no hand-rolled packet loops in `eval`; BLE UUIDs via `canonicalBleUuid` ("0x18f0" breaks `requestDevice`).
- Evidence: emulator-tested only, unverified on real hardware; trust is no go-ahead for a test; `docs/hardware-host-helper.md` is design only.
Details: docs/agents/hardware.md

### Nothing Cody or its engine writes may grow without bound
- Every per-turn/spawn/screenshot store needs a pruner inside Cody (`lib/harness/housekeeping.ts`), never a host cron — leaks hit 21 GB packs, 5.2 GB memory DB.
- Add pruning in the same change as any per-event write; one-shot jobs must not retain memories (ignored overlay switch: 7,700 junk ones got recalled).
Details: docs/agents/disk.md

### Disk hygiene: per-chat scratch, the janitor, the low-disk gate (`lib/disk/`)
- MAIN chats get `TMPDIR`/`CODY_SCRATCH`=`<tmp>/cs/<12 hex>` (`scratch.ts`) plus `CODY_DATA_SCRATCH`; kept across restarts, removed on chat delete/janitor.
- Janitor (`janitor.ts`) is the ONLY cleanup (no host cron); removes a temp entry only if unchanged and unreferenced by process/chat; doubt keeps; never `<tmp>/jiti`.
- Gate (`gate.ts`, `status.ts`): below 5 % free, new work gets 507 `disk_full`; steer/abort still pass so agents can be told to clean up.
- Trap: in omp any extension `tool_call`/`tool_result` handler vetoes `task.speculativeLaunch`; `cody-disk-budget.ts` registers `tool_result` lazily.
- Trap: an extension's `before_agent_start` must NEVER return `systemPrompt` (omp then re-announces the whole xd:// tool catalog as a user message, ~6.6k tokens, every time): return ONE hidden `message`, only when `noteIsLive` says the note is gone (gate, disk rule, context budget, on-demand restore); a new type goes in `HIDDEN_CUSTOM_TYPES` AND `isModelOnlyNote` (`lib/message-display.ts`).
Details: docs/agents/disk.md

### Disk exhaustion is a first-class failure (`lib/disk-space.ts`)
- Full disk = npm `errno -122` (EDQUOT); `describeDiskError()` matches the number. Preflight checks tools prefix AND npm cache; unknown space never blocks.
- `requiredFreeBytes()` = installed size +256 MB; `cleanStaleInstallDirs()` unblocks updates; probe `--version` (npm exit 0 ≠ working).
- Trap: `formatBytes` is in `lib/format-bytes.ts`; client import of `disk-space.ts` pulls `fs`, breaking only `next build`.
Details: docs/agents/disk.md

### Engine database health (`bin/cody-engine-db.mjs`, `lib/omp/engine-db.ts`)
- omp's `agent.db` (logins, settings, caches) is checked by a SEPARATE process a minute after boot, every 6 h (housekeeping) and 30 s after an engine crash; never open it inside the server or an engine (omp < 18.16.0 drops its locks: the 2026-11 damage).
- Damage only in `DERIVED_TABLES` is repaired in place in ONE transaction: abandon the table's schema rows (never DROP: it walks the damaged trees), recreate, reinsert readable rows; commit only if `integrity_check` is clean and every other table hashes the same, else roll back.
- Damage touching logins/settings, an unknown tree or an aborted check is `critical`: never auto-repaired; push `engineDbDamaged` once + Settings › System › Engine database.
Details: docs/agents/disk.md

### Checkpoints must never snapshot a home directory or Cody's own state
- `isUncheckpointableRoot()` refuses home, fs roots, agent/data dir (returns null) — a home workspace made a 3.5 GB shadow repo.
- Tests touching agent-dir state MUST set `PI_CODING_AGENT_DIR` to a temp dir BEFORE importing the module (465 leaked repos).
- Exclude dependency/cache dirs and files >20 MB, NOT `build/`, never tracked files; on failure `cody-backoff.json` skips 6 h.
Details: docs/agents/disk.md

### Two kinds of branching — don't confuse them
- Fork = new independent `.jsonl` (`parentSession`); in-session branch = same file, shared `parentId`, via `/api/sessions/[id]/context?leafId=`.
- Fork-from-here is web command `fork_session`, never `fork` (that's `branch`); omp forks only an IDLE chat.
Details: docs/agents/session-runtime.md

### ToolCall field normalization
- Stored `{type:"toolCall", id, name, arguments}` differs from `ToolCallContent` `{toolCallId, toolName, input}`.
- `normalizeToolCalls()` in `lib/normalize.ts` converts — call it in `session-reader.ts` (file load) and streaming handling.
Details: docs/agents/session-runtime.md

### Event protocol differences vs pi
- omp has no `prompt_done`/`prompt_error`/`compaction_start`/`compaction_end`; completion is `agent_end`, errors are failed RPC responses plus `notice`. Handle or ignore unknown frames.
- `agent_end` rewrite in `rpc-manager.handleFrame` only when `isTerminal !== false` (false = continuation: steer, auto-retry); never simplify.
- Mount notices are for the model: never a toast (on-demand `load_tools` mounts made them spam); never show message `content`.
Details: docs/agents/session-runtime.md

### Todo reminder: quiet, and never over a question
- omp appends a `<system-reminder>` and emits `todo_reminder`; Cody cannot stop it, so `replyAsksUser` (`lib/reply-question.ts`) aborts the continuation when the agent asked; tie new cues to boundaries.
- `foldSystemReminder` renders a slim row at BOTH `entryToUiMessage` and live `message_end`; `display:false` messages are "Engine note" rows, never bubbles.
Details: docs/agents/turn-flow.md

### Live plan keeper (`lib/plan-keeper/`)
- Small model proposes done tasks; `evidence.ts` decides (quote in log, newer than task). Fails soft. Ticks go via `set_todos` AND `cody-plan/<sessionId>.json`.
- Engine keeps `set_todos` in memory only — `syncEngine` re-applies ticks first each pass; read list fresh, change only status, never reorder.
- Serve lists through `applyPlanOverlay`; keep accepting `blocked` (omp 18.8, old chats still have it).
Details: docs/agents/turn-flow.md

### Approval prompts: inline, and the agent owns the buttons
- ACP turn truly blocks on the card; `permission_resolved` is the single removal path; `get_state.pendingPermissions` is the reload path — adopt in `loadSession` and in `reconcileAgentState` BEFORE busy return.
- Render agent's options in its order; `kind` is styling only, `optionId` is identity (two share `allow_always`) — never dedupe/reorder by kind.
- Double-click latch is a ref, not `disabled` state (3 answers measured); read `toolCall` fields defensively.
- omp 18.20 `ask` selects carry the form text before the last title line plus `initialIndex` / `selectionMarker` / `checkedIndices` / `markableCount`; `lib/ask-walk.ts` reads them (ticks come from `checkedIndices`, never guessed). The dock is ONE scroll area with sticky Cancel/Done. The ask is `write xd://ask` on engines that mount it there: test `isAskToolCall` (live) / `askCallInput` (transcript card), never `toolName === "ask"` alone.
Details: docs/agents/approvals.md

### HomeLabber approvals in the chat (`lib/homelabber-approval.ts`, `components/HomelabberApproval.tsx`, `/api/homelabber`)
- Card shows state/links only; Cody never approves. Pending/denied arrive as errors; `useApprovalCard` draws recognised approvals, others stay red.
- `parseHomelabberApproval`: live `structuredContent` rules; never read `items[].data` (secrets); `uncertain` = inspect, never repeat.
- Past `expiresAt` card says "approval window has closed"; only HomeLabber's `expired` says expired. `useDeadlinePassed`: ONE timer only.
- omp MCP timeout 30 s: `approval_wait` `waitSeconds` 0..28. Other installs MUST set `CODY_HOMELABBER_URL`.
Details: docs/agents/approvals.md

### Long tool calls narrate themselves
- `tool_execution_update` text goes to `RunningToolInfo.statusText`; past ~8 s (`LONG_TOOL_THRESHOLD_MS`) status adds it plus elapsed — else `run_watch` looks hung.
- Trap: elapsed clock = plain sibling span, never inside `StatusTextCrossfade` text (per-second flicker).
Details: docs/agents/session-runtime.md

### Composer model + tools controls
- Smart row sends no `set_model` on a new session, so omp resolves `modelRoles.default`; `smartPinnedModel` keeps the label `Smart` while the model matches.
- Live `set_model` waits for a step boundary (`modelSwitchPending`), never mid-stream — on Codex WebSocket it ends the response as an error; `set_thinking_level` is safe any time.
- Never reintroduce an invisible restriction: Core preset (`--tools read,bash,edit,write`) kills `task`/`todo`/`github`/`web_search`; `lib/tool-preset-preference.ts` resets unacked values.
- `classifyFallbackReason` tests refusal FIRST: a refusal pins the fallback for the rest of the run (only a manual re-pick returns); a quota clears itself at reset.
- Word completion (`predict_word`): `POST /api/agent/[id]` NEVER spawns (`getRpcSession`, not `startRpcSession`) — typing rate; `Unknown command`/`unsupported` disables it silently, other errors back off 30 s.
Details: docs/agents/composer.md

### Running state SSE + reconciliation
- Sidebar uses `/api/agent/running/events` through `openLiveStream` (`lib/live-stream.ts`: reopens after a refusal, watchdog on the 30 s heartbeat); `useAgentSession` also polls `GET /api/agent/[id]` while running — catches missed `agent_end`.
- A sleeping phone/tablet is handled by ONE signal: `usePageWake` (`lib/page-wake.ts`) folds visible/focus/pageshow/online/resume/clock-jump into one debounced event; every live surface refetches or reconnects from it. New live surfaces use `usePageWake`, never a private `visibilitychange`/`focus`/`online` listener.
- Sidebar choices persist per browser (`lib/sidebar-prefs.ts`, `cody:sidebar-*` keys); search text is not stored.
- Monotonic run id: ignore late SSE/reconcile replies from an old run — no stale streaming bubbles.
Details: docs/agents/session-runtime.md

### Sending during a run: one pipeline, an outbox, and no silent drops
- Always send `prompt` with `streamingBehavior` to an existing session; a plain prompt while streaming is acked, then fails AgentBusyError — message vanishes.
- Every send has `clientMessageId` and a ledger; never prune unsettled rows (reads `unknown`, gets resent); Resume/Retry check the ledger first, lookup failure never resends.
- Outbox (`lib/outbox.ts`): a row always stays visible; settle by `cody_delivery` ID, never text.
- Steers go at once; only follow-ups wait in `heldQueue`; Stop uses `abortRestoringQueue` (plain abort runs every queued message).
- Acks are bounded (202 `pending`); steer/follow-up ack timeout never recycles the child; GET routes bound `get_state` (`stale`) because omp serializes RPC commands.
Details: docs/agents/turn-flow.md

### A viewed session stays warm, and a closed one never leaves a deaf stream
- Idle disposal skips sessions with an attached stream (`resetIdleTimer`) — cold child costs ~7 s.
- Every close is announced (`EngineSession.onClose`); events route sends `retry: 1000` and ends, so the browser reconnects and starts the child — else stuck on "Sent".
Details: docs/agents/session-runtime.md

### Composer-attached panels (`components/ComposerPanels.tsx`)
- Todo plan + subagent roster are pinned ABOVE the input (`ComposerPanels`), not in the scrollable list; collapsible, start collapsed; `TodoList` keeps a non-collapsible default for SSR tests.
- Layout = full-width stacked rows, never fit-content side-by-side — headers stay aligned (`ComposerPanels.test.mjs`).
Details: docs/agents/composer.md

### Native goals (`lib/goal-state.ts`, `components/GoalPanel.tsx`)
- omp owns the goal, Cody mirrors; the `goal` KEY in `get_state` is the capability probe; never write the sessionStorage goal when native works.
- Fold via `adoptGoal`: newest `updatedAt` wins; null `get_state.goal` at `agent_end` must NOT erase a finished card.
- Auto-continue adds `rpc` to `goal.continuationModes` WITHOUT `applyNow` (a restart pauses an active goal).
Details: docs/agents/turn-flow.md

### Side questions: `/btw` (`lib/btw.ts`, `hooks/useSideQuestions.ts`, `hooks/useSideQuestionsBridge.ts`, `components/SidebarSideQuestions.tsx`)
- omp 18.7+ only (older omp: surface hidden); typed `/btw` is intercepted in `ChatInput.handleSend`, never sent as prompt text (it would reach the model literally).
- `btw_delta`/`btw_record` frames never touch run state or the ledger; `btw` is not outbox machinery; `useSideQuestions.applyFrame` runs BEFORE the coalescer.
- History read never spawns a cold chat (`lib/btw-history.ts`).
Details: docs/agents/sidebar-chat.md

### Composer context gauge
- Ring prefers authoritative live usage with a percentage; idle falls back to `derivePersistedContextUsage()` using `contextWindow` from `/api/models`.
- Clear live usage on session switch so no stale gauge leaks; unknown usage keeps an empty ring mounted.
Details: docs/agents/composer.md

### Daily time limit: active time only, one union across devices (`lib/daily-limit/`, `hooks/useDailyLimit.ts`)
- Counts only visible+focused+input in last 60 s; `scroll` is NOT input (agent auto-scroll would count forever). Never blocks a send or run.
- Beats are durations `{activeSeconds, endedSecondsAgo}` on the server clock (`parseBeat` caps 90 s); server keeps a merged interval UNION in `daily-limit.json`, not counters.
- Day = local date in person's zone via `localDayBounds` (searched, not offset-computed, for DST).
- One counter per page: `useDailyLimitTracker()` mounted once in AppShell.
Details: docs/agents/time-and-limits.md

### Token rate: measured from the engine's own numbers, never guessed
- `t/s` = output tokens over measured `duration` (`lib/message-rate.ts`); do NOT read `get_state`'s `tokensPerSecond` — only as fresh as the 15 s poll.
- No badge below `MIN_RATE_OUTPUT_TOKENS` (48) — a 4-token "ok" showed 2.3 t/s on a ~90 t/s model; the `chars / 4` fallback wears `~`.
- `message.timestamp` is request START; measure tool durations from `completedAt`.
Details: docs/agents/usage-monitoring.md

### Distill: summaries that never break with the engine
- One-shot children MUST use `getOneShotAgentDir()` (empty `mcp.json`, symlinked `agent.db`/`config.yml`) — user MCP servers cost 45-58 s per spawn, past the 20 s timeout.
- Trap: overlay keys must be NESTED; flat `memory.backend: off` is ignored (~4,400 omp processes/day). `one-shot.test.mjs` rejects dotted keys.
- Any failure tries the next chain selector, then engine default (no `--model`); original text stays untouched; `DistillQueueOverflowError` is not a failure.
- `unsupported` (ACP engine) is a permanent latch; 401/403 only pauses `AUTH_BACKOFF_MS`. `plain` is in both cache keys; state in data dir, not omp config.
Details: docs/agents/distill.md

### Subagent integration (`lib/subagent-types.ts`, `lib/subagent-history.ts`)
- Subscribe to lifecycle+progress, NEVER "events" (`SUBAGENT_SUBSCRIPTION_LEVEL`) — 5.3 GB in 5 min froze sessions (check `/tmp/omp-rpc-output-*`).
- Roster is run-scoped; never seed from `extractSubagentHistory` (20+ stale chips).
- Transcript route reads only needed bytes (`readSubagentTranscriptPage`), never the whole 14–21 MB file.
- Validate ids as safe filename components with realpath confinement, not an AdjectiveNoun regex.
Details: docs/agents/subagents.md

### Worktrees and project grouping
- `lib/worktree.ts` maps linked worktrees to the main repo `projectRoot`; sessions in removed worktrees map back, not to a phantom row.
- `/api/worktrees` uses `/api/files` root rules; removing a dirty worktree returns `409` `{ dirty: true }` so the UI asks before `force`.
Details: docs/agents/projects-and-files.md

### Managed projects sidebar (`lib/project-registry.ts`, `/api/projects`)
- Registry holds canonical `projectRoot`s (`resolveProject`); removing only hides (blocks re-discovery).
- `GET /api/projects` re-authorizes roots via `allowFileRoot()`; the allowlist doesn't survive restarts.
- Order = registration, not activity; prune `cody:expanded-projects` only after first fetch.
Details: docs/agents/projects-and-files.md

### File access allow-list
- `/api/files` is no general browser: roots = session cwds, project roots, `~/omp-cwd-*`, `allowFileRoot()`; `/api/cwd/browse` and `/api/worktrees` call it.
- One rule for every cwd operation: browsable via `/api/cwd/browse` means `/api/cwd/mkdir` may write there (and registers the new folder as a root).
Details: docs/agents/projects-and-files.md

### Session list caching — new sessions must appear immediately
- `invalidateSessionListCache()` MUST also call `invalidateSessionFileListCache()` — the walk cache keys on root mtime, which NTFS subdir writes don't bump.
- A new session has no `.jsonl` for ~5 s; `retainPendingSessions()` keeps its client-side row until the server lists it.
- `scanSessionInfo` rereads a 64 KiB prefix when 4 KiB has no user message — else chats read "(no messages)" and never get named.
Details: docs/agents/chat-ui.md

### Session switching: paint from cache, never wait on the engine
- `loadSession` releases the loading gate on the TRANSCRIPT, never on `/state` — state queues behind a running turn and left sessions blank.
- Revisits paint from `lib/session-transcript-cache.ts`; a switch aborts old requests; a `stale` state without a snapshot never finishes a running turn.
Details: docs/agents/chat-ui.md

### Chat scroll: a follower is pinned to the tail, a reader is pinned to their content
- Following re-pins the bottom; reading runs NO programmatic scroll — reader pin (`lib/transcript-anchor.ts`) restores by `data-turn-index`/`data-block-index` identity, not DOM node.
- Nothing a reader looks at folds: `readerHoldsTail` keeps the last turn unfolded until the bottom is reached.
- Scroll events never unpin a FOLLOWER (a late clamp stranded one 180px up); smooth scroll honors `prefers-reduced-motion`.
Details: docs/agents/chat-ui.md

### MCP configuration (`lib/omp/mcp-config.ts`, `/api/mcp`, `components/McpConfig.tsx`)
- User secrets never reach browser (`lib/mcp-secrets.ts`): `MCP_SECRET_SENTINEL`; write REFUSES if no stored value backs a sentinel.
- User scope admin-only (`userScopeDenied`): stdio runs in everyone's sessions.
- Enable/disable = user `disabledServers` (`setUserServerDisabled`), not `enabled`; delete must remove entry.
Details: docs/agents/mcp-plugins.md

### Load on demand (heavy MCP servers + desktop control)
- Settings > Extensions > MCP "Load on demand": the server leaves omp's `mcp.json` for Cody's registry `<agent dir>/cody-on-demand-mcp.json` and costs nothing per request; every omp chat gets ONE small tool `load_tools {server, unload?}` (extension `lib/omp/extensions/cody-on-demand-mcp.ts`, desc ~100 tokens) that starts the server and registers its tools as normal `mcp__<server>_<tool>` tools for the rest of THAT chat (session entries `cody-on-demand-mcp`; resume/restart remounts).
- Built-in `computer` (omp desktop control, `computer.enabled`): a per-key launch default keeps it off; `load_tools {computer}` flags the chat (`lib/omp/on-demand-chats.ts`), Cody restarts that chat's engine when idle with a per-chat layer; the user re-sends. Explicit `computer.enabled: true` in config.yml wins (layer dropped, no saving).
- ACP engines: unsupported by design (they read MCP from their own config; no extension). A `computer` load from inside a subagent never reaches the host chat.
Details: docs/agents/mcp-plugins.md

### Plugins and skills
- `/api/plugins` shells out to `omp plugin` (`runOmpCli`), never the Bun-only SDK; `parsePluginId` keeps bare names from omp 18.3.x; marketplace browse is pure-Node.
- `lib/skills-service.ts` scans ONE level deep (else vendored `SKILL.md` listed); toggle edits only `disable-model-invocation`.
- Gate composer skill lookup on `capabilities.skills` — else Claude Code/Codex scan per `/` keystroke.
Details: docs/agents/mcp-plugins.md

### Update notifications (`/api/omp-update`, `/api/app-update`)
- No in-app self-updating: only notifications plus copyable terminal commands (`SystemUpdates.tsx`).
- `/api/app-update`: `/.dockerenv` → `nphil/Cody` release, else npm `@nphil/cody` (bun/npm via `detectInstallMethod`).
Details: docs/agents/mcp-plugins.md

### Usage-aware routing: one registry, blackouts, role binding (`lib/routing/`)
- Per usage poll: observe → remember → bind roles → bind agents; WRITING is opt-in (`autoBindEnabled()`, `CODY_ROUTE_AUTOBIND=1`) so an update never rewrites user roles.
- `lib/usage/availability.ts` is the single verdict (unknown is usable); `quota-tiers.ts` says which windows bind which model — use `isAccountWideWindow`, never `!window.tier`.
- Blackouts persist in `cody-route-memory.json`, provider's reset = expiry (prepaid `credits` has none); a failed read never lifts one.
- A usage reading carries its own age (`lib/usage/reading-age.ts`): omp re-serves a login's last saved report when its live fetch fails (Claude's usage endpoint 429s bursts), so every bound counts from the report's own `fetchedAt` (`UsageAccount.measuredAt`), never from Cody's read time. After 30 minutes an account is `outdated`: ring dimmed, "out of date · measured 5 days ago", no number when no window is left; a login's numbers never go back in time.
- A credential block (`applyCredentialBlocks`) outranks a usage percentage: an account at 4% used was blocked for 5 hours.
- Subagents resolve via `@alias` roles (`agent-roles.ts`); a concrete model pin has no fallback chain.
Details: docs/agents/routing.md

### Claude API credits as the backup behind the Claude plans
- One extra provider PER KEY (`anthropic-api`, `-2`, …) that omp's chain walks to; a shared pool fails (omp rotates only on quota-like errors). omp only.
- omp ignores an `anthropic` API key while a plan is signed in; never list `anthropic-api*` as Providers rows; models.yml twins need `auth: none`.
- Chain rewrite is launch-only via `withClaudeCreditsOverlay`; config.yml and presets are never edited; Local-only comes last.
- `credits-cover.ts`: routing never jumps past a covered plan model until every saved key is itself blocked.
Details: docs/agents/routing.md

### Model orchestration: roles, plans, chains, resets
- Roles come from the engine (`getOmpModelRoleIds()`, `planRoleNames()`), never a frozen list — else `widget` leaks to old engines.
- One roster (`lib/model-plan/roster.ts`) = omp's `get_available_models`, already filtered by `enabledModels`; no second Cody filter.
- Config is read at spawn: plan apply and resets call `restartIdleRpcSessions()`; resets delete only Cody's overrides.
- Trap: `patchSettingsSection` must spread the SECTION, not the whole settings object (junk keys in config.yml).
Details: docs/agents/models.md

### Model presets: per-conversation role overlays, researched on the web (`lib/model-presets/`)
- Per conversation, never global: an omp config layer in `PI_CONFIG_FILES` at spawn, never `config.yml`; applied ONLY by direct pick.
- Research runs a sandboxed omp child: `web_search` only, EMPTY `mcp.json` (`--tools` alone doesn't stop user MCP) — untrusted web content must not reach file tools.
- Trap: the server import graph cannot use `@/` aliases — the server won't boot while tests pass.
Details: docs/agents/models.md

### Auth and model config
- Credentials live in omp's `agent.db`; Cody touches them only via `bin/cody-omp-credentials.mjs` (plus one read-only SELECT in `lib/openrouter/key.ts`).
- API-key status endpoints must never return the raw key.
- Gate new models.yml kinds/apis/tokenizers by engine version (`lib/model-kinds.ts`) — one future value in a closed enum (runner `api`, `tokenizer`) makes omp drop the WHOLE file.
Details: docs/agents/models.md

### RPC transport limit — the utility process MUST negotiate v2
- omp caps a frame at 1 MiB; v1 fails oversized replies, v2 chunks. `get_available_models` hit 1,058,841 bytes — `/api/models` failed.
- `startProcess` and `runIsolatedUtilityCommand` (`lib/omp/rpc-utility.ts`) must negotiate v2; never send it to engines not advertising v2 (pi).
Details: docs/agents/session-runtime.md

### Model curation (`enabledModels`) — omp filters, Cody does not
- omp applies the `enabledModels` globs in `get_available_models`; Cody MUST NOT add a second filter.
- Trap: a curated read can't see what it hides, so only the curation panel fetches `/api/models?catalog=full` (`enabledModels: []` overlay).
- Never write `config.yml` for that; `--models` doesn't work.
Details: docs/agents/models.md

### Brand marks (`components/ProviderIcon.tsx`, `lib/provider-brand.ts`)
- Marks are vendored path data, never hotlinked — the picker must render offline.
- Trap: models.dev returns 200 with a sparkle placeholder for unknown providers — eyeball each mark; keep the source viewBox, never rescale by hand.
- `ProviderIcon` = provider, `ModelIcon` = VENDOR (`modelBrand()`); a gateway is not a vendor.
Details: docs/agents/models.md

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` and reuses one `AudioContext`.
- Audio needs a user gesture: `ChatInput` calls the unlock hook from interactive controls; `ChatWindow` plays the tone from `onAgentEnd`.
Details: docs/agents/chat-ui.md

## omp Session File Format (v3)
- `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`; line 1 is a 256-byte title slot (old pi files lack it); tolerate unknown entry types.
- `model_usage` is billing, not messages: head is NOT the last entry — use `resolveSessionLeafId`; sum with `aggregateModelUsage`.
- Never render `preserveData` (up to 24 MB on one line); `entryIds[]` in `SessionContext` parallels `messages[]`.
Details: docs/agents/session-format.md

## Design Tokens & UI Kit (`app/globals.css`, `components/ui/`)
- Consume the CSS variables (`--bg`, `--text`, `--accent`, `--radius-card`, `--safe-*`); never hardcode colors — pairs are WCAG AA-verified.
- Use `components/ui/` primitives and `lucide-react` icons; never add inline SVGs.
Details: docs/agents/ui-kit.md

### One dropdown, and a placeholder is not a choice
- `components/ui/Select.tsx` is the only dropdown; zero native `<select>` — a new one is a regression (browser-painted, ignores theme).
- `placeholder` is NOT selectable: an "All/default/unset" row must be a real `{ value: "", label }` option; keep `|| undefined` transforms (else `""` lands in `models.yml`).
Details: docs/agents/ui-kit.md

### Standalone immersion and the safe-area variables
- Edges pad via `--safe-*` vars, never `env()` at call sites; a padded parent owns the inset; only the composer adds the bottom one.
- `theme-color` is `--bg-panel` (`preview.surface` in `lib/theme-catalog.ts`), not `--bg`; `theme-catalog.test.mjs` fails on drift.
- iOS `black-translucent` glyphs are ALWAYS white: key off the theme's mode, never `prefers-color-scheme`; top-bar `background` stays in the stylesheet, not inline.
- `html, body` stay `overflow: hidden` — iOS rubber-band isn't stopped by `overscroll-behavior`.
Details: docs/agents/ui-kit.md

### Phone composer: one row, nothing wraps
- Below 640px the row is `nowrap`; every fixed control is 38px `flex-shrink: 0` (Send 62px with its ▾ zone); only the model selector shrinks and ellipsises.
- `phoneBudget()` (`lib/scheduled/ui.ts`): a new control needs the budget redone first — at 360px with agent-mode the name has 7px left.
- State dots sit inside existing boxes; ChatInput's 16px sides ARE the gutter — docks add none.
Details: docs/agents/ui-kit.md

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
