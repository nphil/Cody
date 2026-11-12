# Pluggable engines

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

## Pluggable engines (`lib/harness/`)

The coding agent under the UI is a swappable **engine**: omp (founding,
full-featured), plus pi, Claude Code and Codex (experimental). Full
architecture: `docs/harnesses.md`. The load-bearing rules:

- `getHarness()` resolves persisted selection (`cody-engine.json`) →
  `CODY_HARNESS` env → omp. `selectHarness(id)` persists a switch; the
  select route then calls `restartAllRpcSessions()`.
- **Cody-level state always lives in the instance data dir** (`lib/omp/paths`
  `getAgentDir()`): accounts, checkpoints, engine selection, session owners,
  the engine session index, the tools prefix, per-engine provider keys
  (`cody-provider-keys.json`), who hides/pins which models
  (`cody-model-visibility.json`), the model-catalog "seen" ledger
  (`cody-model-catalog-seen.json`) and the Settings "New" ledger
  (`cody-settings-seen.json`). Never route these through the
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
    description (`AcpEngineSpec`), never a class. Claude Code and Codex speak it through
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
  leaks at once: with `models` and `skills` never threaded, the `Smart`
  model-roles row (which fetches omp's `config.yml`) rendered on pi because it was
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
  `engine.shortName` (`chatInput.smartModelHint`,
  `.smartModelUnavailable`, `.thinkingAuto`, `.toolPresetCoreWarning*`,
  `.groupEngineBuiltin`, `agentSession.startingAgent`,
  `info.section.engine`; the fallback toasts no longer name the engine at
  all, they name the JOB, see the model-switch marker note below). The sole
  intentional exception is the Smart model
  label: it is exactly `Smart`, with no engine, role, or resolved-model
  suffix. `agentSession.startingAgent` fires on any slow first connect —
  i.e. exactly an ACP engine's cold start — which is why it said
  "Starting omp…" to a Codex user. The Info panel's copyable diagnostics say
  `Engine: <shortName> <version>` for the same reason: the VALUE was always
  the active engine's, only the label lied.
- **Composer request state has two authorities.** Fast catalog support is a
  capability prediction, while `fastModeActive` and explicit
  `fastModeUnavailable` come from the live engine. The compact Fast control
  says **Fast off**, **Fast requested**, **Fast inactive**, **Fast unavailable**,
  **Fast unverified**, or **Checking**. Requested means the engine accepted a
  priority request; it is never positive confirmation that the provider is
  actually servicing it. Inactive means the enabled request is not receiving
  engine priority and normal service applies, not that it was rejected; it can
  still be turned off. An active engine answer outranks stale catalog metadata.
  Reasoning-level changes are allowed during a run, lock only while awaiting
  engine acknowledgement, and apply to the next model invocation (including a
  tool continuation), never the stream already in progress.
- **Slow mode and the usage-limit stage are engine-reported and follow the
  active model** (`lib/slow-mode-state.ts`, omp 18.6.3+). `get_state` carries
  `slowModeSupported`/`slowModeEnabled`/`slowModeScope` and `usageLimit`;
  `deriveSlowModeState` returns `null` — and the **Slow** switch in the model
  dropdown does not render at all, never as a disabled control — when the
  engine omits them (older omp, pi, ACP) or the model has no slow mode. The
  switch sends `set_slow_mode {enabled}` (`Unknown command` hides it, like the
  other newer-omp commands) and re-reads state. Scope matters in the words:
  `session` is this chat's own flex tier; `global` is persisted config
  (`providers.anthropic.slowMode` in `config.yml`) that EVERY chat shares, and
  the switch's hint says plainly that it is saved for every chat. A missing
  scope is read as `session` so the switch never promises reach it cannot
  confirm. `usageLimit` (`low_priority` with a reset time, or `wrap_up` with
  `extraUsage`) is shown as a status dot on the quota ring, a suffix on its
  tooltip, one line right under the QuotaPopover hero (tooltip = the full
  sentence), and ONE chat notice when a chat first sees a stage or moves
  between stages — never on leaving one, because the field also vanishes on a
  model switch. All copy is `slowMode.*` (en/ja/zh-CN) via
  `describeUsageLimit`; times go through `formatResetTime` in the reader's zone.
- **A capability flag is a UI convenience; the ROUTE is the boundary**
  (`lib/engine-guard.ts`). Every omp-shaped endpoint used to answer 200
  whichever engine was selected — probed directly under another engine they served
  omp's model catalog, model roles, models.yml, config.yml, login providers,
  plan quota and version, each presented as that engine's. Some were reachable
  through the UI too, because the flag that hid them is not the flag they
  needed: an engine that declares `nativeSettings` (it has its own config)
  rendered omp's `config.yml` panels with a Save that wrote to a file it
  never reads; pi has `chatExtras` and so offered omp's `Smart` model-roles
  row and an Export that shells `omp --export`. Every such route now either
  DISPATCHES on `getHarness()` (`/api/models`, `/api/omp-version`) or on an
  ADAPTER METHOD (`/api/omp-settings/schema` → `HarnessAdapter.settings`), or
  REFUSES with 400 `{code:"unsupported"}`, which is the same answer
  every capability-gated route gives and the one the client hides on. Prefer the adapter
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
  currentModelId}` + `session/set_model` + `current_model_update` (kept for an
  agent that publishes no `configOptions` at all). The
  shape decides which call is made, so `acp-session.ts` still names no
  engine. Whether an agent offers models is per SESSION — it depends on the
  account the session opened with — so it is reported as data, never as a
  static capability flag that could not tell the truth about it.
- **ACP session MODES are session state the same way** (`AcpModeSurface`,
  `session/new` → `modes: {availableModes, currentModeId}`). Claude publishes
  Manual / Accept edits / Plan / Auto, Codex none — and "none" is the answer for every rpc-dialect engine
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
  the process environment (pi/omp env maps,
  Claude `ANTHROPIC_API_KEY`, Codex `OPENAI_API_KEY`), so the store is a
  0600 JSON file in the instance data dir and `engineChildEnv()` is the one
  function every child spawn (`lib/omp/rpc-process.ts`,
  `lib/harness/acp-session.ts`, `lib/terminal-manager.ts`) builds its env
  from: process env, then stored keys, then the spec's own entries (a spec
  must be able to override — `CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`). Values
  never reach the browser; the panel gets `stored` / `fromEnvironment`
  flags. This is what the owner's "pi didn't work" came down to:
  no credentials, and Cody dropping the error — an assistant turn ending
  with `stopReason: "error"` used to append an EMPTY bubble; it is now an
  error notice in the provider's words, with a pointer at the keys panel when
  the text smells like a 401.
- **Engine start-up failure detection.** `lib/omp/rpc-process.ts` recognises an engine that exits before answering by its stderr line. omp 18.19 prefixes it with `error:` and a typed name (`SessionModelRestoreError:`) where 18.8.3 printed the bare sentence; the regex accepts both, so a missing/unavailable model on `--resume` is reported the same on either engine.
- **Engine install needs Bun.** `lib/harness/install.ts` checks the Bun version before installing omp 18.19+ (engine floor Bun 1.4.4) and refuses with a plain message; older omp keeps the old floor. `docker/Dockerfile` ships Bun 1.4.4. The `bin/cody-omp-*.mjs` helpers need Bun >= 1.4.4 as well (they open agent.db; 18.16+ installs an SQLite lock shim on Linux and logs "SQLite OFD lock shim unavailable" once on stderr if it cannot).
- **Providers, sign-in roster and catalog.** The Providers list joins three sources: the engine's sign-in roster, Cody's curated catalog (`lib/harness/provider-catalog.ts`) and the model catalog. Row ids must be unique: a roster id that a catalog row does not list in `loginIds` still merges into the row whose `id` equals it (omp 18.16.0 added a `mistral` sign-in; the Mistral entry now lists `loginIds: ["mistral"]`). The eight API-key vendors omp added after 18.8.3 (`cloudflare-workers-ai`, `coralbricks`, `inception`, `liquid`, `modular`, `otari`, `sambanova`, `scaleway`) are catalog rows marked `needsRoster`: they are listed only when the engine's roster or model catalog names them, or a key for them is already saved, so 18.8.3 never shows a paste box its omp would ignore. One variable per field: the first name from omp's own rules (`CLOUDFLARE_API_TOKEN`, `CORAL_API_KEY`, `INCEPTION_API_KEY`, `LIQUID_API_KEY`, `MODULAR_API_KEY`, `OTARI_API_KEY`, `SAMBANOVA_API_KEY`, `SCW_SECRET_KEY`); the aliases (`CLOUDFLARE_AUTH_TOKEN`, `CORALBRICKS_API_KEY`, `SCW_API_KEY`) still work in the server's environment. Cloudflare Workers AI also needs `CLOUDFLARE_ACCOUNT_ID` (a non-secret field) when the token is a pasted key rather than a stored sign-in. Devin is one row with a key and three sign-ins (`devin`, `devin-cli`, `devin-windsurf`; all store as provider `devin`). Real-roster regression fixtures: `lib/harness/fixtures/omp-login-roster-18.8.3.json` (81 entries) and `-18.19.0.json` (92).
  New curated vendors also need an entry in `components/settings/providers/provider-groups.ts` (`KEY_IDS`, or `GATEWAY_IDS` for a router like Otari).
- **Sign-ins omp refuses over RPC.** omp's RPC mode cannot answer a prompt asked before any URL. From omp 18.18.7, Google Antigravity first makes the user type `yes` to a risk warning, so a Cody sign-in fails at once with "requires interactive prompts which are not supported in RPC mode". omp's roster carries no flag for this, so `lib/omp/provider-login.ts` keeps `TERMINAL_ONLY_SINCE` (provider id → first omp version that refuses it) and `list()` sets `terminalOnly: true` on those roster rows only when the installed omp is at least that version (`getOmpVersion`; an unreadable version flags nothing). The Providers detail then shows "Sign in from the omp terminal: type /login" instead of the Sign in button, and `ProviderLoginFlow` never auto-starts it. Any refusal that slips through (`requires interactive prompts` / `requires secret input`, `not supported in RPC mode`) is translated by `explainLoginError` into a `TerminalOnlyLoginError` with code `terminal_only`; the login route forwards the code in the SSE `error` frame and the panel shows its own translated words. When omp flags more providers this way, add them to `TERMINAL_ONLY_SINCE`.

  A login can ask more than one `input` (Cloudflare Workers AI: API token, then account id). The login driver answers each request with whatever the user submits next; a stale prompt waiter used to swallow the second submission and is fixed (`deliver`).
- **Refreshing models after sign-in or sign-out.** omp 18.18.2+ refreshes its scoped model list only inside the process that signed in or out. Every Cody sign-in success, sign-out and account removal therefore goes through `settleProviderChange` (`lib/provider-state.ts`): drop Cody's model cache and sign-in roster, restart idle chat engines, leave mid-reply ones alone. Do not call `invalidateModelsCache` directly from a new login/logout path.
- **Moving sign-ins between machines (omp auth export / import).** Not offered in Cody: Cody deliberately never lets credential secrets into its own process, and an in-app export would. The terminal commands are `omp auth export` and `omp auth import` on the server's omp.
- **Signed-out providers and saved-reset notices (omp 18.15+).** omp hops BEFORE the turn onto the first keyed `retry.fallbackChains` entry when a model's provider has no login, announcing it as `retry_fallback_applied` with `reason: "no credential for <provider>"` (src/session/turn-recovery.ts). With no keyed fallback it refuses the prompt with `No API key found for <provider>.` (18.19.0: typed PromptPreflightError; 18.8.3: plain Error; same text, so the result is a failed prompt response / `prompt_error` / `prompt_result` error on both). hooks/credential-notices.ts is the one pure module that reads those strings (`missingCredentialProvider`, `missingApiKeyProvider`) and maps the `claude-auto-reset` / `codex-auto-reset` notice sources (`savedResetEligibleProvider`). The hop is told as "You are signed out of X; using Y until you sign in" (hooks/useAgentSession.ts `announceFallbackApplied`, composer chip reason `signed_out`); the refusal goes through `engineErrorNotice` (and `rollBackFailedSend`) and reads "You are signed out of X, so your message was not sent". Both notices carry a button, found by the shelf from the notice `dedupeKey` (`signed-out:<provider>` / `saved-reset:<provider>`, see `noticeCtaForDedupeKey`): components/NoticeActions.tsx renders "Sign in to X" (Settings > Providers, `provider-<id>` highlight) or "Use reset" (confirm dialog, `useResetCredits().redeem` on the first redeemable credit of that provider; no button when none) plus a link to the auto-redeem setting (first of `claudeResets.autoRedeem5h|Weekly|autoRedeem` / `codexResets.*` the engine schema has). `creditsNoticeKind(from, to, reason)` returns null for a signed-out reason, so a hop off a signed-out Claude plan onto the credits is never worded "Claude plan limit reached". Notices with buttons stay 20 s (plain ones 5 s). Other `claude-auto-reset`/`codex-auto-reset` notices (redeemed, already redeemed, will retry) show omp's own words as plain info/warning, never through the engine-error describer (a 429 code would read as a usage error). The saved-reset EXPIRY warning (C5-20, omp 18.9+) is built only for omp's terminal status line (modes/status-line-host.ts) and is never a `notice` frame, so an RPC host cannot show it; Cody's own expiry badge covers it. Cody always spawns omp with a prompt UI, so the "no prompt UI" saved-reset notice itself is not reachable in Cody chats (the consent is an ordinary select dialog); the mapping is kept for headless/ACP engines.
- **Signed-out notices keep Cody's "no credentials" banner and the chain rules.**
  - `components/ChatInput.tsx` `modelErrorCode === "no_credentials"` banner: comes from `lib/models-cache.ts classifyModelError` on "No models available" from `get_available_models`, i.e. only when the whole model LIST is empty (nothing signed in). In that state every fallback chain entry is also unkeyed, so omp finds no hop candidate and refuses the prompt (AU-10 text) - the banner and the refusal agree. A single signed-out provider among others does NOT empty the list, so the banner never fires there; the hop notice is the right signal. Keep the banner.
  - `lib/routing/chain-binding.ts` / `reconcile.ts` / `lib/claude-credits.ts` have no credential logic (an empty chain still means "no fallback"; omp's `#findKeyedRetryFallback` honours an empty chain and `retry.modelFallback` too, so an empty chain yields no hop, the refusal appears instead). Nothing can be bypassed that Cody relied on. Evidence: read from omp 18.19.0 source (turn-recovery.ts ~2094-2110, agent-session.ts ~9549), and CatchupAuthNotices-2's runs on both engines (keyed chain: hop frame then agent_start; no chain: late failed response + prompt_result error on both 18.8.3 and 18.19.0).
  - 18.8.3 never sends the hop; the notice code is inert there and the refusal text is handled.
- **Saved-reset consent dialog has a multi-line title.** omp's saved-reset consent is an extension `select` whose TITLE is "Spend a saved X rate-limit reset?\n<one line per account>". The InputDock header is a single ellipsized line, so the account lines were squashed/cut. Now: header shows the first line (`splitExtensionTitle().headline`), and ExtensionInputCard shows the remaining lines as a wrapped paragraph above the options. Option descriptions ("Redeem now and set <keys> to yes.") already render via `optionDetails` (verified in components/ExtensionDialog.tsx; text comes from the engine, so the new per-window keys appear automatically).
- **Provider SIGN-IN is each engine's own, behind one seam**
  (`HarnessAdapter.providerLogins`: `ProviderLoginSurface` in
  `lib/harness/types.ts`, gated by `capabilities.providerLogin`). A
  subscription (Claude Pro/Max, ChatGPT, Nous Portal, GitHub Copilot, …) is a
  credential only the engine's own store may hold, and every engine has a
  login of its own that prints a URL and takes a code back — omp's rpc-ui
  extension frames, pi's pi-ai flows, `claude auth login`,
  `codex login --device-auth`. The surface is
  `list()` → rows `{id, name, authenticated, kind: oauth|device, canLogout}`,
  `login(id, ui)` with `ui = {onUrl, onDeviceCode, onPrompt, onManualInput,
  onProgress, signal}`, optional `logout(id)`. `/api/auth/providers`,
  `/login/[provider]` (SSE + POST for the pasted value) and
  `/logout/[provider]` dispatch on it and refuse `unsupported` without it;
  the route turns the `ui` calls into the frames the panel already rendered
  for omp (`auth`, `device_code`, `prompt_request`, `progress`, `success`,
  `error`, `cancelled`) and holds a value pasted BEFORE the engine asks —
  the paste box is on screen from the first URL, and a redirect URL usually
  arrives first. `components/settings/providers/ProviderDetail.tsx` renders
  the Sign in / Re-login / Sign out row in every provider's detail drawer
  (Settings › Providers), for every engine with `providerLogin`;
  `ProviderLoginFlow.tsx` is the one state machine it shares with the setup
  wizard's provider step. Credentials
  never pass through Cody: a driver relays a URL out and a code in and reads
  the engine's answer. `/api/auth/all-providers` stays omp-only (it reads
  omp's model catalog to list configured API-key providers).
  **Every removal control reports its real outcome** (toast, plain words; a
  failure also stays as an inline error): the per-account trash and the
  provider-wide "Disconnect" read `postLogout()` (ProviderLoginFlow.tsx);
  a 404 `not_found` is an info toast + refresh (the account was already
  gone), never an alarm. The drawer's danger zone is `Disable in {engine}`
  (toast with Undo) and ONE `Remove {provider}` that signs out every
  sign-in holding accounts, forgets every key saved in Cody and deletes a
  custom endpoint (`planRemoval` / `runRemoval` / `reportRemoval`, pure and
  unit-tested; stops at the first failure and says what was and was not
  removed). A key only the SERVER'S ENVIRONMENT sets is not Cody's to
  remove: the row says "Set in the server's environment — remove it there"
  (no button; `PUT /api/provider-keys` answers 409 `set_in_environment`),
  and Disable is the way to hide it. The directory re-reads usage and the
  OpenRouter balance after every change so a removed account leaves the
  Usage block at once.
- **Several accounts can serve one provider, and which one is IN USE is the
  engine's fact, never a Cody guess** (omp only today). omp's `agent.db` may
  hold more than one OAuth credential per provider (two Claude subscriptions,
  say). omp keeps a conversation on the account that served it (session-
  sticky; Anthropic's prompt cache is per account) and rotates to a sibling
  only on a limit. It records the serving account after every turn as a
  `credential_pin` entry in the session file (a sha256 of the account's
  billing scope, omp `src/session/credential-pin.ts`). Cody reads THAT:
  `bin/cody-omp-credentials.mjs` emits each OAuth row's `pinHash` (omp's own
  `credentialPinHash`, falling back to the same persisted formula),
  `lib/usage/cache.ts` indexes digest → credential row (server-only),
  `lib/usage/session-pins.ts` reads a session's latest pin per provider
  (append-only, incremental), and `/api/usage?session=` answers
  `sessionAccounts: {provider: {accountId, since}}`.
  `lib/usage/select.ts` `rankProviderAccounts(…, evidence)` then orders
  `in_use` → `standby` (by headroom) → `limited` → `disabled`, with a
  `basis` on the in-use row: `session` (the pin), `recent` (no conversation
  in scope — Settings — so the account omp last refreshed from a live
  response, `lastServedAt` = omp's `headersUpdatedAt`), or `expected` (the
  conversation has not used the provider; omp routes its first request on
  headroom). A pin naming a limited/disabled account is overruled. **Trap —
  never rank "in use" by lowest utilization:** the account in use is the one
  burning quota, so headroom picks the idle sibling. That shipped as
  "Serving next · Secondary 0%" while every reply came from Primary at 41%.
  A pin the server cannot match to an account (credential store unreadable,
  account removed) is still reported, as `{accountId: null, since}`: the
  conversation HAS used the provider, so the popover ranks with the
  `recent` evidence instead of falling to `expected` — dropping it is what
  made the Kestrel chat gauge the idle Secondary at 0% after omp 18.3.4
  broke the credential read. The account rows say `In use` / `Standby` in
  words, not only through the dot's hover title.
  Accounts are named by POSITION everywhere in the composer (`usage.accountPrimary` /
  `usage.accountSecondary` / `usage.accountNth`, computed in the snapshot's
  original order, never the rank order) — no emails or org names in the
  quota popup; Settings shows the identity as muted secondary text.
  Credential ROWS come from the store, not the usage snapshot:
  `bin/cody-omp-credentials.mjs` runs omp's own `AuthStorage` under Bun
  (`list` / `remove` / `removeProvider`, the reset-credits pattern) and
  never emits tokens or keys; `lib/harness/omp-credentials.ts` bridges it,
  and `lib/omp/provider-login.ts` joins rows to usage state as
  `ProviderLoginOption.accounts` (`ProviderLoginAccount {id, position,
  label, state, planType, resetsAt, canRemove}`) and implements
  `removeAccount`/`logout`. `POST /api/auth/logout/[provider]` with a JSON
  body `{accountId}` removes ONE credential (404 `not_found` = already gone,
  a stale list, never shown as a failure; 400 `unsupported` on an engine
  without `removeAccount`); no body is the provider-wide logout and answers
  `{removed, count}` (`removed:false` = nothing was stored, never a silent
  success). `accounts` is `undefined` (never `[]`) when the read fails, and
  the sign-in row then behaves exactly as before. `accounts: []` on a
  CONNECTED sign-in means the credential is not in omp's store at all (it
  comes from the server's environment or a config file): the card says it can
  only be removed there.
  **Removal is real, and it sticks.** omp's `removeById` / `remove` only
  SOFT-delete: the row stays with `disabled_cause` set (`deleted by user`),
  the API key or refresh token still inside, and they can only act on ACTIVE
  rows. Cody used to list those tombstones as removable "Disabled" accounts,
  so Remove answered 404 "no account matching that id" forever (the owner's
  OpenRouter: a key deleted weeks earlier, listed, un-removable, and still
  READ — `lib/openrouter/key.ts` ignored `disabled_cause`, so its balance,
  an "out of credits" blackout and a Usage row outlived the removal). Now:
  the helper's `remove` / `remove_provider` delete the tombstone row, its
  block and lease rows after omp's own soft delete (`purgeTombstones` — the
  ONE raw SQL write in the Bun helpers, guarded by `disabled_cause IS NOT
  NULL` so it can never delete a credential that can still serve); `list`
  omits `deleted by user` / `replaced by` tombstones (omp's own `omp usage`
  omits the same two) and sweeps the `deleted by user` ones; an
  auto-disabled account (failed refresh) is still listed and now IS
  removable. `position` therefore renumbers after a removal, in Settings and
  the composer alike. `lib/openrouter/key.ts` reads ACTIVE rows only.
  After ANY removal, key clear or enable/disable, the route calls
  `settleProviderChange` (`lib/provider-state.ts`): models, roster, usage
  (`resetUsageCache` — a 60 s cache served stale while it refreshed), the
  OpenRouter balance (a `no_key` read is final, never served "stale", and an
  in-flight read from before the change is not cached), the saved-reset
  balances, the removed provider's route-memory blackouts, and **idle engine
  children restart** (`restartIdleRpcSessions`): a live child holds the
  credential it loaded and the key's environment variable it was spawned
  with, and an environment variable is never re-read, so a removal cannot
  depend on the child noticing. A child mid-reply is left alone and the
  response says how many (`restarted`, `active`). (The earlier note that no
  restart is needed held for the credential store alone — never for a key
  Cody put in the child's environment.)
  **A login that ended is "signed out", not "disabled".** When the provider
  refuses to renew a login for good (omp's token refresh answers
  `invalid_grant` "Refresh token expired", or the token was revoked or
  invalidated) omp disables the credential and writes why into
  `disabled_cause`. A bare red "Disabled" read as a spent quota: an expired
  Claude login sat unnoticed for two days (2026-11-10). Cody cannot stop a
  provider ending a login; it makes it impossible to miss and one click to fix.
  `lib/usage/credential-health.ts` `isSignedOutCause` is the ONE classifier
  (every other cause — a deliberate logout, a block — stays `disabled`), and
  `UsageAccountService` has `signed_out` beside `disabled`, set by
  `lib/omp/provider-login.ts` (credential row) and `rankProviderAccounts`
  (`UsageAccount.disabled.cause`). It is unusable exactly where `disabled` is
  (ranking, `availability.ts`, Claude-credits coverage, routing), but says
  what to do: the Providers drawer's account row shows "Signed out — sign in
  again" and a "Sign in again" button that starts the SAME `ProviderLoginFlow`
  as the card's own button (the card reads a plain "Sign in" when every stored
  account is signed out); the provider's row in the directory wears a "Signed
  out" badge (`ProviderRow.signedOut`) and stays in the Connected list
  although omp reports a provider whose only credential is disabled as not
  authenticated — `connected` keeps meaning "usable right now", never fold
  signed-out into it; the composer's quota popover shows "Signed out" on that
  account's row, a button to `openSettings("providers", { highlight:
  "provider-<id>" })` (`ProviderDirectory` answers a `provider-` highlight by
  opening that drawer), and when no account of the model's provider is usable
  the ring wears the usage-limit dot's warning style (`signed-out-dot`).
  **Observed against a REAL omp store:** signing in again with the SAME
  identity makes omp insert a new active row and hard-delete the stale
  disabled one (no tombstone), so Cody adds no cleanup; a different identity
  leaves the stale row, removable like any other
  (`lib/harness/omp-auth-helpers.test.mjs`). The push notification
  `accountSignedOut` (see Push notifications) is what reaches an owner who is
  not looking at Settings.
  **Every AuthStorage call in the three Bun helpers
  (`cody-omp-credentials`, `-reset-credits`, `-unblock`) goes through
  `bin/cody-omp-auth-api.mjs`**, which prefers omp 18.3.4+'s namespaced API
  (`storage.credentials.list()`, `.blocks`, `.resets`) and falls back to
  the older flat names, resolving lazily per call (the unblock helper must
  never touch `storage.credentials`). 18.3.4 renamed the flat methods away
  and every hand-written fixture kept passing, so
  `lib/harness/omp-auth-helpers.test.mjs` runs all three helpers against
  the REAL installed omp (an empty store, and stores seeded through omp's own
  API by `lib/omp/omp-test-store.mjs` for the soft-delete cases — a
  hand-written fixture cannot soft-delete);
  `lib/settings-routes-logout.test.mjs` drives the route end to end against
  such a store.
- **The composer reads whichever catalog is real.** `useAgentSession` keeps
  `modelCatalogSource` from `/api/models` and, when it says `"session"`,
  serves the composer the list it adopted off `get_state` instead (a
  session-scoped catalog). It exposes `modelSelectable` — `null` for a
  global-registry engine, where the rpc-dialect `set_model` surface
  (`chatExtras`) decides as it always did, and a boolean for a session-scoped
  one, where the SESSION decides. `ChatWindow` gates the picker on that, so no
  new capability flag was invented for something a flag cannot know. A
  session-scoped engine also seeds no `newSessionDefaultModel`: the agent
  resolves its own on `session/new` and reports it back, and the picker only
  appears once a session exists — before that there is genuinely nothing to
  choose from.
- The Docker image ships NO engine — omp included. Every engine installs
  from the picker into the persistent tools prefix (`CODY_TOOLS_DIR`,
  default `<data dir>/tools`; entrypoint puts its `bin` first on PATH), and
  the install route doubles as UPDATE (specs pin `@latest`; updating the
  active engine restarts live sessions). Binary resolution per engine:
  `CODY_<NAME>_BIN` override → tools prefix → PATH
  (`lib/harness/engine-bin.ts`; omp's probe in `lib/omp/omp-cli.ts` checks
  the tools prefix too). Selecting the already-active engine is the
  "decide later" no-op — but it is offered ONLY once some engine is actually
  installed, because with none installed it is the one action that strands a
  new user in an app where every turn fails.
- **Onboarding is one dependency-ordered flow driven by READINESS, not a flag**
  (`lib/setup-status.ts`, `hooks/useSetupStatus.ts`,
  `components/SetupWizard.tsx`, `components/SetupResumeBar.tsx`). Readiness is
  three facts — an engine installed AND active, a provider connected, a
  non-empty catalog — read from the two CHEAP routes that carry them
  (`/api/engines`, `/api/providers?cached=1`; never `/api/models`, which
  spawns the utility child). Four rules, each one a defect observed on a
  genuinely fresh instance:
  - **The engine is step 1, not a separate screen.** The old
    `components/EnginePicker.tsx` overlay ran before an unrelated wizard and
    offered "Decide later and keep using OMP" with nothing installed; taking
    it produced a working-looking app where every turn failed. The engine step
    now leads the flow, `Next` is disabled until an engine exists, and a
    successful install auto-advances (the install IS the choice). The picker
    module is gone — `EngineRoster` in `mode="pick"` is the step.
  - **Every step declares its prerequisite** (`STEP_REQUIREMENTS`), and a step
    whose requirement is unmet renders `PrerequisiteNotice` — the missing
    thing plus a button that jumps to the step that fixes it. Before this, the
    default-model step said "connect a provider in the previous step" with no
    way there, and the plan step printed the engine's own
    `omp binary not found. Install oh-my-pi or set CODY_OMP_BIN`.
  - **It resumes.** The flow opens on the first INCOMPLETE requirement, and
    `SetupResumeBar` (bottom-right; the left gutter is the sidebar, which
    clips a fixed element anchored there) names the nearest missing one and
    reopens the flow there. `setupDone` stops Cody NAGGING; it never decides
    whether the instance works, so skipping cannot hide a broken install.
  - **An unread fact is `pending`, never "missing"** (`UNKNOWN_READINESS`).
    Announcing a missing provider because the answer had not arrived yet is
    how a working instance gets told it is broken;
    `lib/setup-status.test.mjs` pins both directions.
  `/api/engines` is deliberately unreachable before the first account exists.
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
  accepts). A wrong-registry lookup is not a loud failure: it reports
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
    (`lib/harness/index.ts`): the picker card and the System › Engines
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
- **HarnessAdapter.verifiedVersion** is the exact engine version this Cody
  build was last audited against — every adapter carries one (omp: 18.19.0,
  claude-agent-acp: 0.73.0, codex-acp: 1.8.0, pi: 0.73.1).
  It is shown verbatim on the System hub's engine roster card (Settings ›
  System › Engines) ("Built to vX.Y.Z", served through /api/engines), and
  the full semver drives warnings: checkEngineUpdates compares patch, minor,
  and major releases to the verified version (latestBeyondVerified /
  installedBeyondVerified). The System hub warns before an update and marks
  an installed version past that exact marker: core surfaces keep working
  (settings are schema-driven, unknown RPC frames are tolerated), but brand-new
  engine features may not appear in Cody until Cody updates. Bump the marker
  in the same commit as each compatibility audit. It is always a version of
  the package installSpec names, so for a two-package engine it is the
  ADAPTER's — which is why the notice names engineCli.adapterLabel rather than
  the engine's brand ("Claude Code ACP adapter v1.0.0", never "Claude Code
  v1.0.0" while Claude Code is on 2.1.x). The CLI half becoming newer still
  raises no notice: Cody speaks to the adapter, and an ACP engine's Cody
  surfaces are capability-gated almost entirely off.
- **The seam is CI-enforced** (`lib/architecture.test.mjs`): outside
  `lib/omp/` and `lib/harness/`, importing `lib/omp/*` fails the test unless
  the file is on the in-test allowlist with a written reason, stale allowlist
  entries fail too (the list only ratchets down), and the adapter/translator
  modules (`harness/omp|claude|codex|claude-stream|acp-session`) are
  private to the seam —
  everything else goes through `@/lib/harness` or its engine-neutral
  submodules. New engine-neutral code must NOT import `lib/omp` directly;
  route it through the harness (capabilities, adapter methods, or the engine
  dispatch pattern in `app/api/sessions/route.ts`).

**Notes for maintainers (omp 18.19 catch-up).**
- `task.workerThreads: 0` is omp's escape hatch if worker threads misbehave in a container (no Cody setting).
- Sidebar chats keep a bare cwd (`sidebarBareCwd`): `--no-context-files` does not exist on 18.8.3 and the sidebar has no tools/subagents.
- `luna.md`/`agents/` live under `$PI_CODING_AGENT_DIR/agents` on omp 18.18.8+ (`~/.omp/agent/agents` before); `lib/routing/request.ts` reads both roots.
- Checked and left alone: joined `--flag=value` forms (both engines accept the spaced form too, joined works everywhere); `omp-uploads-*` is swept by omp itself, `yt-*`/`omp-dump-anon-*` fall under the hourly disk janitor's temp sweep.

