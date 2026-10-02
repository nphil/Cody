/**
 * The project To-do document's shapes and limits — a pure module, so the
 * browser (components/todo/*) can import them without dragging
 * lib/project-todo.ts's node:fs/node:crypto into the client bundle. The
 * server module re-exports everything here; nothing else should be added
 * that needs Node.
 */

export const TODO_FILE_RELATIVE_PATH = ".cody/todo.json";
export const TODO_VERSION = 1 as const;
export const MAX_TODO_TITLE_LENGTH = 200;
export const MAX_TODO_NOTES_LENGTH = 4_000;
export const MAX_TODO_ITEMS = 1_000;
export const MAX_TODO_FILE_BYTES = 8 * 1024 * 1024;

export const TODO_COLORS = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;
export type TodoColor = (typeof TODO_COLORS)[number];
export type TodoStatus = "active" | "done";

export interface TodoItem {
  id: string;
  title: string;
  notes?: string;
  status: TodoStatus;
  color?: TodoColor;
  order: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** The project document may carry future top-level fields Cody does not own. */
export interface TodoDocument {
  version: typeof TODO_VERSION;
  items: TodoItem[];
  [key: string]: unknown;
}

export type TodoOperation =
  | { op: "add"; title: string; notes?: string | null; color?: TodoColor | null }
  | { op: "update"; id: string; title?: string; notes?: string | null; color?: TodoColor | null }
  | { op: "complete"; id: string }
  | { op: "reopen"; id: string }
  | { op: "delete"; id: string }
  | { op: "reorder"; ids: string[] };
