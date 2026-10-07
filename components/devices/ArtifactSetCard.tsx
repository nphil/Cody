"use client";

import { Check, ChevronDown, ChevronRight, CircleAlert, Copy, Download, FileCheck, File as FileIcon, Info, Loader2, Server, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useI18n } from "@/lib/i18n";
import { deviceArtifacts, type ArtifactSet, type DeviceArtifact, type TransferJob } from "@/lib/devices/artifacts";
import { setSaveState } from "@/lib/devices/artifact-sets";
import { whenText } from "./job-text";
import { FILTER_FROM, narrow } from "./list-view";
import { RowMenu, type MenuItem } from "./RowMenu";
import { downloadedName, fileLabel, latestTransfer, runningTransfer, setTitle, transferText, verifiedText } from "./set-text";
import { Button, Notice, ProgressLine, Segmented, TextField } from "./ui";

export type FileSort = "order" | "name" | "size";

/** The files of a set in the order asked for: the order they were made in, by name (numbers in order), or the biggest first. */
export function orderFiles(files: readonly DeviceArtifact[], sort: FileSort): DeviceArtifact[] {
  const copy = [...files];
  if (sort === "name") return copy.sort((left, right) => fileLabel(left).localeCompare(fileLabel(right), undefined, { numeric: true, sensitivity: "base" }));
  if (sort === "size") return copy.sort((left, right) => right.size - left.size);
  return copy;
}

function useFlash(): [string | null, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = useCallback((next: string) => {
    setMessage(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), 2_500);
  }, []);
  return [message, flash];
}

interface FileActions {
  sessionId: string;
  selectedInputId: string | null;
  onSelectInput: (id: string | null) => void;
  onDetails: (artifactId: string) => void;
  /** Ask before removing this file. */
  onRemove: (artifactId: string) => void;
  flash: (message: string) => void;
}

/** What the ⋯ of a file offers. Every one of these existed on the big card; none is on the row itself. */
export function fileMenuItems(artifact: DeviceArtifact, actions: FileActions, t: (key: string, vars?: Record<string, string | number>) => string, options: { input: boolean; locked?: boolean }): MenuItem[] {
  const name = fileLabel(artifact);
  const copy = (text: string, what: string): void => {
    if (!navigator.clipboard) {
      actions.flash(t("devices.clipboardUnavailableShort"));
      return;
    }
    navigator.clipboard.writeText(text).then(() => actions.flash(t("devices.files.copied", { what, name })), () => actions.flash(t("devices.clipboardUnavailableShort")));
  };
  const selected = artifact.id === actions.selectedInputId;
  return [
    { id: "download", label: t("devices.downloadArtifact"), icon: <Download size={16} />, onSelect: () => { try { deviceArtifacts.download(actions.sessionId, artifact.id); } catch (caught) { actions.flash(caught instanceof Error ? caught.message : String(caught)); } } },
    { id: "sha", label: t("devices.files.copySha"), icon: <Copy size={16} />, onSelect: () => copy(artifact.sha256, "SHA-256") },
    { id: "id", label: t("devices.files.copyId"), icon: <Copy size={16} />, onSelect: () => copy(artifact.id, "id") },
    ...(options.input ? [] : [{ id: "use", label: selected ? t("devices.files.stopUsing") : t("devices.files.useAsInput"), icon: <FileCheck size={16} />, onSelect: () => actions.onSelectInput(selected ? null : artifact.id) }]),
    { id: "details", label: t("devices.files.details"), icon: <Info size={16} />, onSelect: () => actions.onDetails(artifact.id) },
    { id: "remove", label: t("devices.removeArtifact"), icon: <Trash2 size={16} />, tone: "danger", disabled: options.locked === true, onSelect: () => actions.onRemove(artifact.id) },
  ];
}

/** One file as one line: its name as a person says it, how big, whether the device's own read-back agreed, and its menu. */
export function FileRow({ artifact, verified, actions, confirming, onCancelRemove, onConfirmRemove, input = false, locked = false }: {
  artifact: DeviceArtifact;
  verified: boolean;
  actions: FileActions;
  confirming: boolean;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  input?: boolean;
  /** A transfer is reading this file: taking it out would stop that transfer, so Remove waits (as Remove set does). */
  locked?: boolean;
}): React.ReactElement {
  const { t } = useI18n();
  const name = input ? artifact.name : fileLabel(artifact);
  const selected = artifact.id === actions.selectedInputId;
  if (confirming) {
    return (
      <li className="dv-file dv-file--confirm" data-file={artifact.id}>
        <p>{t("devices.files.removeOne", { name, size: formatBytes(artifact.size) })}</p>
        <div className="dv-job__actions">
          <Button tone="danger" icon={<Trash2 size={14} />} disabled={locked} title={locked ? t("devices.files.stillSaving") : undefined} onClick={onConfirmRemove}>{t("devices.files.removeConfirm")}</Button>
          <Button autoFocus onClick={onCancelRemove}>{t("devices.files.keep")}</Button>
        </div>
      </li>
    );
  }
  return (
    <li className="dv-file" data-file={artifact.id} data-selected={selected || undefined}>
      <span className="dv-file__icon">{verified ? <Check size={14} aria-hidden="true" style={{ color: "var(--status-success)" }} /> : <FileIcon size={14} aria-hidden="true" style={{ color: "var(--text-dim)" }} />}</span>
      {input ? (
        <span className="dv-file__stack">
          <span className="dv-file__name" title={artifact.name}>{name}</span>
          <span className="dv-file__size dv-file__size--sub">{formatBytes(artifact.size)}</span>
        </span>
      ) : (
        <>
          <span className="dv-file__name" title={artifact.name}>{name}{verified && <span className="sr-only"> ({t("devices.operationVerified")})</span>}</span>
          <span className="dv-file__size">{formatBytes(artifact.size)}</span>
        </>
      )}
      {input && <Button tone={selected ? "primary" : "normal"} pressed={selected} onClick={() => actions.onSelectInput(selected ? null : artifact.id)}>{selected ? t("devices.inputSelected") : t("devices.useInput")}</Button>}
      <RowMenu label={t("devices.files.menu", { name })} items={fileMenuItems(artifact, actions, t, { input, locked })} />
    </li>
  );
}

export interface SetCardProps {
  sessionId: string;
  set: ArtifactSet;
  artifacts: readonly DeviceArtifact[];
  transfers: readonly TransferJob[];
  /** What the device is called now, for a set whose files did not record a name. */
  deviceName: string;
  /** The job that is still making these files is running: nothing is offered that would take half a backup. */
  busy: boolean;
  selectedInputId: string | null;
  onSelectInput: (id: string | null) => void;
  onDetails: (artifactId: string) => void;
  /** Whether the device's own read-back agreed for the operation that made a file (undefined: unknown, e.g. after a reload). */
  verifiedBy: (operationId: string) => boolean | undefined;
  acknowledged: ReadonlySet<string>;
  acknowledge: (keys: readonly string[]) => void;
  /** Open at first: when the person arrived by "N files" on a job, or in a test. */
  defaultOpen?: boolean;
  locale: string;
}

/**
 * A set of files as ONE card: what it is, when, how many and how big, whether it was checked, whether the server has it;
 * the three things to do with all of it (download, save to the server, remove); and, opened, a line per file.
 */
export function SetCard({ sessionId, set, artifacts, transfers, deviceName, busy, selectedInputId, onSelectInput, onDetails, verifiedBy, acknowledged, acknowledge, defaultOpen = false, locale }: SetCardProps): React.ReactElement {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const [confirmSet, setConfirmSet] = useState(false);
  const [confirmFile, setConfirmFile] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<FileSort>("order");
  const [showAll, setShowAll] = useState(false);
  const [note, flash] = useFlash();
  const filesId = `${set.id}-files`.replace(/[^A-Za-z0-9_-]/g, "");

  const byId = useMemo(() => new Map(artifacts.map((artifact) => [artifact.id, artifact])), [artifacts]);
  const files = useMemo(() => set.artifactIds.flatMap((id) => byId.get(id) ?? []), [set.artifactIds, byId]);
  const verified = files.filter((file) => file.provenance && verifiedBy(file.provenance.operationId) === true).length;
  const saved = setSaveState(set, files);
  // A transfer still running over these files holds the card, even when a newer one has already finished.
  const active = runningTransfer(transfers, set);
  const transfer = active ?? latestTransfer(transfers, set);
  const running = active !== undefined;
  const failed = transfer?.state === "failed" && !acknowledged.has(transfer.id) ? transfer : undefined;
  const cancelled = transfer?.state === "cancelled" && !acknowledged.has(transfer.id) ? transfer : undefined;
  const name = set.label ?? deviceName;
  const title = setTitle(set, name, t);
  const checked = verifiedText(files.length, verified, t, tn);
  const locked = running || busy;

  const ordered = useMemo(() => orderFiles(files, sort), [files, sort]);
  const { rows, capped } = narrow(ordered, { query, showAll, nameOf: fileLabel });

  const start = (run: () => Promise<unknown>): void => {
    // The store lists the transfer and its outcome; a failure is shown from there, so nothing is thrown at the click.
    run().catch(() => undefined);
  };
  const actions: FileActions = {
    sessionId,
    selectedInputId,
    onSelectInput,
    onDetails,
    onRemove: (artifactId) => setConfirmFile(artifactId),
    flash,
  };
  const removeSet = (): void => {
    setConfirmSet(false);
    deviceArtifacts.removeSet(sessionId, set.id).catch((cause: unknown) => flash(cause instanceof Error ? cause.message : String(cause)));
  };
  const removeFile = (artifactId: string): void => {
    setConfirmFile(null);
    // Taking a file out stops every transfer that reads it; the lock is the same one Remove set waits for.
    if (locked) {
      flash(t("devices.files.stillSaving"));
      return;
    }
    deviceArtifacts.removeMany(sessionId, [artifactId]).then((removed) => { if (removed > 0 && artifactId === selectedInputId) onSelectInput(null); }, (cause: unknown) => flash(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <article className="dv-set" aria-label={title} data-set={set.id}>
      <div className="dv-set__top">
      <button type="button" className="ui-focus-ring dv-set__head" aria-expanded={open} aria-controls={filesId} onClick={() => setOpen((current) => !current)}>
        <span aria-hidden="true" className="dv-set__chevron">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
        <span className="dv-set__text">
          <span className="dv-set__title">{title}</span>
          <span className="dv-set__meta">{[whenText(set.endedAt, locale), tn("devices.files.count", files.length), formatBytes(set.totalBytes)].join(" · ")}</span>
          {(checked || saved.state !== "none") && (
            <span className="dv-set__status">
              {checked && <span><Check size={12} aria-hidden="true" style={{ color: "var(--status-success)" }} /> {checked}</span>}
              {saved.state === "saved" && <span><Server size={12} aria-hidden="true" style={{ color: "var(--status-success)" }} /> {t("devices.files.savedToServer")}</span>}
              {saved.state === "partial" && <span><Server size={12} aria-hidden="true" /> {t("devices.files.savedPartial", { saved: saved.saved, total: saved.total })}</span>}
            </span>
          )}
        </span>
      </button>
      <RowMenu
        label={t("devices.files.setMenu", { title })}
        items={[{ id: "remove", label: t("devices.files.removeSet"), icon: <Trash2 size={16} />, tone: "danger", disabled: locked, onSelect: () => setConfirmSet(true) }]}
      />
      </div>

      {saved.state === "saved" && (
        <p className="dv-set__path">
          <code title={saved.path}>{saved.path}</code>
          {saved.verified && <span> · {t("devices.files.verifiedOnServer")}</span>}
        </p>
      )}

      {running && transfer ? (
        <div className="dv-set__transfer" role="status">
          <div className="dv-set__transfer-line">
            <Loader2 size={14} className="icon-spin" aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }} />
            <span>{transferText(transfer, t)}</span>
          </div>
          <ProgressLine fraction={transfer.progress.totalBytes > 0 ? transfer.progress.bytes / transfer.progress.totalBytes : transfer.progress.total > 0 ? transfer.progress.done / transfer.progress.total : 0} label={t("devices.files.transferProgress")} />
          <div className="dv-job__actions"><span style={{ flex: 1 }} /><Button tone="quiet" icon={<X size={14} />} onClick={() => deviceArtifacts.cancelJob(sessionId, transfer.id)}>{t("devices.files.cancelTransfer")}</Button></div>
        </div>
      ) : confirmSet ? (
        <div className="dv-set__confirm" role="group" aria-label={t("devices.files.removeSet")}>
          <p>{tn("devices.files.removeSetConfirm", files.length)}{saved.state === "saved" ? ` ${t("devices.files.removeKeepsServer")}` : ""}</p>
          <div className="dv-job__actions">
            <Button tone="danger" icon={<Trash2 size={14} />} onClick={removeSet}>{t("devices.files.removeConfirm")}</Button>
            <Button autoFocus onClick={() => setConfirmSet(false)}>{t("devices.files.keep")}</Button>
          </div>
        </div>
      ) : (
        <div className="dv-set__actions">
          <Button
            icon={<Download size={16} />}
            disabled={locked}
            title={busy ? t("devices.files.stillSaving") : undefined}
            // Straight from the click: the browser's save-as picker needs the click's user activation.
            onClick={() => start(() => deviceArtifacts.downloadSet(sessionId, set.id))}
          >
            {t("devices.files.downloadAll")}
          </Button>
          <Button
            icon={<Server size={16} />}
            disabled={locked}
            title={busy ? t("devices.files.stillSaving") : undefined}
            onClick={() => start(() => deviceArtifacts.saveSetToServer(sessionId, set.id))}
          >
            {t("devices.files.saveToServer")}
          </Button>
        </div>
      )}

      {transfer?.state === "succeeded" && transfer.kind === "download" && (
        <p className="dv-set__note" role="status"><Check size={12} aria-hidden="true" style={{ color: "var(--status-success)" }} /> {t("devices.files.downloaded", { name: downloadedName(transfer) ?? title })}</p>
      )}
      {failed && (
        <Notice tone="error" role="alert" icon={<CircleAlert size={14} />}>
          {failed.error?.message ?? t("devices.files.transferFailed")}
          <span style={{ display: "block", marginTop: 6 }}><Button onClick={() => acknowledge([failed.id])}>{t("devices.problem.gotIt")}</Button></span>
        </Notice>
      )}
      {cancelled && (
        <Notice tone="info" role="status">
          {cancelled.kind === "save" ? t("devices.files.cancelledSave") : t("devices.files.cancelledDownload")}
          <span style={{ display: "block", marginTop: 6 }}><Button onClick={() => acknowledge([cancelled.id])}>{t("devices.problem.gotIt")}</Button></span>
        </Notice>
      )}
      {note && <p className="dv-set__note" role="status">{note}</p>}

      {open && (
        <div id={filesId} className="dv-set__files">
          {files.length > FILTER_FROM && (
            <div className="dv-set__tools">
              <TextField label={t("devices.files.filter")} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
              <Segmented
                label={t("devices.files.sortLabel")}
                value={sort}
                onChange={setSort}
                options={[{ value: "order", label: t("devices.files.sort.order") }, { value: "name", label: t("devices.files.sort.name") }, { value: "size", label: t("devices.files.sort.size") }]}
              />
            </div>
          )}
          <ul className="dv-files" aria-label={t("devices.files.listLabel", { title })}>
            {rows.map((file) => (
              <FileRow
                key={file.id}
                artifact={file}
                verified={file.provenance !== undefined && verifiedBy(file.provenance.operationId) === true}
                actions={actions}
                confirming={confirmFile === file.id}
                locked={locked}
                onCancelRemove={() => setConfirmFile(null)}
                onConfirmRemove={() => removeFile(file.id)}
              />
            ))}
          </ul>
          {query && rows.length === 0 && <p className="dv-set__note">{t("devices.files.noMatch", { query: query.trim() })}</p>}
          {capped && <Button tone="quiet" onClick={() => setShowAll(true)}>{t("devices.files.showAll", { count: ordered.length })}</Button>}
          {set.legacy && <p className="dv-set__note">{t("devices.files.legacyNote")}</p>}
        </div>
      )}
    </article>
  );
}
