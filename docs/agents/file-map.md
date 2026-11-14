# File Map: the full annotated version

← Back to [AGENTS.md](../../AGENTS.md) · AGENTS.md carries a compact map that lists every path; this file keeps the complete per-file notes.

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  sessions/[id]/media/route.ts    GET one deferred tool-result image's bytes
  sessions/[id]/scheduled/route.ts GET list / POST schedule a message for later (owner-checked)
  sessions/[id]/scheduled/[itemId]/route.ts  PATCH change text/time / DELETE cancel
  sessions/[id]/scheduled/[itemId]/send-now/route.ts  POST send it now (a failed one's Retry)
  sessions/[id]/btw/route.ts      GET side-question (/btw) topics: the live engine's get_btw_history (3 s bound) else omp's sidecar on disk; omp only, owner-checked, never spawns
  preview/screenshot/route.ts     POST server-side screenshot of a loopback URL
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any RPC command
  agent/[id]/events/route.ts      GET SSE stream
  agent/[id]/recover-model/route.ts POST {provider, modelId} reopen a chat whose saved model is gone
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  agent/[id]/display/route.ts     POST publish a display request | GET latest (auth-gated)
  agent/[id]/display/events/route.ts GET SSE stream of display requests (snapshot + live)
  sidebar-chats/route.ts          GET list sidebar chats for workspace
  sidebar-chats/[id]/route.ts     DELETE a sidebar chat session by id
  internal/display/route.ts       POST publish from engine MCP servers (capability-token auth)
  internal/scheduled/route.ts     POST the scheduling tools for ACP engines (capability-token auth)
  internal/messaging/route.ts     POST send_to_chat + message_status for ACP engines (capability-token auth)
  internal/model-switch/route.ts  POST the switch_model tool for ACP engines (capability-token auth)
  auth/**                         omp's provider list + login flow (via RPC); every
                                   route refuses `unsupported` unless omp is active
  cwd/validate/route.ts           POST validate/select a cwd
  cwd/browse/route.ts             GET list subdirectories of a given path (no auth restriction on parent)
  cwd/mkdir/route.ts              POST create a folder in a browsable directory

  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  git/status/route.ts             GET repo status + branch/ahead-behind for a cwd
  git/diff/route.ts               GET one file's HEAD->worktree patch
  info/route.ts                   GET server facts for the Info panel
  todo/route.ts                   GET/POST project .cody/todo.json (validated, atomic)
  tasks/route.ts                  GET .cody/tasks.json (validated)
  tasks/run/route.ts              POST run a task by id into a new terminal
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel, catalogSource }
                                   dispatches on the active engine: an rpc-dialect
                                   engine's own sessionless catalog, or an empty
                                   `catalogSource:"session"` answer for ACP engines,
                                   whose models live in the session's get_state.
                                   `?catalog=full[&refresh=1]` (omp only): the
                                   UNRESTRICTED catalog behind an --config overlay,
                                   an hour's cache, what curation and the new-models
                                   diff read from
  models/new/route.ts             GET models in the catalog never shown before (the
                                   seen ledger); `?cached=1` answers from the catalog
                                   cache only and never spawns an engine — for a
                                   status line, never the hub's own open. A COLD cache
                                   answers `stale: true` with the last count this
                                   instance showed (`cody-model-catalog-summary.json`)
                                   and warms the catalog in the background, so the
                                   Models rail says "568 models" on the first open
                                   after a restart instead of nothing until a manual
                                   Refresh; `pending: true` only before any count was
                                   ever recorded
  models/seen/route.ts            GET/POST the seen ledger
                                   (`cody-model-catalog-seen.json`) that makes "new"
                                   a fact instead of a guess; POST is admin-only
  models/visibility/route.ts      GET/PUT who hides and pins which models
                                   (`cody-model-visibility.json`): an admin's
                                   instance-wide hide plus each user's own hide/pin.
                                   `instanceHidden` is refused `unsupported` on omp,
                                   whose instance hide is its own `enabledModels`
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml (omp only);
                                   a PUT that drops a provider the file had is a
                                   REMOVAL: idle engines restart (settleProviderChange)
  models-config/test/route.ts     POST test a configured model/provider (omp only)
  omp-settings/route.ts           GET/PUT omp's OWN config.yml — `configEditor`,
                                   not `nativeSettings`: pi declares the latter for
                                   its OWN schema panel and must not land here. A PUT
                                   that CHANGES `disabledProviders` restarts idle
                                   engines and forgets the newly disabled provider's
                                   blackouts (the Models hub spreads the whole object
                                   on every curation write, so an unchanged list is a no-op)
  omp-settings/schema/route.ts    GET the ACTIVE engine's own settings schema +
                                   values; PUT a dotted-path patch. Engine-NEUTRAL:
                                   it dispatches on HarnessAdapter.settings and
                                   refuses `unsupported` when an engine has none —
                                   never on an engine id
  settings-seen/route.ts          GET/POST which engine settings are new for the caller (per
                                   account, NOT admin-only); POST reports chips seen / keys
                                   changed, once per Settings open
  mcp/route.ts                    GET/POST/PUT/DELETE MCP servers in either
                                   scope (`scope: "project"` default, `"user"`)
  homelabber/route.ts             GET {base, source}: the web origin of HomeLabber for the
                                   approval card's backup-code link — CODY_HOMELABBER_URL,
                                   else the ORIGIN (only) of the `homelabber` server in
                                   omp's user mcp.json, else the built-in default; any
                                   signed-in user, never a header or a path
  provider-keys/route.ts          GET the provider-key catalogue for the active
                                   engine with stored/fromEnvironment flags (never
                                   values); PUT {name,value} (admin) stores or clears
                                   one — every engine, no capability gate. A CLEAR
                                   restarts idle engines (their env carried the key)
                                   and answers 409 `set_in_environment` when only the
                                   server's environment holds the variable
  providers/route.ts              GET the Providers hub's one list for the active
                                   engine: sign-in roster + key store + effective
                                   catalog + registry file, joined per provider.
                                   `?cached=1` never starts an engine child
  providers/verify/route.ts       POST {providerId} — "Check models": drops the
                                   shared utility child and re-reads the catalog to
                                   count what a provider now serves (admin-only,
                                   `unsupported` on an ACP engine)
  providers/enable/route.ts       POST {provider} — omp only: clears a provider from
                                   `disabledProviders` (restarts idle engines when it
                                   really was disabled)
  plugins/route.ts                GET/POST plugin management (shells out to `omp plugin`)
  plugins/marketplace/route.ts    GET browse configured marketplaces + catalogs | POST
                                   add/remove/update marketplace, install/uninstall/upgrade
  projects/route.ts               GET registered+discovered projects | POST add | DELETE hide
  skills/route.ts                 GET loaded skills + surface flags | PATCH enable/disable
                                  (the SKILL.md frontmatter key)
  skills/install/route.ts         POST install through the active engine's own
                                  installer (npx skills add)
  skills/store/route.ts           GET browse/search/detail | POST card descriptions (skills.sh registry)
  worktrees/route.ts              GET/POST/DELETE git worktrees
  forge/route.ts                  GET the configured code hosts, tokens redacted to
                                  hasToken + a last-four preview; PUT (admin) upsert
                                  a host / set the default / point Cody's own update
                                  check at a host; DELETE (admin) one host
  forge/[id]/test/route.ts        POST "test connection": GET {api}/user on that host,
                                  answering the login and (Gitea) the server version
  distill/route.ts                POST one model-written summary of a thinking block
                                  or a reply, streamed as SSE: `delta`* then exactly
                                  one `done` (full text, replace never append) or one
                                  `error` (unsupported|no_model|too_large|failed).
                                  Ownership is canAccessSession alone, so a session
                                  with no file yet (mid-turn) is allowed
  distill/config/route.ts         GET/PUT the Distill model chain; 400 `unsupported`
                                  under an ACP engine, PUT admin-or-open-instance
  notifications/route.ts          GET/PUT this account's push-notification settings
                                   (the ntfy token is write-only: GET says hasToken)
  notifications/test/route.ts     POST send a test push with the saved settings
  notifications/presence/route.ts POST {sessionId|null}: the chat this tab shows
  notifications/action/route.ts   POST {t} PUBLIC: an ntfy answer button; the signed
                                   single-use token is the only credential (CORS *)
  daily-limit/route.ts            GET/PUT the personal daily time limit: today's state
                                   (active time used on every device, time left, notice
                                   due) | on/off, length, "Add 15 minutes", "Done for today"
  daily-limit/beat/route.ts       POST {activeSeconds, endedSecondsAgo?}: one finished
                                   stretch of ACTIVE use, merged into the account's union
  machines/route.ts               GET the machines the top bar meters (this server +
                                   ssh ones; an ssh address only for someone who may
                                   edit) | PUT (admin, or an open instance) the list
  machines/stream/route.ts        GET SSE: every machine's status and CPU/memory, a
                                   frame per reading, a 10 s heartbeat. Holding it
                                   open IS what makes the server sample at all
  machines/test/route.ts          POST {destination} (admin) one real ssh sample;
                                   200 either way, `ok:false` carries a reason code
  machines/worker-check/route.ts  POST {id} (admin) one real check of a saved ssh worker:
                                  reads /etc/cody-worker.json, the work root and the load over ssh;
                                  200 either way, `ok:false` carries a reason code; 429 while 2 run
  internal/workers/route.ts       POST the run_on_worker tool for ACP engines (capability-token auth);
                                  answers application/x-ndjson: progress, heartbeat, one result
  statistics/route.ts             GET  usage totals, ring tree, timeline, insights
                                   (?preset|from&to &groupBy &refresh) / one chat's
                                   deep dive (?session=)
  ../statistics/page.tsx          the Statistics page
  disk/route.ts                   GET disk meters, largest chat scratch folders, the
                                   janitor's last run | POST {action:"clean"} (admin)
                                   runs the janitor now | PUT (admin) its settings
  claude-credits/route.ts         GET (omp only) each Claude plan account and its backup
                                  API key, last four only | PUT {accountId, key} /
                                  DELETE {keyId} (admin): "Claude API credits as the
                                  backup behind the Claude plans"

lib/
  omp/                 shared omp foundations (paths, CLI probe, RpcProcess,
                        marketplace.ts pure-Node catalog reader, plugin-cli.ts
                        shared `omp plugin` execFile/JSON helpers,
                        isolated-agent-dir.ts's shared empty-mcp.json symlink
                        dance for sidebar chat, Distill, the session namer
                        and the web-research planner, homelabber-base.ts: the
                        origin of the `homelabber` MCP server for /api/homelabber)
  claude-credits.ts    browser-safe half of the Claude API credits backup: the
                       `anthropic-api`, `anthropic-api-2`, … provider ids (one per
                       key), plan <-> credits selector helpers and the
                       /api/claude-credits payload types. Server half:
                       omp/claude-credits.ts (models.yml blocks, keys, status),
                       omp/claude-credits-store.ts, omp/claude-credits-overlay.ts
                       (the per-chat chain overlay) and routing/credits-cover.ts
  agent-client.ts      typed fetch helper for /api/agent commands
  time-zone.ts         zones in one pure, browser-and-server-safe place: IANA
                       validation/canonicalisation (`normalizeTimeZone`), the
                       precedence (`resolveTimeZone`), `formatLocalTime` /
                       `describeLocalNow`, the message-command set and the
                       hidden line's `LOCAL_TIME_CUSTOM_TYPE` — see "Time zones"
  time-zone-prefs.ts   server only: a person's chosen zone and last-seen device
                       zone (account record; `<accounts dir>/time-zone.json` on
                       an open instance), `zoneForMessage`, `ownerTimeZone`
  tool-time.ts         `formatToolTime()`: how a host tool writes a time the
                       model reads
  notifications/       push notifications to the owner's ntfy topic ("Push
                       notifications" below). `catalog.ts` is the shared,
                       browser-safe vocabulary (kinds, prefs, bounds); the rest
                       is server only: `store.ts` (per-account settings, 0600),
                       `recipients.ts`, `presence.ts`, `observer.ts` (per-chat
                       state machine), `compose.ts` (text, answer buttons,
                       digests), `dispatch.ts`, `ntfy.ts` (client), `tokens.ts`
                       (answer-button tokens), `answer.ts` (what a button tap
                       does), `quota-watch.ts`
  device-time-zone.ts  browser: `deviceTimeZoneField()`, the zone to spread into
                       a request body, read fresh on every call
  daily-limit/         the personal daily time limit ("Daily time limit" below).
                       Pure and browser-safe: `active-time.ts` (what counts as
                       active, the 15 s beat controller), `ledger.ts` (the
                       wall-clock interval union, local-day bounds), `state.ts`
                       (settings, the arithmetic, beat parsing), `view.ts` (phase,
                       tone, level, durations); `store.ts` is server only
                       (`<accounts dir>/daily-limit.json`)
  draft-store.ts       composer drafts: in-memory per session key, with the TEXT
                        mirrored to sessionStorage (`cody:draft:<key>`, 64 K cap)
                        so a reload or navigation never loses an unsent prompt;
                        images/files stay in memory only
  homelabber-approval.ts the pure half of HomeLabber's Face ID approvals in the
                       chat: which tool calls are HomeLabber's, parsing a
                       result (text, structured content or both) into a
                       request's id/status/expiry/item outcomes, folding every
                       call into one state per request id, phases/tones, the
                       deep link and web URL, and the base-URL rules — see
                       "HomeLabber approvals in the chat"
  image-compress.ts    browser-side source-first batch preparation: exact 900 KiB prompt-frame budget, adaptive WebP fallback, explicit decode/budget errors
  image-attachments.ts defensive server validation for base64 image command payloads (10-image bound)
  context-usage.ts     derives idle/reconnect gauge usage from persisted messages
  env.ts               readEnv(): CODY_* config with OMP_WEB_* fallback
  display/             universal display/preview surface:
    types.ts           DisplayRequestV1 + DisplayCandidate + bus event types
    validation.ts      loopback-only http(s) URL normalization (rejects credentials)
    bus.ts             globalThis per-session latest+listeners; publish/subscribe/alias
    capability.ts      HMAC session-scoped display/to-do tokens (CODY_INTERNAL_DISPLAY_SECRET/ORIGIN)
    provider.ts        RasterWebProvider: puppeteer-core + system Chromium → JPEG WS stream
    native-gateway.ts  candidate ranking; optional CODY_PREVIEW_BASE_URL
                       wildcard-subdomain reverse proxy
    engine-tools.ts    bundled display/to-do MCP launch descriptors: --mcp-config JSON for a
                       per-turn CLI, an ACP McpServerStdio for an ACP session
    access.ts          authorizeDisplaySession(): request auth for display routes
    csp.ts             buildContentSecurityPolicy(): loopback + this host's
                       private LAN/CGNAT frame-src/connect-src for proxy.ts
  forge/               code hosts — GitHub and self-hosted Gitea:
    config.ts          cody-forge.json in the instance data dir (0600, atomic): the
                       host roster, tokens, the default host and Cody's own update
                       source; resolveApiUrl/authHeader/matchForgeHostUrl
    client.ts          one fetch-based interface over both hosts (no octokit):
                       repos, files, issues, pulls + diffs, releases + assets,
                       Actions runs/jobs/logs, packages, git trees
    tool.ts            the `forge` host tool omp sessions call (lib/rpc-manager.ts
                       registers it). ACP engines do not get it: their bridge
                       (bin/cody-display-mcp.js) is a separate process holding no
                       Cody state, and giving it the forge would mean a new
                       authenticated HTTP surface proxying arbitrary host calls
  disk/                disk hygiene (see "Disk hygiene" below): `scratch.ts`
                       (per-chat TMPDIR), `janitor.ts` + `sweep.ts` / `walk.ts` /
                       `transcripts.ts` / `mentions.ts` (the hourly cleanup),
                       `gate.ts` (refuse new work at < 5 % free), `status.ts`,
                       `settings.ts` (`cody-disk.json`), `types.ts` (browser-safe
                       shapes). Nothing here may use `@/` (loaded by the server)
  machines/            the machines the top bar shows CPU/memory meters for:
                       this server plus any ssh machine (see "Machine meters
                       in the top bar"). Browser-safe: `types.ts` (statuses,
                       reason codes, the strict name/destination checks, API
                       payloads) and `present.ts` (which machine is "worst",
                       how much of each fits in the room the bar has).
                       Server only: `proc.ts` (/proc/stat, meminfo, loadavg
                       to CPU % from deltas, memory and load; the ssh stream
                       framing), `ssh.ts` (the ONE fixed sampling loop, the ssh
                       argv, a failure to a reason code), `store.ts`
                       (`cody-machines.json`, 0600, atomic), `sampler.ts`
                       (collectors and the viewer-driven lifecycle).
                       bin/cody-server.js loads sampler.ts to stop it at
                       shutdown, so nothing in here may use `@/`
                       Worker additions: `jobs.ts` (job counts and the newest worker check per
                       machine, on globalThis; imports only a type); `types.ts` also holds WorkerFacts and
                       `checkWorkerFacts`; `store.ts` keeps `worker` and `workerFacts` per ssh machine
  workers/             `run_on_worker`: heavy commands on another machine ("Workers: heavy jobs on other
                       machines"). Nothing here may use `@/`.
    tool.ts            the tool definition the agent reads + `runOnWorker` (every harness calls it)
    run.ts             one job from start to result: pick a worker, copy in, run, copy back, clean up,
                       rerun once on a drop, fall back to this server
    scheduler.ts       the FIFO queue and the leases; placement.ts picks the worker (pure)
    health.ts          reading a worker over ssh (button, 60 s monitor, scheduler probe); facts.ts the
                       check command and its parser
    files.ts           which files go out, which result paths may come back (name safety)
    tarball.ts         `tar` packing and the checking unpacker for results
    transfer.ts        the two trips of files; execute.ts the run, its markers and the time limit
    remote.ts          the remote scripts (copy in, run, copy back, cleanup) and the marker reader
    shell.ts           the ONE ssh seam (RemoteShell); output.ts/progress.ts the log file, tail and live status
    local.ts           the same job on this server (fallback); format.ts words for the agent; live.ts the
                       server's scheduler on globalThis; types.ts shared shapes
    local-shell.mjs    test helper: this machine as a worker
  statistics/          Statistics page server half: scan.ts (usage out of transcript lines), indexer.ts
                       (reads only unread bytes), joblog.ts and oneshot.ts (Cody's own background jobs'
                       usage), query.ts (totals, ring tree, timeline, insights), days.ts (day buckets),
                       sunburst.ts (ring geometry), workers.ts (id to kind), test-helpers.mjs
  usage/               client-merge.ts (what the browser keeps after a poll), credential-health.ts (ended
                       logins), last-good.ts (server keeps the last good read), quota-copy.ts (plain words),
                       reading-age.ts (how old a reading is, when it is out of date)
  model-switch/        agent-requested model switch: resolve.ts (pure), switch.ts, tool.ts
  engine-crash*.ts     engine-crash.ts (why an engine stopped), -events.ts (who hears it), -host.ts (cgroup
                       facts), -log.ts (the chat's crash line)
  model-presets/roster-check.ts, plan-keeper/fold.ts, scheduled/model-ui.ts, notifications/signed-out.ts,
  ask-result.ts, bash-output-meta.ts, extension-title.ts, helper-memory-limit.ts, irc-display.ts,
  task-call-preview.ts, omp/cody-launch-defaults.ts, omp/gc-strip.ts, omp/services.ts: see the compact map in AGENTS.md
  engine-guard.ts      requireEngine()/requireCapability(): the SERVER half of the
                       capability rule. An omp-only route (models.yml, model roles,
                       config.yml, `omp usage`, agent.db credentials, session
                       import/archive/export) refuses 400 `unsupported` under any
                       other engine instead of answering with omp's data
  file-access.ts       allowed file roots for /api/files and worktrees
  distill/             Distill's server half (see "Distill" under Key Design
                       Decisions):
    config.ts          cody-distill.json in the instance data dir (0600, atomic):
                       the fallback chain of `provider/id[:effort]` selectors
    prompts.ts         the two prompts, the 200 KB head/tail clamp and the
                       one-line thinking normalizer
    cache.ts           finished summaries per session (cody-distill/<id>.json,
                       400 entries, oldest evicted)
    runner.ts          engine support (same rule as session-namer), the fallback
                       chain and the 2-at-a-time queue
  distill-preferences.ts  browser-local Distill preferences (`cody:distill`):
                       reply verbosity, collapsed-thinking summaries, plain
                       language, normalizer
  harness/             pluggable engine seam: adapters (omp/pi/claude/codex),
                       runtime selection state, three transports (rpc-ui, ACP,
                       per-turn), session index, binary probe + on-demand install
                       (docs/harnesses.md)
    housekeeping.ts    the server's own cleanup (first pass 60 s after boot,
                       then HOURLY, timers unref'd): the disk janitor
                       (lib/disk/janitor.ts) and omp's temp leftovers via
                       lib/omp/temp-files.ts (`omp-sshots-*`,
                       `omp-worker-stderr-*` older than 7 days). Built into
                       Cody on purpose: an install must never depend on a
                       host cron or user script to stop files piling up
    pi-settings.ts     pi's settings, derived from the settings TABLES in the
                       installed pi package's own docs/settings.md (parsed at
                       runtime, failing soft) and written back to
                       <pi agent dir>/settings.json — the read/write half of
                       pi's HarnessAdapter.settings
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
                       the shared driver behind claude-login / codex-login
    claude-login.ts    `claude auth login` / `auth status` / `auth logout`
    codex-login.ts     `codex login --device-auth` / `login status` / `logout`
    omp-credentials.ts omp's stored credentials, read and removed through
                       bin/cody-omp-credentials.mjs (never agent.db directly);
                       feeds the per-account rows in lib/omp/provider-login.ts;
                       a removal really deletes the row (omp only soft-deletes)
    omp-claude-credits.ts the Claude API keys in omp's store under `anthropic-api`:
                       list/add through bin/cody-omp-claude-credits.mjs (key on
                       stdin, never argv); removal reuses omp-credentials.ts
    pi-login.ts        pi's pi-ai OAuth flows, run in bin/cody-pi-login.mjs (a
                       child that imports the INSTALLED pi package) and bridged
                       over JSON lines
    login-channel.ts   the one FIFO channel a sign-in's pasted values travel
                       through: a value pasted before the engine asks is held
                       for the first asker; cancel rejects every waiter
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  message-rate.ts      the ONE place output-token throughput is computed: the
                       engine-measured rate (the provider's output count over
                       the request's own duration, plus ttft and a decode-only
                       rate) and, separately and always labelled as such, the
                       chars/4 streaming estimate
  model-display.ts    shared display-only model-label formatter; route identifiers remain untouched
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
  provider-directory.ts / provider-directory-server.ts  the Providers hub's one
                       list per engine: joins the sign-in roster, the key store,
                       the effective catalog and the registry file into one row
                       per provider (composeProviderDirectory, server-only —
                       provider-directory.ts holds the pure/shared shapes and
                       helpers, e.g. isSubscriptionLogin)
  provider-state.ts    `settleProviderChange`: everything Cody remembers about a
                       provider that must be forgotten when its credentials, key
                       or enablement change — models / roster / usage / OpenRouter
                       balance / saved-reset caches, the route-memory blackouts of a
                       REMOVED provider, and a restart of idle engine children.
                       Every route that removes or disables a provider calls it
                       (logout, provider-keys, omp-settings, providers/enable)
  model-allow-list.ts  helpers for omp's native `enabledModels` glob allow-list
                       (Cody edits it, never re-filters by it — see "Model
                       curation" below); modelKey()/providerGlob() are the
                       `provider/id` and whole-provider-glob dialects every
                       models file below shares
  model-catalog-full.ts the unrestricted omp catalog behind its --config overlay
                       (`GET /api/models?catalog=full`), hour-long cache
  model-catalog-seen.ts the "seen" ledger (`cody-model-catalog-seen.json`) that
                       makes "new since you last looked" a fact, not a guess —
                       see the design-decision note under Settings shell
  settings-new-keys.ts pure rules for the Settings "New" badge: diff, accumulate, fade
  settings-seen.ts     the Settings "New" ledger (`cody-settings-seen.json`)
  settings-new-reporter.ts browser-safe batching and the on-screen dwell for it
  model-visibility.ts  who hides/pins which models, instance-wide (admin) and
                       per user (`cody-model-visibility.json`); the HIDE set is
                       an inversion, not an allowlist, so a model neither list
                       names stays visible — see the same note
  models-effective.ts  the effective (already-curated) catalog loader shared by
                       /api/models and /api/providers's per-provider counts;
                       flags `unpriced` rows (every rate zero or absent, and
                       not tagged `pricingStatus` free/included/variable by
                       omp 18.4.5+ — that tag is rare on the wire (set on a
                       handful of catalog models; omp derives the rest), so
                       the bundled-catalog judgement in model-price-fill
                       still does most of the work, and is all older engines
                       have)
  models-dev.ts        the one models.dev reader (hourly cache), shared by the
                       Add-model-from-catalog picker and the price fill
  model-price-fill.ts  fills models.dev prices into models.yml for models omp's
                       bundled catalog does not list yet — see "Prices for
                       models omp does not know yet" below
  composer-model-visibility.ts  browser-side mirror of the visibility file so
                       the composer repaints without a round trip, and the
                       store of record on an open instance (no accounts)
  rpc-manager.ts       session registry + Cody-owned host tools + startRpcSession over RpcProcess;
                       sidebar chats (`kind:"sidebar"`) are ISOLATED and carry no
                       preloaded context — see "Sidebar chat" below: a bare
                       `--cwd` (sidebarBareCwd), an own agent dir with an empty
                       mcp.json and symlinked credentials (sidebarAgentDir), the
                       --no-* flags, an overlay, and SIDEBAR_CONTEXT_TOOLS
                       registered through set_host_tools
  session-tools.ts     the three CROSS-SESSION tools every chat gets
                       (list_sessions, session_status, read_session): name-or-id
                       resolution that lists candidates instead of guessing,
                       the ownership gate, the condensed transcript (messages
                       and tool NAMES only), snapshot-only — nothing here
                       blocks on another session's run
  session-acquire.ts   a chat's live engine session for work nobody is typing
                       for (scheduled messages, run recovery): reuses a live
                       child or starts one exactly as POST /api/agent/[id]
                       would; `SessionUnavailableError` (gone / sidebar)
  run-recovery/        keeps unattended runs going ("Overnight runs" below):
                       `supervisor.ts` (observer per main chat, the one-minute
                       watchdog, recovery, crash and boot resume; state on
                       globalThis), `journal.ts` (cody-run-journal.json: runs
                       in flight), `judge.ts` (tool-overdue rules),
                       `limits.ts` (every threshold), `text.ts` (the recovery
                       turn and push wording), `notify.ts`, `shutdown.ts`
                       (import-free "server is going down" flag)
  scheduled/           scheduled send ("Scheduled messages" below). Browser-safe:
                       `types.ts` (item views, SCHEDULED_LIMITS, error codes),
                       `client.ts` (fetch helpers), `ui.ts` (every composer
                       decision that is not React: quick times, row words, menu
                       placement, long press, the refresh plan, the phone row's
                       arithmetic), `sync.ts` (when the list is read again).
                       Server only: `store.ts` (the schedule file, 0600,
                       atomic), `service.ts` (create / change / cancel / send
                       now — the one place routes AND tools go through),
                       `scheduler.ts` (the timer), `delivery.ts` (into the
                       chat), `quota.ts` ("when quota resets"), `tools.ts`
                       (schedule_message / list_scheduled / cancel_scheduled),
                       `notify.ts`, `access.ts` (the routes' ownership gate)
  chat-messages/       one chat's agent messaging another ("Cross-session
                       awareness" below): `types.ts` (urgencies, limits, the
                       record), `registry.ts` (in-memory deliveries, the loop
                       guard), `header.ts` (the sender line), `delivery.ts`
                       (into the target's wrapper, and the status read from its
                       ledger), `tools.ts` (send_to_chat / message_status)
  sidebar-context-tools.ts  the sidebar's three WORKSPACE tools
                       (list_workspace_files, read_workspace_file,
                       read_project_context) plus the session three above,
                       appended verbatim rather than re-declared
  sidebar-context-budget.ts  how much of a small model's window one tool result
                       may take; an unknown window is assumed to be the
                       SMALLEST supported (8,192), never unlimited
  session-active-models.ts  every model in use in the CURRENT run (live model,
                       Smart resolution, subagents' resolvedModel, fallback
                       targets, this run's assistant turns) with what uses
                       each; feeds the quota popup's "Also in use" section
  session-namer.ts     3-4 word model-written session names: a one-shot run of the
                       ACTIVE rpc-dialect engine (omp's `tiny` role only when omp
                       is that engine; null for ACP engines), plus the pure
                       normalizer that turns its answer into a name
  session-reader.ts    session .jsonl parsing + path cache + buildSessionContext;
                       per-session routes (GET /api/agent/[id]/*) resolve paths via
                       resolveSessionPath() which searches cody-sidebar-chats/** as fallback;
                       listAllSessions() excludes sidebar (scans only main sessions root);
                       isSidebarSessionPath() gates access control in DELETE /api/sidebar-chats/[id]
  btw.ts               side questions (omp 18.7 `/btw`), pure + browser-safe: topic types, parseSideQuestionCommand, the frame/snapshot merge rules (applyBtwFrame, mergeBtwSnapshot), describeBtwError, the omp-version gate
  btw-history.ts       server-only bounded reader of omp's btw-history sidecar beside the session file (running → interrupted when no engine is live)
  sidebar-mode.ts      the Side Bar's pure view state (browser-safe reducer): which view is chosen (This chat / New chat), a `/btw` request taken exactly once, a bare `/btw`'s cursor still waiting to land, and the choice dropped when This chat goes away
  skills-service.ts    pure-Node skill discovery mirroring the ACTIVE engine's
                       providers (omp's list, pi's narrower one) + getSkillsSurface(): what the surface can do here
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
  thinking-level-labels.ts  the one raw-reasoning-level → label-key map shared
                       by the composer selector, its pending status, chat
                       notices and the subagent dialog
  project-todo.ts      .cody/todo.json schema, atomic mutation/history (human panel only)
  workspace-tasks.ts   .cody/tasks.json schema validation + grouping
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  transcript-anchor.ts the reader pin's anchor: what a scrolled-up reader is
                       looking at, by transcript identity (turn index / part /
                       block index + offset), captured on scroll and restored
                       after every commit — see "Chat scroll" below
  transcript-scroll.ts the scroll rules of a transcript that is read AND
                       followed: the pin/unpin decision for a scroll event
                       and the row anchor (stable row key + offset) that holds
                       a reader's place — used by the subagent transcript
  subagent-transcript.ts  the open subagent transcript as a bounded window of
                       pages: rows keyed by byte offset, prepend/append, and
                       trimming that drops the page farthest from the reader
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  SendPill.tsx        the Send button: one pill whose main part sends and whose
                      joined ▾ zone (and a right-click, and a long press) opens
                      ScheduleMenu
  ScheduleMenu.tsx    that menu: a popover on a mouse, a bottom sheet on touch —
                      Send now · When quota resets · Send at… (quick times and a
                      native date-time field)
  ScheduledBar.tsx    the scheduled messages as one slim bar above the composer
                      (collapsed summary; opened: one row each with Edit / Send now
                      / Cancel icon buttons, Retry when failed)
  DailyLimitRing.tsx  the daily time limit's circle in the controls row (liquid fill,
                      popover) and the glyph the other surfaces reuse
  DailyLimitNotice.tsx the calm "you've reached today's limit" bar above the composer
  SidebarChatPanel.tsx the Side Bar: a "This chat | New chat" switch (a SegmentedControl,
                      shown only where side questions exist) over two views that both
                      stay mounted, so flipping it never stops a streaming sidebar
                      answer. New chat = the sidebar chat: rpc-managed session, model
                      picker (grouped by provider) + thinking level, message display,
                      composer (no file editing, no tools). Image attachments go
                      through the MAIN composer's engine — `prepareImageBatchForAttachment`
                      (lib/image-compress.ts), same 900 KiB prompt-frame budget and
                      WebP fallback — by click, drop or paste. `auto` is a real
                      thinking OPTION, not an absence: unset means "the model's own
                      default", which is what the main composer shows and sends, and
                      without the row the trigger rendered blank. This chat =
                      SidebarSideQuestions
  SidebarSideQuestions.tsx  the Side Bar's "This chat" view (omp's /btw): topics newest first (ten, the rest behind Show all) with streaming markdown answers, Cancel, Copy and a follow-up box per topic, and the new-question box at the bottom built like the New chat composer. Presentational: the state lives in useSideQuestions and arrives over useSideQuestionsBridge
  ComposerPanels.tsx  composer-attached goal + todo + subagent panels (collapsible, live states)
  GoalPanel.tsx      the Goal row of ComposerPanels: the engine's goal (objective, status, tokens vs budget, live time, Pause/Resume/Drop with a two-tap Drop, "Keep working automatically") or the fallback note
  TodoList.tsx        todo phase grid with preview/show-all (used by ComposerPanels)
  SubagentTranscriptDialog.tsx  header + Result → Task → Transcript in ONE scroll container + steer footer (wide, fixed height)
  SubagentTranscript.tsx the transcript section of that dialog: rows drawn by
                      MessageView, the one "Show earlier" control, "Jump to
                      latest", loading / error / empty states
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  HomelabberApproval.tsx the React half of those approvals: the transcript-wide
                      index (context + provider), `useApprovalCard`, the status
                      row with the live countdown and the two ways to approve
  CommandPalette.tsx  ⌘K/Ctrl+K palette (cmdk): session switch, new session, theme
  ImageLightbox.tsx   click-to-preview lightbox for chat images (ClickableImage)
  BranchNavigator.tsx in-session branch switcher
  DiffView.tsx        folding unified-diff renderer (FileViewer + GitPanel)
  GitPanel.tsx        right-panel Git tool: changed files + diffs + branch info
  todo/
    TodoPanel.tsx       right-panel To-do list UI: input, active/done rows, drag-reorder,
                        inline title/notes/color editing, delete with undo, clear-completed
    TodoItemRow.tsx     memo'd row component: checkbox with animation, colored dot palette,
                        chevron-toggled inline notes textarea, grip drag-handle, trash, hover-reveals
    TodoQuickAdd.tsx    top-bar quick-add input; Enter adds + keeps focus, Escape clears
    useTodoDocument.ts  hook: poll/SSE watch on /api/todo, optimistic mutations, busy/error state
  TasksPanel.tsx      embedded Commands runner for .cody/tasks.json
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
  InputDock.tsx       non-modal composer panel for extension, permission, and
                      refusal questions; keeps the transcript visible
                      Also draws the model's `ask` walk (one card per field), the
                      one-line "a message withdraws this question" warning and the
                      ONE scroll area (sticky Cancel/Done) that holds a whole prompt.
  ExtensionDialog.tsx select / input / editor requests, including the radio / checkbox
                      view of an `ask` step (ticks from omp's `checkedIndices`, action rows
                      past `markableCount`) and masked (`secret`) inputs.
                      `lib/ask-walk.ts` is the pure logic behind both (tested);
                      `lib/extension-title.ts` splits the header from the body text.
  PermissionRequestCard.tsx one approval an ACP engine is blocked on, shown
                      inside InputDock with the transcript still in view
  ProviderIcon.tsx    vendored brand marks (models.dev logo set + simple-icons for
                      the few it stubs); ProviderIcon = a provider, ModelIcon = a
                      model's vendor. Never hotlinked — see the note below
  ModelsConfig.tsx    omp's models.yml editors (provider/model entry forms, the
                      thinking-level ladder) plus the coloured brand tiles
                      Settings draws providers with; rendered inside
                      settings/providers/ProviderDetail's "Advanced" form for a
                      custom endpoint — the old tree-and-detail dialog that used
                      to live here is gone, its registry/roles/composer-picker
                      views having moved to the Models and Providers hubs
  McpConfig.tsx       MCP server editor (Settings › Extensions › MCP), scoped
                      to this project's mcp.json or the user-level one
  PluginsConfig.tsx   embedded under Settings › Extensions › Plugins; opens
                      PluginMarketplace
  PluginMarketplace.tsx marketplace dialog: browse/search/install across
                      configured `omp` marketplaces, manage marketplaces
                      (opened from PluginsConfig and the System hub's card)
  SkillsConfig.tsx    embedded under Settings › Extensions › Skills; opens
                      SkillsStore
  SkillsStore.tsx     skill store dialog: skills.sh browse/search/detail/install
                      (opened from SkillsConfig and the System hub's card)
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)
  SettingsTabs.tsx    now just shared TYPES/constants (SettingsTab,
                      EngineCapabilities, ALL_CAPABILITIES, PlatformInfo,
                      DEFAULT_HARNESS_LABEL, OMP_ENGINE_ID,
                      SCHEMA_TAB_CAPABILITY, extensionsGroupDescription,
                      getNormalizedActive) — the tab-bar COMPONENT and its
                      hand-listed category table are gone; see Settings shell
  SettingsConfig.tsx  ~20-line entry point: hands AppShell's props to
                      settings/SettingsShell and re-exports its request type
  settings/           the Settings dialog itself — see "Settings shell" below
                      for the registry/data-cache/writer contracts this
                      directory is built on; file by file:
    registry.ts         SETTINGS_SECTIONS, the hub table every rail reads
    shell-context.tsx   useSettingsShell() / useSettingsOpener() contracts
    SettingsShell.tsx   the dialog: desktop rail+pane, phone MobileStack,
                        dialog-wide search, the busy/leave-confirm guard
    SettingsSidebar.tsx / MobileStack.tsx  desktop rail; phone root list + stack
    SettingsSearch.tsx / search-index.ts  results list; the static ∪ dynamic
                        search index (each panel's SEARCH_ENTRIES + schema rows)
    Drawer.tsx          the one nested-surface primitive (side / push / dialog
                        presentations; never a second Dialog)
    Directory.tsx       the sectioned-row-list primitive (Connected/Discovered,
                        the engine roster, MCP servers)
    DangerZone.tsx      the confirmed-destructive-row block, one per hub
    SaveStatus.tsx      per-hub save/error corner indicator
    SegmentedControl.tsx the MCP/Skills/Plugins and Catalog/Assignments switch
    primitives.tsx      NativeSetting row, chip styles, SettingsHighlightContext
    new-badges.ts       the "New" badge context, `isBadgedRow`, the hub/sub-view dot
                        computation and the `N new` label
    EngineRoster.tsx    install/switch/update/reinstall/revert/uninstall for
                        every known engine; shared by Settings › System ›
                        Engines and the setup flow's engine step
                        (`mode="pick"`). An engine that is SELECTED but not
                        installed reads as exactly that — never "active", in
                        either mode — and pick mode auto-advances on a
                        successful install
    AccountSettings.tsx / AccessTokensSection.tsx / account-controls.tsx
                        Settings › Account: profile, password, tokens, roster
    SystemUpdates.tsx    Settings › System: the Cody update card over the
                        EngineRoster
    RetryFallbackPanel.tsx / ModelPlanPanel.tsx  Behavior's retry/fallback
                        chain editor and the plan-apply wizard
    ProviderLoginFlow.tsx the one sign-in state machine (SSE frames → URL +
                        paste box, device code, prompt, progress, success/
                        error), used by providers/ProviderDetail and the
                        setup wizard's provider step
    panels/             one file per hub (Account, Preferences, Notifications,
                        Code hosts [= Forge], Providers, Models, Engine
                        [= Behavior], Extensions, System), each a thin
                        composition of the pieces above plus that hub's own
                        SEARCH_ENTRIES export. NotificationsPanel edits the
                        ntfy settings (`/api/notifications`), English-only
                        like every Settings panel
    providers/          the Providers hub: ProviderDirectory (the Connected /
                        Discovered list), ProviderDetail (the sign-in / keys /
                        custom-endpoint drawer), ClaudeCreditsSection (the
                        Anthropic drawer's "API credits (backup)" key rows;
                        claude-credits-view.ts is its pure half),
                        AddProviderPicker, LocalEndpointForm,
                        provider-groups.ts (the Add picker's sections),
                        controls.tsx (shared row bits)
    models/             the Models hub: ModelCatalog, ModelCurationDialog
                        (omp's per-provider selection), ModelAssignments +
                        ModelRoles (role → model), DistillAssignment
                        (Cody's own Distill chain, gated on
                        /api/distill/config, not on a capability),
                        NewModelsNotice
    engine/             the Behavior hub: RecommendedSettings +
                        recommended-cards.ts (the curated-card table),
                        SchemaSettingsList (the engine's complete schema,
                        chip-grouped, secrets masked), HelperMemoryCard
                        (helper agents' memory limit; logic in helper-memory.ts)
    DiskSection.tsx     the System hub's "Disk space" card (`/api/disk`):
                        meters, largest scratch folders, "Clean idle scratch
                        now", idle-days setting. Highlight id `disk`
    MachinesSection.tsx the System hub's "Machines" card: rename this server,
                        add / edit / remove ssh machines (a removal answers with an
                        Undo toast that re-adds it), a Test button
                        (`/api/machines`, admin writes). Highlight id `machines`
  machines/           the top-bar machine meters: MachineMeters.tsx (the
                      measured slot, a chip per machine at the density that
                      fits — this server wears a server glyph, not an initial,
                      in the slim chip — the phone's one-indicator ring) and
                      MachinesPanel.tsx (the dropdown's per-machine cards).
                      This server's DEFAULT name ("This server") is stored in
                      English and shown in the reader's language by
                      `machineDisplayName` (lib/machines/present.ts); a name
                      the person chose is shown as typed
    MachinesSection.tsx (addition) per ssh machine a "Use as worker" switch, a "Check worker" button, the
                        facts it read and why a check failed; MachinesPanel.tsx shows a worker's running
                        jobs ("2 jobs running") and "Worker not ready"
    ServicesSection.tsx, ReplayDataRow.tsx, engine/list-draft.ts, statistics/*, AskResultPanel.tsx,
    NoticeActions.tsx, QuotaAutoSpend.tsx, ScheduleModelPicker.tsx, engine-crash-toast.ts: see the compact map in AGENTS.md
  ui/                 shared primitives: Dialog/Tooltip/Collapsible, fields, toast

hooks/
  useSettingsData.ts       the Settings dialog's route cache (useSettingsRoute/
                           useSettingsRoutes): one in-flight request per route,
                           an `unsupported` answer cached as a value, prefix
                           invalidation for writers
  useConfigWriter.ts       the one writer for omp's config.yml: per-family FIFO
                           queues, coalesced schema patches, useNativeSettings
                           for the curated cards
  useSchemaIndex.ts        the active engine's settings schema, indexed with
                           each row's effective value, `ui.condition` result and
                           changed-from-default flag; backs Behavior AND the
                           dialog-wide search
  useSettingsNewKeys.ts    one answer per Settings open + the seen/changed reporters
                           for the "New" badge
  useModelCatalog.ts       Settings › Models' one row shape across omp/pi/ACP
                           catalogs, with who hid/pinned what and what is new
  useLocalAiScan.ts        client for `/api/local-ai`, feeding Providers ›
                           Discovered
  useSettingsHistory.ts    mirrors the phone stack's depth into browser history
                           so a back gesture pops exactly one level
  useAgentSession.ts       messages + streaming + SSE + fork/navigate/reconciliation logic
  claude-credits-notices.ts  the pure decisions behind the "plan limit -> API credits"
                           chat notices: which event is the switch, what silences the
                           plan's own warning, when the plan is back
  useAudio.ts              completion sound + browser AudioContext unlock
  useDragDrop.ts           shared drag/drop state
  useDisplayRequests.ts    display-request SSE → snapshot/live request state
  useMachineMeters.ts      the machines SSE as a page-wide store (useSyncExternalStore):
                           MachineMeters and MachinesPanel subscribe, AppShell does
                           NOT (a frame a second would re-render the whole shell);
                           one stream, opened with the first subscriber, closed
                           with the last and while the page is hidden (that is
                           what lets the server stop sampling); reconnects, and a
                           30 s silence watchdog
  useDailyLimit.ts         the daily time limit's one client store (`useDailyLimit`),
                           its actions, and `useDailyLimitTracker` (mounted once in
                           AppShell): counts ACTIVE time only, a timer only inside a
                           stretch of activity, never while hidden or idle
  useNotificationPresence.ts  tells the server which chat this tab is showing
                           (POST /api/notifications/presence: on change, on
                           visible, every 30 s while visible, null on hide /
                           pagehide via sendBeacon) so push notifications skip
                           the chat you are looking at
  useScheduledMessages.ts  this chat's scheduled messages for the composer's rows
                           and the Send menu: read on open, tab focus, network
                           return, a run ending and at the next due time —
                           never polled (lib/scheduled/sync.ts holds the rules)
  useSideQuestions.ts      this chat's /btw topics: history read on open and on every stream (re)connect, deltas applied once per animation frame, ask / follow-up / cancel, the omp-version and `Unknown command` latch; returns ONE memoised object (it carries `sessionId`), so it changes only when a topic, flag or error does
  useSideQuestionsBridge.ts  how those topics reach the Side Bar: AppShell makes the bridge, ChatWindow publishes into it (`usePublishSideQuestions`), SidebarChatPanel subscribes (`useBridgedSideQuestions`, `useSyncExternalStore`); also the `SideQuestionsRequest` token a typed `/btw` uses to ask AppShell for the Side Bar's This chat view
  useDistill.ts            the client store over POST /api/distill: SSE framing,
                           per-key in-memory cache, FIFO queue capped at two
                           concurrent streams (a queued request for a key is
                           replaced by a newer one, a DISPATCHED one is left
                           to finish), the permanent `unsupported` latch and
                           the separate temporary 401/403 backoff
  useIsMobile.ts           responsive breakpoint hook
  useSubagentTranscript.ts the open subagent transcript's data: newest page,
                           earlier pages on request, live append, bounded window
  useTranscriptScroll.ts   follow / reader anchor / edge auto-load for that scroller
  usePrefersReducedMotion.ts OS reduce-motion preference (SMIL-safe)
  useTheme.ts              theme state: saved per account (/api/accounts/me) and mirrored in localStorage "cody:theme"; first visit follows prefers-color-scheme

bin/

  cody-server.js           custom server; also WS upgrade for /api/display/socket
                           (stream frames + input) and native-gateway host routing;
                           mints the display capability secret at boot; stops the
                           machine sampler (every ssh child) at shutdown
  cody-display-mcp.js      bundled stdio MCP server exposing open_preview (plus the session, scheduling,
                           chat-messaging, model-switch, device and worker tools) to Claude/Codex engines (posts to /api/internal/*)
  cody-omp-reset-cli.mjs   spends a saved reset through `omp usage reset`
  cody-pi-login.mjs        pi's provider sign-in helper: imports the INSTALLED pi
                           package's AuthStorage/OAuth flows and speaks JSON
                           lines to lib/harness/pi-login.ts (list / login /
                           logout), so pi's own auth.json holds the credential
  cody-omp-credentials.mjs omp's credential list/remove helper: runs omp's own
                           AuthStorage under Bun (list / remove / removeProvider),
                           emits identities and block state only, never a token;
                           purges omp's soft-delete tombstones (see "Removal is
                           real" under Several accounts)
  cody-omp-auth-api.mjs    the one AuthStorage surface the omp Bun helpers call:
                           namespaced (omp 18.3.4+) first, flat names as fallback
  cody-omp-claude-credits.mjs  list / add the Claude API keys (`anthropic-api`) through
                           omp's own AuthStorage under Bun: the key arrives on STDIN,
                           only ids and the last four characters come back
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

