import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import * as path from "node:path";

function checkPart(part: string): void {
  if (!part.trim() || part.startsWith(".") || /[/\\:\u0000-\u001f\u007f]/.test(part)) {
    throw new Error("Use a project-relative path without hidden names, traversal, empty components or absolute paths.");
  }
}

/** Linux resolves the next name against the open directory, not a possibly replaced ancestor. */
export function pinnedChild(parent: FileHandle, name: string): string {
  checkPart(name);
  return `/proc/self/fd/${parent.fd}/${name}`;
}

/** The trusted project must already exist; only caller-selected subdirectories may be created. Close the returned handle after the final file operation. */
export async function openProjectDirectory(cwd: string, parts: readonly string[], create = false): Promise<FileHandle> {
  if (process.platform !== "linux") throw new Error("Secure project artifact access requires a Linux or WSL Cody server.");
  if (!path.isAbsolute(cwd) || path.resolve(cwd) === "/" || cwd.split("/").includes("..")) throw new Error("A non-root project working directory is required.");
  parts.forEach(checkPart);
  const project = path.resolve(cwd).split("/").filter(Boolean);
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let parent = await open("/", flags);
  try {
    for (const [i, part] of [...project, ...parts].entries()) {
      const child = `/proc/self/fd/${parent.fd}/${part}`;
      if (create && i >= project.length) await mkdir(child, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => { if (err.code !== "EEXIST") throw err; });
      const next = await open(child, flags);
      await parent.close();
      parent = next;
    }
    return parent;
  } catch (error) {
    await parent.close();
    throw error;
  }
}
