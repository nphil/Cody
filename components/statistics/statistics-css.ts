/**
 * The styles of the page shell and of the small pieces it owns (header, controls,
 * segmented switch, breadcrumb, sheet, chart card, empty and error states).
 * One string, rendered once by StatisticsPage: the sheet and the other portalled
 * parts live outside the page's own element but styles are document-wide, so a
 * single sheet reaches all of them. The panels, table, circle and timeline each
 * carry their own styles under their own prefixes.
 *
 * Only theme tokens are used for colour, so every theme (light or dark) keeps
 * its own look. Pointer-coarse devices get 40px+ touch targets; phones (up to
 * 640px, the app's mobile breakpoint) stack the controls.
 */
export const STATISTICS_CSS = `
.stats-page {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  background: var(--bg);
  color: var(--text);
}
.stats-page-inner {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 1240px;
  margin: 0 auto;
  padding: calc(16px + var(--safe-top)) calc(16px + var(--safe-right)) calc(40px + var(--safe-bottom)) calc(16px + var(--safe-left));
}
@media (min-width: 641px) {
  .stats-page-inner {
    gap: 24px;
    padding: calc(24px + var(--safe-top)) calc(24px + var(--safe-right)) calc(56px + var(--safe-bottom)) calc(24px + var(--safe-left));
  }
}

/* Header */
.stats-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 16px; }
.stats-head-main { display: flex; align-items: center; gap: 4px; min-width: 0; }
.stats-head-tools { display: flex; align-items: center; gap: 4px; min-width: 0; margin-left: auto; }
.stats-head > .stats-state-bar { flex: 1 1 100%; }
.stats-title { margin: 0; font-size: 24px; line-height: 32px; letter-spacing: -0.01em; color: var(--text); overflow-wrap: anywhere; }
.stats-status { min-width: 0; font-size: 13px; line-height: 20px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.stats-back,
.stats-icon-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-muted);
  text-decoration: none;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm);
}
.stats-back { margin-left: -8px; }
.stats-icon-btn[data-size="sm"] { width: 28px; height: 28px; }
.stats-back:hover,
.stats-icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.stats-icon-btn[aria-disabled="true"] { cursor: default; }
.stats-icon-btn[aria-disabled="true"]:hover { background: transparent; color: var(--text-muted); }
@media (pointer: coarse) {
  .stats-back,
  .stats-icon-btn { width: 44px; height: 44px; }
  .stats-icon-btn[data-size="sm"] { width: 36px; height: 36px; }
}

/* Buttons */
.stats-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-panel);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm);
}
.stats-btn:hover { background: var(--bg-hover); }
.stats-btn[data-primary="true"] { border-color: transparent; background: var(--accent-strong); color: var(--on-accent); }
.stats-btn[data-primary="true"]:hover { background: var(--accent-hover); }
.stats-btn[data-quiet="true"] {
  min-height: 28px;
  padding: 0 6px;
  border-color: transparent;
  background: transparent;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.stats-btn[data-quiet="true"]:hover { background: var(--bg-hover); }
@media (pointer: coarse) {
  .stats-btn { min-height: 44px; }
  .stats-btn[data-quiet="true"] { min-height: 40px; }
}

/* Segmented switch */
.stats-seg {
  display: inline-flex;
  align-items: stretch;
  gap: 2px;
  max-width: 100%;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius-control) + 2px);
  background: var(--bg-subtle);
  overflow-x: auto;
  scrollbar-width: none;
}
.stats-seg::-webkit-scrollbar { display: none; }
.stats-seg-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm);
}
.stats-seg[data-size="sm"] .stats-seg-btn { min-height: 24px; padding: 0 8px; font-size: 12px; }
.stats-seg-btn:hover { background: var(--bg-hover); color: var(--text); }
.stats-seg-btn[data-selected="true"] { background: var(--bg-selected); color: var(--text); font-weight: 600; }
@media (pointer: coarse) {
  .stats-seg-btn { min-height: 38px; }
}

/* Controls */
.stats-ctl { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.stats-ctl-period,
.stats-ctl-metric { min-width: 0; }
.stats-ctl-range { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
.stats-ctl-date { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.stats-ctl-label { font-size: 12px; line-height: 16px; color: var(--text-muted); white-space: nowrap; }
.stats-ctl-input {
  box-sizing: border-box;
  height: 34px;
  min-width: 0;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-panel);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.stats-ctl-group { display: flex; align-items: center; gap: 8px; margin-left: auto; min-width: 0; }
.stats-ctl-select { width: 168px; min-width: 0; }
.stats-ctl-select .ui-select-trigger { height: 34px !important; }
@media (pointer: coarse) {
  .stats-ctl-input { height: 44px; font-size: 16px; }
  .stats-ctl-select .ui-select-trigger { height: 44px !important; font-size: 14px !important; }
}
@media (max-width: 640px) {
  .stats-ctl-period { flex: 1 1 100%; }
  .stats-ctl-period .stats-seg { display: flex; width: 100%; }
  .stats-ctl-period .stats-seg-btn { flex: 1 1 0; min-width: 0; padding: 0 4px; }
  .stats-ctl-range { flex: 1 1 100%; }
  .stats-ctl-date { flex: 1 1 0; }
  .stats-ctl-input { width: 100%; }
  .stats-ctl-group { flex: 1 1 0; margin-left: 0; }
  .stats-ctl-select { flex: 1 1 auto; width: auto; }
}
@media (max-width: 360px) {
  .stats-seg-btn { font-size: 12px; }
}

/* "Showing Nov 3 - Nov 5" with the way back */
.stats-chip { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 13px; line-height: 20px; color: var(--text-muted); }
.stats-chip-text { min-width: 0; overflow-wrap: anywhere; font-weight: 500; color: var(--text); }

/* Breadcrumb */
.stats-crumb { min-width: 0; }
.stats-crumb-list { display: flex; flex-wrap: wrap; align-items: center; margin: 0; padding: 0; list-style: none; }
.stats-crumb-item { display: inline-flex; align-items: center; min-width: 0; }
.stats-crumb-sep { flex: none; margin-inline: 2px; color: var(--text-dim); }
.stats-crumb-link,
.stats-crumb-current {
  display: inline-block;
  box-sizing: border-box;
  max-width: 220px;
  padding: 3px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: var(--radius-control);
  font-size: 13px;
  line-height: 22px;
}
.stats-crumb-link {
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm);
}
.stats-crumb-link:hover { background: var(--bg-hover); color: var(--text); }
.stats-crumb-current { font-weight: 600; color: var(--text); }
@media (pointer: coarse) {
  .stats-crumb-link,
  .stats-crumb-current { padding-block: 9px; }
}

/* The report */
.stats-body { container: stats-body / inline-size; display: flex; flex-direction: column; gap: 20px; min-width: 0; transition: opacity var(--dur-med) var(--ease-out-warm); }
@media (min-width: 641px) {
  .stats-body { gap: 24px; }
}
/* A new period's answer is on its way: the old numbers dim, but only if it takes a moment, so a quick answer does not flicker. */
.stats-body[data-busy="true"] { opacity: 0.55; transition-delay: 250ms; }
.stats-grid { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 16px; }
/* Side by side only when the page itself (the window less the sidebar) leaves the table room for its name and figures; otherwise the circle comes first and the table follows at full width. */
@container stats-body (min-width: 860px) {
  .stats-grid { grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 20px; }
}
.stats-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
/* The chat deep dive brings no frame of its own, so this is the card around it (the phone sheet is already a surface). */
.stats-panel { min-width: 0; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--bg-panel); scroll-margin-top: 16px; }
@media (min-width: 641px) {
  .stats-panel { padding: 20px; }
}
.stats-more { display: flex; margin-top: 4px; }

/* Chart card */
.stats-chart {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 12px 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg-panel);
}
@media (min-width: 641px) {
  .stats-chart { padding: 14px 16px 16px; }
}
.stats-chart-rings { margin: 0; font-size: 12px; line-height: 18px; text-align: center; color: var(--text-muted); overflow-wrap: anywhere; }
.stats-chart-note { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 2px 6px; margin: 0; font-size: 12px; line-height: 18px; text-align: center; color: var(--text-muted); }
.stats-chart-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 12px; text-align: center; }
.stats-chart-empty-title { margin: 0; font-size: 18px; line-height: 26px; color: var(--text); }
.stats-chart-empty-text { margin: 0; max-width: 36ch; font-size: 13px; line-height: 20px; color: var(--text-muted); }

/* What is selected, on wide screens (the phone shows it in the sheet) */
.stats-selection {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg-panel);
  animation: ui-fade-in var(--dur-med) var(--ease-out-warm) both;
}
.stats-selection .stats-icon-btn { margin: -6px -6px 0 0; }

/* Phone bottom sheet: the dialog itself never scrolls, this body does. */
.stats-sheet-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 20px;
  min-height: 0;
  padding: 40px 16px calc(20px + var(--safe-bottom));
  overflow-y: auto;
  overscroll-behavior: contain;
}
@keyframes stats-sheet-rise {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: none; }
}

/* States: first run, empty, errors, loading */
.stats-state { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 440px; margin: 32px auto; padding: 0 8px; text-align: center; }
@media (min-width: 641px) {
  .stats-state { margin-block: 64px; }
}
.stats-state-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: var(--bg-panel); color: var(--text-muted); border: 1px solid var(--border); }
.stats-state-title { margin: 0; font-size: 20px; line-height: 28px; color: var(--text); }
.stats-state-text { margin: 0; font-size: 14px; line-height: 22px; color: var(--text-muted); }
.stats-state-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 6px; }
.stats-state-progress { display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 8px; }
.stats-state-progress-text { font-size: 13px; line-height: 20px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.stats-state-bar { height: 6px; overflow: hidden; border-radius: 999px; background: var(--bg-hover); }
.stats-state-bar[data-slim="true"] { height: 3px; border-radius: 0; }
.stats-state-bar-fill { height: 100%; border-radius: inherit; background: var(--accent); transition: width var(--dur-med) var(--ease-out-warm); }
.stats-state-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-panel);
  font-size: 13px;
  line-height: 20px;
  color: var(--text);
}
.stats-state-notice-icon { flex: none; }
.stats-state-notice[data-tone="warning"] .stats-state-notice-icon { color: var(--status-warning); }
.stats-state-notice[data-tone="error"] .stats-state-notice-icon { color: var(--status-error); }
.stats-state-notice-text { flex: 1 1 220px; min-width: 0; overflow-wrap: anywhere; }
.stats-state-skeleton { display: flex; flex-direction: column; gap: 20px; }
.stats-state-skeleton-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@media (min-width: 960px) {
  .stats-state-skeleton-grid { grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 20px; }
}
.stats-state-skeleton-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--bg-panel); }
.skeleton.stats-state-skeleton-disc { width: min(100%, 320px); margin: 0 auto; aspect-ratio: 1; border-radius: 50%; }
.skeleton.stats-state-skeleton-row { height: 20px; }
.skeleton.stats-state-skeleton-timeline { height: 176px; border-radius: var(--radius-card); }
.stats-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
`;
