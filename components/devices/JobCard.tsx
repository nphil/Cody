"use client";

import { Ban, ChevronDown, ChevronRight, Files } from "lucide-react";
import { useId, useRef, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useI18n } from "@/lib/i18n";
import { jobProgress, memberOutcome, type Job } from "@/lib/devices/jobs";
import type { ActivityContext } from "./activity-context";
import { JobItems } from "./JobItems";
import { PhaseIcon, phaseColor } from "./job-icons";
import { bytesText, durationText, etaText, itemsText, phaseText, timeText, titleText, unitWord } from "./job-text";
import { Button, Notice, ProgressLine } from "./ui";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A bar that never goes backwards. A multi-step operation restarts its own byte count in each step, so the fraction read
 * off it can dip for a moment; a bar that steps back reads as the work going wrong.
 */
function useNeverBackwards(key: string, value: number | null): number | null {
  const highest = useRef({ key, value: 0 });
  if (highest.current.key !== key) highest.current = { key, value: 0 };
  if (value === null) return null;
  highest.current.value = Math.max(highest.current.value, value);
  return highest.current.value;
}

/** A job that is running: ONE card with its name, how far it has got, what it is on, and the two things a person may want: details, cancel. */
export function LiveJobCard({ job, ctx }: { job: Job; ctx: ActivityContext }): React.ReactElement {
  const { t, tn } = useI18n();
  const itemsId = useId();
  const [itemsOpen, setItemsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = jobProgress(job, { now: ctx.now, plan: ctx.planFor(job) });
  const running = job.members.findLast((member) => memberOutcome(member) === "active");
  // Without a whole to measure against the bar follows the item in flight, which starts again at zero for each item.
  const overall = progress.fraction;
  const bar = useNeverBackwards(overall !== null ? `${job.id}:overall` : `${job.id}:${running?.id ?? ""}`, overall ?? progress.current?.fraction ?? null);
  const title = titleText(job, t, tn);
  const cancelling = running?.state === "cancelling";
  const multi = job.members.length > 1;
  const eta = progress.etaSeconds ?? (multi ? null : progress.current?.etaSeconds ?? null);
  const meta = [
    ctx.showDevice ? ctx.deviceLabel(job.deviceId) : null,
    itemsText(job, progress, tn),
    eta === null ? null : etaText(eta, t, tn),
    job.counts.failed + job.counts.stopped > 0 ? t("devices.jobMeta.failedCount", { count: job.counts.failed + job.counts.stopped }) : null,
  ].filter((part): part is string => part !== null);
  const now = progress.current && (multi || progress.current.name !== job.members[0]?.request.target)
    ? progress.current.fraction === null
      ? t("devices.jobNow", { name: progress.current.name })
      : t("devices.jobNowPercent", { name: progress.current.name, percent: Math.round(progress.current.fraction * 100) })
    : null;
  const stateWord = cancelling ? phaseText(job, t) : null;

  return (
    <article className="dv-job" aria-label={title} data-job={job.id} data-phase={job.phase}>
      <div className="dv-job__head">
        <PhaseIcon phase="running" />
        <div className="dv-job__text">
          <h4 className="dv-job__title">{title}</h4>
          {meta.length > 0 && <p className="dv-job__meta">{meta.join(" · ")}</p>}
        </div>
        {stateWord && <span className="dv-job__state">{stateWord}</span>}
      </div>
      {bar !== null && (
        <div className="dv-job__bar">
          <ProgressLine fraction={bar} label={t("devices.operationProgress", { percent: Math.round(bar * 100) })} />
          <span className="dv-job__percent">{overall !== null && progress.basis === "bytes" ? bytesText(progress, t) : `${Math.round(bar * 100)}%`}</span>
        </div>
      )}
      {now && <p className="dv-job__now">{now}</p>}
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      <div className="dv-job__actions">
        {multi && (
          <Button
            tone="quiet"
            expanded={itemsOpen}
            controls={itemsId}
            icon={itemsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            onClick={() => setItemsOpen((open) => !open)}
          >
            {unitWord(job, t)}
          </Button>
        )}
        <span style={{ flex: 1 }} />
        <Button tone="quiet" ariaLabel={t("devices.jobDetailsLabel", { title })} onClick={() => ctx.openDetails({ kind: "job", jobId: job.id })}>{t("devices.jobDetails")}</Button>
        {running && ctx.manager && (
          <Button
            tone="quiet"
            disabled={cancelling}
            icon={<Ban size={14} />}
            ariaLabel={t("devices.jobCancelLabel", { name: progress.current?.name ?? title })}
            style={{ color: "var(--status-error)" }}
            onClick={() => { try { ctx.manager?.cancel(running.id); } catch (caught) { setError(errorText(caught)); } }}
          >
            {t("devices.jobCancel")}
          </Button>
        )}
      </div>
      {multi && itemsOpen && (
        <div id={itemsId}>
          <JobItems job={job} onOpen={(operationId) => ctx.openDetails({ kind: "job", jobId: job.id, operationId })} />
        </div>
      )}
    </article>
  );
}

/** What the right-hand part of a finished job's line says besides its size and time: nothing for a success, otherwise what went wrong. */
function problemWord(job: Job, t: (key: string, vars?: Record<string, string | number>) => string): { text: string; color: string } | null {
  if (job.phase === "done") return null;
  const count = job.counts.failed + job.counts.stopped;
  if (job.phase === "failed" || job.phase === "stopped") return { text: count > 1 || job.members.length > 1 ? t("devices.jobMeta.failedCount", { count }) : t(`devices.jobState.${job.phase}`), color: phaseColor(job.phase) };
  return { text: t(`devices.jobState.${job.phase}`), color: phaseColor(job.phase) };
}

/**
 * A job that has finished, as one line: what it was, how it ended, how big, how long, when. Opening it lists its items and
 * offers the two next steps (its details, its files). Native disclosure: the browser owns open/closed and the keyboard.
 */
export function HistoryJobRow({ job, ctx, defaultOpen = false }: { job: Job; ctx: ActivityContext; defaultOpen?: boolean }): React.ReactElement {
  const { t, tn } = useI18n();
  const progress = jobProgress(job, { now: ctx.now, plan: ctx.planFor(job) });
  const files = ctx.filesOf(job);
  const title = titleText(job, t, tn);
  const problem = problemWord(job, t);
  const size = files ? formatBytes(files.bytes) : progress.doneBytes > 0 ? formatBytes(progress.doneBytes) : null;
  // History is already grouped under the device's name when several have any, so the row never repeats it.
  const parts = [
    size,
    durationText(job.endedAt - job.startedAt, t),
    timeText(job.endedAt, ctx.locale),
  ].filter((part): part is string => part !== null);
  return (
    <details className="dv-row" data-job={job.id} data-phase={job.phase} open={defaultOpen}>
      <summary className="ui-focus-ring dv-row__summary">
        <PhaseIcon phase={job.phase} />
        <span className="dv-row__text">
          <span className="dv-row__title">{title}</span>
          <span className="dv-row__meta">
            {problem && <span style={{ color: problem.color, fontWeight: 600 }}>{problem.text}</span>}
            {problem && " · "}
            {parts.join(" · ")}
          </span>
        </span>
      </summary>
      <div className="dv-row__body">
        {job.members.length > 1 && <JobItems job={job} onOpen={(operationId) => ctx.openDetails({ kind: "job", jobId: job.id, operationId })} />}
        <div className="dv-job__actions">
          <Button tone="quiet" ariaLabel={t("devices.jobDetailsLabel", { title })} onClick={() => ctx.openDetails({ kind: "job", jobId: job.id })}>{t("devices.jobDetails")}</Button>
          {files && <Button tone="quiet" icon={<Files size={14} />} onClick={() => ctx.showFiles(files.setId)}>{tn("devices.jobFiles", files.count)}</Button>}
        </div>
      </div>
    </details>
  );
}
