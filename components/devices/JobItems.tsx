"use client";

import { useMemo, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useI18n } from "@/lib/i18n";
import { memberName, memberOutcome, type Job, type MemberOutcome } from "@/lib/devices/jobs";
import type { DeviceOperationSnapshot } from "@/lib/devices/operations";
import { OutcomeIcon } from "./job-icons";
import { FILTER_FROM, narrow } from "./list-view";
import { Button, TextField } from "./ui";

const OUTCOME_WORD: Record<MemberOutcome, string> = {
  succeeded: "devices.operationStateSucceeded",
  failed: "devices.operationStateFailed",
  stopped: "devices.jobState.stopped",
  cancelled: "devices.operationStateCancelled",
  declined: "devices.jobState.declined",
  active: "devices.operationStateRunning",
  waiting: "deviceTrust.stateAwaiting",
  countdown: "deviceTrust.stateCountdown",
};

/** What is working, then what went wrong, then the rest in the order it happened: the rows that matter are never the last ones. */
export function itemOrder(members: readonly DeviceOperationSnapshot[]): DeviceOperationSnapshot[] {
  const rank = (member: DeviceOperationSnapshot): number => {
    const outcome = memberOutcome(member);
    if (outcome === "active" || outcome === "waiting" || outcome === "countdown") return 0;
    return outcome === "failed" || outcome === "stopped" ? 1 : 2;
  };
  return members.map((member, index) => ({ member, index })).sort((left, right) => rank(left.member) - rank(right.member) || left.index - right.index).map((entry) => entry.member);
}

function percentOf(member: DeviceOperationSnapshot): number | null {
  const progress = member.progress;
  return progress?.completed !== undefined && progress.total ? Math.round(Math.min(1, progress.completed / progress.total) * 100) : null;
}

/** The short right-hand text of a row: how big it is once done, how far it has got while running, otherwise what became of it. */
function itemMeta(member: DeviceOperationSnapshot, outcome: MemberOutcome, t: (key: string) => string): string {
  if (outcome === "succeeded") return member.progress?.total !== undefined ? formatBytes(member.progress.total) : "";
  if (outcome === "active") {
    const percent = percentOf(member);
    return percent === null ? t(OUTCOME_WORD.active) : `${percent}%`;
  }
  return t(OUTCOME_WORD[outcome]);
}

/**
 * One line per operation of a job: its partition, how big or how far, and what became of it. Each row opens that
 * operation's detail. A long list has a filter and holds back all but the first rows until asked.
 */
export function JobItems({ job, onOpen, initialShowAll = false }: { job: Job; onOpen: (operationId: string) => void; initialShowAll?: boolean }): React.ReactElement {
  const { t, tn } = useI18n();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(initialShowAll);
  const ordered = useMemo(() => itemOrder(job.members), [job.members]);
  const { rows, capped } = narrow(ordered, { query, showAll, nameOf: memberName });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      {ordered.length > FILTER_FROM && (
        <TextField label={t("devices.items.filter")} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      )}
      <ul className="dv-items" aria-label={t("devices.items.list")}>
        {rows.map((member) => {
          const outcome = memberOutcome(member);
          const problem = outcome === "failed" || outcome === "stopped";
          return (
            <li key={member.id}>
              <button type="button" className="ui-focus-ring dv-item" onClick={() => onOpen(member.id)}>
                <OutcomeIcon outcome={outcome} />
                <span className="dv-item__name">{memberName(member)}</span>
                <span className="dv-item__meta" style={problem ? { color: outcome === "failed" ? "var(--status-error)" : "var(--status-warning)" } : undefined}>{itemMeta(member, outcome, t)}</span>
                <span className="sr-only">{t(OUTCOME_WORD[outcome])}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {query && rows.length === 0 && <p style={{ margin: 0, padding: "0 8px", fontSize: 12, color: "var(--text-dim)" }}>{t("devices.items.noMatch", { query: query.trim() })}</p>}
      {capped && <Button tone="quiet" onClick={() => setShowAll(true)}>{t("devices.items.showAll", { count: ordered.length })}</Button>}
      {query && <p className="sr-only" role="status">{tn("devices.items.matches", rows.length)}</p>}
    </div>
  );
}
