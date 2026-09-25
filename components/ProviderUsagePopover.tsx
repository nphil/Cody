"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ChevronDown, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { QuotaBar, clampQuotaPercent, usageToneColor } from "@/components/QuotaBar";
import { useUsage } from "@/hooks/useUsage";
import { useI18n } from "@/lib/i18n";
import { providerBrand } from "@/lib/provider-brand";
import { selectBindingWindow } from "@/lib/usage/select";
import type { UsageAccount, UsageWindow } from "@/lib/usage/types";

export interface ProviderUsageAccountRow {
  account: UsageAccount;
  title: string;
  windows: UsageWindow[];
  moreWindows: UsageWindow[];
}

export interface ProviderUsageGroup {
  provider: string;
  title: string;
  accounts: ProviderUsageAccountRow[];
}

function providerTitle(provider: string): string {
  return providerBrand(provider)?.name ?? provider
    .trim()
    .split(/[-_]/g)
    .map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : "")
    .filter(Boolean)
    .join(" ");
}

function accountPosition(index: number): string {
  if (index === 0) return "Primary";
  if (index === 1) return "Secondary";
  return `Account ${index + 1}`;
}

export function providerUsageAccountTitle(account: UsageAccount, index: number, count: number): string {
  const customName = account.customName?.trim();
  if (customName) return customName;
  if (count > 1) return accountPosition(index);
  return account.identity?.trim() || account.label.trim() || "Account 1";
}

function compareWindows(a: UsageWindow, b: UsageWindow): number {
  const severity = (state: UsageWindow["state"]) => state === "exhausted" ? 2 : state === "warning" ? 1 : 0;
  const severityDiff = severity(b.state) - severity(a.state);
  if (severityDiff) return severityDiff;
  const utilizationDiff = clampQuotaPercent(b.utilization) - clampQuotaPercent(a.utilization);
  if (utilizationDiff) return utilizationDiff;
  const spanA = a.windowMs ?? Number.POSITIVE_INFINITY;
  const spanB = b.windowMs ?? Number.POSITIVE_INFINITY;
  if (spanA !== spanB) return spanA - spanB;
  const resetA = a.resetsAt ? Date.parse(a.resetsAt) : Number.POSITIVE_INFINITY;
  const resetB = b.resetsAt ? Date.parse(b.resetsAt) : Number.POSITIVE_INFINITY;
  return resetA - resetB;
}

/** The shared binding-window selector chooses the first row. The next most
 * constrained window is shown beside it; remaining provider tiers stay
 * available in an inline disclosure so the popover remains compact. */
export function selectProviderUsageWindows(account: UsageAccount): { windows: UsageWindow[]; moreWindows: UsageWindow[] } {
  const binding = selectBindingWindow([account])?.window;
  if (!binding) return { windows: [], moreWindows: [] };
  const rest = [...(account.windows ?? [])]
    .filter((window) => window.id !== binding.id)
    .sort(compareWindows);
  return { windows: [binding, ...rest.slice(0, 1)], moreWindows: rest.slice(1) };
}

/** Groups every reportable account, ordered the same way as Cody's provider
 * settings. Disabled credentials and accounts with neither windows nor an
 * unlimited plan do not claim quota data. */
export function buildProviderUsageGroups(accounts: readonly UsageAccount[]): ProviderUsageGroup[] {
  const order: string[] = [];
  const byProvider = new Map<string, UsageAccount[]>();
  for (const raw of accounts ?? []) {
    const account = raw;
    if (!account || account.disabled || (!account.unlimited && account.windows.length === 0)) continue;
    const list = byProvider.get(account.provider);
    if (list) list.push(account);
    else {
      byProvider.set(account.provider, [account]);
      order.push(account.provider);
    }
  }

  return order.map((provider) => {
    const sorted = [...byProvider.get(provider)!].sort((a, b) => {
      const idA = a.credentialId ?? Number.MAX_SAFE_INTEGER;
      const idB = b.credentialId ?? Number.MAX_SAFE_INTEGER;
      return idA - idB || a.id.localeCompare(b.id);
    });
    return {
      provider,
      title: providerTitle(provider),
      accounts: sorted.map((account, index) => ({
        account,
        title: providerUsageAccountTitle(account, index, sorted.length),
        ...selectProviderUsageWindows(account),
      })),
    };
  });
}

function formatUpdatedAge(iso: string, now: number, locale: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = seconds < 60
    ? [seconds, "second"]
    : seconds < 3_600
      ? [Math.floor(seconds / 60), "minute"]
      : seconds < 86_400
        ? [Math.floor(seconds / 3_600), "hour"]
        : [Math.floor(seconds / 86_400), "day"];
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-value, unit);
}

function formatResetTime(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { weekday: "short" as const, month: "short" as const, day: "numeric" as const }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function QuotaWindow({ window, locale, t }: {
  window: UsageWindow;
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const percent = clampQuotaPercent(window.utilization);
  const blocked = window.source === "block";
  const resetTime = formatResetTime(window.resetsAt, locale);
  return (
    <div className="provider-usage-window">
      <div className="provider-usage-window-heading">
        <span className="provider-usage-window-label" title={window.label}>{window.label}</span>
        <span className="provider-usage-window-percent" style={{ color: usageToneColor(percent, window.state) }}>
          {blocked ? t("appShell.providerUsageBlockedLabel") : `${Math.round(percent)}%`}
        </span>
      </div>
      {!blocked && <QuotaBar percent={percent} color={usageToneColor(percent, window.state)} />}
      {blocked && (
        <span className="provider-usage-reset">{t("appShell.providerUsageBlocked")}</span>
      )}
      {resetTime && (
        <time className="provider-usage-reset" dateTime={window.resetsAt ?? undefined}>
          {t("usage.resetsAt", { time: resetTime })}
        </time>
      )}
    </div>
  );
}

export function ProviderUsagePopover({ onOpenProviders }: { onOpenProviders: () => void }) {
  // This component is mounted only while the top-bar popover is open, so the
  // usage endpoint is never queried just because Cody's shell rendered.
  const usage = useUsage(true);
  const { locale, t } = useI18n();
  const panelRef = useRef<HTMLElement>(null);
  const [clock, setClock] = useState(() => Date.now());
  const groups = useMemo(() => buildProviderUsageGroups(usage.snapshot?.accounts ?? []), [usage.snapshot]);
  const unavailableProviders = (usage.snapshot?.unavailableProviders ?? []).filter(
    (item) => !groups.some((group) => group.provider === item.provider),
  );

  useEffect(() => {
    panelRef.current?.focus();
    // Kept separate from the usage polling cadence; the displayed timestamp
    // ages naturally without issuing more network requests.
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section ref={panelRef} tabIndex={-1} className="provider-usage-popover" role="dialog" aria-modal="false" aria-labelledby="provider-usage-title">
      <header className="provider-usage-header">
        <div className="provider-usage-heading">
          <Activity size={15} aria-hidden="true" />
          <h2 id="provider-usage-title">{t("usage.title")}</h2>
        </div>
        <div className="provider-usage-header-actions">
          {usage.snapshot?.fetchedAt && (
            <time className="provider-usage-updated" dateTime={usage.snapshot.fetchedAt}>
              {t("usage.updatedAgo", { ago: formatUpdatedAge(usage.snapshot.fetchedAt, clock, locale) })}
            </time>
          )}
          <button
            type="button"
            className="provider-usage-icon-button ui-focus-ring"
            onClick={usage.refresh}
            disabled={usage.loading}
            aria-label={t("usage.refresh")}
            title={t("usage.refresh")}
          >
            <RefreshCw size={14} aria-hidden="true" className={usage.loading ? "icon-spin" : undefined} />
          </button>
        </div>
      </header>

      {usage.snapshot?.stale && <p className="provider-usage-note">{t("usage.stale")}</p>}
      {usage.failed && usage.snapshot && <p className="provider-usage-error" role="status">{t("usage.unavailableNote")}</p>}

      <div className="provider-usage-content" aria-live="polite">
        {usage.loading && !usage.snapshot && (
          <p className="provider-usage-state"><Loader2 size={14} className="icon-spin" aria-hidden="true" />{t("usage.checking")}</p>
        )}
        {!usage.loading && !usage.snapshot && usage.failed && (
          <p className="provider-usage-error" role="alert">{t("usage.unavailableNote")}</p>
        )}
        {usage.snapshot && !usage.snapshot.available && (
          <p className="provider-usage-state">{t("usage.unavailableNote")}</p>
        )}
        {usage.snapshot?.available && groups.length === 0 && unavailableProviders.length === 0 && (
          <p className="provider-usage-state">{t("usage.noQuotaSignal")}</p>
        )}

        {groups.map((group) => (
          <section className="provider-usage-group" key={group.provider} aria-label={group.title}>
            <h3>{group.title}</h3>
            {group.accounts.map(({ account, title, windows, moreWindows }) => {
              return (
                <article className="provider-usage-account" key={account.id}>
                  <div className="provider-usage-account-heading">
                    <div className="provider-usage-account-name">
                      <strong title={title}>{title}</strong>
                    </div>
                  </div>
                  {account.identity && account.identity !== title && (
                    <div className="provider-usage-account-identity" title={account.identity}>{account.identity}</div>
                  )}
                  {account.unlimited ? (
                    <div className="provider-usage-unlimited">{t("usage.unlimited")}</div>
                  ) : (
                    <div className="provider-usage-windows">
                      {windows.map((window) => <QuotaWindow key={window.id} window={window} locale={locale} t={t} />)}
                      {moreWindows.length > 0 && (
                        <details className="provider-usage-more-windows">
                          <summary>
                            <ChevronDown size={12} aria-hidden="true" />
                            {t("appShell.providerUsageMoreWindows", { count: moreWindows.length })}
                          </summary>
                          <div className="provider-usage-more-window-list">
                            {moreWindows.map((window) => <QuotaWindow key={window.id} window={window} locale={locale} t={t} />)}
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        ))}

        {unavailableProviders.map((item) => (
          <p className="provider-usage-unavailable" key={item.provider} role="status">
            {t("appShell.providerUsageUnavailableProvider", { provider: providerTitle(item.provider) })}
          </p>
        ))}
      </div>

      <footer className="provider-usage-footer">
        <button type="button" className="provider-usage-action-button provider-usage-settings" onClick={onOpenProviders}>
          <Settings2 size={13} aria-hidden="true" />{t("appShell.providerUsageSettings")}
        </button>
      </footer>
    </section>
  );
}
