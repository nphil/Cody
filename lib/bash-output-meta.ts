/**
 * What omp reports about a shell command's output that was cut down before it
 * reached the chat: the `meta` it saves on a bashExecution message (the `!`
 * and `!!` lines). Reading it turns a silently short output into a plain note
 * ("191,295 lines hidden from the middle").
 *
 * Both engines Cody supports write `meta.truncation` (output cut from the
 * middle) and `meta.limits.columnTruncated` (lines cut at the per-line cap);
 * omp 18.17+ adds `meta.minimized` (the output minimizer rewrote the output).
 * The data is read defensively: it comes from a file a person may have edited,
 * and a field an older engine never wrote just means no note.
 */

import { isRecord } from "./type-guards";

export type BashOutputNote =
  /** Lines/bytes dropped from the middle; either count may be unknown. */
  | { kind: "middle"; lines: number | null; bytes: number | null }
  /** A head/tail cut: `shown` of `total` lines are in the output. */
  | { kind: "shown"; shown: number; total: number }
  /** Long lines were cut at `max` bytes (or characters). */
  | { kind: "columns"; max: number; unit: "bytes" | "chars" }
  /** The output minimizer rewrote the output from `inputBytes` down to `outputBytes`. */
  | { kind: "minimized"; filter: string | null; inputBytes: number | null; outputBytes: number | null };

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** `total - kept` when both are known and something was dropped. */
function dropped(total: unknown, kept: unknown): number | null {
  const all = count(total);
  const some = count(kept);
  return all !== null && some !== null && all > some ? all - some : null;
}

/** The notes to show under a shell command's output, in the order omp lists them. */
export function bashOutputNotes(meta: unknown): BashOutputNote[] {
  if (!isRecord(meta)) return [];
  const notes: BashOutputNote[] = [];

  const truncation = meta.truncation;
  if (isRecord(truncation)) {
    if (truncation.direction === "middle" || truncation.truncatedBy === "middle") {
      const lines = count(truncation.elidedLines) ?? dropped(truncation.totalLines, truncation.outputLines);
      const bytes = count(truncation.elidedBytes) ?? dropped(truncation.totalBytes, truncation.outputBytes);
      if ((lines ?? 0) > 0 || (bytes ?? 0) > 0) {
        notes.push({ kind: "middle", lines: lines && lines > 0 ? lines : null, bytes: bytes && bytes > 0 ? bytes : null });
      }
    } else {
      const shown = count(truncation.outputLines);
      const total = count(truncation.totalLines);
      if (shown !== null && total !== null && shown < total) notes.push({ kind: "shown", shown, total });
    }
  }

  const limits = meta.limits;
  if (isRecord(limits) && isRecord(limits.columnTruncated)) {
    const max = count(limits.columnTruncated.maxColumn);
    if (max !== null && max > 0) notes.push({ kind: "columns", max, unit: limits.columnTruncated.unit === "chars" ? "chars" : "bytes" });
  }

  const minimized = meta.minimized;
  if (isRecord(minimized)) {
    const filter = typeof minimized.filter === "string" && minimized.filter.trim() !== "" && minimized.filter.length <= 64 ? minimized.filter.trim() : null;
    notes.push({ kind: "minimized", filter, inputBytes: count(minimized.inputBytes), outputBytes: count(minimized.outputBytes) });
  }

  return notes;
}
