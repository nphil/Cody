"use client";

/**
 * The composer quota ring's popover.
 *
 * Owns the whole quota-view pipeline: the pure `buildQuotaView` transform
 * (snapshot -> what the ring and this popover say) plus the popover itself,
 * so ChatInput only ever consumes the answer (`buildQuotaView`, the handful
 * of pure predicates the model dropdown needs, and the `<QuotaPopover>`
 * component) rather than owning the machinery. Moved out of ChatInput.tsx
 * wholesale (2026-09) when the owner's screenshot — several accounts per
 * provider, several models in flight — made the old flat "one card per
 * fact" popover unreadable. The information hierarchy is now: a single hero
 * (selected model, its binding window), an Accounts list only when there is
 * more than one to disambiguate, an always-visible "also in use" list for
 * other session models, and two disclosures (saved resets, other limits)
 * collapsed by default so a rarely-needed fact never outweighs the one that
 * matters right now.
 */
import React, { useCallback, useRef, useState } from "react";
import { ChevronRight, Info, RefreshCw } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { formatRelativeTime, usageToneColor } from "@/lib/format";
import { QuotaBar, clampQuotaPercent } from "@/components/QuotaBar";
import { OpenRouterCredits } from "./OpenRouterCredits";
import type { UseResetCreditsResult, ResetCreditAccount } from "@/hooks/useUsage";
import type { UseOpenRouterAccountResult } from "@/hooks/useOpenRouterAccount";
import { rankProviderAccounts, selectBindingWindow, selectWindowsForModel, type AccountEvidence, type ModelRef } from "@/lib/usage/select";
import { resolveModelAvailability } from "@/lib/usage/availability";
import type { UsageAccount, UsageAccountService, UsageInUseBasis, UsageSnapshot, UsageWindow, UsageWindowState } from "@/lib/usage/types";
import { brandAccountLabel } from "@/lib/provider-brand";
import { ProviderIcon } from "./ProviderIcon";
import { translate, useI18n } from "@/lib/i18n";
import { OMP_ENGINE_ID } from "./SettingsTabs";
import type { SessionActiveModel } from "@/lib/session-active-models";
import { Tooltip, Collapsible, CollapsibleTrigger, CollapsiblePanel } from "./ui/primitives";
import { ConfirmDialog } from "./ui/field";

/** Stable empty list keeps quota derivation memo-friendly when no session is live. */
const NO_ACTIVE_MODELS: readonly SessionActiveModel[] = [];

export interface QuotaWindowView {
  key: string;
  label: string;
  percent: number;
  color: string;
  state: UsageWindowState;
  exhausted: boolean;
  resetsAt: string | null;
  /** Set from ONE rejected request, never measured — omp's own deadline
   *  rather than a read utilization. Surfaced as short honesty text, never
   *  silently painted like a normal reading. */
  blocked: boolean;
}

/** A non-selected window that constrains work still active in this session. */
export interface QuotaInUseWindowView extends QuotaWindowView {
  provider: string;
  uses: SessionActiveModel["uses"];
}

/** One quota window the ring is deliberately NOT gauging — another provider's
 *  subscription, or another model tier on this one. Reported so a spent window
 *  is never a surprise, but kept out of everything that colours the ring. */
export interface QuotaOtherWindowView {
  key: string;
  /** Engine provider id, so the row can draw its brand mark. */
  provider: string;
  /** Account label, already branded ("Codex", never "Openai Codex"). */
  account: string;
  /** That account's binding window among the ones not shown above. */
  label: string;
  percent: number;
  state: UsageWindowState;
  exhausted: boolean;
  resetsAt: string | null;
  blocked: boolean;
}

/** One account among several serving the same provider as the selected
 *  model. omp routes to exactly one at a time (`serving`); every other
 *  reports `standby`, `limited`, or `disabled`. Rendered only when more than
 *  one account can serve the model — a single-account provider never grows
 *  this list. `label` is a position ("Primary", "Secondary", …), never the
 *  account's raw identity, which can be an email address or an org name. */
export interface QuotaAccountRowView {
  key: string;
  label: string;
  state: UsageAccountService;
  percent: number;
  resetsAt: string | null;
  planType: string | null;
  /** Position within the provider's own account list (0 = Primary) — the
   *  same index a saved-reset account reports, so the popover can offer a
   *  "Use reset" action on a limited row without guessing from `label`. */
  position: number;
  blocked: boolean;
}

export interface QuotaKnownView {
  known: true;
  /** Engine provider id of the binding account, for the header's brand mark. */
  provider: string;
  percent: number;
  color: string;
  state: UsageWindowState;
  label: string;
  resetsAt: string | null;
  blocked: boolean;
  windows: QuotaWindowView[];
  /** Non-selected models with work in this session, always expanded. */
  inUse: QuotaInUseWindowView[];
  /** Everything the section above does not cover, de-emphasised. */
  others: QuotaOtherWindowView[];
  /** Every account able to serve the selected model's provider, in use first.
   *  Empty unless more than one account can serve it. */
  accounts: QuotaAccountRowView[];
  /** What the in-use row rests on; null when there are no account rows. */
  accountsBasis: UsageInUseBasis | null;
  fetchedAt: string | null;
  stale: boolean;
  /** Subscription name only when the engine reported one. */
  planType: string | null;
  /** Banked rate-limit resets remain separate from quota windows. */
  resetCredits: UsageAccount["resetCredits"];
}

export interface QuotaAbsentView {
  known: false;
  color: string;
  /** i18n key standing in for the headline percentage's meaning. */
  titleKey: string;
  /** i18n key for the explanation under the divider, if any. */
  noteKey: string | null;
  /** i18n key for the footer's scope line. */
  scopeKey: string;
  /** Engine-supplied prose explaining the gap, when it gave one. */
  reason: string | null;
  others: QuotaOtherWindowView[];
  inUse: QuotaInUseWindowView[];
}

/** What the ring and the popover's quota half should say. A missing signal is
 *  a distinct shape — never a zero-percent reading — so nothing downstream can
 *  accidentally paint "0%" over an engine that simply does not report limits. */
export type QuotaView = QuotaKnownView | QuotaAbsentView;

/** The engine answered and reported no plan limits at all. Only reachable from
 *  an actual response — nothing else may claim this about an engine. */
const QUOTA_UNREPORTED: QuotaAbsentView = {
  known: false,
  color: "var(--text-muted)",
  titleKey: "usage.notReported",
  noteKey: "usage.notReportedNote",
  scopeKey: "usage.noQuotaSignal",
  reason: null,
  inUse: [],
  others: [],
};

/** No quota-reporting account serves the selected model's provider at all — a
 *  local runtime, say. Nothing this model spends is metered anywhere. */
const QUOTA_MODEL_UNMETERED: QuotaAbsentView = {
  known: false,
  color: "var(--text-muted)",
  titleKey: "usage.modelUnmetered",
  noteKey: "usage.modelUnmeteredNote",
  scopeKey: "usage.modelUnmeteredScope",
  reason: null,
  inUse: [],
  others: [],
};

/** The provider meters spend as a PREPAID BALANCE rather than a refilling
 *  window (OpenRouter). Saying "no plan limits" here would be false — money
 *  runs out, and it is the hardest limit there is — so the ring stays blank
 *  (there is no honest percentage of a balance the user can top up) while the
 *  credit section below states the real number. */
const QUOTA_MODEL_PREPAID: QuotaAbsentView = {
  known: false,
  color: "var(--text-muted)",
  titleKey: "usage.prepaidTitle",
  noteKey: null,
  scopeKey: "usage.prepaidScope",
  reason: null,
  inUse: [],
  others: [],
};

/** Providers that bill a prepaid balance instead of a refilling plan window,
 *  and therefore have a credit balance worth reading. Exported so the composer
 *  gates its OpenRouter poll on the SAME predicate the quota view branches on:
 *  a model that shows the prepaid state must be a model whose balance was
 *  fetched, or the popover says "prepaid" and then shows nothing. */
export function isPrepaidProvider(provider: string | null | undefined): boolean {
  return typeof provider === "string" && provider.trim().toLowerCase() === "openrouter";
}

/** omp's own models already carry the provider id `/api/usage` reports
 *  accounts under ("anthropic", "openai-codex", ...). An ACP engine (Claude
 *  Code, Codex) instead reports every one of ITS models under its own
 *  engine id as `provider` (`lib/harness/acp-session.ts`'s `resolvedModel()`
 *  sets `provider: this.spec.id`), so a bare "claude-opus-4-5" or "gpt-5.1"
 *  needs translating before it means anything to the usage snapshot. */
const ACP_ENGINE_USAGE_PROVIDER: Record<string, string> = {
  claude: "anthropic",
  codex: "openai-codex",
};

/**
 * The omp usage-provider id that actually meters a model, or null when Cody
 * cannot say so with confidence.
 *
 * Deliberately conservative: only omp itself (whose models already carry the
 * right id) and the two ACP engines above translate, and only when the
 * option's own provider IS that engine's id — never a guess for Pi, Hermes,
 * or any other engine. A wrong guess would mark a healthy model exhausted,
 * or hide a real exhaustion; showing nothing is the safe wrong answer,
 * mismarking is not.
 */
export function usageProviderFor(engineId: string | null | undefined, modelProvider: string): string | null {
  if (engineId === OMP_ENGINE_ID) return modelProvider;
  if (!engineId || modelProvider !== engineId) return null;
  return ACP_ENGINE_USAGE_PROVIDER[engineId] ?? null;
}

/**
 * Whether the model picker should mark one option as spent, for ANY engine.
 *
 * `resolveModelAvailability` is already account-aware — a model reads
 * "exhausted" only when every account able to serve it is, so a healthy
 * sibling account never earns a mark here. This only adds the engine→provider
 * translation on top, and only marks on a positive "exhausted" verdict:
 * "unknown" (no mapping, or the snapshot has nothing to say) and "warning"
 * both render nothing extra, same as a model with quota on another account.
 */
export function modelLimitReached(
  snapshot: UsageSnapshot | null | undefined,
  engineId: string | null | undefined,
  optProvider: string,
  optModelId: string,
): { resetsAt: string | null } | null {
  if (!snapshot?.available) return null;
  const usageProvider = usageProviderFor(engineId, optProvider);
  if (!usageProvider) return null;
  const availability = resolveModelAvailability(snapshot, usageProvider, optModelId);
  return availability.state === "exhausted" ? { resetsAt: availability.resetsAt ?? null } : null;
}

/** The provider DOES report quota and none of it constrains this model (every
 *  window it reports is scoped to another model tier). Emphatically not the
 *  same as "no limits reported": the quota exists, it just cannot stop this
 *  model, and saying the former would hide a real limit the next model hits. */
const QUOTA_MODEL_UNCONSTRAINED: QuotaAbsentView = {
  known: false,
  color: "var(--text-muted)",
  titleKey: "usage.modelUnconstrained",
  noteKey: "usage.modelUnconstrainedNote",
  scopeKey: "usage.modelUnconstrainedScope",
  reason: null,
  inUse: [],
  others: [],
};

/** Cody never got an answer: the first read has not landed, or the last one
 *  failed (server restarting, proxy error page). Says nothing about the
 *  engine's limits, because nothing has established anything about them. */
const QUOTA_UNAVAILABLE: QuotaAbsentView = {
  known: false,
  color: "var(--text-muted)",
  titleKey: "usage.unavailableTitle",
  noteKey: "usage.unavailableNote",
  scopeKey: "usage.unavailableScope",
  reason: null,
  inUse: [],
  others: [],
};

/** A read is out and nothing has come back yet. */
const QUOTA_CHECKING: QuotaAbsentView = {
  known: false,
  color: "var(--text-muted)",
  titleKey: "usage.checking",
  noteKey: null,
  scopeKey: "usage.checkingScope",
  reason: null,
  inUse: [],
  others: [],
};

/** Machine reason codes ("engine_unsupported") must not reach the popover;
 *  only a sentence the server actually wrote for a human does. */
function readableReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.includes(" ") && trimmed.length <= 200 ? trimmed : null;
}

/** Severity ranking for the de-emphasised list: a refused window outranks a
 *  merely-full one, exactly as lib/usage/select ranks the binding one. */
const OTHER_STATE_RANK: Record<UsageWindowState, number> = { exhausted: 2, warning: 1, ok: 0 };

function accountWindowKey(accountIndex: number, account: UsageAccount, window: Pick<UsageWindow, "id">): string {
  return accountIndex + ":" + account.provider + ":" + window.id;
}

/** "Primary" / "Secondary" / "Account {n}" — never the raw identity, which
 *  can be an email address or an organization name the composer must not
 *  print. */
function accountPositionLabel(position: number): string {
  if (position === 0) return translate("usage.accountPrimary");
  if (position === 1) return translate("usage.accountSecondary");
  return translate("usage.accountNth", { n: position + 1 });
}

/** Brand name, plus a position discriminator when this account's provider
 *  has more than one — e.g. "Claude · Secondary". Built from the provider id
 *  and ORIGINAL snapshot position only, so it never touches `label`/`identity`. */
function brandedAccountLabel(accounts: UsageAccount[], account: UsageAccount): string {
  const brand = brandAccountLabel(account.provider, account.provider);
  const siblings = accounts.filter((candidate) => candidate.provider === account.provider);
  return siblings.length > 1 ? `${brand} · ${accountPositionLabel(siblings.indexOf(account))}` : brand;
}

/** Tone for each per-account state dot — accent for the account in use,
 *  muted for a healthy standby, the shared error tone for anything blocked
 *  (limited or disabled alike). */
const ACCOUNT_STATE_COLOR: Record<UsageAccountService, string> = {
  in_use: "var(--accent)",
  standby: "var(--text-muted)",
  limited: "var(--status-error)",
  disabled: "var(--status-error)",
};

/** i18n key for each per-account state, used as the dot's accessible name —
 *  the dot's colour carries the state visually, this carries it for anyone
 *  who cannot see colour. */
const ACCOUNT_STATE_LABEL_KEYS: Record<UsageAccountService, string> = {
  in_use: "usage.accountInUse",
  standby: "usage.accountStandby",
  limited: "usage.accountLimited",
  disabled: "usage.accountDisabled",
};

/** What "In use" rests on, now surfaced through the Accounts header's info
 *  tooltip rather than an always-visible paragraph. */
const ACCOUNT_BASIS_NOTE_KEYS: Record<UsageInUseBasis, string> = {
  session: "usage.accountsBasisSession",
  recent: "usage.accountsBasisRecent",
  expected: "usage.accountsBasisExpected",
};

/** What this conversation says about which account serves `provider`: the
 *  account omp recorded for its latest reply, if it has used the provider.
 *  A recorded pin Cody could not match still proves the provider was used,
 *  so the account that most recently served a request stands in — labelled
 *  as that, never as this conversation's. With no pin at all, nothing: omp
 *  routes a conversation's first request by quota headroom, so another
 *  conversation's account is no evidence here. */
function sessionEvidence(snapshot: UsageSnapshot, provider: string): AccountEvidence {
  const entry = snapshot.sessionAccounts?.[provider];
  if (!entry) return {};
  return entry.accountId ? { inUseAccountId: entry.accountId } : { recent: true };
}

function isSelectedModel(active: SessionActiveModel, selected: ModelRef): boolean {
  return active.provider.trim().toLocaleLowerCase() === selected.provider.trim().toLocaleLowerCase()
    && active.modelId.trim() === selected.modelId.trim();
}

function mergeModelUses(target: SessionActiveModel["uses"], incoming: SessionActiveModel["uses"]): void {
  for (const use of incoming) {
    if (!target.some((candidate) => candidate.kind === use.kind && candidate.label === use.label)) {
      target.push({ kind: use.kind, label: use.label });
    }
  }
}

/**
 * Windows for concrete non-selected models with attributable session work.
 * A shared provider window is rendered once with every reason it is active;
 * tiered windows remain separate, exactly like the selected model's rows.
 */
function buildInUseWindows(
  accounts: UsageAccount[],
  primary: { account: UsageAccount; windows: UsageWindow[] } | null,
  activeModels: readonly SessionActiveModel[],
  selectedModel: ModelRef,
  nameWindow: (account: UsageAccount, windowLabel: string) => string,
  evidenceFor: (provider: string) => AccountEvidence,
): QuotaInUseWindowView[] {
  const primaryAccountIndex = primary ? accounts.indexOf(primary.account) : -1;
  const primaryKeys = new Set(
    primary && primaryAccountIndex >= 0
      ? primary.windows.map((window) => accountWindowKey(primaryAccountIndex, primary.account, window))
      : [],
  );
  const rows = new Map<string, QuotaInUseWindowView>();

  for (const active of activeModels) {
    if (isSelectedModel(active, selectedModel) || active.uses.length === 0) continue;
    // Subagents inherit their parent's account affinity (omp copies it at
    // spawn), so the conversation's evidence applies to their models too.
    const match = selectWindowsForModel(accounts, active, evidenceFor(active.provider));
    if (!match) continue;
    const accountIndex = accounts.indexOf(match.account);
    if (accountIndex < 0) continue;

    for (const quotaWindow of match.windows) {
      const key = accountWindowKey(accountIndex, match.account, quotaWindow);
      if (primaryKeys.has(key)) continue;
      const existing = rows.get(key);
      if (existing) {
        mergeModelUses(existing.uses, active.uses);
        continue;
      }
      const percent = clampQuotaPercent(quotaWindow.utilization);
      rows.set(key, {
        key,
        provider: match.account.provider,
        label: nameWindow(match.account, quotaWindow.label),
        percent,
        color: usageToneColor(percent, quotaWindow.state),
        state: quotaWindow.state,
        exhausted: quotaWindow.state === "exhausted",
        resetsAt: quotaWindow.resetsAt,
        blocked: quotaWindow.source === "block",
        uses: active.uses.map((use) => ({ kind: use.kind, label: use.label })),
      });
    }
  }

  return [...rows.values()].sort((a, b) => (
    (OTHER_STATE_RANK[b.state] ?? 0) - (OTHER_STATE_RANK[a.state] ?? 0) || b.percent - a.percent
  ));
}

/**
 * Everything the selected model and the active-session rows do not cover,
 * one binding row per account. These limits remain visible, but explicitly
 * cannot stop the selected model.
 */
function buildOtherWindows(
  accounts: UsageAccount[],
  primary: { account: UsageAccount; windows: UsageWindow[] } | null,
  inUseKeys: ReadonlySet<string>,
  excludeProvider: string | null = null,
): QuotaOtherWindowView[] {
  const primaryAccountIndex = primary ? accounts.indexOf(primary.account) : -1;
  const primaryKeys = new Set(
    primary && primaryAccountIndex >= 0
      ? primary.windows.map((window) => accountWindowKey(primaryAccountIndex, primary.account, window))
      : [],
  );
  const rows: QuotaOtherWindowView[] = [];
  accounts.forEach((account, index) => {
    if (!account) return;
    if (excludeProvider !== null && account.provider === excludeProvider) return;
    const leftover = (account.windows ?? []).filter((window): window is UsageWindow => (
      Boolean(window)
      && !primaryKeys.has(accountWindowKey(index, account, window))
      && !inUseKeys.has(accountWindowKey(index, account, window))
    ));
    // Same comparator as the ring's own pick, so the row a user reads first is
    // the one that would stop them first on that account.
    const binding = selectBindingWindow([{ ...account, windows: leftover }]);
    if (!binding) return;
    rows.push({
      key: accountWindowKey(index, account, binding.window),
      provider: account.provider,
      account: brandedAccountLabel(accounts, account),
      label: binding.window.label,
      percent: clampQuotaPercent(binding.window.utilization),
      state: binding.window.state,
      exhausted: binding.window.state === "exhausted",
      resetsAt: binding.window.resetsAt,
      blocked: binding.window.source === "block",
    });
  });
  return rows.sort((a, b) => (
    (OTHER_STATE_RANK[b.state] ?? 0) - (OTHER_STATE_RANK[a.state] ?? 0) || b.percent - a.percent
  ));
}

/** Turns the usage snapshot into the ring's states. Pure, so the thresholds and
 *  the absence cases are testable without a DOM.
 *
 *  Quota is per provider, so the ring answers for the SELECTED model: an
 *  exhausted week on another provider says nothing about whether this model can
 *  run, and letting it drive the ring makes the gauge scream about a resource
 *  the conversation does not spend. With no model selected there is nothing to
 *  scope to, and the account-wide reading stands.
 *
 *  Absence comes in five flavours and they must not be conflated: still
 *  checking, could-not-read (never loaded, or the last read failed), the engine
 *  having genuinely answered "no limits here", this model's provider reporting
 *  no limits, and this model's provider reporting limits none of which apply to
 *  it. Only an actual answer is entitled to say anything about the engine. */
export function buildQuotaView(
  snapshot: UsageSnapshot | null,
  loading: boolean,
  failed = false,
  model?: ModelRef | null,
  activeModels: readonly SessionActiveModel[] = NO_ACTIVE_MODELS,
): QuotaView {
  if (!snapshot) {
    // A first read still in flight says "checking"; once one has failed, the
    // retries keep saying "could not read" rather than flipping back to
    // "checking" every poll. Neither one may speak for the engine.
    if (loading && !failed) return QUOTA_CHECKING;
    return QUOTA_UNAVAILABLE;
  }
  const accounts = snapshot.accounts ?? [];
  if (!snapshot.available || accounts.length === 0) {
    return { ...QUOTA_UNREPORTED, reason: readableReason(snapshot.reason) };
  }
  // Every account the engine reports is unlimited (a local runtime, say):
  // there is no quota to gauge, which is different from having no signal.
  if (accounts.every((account) => account.unlimited)) {
    return {
      known: false,
      color: "var(--text-muted)",
      titleKey: "usage.unlimitedTitle",
      noteKey: "usage.unlimitedNote",
      scopeKey: "usage.unlimited",
      reason: readableReason(snapshot.reason),
      inUse: [],
      others: [],
    };
  }

  // One account needs no disambiguation; several do, so each window carries
  // the account it belongs to — under its brand name, which is how the owner
  // knows the subscription ("Claude", not "Anthropic").
  const multipleAccounts = accounts.length > 1;
  const nameWindow = (account: UsageAccount, windowLabel: string) => {
    if (!multipleAccounts) return windowLabel;
    const accountLabel = brandedAccountLabel(accounts, account);
    return accountLabel ? `${accountLabel} · ${windowLabel}` : windowLabel;
  };

  if (model) {
    const evidenceFor = (provider: string) => sessionEvidence(snapshot, provider);
    const ranks = rankProviderAccounts(accounts, model.provider, model.modelId, evidenceFor(model.provider));
    // The ring reads the account in use (ranks[0]); taking it from the same
    // ranking the list below renders guarantees they name the same account.
    const match = ranks[0] ? { account: ranks[0].account, windows: ranks[0].windows } : null;
    // windows[0] is the pick selectBindingWindowForModel makes — taking it here
    // selects once over the snapshot instead of twice, and guarantees the ring
    // and the list below it name the same window.
    const modelBinding = match?.windows[0] ?? null;
    const inUse = buildInUseWindows(accounts, match, activeModels, model, nameWindow, evidenceFor);
    // Only worth listing when more than one account can actually serve this
    // model — a single-account provider has nothing to disambiguate.
    const providerAccounts = accounts.filter((account) => account.provider === model.provider);
    const accountRows: QuotaAccountRowView[] = providerAccounts.length > 1
      ? ranks.map((rank) => ({
          key: rank.account.id,
          label: accountPositionLabel(providerAccounts.indexOf(rank.account)),
          state: rank.state,
          percent: clampQuotaPercent(rank.binding?.utilization ?? 0),
          resetsAt: rank.binding?.resetsAt ?? null,
          planType: rank.account.planType,
          position: providerAccounts.indexOf(rank.account),
          blocked: rank.binding?.source === "block",
        }))
      : [];
    const accountsBasis = accountRows.length > 0 ? (ranks.find((rank) => rank.state === "in_use")?.basis ?? null) : null;
    const others = buildOtherWindows(
      accounts,
      match,
      new Set(inUse.map((entry) => entry.key)),
      accountRows.length > 1 ? model.provider : null,
    );
    const reason = readableReason(snapshot.reason);

    if (!match || !modelBinding) {
      // A prepaid gateway is not a silence at all — it meters spend, just not
      // in windows. It has to be checked BEFORE the unmetered fallback, which
      // would otherwise claim "nothing it runs counts against a quota" about
      // an account that is literally spending money per token.
      if (isPrepaidProvider(model.provider)) return { ...QUOTA_MODEL_PREPAID, inUse, others };
      // Three different silences, and the copy has to tell them apart: no
      // account serves this provider / the account is unmetered / the account
      // reports quota that all belongs to other models.
      const providerReportsQuota = match !== null
        && match.account.unlimited !== true
        && (match.account.windows ?? []).some(Boolean);
      return providerReportsQuota
        ? { ...QUOTA_MODEL_UNCONSTRAINED, reason, inUse, others }
        : { ...QUOTA_MODEL_UNMETERED, reason, inUse, others };
    }

    const accountIndex = accounts.indexOf(match.account);
    const modelPercent = clampQuotaPercent(modelBinding.utilization);
    return {
      known: true,
      provider: match.account.provider,
      percent: modelPercent,
      color: usageToneColor(modelPercent, modelBinding.state),
      state: modelBinding.state,
      label: nameWindow(match.account, modelBinding.label),
      resetsAt: modelBinding.resetsAt,
      blocked: modelBinding.source === "block",
      // Already most-binding-first from the selector, and left in that order:
      // the row a user reads first is the one that stops them first.
      windows: match.windows.map((quotaWindow) => {
        const percent = clampQuotaPercent(quotaWindow.utilization);
        return {
          key: `${accountIndex}:${match.account.provider}:${quotaWindow.id}`,
          label: nameWindow(match.account, quotaWindow.label),
          percent,
          color: usageToneColor(percent, quotaWindow.state),
          state: quotaWindow.state,
          exhausted: quotaWindow.state === "exhausted",
          resetsAt: quotaWindow.resetsAt,
          blocked: quotaWindow.source === "block",
        };
      }),
      others,
      accounts: accountRows,
      accountsBasis,
      inUse,
      fetchedAt: snapshot.fetchedAt ?? null,
      stale: snapshot.stale === true,
      planType: match.account.planType,
      resetCredits: match.account.resetCredits,
    };
  }

  const binding = selectBindingWindow(accounts);
  if (!binding) return { ...QUOTA_UNREPORTED, reason: readableReason(snapshot.reason) };

  const windows: QuotaWindowView[] = accounts
    // Window ids are unique only WITHIN an account, so two subscriptions on
    // one provider can report the same id. The row key carries the account's
    // position too — the list is re-sorted on every refresh, and duplicate
    // keys freeze the second account's row on stale numbers.
    .flatMap((account, accountIndex) => (account.windows ?? []).map((quotaWindow) => {
      const percent = clampQuotaPercent(quotaWindow.utilization);
      return {
        key: `${accountIndex}:${account.provider}:${quotaWindow.id}`,
        label: nameWindow(account, quotaWindow.label),
        percent,
        color: usageToneColor(percent, quotaWindow.state),
        state: quotaWindow.state,
        exhausted: quotaWindow.state === "exhausted",
        resetsAt: quotaWindow.resetsAt,
        blocked: quotaWindow.source === "block",
      };
    }))
    .sort((a, b) => b.percent - a.percent);

  const percent = clampQuotaPercent(binding.window.utilization);
  return {
    known: true,
    provider: binding.account.provider,
    percent,
    color: usageToneColor(percent, binding.window.state),
    state: binding.window.state,
    label: nameWindow(binding.account, binding.window.label),
    resetsAt: binding.window.resetsAt,
    blocked: binding.window.source === "block",
    windows,
    // The account-wide list above already shows every window there is.
    inUse: [],
    others: [],
    accounts: [],
    accountsBasis: null,
    fetchedAt: snapshot.fetchedAt ?? null,
    stale: snapshot.stale === true,
    planType: binding.account.planType,
    resetCredits: binding.account.resetCredits,
  };
}

/** "18:20" for a reset later today, "Sun 09:00" once it crosses a day —
 *  matching how MessageView renders wall-clock times. */
export function formatResetTime(iso: string | null, locale: string, now: number): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const ts = at.getTime();
  if (!Number.isFinite(ts)) return null;
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return sameDay
    ? at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** Usage-window labels are presentation text, unlike opaque plan and model
 * identifiers. Give case-aware locales a readable capital to every visible
 * window segment without changing the reported value itself. */
function formatQuotaLabel(label: string, locale: string): string {
  return label.replace(/(^|·\s*)(\p{Ll})/gu, (_match, prefix: string, letter: string) => prefix + letter.toLocaleUpperCase(locale));
}

/* ────────────────────────── Presentational rows ────────────────────────── */

/** One compact quota line: label, percent, an optional trailing meta fragment
 *  (reset time, block honesty), an optional secondary attribution line, and
 *  its own mini meter. Every de-emphasised or "also in use" row in the
 *  popover is one of these at a different volume — never a separate card. */
function WindowLine({
  icon,
  label,
  percent,
  color,
  metaText,
  subText,
  muted = false,
  meterHeight = 3,
}: {
  icon?: React.ReactNode;
  label: string;
  percent: number;
  color: string;
  metaText?: string | null;
  subText?: string | null;
  muted?: boolean;
  meterHeight?: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5, minWidth: 0, overflow: "hidden" }}>
        {icon}
        <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, color: muted ? "var(--text-dim)" : "var(--text-muted)" }}>
          {label}
        </span>
        <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>
          {`${Math.round(percent)}%`}
        </span>
        {metaText && (
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {`· ${metaText}`}
          </span>
        )}
      </div>
      {subText && (
        <div style={{ fontSize: 11, lineHeight: 1.3, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {subText}
        </div>
      )}
      <QuotaBar percent={percent} color={color} height={meterHeight} dimmed={muted} />
    </div>
  );
}

/** One row in the Accounts list: a state dot, the account's position, and
 *  either its percentage or a "Limited · resets …" note in its place. A
 *  limited row with a redeemable saved reset gets a contextual "Use reset"
 *  action right on the row — the one place that shortcut belongs, since it
 *  is scoped to exactly the account it would clear. */
function AccountRow({
  account,
  reset,
  now,
  locale,
  t,
  onUseReset,
}: {
  account: QuotaAccountRowView;
  reset: ResetCreditAccount | null;
  now: number;
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUseReset: (reset: ResetCreditAccount, label: string) => void;
}) {
  const tone = ACCOUNT_STATE_COLOR[account.state];
  const resetTime = account.state === "limited" ? formatResetTime(account.resetsAt, locale, now) : null;
  const rightText = account.state === "limited"
    ? (resetTime ? t("usage.accountLimited", { time: resetTime }) : t(ACCOUNT_STATE_LABEL_KEYS.limited))
    : account.state === "disabled"
      ? t(ACCOUNT_STATE_LABEL_KEYS.disabled)
      : null;
  const canUseReset = account.state === "limited" && reset !== null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span
        aria-hidden="true"
        title={t(ACCOUNT_STATE_LABEL_KEYS[account.state])}
        style={{ flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: tone }}
      />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {account.label}
        {/* Which account is serving has to read at a glance, not from a dot's
            hover title; limited/disabled already say so on the right. */}
        {(account.state === "in_use" || account.state === "standby") && (
          <span data-testid="quota-account-state" style={{ marginLeft: 6, fontSize: 11, color: account.state === "in_use" ? tone : "var(--text-dim)" }}>
            {t(ACCOUNT_STATE_LABEL_KEYS[account.state])}
          </span>
        )}
      </span>
      {canUseReset && (
        <button
          type="button"
          onClick={() => onUseReset(reset, account.label)}
          style={{ flexShrink: 0, padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}
        >
          {t("usage.useReset")}
        </button>
      )}
      <span
        title={account.blocked ? t("usage.blockedTag") : undefined}
        style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: rightText ? tone : tone, fontVariantNumeric: "tabular-nums" }}
      >
        {rightText ?? `${Math.round(account.percent)}%`}
      </span>
    </div>
  );
}

/** One collapsed-by-default disclosure: a chevron + title trigger, and a
 *  panel that stays mounted (hidden, not unmounted) while closed so its
 *  content is still present for anyone who searches the page — and so a
 *  test can assert what lives inside it without simulating a click. */
function DisclosureSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          style={{
            display: "flex", alignItems: "center", gap: 5, width: "100%",
            background: "none", border: "none", padding: 0, cursor: "pointer",
            fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textAlign: "left",
          }}
        >
          <ChevronRight
            size={11}
            strokeWidth={1.8}
            aria-hidden="true"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}
          />
          <span>{title}</span>
        </CollapsibleTrigger>
        <CollapsiblePanel keepMounted style={{ marginTop: 8 }}>
          {children}
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/** One saved-reset account, collapsed to a single line: brand, count,
 *  expiry, and a contextual Use action. Everything that used to be its own
 *  paragraph (the per-credit description, a stale-check caveat, why it
 *  cannot be redeemed) moves into the row's own `title` tooltip instead of
 *  taking a line of its own. */
function SavedResetRow({
  account,
  label,
  now,
  locale,
  t,
  onUse,
}: {
  account: ResetCreditAccount;
  label: string;
  now: number;
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUse: () => void;
}) {
  const credit = account.credits[0];
  const expiry = credit ? formatResetTime(credit.expiresAt, locale, now) : null;
  const checked = account.stale && account.checkedAt ? formatRelativeTime(account.checkedAt, locale, now) : null;
  const canUse = Boolean(credit) && account.canRedeem && !account.retrying;
  const statusText = account.retrying
    ? t("usage.resetCreditRetrying")
    : account.error
      ? account.error
      : t("usage.resetCount", { count: account.availableCount });
  const tooltip = [
    credit?.title,
    checked ? t("usage.resetCreditAsOf", { time: checked }) : null,
    !account.error && !account.canRedeem && account.reason ? account.reason : null,
  ].filter(Boolean).join(" ") || undefined;
  return (
    <div title={tooltip} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {`${label} · ${statusText}`}
        {expiry ? ` · ${t("usage.expiresAt", { time: expiry })}` : ""}
      </span>
      {canUse && (
        <button
          type="button"
          onClick={onUse}
          style={{ flexShrink: 0, padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}
        >
          {t("usage.useReset")}
        </button>
      )}
    </div>
  );
}

/** The quota ring's popover keeps the selected model as one clear hero,
 * spelling out every other model with attributable work in this session as a
 * plain always-visible list, and pushes anything rarely needed (saved
 * resets, limits that cannot affect this model) into two disclosures closed
 * by default. Context usage and token traffic live in the top bar. Exported
 * so SSR tests can render it open, which the composer's own state never is. */
export function QuotaPopover({
  resetCredits,
  openRouter,
  quota,
  activeModels = NO_ACTIVE_MODELS,
  provider,
  modelName,
  now,
  failed = false,
  refreshing = false,
  onRefresh,
  anchorTop = null,
  anchorRight = null,
}: {
  resetCredits?: UseResetCreditsResult;
  /** Concrete models with work attributable to this session. */
  activeModels?: readonly SessionActiveModel[];
  /** OpenRouter's prepaid balance when it is selected or actively used by this
   * session. Absent otherwise: subscription providers have no credit balance
   * and must not grow a gateway section. */
  openRouter?: UseOpenRouterAccountResult;
  quota: QuotaView;
  /** Selected model's provider, naming the header before anything binds. */
  provider: string | null;
  modelName: string | null;
  now: number;
  /** The last usage read did not land. The numbers on screen are the previous
   * good ones, and saying "updated 2 min ago" about them would be a claim the
   * read never supported. */
  failed?: boolean;
  /** A read is in flight right now, so the age is about to change. */
  refreshing?: boolean;
  /** Re-read usage on demand. The ring is a snapshot of a moving number: the
   * only honest answer to "is this current?" is a way to ask again. */
  onRefresh?: () => void;
  anchorTop?: number | null;
  anchorRight?: number | null;
}) {
  const { t, locale } = useI18n();
  const formatUse = (use: SessionActiveModel["uses"][number]): string => {
    if (use.kind === "main") return t("usage.useMain", { label: use.label });
    if (use.kind === "smart") return t("usage.useSmart", { label: use.label });
    if (use.kind === "subagent") return t("usage.useSubagent", { label: use.label });
    return t("usage.useFallback", { label: use.label });
  };
  // OpenRouter's balance lives in exactly one place: the hero when it is the
  // selected model (there is no percentage to gauge instead), or the "also in
  // use" list when a subagent/fallback spends it behind a different selection.
  const openRouterIsHero = isPrepaidProvider(provider);
  const openRouterUses: SessionActiveModel["uses"] = [];
  for (const active of activeModels) {
    if (isPrepaidProvider(active.provider)) mergeModelUses(openRouterUses, active.uses);
  }
  const openRouterSessionLabel = !openRouterIsHero && openRouterUses.length > 0
    ? t("usage.openRouterInUse", { uses: openRouterUses.map(formatUse).join(", ") })
    : null;
  // Mirrors OpenRouterCredits' own visibility rule (no key -> renders
  // nothing) so the section header's count never promises a row the
  // component itself declines to draw.
  const openRouterVisible = !openRouterIsHero && Boolean(openRouter) && (
    openRouter!.loading
    || (openRouter!.snapshot?.available === true && Boolean(openRouter!.snapshot?.credits))
    || (openRouter!.snapshot?.error != null && openRouter!.snapshot.error.code !== "no_key")
  );
  const alsoInUseCount = quota.inUse.length + (openRouterVisible ? 1 : 0);

  const [resetSelection, setResetSelection] = useState<{ accountId: string; creditId: string; account: string } | null>(null);
  const resetPendingRef = useRef(false);
  const redeemSelectedReset = useCallback(async () => {
    if (!resetSelection || !resetCredits || resetPendingRef.current) return;
    resetPendingRef.current = true;
    try {
      const outcome = await resetCredits.redeem(resetSelection.accountId, resetSelection.creditId);
      if (outcome.outcome === "reset" || outcome.outcome === "already_redeemed") {
        toast.success(t("usage.resetCreditUsed", { account: resetSelection.account }));
      } else if (outcome.outcome === "no_credit" || outcome.outcome === "nothing_to_reset") {
        toast.info(outcome.message ?? t("usage.resetCreditUnavailable"));
      } else {
        toast.error(t("usage.resetCreditFailed"), outcome.message ?? t("usage.resetCreditInconclusive"));
      }
      setResetSelection(null);
      resetCredits.refresh();
    } catch {
      toast.error(t("usage.resetCreditFailed"), t("usage.resetCreditInconclusive"));
    } finally {
      resetPendingRef.current = false;
    }
  }, [resetCredits, resetSelection, t]);

  const resetAccounts = resetCredits?.snapshot?.accounts ?? [];
  const availableResetCount = resetAccounts.reduce((count, account) => count + account.availableCount, 0);
  // The total remains visible even at zero. Per-account rows only earn their
  // space when they can explain a positive balance, an expiry, or a failure.
  const visibleResetAccounts = resetAccounts.filter((account) =>
    (account.availableCount > 0 || Boolean(account.error))
    && (resetAccounts.length > 1 || account.canRedeem || account.credits.length > 0 || Boolean(account.error)),
  );
  // Named exactly like the account list above ("Claude · Primary"), never by
  // the organization/email string omp reports, which the composer must not
  // print and which truncates to nothing useful anyway.
  const resetAccountLabel = (account: ResetCreditAccount): string => {
    if (!account.provider || account.position === undefined) return account.label;
    const siblings = resetAccounts.filter((candidate) => candidate.provider === account.provider).length;
    const brand = brandAccountLabel(account.provider, account.provider);
    return siblings > 1 ? `${brand} · ${accountPositionLabel(account.position)}` : brand;
  };
  // The contextual "Use reset" action on an Accounts row: does THIS account,
  // by provider + position, actually have a redeemable credit?
  const findResetFor = (accountProvider: string, position: number): ResetCreditAccount | null => (
    resetAccounts.find((candidate) => (
      candidate.provider === accountProvider && candidate.position === position
      && candidate.canRedeem && candidate.credits.length > 0
    )) ?? null
  );

  const percentText = quota.known ? t("usage.percentUsed", { percent: Math.round(quota.percent) }) : null;
  const headlineReset = quota.known ? formatResetTime(quota.resetsAt, locale, now) : null;
  const age = quota.known && quota.fetchedAt ? formatRelativeTime(quota.fetchedAt, locale, now) : null;
  // Three different things, and the footer must not conflate them: a read
  // that just landed, a snapshot the server itself flagged as possibly out of
  // date, and a read that FAILED — where the numbers on screen are the last
  // good ones and their age is the age of that read, not of an answer.
  const freshness = refreshing
    ? t("usage.refreshing")
    : failed
      ? (age ? t("usage.refreshFailedAge", { ago: age }) : t("usage.refreshFailed"))
      : age
        ? [t("usage.updatedAgo", { ago: age }), quota.known && quota.stale ? t("usage.stale") : null]
          .filter(Boolean).join(" · ")
        : null;
  // The scope line used to be always-visible footer prose; it still carries
  // real meaning (which window this percentage is scoped to, or why there is
  // no percentage at all) but now lives on the hero's own tooltip.
  const heroTitle = quota.known
    ? (provider ? t("usage.modelScope") : t("usage.accountWide"))
    : [t(quota.scopeKey), quota.reason].filter(Boolean).join(" · ");
  const heroMetaLine = quota.known
    ? [
        formatQuotaLabel(quota.label, locale),
        quota.blocked ? t("usage.blockedTag") : null,
        headlineReset ? t("usage.resetsAt", { time: headlineReset }) : null,
      ].filter(Boolean).join(" · ")
    : t(quota.titleKey);
  const secondaryWindows = quota.known
    ? quota.windows.filter((entry) => entry.label !== quota.label || entry.resetsAt !== quota.resetsAt)
    : [];

  const anchor = anchorTop != null && anchorRight != null ? { top: anchorTop, right: anchorRight } : null;
  const innerMaxHeight = anchor ? `min(70vh, 560px, ${Math.max(0, anchor.top - 14)}px)` : "min(70vh, 560px)";

  return (
    <div
      role="dialog"
      aria-label={t("usage.title")}
      className="dropdown-surface"
      style={anchor ? {
        // Detach to the viewport: a composer control row can be narrower than
        // its visual viewport. Keep the trigger alignment where it fits, then
        // clamp both horizontal edges to the same 8px gutter.
        position: "fixed",
        bottom: (window.visualViewport?.height ?? window.innerHeight) - anchor.top + 6,
        left: `clamp(8px, ${anchor.right - 340}px, calc(100% - 348px))`,
        zIndex: 500,
        width: "min(340px, calc(100vw - 24px))",
      } : {
        position: "absolute",
        right: 0,
        bottom: "calc(100% + 8px)",
        zIndex: 120,
        width: "min(340px, calc(100vw - 24px))",
      }}
    >
      <div style={{ padding: 14, maxHeight: innerMaxHeight, overflowY: "auto" }}>
        {/* HERO — the selected model, its headline number, and the window
            that actually binds it. Everything else is context underneath. */}
        <div title={heroTitle} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ProviderIcon
            provider={quota.known ? quota.provider : provider}
            size={16}
            style={{ flexShrink: 0, color: "var(--text-muted)" }}
          />
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {modelName ?? t("usage.title")}
          </div>
          {percentText && (
            <div style={{ flexShrink: 0, fontSize: 13, fontWeight: 700, color: quota.color, fontVariantNumeric: "tabular-nums" }}>
              {percentText}
            </div>
          )}
        </div>

        {quota.known ? (
          <>
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {heroMetaLine}
            </div>
            <div style={{ marginTop: 6 }}>
              <QuotaBar percent={quota.percent} color={quota.color} height={6} />
            </div>
            {secondaryWindows.length > 0 && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {secondaryWindows.map((entry) => {
                  const resetTime = formatResetTime(entry.resetsAt, locale, now);
                  const metaText = [entry.blocked ? t("usage.blockedTag") : null, resetTime ? t("usage.resetsAt", { time: resetTime }) : null]
                    .filter(Boolean).join(" · ") || null;
                  return (
                    <WindowLine
                      key={entry.key}
                      label={formatQuotaLabel(entry.label, locale)}
                      percent={entry.percent}
                      color={entry.color}
                      metaText={metaText}
                    />
                  );
                })}
              </div>
            )}
            {quota.planType && (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)" }}>
                {t("usage.reportedPlan", { plan: quota.planType })}
              </div>
            )}
          </>
        ) : openRouterIsHero && openRouter ? (
          <OpenRouterCredits account={openRouter} />
        ) : (
          <>
            {quota.noteKey && (
              <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.45, color: "var(--text-muted)" }}>
                {t(quota.noteKey)}
              </div>
            )}
            {quota.reason && (
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)" }}>{quota.reason}</div>
            )}
          </>
        )}

        {/* ACCOUNTS — only when this provider has more than one, since a
            single-account provider has nothing to disambiguate. */}
        {quota.known && quota.accounts.length > 1 && (
          <section style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{t("usage.accountsHeading")}</span>
              {quota.accountsBasis && (
                <Tooltip content={t(ACCOUNT_BASIS_NOTE_KEYS[quota.accountsBasis])}>
                  <button
                    type="button"
                    aria-label={t("usage.accountsInfoLabel")}
                    style={{ display: "inline-flex", alignItems: "center", background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text-dim)" }}
                  >
                    <Info size={11} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
            </div>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 7 }}>
              {quota.accounts.map((account) => (
                <AccountRow
                  key={account.key}
                  account={account}
                  reset={findResetFor(quota.provider, account.position)}
                  now={now}
                  locale={locale}
                  t={t}
                  onUseReset={(reset, label) => setResetSelection({
                    accountId: reset.id, creditId: reset.credits[0]!.id, account: label,
                  })}
                />
              ))}
            </div>
          </section>
        )}

        {/* ALSO IN USE — other concrete models with attributable session
            work, always visible: this is active context, not diagnostics. */}
        {alsoInUseCount > 0 && (
          <section style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
              {t("usage.alsoInUseSummary", { count: alsoInUseCount })}
            </div>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 10 }}>
              {quota.inUse.map((entry) => {
                const resetTime = formatResetTime(entry.resetsAt, locale, now);
                const metaText = [entry.blocked ? t("usage.blockedTag") : null, resetTime ? t("usage.resetsAt", { time: resetTime }) : null]
                  .filter(Boolean).join(" · ") || null;
                return (
                  <WindowLine
                    key={entry.key}
                    icon={<ProviderIcon provider={entry.provider} size={11} style={{ flexShrink: 0, color: "var(--text-dim)" }} />}
                    label={formatQuotaLabel(entry.label, locale)}
                    percent={entry.percent}
                    color={entry.color}
                    metaText={metaText}
                    subText={entry.uses.map(formatUse).join(", ")}
                  />
                );
              })}
              {openRouterVisible && (
                <OpenRouterCredits account={openRouter!} usageLabel={openRouterSessionLabel ?? undefined} />
              )}
            </div>
          </section>
        )}

        {/* DISCLOSURES — rarely needed, collapsed by default: saved resets
            (including ones unrelated to the selected model), and every limit
            that cannot affect this model. */}
        {resetCredits && (
          <DisclosureSection title={t("usage.savedResets", { count: availableResetCount })}>
            <div style={{ fontSize: 11, lineHeight: 1.4, color: "var(--text-dim)", marginBottom: visibleResetAccounts.length > 0 ? 6 : 0 }}>
              {t(availableResetCount === 0 ? "usage.savedResetsEmpty" : "usage.savedResetsNote")}
            </div>
            {resetCredits.loading && !resetCredits.snapshot && (
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("usage.resetCreditChecking")}</div>
            )}
            {visibleResetAccounts.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {visibleResetAccounts.map((account) => (
                  <SavedResetRow
                    key={account.id}
                    account={account}
                    label={resetAccountLabel(account)}
                    now={now}
                    locale={locale}
                    t={t}
                    onUse={() => {
                      const credit = account.credits[0];
                      if (!credit) return;
                      setResetSelection({ accountId: account.id, creditId: credit.id, account: resetAccountLabel(account) });
                    }}
                  />
                ))}
              </div>
            )}
            {resetCredits.snapshot && !resetCredits.snapshot.available && (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>{resetCredits.snapshot.reason ?? t("usage.resetCreditUnavailable")}</div>
            )}
          </DisclosureSection>
        )}

        {quota.others.length > 0 && (
          <DisclosureSection title={t("usage.otherLimitsSummary", { count: quota.others.length })}>
            <div style={{ fontSize: 11, lineHeight: 1.4, color: "var(--text-dim)", marginBottom: 8 }}>
              {t("usage.notForThisModelNote")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {quota.others.map((entry) => {
                const resetTime = formatResetTime(entry.resetsAt, locale, now);
                const metaText = [entry.blocked ? t("usage.blockedTag") : null, resetTime ? t("usage.resetsAt", { time: resetTime }) : null]
                  .filter(Boolean).join(" · ") || null;
                return (
                  <WindowLine
                    key={entry.key}
                    icon={<ProviderIcon provider={entry.provider} size={11} style={{ flexShrink: 0, color: "var(--text-dim)" }} />}
                    label={t("usage.notForThisModelRow", { account: entry.account, window: formatQuotaLabel(entry.label, locale) })}
                    percent={entry.percent}
                    color={entry.exhausted ? "var(--status-error)" : "var(--text-dim)"}
                    metaText={metaText}
                    muted
                  />
                );
              })}
            </div>
          </DisclosureSection>
        )}

        {/* FOOTER — just the reading's age, plus a way to take a new one. */}
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ minWidth: 0, fontSize: 11, color: failed ? "var(--status-warning)" : "var(--text-dim)", fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {freshness ?? ""}
          </span>
          {onRefresh && (
            <button
              type="button"
              data-testid="usage-refresh"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label={t("usage.refresh")}
              title={t("usage.refresh")}
              style={{
                flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 22, height: 22, background: "none", border: "none", borderRadius: 5,
                color: "var(--text-dim)", cursor: refreshing ? "default" : "pointer",
              }}
            >
              <RefreshCw size={12} strokeWidth={1.8} className={refreshing ? "icon-spin" : undefined} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={resetSelection !== null}
        onOpenChange={(open) => { if (!open) setResetSelection(null); }}
        title={t("usage.useOneReset")}
        description={resetSelection ? t("usage.resetCreditConfirm", { account: resetSelection.account }) : null}
        confirmLabel={t("usage.useOneReset")}
        cancelLabel={t("usage.cancelReset")}
        busy={resetCredits?.redeeming}
        onConfirm={() => void redeemSelectedReset()}
      />
    </div>
  );
}
