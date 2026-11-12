import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readNativeRolePriorities } = await jiti.import("./roster.ts");
const { findOmpPackageRoot } = await jiti.import("../omp/package-source.ts");

const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A stand-in omp: its catalog package with a `compat/rules.json`, and optionally the old `src/priority.json`. */
function fakeOmp({ rules, priority } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "cody-roster-"));
  roots.push(root);
  const catalog = path.join(root, "node_modules", "@oh-my-pi", "pi-catalog");
  mkdirSync(path.join(catalog, "src", "compat"), { recursive: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "0.0.0" }));
  writeFileSync(path.join(catalog, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-catalog", version: "0.0.0", exports: { ".": { import: "./src/index.ts" } } }));
  writeFileSync(path.join(catalog, "src", "index.ts"), "export {};\n");
  if (rules !== undefined) writeFileSync(path.join(catalog, "src", "compat", "rules.json"), typeof rules === "string" ? rules : JSON.stringify(rules));
  if (priority !== undefined) writeFileSync(path.join(root, "src", "priority.json"), typeof priority === "string" ? priority : JSON.stringify(priority));
  return root;
}

test("a newer omp's role chains come from its catalog rules, smol and slow only", () => {
  const root = fakeOmp({
    rules: { behavior: { roleDefaults: { smol: ["claude-haiku-5-5", "openai/gpt-5-mini"], slow: ["anthropic/claude-fable-5-2"], judge: ["typesafe/jev-1.14.0", "@tiny"] } } },
  });
  assert.deepEqual(readNativeRolePriorities(root), {
    smol: ["claude-haiku-5-5", "openai/gpt-5-mini"],
    slow: ["anthropic/claude-fable-5-2"],
  });
});

test("an older omp's src/priority.json still works, and the catalog's chains win when both exist", () => {
  const oldOnly = fakeOmp({
    rules: { behavior: { openaiResponsesHeuristic: null } },
    priority: { smol: ["gemini-3.8-flash"], slow: ["gpt-5.6-sol"], image: ["x"] },
  });
  assert.deepEqual(readNativeRolePriorities(oldOnly), { smol: ["gemini-3.8-flash"], slow: ["gpt-5.6-sol"] });

  const noRulesFile = fakeOmp({ priority: { smol: ["only-smol"] } });
  assert.deepEqual(readNativeRolePriorities(noRulesFile), { smol: ["only-smol"] });

  const both = fakeOmp({
    rules: { behavior: { roleDefaults: { smol: ["from-catalog"] } } },
    priority: { smol: ["from-file"], slow: ["from-file-slow"] },
  });
  assert.deepEqual(readNativeRolePriorities(both), { smol: ["from-catalog"] });
});

test("a malformed chain is ignored as a whole, and no hints is undefined with one warning", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const malformed = fakeOmp({ rules: { behavior: { roleDefaults: { smol: ["fine"], slow: [1, 2] } } } });
  // The catalog's smol list is fine: the bad slow list is dropped and smol is kept.
  assert.deepEqual(readNativeRolePriorities(malformed), { smol: ["fine"] });
  assert.equal(warn.mock.callCount(), 0);

  const nothing = fakeOmp({ rules: "{ not json", priority: "{ not json" });
  assert.equal(readNativeRolePriorities(nothing), undefined);
  assert.equal(readNativeRolePriorities(fakeOmp({})), undefined);
  assert.equal(readNativeRolePriorities(null), undefined);
  assert.equal(warn.mock.callCount(), 1, "the missing hints are said once, not on every plan");
  assert.match(String(warn.mock.calls[0].arguments[0]), /smol\/slow ranking could not be read/);
});

test("the installed omp's own smol and slow chains are found, whichever side of the move it is on", { skip: findOmpPackageRoot() ? false : "omp is not installed" }, () => {
  const lists = readNativeRolePriorities();
  assert.ok(lists, "the installed omp ships role chains and Cody found them");
  for (const role of ["smol", "slow"]) {
    assert.ok(Array.isArray(lists[role]) && lists[role].length > 5, `${role} has a chain`);
    assert.ok(lists[role].every((entry) => typeof entry === "string" && entry.length > 0));
  }
});
