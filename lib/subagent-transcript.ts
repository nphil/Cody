// What an open subagent transcript holds in the browser: the pages fetched so
// far, kept as ONE contiguous window of the file. Pure data and no React, so
// the rules that keep a 20 MB transcript smooth are unit-tested directly
// (lib/subagent-transcript.test.mjs).
//
// A window grows two ways — a page PREPENDED (the reader asked for earlier
// messages) and a page APPENDED (a running child wrote more, or the reader
// walked down out of a trimmed window) — and is bounded: when it holds more
// than MAX_WINDOW_MESSAGES it drops the page farthest from where the reader is
// looking, which `loadEarlier`/`loadLater` can always bring back.

import { normalizeToolCalls } from "./normalize";
import type { SubagentTranscriptPage } from "./subagent-types";
import type { AgentMessage, ToolResultMessage } from "./types";

/** The most messages kept in memory (and mounted) at once. A server page is at
 *  most 200 lines, so this always holds at least two. Collapsed rows cost a
 *  few dozen DOM nodes each; ~400 keeps the tree a few thousand nodes however
 *  many pages the reader walks through. */
export const MAX_WINDOW_MESSAGES = 400;

export interface TranscriptRow {
  /** Stable for the life of the file: the source line's byte offset. A source
   *  that reports no offsets (the live RPC path) falls back to
   *  `<page fromByte>:<index>`, which is just as stable because a page is only
   *  ever added whole. Never an array index into the whole list — pages are
   *  prepended, so an index would name a different row after every load. */
  key: string;
  message: AgentMessage;
}

export interface TranscriptPage {
  fromByte: number;
  nextByte: number;
  rows: TranscriptRow[];
}

export interface TranscriptWindow {
  /** Contiguous (each page's `nextByte` is the next page's `fromByte`), oldest
   *  first, never empty. */
  pages: TranscriptPage[];
  /** End of the file's last complete line as of the newest response; null for
   *  a source that cannot say (the RPC path). */
  endByte: number | null;
}

/** One server page as rows. Tool calls are normalized exactly like the main
 *  transcript's (`lib/normalize.ts`) — idempotent, so the disk reader's already
 *  normalized messages and the RPC path's raw ones come out the same. */
export function pageFromResponse(page: SubagentTranscriptPage): TranscriptPage {
  const rows = page.messages.map((message, index): TranscriptRow => {
    const offset = page.offsets?.[index];
    return {
      key: offset === undefined ? `${page.fromByte}:${index}` : String(offset),
      message: normalizeToolCalls(message),
    };
  });
  return { fromByte: page.fromByte, nextByte: page.nextByte, rows };
}

export function windowFromPage(page: SubagentTranscriptPage): TranscriptWindow {
  return { pages: [pageFromResponse(page)], endByte: page.endByte ?? null };
}

/** Add the page that ends exactly where the window begins. Null when it does
 *  not (a response that lost a race with a newer load): the caller drops it. */
export function prependPage(win: TranscriptWindow, page: SubagentTranscriptPage): TranscriptWindow | null {
  if (page.nextByte !== win.pages[0].fromByte) return null;
  if (page.nextByte <= page.fromByte) return win;
  return { pages: [pageFromResponse(page), ...win.pages], endByte: win.endByte };
}

/** Add the page that starts exactly where the window ends. Null when it does
 *  not. A page with nothing new keeps the window itself (identity), so a
 *  refresh that found nothing re-renders nothing. */
export function appendPage(win: TranscriptWindow, page: SubagentTranscriptPage): TranscriptWindow | null {
  const last = win.pages[win.pages.length - 1];
  if (page.fromByte !== last.nextByte) return null;
  const endByte = page.endByte ?? win.endByte;
  if (page.nextByte <= page.fromByte) return endByte === win.endByte ? win : { pages: win.pages, endByte };
  return { pages: [...win.pages, pageFromResponse(page)], endByte };
}

export function windowMessageCount(win: TranscriptWindow): number {
  let count = 0;
  for (const page of win.pages) count += page.rows.length;
  return count;
}

/** Whether any line precedes the window. */
export function hasEarlier(win: TranscriptWindow): boolean {
  return win.pages[0].fromByte > 0;
}

/** Whether the window reaches the newest line the file has — what a follower
 *  needs: only then does a live append land next to the rows on screen. */
export function reachesEnd(win: TranscriptWindow): boolean {
  return win.endByte === null || win.pages[win.pages.length - 1].nextByte >= win.endByte;
}

/** Drop pages until at most `max` messages remain, always the page farthest
 *  from the reader (`viewportKey`, the row at the top of the viewport; null
 *  means "at the newest end"). The reader's own page is never dropped, so
 *  trimming can never pull rows out from under them. */
export function trimWindow(win: TranscriptWindow, viewportKey: string | null, max: number = MAX_WINDOW_MESSAGES): TranscriptWindow {
  let pages = win.pages;
  let total = windowMessageCount(win);
  while (total > max && pages.length > 1) {
    let at = pages.length - 1;
    if (viewportKey !== null) {
      const found = pages.findIndex((page) => page.rows.some((row) => row.key === viewportKey));
      if (found !== -1) at = found;
    }
    // Distance to each end; the farther page goes. A tie drops the older one.
    const dropFirst = at >= pages.length - 1 - at;
    const dropped = dropFirst ? pages[0] : pages[pages.length - 1];
    pages = dropFirst ? pages.slice(1) : pages.slice(0, -1);
    total -= dropped.rows.length;
  }
  return pages === win.pages ? win : { pages, endByte: win.endByte };
}

/** Every message in the window, oldest first. */
export function windowMessages(win: TranscriptWindow): TranscriptRow[] {
  return win.pages.length === 1 ? win.pages[0].rows : win.pages.flatMap((page) => page.rows);
}

/** The rows a reader sees. A tool result is drawn inside its tool call's card
 *  (MessageView attaches it by id), so it is not a row of its own. */
export function renderableRows(rows: readonly TranscriptRow[]): TranscriptRow[] {
  return rows.filter((row) => row.message.role !== "toolResult");
}

/** Tool results by call id, for the cards. Built over the WHOLE window so a
 *  call and its result are paired even when they arrived in different pages. */
export function toolResultsById(rows: readonly TranscriptRow[]): Map<string, ToolResultMessage> {
  const results = new Map<string, ToolResultMessage>();
  for (const row of rows) {
    if (row.message.role === "toolResult") results.set(row.message.toolCallId, row.message);
  }
  return results;
}
