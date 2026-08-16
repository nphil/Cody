import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildGitFileTree, collectGitFileTreeDirectoryPaths } = await jiti.import("./git-file-tree.ts");

/** Compact shape assertions read better than deep-equalling whole node objects. */
function outline(nodes) {
  return nodes.map((node) => (
    node.kind === "directory"
      ? { dir: node.path, children: outline(node.children) }
      : { file: node.path }
  ));
}

test("an empty list produces an empty tree", () => {
  assert.deepEqual(buildGitFileTree([]), []);
  assert.deepEqual(collectGitFileTreeDirectoryPaths([]), []);
});

test("root-level files stay at the root", () => {
  assert.deepEqual(outline(buildGitFileTree(["package.json", "next.config.ts"])), [
    { file: "next.config.ts" },
    { file: "package.json" },
  ]);
});

test("ordering is case-insensitive, so caps do not sort into their own block", () => {
  // localeCompare, not `<`: an all-caps README belongs next to its neighbours,
  // where a code-point sort would strand every capitalized name up top.
  assert.deepEqual(outline(buildGitFileTree(["package.json", "README.md", "app.ts"])), [
    { file: "app.ts" },
    { file: "package.json" },
    { file: "README.md" },
  ]);
});

test("nested paths become nested directory nodes carrying full paths", () => {
  const tree = buildGitFileTree(["src/lib/deep/file.ts"]);
  assert.deepEqual(outline(tree), [
    {
      dir: "src",
      children: [
        { dir: "src/lib", children: [{ dir: "src/lib/deep", children: [{ file: "src/lib/deep/file.ts" }] }] },
      ],
    },
  ]);
  assert.equal(tree[0].name, "src");
  assert.equal(tree[0].children[0].children[0].children[0].name, "file.ts");
});

test("siblings sharing a prefix share one directory node", () => {
  assert.deepEqual(outline(buildGitFileTree(["src/a.ts", "src/b.ts"])), [
    { dir: "src", children: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
  ]);
});

test("directories sort before files, each alphabetically", () => {
  const tree = buildGitFileTree(["zeta.txt", "alpha.txt", "src/one.ts", "app/two.ts"]);
  assert.deepEqual(outline(tree), [
    { dir: "app", children: [{ file: "app/two.ts" }] },
    { dir: "src", children: [{ file: "src/one.ts" }] },
    { file: "alpha.txt" },
    { file: "zeta.txt" },
  ]);
});

test("ordering is by segment name, not by input order or full path", () => {
  const tree = buildGitFileTree(["src/z/last.ts", "src/a/first.ts", "src/mid.ts"]);
  assert.deepEqual(outline(tree), [
    {
      dir: "src",
      children: [
        { dir: "src/a", children: [{ file: "src/a/first.ts" }] },
        { dir: "src/z", children: [{ file: "src/z/last.ts" }] },
        { file: "src/mid.ts" },
      ],
    },
  ]);
});

test("duplicate paths collapse to a single leaf", () => {
  assert.deepEqual(outline(buildGitFileTree(["src/a.ts", "src/a.ts", "./src/a.ts"])), [
    { dir: "src", children: [{ file: "src/a.ts" }] },
  ]);
});

test("empty and dot segments are dropped", () => {
  assert.deepEqual(outline(buildGitFileTree(["./src//a.ts", "b.ts", "", "/"])), [
    { dir: "src", children: [{ file: "src/a.ts" }] },
    { file: "b.ts" },
  ]);
});

test("directory paths are collected pre-order", () => {
  const tree = buildGitFileTree(["src/lib/a.ts", "src/b.ts", "app/c.ts"]);
  assert.deepEqual(collectGitFileTreeDirectoryPaths(tree), ["app", "src", "src/lib"]);
});

test("a tree of only files has no directory paths", () => {
  assert.deepEqual(collectGitFileTreeDirectoryPaths(buildGitFileTree(["a.ts", "b.ts"])), []);
});
