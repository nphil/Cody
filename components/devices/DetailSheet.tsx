"use client";

import { ArrowLeft, Files, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useI18n } from "@/lib/i18n";
import { jobProgress, memberName, problemMembers, type Job } from "@/lib/devices/jobs";
import { describeRoutine } from "@/lib/devices/activity-groups";
import { groupArtifactSets, shortArtifactName } from "@/lib/devices/artifact-sets";
import type { ArtifactSet, DeviceArtifact } from "@/lib/devices/artifacts";
import type { DeviceOperationSnapshot } from "@/lib/devices/operations";
import type { ActivityContext, DetailSubject } from "./activity-context";
import { CopyButton } from "./CopyButton";
import { JobItems } from "./JobItems";
import { PhaseIcon } from "./job-icons";
import { bytesText, durationText, etaText, itemsText, phaseText, problemText, titleText, whenText } from "./job-text";
import { OperationDetail } from "./OperationDetail";
import { setDeviceName, setTitle } from "./set-text";
import { Button, Notice, sectionHeadingStyle } from "./ui";

export interface DetailSheetProps {
  subject: DetailSubject;
  jobs: ReadonlyMap<string, Job>;
  operations: readonly DeviceOperationSnapshot[];
  artifacts: readonly DeviceArtifact[];
  ctx: ActivityContext;
  onSubject: (subject: DetailSubject) => void;
  onClose: () => void;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <dt style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</dt>
      <dd style={{ margin: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text)", overflowWrap: "anywhere" }}>{children}</dd>
    </div>
  );
}

/** One file: what it is, which backup it is part of, where it came from, and the numbers that identify it. */
function FileDetail({ artifact, set, ctx, jobOf, onSubject }: { artifact: DeviceArtifact; set: ArtifactSet | undefined; ctx: ActivityContext; jobOf: (operationId: string) => Job | undefined; onSubject: (subject: DetailSubject) => void }): React.ReactElement {
  const { t, tn, locale } = useI18n();
  const origin = artifact.provenance;
  const job = origin ? jobOf(origin.operationId) : undefined;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <section aria-label={t("devices.sheet.technical")} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <h4 style={sectionHeadingStyle}>{t("devices.sheet.technical")}</h4>
        <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <Fact label={t("devices.fact.fileName")}><code>{artifact.name}</code></Fact>
          <Fact label={t("devices.fact.size")}>{formatBytes(artifact.size)}</Fact>
          <Fact label={t("devices.fact.kind")}>{artifact.kind === "input" ? t("devices.artifactInput") : t("devices.artifactOutput")}</Fact>
          <Fact label={t("devices.fact.added")}>{whenText(artifact.createdAt, locale)}</Fact>
          <Fact label={t("devices.operationResultHash")}><code>{artifact.sha256}</code><CopyButton text={artifact.sha256} label={t("devices.sheet.copy")} ariaLabel={t("devices.sheet.copyNamed", { what: t("devices.operationResultHash") })} /></Fact>
          <Fact label={t("devices.fact.fileId")}><code>{artifact.id}</code><CopyButton text={artifact.id} label={t("devices.sheet.copy")} ariaLabel={t("devices.sheet.copyNamed", { what: t("devices.fact.fileId") })} /></Fact>
          {origin && <Fact label={t("devices.fact.device")}>{origin.label ?? ctx.deviceLabel(origin.deviceId)}</Fact>}
          {set && <Fact label={t("devices.fact.backup")}>{setTitle(set, setDeviceName(set, ctx.deviceLabel, t), t, tn)}</Fact>}
          {origin && <Fact label={t("devices.fact.operation")}>{origin.protocol} · {origin.action}{origin.target ? ` · ${origin.target}` : ""}</Fact>}
          {origin && <Fact label={t("devices.fact.operationId")}><code>{origin.operationId}</code></Fact>}
          {artifact.server && <Fact label={t("devices.fact.onServer")}><code>{artifact.server.archive}</code>{artifact.server.verified ? ` · ${t("devices.files.verifiedOnServer")}` : ""}</Fact>}
          {artifact.server && <Fact label={t("devices.fact.inArchive")}><code>{artifact.server.entry}</code></Fact>}
        </dl>
      </section>
      {job && <div><Button onClick={() => onSubject({ kind: "job", jobId: job.id, operationId: origin?.operationId })}>{t("devices.fact.showJob")}</Button></div>}
    </div>
  );
}

/** Several operations in one job: its state, how far it got, and every item as a row that opens that item. */
function JobOverview({ job, ctx, onSubject, onClose }: { job: Job; ctx: ActivityContext; onSubject: (subject: DetailSubject) => void; onClose: () => void }): React.ReactElement {
  const { t, tn, locale } = useI18n();
  const progress = jobProgress(job, { now: ctx.now, plan: ctx.planFor(job) });
  const files = ctx.filesOf(job);
  const problems = problemMembers(job).map((member) => ({ name: memberName(member), reason: member.error ?? member.result?.summary ?? "" }));
  const meta = [
    itemsText(job, progress, tn),
    bytesText(progress, t),
    progress.etaSeconds === null ? null : etaText(progress.etaSeconds, t, tn),
    t("devices.sheet.took", { time: durationText(job.endedAt - job.startedAt, t) }),
  ].filter((part): part is string => part !== null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 13 }}>
        <PhaseIcon phase={job.phase} size={16} />
        <strong style={{ color: "var(--text)" }}>{phaseText(job, t)}</strong>
        <span style={{ color: "var(--text-muted)" }}>{whenText(job.startedAt, locale)}</span>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{meta.join(" · ")}</p>
      {problems.length > 0 && <Notice tone={job.phase === "stopped" ? "warning" : "error"} role="alert">{problemText(job, t, problems)}</Notice>}
      {files && (
        <div>
          <Button icon={<Files size={16} />} onClick={() => { ctx.showFiles(files.setId); onClose(); }}>{tn("devices.jobFiles", files.count)}</Button>
        </div>
      )}
      <section aria-label={t("devices.items.list")} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <h4 style={sectionHeadingStyle}>{tn("devices.jobItems", job.members.length)}</h4>
        <JobItems job={job} onOpen={(operationId) => onSubject({ kind: "job", jobId: job.id, operationId })} />
      </section>
    </div>
  );
}

/**
 * The detail drawer: the one place raw output lives (a log, a hash, a JSON result), reached from a job, a command or a
 * file and never written out in the feed. It covers the Devices panel only, so the chat beside it stays usable; behind it
 * the panel is inert, Escape or the close button ends it, and focus goes back to whatever opened it.
 */
export function DetailSheet({ subject, jobs, operations, artifacts, ctx, onSubject, onClose }: DetailSheetProps): React.ReactElement {
  const { t, tn } = useI18n();
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const jobOf = (operationId: string): Job | undefined => [...jobs.values()].find((job) => job.members.some((member) => member.id === operationId));

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.current?.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  let title = "";
  let body: React.ReactNode = null;
  let back: { label: string; to: DetailSubject } | null = null;

  if (subject.kind === "job") {
    const job = jobs.get(subject.jobId);
    if (job) {
      title = titleText(job, t, tn);
      const member = subject.operationId ? job.members.find((candidate) => candidate.id === subject.operationId) : job.members.length === 1 ? job.members[0] : undefined;
      if (member) {
        if (job.members.length > 1) {
          title = memberName(member);
          back = { label: t("devices.sheet.allItems", { count: job.members.length }), to: { kind: "job", jobId: job.id } };
        }
        body = <OperationDetail manager={ctx.manager} operation={member} deviceLabel={ctx.deviceLabel(member.request.deviceId)} />;
      } else {
        body = <JobOverview job={job} ctx={ctx} onSubject={onSubject} onClose={onClose} />;
      }
    }
  } else if (subject.kind === "operation") {
    const operation = operations.find((candidate) => candidate.id === subject.operationId);
    if (operation) {
      title = describeRoutine(operation).title;
      body = <OperationDetail manager={ctx.manager} operation={operation} deviceLabel={ctx.deviceLabel(operation.request.deviceId)} />;
    }
  } else {
    const artifact = artifacts.find((candidate) => candidate.id === subject.artifactId);
    if (artifact) {
      title = shortArtifactName(artifact.name);
      body = <FileDetail artifact={artifact} set={groupArtifactSets(artifacts).find((candidate) => candidate.artifactIds.includes(artifact.id))} ctx={ctx} jobOf={jobOf} onSubject={onSubject} />;
    }
  }

  return (
    <div
      ref={sheet}
      className="dv-sheet"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
    >
      <header className="dv-sheet__head">
        {back && <Button tone="quiet" icon={<ArrowLeft size={18} />} ariaLabel={back.label} title={back.label} onClick={() => onSubject(back.to)} />}
        <h3 id={titleId} className="dv-sheet__title">{title || t("devices.sheet.gone")}</h3>
        <Button tone="quiet" icon={<X size={18} />} ariaLabel={t("devices.sheet.close")} title={t("devices.sheet.close")} onClick={onClose} />
      </header>
      <div className="dv-sheet__body">
        {body ?? <Notice>{t("devices.sheet.goneBody")}</Notice>}
      </div>
    </div>
  );
}
