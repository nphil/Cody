import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-todo-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const todo = await jiti.import("./project-todo.ts");
const todoRoute = await jiti.import("../app/api/todo/route.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

const at = new Date("2026-09-08T12:00:00.000Z");
const json = async (response) => ({ status: response.status, body: await response.json() });

function testProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-project-todo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function add(doc, title, id) {
  return todo.applyTodoOperation(doc, { op: "add", title }, { now: at, idFactory: () => id });
}

test("to-do operations update the item and set timestamps", () => {
  let doc = todo.emptyTodoDocument();
  doc = todo.applyTodoOperation(
    doc,
    { op: "add", title: "  Ship project to-do list  ", notes: "Remember this item", color: "blue" },
    { now: at, idFactory: () => "t_00000001" },
  );
  const firstId = doc.items[0].id;
  assert.deepEqual(doc.items[0], {
    id: firstId,
    title: "Ship project to-do list",
    notes: "Remember this item",
    color: "blue",
    status: "active",
    order: 0,
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
    completedAt: null,
  });
  assert.equal(doc.history, undefined, "no history field should exist");

  doc = todo.applyTodoOperation(doc, { op: "update", id: firstId, title: "Ship manual to-do list", color: "purple" }, { now: at });
  assert.equal(doc.items[0].title, "Ship manual to-do list");
  assert.equal(doc.items[0].color, "purple");

  doc = add(doc, "Document the API", "t_00000002");
  doc = todo.applyTodoOperation(doc, { op: "reorder", ids: ["t_00000002", firstId] }, { now: at });
  assert.deepEqual(doc.items.map((item) => [item.id, item.order]), [["t_00000002", 0], [firstId, 1]]);

  doc = todo.applyTodoOperation(doc, { op: "complete", id: firstId }, { now: at });
  assert.equal(doc.items.find((item) => item.id === firstId).status, "done");
  assert.equal(doc.items.find((item) => item.id === firstId).completedAt, at.toISOString());

  doc = todo.applyTodoOperation(doc, { op: "reopen", id: firstId }, { now: at });
  assert.equal(doc.items.find((item) => item.id === firstId).status, "active");
  assert.equal(doc.items.find((item) => item.id === firstId).completedAt, null);

  doc = todo.applyTodoOperation(doc, { op: "delete", id: firstId }, { now: at });
  assert.equal(doc.items.some((item) => item.id === firstId), false);
});

test("reopening reverses completion and unknown ids are not silently accepted", () => {
  let doc = add(todo.emptyTodoDocument(), "Recover a mistaken completion", "t_00000003");
  doc = todo.applyTodoOperation(doc, { op: "complete", id: "t_00000003" }, { now: at });
  const reopened = todo.applyTodoOperation(doc, { op: "reopen", id: "t_00000003" }, { now: at });
  assert.equal(reopened.items[0].status, "active");
  assert.equal(reopened.items[0].completedAt, null);
  assert.throws(
    () => todo.applyTodoOperation(reopened, { op: "complete", id: "t_missing1" }, { now: at }),
    (error) => error instanceof todo.ProjectTodoError && error.code === "not_found",
  );
});

test("malformed project files are reported and never overwritten", async (t) => {
  const root = testProject(t);
  const todoDir = path.join(root, ".cody");
  fs.mkdirSync(todoDir);
  fs.writeFileSync(path.join(todoDir, "todo.json"), "{ invalid json");

  const result = await todo.readProjectTodo(root);
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /Invalid JSON/u);

  await assert.rejects(
    () => todo.mutateProjectTodo(root, { op: "add", title: "Must not replace malformed content" }),
    (error) => error instanceof todo.ProjectTodoError,
  );
  const stillBroken = fs.readFileSync(path.join(todoDir, "todo.json"), "utf8");
  assert.equal(stillBroken, "{ invalid json");
});

test("to-do storage refuses a symlinked .cody directory", async (t) => {
  const root = testProject(t);
  const realTodoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-todo-real-"));
  t.after(() => fs.rmSync(realTodoDir, { recursive: true, force: true }));
  fs.symlinkSync(realTodoDir, path.join(root, ".cody"), "dir");

  await assert.rejects(
    () => todo.mutateProjectTodo(root, { op: "add", title: "Must stay in the project" }),
    (error) => error instanceof todo.ProjectTodoError && error.message.includes("must be a real directory"),
  );
});

test("project mutations preserve unknown top-level fields and drop legacy history", async (t) => {
  const root = testProject(t);
  const todoDir = path.join(root, ".cody");
  fs.mkdirSync(todoDir);
  fs.writeFileSync(path.join(todoDir, "todo.json"), JSON.stringify({
    version: 1,
    items: [],
    history: [{ ts: "2026-09-08T12:00:00Z", itemId: "t_old", action: "created", title: "old" }],
    externalMetadata: { owner: "another tool" },
  }));

  await todo.mutateProjectTodo(root, { op: "add", title: "Keep project metadata" });
  const stored = JSON.parse(fs.readFileSync(path.join(todoDir, "todo.json"), "utf8"));
  assert.deepEqual(stored.externalMetadata, { owner: "another tool" });
  assert.equal(stored.history, undefined, "legacy history field should be dropped");
});

test("parallel project mutations retain every added item", async (t) => {
  const root = testProject(t);
  await Promise.all(Array.from({ length: 24 }, (_, index) =>
    todo.mutateProjectTodo(root, { op: "add", title: `Concurrent item ${String(index)}` }),
  ));

  const loaded = await todo.readProjectTodo(root);
  assert.equal(loaded.status, "loaded");
  assert.equal(loaded.doc.items.length, 24);
  assert.equal(new Set(loaded.doc.items.map((item) => item.id)).size, 24);
});

test("public to-do route adds, completes, and reopens a project item", async (t) => {
  const root = testProject(t);
  allowFileRoot(root);

  let res = await todoRoute.POST(
    new Request(`http://api/api/todo?cwd=${encodeURIComponent(root)}`, {
      method: "POST",
      body: JSON.stringify({ op: "add", title: "Canary item" }),
      headers: new Map([["content-type", "application/json"]]),
    }),
  );
  let result = await json(res);
  assert.equal(result.status, 200);
  const itemId = result.body.doc.items[0].id;

  res = await todoRoute.POST(
    new Request(`http://api/api/todo?cwd=${encodeURIComponent(root)}`, {
      method: "POST",
      body: JSON.stringify({ op: "complete", id: itemId }),
      headers: new Map([["content-type", "application/json"]]),
    }),
  );
  result = await json(res);
  assert.equal(result.status, 200);
  assert.equal(result.body.doc.items[0].status, "done");

  res = await todoRoute.POST(
    new Request(`http://api/api/todo?cwd=${encodeURIComponent(root)}`, {
      method: "POST",
      body: JSON.stringify({ op: "reopen", id: itemId }),
      headers: new Map([["content-type", "application/json"]]),
    }),
  );
  result = await json(res);
  assert.equal(result.status, 200);
  assert.equal(result.body.doc.items[0].status, "active");
});

test("public route rejects an unrecognized project root with a validation error", async () => {
  const res = await todoRoute.POST(
    new Request("http://api/api/todo?cwd=/nonexistent", {
      method: "POST",
      body: JSON.stringify({ op: "add", title: "Orphan item" }),
      headers: new Map([["content-type", "application/json"]]),
    }),
  );
  const result = await json(res);
  assert.equal(result.status, 400);
});

