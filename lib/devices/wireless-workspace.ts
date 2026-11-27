import { constants } from "node:fs";
import { link, mkdtemp, open, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { openProjectDirectory, pinnedChild } from "./project-directory";
import { WIRELESS_MAX_FILE_BYTES } from "./wireless-types";

export class WirelessWorkspaceError extends Error {}

function workspaceError(error: unknown): WirelessWorkspaceError {
  if (error instanceof WirelessWorkspaceError) return error;
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "ENOENT": return new WirelessWorkspaceError("The workspace file or parent directory does not exist.");
    case "EEXIST": return new WirelessWorkspaceError("That workspace path already exists; nothing was overwritten.");
    case "ELOOP":
    case "ENOTDIR": return new WirelessWorkspaceError("Use the real workspace path, not a link or a path through a file.");
    default: return new WirelessWorkspaceError("Could not access the workspace file. Use a file in this chat's workspace.");
  }
}

/** Pin every ancestor and then the file before opening it for reading. O_PATH cannot open a device or wait on a FIFO. */
export async function readWirelessWorkspaceFile(cwd: string, relative: string, signal: AbortSignal): Promise<Buffer> {
  const parts = relative.split("/");
  const name = parts.pop()!;
  try {
    signal.throwIfAborted();
    const parent = await openProjectDirectory(cwd, parts);
    try {
      signal.throwIfAborted();
      const ref = await open(pinnedChild(parent, name), 0o10000000 /* Linux O_PATH */ | constants.O_NOFOLLOW);
      try {
        const before = await ref.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== BigInt(1)) throw new WirelessWorkspaceError("Send a regular workspace file, not a link or device.");
        if (before.size > BigInt(WIRELESS_MAX_FILE_BYTES)) throw new WirelessWorkspaceError("The workspace file exceeds the wireless transfer size limit.");
        signal.throwIfAborted();
        const file = await open(`/proc/self/fd/${ref.fd}`, constants.O_RDONLY);
        try {
          signal.throwIfAborted();
          const data = Buffer.allocUnsafe(Number(before.size));
          for (let offset = 0; offset < data.length;) {
            signal.throwIfAborted();
            const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
            if (bytesRead === 0) throw new WirelessWorkspaceError("The workspace file changed during the read.");
            offset += bytesRead;
          }
          const after = await file.stat({ bigint: true });
          if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            throw new WirelessWorkspaceError("The workspace file changed during the read.");
          }
          signal.throwIfAborted();
          return data;
        } finally { await file.close(); }
      } finally { await ref.close(); }
    } finally { await parent.close(); }
  } catch (error) {
    signal.throwIfAborted();
    throw workspaceError(error);
  }
}

/** Publish the complete download at once. Neither an existing file nor a symlink can be replaced. */
export async function saveWirelessWorkspaceFile(cwd: string, relative: string, data: Buffer, signal: AbortSignal): Promise<void> {
  if (data.length > WIRELESS_MAX_FILE_BYTES) throw new WirelessWorkspaceError("The tablet file exceeds the wireless transfer size limit.");
  const parts = relative.split("/");
  const name = parts.pop()!;
  try {
    signal.throwIfAborted();
    const parent = await openProjectDirectory(cwd, parts);
    try {
      signal.throwIfAborted();
      const parentFd = `/proc/self/fd/${parent.fd}`;
      const dest = pinnedChild(parent, name);
      const staging = await mkdtemp(`${parentFd}/.cody-wireless-`);
      try {
        const directory = await open(staging, constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const temporary = `/proc/self/fd/${directory.fd}/download.part`;
        try {
          await writeFile(temporary, data, { flag: "wx", mode: 0o600, signal });
          if (await realpath(parentFd) !== path.resolve(cwd, ...parts)) throw new WirelessWorkspaceError("The workspace directory moved during the download.");
          signal.throwIfAborted();
          await link(temporary, dest);
        } finally {
          await unlink(temporary).catch(() => {});
          await directory.close();
        }
      } finally {
        await rmdir(staging).catch(() => {});
      }
    } finally { await parent.close(); }
  } catch (error) {
    signal.throwIfAborted();
    throw workspaceError(error);
  }
}
