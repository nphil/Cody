"use client";

/**
 * Settings › System › Disk space › What is using space. Reads the cached scan
 * (`GET /api/disk/usage`), starts a new one on request, and walks the person
 * from "this disk is full" to the folders that fill it, each labelled with what
 * is safe to do. Clearing always asks the server for the exact size first
 * (`preview`), and the server decides again with the live disk when confirmed.
 */
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { invalidateSettingsRoutes } from "@/hooks/useSettingsData";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/format-bytes";
import type { ClearAnswer, ClearManyAnswer, ClearPlan, ClearRefusal, UsageCandidate, UsagePayload, UsageRoot, UsageVolume } from "@/lib/disk/usage-types";
import { ApiError, ErrorNote, requestJson, smallButtonStyle } from "./account-controls";
import { dimLineStyle } from "./EngineRoster";
import { KindBadge, NodeList, type TreeActions } from "./DiskUsageTree";

const ROUTE = "/api/disk/usage";
const POLL_MS = 3_000;
const LISTED_CANDIDATES = 10;
const DAY_MS = 86_400_000;

const post = <T,>(body: Record<string, unknown>) =>
  requestJson<T>(ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

interface DiskUsageProps {
  /** Volumes worth a tab: just "data" when temp and data share one disk. */
  volumes: readonly UsageVolume[];
  canEdit: boolean;
  /** Bytes the disk reports used per volume, to show what the scan could not account for. */
  usedBytes: Partial<Record<UsageVolume, number>>;
  onCleanNow: () => void;
  cleaning: boolean;
}

export function DiskUsage({ volumes, canEdit, usedBytes, onCleanNow, cleaning }: DiskUsageProps) {
  const { t, locale } = useI18n();
  const [volume, setVolume] = useState<UsageVolume>(volumes[0] ?? "data");
  const [payload, setPayload] = useState<UsagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [checking, setChecking] = useState<string | null>(null);
  const [plan, setPlan] = useState<ClearPlan | null>(null);
  const [clearing, setClearing] = useState(false);
  const [olderOpen, setOlderOpen] = useState(false);

  const load = useCallback(
    () =>
      requestJson<UsagePayload>(`${ROUTE}?volume=${volume}`)
        .then((next) => {
          setPayload(next);
          setNow(Date.now());
          setError(null);
        })
        .catch((failure: unknown) => setError(failure instanceof ApiError && failure.code === "admin_required" ? t("diskUsage.adminOnly") : failure instanceof Error ? failure.message : String(failure))),
    [volume, t],
  );

  useEffect(() => {
    if (!canEdit) return;
    setPayload(null);
    void load();
  }, [canEdit, load]);

  const running = payload?.scan.running === true;
  useEffect(() => {
    if (!canEdit) return;
    // A page left open on a phone shows old numbers: look again when it comes back to the front, and while a scan runs.
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", refresh);
    const timer = running ? setInterval(refresh, POLL_MS) : undefined;
    const clock = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(timer);
      clearInterval(clock);
    };
  }, [canEdit, running, load]);

  if (!canEdit) return <div style={dimLineStyle}>{t("diskUsage.adminOnly")}</div>;

  const refusalText = (refused: ClearRefusal) => t(`diskUsage.refused.${refused.code}`, { minutes: refused.detail ?? "" });

  const rescan = () => {
    setStarting(true);
    void post<UsagePayload>({ action: "scan", volume })
      .then((next) => {
        setPayload(next);
        setNow(Date.now());
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setStarting(false));
  };

  const afterFreed = () => {
    invalidateSettingsRoutes("/api/disk", { exact: true });
    void load();
  };

  const checkClear = (path: string) => {
    setChecking(path);
    void post<ClearAnswer>({ action: "preview", path })
      .then((answer) => {
        if (answer.plan) setPlan(answer.plan);
        else toast.error(t("diskUsage.clearFailed"), answer.refused ? refusalText(answer.refused) : undefined);
      })
      .catch((failure: unknown) => toast.error(t("diskUsage.clearFailed"), failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setChecking(null));
  };

  const confirmClear = () => {
    if (!plan) return;
    setClearing(true);
    void post<ClearAnswer>({ action: "clear", path: plan.path })
      .then((answer) => {
        setPlan(null);
        if (answer.refused) toast.error(t("diskUsage.clearFailed"), refusalText(answer.refused));
        else if (answer.cleared) toast.success(t("diskUsage.cleared", { size: formatBytes(answer.freedBytes ?? 0) }));
        else toast.error(t("diskUsage.clearFailed"), t("diskUsage.clearedPartial", { size: formatBytes(answer.freedBytes ?? 0) }));
        afterFreed();
      })
      .catch((failure: unknown) => toast.error(t("diskUsage.clearFailed"), failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setClearing(false));
  };

  const days = payload?.olderThanDays ?? 14;
  const result = payload?.result ?? null;
  const candidates = result?.rebuildable ?? [];
  const old = candidates.filter((item) => item.changedMs > 0 && now - item.changedMs > days * DAY_MS);
  const oldBytes = old.reduce((sum, item) => sum + item.bytes, 0);

  const clearOlder = () => {
    setClearing(true);
    void post<ClearManyAnswer | { refused: ClearRefusal }>({ action: "clearOlder", volume, days })
      .then((answer) => {
        setOlderOpen(false);
        if (!("cleared" in answer)) {
          toast.error(t("diskUsage.clearFailed"), t(`diskUsage.refused.${answer.refused.code}`, { minutes: answer.refused.detail ?? "" }));
          return;
        }
        toast.success(
          t("diskUsage.rebuild.olderDone", { cleared: answer.cleared, size: formatBytes(answer.freedBytes), refused: answer.refused }),
          answer.stoppedEarly ? t("diskUsage.rebuild.olderEarly") : undefined,
        );
        afterFreed();
      })
      .catch((failure: unknown) => toast.error(t("diskUsage.clearFailed"), failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setClearing(false));
  };

  const actions: TreeActions = { now, canEdit, busyPath: checking, onClear: checkClear, onCleanNow, cleaning, onChanged: afterFreed };
  const scanned = result?.scannedBytes ?? 0;
  const used = usedBytes[volume];
  const missing = used !== undefined && !payload?.partial && result?.complete ? used - scanned : 0;
  const measuredAt = result?.finishedAt ? formatRelativeTime(new Date(result.finishedAt).toISOString(), locale, now) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid var(--border)", minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{t("diskUsage.title")}</div>
      <span style={dimLineStyle}>{t("diskUsage.intro")}</span>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {volumes.length > 1 && (
          <div role="group" aria-label={t("diskUsage.volume.aria")} style={{ display: "inline-flex", gap: 6 }}>
            {volumes.map((id) => (
              <button
                key={id}
                type="button"
                className="ui-focus-ring"
                aria-pressed={volume === id}
                onClick={() => setVolume(id)}
                style={{ ...smallButtonStyle, ...(volume === id ? { borderColor: "var(--accent)" } : {}) }}
              >
                {t(`diskUsage.volume.${id}`)}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="ui-focus-ring"
          onClick={rescan}
          disabled={running || starting || payload?.unavailable === true}
          aria-busy={running || starting}
          style={{ ...smallButtonStyle, opacity: running || starting ? 0.6 : 1 }}
        >
          {running || starting ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          {t(result ? "diskUsage.rescan" : "diskUsage.scan")}
        </button>
        {!running && measuredAt && <span style={dimLineStyle} role="status">{t("diskUsage.measured", { when: measuredAt })}</span>}
      </div>

      {running && payload && (
        <span style={{ fontSize: 12 }} role="status">
          {t("diskUsage.scanning", { files: payload.scan.entries.toLocaleString(locale), size: formatBytes(payload.scan.scannedBytes) })}
        </span>
      )}
      {payload?.unavailable && <span style={dimLineStyle}>{t("diskUsage.unavailable")}</span>}
      {!payload && !error && <span style={dimLineStyle}>{t("diskUsage.loading")}</span>}
      {payload && !result && !running && !payload.unavailable && <span style={dimLineStyle}>{t("diskUsage.never")}</span>}
      {result && payload?.partial && <span style={dimLineStyle}>{t("diskUsage.partial")}</span>}
      {result && !payload?.partial && !result.complete && <span style={dimLineStyle}>{t("diskUsage.stopped")}</span>}
      <ErrorNote message={error} />

      {result && (
        <>
          {result.roots.map((root) => (
            <RootBlock key={root.path} root={root} actions={actions} />
          ))}
          {missing > 1_000_000_000 && <span style={dimLineStyle}>{t("diskUsage.unscanned", { size: formatBytes(missing) })}</span>}
        </>
      )}

      {candidates.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 8, borderTop: "1px solid var(--border)", minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{t("diskUsage.rebuild.title")}</div>
          <span style={dimLineStyle}>
            {t("diskUsage.rebuild.intro")} {t("diskUsage.rebuild.total", { size: formatBytes(candidates.reduce((sum, item) => sum + item.bytes, 0)) })}
          </span>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {candidates.slice(0, LISTED_CANDIDATES).map((item) => (
              <CandidateRow key={item.path} item={item} actions={actions} />
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              className="ui-focus-ring"
              disabled={old.length === 0 || clearing || checking !== null}
              onClick={() => setOlderOpen(true)}
              style={{ ...smallButtonStyle, color: "var(--status-error)", opacity: old.length === 0 ? 0.6 : 1 }}
            >
              <Trash2 size={13} aria-hidden="true" />
              {t("diskUsage.rebuild.older", { days })}
            </button>
            {old.length === 0 && <span style={dimLineStyle}>{t("diskUsage.rebuild.olderNone", { days })}</span>}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={plan !== null}
        onOpenChange={(open) => { if (!open && !clearing) setPlan(null); }}
        title={t("diskUsage.confirm.title")}
        description={plan && (
          <>
            <code style={{ overflowWrap: "anywhere" }}>{plan.path}</code>
            {" "}
            {t("diskUsage.confirm.size", {
              size: formatBytes(plan.bytes),
              files: plan.entries.toLocaleString(locale),
              when: plan.changedMs > 0 ? (formatRelativeTime(new Date(plan.changedMs).toISOString(), locale, now) ?? "?") : "?",
            })}
            {" "}
            {t(`diskUsage.rule.${plan.rule}`)}
            {" "}
            {t("diskUsage.confirm.undone")}
          </>
        )}
        confirmLabel={plan ? t("diskUsage.confirm.button", { size: formatBytes(plan.bytes) }) : ""}
        cancelLabel={t("chatWindow.cancel")}
        danger
        busy={clearing}
        onConfirm={confirmClear}
      />
      <ConfirmDialog
        open={olderOpen}
        onOpenChange={(open) => { if (!open && !clearing) setOlderOpen(false); }}
        title={t("diskUsage.rebuild.olderTitle")}
        description={t("diskUsage.rebuild.olderBody", { days, size: formatBytes(oldBytes), count: old.length })}
        confirmLabel={t("diskUsage.rebuild.older", { days })}
        cancelLabel={t("chatWindow.cancel")}
        danger
        busy={clearing}
        onConfirm={clearOlder}
      />
    </div>
  );
}

function RootBlock({ root, actions }: { root: UsageRoot; actions: TreeActions }) {
  const { t } = useI18n();
  const children = root.node.children ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
        <span style={{ fontWeight: 600 }}>{t(`diskUsage.root.${root.label}`)}</span>
        <span style={{ color: "var(--text-muted)" }}>{formatBytes(root.node.bytes)}</span>
      </div>
      <span style={{ ...dimLineStyle, overflowWrap: "anywhere" }}>{root.path}</span>
      <NodeList nodes={children} depth={0} parentBytes={root.node.bytes} actions={actions} />
    </div>
  );
}

function CandidateRow({ item, actions }: { item: UsageCandidate; actions: TreeActions }) {
  const { t } = useI18n();
  const parts = item.path.split("/").filter(Boolean);
  const short = parts.slice(-2).join("/");
  const busy = actions.busyPath === item.path;
  return (
    <li style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "4px 10px", flexWrap: "wrap" }}>
        <span style={{ flex: "1 1 160px", minWidth: 0, overflowWrap: "anywhere", fontSize: 12, fontWeight: 600 }}>{short}</span>
        <KindBadge kind={item.kind} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>{formatBytes(item.bytes)}</span>
        <button
          type="button"
          className="ui-focus-ring"
          disabled={actions.busyPath !== null}
          aria-busy={busy}
          onClick={() => actions.onClear(item.path)}
          style={{ ...smallButtonStyle, color: "var(--status-error)", opacity: actions.busyPath !== null ? 0.6 : 1 }}
        >
          {busy ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
          {busy ? t("diskUsage.checking") : t("diskUsage.clear")}
        </button>
      </div>
      <span style={{ ...dimLineStyle, overflowWrap: "anywhere" }}>{item.path}</span>
    </li>
  );
}
