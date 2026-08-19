"use client";

import { forwardRef, useState, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AtSign,
  Check,
  ChevronRight,
  CircleAlert,
  CircleMinus,
  Download,
  Folder,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { getFileIcon } from "./FileIcons";
import { Tooltip } from "./ui/primitives";
import { ConfirmDialog } from "./ui/field";
import { toast } from "./ui/toast";
import { translate, useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { postFileOp } from "@/lib/file-ops-client";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
  createFile: () => void;
  createFolder: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    let message = translate("fileExplorer.loadFailed", { status: res.status });
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(translate("fileExplorer.gitStatusFailed", { status: res.status }));
  return res.json() as Promise<GitStatusResponse>;
}

const GIT_STATUS_LABEL_KEYS: Record<GitFileStatusKind, string> = {
  modified: "fileExplorer.gitModified",
  added: "fileExplorer.gitAdded",
  deleted: "fileExplorer.gitDeleted",
  renamed: "fileExplorer.gitRenamed",
  untracked: "fileExplorer.gitUntracked",
  conflict: "fileExplorer.gitConflict",
};

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "var(--status-modified)",
  added: "var(--status-success)",
  deleted: "var(--status-error)",
  renamed: "var(--status-renamed)",
  untracked: "var(--status-success)",
  conflict: "var(--status-error)",
};

function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error(translate("fileExplorer.uploadNetworkError")));
    xhr.onabort = () => reject(new Error(translate("fileExplorer.uploadCancelled")));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: 24, height: 24, padding: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0, border: "none",
        borderRadius: "var(--radius-control)",
        background: "none",
        color: "var(--text-dim)",
        cursor: "pointer",
        transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
    >
      <X size={13} strokeWidth={2.2} aria-hidden="true" />
    </button>
  );
}

const ROW_MENU_MARGIN = 5;
const ROW_MENU_VIEWPORT_PAD = 8;

/** Small floating action menu for a tree row (new file/folder, rename,
 * delete), portaled to <body> and positioned from the anchor button's
 * viewport rect. Mirrors SidebarPortalMenu in SessionSidebar.tsx — kept as a
 * local copy here since that one isn't exported. */
function FileRowMenu({
  anchor,
  open,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const computePos = useCallback((el: HTMLElement | null, menu: HTMLDivElement | null) => {
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let top = r.bottom + ROW_MENU_MARGIN;
    if (top + height > window.innerHeight - ROW_MENU_VIEWPORT_PAD) {
      top = r.top - height - ROW_MENU_MARGIN;
    }
    if (top < ROW_MENU_VIEWPORT_PAD) top = ROW_MENU_VIEWPORT_PAD;
    const left = Math.max(
      ROW_MENU_VIEWPORT_PAD,
      Math.min(r.left, window.innerWidth - width - ROW_MENU_VIEWPORT_PAD),
    );
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    computePos(anchor.current, menuRef.current);
  }, [open, computePos, anchor]);

  useEffect(() => {
    if (!open) return;
    const update = () => computePos(anchor.current, menuRef.current);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, computePos, anchor]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (anchor.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, anchor]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: "fixed",
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        visibility: pos ? "visible" : "hidden",
        zIndex: 1000,
        minWidth: 132,
        padding: 4,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: "var(--bg-panel)",
        boxShadow: "var(--shadow-pop)",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function FileRowMenuItem({ danger, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "6px 9px",
    borderRadius: 6,
    fontSize: 11,
    color: danger ? "var(--status-error)" : "var(--text-muted)",
  };
  return <button type="button" role="menuitem" className="sidebar-menu-item" style={style} {...props} />;
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshToken,
  highlightedPaths,
  gitStatusByPath,
  changedDirectoryPaths,
  onMutated,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshToken: string;
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  /** Bump the tree-wide refresh token — used after a rename/delete, since
   * those change the *parent* directory's listing, not just this node's own
   * (still-loaded) children. */
  onMutated: () => void;
}) {
  const { t } = useI18n();
  const open = expandedPaths.has(node.fullPath);
  const highlighted = highlightedPaths.has(node.fullPath);
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCancelRef = useRef(false);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  // Re-fetch children when the tree refreshes. Open directories re-fetch in
  // place; collapsed directories are marked stale so the next expand re-fetches
  // instead of showing a listing captured before the refresh.
  useEffect(() => {
    if (open) {
      if (loaded) loadChildren(true);
    } else {
      setLoaded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded]);

  // Keyboard activation (Enter/Space) for the row, mirroring the click action so
  // the tree is operable without a mouse. Only reacts when the focus is on the
  // row itself, never when a nested action button (mention/menu) is focused.
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleClick();
  }, [handleClick]);

  const mentionLabel = t("fileExplorer.insertPathIntoChat");

  const startRename = useCallback(() => {
    setMenuOpen(false);
    setRenameValue(node.name);
    setRenaming(true);
    setTimeout(() => renameInputRef.current?.select(), 0);
  }, [node.name]);

  const commitRename = useCallback(async () => {
    if (renameCancelRef.current) {
      renameCancelRef.current = false;
      setRenaming(false);
      return;
    }
    const name = renameValue.trim();
    setRenaming(false);
    if (!name || name === node.name) return;
    setRenameBusy(true);
    try {
      const { ok, data } = await postFileOp({ action: "rename", path: node.fullPath, newName: name });
      if (!ok) throw new Error(formatApiError(data));
      onMutated();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRenameBusy(false);
    }
  }, [node.fullPath, node.name, onMutated, renameValue]);

  const handleDeleteClick = useCallback(async () => {
    setMenuOpen(false);
    setDeleteBusy(true);
    try {
      const { ok, data } = await postFileOp({ action: "delete", path: node.fullPath, recursive: false });
      if (ok) {
        onMutated();
        return;
      }
      if (data.code === "directory_not_empty") {
        setConfirmDelete(true);
        return;
      }
      toast.error(formatApiError(data));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleteBusy(false);
    }
  }, [node.fullPath, onMutated]);

  const confirmForceDelete = useCallback(async () => {
    setConfirmDelete(false);
    setDeleteBusy(true);
    try {
      const { ok, data } = await postFileOp({ action: "delete", path: node.fullPath, recursive: true });
      if (!ok) throw new Error(formatApiError(data));
      onMutated();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleteBusy(false);
    }
  }, [node.fullPath, onMutated]);

  return (
    <div>
      <div
        onClick={renaming ? undefined : handleClick}
        onKeyDown={handleKeyDown}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={(e) => { if (e.target === e.currentTarget) setFocused(true); }}
        onBlur={() => setFocused(false)}
        role="treeitem"
        tabIndex={0}
        aria-selected={highlighted}
        aria-expanded={node.isDir ? open : undefined}
        aria-label={node.isDir ? (node.name + " (folder" + (open ? ", expanded" : ", collapsed") + ")") : (node.name + " (file)")}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: hovered || focused || menuOpen ? 8 + 22 * (1 + (onAtMention ? 1 : 0)) : 8,
          height: 24,
          cursor: renaming ? "default" : "pointer",
          background: hovered ? "var(--bg-hover)" : "transparent",
          borderRadius: "var(--radius-control)",
          userSelect: "none",
          opacity: deleteBusy ? 0.5 : 1,
          boxShadow: focused ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 70%, transparent)" : "none",
          outline: "none",
          transition: `background var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)`,
        }}
      >
        {node.isDir && (
          <ChevronRight
            size={10}
            strokeWidth={2}
            color="var(--text-dim)"
            style={{
              flexShrink: 0,
              transform: open ? "rotate(90deg)" : "none",
              transition: `transform var(--dur-fast) var(--ease-out-warm)`,
            }}
            aria-hidden="true"
          />
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center", color: node.isDir ? "var(--text-muted)" : "var(--text-dim)" }}>
          {node.isDir ? (
            open ? <FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" /> : <Folder size={14} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            getFileIcon(node.name, 14)
          )}
        </span>
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            disabled={renameBusy}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
              if (e.key === "Escape") { e.preventDefault(); renameCancelRef.current = true; setRenaming(false); }
            }}
            onBlur={() => void commitRename()}
            style={{ flex: 1, minWidth: 0, height: 19, padding: "0 4px", border: "1px solid var(--accent)", borderRadius: 4, outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
          />
        ) : (
          <span
            style={{
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
            title={node.fullPath}
          >
            {node.name}
          </span>
        )}
        {highlighted && (
          <span
            title={t("fileExplorer.newlyUploaded")}
            aria-label={t("fileExplorer.newlyUploaded")}
            style={{ width: 6, height: 6, flexShrink: 0, borderRadius: "50%", background: "var(--accent)" }}
          />
        )}
        {!hovered && !node.isDir && gitStatus && (
          <span
            title={t(GIT_STATUS_LABEL_KEYS[gitStatus.status])}
            aria-label={t(GIT_STATUS_LABEL_KEYS[gitStatus.status])}
            style={{
              width: 14,
              flexShrink: 0,
              color: GIT_STATUS_COLORS[gitStatus.status],
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 600,
              textAlign: "center",
            }}
          >
            {gitStatus.code}
          </span>
        )}
        {!hovered && containsGitChanges && (
          <span
            title={t("fileExplorer.containsChangedFiles")}
            aria-label={t("fileExplorer.containsChangedFiles")}
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              borderRadius: "50%",
              background: "var(--status-modified)",
            }}
          />
        )}
        {loading && (
          <Loader2 size={10} strokeWidth={2} color="var(--text-dim)" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true" />
        )}
        {!renaming && (
          <div
            className="touch-reveal"
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 2,
              visibility: hovered || focused || menuOpen ? "visible" : "hidden",
            }}
          >
            {onAtMention && (
              <Tooltip content={mentionLabel}>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
                  }}
                  aria-label={mentionLabel}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 20, height: 20, padding: 0,
                    border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
                    background: "var(--bg-panel)", color: "var(--accent)", cursor: "pointer",
                  }}
                >
                  <AtSign size={11} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
            <Tooltip content={t("fileExplorer.moreActions")}>
              <button
                type="button"
                ref={menuButtonRef}
                onClick={(event) => { event.stopPropagation(); setMenuOpen((value) => !value); }}
                aria-label={t("fileExplorer.moreActions")}
                aria-expanded={menuOpen}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, padding: 0, lineHeight: 0,
                  border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
                  background: menuOpen ? "var(--bg-selected)" : "var(--bg-panel)",
                  color: menuOpen ? "var(--text)" : "var(--text-dim)",
                  cursor: "pointer",
                }}
              >
                <MoreHorizontal size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </Tooltip>
            <FileRowMenu anchor={menuButtonRef} open={menuOpen} onClose={() => setMenuOpen(false)}>
              <a
                role="menuitem"
                className="sidebar-menu-item"
                href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
                download
                onClick={(event) => { event.stopPropagation(); setMenuOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "6px 9px", borderRadius: 6, fontSize: 11,
                  color: "var(--text-muted)", textDecoration: "none",
                }}
              >
                <Download size={12} strokeWidth={2} aria-hidden="true" />
                {t("fileExplorer.download")}
              </a>
              <FileRowMenuItem onClick={(event) => { event.stopPropagation(); startRename(); }}>
                <Pencil size={12} strokeWidth={2} aria-hidden="true" />
                {t("fileExplorer.rename")}
              </FileRowMenuItem>
              <FileRowMenuItem danger onClick={(event) => { event.stopPropagation(); void handleDeleteClick(); }}>
                <Trash2 size={12} strokeWidth={2} aria-hidden="true" />
                {t("fileExplorer.delete")}
              </FileRowMenuItem>
            </FileRowMenu>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("fileExplorer.deleteFolderTitle", { name: node.name })}
        description={t("fileExplorer.deleteNonEmptyDescription")}
        confirmLabel={t("fileExplorer.deleteFolderConfirm")}
        cancelLabel={t("fileExplorer.cancel")}
        danger
        busy={deleteBusy}
        onConfirm={() => void confirmForceDelete()}
      />
      {node.isDir && open && (
        <div role="group">
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              onMutated={onMutated}
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              {t("fileExplorer.emptyDir")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
}, ref) {
  const { t, tn } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [rootCreating, setRootCreating] = useState<"file" | "folder" | null>(null);
  const [rootCreateValue, setRootCreateValue] = useState("");
  const [rootCreateBusy, setRootCreateBusy] = useState(false);
  const prevCwdRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const rootCreateInputRef = useRef<HTMLInputElement>(null);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  // Bumped after a rename/delete anywhere in the tree so every open directory
  // (including the mutated entry's parent) re-fetches its listing.
  const handleMutated = useCallback(() => {
    setTreeRefreshKey((key) => key + 1);
  }, []);

  const applyUploadResult = useCallback((data: UploadResponse) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(cwd, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, [cwd]);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(cwd, files, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? translate("fileExplorer.uploadFailed", { status }));
      }
      setUploadProgress(100);
      applyUploadResult(data);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, cwd]);

  const prepareUpload = useCallback(async (files: File[]) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(cwd)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? translate("fileExplorer.uploadCheckFailed", { status: res.status }));

      if (data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [cwd, performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files);
  }, [prepareUpload]);

  const startRootCreate = useCallback((kind: "file" | "folder") => {
    setRootCreateValue("");
    setRootCreating(kind);
    setTimeout(() => rootCreateInputRef.current?.focus(), 0);
  }, []);
  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
    createFile() {
      if (!rootCreating) startRootCreate("file");
    },
    createFolder() {
      if (!rootCreating) startRootCreate("folder");
    },
  }), [rootCreating, startRootCreate, uploadBusy]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);


  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) {
      setExpandedPaths(new Set());
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
      setRootCreating(null);
      setRootCreateValue("");
    }

    setLoading(cwdChanged);
    setError(null);
    let cancelled = false;
    fetchEntries(cwd)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((status) => {
        if (!cancelled) setGitFiles(status.isGitRepository ? status.files : []);
      })
      .catch(() => {
        if (!cancelled) setGitFiles([]);
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);
  // Keep the mounted explorer in sync with terminal/agent writes. Background
  // timers are throttled by browsers, so focus and visibility restoration also
  // force an immediate refresh.
  useEffect(() => {
    const refreshVisibleTree = () => {
      if (!document.hidden) setTreeRefreshKey((key) => key + 1);
    };
    const interval = window.setInterval(refreshVisibleTree, 2500);
    window.addEventListener("focus", refreshVisibleTree);
    document.addEventListener("visibilitychange", refreshVisibleTree);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisibleTree);
      document.removeEventListener("visibilitychange", refreshVisibleTree);
    };
  }, [cwd]);


  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(cwd, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);


  const commitRootCreate = useCallback(async () => {
    if (!rootCreating) return;
    const name = rootCreateValue.trim();
    if (!name) {
      setRootCreating(null);
      return;
    }
    setRootCreateBusy(true);
    try {
      const action = rootCreating === "folder" ? "mkdir" : "create-file";
      const { ok, data } = await postFileOp({ action, path: cwd, name });
      if (!ok) throw new Error(formatApiError(data));
      setRootCreating(null);
      setRootCreateValue("");
      setTreeRefreshKey((key) => key + 1);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRootCreateBusy(false);
    }
  }, [cwd, rootCreateValue, rootCreating]);

  return (
    <div style={{ minHeight: "100%" }}>
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("fileExplorer.checkingFiles") : t("fileExplorer.uploadingPercent", { percent: uploadProgress })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <Loader2 size={13} strokeWidth={2.2} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
              ) : (
                <Upload size={13} strokeWidth={2} aria-hidden="true" />
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: 10 }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--accent)", transition: `width var(--dur-fast) var(--ease-out-warm)` }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, var(--status-warning) 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, var(--status-warning) 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {tn("fileExplorer.filesAlreadyExist", pendingConflict.conflicts.length, { files: pendingConflict.conflicts.join(", ") })}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: "var(--status-warning)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {t("fileExplorer.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite")} style={{ height: 22, padding: "0 7px", border: "1px solid var(--status-error)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--status-error)", cursor: "pointer", fontSize: 10 }}>
                {t("fileExplorer.replace")}
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip")} style={{ height: 22, padding: "0 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}>
                {t("fileExplorer.skipExisting")}
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>
                {t("fileExplorer.cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.35, color: "var(--status-error)" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("fileExplorer.dismissError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: 11 }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={t("fileExplorer.uploadedCount", { count: uploadSummary.uploaded.length })} aria-label={t("fileExplorer.uploadedCount", { count: uploadSummary.uploaded.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--status-success)" }}>
                    <Check size={13} strokeWidth={2.4} aria-hidden="true" />
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={t("fileExplorer.skippedCount", { count: uploadSummary.skipped.length })} aria-label={t("fileExplorer.skippedCount", { count: uploadSummary.skipped.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <CircleMinus size={13} strokeWidth={2} aria-hidden="true" />
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={t("fileExplorer.failedCount", { count: uploadSummary.errors.length })} aria-label={t("fileExplorer.failedCount", { count: uploadSummary.errors.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--status-error)" }}>
                    <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <Tooltip content={uploadSummary.uploaded.length === 1 ? t("fileExplorer.addUploadedFile") : t("fileExplorer.addAllUploadedFiles")}>
                  <button
                    type="button"
                    onClick={addUploadedFilesToChat}
                    aria-label={uploadSummary.uploaded.length === 1 ? t("fileExplorer.addUploadedFile") : t("fileExplorer.addAllUploadedFiles")}
                    style={{
                      height: 22, padding: "0 7px",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                      flexShrink: 0,
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-control)",
                      background: "var(--bg-panel)",
                      color: "var(--accent)",
                      cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
                      transition: `background var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)`,
                    }}
                  >
                    <AtSign size={11} strokeWidth={2.2} aria-hidden="true" />
                    {t("fileExplorer.mention")}
                  </button>
                </Tooltip>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("fileExplorer.dismissUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 10, color: "var(--status-error)" }}>
                <CircleAlert size={11} strokeWidth={2} style={{ flexShrink: 0 }} aria-hidden="true" />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}


      <div role="tree" aria-label={t("sessionSidebar.explorer")} style={{ padding: "2px 4px" }}>
        {rootCreating && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 8, paddingRight: 8, height: 24 }}>
            <span style={{ width: 10, flexShrink: 0 }} />
            <span style={{ flexShrink: 0, display: "flex", alignItems: "center", color: "var(--text-dim)" }}>
              {rootCreating === "folder"
                ? <Folder size={14} strokeWidth={1.8} aria-hidden="true" />
                : getFileIcon(rootCreateValue || "untitled", 14)}
            </span>
            <input
              ref={rootCreateInputRef}
              value={rootCreateValue}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={rootCreateBusy}
              placeholder={t("fileExplorer.namePlaceholder")}
              onChange={(e) => setRootCreateValue(e.target.value)}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") { e.preventDefault(); void commitRootCreate(); }
                if (e.key === "Escape") { e.preventDefault(); setRootCreating(null); }
              }}
              onBlur={() => { if (!rootCreateBusy) setRootCreating(null); }}
              style={{ flex: 1, minWidth: 0, height: 19, padding: "0 4px", border: "1px solid var(--accent)", borderRadius: 4, outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
            />
          </div>
        )}
        {loading ? (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("fileExplorer.loadingFiles")}</div>
        ) : error ? (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--status-error)" }}>{error}</div>
        ) : (
          roots.map((node) => (
            <TreeNode
              key={node.fullPath}
              node={node}
              depth={0}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={handleToggleExpanded}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              onMutated={handleMutated}
            />
          ))
        )}
        {!loading && !error && roots.length === 0 && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
            {t("fileExplorer.noFilesFound")}
          </div>
        )}
      </div>
    </div>
  );
});
