"use client";

import { Bot, X } from "lucide-react";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { memberName, problemMembers, type Job } from "@/lib/devices/jobs";
import {
  describeRoutine,
  type ActivityBurst,
  type AttentionCountdown,
  type AttentionItem,
  type AttentionProblem,
  type AttentionQuestion,
  type AttentionTransfer,
  type HistoryGroup,
} from "@/lib/devices/activity-groups";
import type { ActivityContext } from "./activity-context";
import { useSecondsUntil } from "./hooks";
import { PhaseIcon, OutcomeIcon, phaseColor } from "./job-icons";
import { HistoryJobRow, LiveJobCard } from "./JobCard";
import { dayText, problemText, titleText, timeText } from "./job-text";
import { Button, Notice, sectionHeadingStyle } from "./ui";

/** Rows of "needs you" shown at once. More are one tap away: the pinned strip must never swallow the panel. */
export const ATTENTION_VISIBLE = 2;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** A command is counting down: what it is about to send, how long is left, and a Cancel that stops it before anything goes out. */
function CountdownRow({ item, ctx }: { item: AttentionCountdown; ctx: ActivityContext }): React.ReactElement {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const seconds = useSecondsUntil(item.releaseAt);
  const binding = item.operation.countdown?.binding;
  return (
    <section className="dv-need dv-need--countdown" aria-label={t("deviceTrust.countdownTitle", { seconds })} data-job={item.job.id}>
      <div className="dv-need__head">
        <PhaseIcon phase="countdown" size={18} />
        <div className="dv-need__text">
          <h4 className="dv-need__title">{t("deviceTrust.countdownTitle", { seconds })}</h4>
          {binding && <p className="dv-need__line"><code>{binding.action} - {binding.target}</code>{ctx.showDevice ? ` · ${ctx.deviceLabel(item.deviceId)}` : ""}</p>}
          <p className="dv-need__line">{t("deviceTrust.countdownBody")}</p>
        </div>
      </div>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      <Button tone="danger" full icon={<X size={16} />} onClick={() => { try { ctx.manager?.cancel(item.operation.id); } catch (caught) { setError(errorText(caught)); } }}>{t("deviceTrust.countdownCancel")}</Button>
    </section>
  );
}

/** Commands are held behind the one question asked in the chat; nothing touches the device until it is answered. */
function QuestionRow({ item, ctx }: { item: AttentionQuestion; ctx: ActivityContext }): React.ReactElement {
  const { t, tn } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const cancelAll = (): void => {
    try {
      for (const id of item.operationIds) ctx.manager?.cancel(id);
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  return (
    <section className="dv-need" aria-label={t("deviceTrust.stateAwaiting")} data-device={item.deviceId}>
      <div className="dv-need__head">
        <PhaseIcon phase="waiting" size={18} />
        <div className="dv-need__text">
          <h4 className="dv-need__title">{t("deviceTrust.stateAwaiting")}</h4>
          <p className="dv-need__line">{t("deviceTrust.awaitingBody")}</p>
          <p className="dv-need__line">{[ctx.showDevice ? ctx.deviceLabel(item.deviceId) : null, tn("devices.attention.waiting", item.waiting)].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      {ctx.manager && <div className="dv-job__actions"><span style={{ flex: 1 }} /><Button tone="quiet" onClick={cancelAll}>{tn("devices.attention.cancelWaiting", item.waiting)}</Button></div>}
    </section>
  );
}

/** A job failed or was stopped. It stays here, above everything, until the person says they have seen it. */
function ProblemRow({ item, ctx }: { item: AttentionProblem; ctx: ActivityContext }): React.ReactElement {
  const { t, tn } = useI18n();
  const { job } = item;
  const title = titleText(job, t, tn);
  const problems = problemMembers(job).map((member) => ({ name: memberName(member), reason: clip(member.error ?? member.result?.summary ?? "", 160) }));
  return (
    <section className="dv-need dv-need--problem" aria-label={title} data-job={job.id} data-phase={job.phase}>
      <div className="dv-need__head">
        <PhaseIcon phase={job.phase} size={18} />
        <div className="dv-need__text">
          <h4 className="dv-need__title">{title}</h4>
          <p className="dv-need__line" style={{ color: phaseColor(job.phase) }}>{t(`devices.jobState.${job.phase}`)}{ctx.showDevice ? ` · ${ctx.deviceLabel(job.deviceId)}` : ""}</p>
          <p className="dv-need__line">{problemText(job, t, problems)}</p>
        </div>
      </div>
      <div className="dv-job__actions">
        <span style={{ flex: 1 }} />
        <Button tone="quiet" ariaLabel={t("devices.jobDetailsLabel", { title })} onClick={() => ctx.openDetails({ kind: "job", jobId: job.id })}>{t("devices.jobDetails")}</Button>
        <Button tone="normal" onClick={() => ctx.acknowledge(item.keys)}>{t("devices.problem.gotIt")}</Button>
      </div>
    </section>
  );
}

/** A zip or a save to the server failed: what the server or the browser said, and the way to the files it was for. */
function TransferRow({ item, ctx }: { item: AttentionTransfer; ctx: ActivityContext }): React.ReactElement {
  const { t } = useI18n();
  const { job } = item;
  const setId = job.setId;
  return (
    <section className="dv-need dv-need--problem" aria-label={job.label} data-transfer={job.id}>
      <div className="dv-need__head">
        <PhaseIcon phase="failed" size={18} />
        <div className="dv-need__text">
          <h4 className="dv-need__title">{t(job.kind === "save" ? "devices.files.saveFailedTitle" : "devices.files.downloadFailedTitle", { label: job.label })}</h4>
          <p className="dv-need__line">{job.error?.message ?? t("devices.files.transferFailed")}</p>
        </div>
      </div>
      <div className="dv-job__actions">
        <span style={{ flex: 1 }} />
        {setId && <Button tone="quiet" onClick={() => ctx.showFiles(setId)}>{t("devices.files.showTheFiles")}</Button>}
        <Button tone="normal" onClick={() => ctx.acknowledge([job.id])}>{t("devices.problem.gotIt")}</Button>
      </div>
    </section>
  );
}

function AttentionRow({ item, ctx }: { item: AttentionItem; ctx: ActivityContext }): React.ReactElement {
  switch (item.kind) {
    case "countdown": return <CountdownRow item={item} ctx={ctx} />;
    case "question": return <QuestionRow item={item} ctx={ctx} />;
    case "problem": return <ProblemRow item={item} ctx={ctx} />;
    case "transfer": return <TransferRow item={item} ctx={ctx} />;
  }
}

function attentionKey(item: AttentionItem): string {
  switch (item.kind) {
    case "countdown": return `countdown-${item.operation.id}`;
    case "question": return `question-${item.deviceId}`;
    case "problem": return `problem-${item.job.id}`;
    case "transfer": return `transfer-${item.job.id}`;
  }
}

/**
 * Everything waiting on the person, pinned above the rest of the panel: a question in the chat, a countdown that can still
 * be cancelled, a failure not yet acknowledged. Nothing else gets this place, so when it is empty there is nothing to do.
 */
export function NeedsYou({ items, ctx }: { items: readonly AttentionItem[]; ctx: ActivityContext }): React.ReactElement | null {
  const { t, tn } = useI18n();
  if (items.length === 0) return null;
  const visible = items.slice(0, ATTENTION_VISIBLE);
  const rest = items.slice(ATTENTION_VISIBLE);
  return (
    <section className="dv-attention" aria-label={t("devices.needsYou")}>
      <h3 style={sectionHeadingStyle}>{t("devices.needsYou")} · {items.length}</h3>
      <p className="sr-only" role="status">{tn("devices.needsYouCount", items.length)}</p>
      {visible.map((item) => <AttentionRow key={attentionKey(item)} item={item} ctx={ctx} />)}
      {rest.length > 0 && (
        <details className="dv-more">
          <summary className="ui-focus-ring">{tn("devices.attention.more", rest.length)}</summary>
          <div className="dv-more__body">{rest.map((item) => <AttentionRow key={attentionKey(item)} item={item} ctx={ctx} />)}</div>
        </details>
      )}
    </section>
  );
}

/** Jobs that are running now, each as one card. Absent when nothing runs, so a quiet panel stays quiet. */
export function LiveJobs({ jobs, ctx }: { jobs: readonly Job[]; ctx: ActivityContext }): React.ReactElement | null {
  const { t } = useI18n();
  if (jobs.length === 0) return null;
  return (
    <section aria-label={t("devices.nowRunning")} className="dv-live">
      <h3 style={sectionHeadingStyle}>{t("devices.nowRunning")}</h3>
      {jobs.map((job) => <LiveJobCard key={job.id} job={job} ctx={ctx} />)}
    </section>
  );
}

/** "3 s · 6 ok · 1 failed": a run is tallied; one command on its own is not ("1 ok" says nothing its icon does not). */
function burstMeta(burst: ActivityBurst, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const seconds = Math.max(1, Math.round((burst.endedAt - burst.startedAt) / 1000));
  const tally = burst.operations.length > 1;
  return [
    t("devices.burstSeconds", { seconds }),
    tally && burst.succeeded > 0 ? t("devices.burstOk", { count: burst.succeeded }) : "",
    burst.failed > 0 ? t("devices.burstFailed", { count: burst.failed }) : "",
    burst.cancelled > 0 ? t("devices.burstCancelled", { count: burst.cancelled }) : "",
  ].filter(Boolean).join(" · ");
}

/** A run of routine agent commands as one line; every command is a row that opens its details. */
export function BurstRow({ burst, ctx, defaultOpen = false }: { burst: ActivityBurst; ctx: ActivityContext; defaultOpen?: boolean }): React.ReactElement {
  const { t, tn, locale } = useI18n();
  const protocol = burst.protocols.join(" + ");
  const count = burst.operations.length;
  const title = count === 1
    ? t("devices.burstOne", { protocol, command: describeRoutine(burst.operations[0]!).title })
    : tn("devices.burstTitle", count, { protocol });
  const problems = burst.failed + burst.cancelled > 0;
  return (
    <details className="dv-row" data-burst={burst.id} open={defaultOpen}>
      <summary className="ui-focus-ring dv-row__summary">
        <Bot size={16} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-muted)" }} />
        <span className="dv-row__text">
          <span className="dv-row__title">{title}</span>
          <span className="dv-row__meta" style={problems ? { color: "var(--status-warning)" } : undefined}>{burstMeta(burst, t)} · {timeText(burst.endedAt, locale)}</span>
        </span>
      </summary>
      <div className="dv-row__body">
        <ul className="dv-items" aria-label={t("devices.items.list")}>
          {burst.operations.map((operation) => {
            const { title: command, outcome } = describeRoutine(operation);
            return (
              <li key={operation.id}>
                <button type="button" className="ui-focus-ring dv-item dv-item--stacked" aria-label={t("devices.commandDetails", { command })} onClick={() => ctx.openDetails({ kind: "operation", operationId: operation.id })}>
                  <OutcomeIcon outcome={operation.state === "succeeded" ? "succeeded" : operation.state === "failed" ? "failed" : "cancelled"} />
                  <span className="dv-item__stack">
                    <code className="dv-item__name">{command}</code>
                    {outcome && <span className="dv-item__sub" style={{ color: operation.state === "succeeded" ? "var(--text-muted)" : "var(--status-error)" }}>{outcome}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}

/**
 * What has already happened, per device that did anything and per day, newest first. Today is open and older days are
 * closed but counted: nothing is cut off, and nothing old is in the way.
 */
export function History({ groups, ctx, timeZone }: { groups: readonly HistoryGroup[]; ctx: ActivityContext; timeZone?: string }): React.ReactElement | null {
  const { t, tn, locale } = useI18n();
  if (groups.length === 0) return null;
  return (
    <section aria-label={t("devices.history")} className="dv-history">
      <h3 style={sectionHeadingStyle}>{t("devices.history")}</h3>
      {groups.map((group) => (
        <div key={group.deviceId} className="dv-history__device" data-device={group.deviceId}>
          {groups.length > 1 && (
            <h4 className="dv-history__name">{ctx.deviceLabel(group.deviceId)}{ctx.connected(group.deviceId) ? "" : ` ${t("devices.disconnectedSuffix")}`}</h4>
          )}
          {group.days.map((day, index) => (
            <details key={day.key} className="dv-day" open={index === 0} data-day={day.key}>
              <summary className="ui-focus-ring">
                <span>{dayText(day, t, locale, timeZone)}</span>
                <span className="dv-day__count">{tn("devices.history.entries", day.entries.length)}</span>
              </summary>
              <div className="dv-day__body">
                {day.entries.map((entry) => (entry.kind === "burst"
                  ? <BurstRow key={`burst-${entry.id}`} burst={entry} ctx={ctx} />
                  : <HistoryJobRow key={`job-${entry.id}`} job={entry} ctx={ctx} />))}
              </div>
            </details>
          ))}
        </div>
      ))}
    </section>
  );
}
