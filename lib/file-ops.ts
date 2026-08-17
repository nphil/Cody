import fs from "fs";
import path from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";

/** Thrown by every operation below; the route maps it straight onto the
 * repo's `{ error, code }` JSON shape at the given HTTP status. */
export class FileOpError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Reject empty names, ".", "..", path separators, and NUL bytes — the same
 * rules lib/file-upload.ts enforces per uploaded file name, applied to a
 * single new/renamed entry. Returns the validated name so call sites can
 * `const safe = validateEntryName(name)`. */
export function validateEntryName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new FileOpError("A name is required", "name_required", 400);
  }
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new FileOpError("That name isn't allowed", "invalid_name", 400);
  }
  return name;
}

function resolveRealRoots(roots: Set<string>): Set<string> {
  const realRoots = new Set<string>();
  for (const root of roots) {
    try {
      realRoots.add(fs.realpathSync(root));
    } catch {
      // Stale root derived from a removed session/worktree — ignore.
    }
  }
  return realRoots;
}

/** Authorize + resolve an existing directory new entries get created inside.
 * Mirrors getUploadDirectory() in app/api/files/[...path]/route.ts: check the
 * raw path, then re-check the symlink-resolved real path so a symlink planted
 * inside an allowed root cannot redirect writes outside it. */
async function authorizeParentDirectory(directoryPath: string): Promise<string> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(directoryPath, allowedRoots)) {
    throw new FileOpError("Access denied", "access_denied", 403);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(directoryPath);
  } catch {
    throw new FileOpError("Directory does not exist", "directory_not_found", 404);
  }
  if (!stat.isDirectory()) {
    throw new FileOpError("The path is not a directory", "not_a_directory", 400);
  }

  const realDirectory = fs.realpathSync(directoryPath);
  if (!isFilePathAllowed(realDirectory, resolveRealRoots(allowedRoots))) {
    throw new FileOpError("Access denied", "access_denied", 403);
  }
  return realDirectory;
}

/** Authorize an existing file or directory targeted by rename/delete. Mirrors
 * the GET handler's own allow/exist/allow-again sequence in
 * app/api/files/[...path]/route.ts. `isRoot` flags an authorized root itself
 * (a session cwd, its project root, or an explicitly allowed directory) so
 * callers can refuse to rename or delete the root out from under itself. */
async function authorizeExistingEntry(
  targetPath: string,
): Promise<{ realPath: string; stat: fs.Stats; isRoot: boolean }> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(targetPath, allowedRoots)) {
    throw new FileOpError("Access denied", "access_denied", 403);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    throw new FileOpError("The file or folder was not found", "entry_not_found", 404);
  }
  if (!isExistingFilePathAllowed(targetPath, allowedRoots)) {
    throw new FileOpError("Access denied", "access_denied", 403);
  }

  const realPath = fs.realpathSync(targetPath);
  const isRoot = resolveRealRoots(allowedRoots).has(realPath);
  return { realPath, stat, isRoot };
}

export async function createDirectoryEntry(parentDirectory: string, name: unknown): Promise<string> {
  const safeName = validateEntryName(name);
  const realParent = await authorizeParentDirectory(parentDirectory);
  const destination = path.join(realParent, safeName);
  try {
    fs.mkdirSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FileOpError("An item with that name already exists here", "entry_already_exists", 409);
    }
    throw error;
  }
  return destination;
}

export async function createFileEntry(parentDirectory: string, name: unknown): Promise<string> {
  const safeName = validateEntryName(name);
  const realParent = await authorizeParentDirectory(parentDirectory);
  const destination = path.join(realParent, safeName);
  try {
    // "wx": create-exclusive, so an existing file (or racing duplicate
    // request) fails instead of silently truncating something already there.
    fs.writeFileSync(destination, "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FileOpError("An item with that name already exists here", "entry_already_exists", 409);
    }
    throw error;
  }
  return destination;
}

/** Rename in place: the new name always lands beside the source in the same
 * parent directory, so once the source is authorized the destination inherits
 * the same allowed-root containment with no separate check needed. */
export async function renameEntry(sourcePath: string, newName: unknown): Promise<string> {
  const safeName = validateEntryName(newName);
  const { realPath, isRoot } = await authorizeExistingEntry(sourcePath);
  if (isRoot) {
    throw new FileOpError("This is the top of the workspace and can't be renamed", "cannot_modify_root", 400);
  }
  const destination = path.join(path.dirname(realPath), safeName);
  if (destination === realPath) return destination;
  if (fs.existsSync(destination)) {
    throw new FileOpError("An item with that name already exists here", "entry_already_exists", 409);
  }
  fs.renameSync(realPath, destination);
  return destination;
}

export async function deleteEntry(targetPath: string, recursive: boolean): Promise<void> {
  const { realPath, stat, isRoot } = await authorizeExistingEntry(targetPath);
  if (isRoot) {
    throw new FileOpError("This is the top of the workspace and can't be deleted", "cannot_delete_root", 400);
  }

  if (!stat.isDirectory()) {
    fs.unlinkSync(realPath);
    return;
  }

  if (!recursive) {
    try {
      fs.rmdirSync(realPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        throw new FileOpError(
          "This folder isn't empty — delete recursively to remove it",
          "directory_not_empty",
          409,
        );
      }
      throw error;
    }
    return;
  }

  fs.rmSync(realPath, { recursive: true, force: false });
}
