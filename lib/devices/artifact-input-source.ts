import { createHash, randomUUID } from "node:crypto";
import { constants, type ReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ARTIFACT_IMPORT_TIMEOUT_MS, validArtifactPath, type WorkspaceImport } from "./protocol";
import { openProjectDirectory, pinnedChild } from "./project-directory";

/** The caller supplies the live session's cwd, never a request argument. Walk from a pinned directory at each step:
 * checking realpath and opening later would follow a directory replaced with a link between the two. */
async function openImage(cwd: string, relative: string) {
  if (!path.isAbsolute(cwd) || !validArtifactPath(relative)) throw new Error("Use a file path relative to this chat's workspace (no links, URLs or '..').");
  // Linux O_PATH names an inode without opening a device node or waiting on a FIFO. Node omits this Linux flag.
  const O_PATH = 0o10000000;
  const parts = relative.split("/");
  const name = parts.pop()!;
  const dir = await openProjectDirectory(cwd, parts);
  try {
    const ref = await open(pinnedChild(dir, name), O_PATH | constants.O_NOFOLLOW);
    try {
      const stat = await ref.stat();
      if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size <= 0) throw new Error("Import requires a non-empty regular file, not a directory, link or device.");
      return { file: await open(`/proc/self/fd/${ref.fd}`, constants.O_RDONLY), size: stat.size };
    } finally { await ref.close(); }
  } finally { await dir.close(); }
}

interface Ticket { sessionId: string; file: FileHandle; size: number; stream?: ReadStream }
const state = globalThis as typeof globalThis & { __codyWorkspaceImports?: Map<string, Ticket> };
const tickets = state.__codyWorkspaceImports ??= new Map<string, Ticket>();

/** A one-use URL is live only while the initiating, session-bound bridge request is pending. No path in the URL. */
export async function withWorkspaceImage<T>(sessionId: string, cwd: string, relative: string, expected: string | undefined, send: (image: WorkspaceImport, remainingMs: number) => Promise<T>): Promise<T> {
  const deadline = Date.now() + ARTIFACT_IMPORT_TIMEOUT_MS;
  const { file, size } = await openImage(cwd, relative);
  const hash = createHash("sha256");
  const token = randomUUID();
  const ticket: Ticket = { sessionId, file, size };
  try {
    const buffer = Buffer.allocUnsafe(Math.min(size, 256 * 1024));
    for (let position = 0; position < size;) {
      if (Date.now() >= deadline) throw new Error("Workspace image hashing timed out. Nothing was imported.");
      const { bytesRead } = await file.read(buffer, 0, Math.min(size - position, buffer.length), position);
      if (!bytesRead) throw new Error("The workspace file changed during hashing.");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if ((await file.stat()).size !== size) throw new Error("The workspace file changed during hashing.");
    const sha256 = hash.digest("hex");
    if (expected !== undefined && expected.toLowerCase() !== sha256) throw new Error("Workspace SHA-256 does not match the expected digest. Nothing was imported.");
    tickets.set(token, ticket);
    return await send({ token, name: path.basename(relative), size, sha256 }, Math.max(1, deadline - Date.now()));
  } finally {
    tickets.delete(token);
    ticket.stream?.destroy();
    await file.close();
  }
}

/** Called only after checking the account can open the chat. Read the hashed descriptor, never reopen a pathname. */
export async function consumeWorkspaceImage(sessionId: string, token: string, signal: AbortSignal): Promise<Response> {
  const ticket = tickets.get(token);
  if (!ticket || ticket.sessionId !== sessionId) return new Response(null, { status: 404 });
  tickets.delete(token);
  const { file, size } = ticket;
  const stream = ticket.stream = file.createReadStream({ start: 0, end: size - 1, signal });
  return new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 1 } }) as unknown as ReadableStream<Uint8Array>, {
    headers: { "content-type": "application/octet-stream", "content-disposition": "attachment", "content-length": String(size), "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
