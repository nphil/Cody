"use client";

import { FolderInput, Plus, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { deviceArtifacts } from "@/lib/devices/artifacts";
import { FileRow, SetCard } from "./ArtifactSetCard";
import type { ArtifactsState } from "./useArtifacts";
import { Button, Disclosure, Notice, sectionHeadingStyle, TextField } from "./ui";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A request to open one set and bring it into view, from "N files" on a job. `token` makes a second press count again. */
export interface RevealRequest {
  readonly setId: string;
  readonly token: number;
}

interface ArtifactPanelProps {
  sessionId: string;
  /** The session's files, sets and transfers (`useArtifacts`), read once by the panel around this one. */
  library: ArtifactsState;
  selectedInputId: string | null;
  onSelectInput: (id: string | null) => void;
  /** What a device is called, for a set whose files did not record a name. */
  deviceLabel: (deviceId: string) => string;
  /** Whether the device's own read-back agreed for the operation that made a file (undefined: not known, e.g. after a reload). */
  verifiedBy: (operationId: string) => boolean | undefined;
  /** Sets whose job is still running: no bulk action is offered on half a backup. */
  busySetIds: ReadonlySet<string>;
  onDetails: (artifactId: string) => void;
  reveal?: RevealRequest;
  acknowledged: ReadonlySet<string>;
  acknowledge: (keys: readonly string[]) => void;
}

/**
 * Files & backups. What the devices made is listed as SETS (one card per run, with Download all, Save to server and
 * Remove set); what the person added (firmware, a loader) is a short group of its own. Session-owned bytes: there is
 * deliberately no remote URL input, and a server path is fetched only through the existing guarded route.
 */
export function ArtifactPanel({ sessionId, library, selectedInputId, onSelectInput, deviceLabel, verifiedBy, busySetIds, onDetails, reveal, acknowledged, acknowledge }: ArtifactPanelProps): React.ReactElement {
  const { t, locale } = useI18n();
  const picker = useRef<HTMLInputElement>(null);
  const { artifacts, sets, inputs, transfers, error: storageError } = library;
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (selectedInputId && !artifacts.some((artifact) => artifact.id === selectedInputId)) onSelectInput(null);
  }, [artifacts, onSelectInput, selectedInputId]);

  useEffect(() => {
    if (!reveal) return;
    document.querySelector(`[data-set="${CSS.escape(reveal.setId)}"]`)?.scrollIntoView({ block: "start" });
  }, [reveal]);

  const addFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let lastInput;
      for (const file of files) lastInput = await deviceArtifacts.addInput(sessionId, file, file.name, "picker");
      if (lastInput) onSelectInput(lastInput.id);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const importLocalPath = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const artifact = await deviceArtifacts.importAuthorizedFile(sessionId, path);
      onSelectInput(artifact.id);
      setPath("");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const fileActions = {
    sessionId,
    selectedInputId,
    onSelectInput,
    onDetails,
    onRemove: (artifactId: string) => setRemoving(artifactId),
    flash: setError,
  };

  return (
    <section
      id="device-files"
      aria-label={t("devices.artifacts")}
      className="dv-files-panel"
      data-dragging={dragging || undefined}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h3 style={sectionHeadingStyle}>{t("devices.artifacts")}</h3>
        <p role="note" style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>{t("devices.artifactEscrowNotice")}</p>
      </div>

      {(storageError || error) && <Notice tone="error" role="alert">{storageError ?? error}</Notice>}

      {sets.map((set) => (
        <SetCard
          key={`${set.id}:${reveal?.setId === set.id ? reveal.token : 0}`}
          sessionId={sessionId}
          set={set}
          artifacts={artifacts}
          transfers={transfers}
          deviceName={set.deviceId ? deviceLabel(set.deviceId) : t("devices.files.unknownDevice")}
          busy={busySetIds.has(set.id)}
          selectedInputId={selectedInputId}
          onSelectInput={onSelectInput}
          onDetails={onDetails}
          verifiedBy={verifiedBy}
          acknowledged={acknowledged}
          acknowledge={acknowledge}
          defaultOpen={reveal?.setId === set.id}
          locale={locale}
        />
      ))}

      <div className="dv-inputs" aria-label={t("devices.files.inputs")} role="group">
        <div className="dv-inputs__head">
          <h4 style={{ ...sectionHeadingStyle, flex: 1 }}>{t("devices.files.inputs")}{inputs.length > 0 ? ` · ${inputs.length}` : ""}</h4>
          <input
            ref={picker}
            type="file"
            hidden
            onChange={(event) => {
              void addFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          <Button id="device-files-choose" tone="primary" disabled={busy} icon={<Plus size={16} />} onClick={() => picker.current?.click()}>{t("devices.files.add")}</Button>
        </div>
        {inputs.length === 0 ? (
          <p className="dv-inputs__empty"><Upload size={14} aria-hidden="true" /> {t("devices.dropFirmware")}</p>
        ) : (
          <ul className="dv-files" aria-label={t("devices.files.inputs")}>
            {inputs.map((artifact) => (
              <FileRow
                key={artifact.id}
                artifact={artifact}
                verified={false}
                input
                actions={fileActions}
                confirming={removing === artifact.id}
                onCancelRemove={() => setRemoving(null)}
                onConfirmRemove={() => {
                  setRemoving(null);
                  deviceArtifacts.remove(sessionId, artifact.id).then((removed) => { if (removed && artifact.id === selectedInputId) onSelectInput(null); }, (cause: unknown) => setError(errorText(cause)));
                }}
              />
            ))}
          </ul>
        )}
        <Disclosure summary={t("devices.files.fromPath")}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <TextField
              label={t("devices.localPath")}
              mono
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && path.trim() && !busy) void importLocalPath(); }}
              placeholder={t("devices.localPathPlaceholder")}
              style={{ flex: "1 1 160px", width: "auto" }}
            />
            <div style={{ alignSelf: "flex-end" }}>
              <Button disabled={busy || !path.trim()} icon={<FolderInput size={16} />} onClick={() => void importLocalPath()}>{t("devices.importPath")}</Button>
            </div>
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.4, color: "var(--text-dim)" }}>{t("devices.authorizedPathHint")}</div>
        </Disclosure>
      </div>

      {sets.length === 0 && inputs.length === 0 && <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>{t("devices.artifactsEmpty")}</p>}
    </section>
  );
}
