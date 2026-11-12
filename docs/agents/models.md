# Models: orchestration, presets, curation, auth config, brand marks

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Model orchestration: roles, plans, chains, resets
- Model presets: per-conversation role overlays, researched on the web (`lib/model-presets/`)
- Auth and model config
- Model curation (`enabledModels`) — omp filters, Cody does not
- Brand marks (`components/ProviderIcon.tsx`, `lib/provider-brand.ts`)

### Model orchestration: roles, plans, chains, resets
- **OMP defaults and role scope.** With no `modelRoles` in config.yml, OMP owns role resolution. Its sixteen built-in roles (omp 18.12.3+; fifteen on older engines such as 18.8.3; read from the engine, `FALLBACK_MODEL_ROLE_IDS` mirrors the newest set) are `default`, `smol`, `slow`, `vision`, `plan`, `commit`, `tiny`, `memory`, `task`, `advisor`, `widget` (job-widget captions; resolves like `smol` until assigned), `image`, `web`, `speech`, `dictation`, and `judge`; no removed or custom role is implicit. Preserve saved custom-role mappings. “Reset to OMP defaults” deletes only Cody's overrides: `DELETE /api/model-roles` drops `modelRoles`, `DELETE /api/omp-settings` `{sections:["retry"]}` removes the retry section, and `DELETE /api/model-plan` removes the plan's roles, fallback chains, and usage-aware flag while preserving unrelated retry tuning. Deletion allow-lists live in `lib/omp/settings-config.ts` (`RESETTABLE_SECTIONS`/`RESETTABLE_PATHS`).
- **Roles come from the engine, never a frozen list.** omp's role vocabulary changes between releases (16 roles from omp 18.12.3: `widget`, which writes job widgets and captions and resolves like `smol` until assigned). Anything that lists roles to the user, proposes them or writes them to `modelRoles` must read the engine's live list (`getOmpModelRoleIds()` in lib/omp/model-roles.ts) and filter Cody's own vocabulary through `planRoleNames()` in lib/model-plan/derive.ts, so `widget` is never offered or written on an engine that lacks it. Label-only maps (`modelPlan.role.*`, `agentSession.job.*`, `ROLE_LABEL_KEYS`, `DESCRIBED_ROLES`) may always know every role. The derive functions (`heuristicPlan`, `constrainPlanDraft`, `deriveChains`, `validatePlan`) and `planWithModel` take an optional `roleNames` list; the default is every role Cody knows, so production callers (app/api/model-plan/route.ts) must pass the engine-filtered list.
- **Non-chat models in the Settings role picker.** `get_available_models` returns chat models only. LM Studio decision models (omp's `judge` role, provider id `lm-studio`) come from Cody's own local scan: `lib/local-ai.ts` reads LM Studio's native `/api/v1/models` and returns them as `decisionModels`, kept out of `models`. Only the `judge` row of Settings > Models > Assignments offers them.
- **Live config takes a restart.** An OMP child reads config.yml at spawn (only subagent preflight reloads it), so plan apply and every reset call `restartIdleRpcSessions()` (rpc-manager): idle children reconnect on demand with the new config; running turns complete on their old config. Responses carry `{restarted, active}` for the UI to announce the result.
- **One effective roster.** `lib/model-plan/roster.ts` builds the planner allow-list directly from OMP's effective `get_available_models` response. That response already applies `enabledModels`; never add a second Cody filter. The planner's `bestAvailableModel` uses the same provider tiering and lets the provider assigned to `default` lead its tier.
- **Native hints are optional.** The planner reads omp's native smol/slow/image/web/speech/dictation/judge suitability ranks through `readNativeRolePriorities(packageRoot)` (`lib/model-plan/roster.ts`): first the catalog rules file `src/compat/rules.json` -> `behavior.roleDefaults` (omp 18.8.4+/18.14, read as JSON, not through Bun), then the legacy `<root>/src/priority.json` (older engines). A missing, malformed or unavailable source leaves planning functional (no ranks). Pinned by `lib/model-plan/roster.test.mjs`. Keep task balanced; native-smol suitability remains a valid light-workload signal.
- **Provider tiering is semantic.** Rank direct Claude/Codex providers first, then other direct APIs, then gateways (including OpenRouter), then genuinely local endpoints. A zero price is common for remote subscriptions or gateways and is never locality evidence; only the endpoint address can establish localness.
- **Fallback chains keep source intent.** For every role assignment that resolves to the same source, derive one invariant source tier: native suitability, then meaningful provider price, then role-only intent when price is unknown. Same-provider suitable siblings remain eligible so distinct quota buckets can absorb a fallback. Emit selectors in OMP precedence order: exact model first, provider wildcard second, role last.
- **Fallback switches announce themselves**: OMP's `retry_fallback_applied` ({from, to, role}) and `retry_fallback_succeeded` ({model, role}) frames surface as toasts in `useAgentSession` (i18n `agentSession.fallback*`).
- **Trap — `patchSettingsSection` in `hooks/useConfigWriter.ts`** (formerly SettingsConfig.tsx's `patchSection`) must spread the SECTION (`base?.[key]`), never the whole settings object; the whole-object spread filled config.yml sections with junk top-level keys after the first save. `patchSettingsTop` is the one deliberate exception — top-level keys and arrays like `enabledModels` genuinely need the whole object spread.
- **OMP 17.4 compaction**: `compaction.strategy`/`remoteEnabled` no longer exist upstream — `compaction.methodOrder` (ordered preference list) replaced them. `settings-config.ts` reads legacy keys through OMP's own migration mapping and deletes them when writing `methodOrder`.
- **Advisor launches.** OMP RPC defaults advisor off even when `advisor.enabled` is saved. `buildEngineRpcLaunch` reads that preference for each new, resumed, and relaunched main chat and passes `--advisor` when enabled; an explicit launch override wins. Sidebar chats and engines without advisor support never receive it. Saving the setting does not update an already-running child.
- **`advisor.subagents` is Cody's logical key, not omp's.** omp has no such schema key; its settings loader migrates it to `task.agentAdvisor.task` (`"on"`/`"off"`/model pattern; an early build persisted booleans). `settings-config.ts` keeps the `advisor.subagents` boolean on the wire (card key, `NativeSettings`, the reset path) but reads/writes/resets `task.agentAdvisor.task`: a legacy un-migrated `advisor.subagents` is read as a fallback and removed on the next write, never written; turning review on keeps a model pattern the user chose; reset drops the real key and tidies empty `task`/`agentAdvisor` maps. `memory.backend` also accepts 18.4's `sharpshooter`.
- Retry/fallback UI lives in `components/settings/RetryFallbackPanel.tsx` (see its module comment for the never-persist-an-empty-chain rule).

### Model presets: per-conversation role overlays, researched on the web (`lib/model-presets/`)

A preset (built-ins Max / High / Medium / Low, plus user-created ones) is a
complete answer to "which model, at which reasoning level, plays each omp
role", with the fallback chains that go with it. Presets live in Cody's
instance data dir (`cody-model-presets.json`), never in `config.yml`.

- **Per conversation, never global.** A chat is bound to one preset
  (`cody-session-presets.json`); the binding is materialized as an omp config
  layer (`cody-model-presets/<hash>.yml`) appended to `PI_CONFIG_FILES` at
  spawn (`launchWithSessionOverlays` in rpc-manager: preset overlay first, then
  the Claude credits overlay, Local-only routing last, so Local-only still wins
  and never reaches a paid API). Switching presets in
  one chat never touches another chat or the user's own `config.yml`. The
  binding follows omp's temp-id -> real-id rename, is copied on fork and is
  forgotten on delete; a deleted preset reads as base settings.
- **Only in Smart mode, and it never fights the user.** The composer offers
  presets as rows under Smart (`hooks/useSessionPreset.ts`,
  `hooks/session-preset-state.ts`). A preset is applied ONLY by a direct pick:
  nothing re-applies one on load, reconnect or session switch. A manual model
  or reasoning pick leaves Smart (and therefore the preset) exactly as a
  manual pick always has. A pick during a turn answers 409 `session_busy` and
  is resent once the run ends.
- **Editing a preset moves the chats bound to it** without killing a turn:
  idle chats restart now, a mid-turn chat at `agent_end`
  (`restartSessionForRoutingWhenIdle`, `routingRestartPending`).
- **Research is a sandboxed omp print-mode child**
  (`lib/model-presets/research.ts`): tools restricted to `web_search`, a
  fresh temp cwd (no project `.mcp.json` or context files) and a fresh agent
  dir with an EMPTY `mcp.json` and only `agent.db`/`models.yml`/`config.yml`
  symlinked (`lib/omp/isolated-agent-dir.ts`'s shared helper, given a
  research-specific file list with no `blobs`; a FRESH per-run directory
  here, not the reusable one Distill and the session namer share, because
  this child spends its turn on untrusted web content).
  `--tools` alone is not enough: user MCP servers bypass it, and
  an untrusted web page must never reach a tool that can touch files or
  commands. Proposals are validated against the live roster (selectors, each
  model's own `thinkingEfforts`, vision), cite their sources, and are only
  written to a preset when the user applies them. One run at a time; the
  snapshot survives a restart (`cody-model-research.json`).
- **Trap: the server's import graph cannot use `@/` aliases.**
  `bin/cody-server.js` loads `lib/` through a bare `createJiti`, so one alias
  anywhere under `lib/rpc-manager.ts` stops the server booting, while every
  test (which loads with `tsconfigPaths`) still passes.
  `lib/server-import-graph.test.mjs` walks that graph from the server's own
  entry list.

- **Preset selectors must be exact on omp 18.14+.** A preset's role and chain entries are `provider/id[:level]` selectors that omp resolves itself. From omp 18.14.0 a provider-qualified selector must name an exact model id; omp no longer picks a close sibling. `PUT /api/model-presets/[id]` therefore checks every role value and chain entry against the live roster (`lib/model-presets/roster-check.ts`, pure rules in `lib/model-presets/selector.ts`: `selectorProblem`) and refuses an unresolvable one with a `unknown_model` 400 that names the closest ids. The check only runs on engines at or above `EXACT_SELECTOR_SINCE` (18.14.0), skips role refs (`@smol`), wildcards (`openai/*`), providers the roster does not list, and a roster that cannot be read. Chain keys are never checked.

### Auth and model config
- Auth flows go through RPC commands (`get_login_providers`, `login`) against the omp child process; credentials live in omp's `agent.db` (SQLite). Cody reads and removes them only through the Bun helper over omp's own AuthStorage (`bin/cody-omp-credentials.mjs`) — plus one read-only SELECT of ACTIVE `openrouter` api keys in `lib/openrouter/key.ts` and the helper's guarded tombstone purge (see "Several accounts can serve one provider").
- `models.yml` in the omp agent directory (`~/.omp/agent/models.yml`, `.yaml` fallback) is read and written from the Providers hub's detail drawer, in a custom endpoint's "Advanced" form (`components/ModelsConfig.tsx`'s editors, rendered by `settings/providers/ProviderDetail.tsx`) — not the Models hub, which only reads the resulting catalog.
  - Model `kind` (chat/tiny/image/tts/stt/judge/embedding/rerank/video, never `search`), runner `api`s and the `compat` switches follow omp 18.19 as seen by the INSTALLED engine: `lib/model-kinds.ts` carries the release that first knew each newer key (`RUNNER_API_SINCE`, `MODELS_YML_SINCE`, `MODEL_TOKENIZERS`), and the editor (`components/ModelsConfig.tsx`, via `hooks/useEngineVersion`) offers a value only from that release on, plus whenever the file already carries it (so it can be seen and removed). Old engines ignore an unknown KEY but the api list and `tokenizer` are closed enums where one future value makes omp drop the WHOLE file, which is why those are gated. Gated fields: judge runner apis `openai-decisions`/`workers-ai-systemone` (18.9.2) and `liquid-systemone` (18.19.0); per-model `imageCountBudget` (18.11.3, positive integer, also validated on `modelOverrides`); `tokenizer` `o200k` (18.10.3) / `cl100k` (18.16.0); `compat.requiresThinkingPresence` (anthropic-messages, 18.13.0); `compat.supportsThinkingBindingControls` (bedrock-converse-stream, 18.9.1); `compat.statefulResponses` on anthropic-messages = message threads (18.17.0); provider `discovery.advertisedReasoning` (18.13.2, only on `openai-models-list`/`lm-studio`/`proxy` discovery; any other type is refused at save because omp 18.13.2+ drops the file). `lib/model-kinds.test.mjs` asks the installed engine's own models.yml schema (`lib/omp/fixtures/models-yml-schema-probe.mjs`) which apis/tokenizers it accepts, so a drifting table turns red on whichever engine runs the test. The kind↔api rule and omp's exact message live in `lib/model-kinds.ts`, shared by the editor (inline error, Save disabled) and `validateModelsConfig`. Unset kind / default statefulResponses persist as the key ABSENT (`withCompatFlag` drops an emptied `compat`). There is no `modelOverrides` editor UI; overrides are only validated and preserved.
- API-key status endpoints must never return the raw key.

### Model curation (`enabledModels`) — omp filters, Cody does not
- OMP owns the allow-list: `get_available_models` already applies `enabledModels` (OMP `session/model-controls.ts`), whose entries are **glob patterns** matched against `provider/modelId` and bare ids. The API response is the one effective roster for the Composer picker, role controls, fallback chains, and planner. Cody MUST NOT apply a second enabled-model filter or dialect.
- **Trap**: because omp filters, a restricted read cannot see what it excluded,
  so curation would be a dead end — no way to find the other 464 OpenRouter
  models to re-add one. `/api/models?catalog=full` therefore runs a throwaway
  utility process with `PI_CONFIG_FILES` pointing at an overlay containing
  `enabledModels: []` (omp's own `--config` layering). The user's `config.yml`
  is never written. `--models` does NOT work for this: it only scopes Ctrl+P
  cycling, while `getAvailableModels()` reads the setting directly.
- Only the curation panel requests the full catalog, and only on mount. The
  main UI never carries it.
- UI shape (`components/settings/models/`): Models › Catalog shows a curation
  strip, one summary row per curated provider (`openrouter — None of 466
  enabled`, from `summarizeProviderCuration`), each opening
  `ModelCurationDialog.tsx` — search, bulk enable/disable of the current
  matches, a rendered-row cap (`CURATION_VISIBLE_LIMIT`, so DOM size is
  constant), and a single PUT on confirm. Turning the restriction ON seeds
  only in-use models
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

