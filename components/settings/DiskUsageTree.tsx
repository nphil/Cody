"use client";

/**
 * The folder list under Settings › Disk space › What is using space: biggest
 * first, a share bar against the folder above, a label saying what is safe, and
 * the one action that label allows. Everything the label allows is decided by
 * the server (lib/disk/usage-rules.ts); this file only draws it.
 */
import { ChevronDown, ChevronRight, FolderOpen, Loader2, Trash2 } from "lucide-react";
import { useContext, useState, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/format-bytes";
import { requestShowInFiles } from "@/lib/show-in-files";
import type { UsageKind, UsageNode } from "@/lib/disk/usage-types";
import { smallButtonStyle } from "./account-controls";
import { dimLineStyle } from "./EngineRoster";
import { BlobsPanel, ChatsPanel } from "./DiskUsageExtras";
import { ShellContext } from "./shell-context";

export const KIND_COLORS: Record<UsageKind, string> = {
  rebuild: "var(--status-success)",
  cache: "var(--accent)",
  engine: "var(--status-warning)",
  "engine-keep": "var(--text-dim)",
  mine: "var(--text-muted)",
};

export interface TreeActions {
  now: number;
  canEdit: boolean;
  /** The path whose clear check or clear is running. */
  busyPath: string | null;
  onClear: (path: string) => void;
  onCleanNow: () => void;
  cleaning: boolean;
  /** Something freed space (a chat, blobs): the totals are out of date. */
  onChanged: () => void;
}

export function KindBadge({ kind }: { kind: UsageKind }) {
  const { t } = useI18n();
  const color = KIND_COLORS[kind];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0 7px",
        border: `1px solid color-mix(in srgb, ${color} 55%, transparent)`,
        borderRadius: 999,
        color,
        fontSize: 11,
        lineHeight: "18px",
        whiteSpace: "nowrap",
      }}
    >
      {t(`diskUsage.kind.${kind}`)}
    </span>
  );
}

export function ShareBar({ fraction, kind }: { fraction: number; kind: UsageKind }) {
  const percent = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div aria-hidden="true" style={{ height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
      <div style={{ width: `${percent}%`, minWidth: percent > 0 ? 2 : 0, height: "100%", background: KIND_COLORS[kind] }} />
    </div>
  );
}

function ChangedLabel({ changedMs, now }: { changedMs: number; now: number }) {
  const { t, locale } = useI18n();
  const when = changedMs > 0 ? formatRelativeTime(new Date(changedMs).toISOString(), locale, now) : null;
  return <>{when ? t("diskUsage.changed", { when }) : t("diskUsage.changedUnknown")}</>;
}

const metaStyle: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: "var(--text-muted)" };

/** Whether opening the row shows anything: what is inside, or what the label allows. */
function hasDetail(node: UsageNode): boolean {
  const labelled = !node.inherited && node.rule !== undefined;
  const inside = (node.children?.length ?? 0) > 0 || (node.otherCount ?? 0) > 0;
  return labelled || node.inFiles === true || inside;
}

function NodeDetail({ node, actions, depth }: { node: UsageNode; actions: TreeActions; depth: number }) {
  const { t } = useI18n();
  const [showChats, setShowChats] = useState(false);
  const shell = useContext(ShellContext);
  const labelled = !node.inherited && node.rule !== undefined;
  const clearing = actions.busyPath === node.path;

  const showInFiles = () => {
    requestShowInFiles(node.path);
    shell?.callbacks.onClose();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 0 4px", minWidth: 0 }}>
      <span style={{ ...dimLineStyle, overflowWrap: "anywhere" }}>{node.path}</span>
      {labelled && node.rule && <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t(`diskUsage.rule.${node.rule}`)}</span>}
      {labelled && node.kind === "mine" && depth <= 2 && <span style={dimLineStyle}>{t("diskUsage.mineNote")}</span>}
      {labelled && node.action === "janitor" && <span style={dimLineStyle}>{t("diskUsage.janitorNote")}</span>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {node.deletable && actions.canEdit && (
          <button
            type="button"
            className="ui-focus-ring"
            disabled={actions.busyPath !== null}
            aria-busy={clearing}
            onClick={() => actions.onClear(node.path)}
            style={{ ...smallButtonStyle, color: "var(--status-error)", opacity: actions.busyPath !== null ? 0.6 : 1 }}
          >
            {clearing ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
            {clearing ? t("diskUsage.checking") : t("diskUsage.clear")}
          </button>
        )}
        {node.inFiles && shell && (
          <button type="button" className="ui-focus-ring" onClick={showInFiles} style={smallButtonStyle}>
            <FolderOpen size={13} aria-hidden="true" />
            {t("diskUsage.showInFiles")}
          </button>
        )}
        {node.action === "chats" && actions.canEdit && (
          <button type="button" className="ui-focus-ring" aria-expanded={showChats} onClick={() => setShowChats((open) => !open)} style={smallButtonStyle}>
            {t(showChats ? "diskUsage.chats.hide" : "diskUsage.chats.show")}
          </button>
        )}
        {node.action === "janitor" && actions.canEdit && (
          <button type="button" className="ui-focus-ring" disabled={actions.cleaning} aria-busy={actions.cleaning} onClick={actions.onCleanNow} style={{ ...smallButtonStyle, opacity: actions.cleaning ? 0.6 : 1 }}>
            {actions.cleaning ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
            {t("diskUsage.cleanNow")}
          </button>
        )}
      </div>
      {node.action === "chats" && showChats && <ChatsPanel now={actions.now} onChanged={actions.onChanged} />}
      {node.action === "blobs" && actions.canEdit && <BlobsPanel onFreed={actions.onChanged} />}
    </div>
  );
}

export function NodeRow({ node, depth, parentBytes, actions }: { node: UsageNode; depth: number; parentBytes: number; actions: TreeActions }) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(false);
  const expandable = hasDetail(node);
  const showBadge = !node.inherited && (node.kind !== "mine" || depth <= 1);
  const children = node.children ?? [];
  const label = open ? "diskUsage.collapse" : "diskUsage.expand";
  const body = (
    <>
      {expandable
        ? (open ? <ChevronDown size={13} aria-hidden="true" style={{ flexShrink: 0 }} /> : <ChevronRight size={13} aria-hidden="true" style={{ flexShrink: 0 }} />)
        : <span style={{ width: 13, flexShrink: 0 }} />}
      <span style={{ minWidth: 0, overflowWrap: "anywhere", fontSize: 12, fontWeight: depth === 0 ? 600 : 400 }}>{node.name}{node.dir ? "/" : ""}</span>
    </>
  );

  return (
    <li style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, paddingTop: 3 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "2px 10px", flexWrap: "wrap", minWidth: 0 }}>
        {expandable
          ? (
            <button
              type="button"
              className="ui-focus-ring"
              aria-expanded={open}
              aria-label={t(label, { name: node.name })}
              onClick={() => setOpen((value) => !value)}
              style={{ flex: "1 1 160px", minWidth: 0, display: "flex", alignItems: "center", gap: 4, padding: "2px 0", border: "none", background: "none", color: "var(--text)", textAlign: "left", cursor: "pointer" }}
            >
              {body}
            </button>
          )
          : <div style={{ flex: "1 1 160px", minWidth: 0, display: "flex", alignItems: "center", gap: 4, padding: "2px 0" }}>{body}</div>}
        <span style={metaStyle}>
          {showBadge && <KindBadge kind={node.kind} />}
          <span style={{ color: "var(--text)", fontWeight: 600 }}>{formatBytes(node.bytes)}</span>
          <span><ChangedLabel changedMs={node.changedMs} now={actions.now} /></span>
        </span>
      </div>
      <ShareBar fraction={parentBytes > 0 ? node.bytes / parentBytes : 0} kind={node.kind} />
      {open && (
        <div style={{ paddingLeft: 14, minWidth: 0 }}>
          {hasDetail(node) && <NodeDetail node={node} actions={actions} depth={depth} />}
          {children.length > 0 && <NodeList nodes={children} depth={depth + 1} parentBytes={node.bytes} actions={actions} />}
          {(node.otherCount ?? 0) > 0 && (
            <div style={{ ...dimLineStyle, paddingTop: 4 }}>
              {tn("diskUsage.other", node.otherCount ?? 0)} · {formatBytes(node.otherBytes ?? 0)}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function NodeList({ nodes, depth, parentBytes, actions }: { nodes: UsageNode[]; depth: number; parentBytes: number; actions: TreeActions }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      {nodes.map((node) => (
        <NodeRow key={node.path} node={node} depth={depth} parentBytes={parentBytes} actions={actions} />
      ))}
    </ul>
  );
}
