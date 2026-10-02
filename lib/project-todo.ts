import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "./type-guards";

export * from "./project-todo-types";
import {
  MAX_TODO_FILE_BYTES, MAX_TODO_ITEMS, MAX_TODO_NOTES_LENGTH, MAX_TODO_TITLE_LENGTH,
  TODO_COLORS, TODO_FILE_RELATIVE_PATH, TODO_VERSION,
  type TodoColor, type TodoDocument, type TodoItem, type TodoOperation, type TodoStatus,
} from "./project-todo-types";

export type ProjectTodoReadResult =
  | { status: "loaded"; path: string; doc: TodoDocument }
  | { status: "missing"; path: string; doc: TodoDocument }
  | { status: "invalid"; path: string; reason: string };

export class ProjectTodoError extends Error {
  readonly code: "invalid" | "not_found";

  constructor(message: string, code: "invalid" | "not_found" = "invalid") {
    super(message);
    this.code = code;
  }
}

const TODO_ID_RE = /^t_[A-Za-z0-9]{8}$/u;

declare global {
  var __codyProjectTodoWrites: Map<string, Promise<void>> | undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireTodoId(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !TODO_ID_RE.test(value)) {
    throw new ProjectTodoError(`${field} must be a to-do item id`);
  }
  return value;
}

function requireTitle(value: unknown): string {
  if (typeof value !== "string") throw new ProjectTodoError("title must be a string");
  const title = value.trim();
  if (!title) throw new ProjectTodoError("title is required");
  if (title.length > MAX_TODO_TITLE_LENGTH) {
    throw new ProjectTodoError(`title must be at most ${String(MAX_TODO_TITLE_LENGTH)} characters`);
  }
  return title;
}

function parseNotes(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new ProjectTodoError("notes must be a string");
  if (value.length > MAX_TODO_NOTES_LENGTH) {
    throw new ProjectTodoError(`notes must be at most ${String(MAX_TODO_NOTES_LENGTH)} characters`);
  }
  return value === "" ? null : value;
}

export function isTodoColor(value: unknown): value is TodoColor {
  return typeof value === "string" && (TODO_COLORS as readonly string[]).includes(value);
}

function parseColor(value: unknown): TodoColor | null {
  if (value === null) return null;
  if (!isTodoColor(value)) throw new ProjectTodoError("color must be a supported to-do color");
  return value;
}

function requireIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    throw new ProjectTodoError(`${field} must be an ISO timestamp`);
  }
  return value;
}

function readItem(value: unknown, index: number): TodoItem {
  if (!isRecord(value)) throw new ProjectTodoError(`items[${String(index)}] must be an object`);
  const id = requireTodoId(value.id, `items[${String(index)}].id`);
  const title = requireTitle(value.title);
  const status = value.status;
  if (status !== "active" && status !== "done") {
    throw new ProjectTodoError(`items[${String(index)}].status must be active or done`);
  }
  if (typeof value.order !== "number" || !Number.isFinite(value.order)) {
    throw new ProjectTodoError(`items[${String(index)}].order must be a finite number`);
  }
  const createdAt = requireIso(value.createdAt, `items[${String(index)}].createdAt`);
  const updatedAt = requireIso(value.updatedAt, `items[${String(index)}].updatedAt`);
  const completedAt = value.completedAt;
  if (completedAt !== null && typeof completedAt !== "string") {
    throw new ProjectTodoError(`items[${String(index)}].completedAt must be an ISO timestamp or null`);
  }
  if (typeof completedAt === "string") requireIso(completedAt, `items[${String(index)}].completedAt`);
  if ((status === "active" && completedAt !== null) || (status === "done" && completedAt === null)) {
    throw new ProjectTodoError(`items[${String(index)}] has an inconsistent completion state`);
  }

  const item: TodoItem = { id, title, status, order: value.order, createdAt, updatedAt, completedAt };
  if (hasOwn(value, "notes")) {
    const notes = parseNotes(value.notes);
    if (notes !== null) item.notes = notes;
  }
  if (hasOwn(value, "color")) {
    const color = parseColor(value.color);
    if (color !== null) item.color = color;
  }
  return item;
}

/** Parse and normalize a version-1 document without touching the filesystem.
 * A legacy `history` key from before history was removed is dropped; every
 * other unknown top-level field the project may carry is preserved. */
export function parseTodoDocument(value: unknown): { ok: true; doc: TodoDocument } | { ok: false; reason: string } {
  try {
    if (!isRecord(value)) throw new ProjectTodoError("To-do document must be an object");
    if (value.version !== TODO_VERSION) throw new ProjectTodoError(`To-do document version must be ${String(TODO_VERSION)}`);
    if (!Array.isArray(value.items) || value.items.length > MAX_TODO_ITEMS) {
      throw new ProjectTodoError(`items must be an array of at most ${String(MAX_TODO_ITEMS)} entries`);
    }

    const items = value.items.map(readItem);
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id)) throw new ProjectTodoError(`Duplicate to-do item id: ${item.id}`);
      ids.add(item.id);
    }
    const rest: Record<string, unknown> = { ...value };
    delete rest.history;
    return { ok: true, doc: { ...rest, version: TODO_VERSION, items } };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

export function emptyTodoDocument(): TodoDocument {
  return { version: TODO_VERSION, items: [] };
}

/** Absolute canonical location under an already-resolved project root. */
export function projectTodoPath(projectRoot: string): string {
  return path.join(projectRoot, ...TODO_FILE_RELATIVE_PATH.split("/"));
}

/** Read the project document without creating it. Invalid source stays untouched. */
export async function readProjectTodo(projectRoot: string): Promise<ProjectTodoReadResult> {
  const filePath = projectTodoPath(projectRoot);
  const directory = path.dirname(filePath);
  try {
    const directoryStat = await fs.promises.lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return {
        status: "invalid",
        path: filePath,
        reason: path.basename(directory) + " must be a real directory",
      };
    }
  } catch (error) {
    if (isEnoent(error)) return { status: "missing", path: filePath, doc: emptyTodoDocument() };
    return {
      status: "invalid",
      path: filePath,
      reason: "Unable to read " + TODO_FILE_RELATIVE_PATH + ": " + errorText(error),
    };
  }

  let raw: string;
  try {
    const stat = await fs.promises.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        status: "invalid",
        path: filePath,
        reason: TODO_FILE_RELATIVE_PATH + " must be a regular file",
      };
    }
    if (stat.size > MAX_TODO_FILE_BYTES) {
      return {
        status: "invalid",
        path: filePath,
        reason:
          TODO_FILE_RELATIVE_PATH + " is larger than " + String(MAX_TODO_FILE_BYTES) + " bytes",
      };
    }
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return { status: "missing", path: filePath, doc: emptyTodoDocument() };
    return {
      status: "invalid",
      path: filePath,
      reason: "Unable to read " + TODO_FILE_RELATIVE_PATH + ": " + errorText(error),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return { status: "invalid", path: filePath, reason: `Invalid JSON in ${TODO_FILE_RELATIVE_PATH}: ${errorText(error)}` };
  }

  const normalized = parseTodoDocument(parsed);
  return normalized.ok
    ? { status: "loaded", path: filePath, doc: normalized.doc }
    : { status: "invalid", path: filePath, reason: normalized.reason };
}

export function createTodoId(): string {
  // Eight hex characters are eight random alphanumeric characters, while
  // avoiding punctuation that makes the id awkward in terminal transcripts.
  return `t_${randomBytes(4).toString("hex")}`;
}

function nextTodoId(items: TodoItem[], idFactory: () => string): string {
  const known = new Set(items.map((item) => item.id));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = idFactory();
    if (TODO_ID_RE.test(id) && !known.has(id)) return id;
  }
  throw new ProjectTodoError("Unable to allocate a unique to-do item id");
}

function orderedItems(items: readonly TodoItem[]): TodoItem[] {
  return [...items].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** Apply one validated operation. The returned document is unchanged by identity for an idempotent transition. */
export function applyTodoOperation(
  doc: TodoDocument,
  operation: TodoOperation,
  options: { now?: Date; idFactory?: () => string } = {},
): TodoDocument {
  const ts = (options.now ?? new Date()).toISOString();

  if (operation.op === "add") {
    if (doc.items.length >= MAX_TODO_ITEMS) throw new ProjectTodoError(`A project can contain at most ${String(MAX_TODO_ITEMS)} to-do items`);
    const id = nextTodoId(doc.items, options.idFactory ?? createTodoId);
    const order = doc.items.reduce((highest, item) => Math.max(highest, item.order), -1) + 1;
    const item: TodoItem = {
      id,
      title: requireTitle(operation.title),
      status: "active",
      order,
      createdAt: ts,
      updatedAt: ts,
      completedAt: null,
    };
    if (operation.notes !== undefined) {
      const notes = parseNotes(operation.notes);
      if (notes !== null) item.notes = notes;
    }
    if (operation.color !== undefined) {
      const color = parseColor(operation.color);
      if (color !== null) item.color = color;
    }
    return { ...doc, items: [...doc.items, item] };
  }

  if (operation.op === "reorder") {
    const ids = operation.ids;
    if (ids.length !== doc.items.length || new Set(ids).size !== ids.length) {
      throw new ProjectTodoError("reorder must include every to-do item exactly once");
    }
    const byId = new Map(doc.items.map((item) => [item.id, item]));
    if (ids.some((id) => !byId.has(id))) throw new ProjectTodoError("reorder includes an unknown to-do item", "not_found");
    const current = orderedItems(doc.items).map((item) => item.id);
    if (current.every((id, index) => id === ids[index])) return doc;
    const items = ids.map((id, order) => {
      const item = byId.get(id)!;
      return item.order === order ? item : { ...item, order, updatedAt: ts };
    });
    const moved = items.some((item, order) => byId.get(item.id)!.order !== order);
    if (!moved) throw new ProjectTodoError("reorder did not change a to-do item");
    return { ...doc, items };
  }

  const index = doc.items.findIndex((item) => item.id === operation.id);
  if (index < 0) throw new ProjectTodoError("To-do item not found", "not_found");
  const item = doc.items[index];

  if (operation.op === "delete") {
    return { ...doc, items: [...doc.items.slice(0, index), ...doc.items.slice(index + 1)] };
  }

  if (operation.op === "complete") {
    if (item.status === "done") return doc;
    const next = { ...item, status: "done" as const, completedAt: ts, updatedAt: ts };
    const items = [...doc.items];
    items[index] = next;
    return { ...doc, items };
  }

  if (operation.op === "reopen") {
    if (item.status === "active") return doc;
    const next = { ...item, status: "active" as const, completedAt: null, updatedAt: ts };
    const items = [...doc.items];
    items[index] = next;
    return { ...doc, items };
  }

  let next: TodoItem = item;
  if (operation.title !== undefined) {
    const title = requireTitle(operation.title);
    if (title !== next.title) next = { ...next, title };
  }
  if (operation.notes !== undefined) {
    const notes = parseNotes(operation.notes);
    if (notes !== next.notes) {
      next = { ...next };
      if (notes === null) delete next.notes;
      else next.notes = notes;
    }
  }
  if (operation.color !== undefined) {
    const color = parseColor(operation.color);
    if (color !== next.color) {
      next = { ...next };
      if (color === null) delete next.color;
      else next.color = color;
    }
  }
  if (next === item) return doc;
  next.updatedAt = ts;
  const items = [...doc.items];
  items[index] = next;
  return { ...doc, items };
}

/** Validate one browser/internal POST operation. */
export function parseTodoOperation(value: unknown): TodoOperation {
  if (!isRecord(value)) throw new ProjectTodoError("JSON object required");
  const op = value.op;
  if (op === "add") {
    const result: Extract<TodoOperation, { op: "add" }> = { op, title: requireTitle(value.title) };
    if (hasOwn(value, "notes")) result.notes = parseNotes(value.notes);
    if (hasOwn(value, "color")) result.color = parseColor(value.color);
    return result;
  }
  if (op === "update") {
    const result: Extract<TodoOperation, { op: "update" }> = { op, id: requireTodoId(value.id) };
    if (hasOwn(value, "title")) result.title = requireTitle(value.title);
    if (hasOwn(value, "notes")) result.notes = parseNotes(value.notes);
    if (hasOwn(value, "color")) result.color = parseColor(value.color);
    if (result.title === undefined && result.notes === undefined && result.color === undefined) {
      throw new ProjectTodoError("update requires title, notes, or color");
    }
    return result;
  }
  if (op === "complete" || op === "reopen" || op === "delete") {
    return { op, id: requireTodoId(value.id) };
  }
  if (op === "reorder") {
    if (!Array.isArray(value.ids)) throw new ProjectTodoError("ids must be an array of to-do item ids");
    return { op, ids: value.ids.map((id) => requireTodoId(id, "ids")) };
  }
  throw new ProjectTodoError("Unsupported to-do operation");
}

async function ensureTodoDirectory(projectRoot: string): Promise<string> {
  let project: fs.Stats;
  try {
    project = await fs.promises.stat(projectRoot);
  } catch (error) {
    throw new ProjectTodoError(`Unable to access project root: ${errorText(error)}`);
  }
  if (!project.isDirectory()) throw new ProjectTodoError("Project root is not a directory");

  const directory = path.dirname(projectTodoPath(projectRoot));
  try {
    const stat = await fs.promises.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ProjectTodoError(`${path.basename(directory)} must be a real directory`);
    }
  } catch (error) {
    if (!isEnoent(error)) throw error;
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ProjectTodoError(`${path.basename(directory)} must be a real directory`);
    }
  }
  return directory;
}

async function writeTodoDocument(projectRoot: string, doc: TodoDocument): Promise<void> {
  const directory = await ensureTodoDirectory(projectRoot);
  const target = projectTodoPath(projectRoot);
  const temp = path.join(directory, `.todo-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.promises.writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temp, target);
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
  }
}

function getWriteQueue(): Map<string, Promise<void>> {
  if (!globalThis.__codyProjectTodoWrites) globalThis.__codyProjectTodoWrites = new Map();
  return globalThis.__codyProjectTodoWrites;
}

async function serializeProjectTodoWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const queue = getWriteQueue();
  const previous = queue.get(filePath) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(() => undefined, () => undefined);
  queue.set(filePath, settled);
  void settled.then(() => {
    if (queue.get(filePath) === settled) queue.delete(filePath);
  });
  return run;
}

/** Read, mutate, and atomically replace the document without clobbering malformed source. */
export async function mutateProjectTodo(
  projectRoot: string,
  operation: TodoOperation,
): Promise<TodoDocument> {
  const filePath = projectTodoPath(projectRoot);
  return serializeProjectTodoWrite(filePath, async () => {
    const loaded = await readProjectTodo(projectRoot);
    if (loaded.status === "invalid") throw new ProjectTodoError(loaded.reason);
    const doc = applyTodoOperation(loaded.doc, operation);
    if (doc !== loaded.doc) await writeTodoDocument(projectRoot, doc);
    return doc;
  });
}
