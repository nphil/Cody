"use client";

import { Copy, Download, FileDown, FileUp, FolderInput, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useI18n } from "@/lib/i18n";
import { deviceArtifacts, type DeviceArtifact, type DeviceArtifactSource } from "@/lib/devices/artifacts";
import { Button, cardStyle, Notice, sectionHeadingStyle, TOUCH } from "./ui";

interface ArtifactPanelProps {
  sessionId: string;
  selectedInputId: string | null;
  onSelectInput(id: string | null): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceLabel(source: DeviceArtifactSource, t: (key: string) => string): string {
  switch (source) {
    case "picker": return t("devices.artifactSourcePicker");
    case "drop": return t("devices.artifactSourceDrop");
    case "server-file": return t("devices.artifactSourceServer");
    case "device": return t("devices.artifactSourceDevice");
  }
}

/** Session-owned firmware and dump bytes. It deliberately has no remote URL
 * input: server-local paths are fetched only through the existing guarded API. */
export function ArtifactPanel({ sessionId, selectedInputId, onSelectInput }: ArtifactPanelProps): React.ReactElement {
  const { t } = useI18n();
  const picker = useRef<HTMLInputElement>(null);
  const [artifacts, setArtifacts] = useState<readonly DeviceArtifact[]>(() => deviceArtifacts.list(sessionId));
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = deviceArtifacts.subscribe(sessionId, setArtifacts);
    void deviceArtifacts.hydrate(sessionId).catch((cause: unknown) => {
      if (active) setError(errorText(cause));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [sessionId]);

  useEffect(() => {
    if (selectedInputId && !artifacts.some((artifact) => artifact.id === selectedInputId)) {
      onSelectInput(null);
    }
  }, [artifacts, onSelectInput, selectedInputId]);

  const addFiles = async (files: readonly File[], source: "picker" | "drop") => {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let lastInput: DeviceArtifact | undefined;
      for (const file of files) lastInput = await deviceArtifacts.addInput(sessionId, file, file.name, source);
      if (lastInput) onSelectInput(lastInput.id);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const importLocalPath = async () => {
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

  return (
    <section id="device-files" aria-label={t("devices.artifacts")} style={cardStyle}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h3 style={sectionHeadingStyle}>{t("devices.artifacts")}</h3>
        <p role="note" style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>{t("devices.artifactEscrowNotice")}</p>
      </div>
      <div
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void addFiles(Array.from(event.dataTransfer.files), "drop");
        }}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 12,
          border: `1px dashed ${dragging ? "var(--accent)" : "var(--border)"}`,
          borderRadius: "var(--radius-control)",
          background: dragging ? "var(--bg-selected)" : "var(--bg)",
        }}
      >
        <input
          ref={picker}
          type="file"
          hidden
          onChange={(event) => {
            void addFiles(Array.from(event.currentTarget.files ?? []), "picker");
            event.currentTarget.value = "";
          }}
        />
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <Upload size={18} aria-hidden="true" style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <span style={{ flex: "1 1 160px", minWidth: 0, fontSize: 12, lineHeight: 1.4, color: "var(--text-muted)" }}>{t("devices.dropFirmware")}</span>
          <button id="device-files-choose" type="button" className="ui-focus-ring dv-btn dv-btn--primary" disabled={busy} onClick={() => picker.current?.click()} style={{ minHeight: TOUCH, padding: "0 16px", borderRadius: "var(--radius-control)", border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--on-accent)", fontSize: 13, fontWeight: 600, opacity: busy ? 0.55 : 1, cursor: busy ? "default" : "pointer" }}>
            {t("devices.chooseFile")}
          </button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <label htmlFor="device-local-artifact" className="sr-only">{t("devices.localPath")}</label>
          <input
            id="device-local-artifact"
            className="ui-focus-ring"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && path.trim() && !busy) void importLocalPath();
            }}
            placeholder={t("devices.localPathPlaceholder")}
            style={{ minWidth: 0, flex: "1 1 160px", minHeight: TOUCH, padding: "0 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 16 }}
          />
          <Button disabled={busy || !path.trim()} icon={<FolderInput size={16} />} onClick={() => void importLocalPath()}>{t("devices.importPath")}</Button>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.4, color: "var(--text-dim)" }}>{t("devices.authorizedPathHint")}</div>
      </div>

      {error && <Notice tone="error" role="alert">{error}</Notice>}

      {artifacts.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("devices.artifactsEmpty")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {artifacts.map((artifact) => {
            const selected = artifact.id === selectedInputId;
            return (
              <div key={artifact.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`, borderRadius: "var(--radius-control)", background: selected ? "var(--bg-selected)" : "var(--bg)" }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  {artifact.kind === "input" ? <FileUp size={16} aria-hidden="true" /> : <FileDown size={16} aria-hidden="true" />}
                  <span style={{ minWidth: 0, flex: "1 1 120px", overflowWrap: "anywhere", color: "var(--text)", fontSize: 13, fontWeight: 600 }} title={artifact.name}>{artifact.name}</span>
                  <Button pressed={selected} tone={selected ? "primary" : "normal"} onClick={() => onSelectInput(selected ? null : artifact.id)}>
                    {selected ? t("devices.inputSelected") : t("devices.useInput")}
                  </Button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12, lineHeight: 1.35, color: "var(--text-muted)" }}>
                  <span>{artifact.kind === "input" ? t("devices.artifactInput") : t("devices.artifactOutput")} · {sourceLabel(artifact.source, t)} · {formatBytes(artifact.size)}</span>
                  <code style={{ overflowWrap: "anywhere", color: "var(--text-dim)" }}>{artifact.id}</code>
                  <code style={{ overflowWrap: "anywhere", color: "var(--text-dim)" }}>{artifact.sha256}</code>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <Button icon={<Copy size={16} />} onClick={() => { if (!navigator.clipboard) { setError(t("devices.clipboardUnavailable")); return; } void navigator.clipboard.writeText(artifact.id + "\n" + artifact.sha256).then(() => setError(null)).catch((caught: unknown) => setError(errorText(caught))); }}>{t("devices.copyArtifactReference")}</Button>
                  <Button icon={<Download size={16} />} onClick={() => deviceArtifacts.download(sessionId, artifact.id)}>{t("devices.downloadArtifact")}</Button>
                  <Button tone="danger" icon={<Trash2 size={16} />} onClick={() => { void deviceArtifacts.remove(sessionId, artifact.id).then((removed) => { if (removed && selected) onSelectInput(null); }).catch((cause: unknown) => setError(errorText(cause))); }}>{t("devices.removeArtifact")}</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
