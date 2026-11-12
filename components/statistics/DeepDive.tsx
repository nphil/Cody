"use client";

import { MessageSquare, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ModelIcon } from "@/components/ProviderIcon";
import { useI18n } from "@/lib/i18n";
import { formatApiError, type ApiErrorPayload } from "@/lib/i18n/api-error";
import { billingKind } from "@/lib/statistics/billing";
import { formatCount, formatMoment, formatShare, formatTokens, shareOf, workerLabel } from "@/lib/statistics/present";
import type { Metric } from "@/lib/statistics/sunburst";
import { WORKER_ADVISOR, WORKER_SUBAGENT, WORKER_SUBAGENT_PREFIX, type DeepDiveResponse, type DeepDiveSubagent, type DeepDiveTurn, type DeepDiveWorker, type PeriodInfo } from "@/lib/statistics/types";
import { CostText, DASH } from "./parts";

export interface DeepDiveProps {
  /** The chat's id (`StatNode.chat`). */
  chat: string;
  /** The page's period, sent along so the dive can also say what the chat did inside it. */
  period: PeriodInfo;
  /** The zone days are bucketed in, so a turn is dated on the day it was counted under. */
  zone: string;
  /** Which of cost and tokens leads in every list. */
  metric: Metric;
  /** When the index last finished a pass; a new value asks again. */
  refreshKey: number | null;
}

/** What went wrong with the last request for a chat. Status 0 means the request never got an answer. */
interface Failure {
  chat: string;
  status: number;
  payload: ApiErrorPayload | null;
}

const TURNS_SHOWN = 10;
const SUBAGENTS_SHOWN = 12;

/** The token counters of a turn, in the order the prompts are read: what was sent, what came back, what the cache served. */
const SPLIT = [
  ["input", "statistics.tokens.input"],
  ["output", "statistics.tokens.output"],
  ["cacheRead", "statistics.tokens.cacheRead"],
  ["cacheWrite", "statistics.tokens.cacheWrite"],
] as const;

const SKELETON_ROWS: readonly number[] = [72, 58, 64];

const CSS = `
.stats-dive { display: flex; flex-direction: column; gap: 20px; min-width: 0; font-variant-numeric: tabular-nums; transition: opacity var(--dur-med) var(--ease-out-warm); }
.stats-dive[data-busy="true"] { opacity: 0.6; }
.stats-dive-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 16px; }
.stats-dive-titles { flex: 1 1 220px; min-width: 0; }
.stats-dive-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.stats-dive-sub { margin: 0; font-size: 12px; line-height: 18px; color: var(--text-muted); overflow-wrap: anywhere; }
.stats-dive-open,
.stats-dive-retry {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out-warm);
}
.stats-dive-open:hover,
.stats-dive-retry:hover { background: var(--bg-hover); }
.stats-dive-retry:disabled { cursor: default; opacity: 0.6; }
.stats-dive-totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px 24px; margin: 0; }
.stats-dive-totals dt { margin: 0; font-size: 12px; line-height: 18px; color: var(--text-muted); }
.stats-dive-totals dd { margin: 0; }
.stats-dive-totals .stats-dive-figures { align-items: flex-start; text-align: left; }
.stats-dive-totals .stats-dive-lead { font-size: 20px; line-height: 28px; font-weight: 600; }
.stats-dive-note { margin: -8px 0 0; font-size: 12px; line-height: 18px; color: var(--text-muted); }
.stats-dive-section { min-width: 0; }
.stats-dive-h { margin: 0 0 4px; font-size: 14px; line-height: 20px; font-weight: 600; color: var(--text); }
.stats-dive-list { margin: 0; padding: 0; list-style: none; }
.stats-dive-row { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-top: 1px solid var(--border); }
.stats-dive-row:first-child { border-top: 0; }
.stats-dive-main { flex: 1 1 auto; min-width: 0; }
.stats-dive-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; line-height: 20px; color: var(--text); }
.stats-dive-name svg { flex: none; }
.stats-dive-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats-dive-meta { font-size: 12px; line-height: 18px; color: var(--text-muted); overflow-wrap: anywhere; }
.stats-dive-split { display: flex; flex-wrap: wrap; gap: 0 12px; }
.stats-dive-figures { display: flex; flex: none; flex-direction: column; align-items: flex-end; text-align: right; }
.stats-dive-lead { font-size: 14px; line-height: 20px; font-weight: 600; color: var(--text); }
.stats-dive-aside { font-size: 12px; line-height: 18px; color: var(--text-muted); }
.stats-dive-bar { height: 4px; margin: 4px 0; border-radius: 2px; background: color-mix(in srgb, var(--text-muted) 18%, transparent); }
.stats-dive-bar > span { display: block; height: 100%; border-radius: inherit; background: color-mix(in srgb, var(--accent) 70%, transparent); }
.stats-dive-more { margin: 4px 0 0; font-size: 12px; line-height: 18px; color: var(--text-muted); }
.stats-dive-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: 13px; line-height: 20px; color: var(--text); }
.stats-dive-error p { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.stats-dive-sk { display: block; border-radius: 6px; }
.stats-dive-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
@media (pointer: coarse) {
  .stats-dive-open, .stats-dive-retry { min-height: 44px; }
}
`;

/** The answer is ours, but a proxy or an old server can still hand back something else, and a list on a missing array would take the page down. */
function isDeepDive(value: unknown): value is DeepDiveResponse {
  if (typeof value !== "object" || value === null) return false;
  const dive = value as Partial<DeepDiveResponse>;
  return (
    typeof dive.chat === "string" &&
    typeof dive.lifetime === "object" &&
    dive.lifetime !== null &&
    Array.isArray(dive.topTurns) &&
    Array.isArray(dive.workers) &&
    Array.isArray(dive.subagents)
  );
}

interface PairProps {
  metric: Metric;
  cost: number;
  tokens: number;
  /** Tokens that ran on a model with no known price. */
  unpriced: number;
}

/** A cost and a token count, the one the page is sorted by first and larger. */
function Pair({ metric, cost, tokens, unpriced }: PairProps) {
  const { locale, tn } = useI18n();
  const money = <CostText node={{ cost, tokens, unpricedTokens: unpriced }} />;
  const count =
    tokens > 0 ? <span title={formatCount(tokens, locale)}>{tn("statistics.dive.tokensCount", tokens, { tokens: formatTokens(tokens, locale) })}</span> : DASH;
  return (
    <div className="stats-dive-figures">
      <span className="stats-dive-lead">{metric === "cost" ? money : count}</span>
      <span className="stats-dive-aside">{metric === "cost" ? count : money}</span>
    </div>
  );
}

function TurnRow({ turn, metric, zone }: { turn: DeepDiveTurn; metric: Metric; zone: string }) {
  const { locale, t } = useI18n();
  const tokens = turn.input + turn.output + turn.cacheRead + turn.cacheWrite;
  // A turn is one priced message: with no cost it is either on the user's own machine or on a model nobody has a price for.
  const unpriced = turn.cost > 0 || billingKind(turn.provider) === "local" ? 0 : tokens;
  return (
    <li className="stats-dive-row">
      <div className="stats-dive-main">
        <div className="stats-dive-name">
          <ModelIcon provider={turn.provider} modelId={turn.model} size={16} />
          <span className="stats-dive-ellipsis" title={turn.model}>
            {turn.model}
          </span>
        </div>
        <div className="stats-dive-meta">
          {formatMoment(turn.ts, locale, zone)} · {workerLabel(turn.worker, t)}
        </div>
        <div className="stats-dive-meta stats-dive-split">
          {SPLIT.map(([field, label]) => turn[field] > 0 && <span key={field}>{`${t(label)} ${formatTokens(turn[field], locale)}`}</span>)}
        </div>
      </div>
      <Pair metric={metric} cost={turn.cost} tokens={tokens} unpriced={unpriced} />
    </li>
  );
}

function WorkerRow({ worker, sum, metric }: { worker: DeepDiveWorker; sum: number; metric: Metric }) {
  const { locale, t, tn } = useI18n();
  const value = metric === "cost" ? worker.cost : worker.tokens;
  const share = shareOf(value, sum);
  return (
    <li className="stats-dive-row">
      <div className="stats-dive-main">
        <div className="stats-dive-name">
          <span className="stats-dive-ellipsis">{workerLabel(worker.worker, t)}</span>
        </div>
        <div className="stats-dive-bar" aria-hidden="true">
          <span style={{ width: `${Math.min(100, share * 100)}%` }} />
        </div>
        <div className="stats-dive-meta">
          {value > 0 && `${formatShare(share, locale)} · `}
          {tn("statistics.messages", worker.messages)}
        </div>
      </div>
      <Pair metric={metric} cost={worker.cost} tokens={worker.tokens} unpriced={worker.unpricedTokens} />
    </li>
  );
}

function SubagentRow({ subagent, metric, zone }: { subagent: DeepDiveSubagent; metric: Metric; zone: string }) {
  const { locale, t, tn } = useI18n();
  const id = subagent.kind === "advisor" ? WORKER_ADVISOR : subagent.agent !== "" ? `${WORKER_SUBAGENT_PREFIX}${subagent.agent}` : WORKER_SUBAGENT;
  const models = subagent.models.join(", ");
  const span =
    subagent.first <= 0
      ? null
      : subagent.last > subagent.first
        ? `${formatMoment(subagent.first, locale, zone)} \u2013 ${formatMoment(subagent.last, locale, zone)}`
        : formatMoment(subagent.first, locale, zone);
  return (
    <li className="stats-dive-row">
      <div className="stats-dive-main">
        <div className="stats-dive-name">
          <span className="stats-dive-ellipsis">{workerLabel(id, t)}</span>
        </div>
        {models !== "" && (
          <div className="stats-dive-meta" title={models}>
            {models}
          </div>
        )}
        <div className="stats-dive-meta">
          {tn("statistics.messages", subagent.messages)}
          {span !== null && ` · ${span}`}
        </div>
      </div>
      <Pair metric={metric} cost={subagent.cost} tokens={subagent.tokens} unpriced={subagent.unpricedTokens} />
    </li>
  );
}

/** The one chat's usage: what it cost, which turns cost the most, what did the work and which subagents ran. Fetches its own answer and keeps the last one on screen while a newer one loads. */
export function DeepDive({ chat, period, zone, metric, refreshKey }: DeepDiveProps) {
  const { t, tn } = useI18n();
  const [data, setData] = useState<DeepDiveResponse | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(true);
  // Bumped by the Retry button to ask again for the same chat and period.
  const [nudge, setNudge] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    const params = new URLSearchParams({ session: chat, from: period.from, to: period.to });
    fetch(`/api/statistics?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (response.ok && isDeepDive(payload)) {
          setData(payload);
          setFailure(null);
          return;
        }
        const body = typeof payload === "object" && payload !== null ? (payload as ApiErrorPayload) : null;
        setFailure({ chat, status: response.status, payload: body });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailure({ chat, status: 0, payload: null });
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [chat, period.from, period.to, refreshKey, nudge]);

  // What is on screen may belong to the chat that was open a moment ago; it never shows under another chat's name.
  const current = data !== null && data.chat === chat ? data : null;
  const failed = failure !== null && failure.chat === chat ? failure : null;

  const error =
    failed === null ? null : (
      <div className="stats-dive-error" role="alert">
        <p>{failed.status === 404 ? t("statistics.dive.notFound") : formatApiError(failed.payload, "statistics.dive.failed")}</p>
        {failed.status !== 404 && (
          <button type="button" className="stats-dive-retry ui-focus-ring" disabled={busy} onClick={() => setNudge((count) => count + 1)}>
            <RefreshCw size={14} className={busy ? "icon-spin" : undefined} aria-hidden="true" />
            {t("statistics.dive.retry")}
          </button>
        )}
      </div>
    );

  if (current === null) {
    return (
      <section className="stats-dive" aria-busy={failed === null} aria-label={t("statistics.dive.label")}>
        <style>{CSS}</style>
        {error ?? (
          <>
            <span className="stats-dive-sr" role="status">
              {t("statistics.dive.loading")}
            </span>
            <div aria-hidden="true">
              <span className="skeleton stats-dive-sk" style={{ width: 180, height: 20, margin: "2px 0 8px" }} />
              {SKELETON_ROWS.map((width) => (
                <span key={width} className="skeleton stats-dive-sk" style={{ width: `${width}%`, height: 14, margin: "14px 0" }} />
              ))}
            </div>
          </>
        )}
      </section>
    );
  }

  const workers = [...current.workers].sort((a, b) => (metric === "cost" ? b.cost - a.cost : b.tokens - a.tokens));
  const workersSum = workers.reduce((sum, worker) => sum + (metric === "cost" ? worker.cost : worker.tokens), 0);
  const subagents = [...current.subagents].sort((a, b) => (metric === "cost" ? b.cost - a.cost : b.tokens - a.tokens));
  const hidden = subagents.length - SUBAGENTS_SHOWN;

  return (
    <section className="stats-dive" aria-label={t("statistics.dive.label")} aria-busy={busy} data-busy={busy ? "true" : undefined}>
      <style>{CSS}</style>
      {error}
      <div className="stats-dive-head">
        <div className="stats-dive-titles">
          <h3 className="stats-dive-title">{current.title || t("statistics.untitledChat")}</h3>
          {current.project !== "" && (
            <p className="stats-dive-sub" title={current.cwd || undefined}>
              {current.project}
            </p>
          )}
        </div>
        {current.openable && (
          <Link href={`/?session=${encodeURIComponent(chat)}`} className="stats-dive-open ui-focus-ring">
            <MessageSquare size={16} aria-hidden="true" />
            {t("statistics.dive.open")}
          </Link>
        )}
      </div>

      <dl className="stats-dive-totals">
        <div>
          <dt>{t("statistics.dive.lifetime")}</dt>
          <dd>
            <Pair metric={metric} cost={current.lifetime.cost} tokens={current.lifetime.tokens} unpriced={current.lifetime.unpricedTokens} />
          </dd>
        </div>
        {current.inPeriod !== null && (
          <div>
            <dt>{t("statistics.dive.inPeriod")}</dt>
            <dd>
              <Pair metric={metric} cost={current.inPeriod.cost} tokens={current.inPeriod.tokens} unpriced={current.inPeriod.unpricedTokens} />
            </dd>
          </div>
        )}
      </dl>
      <p className="stats-dive-note">{t("statistics.dive.estimateNote")}</p>

      {current.topTurns.length > 0 && (
        <section className="stats-dive-section">
          <h4 className="stats-dive-h">{t("statistics.dive.turns")}</h4>
          <ul className="stats-dive-list">
            {current.topTurns.slice(0, TURNS_SHOWN).map((turn, index) => (
              <TurnRow key={`${turn.ts}:${turn.model}:${index}`} turn={turn} metric={metric} zone={zone} />
            ))}
          </ul>
        </section>
      )}

      {workers.length > 0 && (
        <section className="stats-dive-section">
          <h4 className="stats-dive-h">{t("statistics.dive.workers")}</h4>
          <ul className="stats-dive-list">
            {workers.map((worker) => (
              <WorkerRow key={worker.worker} worker={worker} sum={workersSum} metric={metric} />
            ))}
          </ul>
        </section>
      )}

      {subagents.length > 0 && (
        <section className="stats-dive-section">
          <h4 className="stats-dive-h">{t("statistics.dive.subagents")}</h4>
          <ul className="stats-dive-list">
            {subagents.slice(0, SUBAGENTS_SHOWN).map((subagent) => (
              <SubagentRow key={subagent.name} subagent={subagent} metric={metric} zone={zone} />
            ))}
          </ul>
          {hidden > 0 && <p className="stats-dive-more">{tn("statistics.dive.more", hidden)}</p>}
        </section>
      )}
    </section>
  );
}
