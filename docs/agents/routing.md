# Usage-aware routing and Claude API credits

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Usage-aware routing: one registry, blackouts, role binding (`lib/routing/`)
- Claude API credits as the backup behind the Claude plans

### Usage-aware routing: one registry, blackouts, role binding (`lib/routing/`)

Quota telemetry becomes a routing decision in exactly one place, and every
surface reads that answer. The order is the design:
**observe → remember → bind roles → bind agents**, run once per usage poll
from `app/api/usage/route.ts` (`lib/routing/request.ts` gathers only what is
already cheap; `reconcileRouting` is omp-gated and never throws).

**Observation is unconditional; WRITING is opt-in and off by default**
(`autoBindEnabled()`, `CODY_ROUTE_AUTOBIND=1` or the persisted `autoBind`
flag). Recording blackouts and folding them into the snapshot is Cody's own
state and only makes the ring honest. Re-pointing a role edits the user's
configuration, and that must never happen merely because they installed a
new version — an instance that updates and finds its roles rewritten on the
first usage poll is the exact failure this guard prevents. Pinned by
`lib/routing/routing.test.mjs` ("observation never writes to the engine's
config").

- **`lib/usage/availability.ts` is the single verdict.** Built on
  `select.ts`'s primitives, never a second matching dialect. Two rules are
  load-bearing: **unknown is usable** (a provider reporting no quota — an
  API key, a local endpoint — must never be routed around; only positive
  evidence blocks a model), and **exhaustion is per SERVING account** (a
  spent idle sibling says nothing). An exhausted untiered window takes its
  own tiers down with it: 5% left on the Fable bucket is unreachable when
  the account-wide weekly window is spent.
- **A block is a harder fact than a percentage, and it lives in a different
  store.** omp writes `auth_credential_blocks` when a provider answers with
  a limit and then refuses to send on that credential; `omp usage --json`
  knows nothing about it. Measured on a live install: an Anthropic account
  reporting **4% used** was blocked for five hours, so the ring showed
  headroom while every turn fell back — and the Token Plan key was blocked
  for six days while reporting nothing at all. `applyCredentialBlocks`
  (lib/usage/credential-order.ts) folds blocks in as exhausted untiered
  windows, synthesizing an account for a blocked credential whose provider
  reports no usage (an API key) — otherwise it stays invisible and keeps
  being chosen. Block windows carry `source: "block"`: set from ONE rejected
  request, never measured, and labelled that way in the UI. `POST
  /api/usage/unblock` {provider, accountId} is the Providers panel's
  "Retry now" (admin-only, `bin/cody-omp-unblock.mjs` via
  lib/harness/omp-unblock.ts). It lifts only a block (a measured exhaustion
  is refused), never loads a credential (`AuthStorage.create` without
  `reload()`), clears the matching blackout, re-reconciles and restarts idle
  sessions, because a running omp keeps its own in-memory copy of the block
  (`#credentialBackoff`) until it restarts. Safe: a provider still limiting
  re-writes the block on the next request.
- **Usage reading (`lib/usage`): a failed or partial read never erases a good one.** `omp usage --json` is a photograph, and the camera sometimes fails (timeout, a provider endpoint rate-limiting one login, an engine restart). The rules, all in pure modules so the cache, the browser hook and the tests share them:
  - **`lib/usage/last-good.ts`.** A FAILED read (timeout, crash, no usable JSON) keeps serving the last good reading for up to 6 hours (`LAST_GOOD_MAX_AGE_MS`), flagged `stale: true` with `refreshFailed {at, reason}`; older than that the plain failure shows ("unavailable"). A SUCCESSFUL read that does not mention an account the previous good one had carries that account forward for up to 30 minutes (`CARRY_FORWARD_MAX_AGE_MS`), its windows labelled by `UsageAccount.windowsStaleSince` (the time of the reading they come from, never refreshed by later reads, so the account ages out). Carried windows whose reset time has passed are dropped, and an account the newest read does name (measured, signed out or disabled) is always the newest word.
  - **`lib/usage/cache.ts`** owns `lastGood`; it is dropped with the cache (engine switch, login, logout, tests), and a read that was in flight when the cache was reset cannot become the new world's last good (generation guard). A re-served last-good reading backs off like a failure (`USAGE_FAILURE_BACKOFF_MS`), so no caller can turn a failing probe into a spawn loop. Credential blocks come from `listOmpCredentialsKeepingLast` (the last good store read, 15 minutes at most) so a block that vanished for one read cannot flip a refused account back to usable.
  - **`lib/usage/client-merge.ts` (`mergeUsageRead`, used by `hooks/useUsage.ts`).** The browser keeps a good reading on screen when a poll answers `available: false` (a restarting server, a first read that failed) and marks it stale instead; a newer good reading always replaces it, and a reading older than six hours is not kept.
  - **Readings carry their own age (`lib/usage/reading-age.ts`).** omp keeps re-serving the last report it saved for a login whose live fetch fails (Claude's usage endpoint answers bursts with HTTP 429, and a damaged `agent.db` cannot save the fresh one), so the moment Cody read omp says nothing about how old the numbers are. Each report's own `fetchedAt` becomes `UsageAccount.measuredAt` (`buildAccount`), and every bound counts from it: `LAST_GOOD_MAX_AGE_MS` from the newest measurement in the reading, `CARRY_FORWARD_MAX_AGE_MS` (= `READING_OUTDATED_AFTER_MS`, 30 minutes) from the account's own. `withOutdatedReadings(snapshot, now)` is applied by `cache.ts` before it serves and by `mergeUsageRead` on every browser poll, including a failed one: an account measured longer ago than that is marked `outdated: true` and loses the windows whose reset has passed, so it may keep no window at all, which every reader takes as "no current reading" (never 0%, never unmetered; `availability.ts` still treats it as usable and never routes around it). A login's numbers never go back in time (`neverOlder` in `carryForwardMissingAccounts`): one login can come back live in one read and as its days-old saved report in the next, and the newer measurement stays. An account with no recorded time (a report without `fetchedAt`) makes no claim and is never called out of date. Fixtures of real captures from both engines: `lib/usage/fixtures/omp-18.8.3-usage-stale-primary.json`, `omp-18.19.0-usage-primary-fresh.json`; tests: `lib/usage/reading-age.test.mjs`, `robustness.test.mjs`.
  - **Parser tolerance (`lib/usage/omp-usage.ts`).** A notice printed before or after the JSON (an update line, a deprecation) no longer makes the output "malformed" (falls back to the `{`...`}` span); a non-zero exit that still printed a readable payload (some builds exit 1 when one provider's fetch failed) is a reading, not a failure. `accountsWithoutUsage` (both 18.8.3 and 18.19.0 print the key; 18.19.0 also lists capless LiteLLM keys and a per-entry `policy`) is kept as `UsageSnapshot.unreportedAccounts`, never as account rows (nothing was measured). When NOTHING is measurable but omp listed signed-in logins it could not read, the read is unavailable with "omp could not read the quota of N signed-in accounts" rather than "no quota windows". A saved reset that is spent (`remainingCount` 0 or status `redeemed`) no longer pulls the "expires soon" date earlier.
  - **New 18.19 fields, all optional (18.8.3 prints none of them):** `reports[].policy` becomes `UsageAccount.policy` (priority, reservePct, reserveSource, reclaimAbovePct, state, remainingPct); `metadata.inactiveSharedGates` becomes `UsageAccount.inactiveGates` (`["5h"]`: no 5-hour session is open, so the window is absent, not dropped); `limits[].amount` of a money meter (usd, credits) becomes `UsageWindow.amount {unit, used, limit}`; a LiteLLM budget is labelled "key budget" / "user budget"; a Codex `credits` tier is a billing meter, labelled "credit spend cap".
- **`lib/usage/quota-tiers.ts` is the one place that says which windows constrain which model** (header comment is the rule list): Claude tiered windows (Fable, Mythos) bind only that family; a Codex Spark model spends only the Spark meter and every other model only the 5-hour and weekly plan windows; a credit-billed Codex seat has no plan windows, so `openai-codex:spend-cap` stands in for them (beside plan windows the cap only bounds credit overage and gates nothing); Cursor's weekly pool binds only Cursor's own models (Auto, Composer, Grok) and the prepaid pool only every other model (a plan reporting one combined window binds all); Factory Droid's extra-balance meter is a top-up, not a gate; plan-label tiers (Copilot `individual`, Devin) name no model and constrain none. `select.ts` and `availability.ts` call it; do not re-implement the rules elsewhere.
- **`AvailabilityState` has a fifth value, `unavailable`.** When every account a provider has is signed out or disabled, nothing can serve the model: `unavailable` with `unusable: "signed_out" | "disabled"`, never `unknown` (which every caller reads as "usable") and never `exhausted` (which means "wait for the reset"). `cannotServe()` is what a caller that asks "may I send here?" reads; `pickAvailableRoute` skips an unavailable candidate like a spent one and reports `chosenState: "unavailable"` only when every skip was a login problem. Routing consumers outside `lib/usage` (blackouts, chain binding, credits cover) intentionally still act only on `exhausted`: a signed-out provider is not a blackout that ends at a reset, omp walks the chain itself (see "Signed-out providers"), and the UI says "sign in".
- **Credential blocks are scoped (omp 18.19).** omp stores each rate-limit block with a `blockScope` (Claude `''`/`tier:fable`/`tier:mythos`; Codex `chat`/`spark`/`shared`; Cursor `pool:auto`/`pool:api`; others account-wide). `bin/cody-omp-credentials.mjs` returns every credential row with `blocks: [{scope, until(epoch ms)}]` (unexpired only, one per scope, scope `''` when the engine has none) beside the merged `blockedUntil`; `OmpCredentialRow.blocks` is optional, and a row without it reads as one `''` block. `applyCredentialBlocks` (lib/usage/credential-order.ts) makes ONE window per (credential, scope): id `<provider>:blocked:<credentialId>` for `''` (unchanged, so remembered blackouts match) and `<provider>:blocked:<credentialId>:<scope>` otherwise, with `source: "block"`, `blockScope`, and `tier` from `tierOfBlockScope`. Never test "account-wide" with `!window.tier`; call `isAccountWideWindow` (lib/usage/quota-tiers.ts) — blackouts, credits-cover and chain-binding do. `listOmpCredentialsKeepingLast` (lib/harness/omp-credentials.ts) returns the last successful list (marked `stale`, up to 15 minutes) when a later helper call fails, so a block already seen is not lost to a transient failure. Real-engine test: `lib/harness/omp-credentials-blocks.test.mjs` (run with `CODY_OMP_BIN` for each engine).

- **Usage is about accounts, not the active engine.** `/api/usage` answers
  whenever the omp binary is installed, whichever engine is active, and the
  composer ring and picker badges ("Limit reached · resets …") render for
  every engine where the engine's provider maps unambiguously (Claude Code →
  anthropic, Codex → openai-codex). Blackouts are observed for every engine;
  config writes and restarts stay omp-only.
- **Blackouts are remembered, with the provider's own reset as the expiry**
  (`lib/routing/route-memory.ts`, `cody-route-memory.json`, 0600, atomic).
  A quiet or failed telemetry read reports nothing, and "nothing" reads as
  usable — which is how a session dials an account that has been spent for
  days, every turn. A `credits` blackout (prepaid: OpenRouter) has **no
  expiry**: money does not return on a timer, so it clears only when a read
  sees a positive balance, and a FAILED balance read is never a zero one.
  **A blackout must not outlive its provider.** `applyBlackouts` fabricates
  an account for a blacked-out provider the live report no longer has, so a
  remembered blackout keeps a provider in Usage after it is gone. Three
  rules: a read that finds NO key at all (`no_key`) covers the `credits`
  blackout and lifts it (a removed key can never give a positive balance;
  any other failed read still covers nothing); removing a provider's last
  credential or key forgets its blackouts outright
  (`clearProviderBlackouts`, called through `settleProviderChange`); and a
  provider omp's config DISABLES (`disabledProviders`) leaves the one
  snapshot routing and Usage read (`withoutProviders` in `reconcileRouting`,
  fed by `reconcileRoutingForRequest`), derives no blackout, and has the
  ones already remembered forgotten (a newly disabled one through
  `settleProviderChange`, a long-disabled one on the next usage read — the
  owner's OpenRouter was already disabled when this was found); a live
  read re-derives the truth when it is enabled again. A
  credential that is disabled or removed never yields a "blocked account"
  (`applyCredentialBlocks` skips rows with a `disabledCause`).
- **Roles follow the quota** (`lib/routing/role-binding.ts`). When a role's
  configured model is blacked out, Cody re-points `modelRoles.<role>` at the
  first entry of the USER's own `retry.fallbackChains` that is not — never
  re-sorted by utilization, because a chain is a preference — and stores
  their assignment as `baseline` to restore verbatim. The user always wins:
  an assignment that no longer matches what Cody wrote is adopted as the new
  baseline. Nothing usable in the chain means the role is left exactly as
  configured; inventing a destination the user never listed is not Cody's
  call. A Claude plan model that saved API credits cover is left alone: the
  credits are its next hop ("Claude API credits as the backup" below).
- **Chains skip what cannot answer** (`lib/routing/chain-binding.ts`). omp's
  REACTIVE fallback (`#tryRetryModelFallback`) only checks that a candidate
  has a key, so a provider out of credits or blocked on every account was
  still dialled. Cody writes each `retry.fallbackChains.<key>` without
  entries whose EVERY account is exhausted (`allAccountsExhausted`, a
  provider-wide credits blackout, or blocks), stores the user's chain as
  baseline in route memory BEFORE rewriting, restores entries the moment
  they are usable, and adopts a chain the user edited as the new baseline.
  One spent account beside a healthy sibling drops nothing: omp rotates
  accounts itself. All entries spent → the full chain is kept. Role binding
  walks the baselines. Any chain or role change restarts idle sessions.
  Also: a failed usage read never lifts a blackout (only a fresh read that
  sees the account does), and a cached window past its own reset counts as
  reset. A Claude plan entry the saved API credits cover is kept as well.
- **Subagents must resolve through a ROLE, not a model name**
  (`lib/routing/agent-roles.ts`). In omp's `resolveEffectiveAgentModelSelection`,
  `role` is `undefined` for any source that is not a `@alias` — and the role
  is what keys the child's inherited retry-fallback chain, so a concrete pin
  means **no chain at all**, however carefully `retry.fallbackChains.task`
  was written. Worse, a pin that resolves to nothing falls through to
  `activeModelPattern`: ask an Opus session for a cheap subagent and every
  spawn silently runs on Opus. Cody writes `task.agentModelOverrides`
  (which outranks agent frontmatter) as aliases — `luna → @smol`,
  `scout → @smol`, `task → @task`, `reviewer`/`security-reviewer → @slow`
  (omp's own reviewer declares `@slow`; the older `@task` default meant the
  `slow` role never ran), … — filling gaps and repairing pins it
  can PROVE are broken (unresolvable against the cached catalog, or blacked
  out). A working concrete pin, an alias the user wrote, and an `on`/`off`
  value are left untouched; with no cached catalog no pin is ever judged
  unresolvable.
  `seance` (omp's bundled read-only "consult a saved chat" agent, 18.12+) is in
  `BUNDLED_AGENTS` and maps to `@smol` in `DEFAULT_AGENT_ROLES` because it has no
  `model:` of its own.
- **`retry.usageAwareFallback` is the same-provider-first switch.** With it
  on, omp checks usage health before each request (auth-storage
  `getModelUsageHealth`): the provider is healthy while ANY account is, and
  the session is moved onto that account before any chain is walked. Only
  providers with a ranking strategy (anthropic, openai-codex,
  alibaba-token-plan, …) are judged; the rest read "unknown", which is why
  chain filtering above still matters (OpenRouter credits). Trap — "Confirm
  interactively" behaves differently under Cody. omp's `turn-recovery.ts` computes
  `shouldFallback = depleted || policy === "auto" || !confirmer`, and
  `setUsageFallbackConfirmer` is wired only by the ACP agent and the
  interactive TUI controller — never by `--mode rpc-ui`, which is how Cody
  drives omp. So "Confirm interactively" cannot ask anyone and always
  answers yes: any model inside the reserve margin switches away silently.
  Surfaced as a warning clause on the setting itself
  (`SETTING_NOTES` in lib/omp/settings-surface.ts → `OmpSetting.codyNote`,
  rendered by SchemaSettingsList), kept honest by settings-surface.test.mjs
  (a note for a setting newer than the installed engine is only judged against
  engines that have it — `NOTE_SINCE` in the test). Also noted: 18.3.5+
  `providers.cacheWarming` (default `idle`, NOT pinned off for rpc-ui: omp
  replays the last request before the prompt cache expires — a real, billed
  provider call for up to 30 min after the last reply, only for models with a
  `promptCache` lifetime and a >$0.05 expected saving; Cody's 10-minute idle
  destroy skips sessions with a viewer, so warming runs while a tab is open)
  and 18.4.3+ `task.speculativeLaunch`.
- **Engine error text goes through one describer** (`lib/error-text.ts`
  `describeEngineError`, used by `engineErrorNotice` in useAgentSession for
  every engine, ACP notices included): it tells a refusal (safety policy,
  e.g. Anthropic `Refusal (…)`, Codex "flagged for possible cybersecurity
  risk") from usage, credits, auth, overload, transport and an outdated
  engine (`claude_code_version_too_old`), strips JSON wrappers, request ids,
  `raw-http-request=` paths, stack frames and trailing links, and caps the
  text. Identical notices collapse into one with a ×N count.
- **Routing notices are coalesced** (`ROUTING_BURST_MS`, useAgentSession):
  fallback-applied/succeeded events collect for 1.5 s and deliver ONE toast
  plus one notice. A lone event keeps its old wording; a subagent-attributed
  switch raises no toast at all (it already has a home in the subagent
  panel). The composer's persistent `autoModelSwitch` marker is unchanged —
  it is the durable signal.

### Claude API credits as the backup behind the Claude plans

The owner signs two Claude plan accounts into omp and holds a prepaid API key for
each. The keys are a BACKUP: used only once the plans are out, as the SAME model
on the SAME vendor (never a jump to Codex/OpenRouter while a key exists), and the
chat returns to the plan by itself when the limit lifts. Settings › Providers ›
Anthropic › "API credits (backup)" holds one key per plan account
(`ClaudeCreditsSection`, masked to the last four). omp only.
The Providers directory never lists `anthropic-api…` as rows of their own
(`buildProviderDirectory` skips them when it adds unclaimed catalog ids, as
`harness/omp.ts` skips their models.yml blocks): they are the Anthropic row's
business, and a row for each would be a second, deletable "provider" whose
removal silently breaks the credits.

- **What omp does with an Anthropic API key (omp 18.8.3, measured with its own
  `AuthStorage` and fake credentials; `lib/omp/claude-credits-omp.test.mjs` pins
  it).** Key order: runtime `--api-key` → models.yml `apiKey` → stored OAuth →
  login-stored API key → `ANTHROPIC_API_KEY` → other stored keys. The OAuth step
  has a last-resort pass (`allowBlocked`) that returns a BLOCKED plan account so
  the provider's own limit error comes back — it never falls through to a key.
  `limits.rotate` only rotates between credentials of the SAME type. So with a
  plan signed in, an API key under `anthropic` (stored, env or Cody's key box) is
  never used, even with both plans blocked; it wins only if every plan is
  removed. Today a plan limit goes to the next entry of `retry.fallbackChains`.
- **Mechanism: one extra provider PER KEY that omp's own chain walks to.** The
  first key lives under `anthropic-api`, the second under `anthropic-api-2`, …
  (`claudeCreditsProvider(slot)`, up to 8), each serving the plans' models with
  its key. Not one shared pool, because omp rotates to a sibling credential of ONE
  provider only when the error reads like a quota, and Anthropic's reply for an
  empty prepaid balance ("credit balance is too low", HTTP 400) does not. Measured
  against real omp: with both keys in one provider 2 of 6 fresh chats picked the
  empty key and fell to the next vendor with the other key unused; with one
  provider per key 6 of 6 went plan → key 1 (400) → key 2, and omp then skips the
  empty key's selector for about 5 minutes. Each piece exists only while a key does:
  1. the keys, in omp's AuthStorage, one per provider
     (`bin/cody-omp-claude-credits.mjs`: it refuses any provider outside the
     `anthropic-api*` family and answers with the existing row when the same key is
     already stored under another; removal also purges omp's soft-delete
     tombstone, though SQLite keeps freed pages until overwritten).
     `cody-claude-credits.json` (0600, no secret) records which plan account each
     key belongs to and which provider holds it (routing reads that without
     starting omp); a replaced key stays in its provider, a new one takes the first
     free provider;
  2. one Cody block per key's provider in models.yml (`syncClaudeCreditsProviders`):
     model IDs, plus `reasoning` and `thinking` copied from the bundled catalog row when the engine needs them (an unlisted-but-discovered model such as `claude-fable-5-2` on omp 18.8.3 builds as non-reasoning on its own, so the twin mirrors the catalog's thinking ladder; on omp 18.19 the catalog lists it and omp fills the rest itself), names suffixed " (API credits)" / " (API credits 2)", `auth: none`.
     Never omit `auth`: omp then forces OAuth-style request shaping; with `none` an
     `sk-ant-api…` key goes as `X-Api-Key` with no `Authorization` header. A
     hand-written provider of one of those names is never touched, a block keeps its
     `baseUrl` (a new one inherits the first's), the Providers directory hides them,
     and every chat launch levels them with omp's catalog (a new Claude model gets
     its twins at once, not when someone opens Settings). The Claude model list comes
     from `readClaudePlanModels` through the shared catalog reader (see "Prices for models
     omp does not know yet"), so saving a key works on both layouts. omp 18.19.0 holds a
     plan for 60 s when a refusal repeats with stale usage: a fake usage server in tests
     must report a reset of now + `retry-after`;
  3. a per-chat config overlay (`cody-claude-credits/<digest>.yml`) appended to
     `PI_CONFIG_FILES` by `withClaudeCreditsOverlay` (profile → preset → credits →
     Local-only, which replaces the launch so a Local-only chat never reaches a
     paid API). It rewrites every EFFECTIVE chain (config.yml + the chat's preset,
     `effectiveFallbackChains`): `anthropic-api/*`, `anthropic-api-2/*`, … FIRST in
     key order (omp resolves a wildcard against the model that just failed, so one
     entry serves every role and a non-Claude model skips it) and the exact twins
     after each `anthropic/<id>` entry (a Claude model parked at the END of a chain
     is backed too). Launch-only: config.yml, presets and the Model plan are never
     edited; the last key removed removes the overlay; content-addressed, newest 12
     kept, none deleted before 7 days.
- **Order, proven against real omp with fake backends**: plan accounts first (omp's
  own rotation) → key 1 after every plan's limit error → key 2 when key 1 is
  refused → no other provider before them → every key spent, the chain goes on to
  its next provider. omp returns to the plan itself at cooldown expiry
  (`retry.fallbackRevertPolicy` default `cooldown-expiry`; the settings row warns
  when it is `never`). The switch costs one refused plan request per chat start.
  `retry.usageAwareFallback` is untouched: with it on omp pins the fallback and
  never reverts.
- **Routing never jumps ahead of the credits** (`lib/routing/credits-cover.ts`).
  A spent Claude plan model the saved keys can answer for is "covered": role
  binding leaves the role alone, chain filtering keeps the entry, the agent-role
  repair does not call a covered pin exhausted. Covered stops when every saved key
  is blocked itself: omp's block on a refused key shows in the usage snapshot as an
  exhausted account of that key's provider (`applyCredentialBlocks` gives EACH
  blocked key its own), so "spent" means as many blocked credits accounts as keys.
- **Chat UX** (`hooks/claude-credits-notices.ts`, `useAgentSession`): ONE notice,
  "Claude plan limit reached — now using your Claude API credits." (the
  `retry_fallback_applied` from `anthropic/` to any `anthropic-api*/`); the plan's
  own limit warning is held 1 s and dropped when `auto_retry_start` arrives; the
  "fallback succeeded" notice is skipped; the model chip reads "… (API credits)";
  the silent restore (a bare `model_changed`) says "Claude plan is back". The
  generic "Retrying (1/3)…" banner for a Claude plan usage limit is held 1.6 s
  (`PLAN_LIMIT_RETRY_BANNER_HOLD_MS`, longer than rpc-manager's 1.2 s hold on the
  switch frame) and never shows when the credits take over; any other retry shows
  at once. A key that is empty adds a second hop (key 1 → key 2): it is announced
  by the generic fallback notice, which carries the provider's reason.
- **Not covered**: Cody's background one-shots (`lib/model-plan/one-shot.ts`:
  session titles, the plan researcher; Distill's own chain) are separate omp runs
  without the credits overlay, so on a Claude limit they still follow the normal
  chain (a title may be written by the next provider); the Claude Code engine has
  its own login; no balance is shown (Anthropic exposes none for a plain key); the
  generic `ANTHROPIC_API_KEY` box is unused by omp while a plan is signed in.

