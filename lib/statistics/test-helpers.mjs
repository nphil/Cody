// Shared fixtures for the statistics tests: transcript lines shaped like omp's,
// a scratch directory that removes itself, and a way to seed a store directly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

export const load = (file) => jiti.import(file);

/** Fixed clock for every test: 2026-11-12T00:00:00Z. */
export const NOW = Date.parse("2026-11-12T00:00:00Z");

export const IDLE = { updating: false, indexedAt: null, progress: null, error: null };

/** A scratch directory removed when the test ends. */
export function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-stats-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function headerLine(id, cwd, ts, extra = {}) {
  return `${JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd, ...extra })}\n`;
}

/** An assistant message. `cost` undefined records no price at all. */
export function assistantLine(id, ts, o = {}) {
  const usage = { input: o.input ?? 0, output: o.output ?? 0, cacheRead: o.cacheRead ?? 0, cacheWrite: o.cacheWrite ?? 0 };
  if (o.costParts) usage.cost = o.costParts;
  else if (o.cost !== undefined) usage.cost = { total: o.cost };
  return `${JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: o.provider ?? "anthropic", model: o.model ?? "claude-x", usage },
  })}\n`;
}

export function userLine(id, ts) {
  return `${JSON.stringify({ type: "message", id, timestamp: ts, message: { role: "user", content: "hello" } })}\n`;
}

export function sessionInitLine(agent) {
  return `${JSON.stringify({ type: "session_init", agent })}\n`;
}

/** `<root>/<slug>/<ts>_<chat>.jsonl`, written with `lines`. Returns its path. */
export function writeChat(root, slug, chat, lines, stamp = "2026-11-10T00-00-00-000Z") {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}_${chat}.jsonl`);
  fs.writeFileSync(file, lines.join(""));
  return file;
}

/** A subagent transcript in the chat's artifacts directory. */
export function writeArtifact(chatFile, relative, lines) {
  const target = path.join(chatFile.slice(0, -".jsonl".length), relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join(""));
  return target;
}

/** The four directories an index pass needs, inside `base`. */
export function layout(base) {
  const dirs = { sessions: path.join(base, "sessions"), sidebar: path.join(base, "sidebar"), logs: path.join(base, "logs"), index: path.join(base, "index") };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

export function configFor(dirs, now = NOW) {
  return { sessionRoots: [dirs.sessions], sidebarRoots: [dirs.sidebar], logsDir: dirs.logs, now };
}

/** A RawUsage as the scanner produces it. */
export function rawUsage(o = {}) {
  const costTotal = o.cost ?? 0;
  return {
    input: o.input ?? 0,
    output: o.output ?? 0,
    cacheRead: o.cacheRead ?? 0,
    cacheWrite: o.cacheWrite ?? 0,
    costInput: o.costInput ?? 0,
    costOutput: o.costOutput ?? 0,
    costCacheRead: o.costCacheRead ?? 0,
    costCacheWrite: o.costCacheWrite ?? 0,
    costTotal,
  };
}

/**
 * Files one call straight into a store: `where` names the transcript file
 * ({kind, chat, cwd, slug, agent, name, path}), `day` is `YYYY-MM-DD` (noon UTC).
 */
export function addCall(store, where, day, o = {}) {
  const key = where.path ?? `/fake/${where.kind ?? "main"}/${where.chat}/${where.name ?? ""}.jsonl`;
  const file = store.fileFor(key, { kind: where.kind ?? "main", chat: where.chat, cwd: where.cwd, slug: where.slug, name: where.name });
  if (where.agent) file.agent = where.agent;
  store.addRecord(file, {
    ts: o.ts ?? Date.parse(`${day}T12:00:00Z`),
    id: o.id ?? "",
    provider: o.provider ?? "anthropic",
    model: o.model ?? "claude-x",
    worker: o.worker ?? (where.kind === "subagent" ? `subagent:${where.agent ?? ""}` : "main"),
    usage: rawUsage(o),
    turn: o.turn ?? true,
    estimate: false,
  });
  return file;
}

/** Sum of a counter over the rows that pass `keep`. */
export function sumRows(store, field, keep = () => true) {
  let total = 0;
  for (const rows of store.rows.values()) for (const row of rows.values()) if (keep(row)) total += row[field];
  return total;
}

export function allRows(store) {
  return [...store.rows.values()].flatMap((rows) => [...rows.values()]);
}
