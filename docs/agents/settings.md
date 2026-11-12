# Settings: the shell and the schema-driven panels

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Settings shell (`components/settings/`)
- Settings: schema-driven, not hand-listed

## Settings shell (`components/settings/`)

Settings is one dialog built from a single table, not ad hoc panels. Nine
hubs exist today: **Account**, **Preferences**, **Notifications**, **Code
hosts** (`you`); **Providers**, **Models**, **Behavior**, **Extensions** (the
active engine, named by its short name); **System** (the server).

- **`registry.ts`** is the source of truth: `SETTINGS_SECTIONS`, one entry per
  hub with its label, `group`, icon, `needsCapability` gate (ANY-of over a
  list — a hub whose sub-surfaces gate individually stays as long as one of
  them can render), `phoneOrder`, optional `subViews` (Models ›
  Catalog/Assignments; Extensions › MCP/Skills/Plugins) and the
  dynamically-imported panel component. A hub not in this table does not
  exist. `getVisibleSections`/`getVisibleSubViews` are the ONLY places
  capability gating happens for the rail — a panel never re-decides its own
  visibility.
- **`SettingsShell.tsx`** owns the open hub/segment, the search query, the
  highlight (a `data-search-id` to scroll to and outline once), the visited
  set (a hub stays MOUNTED once opened — a Providers sign-in SSE survives a
  look at System), the phone stack's levels and a `busy` register a login SSE
  or a dirty form holds so a navigation confirms before cutting work off.
  Desktop is a 230px rail (`SettingsSidebar.tsx`) over a pane; phone is a
  full-bleed `MobileStack.tsx` whose levels mirror browser history through
  `hooks/useSettingsHistory.ts`, so a back gesture, Escape and the ‹ button
  all pop exactly one level (`requestPop`). Both widths render the same hubs
  under the same ids (`settings-tab-<id>` / `settings-panel-<id>`).
- **The dialog-wide search** (`SettingsSearch.tsx` + `search-index.ts`) unions
  two kinds of entry: STATIC ones, each panel module's own `SEARCH_ENTRIES`
  export (a card, a toggle, a whole hub as a fallback result), and DYNAMIC
  ones, the active engine's schema rows from `hooks/useSchemaIndex.ts` — so
  typing a setting's name jumps to it even when it has no hand-built card.
  `components/settings-search-index.test.mjs` pins that a hidden hub or a
  gated card DROPS from the union entirely (never shown dimmed) and that a
  schema row a curated card already owns collapses into that one result
  instead of appearing twice.
- **The data layer.** `hooks/useSettingsData.ts` is the route cache every
  panel and every rail status line reads through (`useSettingsRoute` /
  `useSettingsRoutes`): one in-flight request serves every concurrent caller,
  an `{code:"unsupported"}` answer is cached as a VALUE so the hub hides and
  nothing retries a route the engine refused, and `invalidateSettingsRoutes`
  marks a prefix stale so mounted hooks re-fetch while the stale body keeps
  painting (no flash). `hooks/useConfigWriter.ts` is the one writer for omp's
  config.yml — per-family FIFO queues (`settings`/`schema`/`roles`/`plan`/
  `delete`) so a slow write in one family cannot starve another,
  `patchSettingsSchema` coalesces rapid writes (a slider) into one PUT every
  350 ms, and every settled write invalidates the same cached reads the
  panels above read through. See the `patchSection` trap note under Model
  orchestration below — it now lives here, not in `SettingsConfig.tsx`.
- **Shared nested-surface primitives**, so no hub reaches for a second
  `Dialog` (which would stack a second portal, backdrop and focus trap, and
  break Escape): `Drawer.tsx` (side panel on desktop, a pushed phone-stack
  level on narrow screens, or a centred dialog — the caller picks, the shell
  overrides on phone), `Directory.tsx` (the sectioned-row-list every hub's
  own list renders through — Providers' Connected/Discovered, the engine
  roster, MCP servers), and `DangerZone.tsx` (the confirmed-destructive-row
  block, always last in a hub).
- **Design decision — a new model is never silently hidden.** Three
  mechanisms work together so curation cannot make "new" invisible: (1) the
  "seen" ledger (`lib/model-catalog-seen.ts`, `cody-model-catalog-seen.json`)
  records what the catalog looked like last time it was SHOWN, not what is
  currently allowed, so a model excluded by curation still diffs as new;
  (2) omp's allow-list is written with whole-provider globs (`provider/**`,
  `lib/model-allow-list.ts`) rather than frozen id lists whenever a provider
  is left open, so a provider the user has not restricted keeps admitting
  models it did not have yet; (3) personal and instance hides
  (`lib/model-visibility.ts`) are a HIDE set, not an allowlist — the
  inversion means a model neither list names stays visible by default,
  instead of needing to be added to something before it can be seen. Losing
  any one of the three turns curation into a trap: without the ledger,
  "new" is a guess; without globs, curating a provider once freezes its
  roster forever; without the inversion, every model would need an explicit
  add.
- **Design decision — a new engine setting is badged once, per person, and
  fades with use.** An engine update adds settings and the Behavior hub
  renders whatever schema the engine declares, so nothing said a setting was
  new. `lib/settings-seen.ts` (`cody-settings-seen.json`, instance data dir,
  0600, atomic temp+rename) keeps, per engine, the key set Cody saw the LAST
  time it looked (the normalized schema, `harness.settings.readSchema()
  .schema.settings[].key`, terminal-only rows included) plus the keys
  introduced since, each with the engine version that brought it. A key in
  the schema that the last snapshot lacked is new; the snapshot then moves to
  the current set, new keys accumulate across upgrades while unfaded and drop
  out when the engine stops declaring them. The FIRST look at an engine only
  records its keys (a fresh install or a lost ledger never badges ~550
  settings); a missing or corrupt file reads the same way. The rules are pure,
  browser-safe functions in `lib/settings-new-keys.ts` (`FADE_AFTER_SEEN = 3`)
  and are unit-tested without a browser. Fading is per person (`user.id`; one
  fixed `__instance` key on an open instance): the chip fades after it was
  seen in 3 separate Settings opens, or the first time the key is changed
  through Settings, and one person's views never fade another's chip — so
  `/api/settings-seen` is NOT admin-only. "Seen" means the "New" chip was at
  least half on screen for ~600 ms in a visible page (`NewChip` →
  `observeSeen` in `lib/settings-new-reporter.ts`); a hub kept mounted under
  `display:none` never intersects. Counting is once per (person, key, OPEN):
  the dialog sends one random `openId` per Settings open
  (`hooks/useSettingsNewKeys.ts`) and the ledger stores the last counted
  `openId` beside each counter, so a retried POST, or the same key shown in
  two panels, cannot count twice. The answer is read once per open, so a chip
  is never pulled from under the cursor because the count reached 3; it fades
  at the next open. A CHANGE hides it at once: every settled write in
  `hooks/useConfigWriter.ts` announces its keys through
  `subscribeSettingsWritten`. Terminal-only rows never badge (the route
  leaves them out of `newKeys`; `isBadgedRow` in
  `components/settings/new-badges.ts` double-checks) though their keys are
  still recorded. Surfaces: the chip in the label row of `NativeSetting`
  (`newKey` prop) on the All-settings rows and on the curated, MCP and retry
  cards; a dot on the hub rows of the rail and the phone root list and on the
  Models › Assignments / Extensions sub-view tabs, where a key's home is
  resolved by `settingHome()` in `search-index.ts` (it reuses `cardHome()`:
  retry cards → Models › Assignments, MCP cards → Extensions › MCP, every
  other key → Behavior); `N new` counts on the All-settings tab buttons, group
  headers and phone contents; and a chip on dialog-wide search results
  (`SearchEntry.isNew`). Settings copy is English-only, so no `lib/i18n`
  entries.
- **Safety & approvals cards (Settings > Behavior).** The Recommended "Safety & approvals" group has seven cards: `tools.approvalMode`, `tools.approval.bash`, `tools.approval.extension`, `tools.restrictedFolders`, `bash.gitGuard`, `session.warnCost`, `session.maxCost`. `tools.approvalMode` also takes `always-ask-cached` ("Ask and remember", omp 18.12.3+). Cody offers it only when the installed schema lists it, but the typed config read/write (`lib/omp/settings-config.ts`) always accepts it. The typed read keeps EVERY `tools.approval.<tool>` entry holding allow/prompt/deny (e.g. `computer.control`, omp 18.14+), so a save never drops one; the Settings UI has no editor for them. `tools.restrictedFolders` and `bash.gitGuard` are schema-declared (18.13.1 / 18.8.7) so their cards hide on older engines like the other versioned cards (`INTRODUCED_IN` in `components/recommended-cards.test.mjs`). `session.warnCost` / `session.maxCost` have no UI metadata in omp, so they are `CURATED_ONLY` number cards (section `session`, `unset: true`, `minVersion: "18.13.0"`, hidden below that version by `curatedSupported`). omp accepts only POSITIVE USD amounts for them (0 is rejected), so "off" means the key is absent: the card starts empty and Reset removes it. Cody has no /forget-approvals button; the card hint says to type the slash command in the composer. The `ask.timeout` note in `SETTING_NOTES` describes 18.19 behaviour (submit the form's current values) and says older engines pick the recommended answer; the cfg:// approval part is left out because only the terminal UI registers a host for it.

  The `tools.approval.extension` card ("Extension Tool Requests") is Cody's own: omp reads no such key. Its one consumer is the auto-approve branch of `trackExtensionUiRequest` in `lib/rpc-manager.ts`, which, when the value is `allow`, answers a tool approval through `autoApprovalReply` (`lib/notifications/compose.ts`, built on the same `toolApprovalSelect` / `isToolApprovalTitle` the notification buttons use). omp 18.8.3 and 18.19.0 ask the approval as a `select` titled `Allow tool: <name>…`, so the reply is the option that allows THIS call once (`Approve`, or `Approve Once` beside grants), never a session-wide, remembered or `Deny` option; a list it cannot recognise is left for the person. The legacy `confirm` form still gets `confirmed: true`. Provider safety-check prompts (`Provider safety checks:` in the title) and restricted-folder prompts (`Reason: Restricted folder:`) are never auto-approved. Tests: `lib/rpc-manager.test.mjs` ("auto approve …").

## Settings: schema-driven, not hand-listed

Cody renders each engine's settings from the ENGINE's own declaration, so a
setting added upstream appears without a Cody change.

- **The route is engine-neutral; the derivation is per engine.**
  `HarnessAdapter.settings` (`EngineSettingsSurface` in `lib/harness/types.ts`)
  is one pair of methods — `readSchema()` → `{path, schema, values, reason?}`
  and `write(patch)` → `{written, rejected, values}` — implemented two ways:
  omp from its TypeScript schema (`lib/harness/omp.ts`, the one adapter the
  seam lets import `lib/omp`), and pi from the four-column settings
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
  is the whole property: pi has no schema, but ships every setting's type, default and description in
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
  Two loader rules for omp's newer source layout. (1) Import attributes: a
  `import x from "./f.md" with { type: "text" };` line is now recognised by the
  one `sourceImports` regexp (it used to be missed and could swallow the next
  import), so a prompt-text import is aliased to the stub like any other.
  (2) `SETTINGS_DATA_MODULES` (a `Record<string, true>`, today only
  `magic-keywords.ts`): a settings domain file's relative import of one of
  these in-package data tables is loaded for real (its own imports stubbed,
  `depth` 1) and handed to the domain as an override, because rows derived
  from the table at load time (`magicKeywords.<id>` per keyword, and the
  master switch's "standalone ultrathink, chillax, … keywords" text) came back
  empty under the stub. A table that fails to load falls back to the stub (no
  per-keyword rows), never to an error. Covered by the "derives the
  per-keyword magic switches" test in `lib/omp/settings-schema.test.mjs`; the
  18.19.0 key snapshot `lib/harness/fixtures/omp-schema-keys.json` now lists the
  five `magicKeywords.*` rows (440 keys).
- **Upstream keeps moving modules into sibling packages, and the stub destroys
  data.** 18.2.5 moved the whole terminal UI into `@oh-my-pi/pi-tui`, leaving
  `export { MODEL_ROLE_IDS } from "@oh-my-pi/pi-tui/…"` behind and enum values
  like `treeFilterMode`'s in that package. pi-tui is Bun-only (a real import
  dies on `Bun is not defined`), so two mechanisms read the data anyway, both
  in `package-source.ts`:
  - `loadOmpPackageSymbol(root, segments, symbol, isValid)` follows a
    re-export — load the file, and when the symbol is not what the caller
    expects, resolve the specifier it is re-exported from and read the
    declaring file. Without it `getOmpModelRoleIds` silently fell back to its
    frozen copy, which is the exact failure reading the source prevents.
  - A BARE import is bridged rather than stubbed: the dependency's own source
    is loaded (with all of ITS imports stubbed, one hop only) and handed to
    the parent through a generated CJS module (which reads the value off
    `globalThis`, never `require(__filename)`: in the built server that is a
    webpack chunk, and requiring it back blanked the schema in production
    while every jiti-run test passed). This is what keeps
    `treeFilterMode` in the panel at all — under the plain stub its enum had
    no values and the row dropped out. Relative imports stay stubbed on
    purpose: their behaviour is unchanged from before the split, and
    stub-loading dozens of in-package modules is a far larger blast radius.
  - Both resolve a specifier through the dependency's own `exports` map
    (`resolveSourceSpecifier`), because these packages publish `src/*.ts`
    under it. Every failure returns null; every caller has a fallback.
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
  schema, so an upstream rename surfaces as a test failure, not a vanished
  chip — with one necessary refinement: a rule that names a setting the
  installed engine does not declare is ambiguous (renamed away, or targeting a
  NEWER engine), so the unmatched-rule check only judges an engine at least as
  new as `HarnessAdapter.verifiedVersion`.
  Terminal-only list, 18.8.6-18.19.0 additions (checked against the 18.19.0
  source: none is read under `src/modes/rpc` or `src/modes/acp`):
  `update.auto`, `session.worktreeScope`, `composer.predictions`,
  `composer.predictionAlternatives`, `terminal.programStatus`,
  `worktree.onStart`, `worktree.onExit`, `extensionHandlers.modeControl`,
  `extensionRenderers.assistantText`, `extensionRenderers.transcriptPresenters`,
  `btw.inject`, `async.printWake`, `title.refreshAfterPrompts`. `steeringMode`,
  `followUpMode` and `interruptMode` are NOT terminal-only any more: the engine
  core reads them for rpc-ui sessions too and Cody drives their live values
  through `set_steering_mode` / `set_follow_up_mode` / `set_interrupt_mode`.
  `SETTING_NOTES` gained Cody notes for `out.enabled`,
  `providers.openaiLiveSteering` (18.14 default flipped to Off: a message sent
  during a GPT reply waits for the next tool call), `task.autoParallel` (one
  extra request to the `judge` role per new prompt), `task.perCallModel`,
  `async.widgets` (background-job widgets cost extra small-model calls that
  Cody never shows; the `widget` role resolves like `smol`), and a refreshed
  memory-store note (omp 18.9 made the per-memory scoring much cheaper but it is
  still per stored memory). `settings-surface.test.mjs` keeps every rule and note
  matching the installed schema.

  `lib/omp/settings-schema.ts` `CODY_DEFAULT_OVERRIDES` (`Record<string,
  boolean | number | string>`): the value a Cody chat has while nothing
  configures it, for settings whose engine default follows the host — `out.enabled`
  (off under rpc-ui, on in the terminal) and `display.shellVisualization` (Cody
  launches with it off, `lib/omp/cody-launch-defaults.yml`). The panel shows that
  value instead of the declared default so a switch never reads On while the
  engine keeps the feature off.

  `lib/omp/settings-conditions.ts`: `composerPredictionsEnabled` (a
  `SETTING_CONDITIONS` rule on `composer.predictions`) and
  `GLOBAL_LAYER_CONDITIONS` (`Record<string, true>`: `contextFilesExtraNotProject`,
  `restrictedFoldersNotProject`, `perCallModelAllowNotProject`). The engine hides
  those three list editors while a project file supplied the list; Cody reads and
  writes the global layer only, so they are always satisfied (no "only takes
  effect when…" hint). `hooks/useSchemaIndex.ts` `describeCondition` knows the
  set.
  `task.autoParallel` (omp 18.19.0) and `task.perCallModel` (18.14.2) carry cost /
  behaviour notes in `SETTING_NOTES`; the settings themselves, and `task.steps`,
  `task.structured`, `task.agentSoftRequestBudget`, appear in the panel through the
  engine's own schema with its own descriptions.
- **This whole pipeline is tested against a REAL omp package, and for a long
  time it was not.** Six test files (`settings-schema`, `settings-values`,
  `settings-surface`, `model-roles`, `recommended-roundtrip`,
  `recommended-cards`) looked for `/tmp/ompkg/package/bin/omp`, which nothing
  in this repo creates, so every one of them SKIPPED — locally and in CI — and
  18.2.5's package split went undetected until it was read by hand.
  `lib/omp/omp-test-package.mjs` now resolves whatever omp is actually
  available (`CODY_OMP_BIN`, that extraction, the tools prefix, PATH), so they
  run; point `CODY_OMP_BIN` at an unpacked newer engine to audit it before
  updating. Two consequences for what these tests may assert: the curated-card
  split (schema-declared vs curated-only) and the settings-tab ORDER are
  DERIVED from whichever engine is installed — 18.2.5 moved two keys and
  reordered every tab — so they are asserted as invariants ("every card can
  render", "these tabs exist"), never as counts or positions.
- `components/settings/engine/SchemaSettingsList.tsx` — the Behavior hub's
  "All settings" list: the complete schema, chip-grouped, secrets masked.
  Indexed for search by `hooks/useSchemaIndex.ts`, the one component-facing
  module that reads `lib/omp/settings-conditions`, so a Recommended card and
  its schema row can never disagree about visibility.
- `lib/omp/settings-config.ts` stays: it backs the server-side reset paths
  (`/api/omp-settings`'s section deletes, `/api/model-plan`) that
  `RetryFallbackPanel`/`ModelPlanPanel` and the config writer's "Reset to
  defaults" calls hit — see "Model orchestration" below for its
  `RESETTABLE_SECTIONS`/`RESETTABLE_PATHS`. It writes the same config.yml the
  schema route does; `useConfigWriteSeq` is what tells a panel holding its
  own copy of the file (the schema list) to reload once a reset lands,
  without bouncing on its own save.
- `jiti` must remain in `serverExternalPackages` — bundling it breaks its
  runtime file resolution.
- **Trap — `ui` fields can be getters that throw.** In omp 18.3 some
  descriptions are computed (`get description() { … formatKeyHint(…) }`) from
  an import the source loader stubs, so reading one throws. Uncaught, that one
  throw made `getOmpSettingsSchema()` return null and blanked the whole
  settings panel (and every Cody note). `readText` in
  `lib/omp/settings-schema.ts` reads each text field defensively and drops only
  the field that failed.
- Behavior sits with the other engine-scoped hubs in the registry, named from
  the active harness (`HarnessAdapter.shortName`, served by the schema
  route), so switching `CODY_HARNESS` renames it rather than requiring a UI
  edit — see "Settings shell" below for where it sits among the other hubs.
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

- **Recommended cards for newer engine keys.** `defaultThinkingLevel` is now a
  card (it left `CURATED_ONLY`); `textVerbosity` carries the "omp 18.17+ defaults
  to Low" hint; `advisor.continueSeverity` (18.12.1) is an Advisor card; the
  retry cards gained `retry.fallbackOn` (18.9) and `retry.rateLimitWalksChain`
  (18.13.3), rendered by `RetrySchemaCard` in
  `components/settings/RetryFallbackPanel.tsx` and shown only when the installed
  schema declares the key, so 18.8.3 shows neither. `advisor.syncBacklog` also
  accepts `strict` (`lib/omp/settings-config.ts`, `BACKLOGS`;
  `hooks/useConfigWriter.ts`).
- **List settings accept pasted lists.** `ArrayControl` in
  `components/settings/engine/SchemaSettingsList.tsx` takes a pasted JSON array
  (or newline text) through `components/settings/engine/list-draft.ts` (pure,
  tested in `list-draft.test.mjs`) instead of making the user add each entry.
  `lib/omp/settings-values.ts` validates `contextFiles.extra` as bare file names
  (no path separators), which is what the engine accepts (18.14.2).
- **Web-search order.** The setup wizard writes the full engine order
  (`WEB_SEARCH_FULL_ORDER` in `components/setup-wizard-steps.tsx`, now also
  `deepseek`, `keenable`, `sofya`). omp migrates `providers.webSearchOrder`
  into its `web` model role and fallback chain on load (18.8.3 too; ids the
  engine does not know are dropped), so one list serves both; `hackernews` is
  left out on purpose (omp routes `site:news.ycombinator.com` there itself).

