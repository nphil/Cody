/**
 * "What did the work": the worker ids the indexer files usage under, read back
 * into a kind plus the free-form tail they carry. Pure, so the server (insight
 * maths) and the page (labels) classify an id the same way.
 */

import {
  WORKER_ADVISOR,
  WORKER_BACKGROUND,
  WORKER_BACKGROUND_PREFIX,
  WORKER_COMPACTION,
  WORKER_ENGINE_PREFIX,
  WORKER_MAIN,
  WORKER_SIDEBAR,
  WORKER_SUBAGENT,
  WORKER_SUBAGENT_PREFIX,
} from "./types";

export type WorkerKind =
  /** The chat itself. */
  | "main"
  /** A side chat in the sidebar. */
  | "sidebar"
  /** The advisor model consulted from a chat. */
  | "advisor"
  /** A subagent the chat started; `detail` is its agent type. */
  | "subagent"
  /** Summarising an old conversation to make room. */
  | "compaction"
  /** The engine's own helper calls (memory, thinking judges); `detail` is the purpose. */
  | "engine"
  /** A Cody background job (titles, Distill, plan keeper, research); `detail` is the purpose. */
  | "background"
  /** An id this version does not know. */
  | "other";

export interface WorkerInfo {
  kind: WorkerKind;
  detail: string;
}

export function parseWorker(id: string): WorkerInfo {
  if (id === WORKER_MAIN) return { kind: "main", detail: "" };
  if (id === WORKER_SIDEBAR) return { kind: "sidebar", detail: "" };
  if (id === WORKER_ADVISOR) return { kind: "advisor", detail: "" };
  if (id === WORKER_COMPACTION) return { kind: "compaction", detail: "" };
  if (id === WORKER_SUBAGENT) return { kind: "subagent", detail: "" };
  if (id === WORKER_BACKGROUND) return { kind: "background", detail: "" };
  if (id.startsWith(WORKER_SUBAGENT_PREFIX)) return { kind: "subagent", detail: id.slice(WORKER_SUBAGENT_PREFIX.length) };
  if (id.startsWith(WORKER_ENGINE_PREFIX)) return { kind: "engine", detail: id.slice(WORKER_ENGINE_PREFIX.length) };
  if (id.startsWith(WORKER_BACKGROUND_PREFIX)) return { kind: "background", detail: id.slice(WORKER_BACKGROUND_PREFIX.length) };
  return { kind: "other", detail: id };
}
