/**
 * Nest Git's flat changed-file list into a directory tree for the Git panel's
 * tree view.
 *
 * Git status hands back one flat list of repository-relative paths, so unlike
 * the Files tab (which lazily lists one directory at a time from disk) the
 * whole tree is known up front and this stays a pure, synchronous transform.
 * Keeping it out of the component makes the ordering rules testable.
 */

/** A changed file at a leaf of the tree. `path` is the full repository-relative
 * path (the key used to look the file's status back up); `name` is only the
 * final segment shown in the row. */
export interface GitFileTreeFileNode {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
}

/** A directory grouping. `path` is the full directory path and doubles as the
 * stable key the panel tracks expand/collapse state under. */
export interface GitFileTreeDirectoryNode {
  readonly kind: "directory";
  readonly name: string;
  readonly path: string;
  readonly children: readonly GitFileTreeNode[];
}

export type GitFileTreeNode = GitFileTreeDirectoryNode | GitFileTreeFileNode;

interface DirectoryAccumulator {
  readonly path: string;
  readonly directories: Map<string, DirectoryAccumulator>;
  readonly files: GitFileTreeFileNode[];
}

/**
 * Build a nested tree from repository-relative file paths.
 *
 * Directories sort before files, each group alphabetically by its own segment
 * name (`localeCompare`, so casing does not split the alphabet the way a raw
 * `<` comparison would). Duplicate paths collapse to one leaf — a rename that
 * reports the same destination twice must not render two identical rows.
 * Empty and `.` segments are dropped so `./a/b` and `a//b` both nest as `a/b`.
 */
export function buildGitFileTree(paths: readonly string[]): GitFileTreeNode[] {
  const root = createDirectory("");
  const seen = new Set<string>();

  for (const path of paths) {
    const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
    const name = segments[segments.length - 1];
    if (name === undefined) continue;

    // Key on the normalized path, not the raw input: "./a" and "a" are the
    // same file and would otherwise both survive deduplication.
    const normalized = segments.join("/");
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    let directory = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      directory = childDirectory(directory, segments[index]);
    }
    directory.files.push({ kind: "file", name, path: normalized });
  }

  return finalize(root);
}

/**
 * Every directory path in the tree, pre-order. The panel uses this to seed
 * "expanded by default" state and to drive expand-all / collapse-all.
 */
export function collectGitFileTreeDirectoryPaths(nodes: readonly GitFileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectGitFileTreeDirectoryPaths(node.children));
  }
  return paths;
}

function createDirectory(path: string): DirectoryAccumulator {
  return { path, directories: new Map(), files: [] };
}

function childDirectory(parent: DirectoryAccumulator, segment: string): DirectoryAccumulator {
  const existing = parent.directories.get(segment);
  if (existing !== undefined) return existing;
  const created = createDirectory(parent.path.length === 0 ? segment : `${parent.path}/${segment}`);
  parent.directories.set(segment, created);
  return created;
}

function finalize(directory: DirectoryAccumulator): GitFileTreeNode[] {
  const directories = [...directory.directories.entries()]
    .map(([name, child]): GitFileTreeDirectoryNode => ({
      kind: "directory",
      name,
      path: child.path,
      children: finalize(child),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [...directory.files].sort((left, right) => left.name.localeCompare(right.name));
  return [...directories, ...files];
}
