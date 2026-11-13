# Composer: model and tools controls, word completion, attached panels, context gauge

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Composer model + tools controls
  - Composer word completion (omp 18.4 `predict_word`)
- Composer-attached panels (`components/ComposerPanels.tsx`)
- Composer context gauge

### Composer model + tools controls
- **Smart model row**: the model dropdown's pinned first row is labeled
  exactly `Smart`; engine roles and the resolved model are intentionally not
  appended. It is the labeled face of auto model selection. A NEW session with
  no explicit pick sends no `set_model`, so omp resolves `modelRoles.default`
  (the saved plan); Smart re-selects that state (`selectSmartModel()` clears
  `newSessionModel`). On a live session it resolves the configured default
  role to a concrete model client-side and pins it (omp's `set_model` RPC
  takes exact provider/model — no role aliases). Picking any named model pins
  it and OMP roles stop applying to that session's main turns.
- **Smart-ness survives the pin** (`smartPinnedModel` in useAgentSession):
  both a live Smart pick (`markSmartPinnedModel`) and the engine's own
  resolution of a Smart spawn (`pendingSmartSpawnRef`, claimed by the first
  authoritative model) record the pin as Smart's answer, id-scoped to their
  session — loads and reconciles reuse `loadSession`, so a reset there would
  wipe it mid-conversation. The composer keeps the label `Smart` while the
  running model still matches; it does not append that model to the label. The
  Advisor indicator is ShieldCheck, never Sparkles: Sparkles is the Smart glyph,
  and an accent sparkle beside the model name read as "auto-picked".
- **Display names and picker controls stay presentation-only.** `formatModelDisplayName()` in `lib/model-display.ts` is the shared display boundary for the composer, transcript, and usage surfaces; it may improve a catalog label but never changes the routing identifier. Fast remains beside the existing Composer model picker, and its adjacent Manage models gear opens Settings › Models. Only Smart is pinned; the ordinary named-model list has no sticky selection.
- **Composer quota is model-scoped, but the popup covers the whole session.** The RING gauges the selected/live model: select usage windows for that model; a reported tier explicitly scopes its bucket even when it is also marked shared; only untiered buckets apply to the account as a whole. Render the raw engine-reported plan without inferring a `$tier` convention. Saved resets are a separate single summary that keeps explicit zero visible; only meaningful positive account rows expand it. Under Smart routing, subagents and fallback chains other providers consume quota in the same session, so `lib/session-active-models.ts` derives every model in use this run (live model, Smart resolution, each subagent's `resolvedModel`, fallback `to`, this run's assistant turns) and the popup renders their windows EXPANDED under "Also in use", each attributed to what uses it ("Subagent scout (research)", "Fallback for this conversation"); OpenRouter credits appear the same way when only a subagent rides that gateway. Limits nothing in the session touches stay in the collapsed "Other limits" section that says they cannot stop the selected model.
- **The popover is a hierarchy, not a report** (`components/QuotaPopover.tsx`).
  The owner runs several accounts per provider and many models, and the old
  popover gave every fact equal weight: about 800 px of cards, pills and
  explanation paragraphs over the transcript. The order is fixed:
  1. The selected model, with its % used, and one meter for the BINDING
     window (the tightest one on the serving account). Other windows get
     one line each.
  2. Accounts, only when there is more than one: one line each. "Use reset"
     sits on a limited account's own row when that account holds a credit.
  3. Also in use, one line each.
  4. Saved resets and other limits, collapsed.
  5. A one-line freshness footer.

  Explanations live in tooltips, never inline, and colour marks state only.
  The one thing allowed between the hero and its meter is the usage-limit
  stage line (`usageLimit` prop, one ellipsised line, warning/error colour,
  full sentence in its tooltip) and only while the account is past its limit.
  About 320 px tall collapsed.
- **Quota popover: what omp 18.19.0 adds, and what 18.8.3 still gets.** The quota ring's popover (components/QuotaPopover.tsx) words only facts the engine actually sent, so the installed 18.8.3 renders exactly as before and 18.19.0 adds lines. `buildQuotaView` is a thin wrapper over `buildQuotaViewCore`: it adds per-read facts (`refreshFailed`, `unreported`) to whichever view came out, and the per-account facts (`policy` + `showPriority`, `fiveHourIdle`, `windowsStaleSince`; helper `accountFacts`) sit on the hero view or on each `QuotaAccountRowView`. Every field exists only when it has something to say; nothing is invented for an engine that does not report it. All wording lives in lib/usage/quota-copy.ts (pure, takes `t`): `describeAccountPolicy` (the default policy says nothing; the priority is named only when another login of the same provider has a non-default one, `providerUsesPriority`), `isFiveHourIdle` (omp's `inactiveGates` contains `5h` AND no 5-hour window is reported), `describeWindowAmount` (`UsageWindow.amount`: "$5 of $20", "40 of 100 credits"; a window with no length, `windowMs` null, renders normally), `creditExpiryState` / `formatCreditDate` (a saved reset is "soon" within `EXPIRES_SOON_MS` = 48 h; the date is a clock time today, a weekday within six days, a plain "Dec 30" beyond), `describeCreditClears` (from the credit's `clears` ids such as `anthropic:7d:fable`; ids Cody cannot name are dropped, nothing nameable means no line). Footer: a failed refresh with an older good reading shows "Numbers from <read time> · refresh failed at <time>" (the reason, when omp wrote a readable one, is the tooltip), never "Updated just now"; an account carried over from an earlier read says "Quota as of <time>"; logins omp could not read are one muted line ("omp could not read the quota of N signed-in accounts"), counted by provider only, never by identity or email. A limited login's row has a tooltip that explains the fallback model; with no reset time it reads "Limited" (`usage.accountLimitedNoTime`), never a leaked "{time}".

  Logins that cannot serve: `resolveModelAvailability` can answer `unavailable` (every login signed out or turned off). A login that ended gets the existing sign-in view (`signedOut` set, so the ring wears its dot and the popover its "Sign in again" button). A login omp turned off for any other reason gets `QUOTA_DISABLED`: warning colour and the words "Login turned off", but NO `signedOut`, so no dot and no sign-in button (the owner may have turned it off on purpose, and a sign-in is not the fix). The same holds with no model selected. `modelLimitReached` (the picker's "Limit reached" mark) stays exhausted-only: `unavailable` never marks or blocks a model in the picker.

  Saved resets inside the popover: each credit line shows its end date, an "Expires soon" tag when it is within 48 h (the Saved resets header carries the same tag so it is seen without opening anything), a "Clears: …" line from `credit.clears`, and "Expired <time>" for one already past; when `snapshot.failedProviders` is set, a note names the provider(s) whose list could not be read, so a short list is not read as "none". Automatic spending (components/QuotaAutoSpend.tsx): `AutoSpendSection` is bound to the running engine's own settings schema (`useSchemaIndex`); `buildAutoRedeemGroups` (hooks/auto-redeem-controls.ts) offers exactly the keys that engine has: 18.19.0 gets one Ask / Spend / Never switch per limit (`<group>Resets.autoRedeem5h`, `autoRedeemWeekly`, and Claude's separate `claudeResets.autoRedeemFable` with a note that weekly consent does not cover it), 18.8.3 gets the single legacy `<group>Resets.autoRedeem`, an engine with none gets no switches, and nothing renders before the schema has loaded. "Ask" is written as `unset`, never by clearing the key (clearing would let an old single key flow back in). Writes use the same `setValue` the Settings panel uses, so the two can never disagree.

  Tests (engine-independent, real `omp usage --json` fixtures of both engines in lib/usage/fixtures/): components/QuotaPopover.auth.test.mjs, lib/usage/quota-copy.test.mjs, hooks/auto-redeem-controls.test.mjs. Time assertions are timezone-agnostic on purpose (`\d{1,2}:\d{2}`, dates built from local-time parts).
- **The ring says whose quota it is, and how old the reading is.** With more
  than one account on a provider, every window label carries the account's
  POSITION (`brandedAccountLabel` → "Claude · Primary · 5-hour window"), and
  that label is what the ring's tooltip and the popover headline quote — so a
  percentage can never be read as the wrong subscription's. The per-account
  rows say `In use` / `Standby` and one line under them says what "in use"
  rests on (this conversation's last reply, the most recent request, or an
  expectation for a conversation that has not used the provider yet).
- **An out-of-date reading says so, and the ring dims.** omp re-serves the last report it saved for a login whose fetch fails, so an account can show days-old numbers that look live; after 30 minutes (`READING_OUTDATED_AFTER_MS`, lib/usage/reading-age.ts) the account carries `outdated: true` (set on the server by `withOutdatedReadings` and again in the browser by `mergeUsageRead`; `measuredAt` is omp's own report time). The ring (components/ChatInput.tsx) drops to half opacity, and its tooltip and aria label say "(out of date · measured 5 days ago)" (`usage.ringOutdated`, `usage.ringModelOutdated`) or, when no window of the account is left, "no current reading · last measured …" (`usage.ringOutdatedUnknown`, `usage.ringModelOutdatedUnknown`). The popover (components/QuotaPopover.tsx) puts an "Out of date · measured …" line under the account (`usage.outdatedReading`, `data-testid="quota-reading-outdated"`), dims its percentage, lists an outdated account with nothing left to show as "No current reading" (`noReading`, `usage.accountNoReading`), and when every account is outdated renders the `QUOTA_OUTDATED` absent view instead of a gauge. A window whose reset has passed is dropped, never shown as the old percentage. Strings are in en/ja/zh-CN; tests: components/QuotaPopover.auth.test.mjs, components/ChatInput.test.mjs, lib/usage/reading-age.test.mjs.
- **Saved resets are read gently** (`lib/harness/reset-credits-cache.ts`).
  omp discovers them live per account — for Claude up to three requests
  each — and Anthropic rate-limits those endpoints per source address;
  polling discovery from every tab's timer and focus event got every read a
  429 and every Claude row "Failed to load saved resets". One process-wide
  read now serves everyone for 10 minutes, a failed check backs off
  (2→15 min), the popover's Refresh forces at most one live check a minute,
  and a failed check keeps the account's last CONFIRMED balance
  (`cody-reset-credits.json`, 0600) marked stale rather than erasing it.
  Rows are named like the account list ("Claude · Primary"), never by the
  org/email string omp reports.
- **Saved-reset redemption (Claude and Codex).** Cody spends a saved reset through omp's own locked command when the installed engine has it, and through the old Bun helper otherwise. `redeemResetCredit` (lib/harness/reset-credits.ts) probes the engine once per binary and package version (`probeUsageResetSupport`: reads `omp usage --help` and checks the ACTION list for `reset`, no version-number compare; a failed probe is not cached and counts as unsupported). When supported, it hands the helper (bin/cody-omp-reset-credits.mjs) the omp binary; the helper first re-lists the account and refuses with `offer_changed` unless the grant the user chose is still the one omp will spend (`credits[0]`; omp's command spends the account's next credit and takes no credit id), then runs `omp usage reset <provider>/<credentialId>` (bin/cody-omp-reset-cli.mjs: fixed argv, no shell, `NO_COLOR=1`, 90 s timeout, `PI_CODING_AGENT_DIR` set). That command holds omp's cross-process lock (`<agent.db>.reset-<hash>`), so a Cody click cannot double-spend with a running omp. The command prints text, not JSON (`--json` only affects listing), so `parseUsageResetResult` maps exit code plus sentence to Cody's unchanged outcomes: `Reset applied for` with exit 0 -> `reset`; lock contention / lock timeout / "another omp process started spending" -> `reset_in_progress`; "another omp process spent" -> `already_redeemed`; nothing to reset, no credit, ineligible, offer changed, unconfirmed, cooldown, account unavailable, credit list failed -> their existing codes. Anything unrecognised, an exit 0 without the spend sentence, or a timeout is `inconclusive` (never reported as spent). If the binary cannot launch, the helper falls back to the direct storage call. Listing always stays on the Bun helper (works on every engine). The listing also carries each credit's `clears` (limits it refreshes, e.g. `anthropic:7d:fable` for the Fable launch reset) and `failedProviders` (a provider that did not answer; the other provider's accounts still show).

  Fable (omp 18.19.0): a Claude launch reset that also clears the Fable weekly cap is an ordinary Claude credit whose `clears` includes `anthropic:7d:fable`; it appears in the normal saved-reset list. omp 18.8.3 has no name for that cap and lists it as `anthropic:reset:seven_day_overage_included` (the API's own word), and a saved list written by 18.8.3 keeps that spelling after an upgrade; `describeCreditClears` (lib/usage/quota-copy.ts, `CLEARED_LIMIT_ALIASES`) reads both as "Fable weekly", so the "Clears:" line is the same on either engine. Whether it is spent automatically is the engine-side setting `claudeResets.autoRedeemFable` alone; nothing in the helper acts on it.
- **Saved-reset auto-redeem settings (omp 18.18.7+).** omp 18.18.7 replaced `codexResets.autoRedeem` / `claudeResets.autoRedeem` with per-window `autoRedeem5h` / `autoRedeemWeekly` (Claude also `autoRedeemFable`). The engine copies a legacy value into 5h and weekly IN MEMORY only and leaves config.yml untouched, so the file alone reads "unset" while omp is already spending saved resets. `migrateLegacyAutoRedeem(data, schemaKeys)` in `lib/omp/settings-values.ts` mirrors that rule (nested `group.autoRedeem` wins over the quoted dotted key; boolean true/false becomes yes/no, strings carry over; a window key that is already set, nested or flat, is never overwritten; Fable is never filled). `readSchemaSettings` applies it, so the Settings panel, the quota popover and `/api/omp-settings/schema` all show what the engine acts on. It is gated on the engine's schema declaring BOTH window keys of a group, so 18.8.x values pass through untouched. One engine quirk is mirrored on purpose: when the legacy key is a quoted dotted key with no nested group beside it, omp fills a dotted key it never reads (checked on 18.19.0 with `omp config get`: "unset"), so Cody fills nothing there either; showing or writing "yes" would grant a new spending consent. `writeSchemaSettings` extends the one existing write: when the patch touches any `group.autoRedeem*` key and the legacy key is still in the file, it writes BOTH 5h and weekly with their migrated values, applies the patch, and removes the legacy key, all in the same atomic write; other keys are never touched. The Claude 5h / weekly / Fable rows carry the note "Fable is a separate consent: it is not copied from the old switch." (`SETTING_NOTES` in `lib/omp/settings-surface.ts`, listed in the test's `NOTE_SINCE` as 18.18.7). A legacy value that is not unset/yes/no is written as "unset". Tests: `lib/omp/settings-values.test.mjs` compares the migration with `omp config get` on the installed engine (run it with CODY_OMP_BIN against 18.8.3 and 18.19.0).
- **Freshness is refreshed where it changes, and stated where it is read.** A
  usage read happens on mount, on a session switch, when the popover OPENS,
  on an explicit Refresh in the popover footer, and — the one that matters —
  on the falling edge of a run (`isStreaming` true→false in `ChatInput`),
  because a turn ending is the only moment the numbers provably moved. The
  hook's 90 s/5 min cadence alone left the ring quoting a pre-turn reading
  for up to a minute and a half after the reply landed. The footer tells the
  three states apart: `Reading…` while a read is out, `Updated <ago>` (plus
  `May be out of date` for a server-flagged stale snapshot), and
  `Could not refresh · last read <ago>` in warning colour when the last
  attempt FAILED — where the numbers on screen are the previous good ones and
  claiming an age for them would be claiming an answer that never arrived.
- **Engine-initiated model switches wear a persistent marker and name the
  job** (`autoModelSwitch`): `retry_fallback_applied` (error and usage-aware
  routing both emit it) and any bare `model_changed` whose model differs
  from the last authoritative one set a warning chip beside the model
  control; click re-shows the detail as a toast. The frame carries only
  `{from, to, role}`, so the JOB is derived from `role`: a built-in role
  (`default` = this conversation, `tiny` = session naming, `task`, `advisor`,
  ...) or `subagent:<id>`, and a CHILD subagent's fallback never arrives as
  a top-level frame at all: it is read off that child's progress frames
  (`resolvedModel` changing with `resolvedModelIsFallback` set,
  `activityFromProgressChange`), attributed to that subagent by roster name,
  and never repaints the composer's model marker (`announceFallbackApplied`,
  `hooks/session-control-scope.ts` `fallbackAttributionFor*`). The provider
  error is remembered PER JOB from `auto_retry_start`, because usage-aware
  fallback fires before any request with no retry at all: such a switch says
  "hit a usage limit or error" rather than borrowing another job's error.
  The echo of Cody's own `set_model` (`recentUserModelPicksRef`, 15s
  window) is never dressed up as an engine switch.
- **A refusal is not a limit, and the switch message says which**
  (`classifyFallbackReason`, hooks/session-control-scope.ts). The remembered
  `auto_retry_start` error is classified into `refusal` (the model declined on
  content-policy grounds: omp's stop detail is `refusal`/`sensitive`) or
  `usage` (quota, rate limit, out of credits), and the notice, toast and
  composer detail each use their own sentence. The two need opposite actions,
  which is why one generic "hit a usage limit or error" was wrong: a quota
  clears itself at the reset, while a refusal is PINNED for the rest of the
  run — omp passes `pinFallback: classifierRefusal` and
  `#maybeRestoreRetryFallbackPrimary` returns early on a pinned chain, so
  `retry.fallbackRevertPolicy: cooldown-expiry` never reverts it and only a
  manual re-pick returns to the original model. Refusal is matched FIRST
  because a wrapped message can carry both, and mislabelling a refusal sends
  the user to inspect a perfectly healthy quota. Unrecognized text stays
  unclassified and the provider's own words are shown.
  `hooks/fallback-reason.test.mjs` pins the precedence and the real Anthropic
  refusal string.
- **Live model and reasoning switches apply at the step boundary steering
  uses, never mid-stream.** omp's `steer` does not abort an in-flight
  provider stream either: it is delivered after the current assistant
  message and its tools, and `getModel`/`getReasoning` are sampled before
  EACH provider call. `set_thinking_level` is therefore safe any time (sent
  immediately, `thinkingLevelTarget` shown as "Applying High" until the
  engine confirms). `set_model` is NOT: on the Codex WebSocket provider,
  omp's model switch closes the socket and the running response ends as a
  provider ERROR whose turn is dropped from replay. So a live pick is held
  as `modelSwitchPending` (`phase: "waiting"`, status "Switching to X at
  next step") while `assistantProviderCallRef` says a stream is open, and
  dispatched at the first boundary frame (assistant `message_end`,
  `tool_execution_start`, `turn_end`, `agent_end`); a newer pick replaces
  the waiting one, a re-pick of the current model cancels it, and the
  applied `model_changed` posts an inline notice "Model switched to X.
  Applies from the next step." (`dispatchPendingModelSwitch`). ACP engines
  keep the picker disabled while a turn runs: mid-prompt `set_model`
  acceptance is unverified there, and `handleModelChange` refuses it
  without `chatExtras` regardless of the UI.
- **Running subagents cannot be switched, and Cody says so instead of
  pretending.** omp's RPC exposes only `get_subagents`,
  `get_subagent_messages` and `set_subagent_subscription`; `set_model` and
  `set_thinking_level` address the root session. A child resolves its model
  and effort once at spawn (request model > `task.agentModelOverrides` >
  agent frontmatter, with the task role expanded from settings re-read from
  disk per spawn), so role changes reach subagents started AFTERWARDS. The
  transcript dialog shows each child's resolved model (with a fallback
  marker), role and reasoning (`progress.thinkingLevel`, parsed from the
  `:<level>` suffix omp appends to `resolvedModel` or from wrapped
  `thinking_level_changed` events) plus that explanation, with no control.
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

#### Composer word completion (omp 18.4 `predict_word`)
- Ghost text after the caret, same engine/setting (`spelling.autocomplete`,
  default `auto`) as omp's terminal editor. Pieces: pure rules in
  `lib/word-completion.ts` (when to ask, stale-answer guard, accept text),
  `hooks/useWordCompletion.ts` (150 ms pause → `predict_word` → one
  suggestion; any text/caret change drops it), `components/ComposerGhostText.tsx`
  (transparent twin of the textarea with identical computed font/padding and
  `clientWidth`, scroll synced, ghost out of flow so wrapping never changes).
- Keys: Tab accepts with a trailing space, Right-arrow without, Esc rejects
  (`predict_word_feedback accepted:false`; Esc still aborts a running turn).
  Only while a suggestion is *visible*; slash/@/history menus disable the
  feature outright, so their Tab handling is never stolen. Accept uses
  `execCommand("insertText")` so Ctrl+Z undoes it (setValue fallback).
- Never sent: empty composer, caret not at end of a line, IME composition,
  touch devices (`useIsCoarsePointer`), non-omp engines, `!`/`/` lines, no
  session id. A ghost that would overflow its line is not shown or accepted.
- `POST /api/agent/[id]` answers `{suffix:null}` / success for these two
  commands when no session is live and NEVER spawns (`getRpcSession`, not
  `startRpcSession`) — the composer fires them at typing rate.
- `Unknown command` (omp 18.3) / `unsupported` turns the feature off for the
  page, silently (`isUnsupportedCommandError`); other errors back off 30 s.
- Engine facts (18.4.9, measured): first call after spawn ≈ 9 s (cold
  daemon; the stale guard discards it), then 1–30 ms; a newer request
  supersedes a queued one (answers `null`). `settings-surface.ts` exempts
  `spelling.autocomplete` from the Terminal-only chip; rest of `spelling.` stays.
- **The Send pill's ▾ menu reuses this catalog.** Its Model row
  (`components/ScheduleModelPicker.tsx`) lists the models and reasoning levels the
  composer's own model picker already holds (`ChatInput` builds
  `scheduleCatalog` from the same pinned/all lists and `modelThinkingLevels`), so a
  scheduled message can be sent on another model than the chat is on; it never
  renames or re-routes a model (display names via `formatModelDisplayName`, the
  stored value is the exact provider/id). See "Scheduled messages".

**Agent-requested model switch (`switch_model`).** An agent can move its own
chat onto another model — "switch to Opus 4.8 with high reasoning" — through the
host tool `switch_model` (`lib/model-switch/tool.ts`). `scope` defaults to
`chat`: ONLY the chat the agent runs in changes (`session` targets another of
the owner's chats by id or title, ownership-gated by `resolveSessionArgument`
like the scheduling tools). `scope: "everywhere"` is the explicit, rarer form:
it rewrites **only** `modelRoles.default` (`provider/id`, plus `:level` when a
reasoning level was given) through `readModelRoles`/`writeModelRoles` (the
Settings panel's helpers — every other role and every other setting in
config.yml is untouched), calls `invalidateModelsCache`, then
`restartIdleRpcSessions` (a running chat, including the calling one, keeps its
engine until it next restarts) and answers with what the default was before and
the exact `switch_model` call that undoes it. `everywhere` needs `model`, cannot
be combined with `session`, and is refused on engines other than omp (only omp
has default-model settings).

What a name means is decided against the target chat's OWN live catalog
(`get_available_models`; ACP: the models inside `get_state`), in
`lib/model-switch/resolve.ts`, and never by guessing: exact `provider/id` → bare
id → display name → same letters/digits without punctuation (`4.8` = `4-8`) →
every word present. A phrase that fits several models answers with the
candidates and changes nothing; an unknown one answers with the closest names
(bigram similarity) and, when its last word is a reasoning level ("opus 4.8
high"), says to pass it as `reasoning`. `reasoning` is validated against that
model's own ladder (`modelThinkingLevels` =
`selectableThinkingLevels(thinkingLevelsForMeta(model))`; a model without
reasoning has only `off`): `none`→`off`, `extra high`/`x-high`→`xhigh` and
similar spellings are accepted, a level the model lacks is refused with the
valid ones, never rounded to a neighbour.

`lib/model-switch/switch.ts` (`switchChatModel(sessionId, {provider, modelId,
thinkingLevel?}, opts)`, free of `@/` imports so later scheduled-send code in
the custom server can reuse it; `tool.ts` loads it lazily because it imports
`rpc-manager`, which imports the tool list) decides WHEN the change reaches the
engine: reasoning alone is applied at once in any state; a model change is
applied at once for an idle chat (`applies: next-turn`) and for the chat's own
agent inside a tool call on the rpc dialect (`atStepBoundary`; no provider
stream is open then — the tool call starts after the assistant message finished
— so the next request of the turn already uses the new model); any other running
chat waits for the composer's own boundary frames (assistant `message_end`,
`tool_execution_start`, `turn_end`, `agent_end`), an ACP engine only for
`turn_end`/`agent_end` and its reasoning cannot be set (`unsupported`). A newer
deferred switch replaces an older one for the same chat, a closing chat drops
it, and a deferred switch the engine then refuses is announced as an info
`notice` frame on the chat's own stream (its caller has already been answered).
The commands go in the order omp needs: `set_model` first, then
`set_thinking_level` (omp re-applies the new model's default level after
`set_model`); the result carries the engine's own `get_state` afterwards
(`not_applied` when it still reports the old model, `reasoning_failed` when the
model moved but the level did not).

The page is told BEFORE the engine switches: `EngineSession.announce?(event)`
(rpc wrapper: `emit`, no replay to late pages; ACP session: `emit`) puts a
`cody_agent_model_switch {provider, modelId, name?, thinkingLevel?,
modelChanges}` frame on the chat's stream. `hooks/agent-model-switch.ts` (a pure
marker the hook keeps in `agentModelSwitchRef`) lets `useAgentSession`'s
`model_changed`/`config_update`/`thinking_level_changed` handlers recognise the
change as the agent's, so the composer shows `agentSession.modelSwitchedByAgent`
/ `modelSwitchedByAgentWithLevel` / `thinkingLevelSetByAgent` ("Model switched
to X by the agent, at your request.") instead of the engine-fallback warning,
and the model leaves Smart mode exactly as a manual pick does.

Registered for omp MAIN chats only (`MODEL_SWITCH_TOOLS` in `SERVER_HOST_TOOLS`
and `MAIN_SESSION_TOOLS`, like `SCHEDULE_TOOLS`) — NOT the sidebar chat, whose
schema budget assumes the smallest local model. ACP engines reach it over MCP:
`bin/cody-display-mcp.js` registers `switch_model` and calls `POST
/api/internal/model-switch` (capability-token authenticated, on `proxy.ts`'s
`PUBLIC_EXACT`, env `CODY_MODEL_SWITCH_ENDPOINT` from
`lib/display/engine-tools.ts`/`capability.ts`); `bin/cody-display-mcp.test.mjs`
fails when the bridge's copy of the tool definition drifts from
`lib/model-switch/tool.ts`. Tests: `lib/model-switch/resolve.test.mjs`
(resolution + level validation), `lib/model-switch/switch.test.mjs` (timing,
order, refusals, `everywhere` writes only `modelRoles.default` and returns the
previous value, tool texts), `hooks/agent-model-switch.test.mjs`.

- **Composer thinking levels.** The composer's level list is `auto` + `thinkingLevelsFor(model)` (`off` + the model's own
  `thinking.efforts` when `reasoning` is true, else only `off`). It passes omp's per-model list through,
  so a live-discovered model shows the real ladder only when omp itself built it as reasoning: omp 18.8.3
  does that for an unlisted Fable build only while models.dev/online discovery knows it (offline it
  arrives as non-reasoning, which Cody cannot repair), omp 18.19.0 lists Fable 5.2 in its bundled
  catalog and shows `low..max` even offline. Credits twins mirror the catalog (see above).
- **Unverified thinking ladders.** omp 18.10.3+ may send `thinking.unverified: true` (with `reasoning: false`) for a model it has no capability data for. `hasUnverifiedLadder` (lib/thinking-levels.ts) is the one test for it; such a model still offers its ladder, the composer's reasoning menu shows a note, and `/api/models` entries carry `thinkingUnverified`. An engine that never sends the marker behaves exactly as before.

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

