"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderPlus, Pencil, Trash2 } from "lucide-react";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { ConfirmDialog } from "@/components/ui/field";
import { postFileOp } from "@/lib/file-ops-client";

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path?: string;
  parentPath?: string | null;
  directories?: DirectoryEntry[];
  error?: string;
  code?: string;
}

async function loadDirectories(directory?: string): Promise<BrowseResponse> {
  const query = directory ? `?path=${encodeURIComponent(directory)}` : "";
  const response = await fetch(`/api/cwd/browse${query}`);
  const data = await response.json() as BrowseResponse;
  if (!response.ok || data.error) {
    throw new Error(formatApiError({ ...data, error: data.error ?? `HTTP ${response.status}` }));
  }
  return data;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z" />
    </svg>
  );
}

interface Props {
  onCancel: () => void;
  onSelect: (path: string) => void;
  busy?: boolean;
  error?: string | null;
}

export function DirectoryPicker({ onCancel, onSelect, busy = false, error }: Props) {
  const { t } = useI18n();
  const isCoarsePointer = useIsCoarsePointer();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [opError, setOpError] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteBusyPath, setDeleteBusyPath] = useState<string | null>(null);
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState<DirectoryEntry | null>(null);
  const [confirmDeleteBusy, setConfirmDeleteBusy] = useState(false);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCancelRef = useRef(false);
  const dialogRef = useModalDialog<HTMLDivElement>({
    onClose: () => { if (!busy) onCancel(); },
    active: portalTarget !== null,
  });

  const navigateTo = useCallback(async (directory?: string) => {
    setLoading(true);
    setLoadError(null);
    setOpError(null);
    setCreatingFolder(false);
    setNewFolderName("");
    setRenamingPath(null);
    setConfirmDeleteEntry(null);
    try {
      const data = await loadDirectories(directory);
      const nextPath = data.path ?? directory ?? "/";
      setCurrentPath(nextPath);
      setParentDirectory(data.parentPath ?? null);
      setPathInput(nextPath);
      setDirectories(data.directories ?? []);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPortalTarget(document.body);
    void navigateTo();
  }, [navigateTo]);

  const startCreateFolder = useCallback(() => {
    setOpError(null);
    setNewFolderName("");
    setCreatingFolder(true);
    setTimeout(() => newFolderInputRef.current?.focus(), 0);
  }, []);

  const commitCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) {
      setCreatingFolder(false);
      return;
    }
    setCreateBusy(true);
    setOpError(null);
    try {
      const { ok, data } = await postFileOp({ action: "mkdir", path: currentPath, name });
      if (!ok) throw new Error(formatApiError(data));
      setCreatingFolder(false);
      setNewFolderName("");
      await navigateTo(currentPath);
    } catch (cause) {
      setOpError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreateBusy(false);
    }
  }, [currentPath, navigateTo, newFolderName]);

  const startRename = useCallback((entry: DirectoryEntry) => {
    setOpError(null);
    setRenamingPath(entry.path);
    setRenameValue(entry.name);
    setTimeout(() => renameInputRef.current?.select(), 0);
  }, []);

  const commitRename = useCallback(async (entry: DirectoryEntry) => {
    if (renameCancelRef.current) {
      renameCancelRef.current = false;
      setRenamingPath(null);
      return;
    }
    const name = renameValue.trim();
    if (!name || name === entry.name) {
      setRenamingPath(null);
      return;
    }
    setRenameBusy(true);
    setOpError(null);
    try {
      const { ok, data } = await postFileOp({ action: "rename", path: entry.path, newName: name });
      if (!ok) throw new Error(formatApiError(data));
      setRenamingPath(null);
      await navigateTo(currentPath);
    } catch (cause) {
      setOpError(cause instanceof Error ? cause.message : String(cause));
      setRenamingPath(null);
    } finally {
      setRenameBusy(false);
    }
  }, [currentPath, navigateTo, renameValue]);

  const handleDeleteClick = useCallback(async (entry: DirectoryEntry) => {
    setOpError(null);
    setDeleteBusyPath(entry.path);
    try {
      const { ok, data } = await postFileOp({ action: "delete", path: entry.path, recursive: false });
      if (ok) {
        await navigateTo(currentPath);
        return;
      }
      if (data.code === "directory_not_empty") {
        setConfirmDeleteEntry(entry);
        return;
      }
      setOpError(formatApiError(data));
    } catch (cause) {
      setOpError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleteBusyPath(null);
    }
  }, [currentPath, navigateTo]);

  const confirmForceDelete = useCallback(async () => {
    if (!confirmDeleteEntry) return;
    setConfirmDeleteBusy(true);
    try {
      const { ok, data } = await postFileOp({ action: "delete", path: confirmDeleteEntry.path, recursive: true });
      if (!ok) throw new Error(formatApiError(data));
      setConfirmDeleteEntry(null);
      await navigateTo(currentPath);
    } catch (cause) {
      setOpError(cause instanceof Error ? cause.message : String(cause));
      setConfirmDeleteEntry(null);
    } finally {
      setConfirmDeleteBusy(false);
    }
  }, [confirmDeleteEntry, currentPath, navigateTo]);

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = pathInput.trim();
    if (candidate) void navigateTo(candidate);
  };
  const hasUncommittedPath = pathInput.trim() !== currentPath;
  const canSelect = Boolean(currentPath) && !hasUncommittedPath && !busy;

  if (!portalTarget) return null;

  return createPortal(
    <div
      className="directory-picker-backdrop animate-fade-in"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1002, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--overlay-backdrop)" }}
    >
      <div className="directory-picker-panel animate-scale-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("directoryPicker.selectDirectory")} tabIndex={-1} style={{ width: 520, maxWidth: "calc(100vw - 16px)", height: "min(620px, calc(100dvh - 16px))", maxHeight: "calc(100dvh - 16px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-modal)", outline: "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 15 }}>{t("directoryPicker.selectDirectory")}</div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            title={t("directoryPicker.close")}
            aria-label={t("directoryPicker.close")}
            style={{ padding: "2px 6px", border: 0, background: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1, transition: "color var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)" }}
            onMouseEnter={(e) => { if (!busy) e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            ×
          </button>
        </div>

        <form onSubmit={handlePathSubmit} style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <button className="directory-picker-back" type="button" onClick={() => parentDirectory && void navigateTo(parentDirectory)} disabled={loading || !parentDirectory} title={t("directoryPicker.goToParent")} aria-label={t("directoryPicker.goToParent")} style={{ width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: parentDirectory ? "pointer" : "default", opacity: parentDirectory ? 1 : 0.45, transition: "background-color var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)" }} onMouseEnter={(e) => { if (parentDirectory && !loading) { e.currentTarget.style.background = "var(--bg-selected)"; e.currentTarget.style.color = "var(--text)"; } }} onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-muted)"; }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <label htmlFor="directory-path" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
            {t("directoryPicker.directoryPath")}
          </label>
          <input
            className="directory-picker-path"
            id="directory-path"
            type="text"
            value={pathInput}
            placeholder={t("directoryPicker.pathPlaceholder")}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setPathInput(event.target.value);
              setLoadError(null);
            }}
            style={{ minWidth: 0, flex: 1, height: 36, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, transition: "border-color var(--dur-fast) var(--ease-out-warm)" }}
          />
          <button
            className="directory-picker-action"
            type="submit"
            disabled={loading || !pathInput.trim()}
            title={t("directoryPicker.goToDirectory")}
            style={{ minWidth: 58, height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: loading || !pathInput.trim() ? "default" : "pointer", opacity: loading || !pathInput.trim() ? 0.6 : 1, transition: "background-color var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)" }}
            onMouseEnter={(e) => { if (!loading && pathInput.trim()) { e.currentTarget.style.background = "var(--bg-selected)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {t("directoryPicker.go")}
          </button>
          <button
            className="directory-picker-back"
            type="button"
            onClick={startCreateFolder}
            disabled={loading || creatingFolder || busy}
            title={t("directoryPicker.newFolder")}
            aria-label={t("directoryPicker.newFolder")}
            style={{ width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: loading || creatingFolder || busy ? "default" : "pointer", opacity: loading || creatingFolder || busy ? 0.5 : 1, transition: "background-color var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)" }}
            onMouseEnter={(e) => { if (!loading && !creatingFolder && !busy) { e.currentTarget.style.background = "var(--bg-selected)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <FolderPlus size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </form>

        <div className="directory-picker-list" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 10px" }}>
          {creatingFolder && (
            <div className="directory-picker-entry" style={{ width: "100%", minHeight: isCoarsePointer ? 44 : 30, display: "flex", alignItems: "center", gap: 7, padding: "5px 8px" }}>
              <FolderIcon />
              <input
                ref={newFolderInputRef}
                type="text"
                value={newFolderName}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder={t("directoryPicker.namePlaceholder")}
                disabled={createBusy}
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === "Enter") { event.preventDefault(); void commitCreateFolder(); }
                  if (event.key === "Escape") { event.preventDefault(); setCreatingFolder(false); }
                }}
                // Blur discards rather than commits (unlike rename below): an
                // accidental click-away should not silently create a folder.
                onBlur={() => { if (!createBusy) setCreatingFolder(false); }}
                style={{ flex: 1, minWidth: 0, height: 24, padding: "0 6px", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }}
              />
            </div>
          )}
          {loading ? (
            <div style={{ display: "grid", gap: 6, padding: 8 }} aria-busy="true" aria-label={t("directoryPicker.loadingDirectories")}>
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={i}
                  className="skeleton"
                  style={{ height: 22, width: `${55 + ((i * 37) % 40)}%` }}
                />
              ))}
            </div>
          ) : directories.length > 0 ? (
            directories.map((entry) => {
              const isRenaming = renamingPath === entry.path;
              const isDeleting = deleteBusyPath === entry.path;
              return (
                <div
                  key={entry.path}
                  className="directory-picker-entry directory-picker-row"
                  title={entry.path}
                  style={{ width: "100%", minHeight: isCoarsePointer ? 44 : 30, display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: 5, opacity: isDeleting ? 0.5 : 1, transition: "background-color var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)" }}
                >
                  <FolderIcon />
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameValue}
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      disabled={renameBusy}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                        if (event.key === "Enter") { event.preventDefault(); void commitRename(entry); }
                        if (event.key === "Escape") { event.preventDefault(); renameCancelRef.current = true; setRenamingPath(null); }
                      }}
                      onBlur={() => void commitRename(entry)}
                      style={{ flex: 1, minWidth: 0, height: 24, padding: "0 6px", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void navigateTo(entry.path)}
                        disabled={isDeleting}
                        style={{ flex: 1, minWidth: 0, display: "flex", border: 0, background: "none", padding: 0, color: "inherit", cursor: isDeleting ? "default" : "pointer", textAlign: "left", font: "inherit" }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                      </button>
                      <div className="directory-picker-row-actions touch-reveal" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); startRename(entry); }}
                          disabled={isDeleting}
                          title={t("directoryPicker.rename")}
                          aria-label={t("directoryPicker.rename")}
                          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: "none", borderRadius: "var(--radius-control)", background: "none", color: "var(--text-dim)", cursor: "pointer" }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-selected)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                        >
                          <Pencil size={12} strokeWidth={1.9} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); void handleDeleteClick(entry); }}
                          disabled={isDeleting}
                          title={t("directoryPicker.delete")}
                          aria-label={t("directoryPicker.delete")}
                          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: "none", borderRadius: "var(--radius-control)", background: "none", color: "var(--text-dim)", cursor: "pointer" }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--status-error)"; e.currentTarget.style.background = "var(--bg-selected)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                        >
                          <Trash2 size={12} strokeWidth={1.9} aria-hidden="true" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          ) : (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noSubdirectories")}</div>
          )}
          {(loadError || error || opError) && <div style={{ padding: "8px", color: "var(--status-error)", fontSize: 11 }}>{loadError ?? error ?? opError}</div>}
        </div>

        <div className="directory-picker-footer" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, flexShrink: 0, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button className="directory-picker-action" type="button" onClick={onCancel} disabled={busy} style={{ padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 13 }}>{t("directoryPicker.cancel")}</button>
          <button
            className="directory-picker-action"
            type="button"
            onClick={() => onSelect(currentPath)}
            disabled={!canSelect}
            title={hasUncommittedPath ? t("directoryPicker.openPathBeforeSelecting") : t("directoryPicker.selectCurrentDirectory")}
            style={{ padding: "6px 16px", border: 0, borderRadius: 6, background: "var(--accent)", color: "var(--on-accent)", fontSize: 13, fontWeight: 600, opacity: canSelect ? 1 : 0.6, cursor: canSelect ? "pointer" : "default" }}
          >
            {busy ? t("directoryPicker.checking") : t("directoryPicker.selectThisFolder")}
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDeleteEntry !== null}
        onOpenChange={(open) => { if (!open) setConfirmDeleteEntry(null); }}
        title={t("directoryPicker.deleteFolderTitle", { name: confirmDeleteEntry?.name ?? "" })}
        description={t("directoryPicker.deleteNonEmptyDescription")}
        confirmLabel={t("directoryPicker.deleteFolderConfirm")}
        cancelLabel={t("directoryPicker.cancel")}
        danger
        busy={confirmDeleteBusy}
        onConfirm={() => void confirmForceDelete()}
      />
    </div>,
    portalTarget,
  );
}
