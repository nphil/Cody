"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Check, ChevronRight, FileText, GitBranch, List, ListTree, Minus, Plus, RotateCw, Undo2 } from "lucide-react";
import { DiffView } from "./DiffView";
import { translate, useI18n } from "@/lib/i18n";
import { getRelativeFilePath } from "@/lib/file-paths";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import {
  buildGitFileTree,
  collectGitFileTreeDirectoryPaths,
  type GitFileTreeDirectoryNode,
  type GitFileTreeNode,
} from "@/lib/git-file-tree";
import type { GitFileDiffResponse, GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";

export interface GitPanelProps {
  cwd: string | null;
  /** This panel is the visible tab. Only an active panel refetches on window focus. */
  active: boolean;
  /** Bumped when an agent turn ends: refetch status even while inactive. */
  refreshKey: number;
  /** Open the clicked file in the Files tab. */
  onOpenFile?: (absolutePath: string) => void;
  /** Changed-file count for the tab badge; null when this is not a repository. */
  onCountChange?: (count: number | null) => void;
  /** Branch + repo root for the shell (Info panel); null when not a repository. */
  onMetaChange?: (meta: { branch: string | null; repoRoot: string | null } | null) => void;
}

type GitFileView = "list" | "tree";

interface ChangedEntry {
  file: GitFileStatus;
  /** Path relative to the repository root — what the rows display. */
  relativePath: string;
}

/** Same status→colour mapping the Files tree uses, so a file reads the same in
 * both panels. */
const STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "var(--status-modified)",
  added: "var(--status-success)",
  deleted: "var(--status-error)",
  renamed: "var(--status-renamed)",
  untracked: "var(--status-success)",
  conflict: "var(--status-error)",
};

const STATUS_LABEL_KEYS: Record<GitFileStatusKind, string> = {
  modified: "fileExplorer.gitModified",
  added: "fileExplorer.gitAdded",
  deleted: "fileExplorer.gitDeleted",
  renamed: "fileExplorer.gitRenamed",
  untracked: "fileExplorer.gitUntracked",
  conflict: "fileExplorer.gitConflict",
};

const ROW_BASE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "3px 10px",
  border: "none",
  borderRadius: "var(--radius-control)",
  textAlign: "left",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  lineHeight: 1.5,
  cursor: "pointer",
  color: "var(--text)",
  transition: "background var(--dur-fast) var(--ease-out-warm)",
};

function readStoredView(): GitFileView {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.gitFileView);
    if (stored === "list" || stored === "tree") return stored;
  } catch {
    // storage unavailable (private mode etc.) — fall back to the default view
  }
  return "list";
}

function storeView(view: GitFileView): void {
  try {
    localStorage.setItem(STORAGE_KEYS.gitFileView, view);
  } catch {
    // a lost preference is never worth breaking the panel over
  }
}

function CenteredHint({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: "16px 12px",
        fontSize: 12,
        color: "var(--text-dim)",
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}

function HeaderButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const background = pressed ? "var(--bg-selected)" : "transparent";
  return (
    <button
      type="button"
      className="ui-focus-ring"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      style={{
        width: 22,
        height: 22,
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        border: "none",
        borderRadius: "var(--radius-control)",
        background,
        color: pressed ? "var(--text)" : "var(--text-muted)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(event) => {
        if (disabled) return;
        event.currentTarget.style.background = pressed ? "var(--bg-selected)" : "var(--bg-subtle)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = background;
      }}
    >
      {children}
    </button>
  );
}

function StatusCode({ file, label }: { file: GitFileStatus; label: string }) {
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        width: 12,
        flexShrink: 0,
        textAlign: "center",
        fontWeight: 600,
        color: STATUS_COLORS[file.status],
      }}
    >
      {file.code}
    </span>
  );
}

interface RowAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
}

function FileRow({
  entry,
  depth,
  directoryPrefix,
  name,
  selected,
  onSelect,
  onOpen,
  openLabel,
  statusLabel,
  actions,
  actionsDisabled,
}: {
  entry: ChangedEntry;
  depth: number;
  /** Leading directories, dimmed. Empty in tree view, where the parent rows already show them. */
  directoryPrefix: string;
  name: string;
  selected: boolean;
  onSelect: () => void;
  onOpen?: () => void;
  openLabel: string;
  statusLabel: string;
  /** Stage/unstage/discard controls, shown on the selected row like Open. */
  actions?: RowAction[];
  actionsDisabled?: boolean;
}) {
  const background = selected ? "var(--bg-selected)" : "transparent";
  const showActions = selected && (actions?.length ?? 0) > 0;
  const showOpen = selected && onOpen !== undefined;
  const reservedRight = 10 + (showOpen ? 22 : 0) + (showActions ? (actions?.length ?? 0) * 22 : 0);
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="ui-focus-ring"
        onClick={onSelect}
        aria-current={selected}
        title={entry.relativePath}
        style={{
          ...ROW_BASE_STYLE,
          paddingLeft: 10 + depth * 14,
          paddingRight: reservedRight,
          background,
        }}
        onMouseEnter={(event) => {
          if (!selected) event.currentTarget.style.background = "var(--bg-subtle)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = background;
        }}
      >
        <StatusCode file={entry.file} label={statusLabel} />
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {directoryPrefix && <span style={{ color: "var(--text-muted)" }}>{directoryPrefix}</span>}
          <span style={{ color: "var(--text)" }}>{name}</span>
        </span>
      </button>
      {showActions && actions?.map((action, index) => (
        <button
          key={action.key}
          type="button"
          className="ui-focus-ring"
          onClick={action.onClick}
          disabled={actionsDisabled}
          title={action.label}
          aria-label={action.label}
          style={{
            position: "absolute",
            right: 5 + (showOpen ? 22 : 0) + index * 22,
            top: "50%",
            transform: "translateY(-50%)",
            width: 20,
            height: 20,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: "var(--radius-control)",
            background: "transparent",
            color: "var(--text-muted)",
            cursor: actionsDisabled ? "default" : "pointer",
            opacity: actionsDisabled ? 0.5 : 1,
            transition: "color var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
        >
          {action.icon}
        </button>
      ))}
      {showOpen && (
        <button
          type="button"
          className="ui-focus-ring"
          onClick={onOpen}
          title={openLabel}
          aria-label={openLabel}
          style={{
            position: "absolute",
            right: 5,
            top: "50%",
            transform: "translateY(-50%)",
            width: 20,
            height: 20,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: "var(--radius-control)",
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
            transition: "color var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <FileText size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function DirectoryRow({
  node,
  depth,
  expanded,
  label,
  onToggle,
}: {
  node: GitFileTreeDirectoryNode;
  depth: number;
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="ui-focus-ring"
      onClick={onToggle}
      aria-expanded={expanded}
      title={node.path}
      aria-label={label}
      style={{
        ...ROW_BASE_STYLE,
        paddingLeft: 10 + depth * 14,
        color: "var(--text-muted)",
        background: "transparent",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-subtle)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
    >
      <ChevronRight
        size={10}
        strokeWidth={2}
        aria-hidden="true"
        style={{
          flexShrink: 0,
          transform: expanded ? "rotate(90deg)" : "none",
          transition: "transform var(--dur-fast) var(--ease-out-warm)",
        }}
      />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {node.name}
      </span>
    </button>
  );
}

export function GitPanel({ cwd, active, refreshKey, onOpenFile, onCountChange, onMetaChange }: GitPanelProps): ReactElement | null {
  const { t, tn } = useI18n();
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiffResponse | null>(null);
  const [view, setView] = useState<GitFileView>("list");
  // Collapsed rather than expanded: directories that appear in a later status
  // refresh then default to open, matching "all expanded" without having to
  // seed state for every new path.
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set());

  const mountedRef = useRef(true);
  const statusSeqRef = useRef(0);
  const statusInFlightRef = useRef(false);
  const statusQueuedRef = useRef(false);
  const statusAbortRef = useRef<AbortController | null>(null);
  const diffSeqRef = useRef(0);
  const diffAbortRef = useRef<AbortController | null>(null);
  const refetchStatusRef = useRef<() => void>(() => {});

  // Held in a ref so a parent that re-creates the callback each render cannot
  // re-trigger the fetch effects below.
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;
  const onMetaChangeRef = useRef(onMetaChange);
  onMetaChangeRef.current = onMetaChange;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      statusAbortRef.current?.abort();
      diffAbortRef.current?.abort();
    };
  }, []);

  // The stored view is read after mount: reading localStorage during render
  // would make the server and client markup disagree.
  useEffect(() => {
    setView(readStoredView());
  }, []);

  const selectView = useCallback((next: GitFileView) => {
    setView(next);
    storeView(next);
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!cwd) return;
    // De-dupe: a refresh requested mid-flight is remembered and replayed once
    // the in-flight response lands, so no trigger is silently dropped.
    if (statusInFlightRef.current) {
      statusQueuedRef.current = true;
      return;
    }
    const seq = ++statusSeqRef.current;
    statusInFlightRef.current = true;
    statusAbortRef.current?.abort();
    const controller = new AbortController();
    statusAbortRef.current = controller;
    setLoading(true);

    try {
      const params = new URLSearchParams({ cwd });
      const response = await fetch(`/api/git/status?${params.toString()}`, { signal: controller.signal });
      // A proxy or crash can answer with HTML: fall back to the status-code
      // message rather than surfacing a JSON parse error to the user.
      const body = await response.json().catch(() => ({})) as GitStatusResponse & { error?: string };
      if (seq !== statusSeqRef.current || !mountedRef.current) return;
      if (!response.ok) {
        // Keep the last good list on screen; the banner explains why it may be stale.
        setStatusError(body.error ?? translate("gitPanel.statusFailed", { status: response.status }));
        return;
      }
      setStatusError(null);
      setStatus(body);
      onCountChangeRef.current?.(body.isGitRepository ? body.files.length : null);
      onMetaChangeRef.current?.(body.isGitRepository
        ? { branch: body.branchInfo?.branch ?? null, repoRoot: body.repositoryRoot }
        : null);
    } catch (error) {
      if (controller.signal.aborted || seq !== statusSeqRef.current || !mountedRef.current) return;
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      // A superseded request no longer owns these flags — whoever bumped the
      // sequence (a newer fetch, or a cwd change) is responsible for them now.
      if (seq === statusSeqRef.current) {
        statusInFlightRef.current = false;
        if (mountedRef.current) setLoading(false);
        if (statusQueuedRef.current && mountedRef.current) {
          statusQueuedRef.current = false;
          refetchStatusRef.current();
        }
      }
    }
  }, [cwd]);

  refetchStatusRef.current = () => { void fetchStatus(); };

  const fetchDiff = useCallback(async (targetPath: string) => {
    if (!cwd) return;
    const seq = ++diffSeqRef.current;
    diffAbortRef.current?.abort();
    const controller = new AbortController();
    diffAbortRef.current = controller;

    try {
      const params = new URLSearchParams({ cwd, path: targetPath });
      const response = await fetch(`/api/git/diff?${params.toString()}`, { signal: controller.signal });
      const body = await response.json().catch(() => ({})) as GitFileDiffResponse & { error?: string };
      if (seq !== diffSeqRef.current || !mountedRef.current) return;
      // A failed diff is shown as "no diff available" instead of its own error
      // banner: the file list is still valid and one unreadable file is not a
      // reason to make the whole panel look broken.
      setDiff(response.ok && typeof body.supported === "boolean" ? body : { supported: false });
    } catch {
      if (controller.signal.aborted || seq !== diffSeqRef.current || !mountedRef.current) return;
      setDiff({ supported: false });
    }
  }, [cwd]);

  // A new workspace shares nothing with the old one: invalidate every in-flight
  // request and drop the list, selection and diff before the first fetch, so
  // neither a stale row nor a late response for the old cwd survives the switch.
  useEffect(() => {
    statusSeqRef.current += 1;
    statusAbortRef.current?.abort();
    statusAbortRef.current = null;
    statusInFlightRef.current = false;
    statusQueuedRef.current = false;
    diffSeqRef.current += 1;
    diffAbortRef.current?.abort();
    diffAbortRef.current = null;

    setStatus(null);
    setStatusError(null);
    setSelectedPath(null);
    setDiff(null);
    setCollapsedDirectories(new Set());
    if (!cwd) {
      setLoading(false);
      onCountChangeRef.current?.(null);
      onMetaChangeRef.current?.(null);
    }
  }, [cwd]);

  // Status refetches on cwd change and on every refreshKey bump, active or not:
  // it is one cheap request and it keeps the tab badge honest.
  useEffect(() => {
    if (!cwd) return;
    void fetchStatus();
  }, [cwd, fetchStatus, refreshKey]);

  // The selected file's diff must follow agent turns too, or the pane shows a
  // pre-edit patch beside a fresh file list. While the panel is hidden the
  // refetch is deferred (no git shell-outs for an invisible diff) and runs on
  // the next activation instead.
  const selectedPathRef = useRef<string | null>(null);
  selectedPathRef.current = selectedPath;
  const diffRefreshedForRef = useRef(refreshKey);
  useEffect(() => {
    if (!cwd || selectedPathRef.current === null) {
      // Nothing selected: a later selection fetches fresh anyway.
      diffRefreshedForRef.current = refreshKey;
      return;
    }
    if (!active) return;
    if (diffRefreshedForRef.current === refreshKey) return;
    diffRefreshedForRef.current = refreshKey;
    void fetchDiff(selectedPathRef.current);
  }, [active, cwd, fetchDiff, refreshKey]);

  // Focus refetch only while visible — a background panel does not need to
  // re-shell out to git every time the window is tabbed back to.
  useEffect(() => {
    if (!cwd || !active) return;
    const onFocus = () => { void fetchStatus(); };
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("focus", onFocus); };
  }, [active, cwd, fetchStatus]);

  const repositoryRoot = status?.repositoryRoot ?? cwd ?? undefined;

  const entries = useMemo((): ChangedEntry[] => {
    if (!status?.isGitRepository) return [];
    return status.files.map((file) => ({
      file,
      relativePath: getRelativeFilePath(file.filePath, repositoryRoot),
    }));
  }, [repositoryRoot, status]);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.file.filePath === selectedPath) ?? null,
    [entries, selectedPath],
  );

  // A file can stop being changed between refreshes (reverted, committed,
  // stashed): drop the selection rather than show a diff for a row that is gone.
  useEffect(() => {
    if (selectedPath === null || status === null) return;
    if (entries.some((entry) => entry.file.filePath === selectedPath)) return;
    setSelectedPath(null);
    setDiff(null);
    diffSeqRef.current += 1;
    diffAbortRef.current?.abort();
  }, [entries, selectedPath, status]);

  const treeNodes = useMemo(
    () => buildGitFileTree(entries.map((entry) => entry.relativePath)),
    [entries],
  );

  const entriesByRelativePath = useMemo(
    () => new Map(entries.map((entry) => [entry.relativePath, entry])),
    [entries],
  );

  // Forget collapse state for directories that no longer exist, so a path that
  // comes back later comes back expanded like every other new directory.
  useEffect(() => {
    setCollapsedDirectories((current) => {
      if (current.size === 0) return current;
      const existing = new Set(collectGitFileTreeDirectoryPaths(treeNodes));
      const next = new Set([...current].filter((path) => existing.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [treeNodes]);

  const selectFile = useCallback((entry: ChangedEntry) => {
    setSelectedPath(entry.file.filePath);
    setDiff(null);
    void fetchDiff(entry.file.filePath);
  }, [fetchDiff]);

  const toggleDirectory = useCallback((path: string) => {
    setCollapsedDirectories((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    void fetchStatus();
    // The selected file's diff can have moved on too; a manual refresh is an
    // explicit "show me current" gesture, so re-pull it as well.
    if (selectedPath !== null) void fetchDiff(selectedPath);
  }, [fetchDiff, fetchStatus, selectedPath]);

  // Write side: stage/unstage/discard/commit. One mutation at a time; every
  // outcome (success or failure) ends in a status refresh so the list always
  // shows what git now thinks.
  const [mutating, setMutating] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const mutate = useCallback(async (action: "stage" | "unstage" | "discard" | "commit", filePath?: string, message?: string): Promise<boolean> => {
    if (!cwd || mutating) return false;
    setMutating(true);
    try {
      const response = await fetch("/api/git/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, action, path: filePath, message }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!mountedRef.current) return false;
      if (!response.ok) {
        setStatusError(body.error ?? translate("gitPanel.mutationFailed"));
        return false;
      }
      setStatusError(null);
      return true;
    } catch (error) {
      if (mountedRef.current) setStatusError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (mountedRef.current) {
        setMutating(false);
        void fetchStatus();
        if (selectedPathRef.current !== null) void fetchDiff(selectedPathRef.current);
      }
    }
  }, [cwd, fetchDiff, fetchStatus, mutating]);

  const stageFile = useCallback((entry: ChangedEntry) => { void mutate("stage", entry.file.filePath); }, [mutate]);
  const unstageFile = useCallback((entry: ChangedEntry) => { void mutate("unstage", entry.file.filePath); }, [mutate]);
  const discardFile = useCallback((entry: ChangedEntry) => {
    const untracked = entry.file.status === "untracked";
    const prompt = untracked
      ? translate("gitPanel.discardConfirmUntracked", { path: entry.relativePath })
      : translate("gitPanel.discardConfirm", { path: entry.relativePath });
    if (!window.confirm(prompt)) return;
    void mutate("discard", entry.file.filePath);
  }, [mutate]);
  const commit = useCallback(() => {
    const message = commitMessage.trim();
    if (!message) return;
    void mutate("commit", undefined, message).then((ok) => {
      if (ok && mountedRef.current) setCommitMessage("");
    });
  }, [commitMessage, mutate]);

  /** The controls a row offers, derived from which sides of the status are
   * dirty. In the sectioned list the section narrows this further. */
  const rowActions = useCallback((entry: ChangedEntry, section: "staged" | "changes" | "all"): RowAction[] => {
    const staged = entry.file.indexStatus !== " " && entry.file.indexStatus !== "?";
    const unstaged = entry.file.worktreeStatus !== " " || entry.file.status === "untracked";
    const actions: RowAction[] = [];
    if (section !== "staged" && unstaged) {
      actions.push({ key: "discard", label: translate("gitPanel.discard"), icon: <Undo2 size={12} strokeWidth={2.2} aria-hidden="true" />, onClick: () => discardFile(entry) });
      actions.push({ key: "stage", label: translate("gitPanel.stage"), icon: <Plus size={13} strokeWidth={2.2} aria-hidden="true" />, onClick: () => stageFile(entry) });
    }
    if (section !== "changes" && staged) {
      actions.push({ key: "unstage", label: translate("gitPanel.unstage"), icon: <Minus size={13} strokeWidth={2.2} aria-hidden="true" />, onClick: () => unstageFile(entry) });
    }
    return actions;
  }, [discardFile, stageFile, unstageFile]);

  const openLabel = t("gitPanel.openInFiles");

  const renderFileRow = useCallback((entry: ChangedEntry, depth: number, directoryPrefix: string, name: string, section: "staged" | "changes" | "all" = "all") => (
    <FileRow
      key={`${section}:${entry.file.filePath}`}
      entry={entry}
      depth={depth}
      directoryPrefix={directoryPrefix}
      name={name}
      selected={entry.file.filePath === selectedPath}
      onSelect={() => selectFile(entry)}
      onOpen={onOpenFile ? () => onOpenFile(entry.file.filePath) : undefined}
      openLabel={openLabel}
      statusLabel={t(STATUS_LABEL_KEYS[entry.file.status])}
      actions={rowActions(entry, section)}
      actionsDisabled={mutating}
    />
  ), [mutating, onOpenFile, openLabel, rowActions, selectFile, selectedPath, t]);

  const renderTreeNodes = useCallback((nodes: readonly GitFileTreeNode[], depth: number): ReactNode[] => (
    nodes.flatMap((node) => {
      if (node.kind === "file") {
        const entry = entriesByRelativePath.get(node.path);
        return entry ? [renderFileRow(entry, depth, "", node.name)] : [];
      }
      const expanded = !collapsedDirectories.has(node.path);
      return [
        <DirectoryRow
          key={node.path}
          node={node}
          depth={depth}
          expanded={expanded}
          label={expanded
            ? t("gitPanel.collapseDirectory", { name: node.name })
            : t("gitPanel.expandDirectory", { name: node.name })}
          onToggle={() => toggleDirectory(node.path)}
        />,
        ...(expanded ? renderTreeNodes(node.children, depth + 1) : []),
      ];
    })
  ), [collapsedDirectories, entriesByRelativePath, renderFileRow, t, toggleDirectory]);

  const branchInfo = status?.branchInfo;
  const isRepository = status?.isGitRepository === true;
  const changedCount = entries.length;

  const renderDiff = (): ReactNode => {
    if (selectedEntry === null) return <CenteredHint>{t("gitPanel.selectFile")}</CenteredHint>;
    // In flight: stay blank rather than flash a message the next paint replaces.
    if (diff === null) return null;
    const patch = diff.supported ? diff.patch : undefined;
    if (typeof patch === "string" && patch.length > 0) return <DiffView patch={patch} />;
    // "Unsupported" covers deleted, binary and over-size files alike, so the
    // file's own status is what distinguishes a deletion from the rest.
    const deleted = selectedEntry.file.status === "deleted" || diff.status === "deleted";
    return (
      <CenteredHint>
        {deleted ? t("gitPanel.diffDeleted") : diff.supported ? t("gitPanel.noDiff") : t("gitPanel.diffUnsupported")}
      </CenteredHint>
    );
  };

  const renderBody = (): ReactNode => {
    if (!cwd) return <CenteredHint>{t("gitPanel.selectWorkspace")}</CenteredHint>;
    // Nothing loaded yet: a hint while the first fetch runs, and nothing at all
    // once it has failed — the error banner above already says what happened.
    if (status === null) return loading ? <CenteredHint>{t("gitPanel.loadingStatus")}</CenteredHint> : null;
    if (!isRepository) return <CenteredHint>{t("gitPanel.notARepository")}</CenteredHint>;
    if (changedCount === 0) {
      return (
        <CenteredHint>
          <Check size={13} strokeWidth={2.2} color="var(--status-success)" aria-hidden="true" />
          {t("gitPanel.noChanges")}
        </CenteredHint>
      );
    }

    const listRow = (entry: ChangedEntry, section: "staged" | "changes" | "all") => {
      const separator = entry.relativePath.lastIndexOf("/");
      return renderFileRow(
        entry,
        0,
        separator >= 0 ? entry.relativePath.slice(0, separator + 1) : "",
        separator >= 0 ? entry.relativePath.slice(separator + 1) : entry.relativePath,
        section,
      );
    };
    const stagedEntries = entries.filter((entry) => entry.file.indexStatus !== " " && entry.file.indexStatus !== "?");
    const changedEntries = entries.filter((entry) => entry.file.worktreeStatus !== " " || entry.file.status === "untracked");
    const sectioned = view === "list" && stagedEntries.length > 0;
    const sectionHeading = (label: string, count: number) => (
      <div style={{ padding: "5px 10px 2px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)" }}>
        {label} · {count}
      </div>
    );

    return (
      <>
        {stagedEntries.length > 0 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0, padding: "6px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
            <input
              type="text"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
              placeholder={t("gitPanel.commitPlaceholder")}
              aria-label={t("gitPanel.commitPlaceholder")}
              disabled={mutating}
              style={{ flex: 1, minWidth: 0, padding: "4px 8px", fontSize: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)" }}
            />
            <button
              type="button"
              className="ui-focus-ring"
              onClick={commit}
              disabled={mutating || commitMessage.trim() === ""}
              style={{ flexShrink: 0, padding: "4px 10px", fontSize: 12, fontWeight: 600, border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--accent)", cursor: mutating || commitMessage.trim() === "" ? "default" : "pointer", opacity: mutating || commitMessage.trim() === "" ? 0.5 : 1 }}
            >
              {tn("gitPanel.commitStaged", stagedEntries.length)}
            </button>
          </div>
        )}
        <div
          role="group"
          aria-label={t("gitPanel.changedFilesLabel")}
          style={{
            flex: "0 0 auto",
            maxHeight: "38%",
            overflowY: "auto",
            padding: "2px 0",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {view === "tree"
            ? renderTreeNodes(treeNodes, 0)
            : sectioned
              ? (
                <>
                  {sectionHeading(t("gitPanel.stagedSection"), stagedEntries.length)}
                  {stagedEntries.map((entry) => listRow(entry, "staged"))}
                  {changedEntries.length > 0 && sectionHeading(t("gitPanel.changesSection"), changedEntries.length)}
                  {changedEntries.map((entry) => listRow(entry, "changes"))}
                </>
              )
              : entries.map((entry) => listRow(entry, "all"))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "auto" }}>
          {renderDiff()}
        </div>
      </>
    );
  };

  return (
    <section
      aria-label={t("gitPanel.title")}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
          padding: "6px 10px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
          fontSize: 12,
        }}
      >
        <GitBranch size={13} strokeWidth={2} color="var(--text-muted)" aria-hidden="true" style={{ flexShrink: 0 }} />
        {branchInfo ? (
          <span
            title={branchInfo.branch ?? undefined}
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-mono)",
              color: "var(--text)",
            }}
          >
            {branchInfo.detached
              ? t("gitPanel.detachedAt", { hash: branchInfo.branch ?? "" })
              : branchInfo.branch ?? t("gitPanel.noBranch")}
          </span>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>{t("gitPanel.title")}</span>
        )}

        {branchInfo?.upstream && (branchInfo.ahead > 0 || branchInfo.behind > 0) && (
          <span
            title={branchInfo.upstream}
            aria-label={t("gitPanel.aheadBehind", {
              ahead: branchInfo.ahead,
              behind: branchInfo.behind,
              upstream: branchInfo.upstream,
            })}
            style={{ flexShrink: 0, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
          >
            {branchInfo.ahead > 0 && `↑${branchInfo.ahead}`}
            {branchInfo.ahead > 0 && branchInfo.behind > 0 && " "}
            {branchInfo.behind > 0 && `↓${branchInfo.behind}`}
          </span>
        )}

        <span style={{ flex: 1 }} />

        {isRepository && (
          <span
            title={tn("gitPanel.changedFiles", changedCount)}
            aria-label={tn("gitPanel.changedFiles", changedCount)}
            style={{ flexShrink: 0, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}
          >
            {changedCount}
          </span>
        )}

        {isRepository && changedCount > 0 && (
          <span role="group" aria-label={t("gitPanel.fileView")} style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            <HeaderButton label={t("gitPanel.viewList")} pressed={view === "list"} onClick={() => selectView("list")}>
              <List size={13} strokeWidth={2} aria-hidden="true" />
            </HeaderButton>
            <HeaderButton label={t("gitPanel.viewTree")} pressed={view === "tree"} onClick={() => selectView("tree")}>
              <ListTree size={13} strokeWidth={2} aria-hidden="true" />
            </HeaderButton>
          </span>
        )}

        <HeaderButton label={t("gitPanel.refresh")} disabled={!cwd || loading} onClick={refresh}>
          <RotateCw
            size={13}
            strokeWidth={2}
            aria-hidden="true"
            style={loading ? { animation: "spin 0.8s linear infinite" } : undefined}
          />
        </HeaderButton>
      </div>

      {statusError && (
        <div
          role="alert"
          style={{
            flexShrink: 0,
            padding: "5px 10px",
            borderBottom: "1px solid var(--border)",
            background: "color-mix(in srgb, var(--status-error) 9%, var(--bg-panel))",
            color: "var(--status-error)",
            fontSize: 11,
            lineHeight: 1.4,
            overflowWrap: "anywhere",
          }}
        >
          {statusError}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>{renderBody()}</div>
    </section>
  );
}
