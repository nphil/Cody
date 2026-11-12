"use client";

import { ArrowLeft, RefreshCw, Undo2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { formatRelativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { todayIn } from "@/lib/statistics/days";
import { formatDay, nodeLabel, type Translate } from "@/lib/statistics/present";
import { nodeValue, pathId, rerootAt, resolveFocus, type Metric } from "@/lib/statistics/sunburst";
import type { GroupBy, RangePreset, StatisticsResponse } from "@/lib/statistics/types";
import { BottomSheet } from "./BottomSheet";
import { ChartSection } from "./ChartSection";
import { ControlsBar } from "./ControlsBar";
import { DeepDive } from "./DeepDive";
import { Insights } from "./Insights";
import { NodeDetail } from "./NodeDetail";
import { STATISTICS_CSS } from "./statistics-css";
import { DEFAULT_PRESET, samePeriod, statisticsSearch, type PeriodSpec, type StatisticsInitial } from "./statistics-query";
import { EmptyPanel, FirstRunPanel, Notice, ProblemPanel, ProgressBar, StatisticsSkeleton } from "./StatisticsStates";
import { StatsTable } from "./StatsTable";
import { Summary } from "./Summary";
import { Timeline } from "./Timeline";
import { useStatisticsData } from "./useStatisticsData";

export type { StatisticsInitial } from "./statistics-query";

/** How often "Updated 5 min ago" is judged against the clock again. */
const STATUS_TICK_MS = 30_000;

/** On a phone the highlights start as this many lines; the rest open on request. */
const PHONE_INSIGHTS = 2;

/** A quick range as it reads inside a sentence ("Back to the last 7 days"). */
const PERIOD_LONG: Record<RangePreset, string> = {
  today: "statistics.period.long.today",
  "7d": "statistics.period.long.7d",
  "30d": "statistics.period.long.30d",
  "90d": "statistics.period.long.90d",
};

// These are the heavy parts of the page. Hovering a slice re-renders the page many times a second, and none of
// them care: they only look at their own props, which stay the same object between those renders.
const MemoSummary = memo(Summary);
const MemoInsights = memo(Insights);
const MemoNodeDetail = memo(NodeDetail);
const MemoDeepDive = memo(DeepDive);
const MemoTimeline = memo(Timeline);

/** The part of the browser's Navigation API this page reads; the TypeScript DOM typings do not include it yet. */
interface NavigationHistory {
  currentEntry: { index: number } | null;
  entries(): { url: string | null }[];
}

/**
 * Whether the page before this one in the history is Cody's chat view. Then "back" returns to the chat the
 * person came from, as they left it, instead of opening a second copy. `document.referrer` cannot tell:
 * the app sends no referrer at all.
 */
function cameFromChat(): boolean {
  const navigation = (window as Window & { navigation?: NavigationHistory }).navigation;
  const index = navigation?.currentEntry?.index ?? -1;
  if (navigation === undefined || index < 1) return false;
  const previous = navigation.entries()[index - 1].url;
  return previous !== null && new URL(previous).pathname === "/";
}

function BackLink() {
  const { t } = useI18n();
  const router = useRouter();

  const goBack = (event: MouseEvent<HTMLAnchorElement>) => {
    // A new-tab or new-window click belongs to the browser, and so does one something else already took.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!cameFromChat()) return;
    event.preventDefault();
    router.back();
  };

  return (
    <Link href="/" className="stats-back ui-focus-ring" aria-label={t("statistics.page.back")} title={t("statistics.page.back")} onClick={goBack}>
      <ArrowLeft size={20} aria-hidden="true" />
    </Link>
  );
}

/** One day as "Thu, Nov 12", several as "Nov 3 – Nov 5". */
function rangeText(from: string, to: string, locale: string, t: Translate): string {
  return from === to ? formatDay(from, locale, true) : t("statistics.page.range", { from: formatDay(from, locale), to: formatDay(to, locale) });
}

/** What the index is doing, or when it last finished. Nothing before the first answer. */
function PageStatus({ data, loading, now }: { data: StatisticsResponse | null; loading: boolean; now: number }) {
  const { locale, t } = useI18n();
  let text: string | null = null;
  if (data !== null && data.progress !== null) {
    text = t("statistics.state.reading", { done: data.progress.done, total: data.progress.total });
  } else if (loading || (data !== null && data.updating)) {
    text = t("statistics.state.updating");
  } else if (data !== null && data.indexedAt !== null) {
    const when = formatRelativeTime(new Date(data.indexedAt).toISOString(), locale, now);
    if (when !== null) text = t("statistics.page.updated", { when });
  }
  return <span className="stats-status">{text}</span>;
}

interface RestoreChipProps {
  from: string;
  to: string;
  restore: PeriodSpec;
  onRestore: () => void;
}

/** After focusing on days in the timeline: which days these are, and the one press back to where the person was. */
function RestoreChip({ from, to, restore, onRestore }: RestoreChipProps) {
  const { locale, t } = useI18n();
  const before = restore.kind === "preset" ? t(PERIOD_LONG[restore.preset]) : rangeText(restore.from, restore.to, locale, t);
  return (
    <div className="stats-chip">
      <span className="stats-chip-text">{t("statistics.page.showing", { when: rangeText(from, to, locale, t) })}</span>
      <button type="button" className="stats-btn ui-focus-ring" data-quiet="true" onClick={onRestore}>
        <Undo2 size={14} aria-hidden="true" />
        {t("statistics.page.backToPeriod", { period: before })}
      </button>
    </div>
  );
}

interface ReportProps {
  data: StatisticsResponse;
  loading: boolean;
  metric: Metric;
  onMetric: (metric: Metric) => void;
  path: string[];
  selected: string[] | null;
  hovered: string[] | null;
  /** Touch: a press selects a slice and the detail opens in a sheet; otherwise it sits beside the chart. */
  tapSelects: boolean;
  phone: boolean;
  onZoom: (path: string[]) => void;
  onSelect: (path: string[] | null) => void;
  onHover: (path: string[] | null) => void;
  onSelectRange: (from: string, to: string) => void;
}

/** Everything under the controls once there is usage to show: summary, highlights, circle and table, one chat's dive, the timeline. */
function Report({ data, loading, metric, onMetric, path, selected, hovered, tapSelects, phone, onZoom, onSelect, onHover, onSelectRange }: ReportProps) {
  const { t } = useI18n();
  const [allInsights, setAllInsights] = useState(false);
  const diveRef = useRef<HTMLDivElement>(null);

  const focus = useMemo(() => resolveFocus(data.tree, path), [data.tree, path]);
  const selectedNode = useMemo(() => (selected === null ? null : rerootAt(data.tree, selected)), [data.tree, selected]);

  // A chat has its own deep dive; any other slice is told in the detail card or sheet. The dive follows the selected
  // chat, or the chat the circle is zoomed into.
  const selectedChat = selectedNode?.dim === "chat" && selectedNode.chat ? selectedNode.chat : null;
  const focusChat = focus.node.dim === "chat" && focus.node.chat ? focus.node.chat : null;
  const diveChat = selectedChat ?? focusChat;
  const sheetOpen = tapSelects && selectedNode !== null;

  const canZoom = selectedNode?.children?.some((child) => nodeValue(child, metric) > 0) ?? false;
  const zoomSelected = useCallback(() => {
    if (selected !== null) onZoom(selected);
  }, [selected, onZoom]);

  const shownInsights = useMemo(() => (phone && !allInsights ? data.insights.slice(0, PHONE_INSIGHTS) : data.insights), [phone, allInsights, data.insights]);

  // The days on screen already are the days pressed: there is nothing to focus on.
  const focusDays = useCallback(
    (from: string, to: string) => {
      if (from === data.period.from && to === data.period.to) return;
      onSelectRange(from, to);
    },
    [data.period.from, data.period.to, onSelectRange],
  );

  // Escape lets go of the selection (the circle's own Escape zooms out first, and says so with preventDefault).
  useEffect(() => {
    if (tapSelects || selected === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tapSelects, selected, onSelect]);

  // Picking a chat fills the dive in below the chart, which may be out of sight: bring it into view.
  useEffect(() => {
    if (selectedChat !== null && !tapSelects) diveRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedChat, tapSelects]);

  const sheetName = selectedNode === null ? "" : selectedNode.dim === "root" ? t("statistics.page.allUsage") : nodeLabel(selectedNode, t);

  return (
    <>
      <MemoSummary data={data} loading={loading} />
      <div className="stats-body" data-busy={loading ? "true" : undefined} aria-busy={loading}>
        {data.insights.length > 0 && (
          <div>
            <MemoInsights insights={shownInsights} period={data.period} />
            {phone && data.insights.length > PHONE_INSIGHTS && (
              <div className="stats-more">
                <button type="button" className="stats-btn ui-focus-ring" data-quiet="true" aria-expanded={allInsights} onClick={() => setAllInsights((open) => !open)}>
                  {allInsights ? t("statistics.page.showLess") : t("statistics.page.showMore")}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="stats-grid">
          <div className="stats-col">
            <ChartSection
              tree={data.tree}
              focus={focus}
              dims={data.dims}
              metric={metric}
              selected={selected}
              hovered={hovered}
              onHover={onHover}
              onZoom={onZoom}
              onSelect={onSelect}
              tapSelects={tapSelects}
              onShowTokens={() => onMetric("tokens")}
            />
            {!tapSelects && selectedNode !== null && selectedChat === null && (
              <div className="stats-selection">
                <MemoNodeDetail node={selectedNode} focusNode={focus.node} metric={metric} canZoom={canZoom} onZoom={zoomSelected} />
                <button type="button" className="stats-icon-btn ui-focus-ring" data-size="sm" aria-label={t("statistics.page.clearSelection")} onClick={() => onSelect(null)}>
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
          <StatsTable
            tree={data.tree}
            path={focus.path}
            metric={metric}
            selected={selected}
            hovered={hovered}
            onHover={onHover}
            onZoom={onZoom}
            onSelect={onSelect}
            tapSelects={tapSelects}
          />
        </div>

        {diveChat !== null && !(sheetOpen && selectedChat !== null) && (
          <div className="stats-panel" ref={diveRef}>
            <MemoDeepDive chat={diveChat} period={data.period} zone={data.zone} metric={metric} refreshKey={data.indexedAt} />
          </div>
        )}

        <MemoTimeline series={data.series} days={data.timeline} dim={data.dims[0]} metric={metric} onSelectRange={focusDays} />
      </div>

      <BottomSheet open={sheetOpen} onClose={() => onSelect(null)} label={t("statistics.page.sheetLabel", { name: sheetName })}>
        {selectedNode !== null && (
          <>
            <MemoNodeDetail node={selectedNode} focusNode={focus.node} metric={metric} canZoom={canZoom} onZoom={zoomSelected} />
            {selectedChat !== null && <MemoDeepDive chat={selectedChat} period={data.period} zone={data.zone} metric={metric} refreshKey={data.indexedAt} />}
          </>
        )}
      </BottomSheet>
    </>
  );
}

/**
 * The Statistics page. It owns every choice (range, ring order, Cost/Tokens, where the circle is zoomed and
 * what is selected or hovered) and the parts below it are told what to show, so a row in the table lights its
 * slice in the circle and the other way round. The choices are kept in the address, so a link or a reload
 * opens the same view.
 */
export function StatisticsPage({ initial }: { initial: StatisticsInitial }) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const isCoarse = useIsCoarsePointer();
  // A finger cannot hover, so on touch a press selects a slice and the detail comes up in a sheet.
  const tapSelects = isMobile || isCoarse;

  const [period, setPeriod] = useState<PeriodSpec>(initial.period);
  const [groupBy, setGroupBy] = useState<GroupBy>(initial.groupBy);
  const [metric, setMetric] = useState<Metric>(initial.metric);
  // Where the circle is zoomed to. It may name a slice a later answer no longer has; the parts cut it back.
  const [path, setPath] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [hovered, setHovered] = useState<string[] | null>(null);
  // The range the person was on before they focused on days in the timeline, so one press brings it back.
  const [restore, setRestore] = useState<PeriodSpec | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pageRef = useRef<HTMLElement>(null);

  const { data, loading, failure, refresh, retry } = useStatisticsData(period, groupBy);

  useEffect(() => {
    const search = statisticsSearch(window.location.search, { period, groupBy, metric });
    // replaceState, not a router push: a change of view should not add a step the Back button has to walk through.
    if (search !== window.location.search) window.history.replaceState(null, "", `${window.location.pathname}${search}${window.location.hash}`);
  }, [period, groupBy, metric]);

  // "Updated 5 min ago" is judged against this clock, which ticks while the page is open and when a pass finishes.
  const indexedAt = data?.indexedAt ?? null;
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), STATUS_TICK_MS);
    return () => window.clearInterval(timer);
  }, [indexedAt]);

  const zoomTo = useCallback((next: string[]) => {
    setPath(next);
    setSelected(null);
    setHovered(null);
  }, []);

  // The table and the circle report the same slice from two places, so the same hover often arrives twice.
  const changeHover = useCallback((next: string[] | null) => {
    setHovered((current) => (current !== null && next !== null && pathId(current) === pathId(next) ? current : next));
  }, []);

  // A new range keeps the zoom (the same slice, over other days) but lets go of what was selected or hovered.
  const changePeriod = useCallback(
    (next: PeriodSpec) => {
      if (samePeriod(period, next)) return;
      setRestore(null);
      setPeriod(next);
      setSelected(null);
      setHovered(null);
    },
    [period],
  );

  // Another ring order is another tree: the zoom and the selection mean nothing in it.
  const changeGroupBy = useCallback(
    (next: GroupBy) => {
      setGroupBy(next);
      zoomTo([]);
    },
    [zoomTo],
  );

  const selectRange = useCallback(
    (from: string, to: string) => {
      setRestore((current) => current ?? period);
      setPeriod({ kind: "custom", from, to });
      setSelected(null);
      setHovered(null);
      // The numbers that just changed are at the top; the timeline that was pressed is at the bottom.
      pageRef.current?.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    },
    [period],
  );

  const restorePeriod = useCallback(() => {
    if (restore === null) return;
    setPeriod(restore);
    setRestore(null);
    setSelected(null);
    setHovered(null);
  }, [restore]);

  // Today's date in the zone days are counted in bounds the custom date fields.
  const bounds = useMemo(() => (data === null ? null : { min: data.dataFrom, max: todayIn(data.zone, data.generatedAt) }), [data]);

  const busy = loading || (data !== null && data.updating);
  const firstRun = data !== null && data.updating && data.indexedAt === null && data.totals.messages === 0;
  // With no answer to fall back on, a failure is the whole page. With one, it is a line above the old numbers.
  const problem = failure === "range" || data === null ? failure : null;

  let content: ReactNode;
  if (problem !== null) {
    content = <ProblemPanel kind={problem} onRetry={retry} onReset={() => changePeriod({ kind: "preset", preset: DEFAULT_PRESET })} />;
  } else if (data === null) {
    content = (
      <>
        <MemoSummary data={null} loading />
        <StatisticsSkeleton />
      </>
    );
  } else if (firstRun) {
    content = <FirstRunPanel progress={data.progress} />;
  } else if (data.totals.messages === 0) {
    content = <EmptyPanel period={data.period} hasData={data.dataFrom !== null} onPeriod={changePeriod} />;
  } else {
    content = (
      <Report
        data={data}
        loading={loading}
        metric={metric}
        onMetric={setMetric}
        path={path}
        selected={selected}
        hovered={hovered}
        tapSelects={tapSelects}
        phone={isMobile}
        onZoom={zoomTo}
        onSelect={setSelected}
        onHover={changeHover}
        onSelectRange={selectRange}
      />
    );
  }

  return (
    <main ref={pageRef} className="stats-page">
      <style>{STATISTICS_CSS}</style>
      <div className="stats-page-inner">
        <header className="stats-head">
          <div className="stats-head-main">
            <BackLink />
            <h1 className="stats-title display-serif">{t("statistics.title")}</h1>
          </div>
          <div className="stats-head-tools">
            <PageStatus data={data} loading={loading} now={now} />
            <button
              type="button"
              className="stats-icon-btn ui-focus-ring"
              aria-label={t("statistics.page.refresh")}
              title={t("statistics.page.refresh")}
              aria-disabled={busy}
              onClick={busy ? undefined : refresh}
            >
              <RefreshCw size={18} className={busy ? "icon-spin" : undefined} aria-hidden="true" />
            </button>
          </div>
          {data !== null && data.progress !== null && !firstRun && (
            <ProgressBar slim progress={data.progress} label={t("statistics.state.reading", { done: data.progress.done, total: data.progress.total })} />
          )}
        </header>

        <ControlsBar
          period={period}
          onPeriod={changePeriod}
          metric={metric}
          onMetric={setMetric}
          groupBy={groupBy}
          onGroupBy={changeGroupBy}
          shown={data?.period ?? null}
          bounds={bounds}
        />

        {restore !== null && period.kind === "custom" && <RestoreChip from={period.from} to={period.to} restore={restore} onRestore={restorePeriod} />}

        {data !== null && data.indexError !== null && <Notice tone="warning">{t("statistics.state.indexError", { error: data.indexError })}</Notice>}
        {data !== null && failure === "failed" && (
          <Notice
            tone="error"
            action={
              <button type="button" className="stats-btn ui-focus-ring" onClick={retry}>
                {t("statistics.state.retry")}
              </button>
            }
          >
            {t("statistics.state.staleError")}
          </Notice>
        )}

        {content}
      </div>
    </main>
  );
}
