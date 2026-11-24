"use client";

/**
 * The two engine-data helpers under Settings › Disk space › What is using
 * space: the per-chat size list (delete through the sidebar's own
 * `DELETE /api/sessions/<id>`), and the engine's unused-blob sweep
 * (`omp gc --blobs`). Neither deletes by path.
 */
import { Check, Eraser, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { invalidateSettingsRoutes } from "@/hooks/useSettingsData";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/format-bytes";
import type { UsageChat, UsageChatsPayload } from "@/lib/disk/usage-types";
import { ApiError, ErrorNote, requestJson, smallButtonStyle } from "./account-controls";
import { dimLineStyle } from "./EngineRoster";

type ChatSort = "size" | "oldest";

export function ChatsPanel({ now, onChanged }: { now: number; onChanged: () => void }) {
  const { t, tn, locale } = useI18n();
  const [sort, setSort] = useState<ChatSort>("size");
  const [data, setData] = useState<UsageChatsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<UsageChat | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback((which: ChatSort) => {
    return requestJson<UsageChatsPayload>(`/api/disk/chats?sort=${which}`)
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  }, []);

  useEffect(() => {
    void load(sort);
  }, [load, sort]);

  const remove = () => {
    if (!pending) return;
    setDeleting(true);
    void requestJson(`/api/sessions/${encodeURIComponent(pending.id)}`, { method: "DELETE" })
      .then(() => {
        toast.success(t("diskUsage.chats.deleted"));
        setPending(null);
        invalidateSettingsRoutes("/api/disk", { exact: true });
        onChanged();
        return load(sort);
      })
      .catch((failure: unknown) => toast.error(t("diskUsage.chats.deleteFailed"), failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setDeleting(false));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {(["size", "oldest"] as const).map((which) => (
          <button
            key={which}
            type="button"
            className="ui-focus-ring"
            aria-pressed={sort === which}
            onClick={() => setSort(which)}
            style={{ ...smallButtonStyle, ...(sort === which ? { borderColor: "var(--accent)", background: "var(--accent-subtle, transparent)" } : {}) }}
          >
            {t(which === "size" ? "diskUsage.chats.sizeSort" : "diskUsage.chats.oldSort")}
          </button>
        ))}
        {data && <span style={dimLineStyle}>{tn("diskUsage.chats.summary", data.count, { size: formatBytes(data.totalBytes) })}</span>}
      </div>
      {!data && !error && <span style={dimLineStyle}><Loader2 size={12} className="icon-spin" aria-hidden="true" /></span>}
      {data && data.chats.length === 0 && <span style={dimLineStyle}>{t("diskUsage.chats.empty")}</span>}
      {data && data.chats.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {data.chats.map((chat) => (
            <li key={chat.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, minWidth: 0 }}>
              <span style={{ flex: "1 1 160px", minWidth: 0, overflowWrap: "anywhere" }}>{chat.title}</span>
              <span style={{ color: "var(--text-muted)" }}>
                {formatBytes(chat.bytes)} · {formatRelativeTime(new Date(chat.modifiedMs).toISOString(), locale, now) ?? "?"}
              </span>
              <button type="button" className="ui-focus-ring" onClick={() => setPending(chat)} style={{ ...smallButtonStyle, color: "var(--status-error)" }}>
                <Trash2 size={12} aria-hidden="true" />
                {t("diskUsage.chats.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote message={error} />
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => { if (!open && !deleting) setPending(null); }}
        title={t("diskUsage.chats.deleteTitle")}
        description={pending ? t("diskUsage.chats.deleteBody", { title: pending.title, size: formatBytes(pending.bytes) }) : undefined}
        confirmLabel={t("diskUsage.chats.delete")}
        cancelLabel={t("chatWindow.cancel")}
        danger
        busy={deleting}
        onConfirm={remove}
      />
    </div>
  );
}

interface BlobAnswer {
  apply: boolean;
  blobs: number;
  bytes: number;
  errors: string[];
}

export function BlobsPanel({ onFreed }: { onFreed: () => void }) {
  const { t, tn } = useI18n();
  const [phase, setPhase] = useState<"idle" | "checking" | "freeing">("idle");
  const [preview, setPreview] = useState<BlobAnswer | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (apply: boolean) => {
    setPhase(apply ? "freeing" : "checking");
    setError(null);
    void requestJson<BlobAnswer>("/api/disk/blobs", { method: apply ? "POST" : "GET" })
      .then((answer) => {
        if (!apply) {
          setPreview(answer);
          return;
        }
        setPreview(null);
        toast.success(t("diskUsage.blobs.freed", { size: formatBytes(answer.bytes) }));
        onFreed();
      })
      .catch((failure: unknown) => {
        if (failure instanceof ApiError && failure.code === "unsupported") setUnsupported(true);
        else setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => setPhase("idle"));
  };

  if (unsupported) return <span style={dimLineStyle}>{t("diskUsage.blobs.unsupported")}</span>;
  const busy = phase !== "idle";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      {preview && (
        <span style={{ fontSize: 12 }} role="status">
          {preview.blobs === 0 ? t("diskUsage.blobs.none") : tn("diskUsage.blobs.found", preview.blobs, { size: formatBytes(preview.bytes) })}
        </span>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="ui-focus-ring" onClick={() => run(false)} disabled={busy} aria-busy={phase === "checking"} style={{ ...smallButtonStyle, opacity: busy ? 0.6 : 1 }}>
          {phase === "checking" ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
          {t("diskUsage.blobs.check")}
        </button>
        {preview && preview.blobs > 0 && (
          <button type="button" className="ui-focus-ring" onClick={() => run(true)} disabled={busy} aria-busy={phase === "freeing"} style={{ ...smallButtonStyle, opacity: busy ? 0.6 : 1 }}>
            {phase === "freeing" ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Eraser size={13} aria-hidden="true" />}
            {t("diskUsage.blobs.free")}
          </button>
        )}
      </div>
      <ErrorNote message={error} />
    </div>
  );
}
