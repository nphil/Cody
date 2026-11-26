import { constants } from "node:fs";
import { copyFile, link, lstat, mkdtemp, open, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { verifyArchiveFile, type ExpectedArchive } from "./artifact-archive-verify";
import { openProjectDirectory, pinnedChild } from "./project-directory";

function fdPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}

async function stageFromVault(archive: string, temporary: string): Promise<void> {
  const vault = await openProjectDirectory(path.dirname(archive), []);
  try {
    const source = await open(pinnedChild(vault, path.basename(archive)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await source.stat()).isFile()) throw new Error("The saved archive is not a regular file.");
      await copyFile(fdPath(source), temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    } finally {
      await source.close();
    }
  } finally {
    await vault.close();
  }
}

/** Publish only a verified, independent copy. A hard link from the private staging folder takes the final name atomically and cannot replace a file. */
export async function copyVerifiedBackup(archive: string, expected: ExpectedArchive, cwd: string, directory: string): Promise<string> {
  const parent = await openProjectDirectory(cwd, directory.split("/"), true);
  const basename = path.basename(archive);
  const dest = pinnedChild(parent, basename);
  try {
    if (await lstat(dest).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; })) {
      throw new Error(`A file named ${basename} already exists in the backup directory; nothing was overwritten.`);
    }
    const stagingName = await mkdtemp(path.join(fdPath(parent), ".cody-export-"));
    try {
      const staging = await open(stagingName, constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const temporary = path.join(fdPath(staging), "archive.part");
        await stageFromVault(archive, temporary);
        try {
          const copy = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            await copy.chmod(0o600);
            await copy.sync();
            await verifyArchiveFile(fdPath(copy), expected);
          } finally {
            await copy.close();
          }
          if (await realpath(fdPath(parent)) !== path.resolve(cwd, directory)) throw new Error("The project backup directory moved during export.");
          await link(temporary, dest);
        } finally {
          await unlink(temporary);
        }
      } finally {
        await staging.close();
      }
    } finally {
      await rmdir(stagingName);
    }
    return path.join(cwd, directory, basename);
  } finally {
    await parent.close();
  }
}
