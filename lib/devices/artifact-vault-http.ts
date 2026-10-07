/**
 * The HTTP face of the artifact vault (./artifact-vault.ts): who may do what,
 * and how a request body becomes a slice of a file. The route files under
 * `app/api/devices/artifacts/` are one line each over these.
 *
 * Auth is the same perimeter every route has (a session cookie, a personal
 * access token or Basic with the instance password), plus two checks of its
 * own: the chat a save belongs to must be one the caller can open
 * (`canAccessSession`), and a save made by one account is invisible to
 * another. An open instance (no accounts) sees everything, as it does elsewhere.
 */

import { NextResponse } from "next/server";
import { requireUserOrOpenInstance } from "../auth/http";
import { canAccessSession } from "../auth/session-owners";
import type { UserRecord } from "../auth/users";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "../bounded-form-data";
import { describeDiskError } from "../disk-space";
import { isRecord } from "../type-guards";
import {
  appendChunk,
  beginSave,
  completeSave,
  listSaves,
  removeSave,
  saveOwnership,
  saveStatus,
  VaultError,
  vaultConfig,
  verifyFile,
  type SaveStatus,
  type VaultConfig,
} from "./artifact-vault";

const NO_STORE = { "Cache-Control": "no-store" };
/** A begin request names every file: 4,096 of them with provenance fits well inside this. */
const MAX_JSON_BYTES = 4 * 1024 * 1024;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function failure(error: unknown): NextResponse {
  if (error instanceof VaultError) return json({ error: error.message, code: error.code, ...error.details }, error.status);
  if (error instanceof RequestBodyTooLargeError) return json({ error: "The request is larger than a save request may be.", code: "request_too_large" }, 413);
  const message = error instanceof Error ? error.message : String(error);
  const disk = describeDiskError(`${message} ${(error as NodeJS.ErrnoException | undefined)?.code ?? ""}`);
  if (disk) return json({ error: "The server ran out of disk space while writing this save. Free some space and try again; what already arrived is kept.", code: "disk_full" }, 507);
  return json({ error: message, code: "server_error" }, 500);
}

function mayOpen(user: UserRecord | null, save: { owner: string | null; sessionId: string }): boolean {
  const ownsIt = save.owner === null || user === null || save.owner === user.id;
  return ownsIt && canAccessSession(save.sessionId, user);
}

interface Caller {
  readonly user: UserRecord | null;
  readonly config: VaultConfig;
}

function identify(request: Request, config: VaultConfig): Caller | NextResponse {
  const actor = requireUserOrOpenInstance(request);
  return "response" in actor ? actor.response : { user: actor.user, config };
}

/** The save, only when this caller may open it; a save that is not theirs is reported as missing, not as forbidden. */
async function openable(caller: Caller, saveId: string): Promise<SaveStatus> {
  const status = await saveStatus(caller.config, saveId);
  if (!status || !mayOpen(caller.user, status)) throw new VaultError(404, "unknown_save", "That save does not exist.");
  return status;
}

/** The same check for a request that has no use for the file counts: a slice arrives once per few megabytes. */
async function authorize(caller: Caller, saveId: string): Promise<void> {
  const owned = await saveOwnership(caller.config, saveId);
  if (!owned || !mayOpen(caller.user, owned)) throw new VaultError(404, "unknown_save", "That save does not exist.");
}

async function readSlice(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) throw new VaultError(411, "length_required", "A slice needs a Content-Length header.");
  const expected = Number(declared);
  if (expected === 0) throw new VaultError(400, "empty_chunk", "A slice cannot be empty.");
  if (expected > limit) throw new VaultError(413, "chunk_too_large", `One slice may be at most ${limit} bytes; this one declares ${expected}. Send smaller slices.`);
  const reader = request.body?.getReader();
  if (!reader) throw new VaultError(400, "empty_chunk", "The slice had no body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new VaultError(413, "chunk_too_large", `One slice may be at most ${limit} bytes. Send smaller slices.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // A body the framework cut short (it buffers only the first 10 MB when a proxy sits in front of a route) or a dropped
  // connection arrives as fewer bytes than declared. Nothing was written, so the sender can simply try again.
  if (size !== expected) throw new VaultError(400, "truncated", `The slice declared ${expected} bytes but ${size} arrived, so nothing was stored. Send it again.`);
  return Buffer.concat(chunks, size);
}

function integer(value: string | null, name: string): number {
  if (value === null || !/^\d{1,16}$/.test(value)) throw new VaultError(400, "invalid_request", `${name} must be a whole number.`);
  return Number(value);
}

/** POST: announce a save, or carry on with / learn about the one this is. */
export async function handleBegin(request: Request, config: VaultConfig = vaultConfig()): Promise<NextResponse> {
  const caller = identify(request, config);
  if (caller instanceof NextResponse) return caller;
  try {
    const body = await parseJsonWithinLimit<unknown>(request, MAX_JSON_BYTES).catch((error: unknown) => {
      if (error instanceof RequestBodyTooLargeError) throw error;
      throw new VaultError(400, "invalid_request", "The save request is not valid JSON.");
    });
    const sessionId = isRecord(body) && typeof body.sessionId === "string" ? body.sessionId : "";
    if (sessionId && !canAccessSession(sessionId, caller.user)) throw new VaultError(403, "access_denied", "That chat belongs to another account, so its files cannot be saved from here.");
    const status = await beginSave(config, { owner: caller.user?.id ?? null, ...(caller.user ? { ownerName: caller.user.username } : {}) }, body);
    return json(status);
  } catch (error) {
    return failure(error);
  }
}

/** GET: finished saves (one archive each) this caller may open, optionally one chat's, newest first. */
export async function handleList(request: Request, config: VaultConfig = vaultConfig()): Promise<NextResponse> {
  const caller = identify(request, config);
  if (caller instanceof NextResponse) return caller;
  try {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    if (sessionId !== undefined && !canAccessSession(sessionId, caller.user)) throw new VaultError(403, "access_denied", "That chat belongs to another account.");
    const saves = await listSaves(config, { ...(sessionId === undefined ? {} : { sessionId }), unfinished: url.searchParams.get("unfinished") === "1" }, (save) => mayOpen(caller.user, save));
    return json({ root: config.root, limits: config.limits, saves });
  } catch (error) {
    return failure(error);
  }
}

export async function handleStatus(request: Request, saveId: string, config: VaultConfig = vaultConfig()): Promise<NextResponse> {
  const caller = identify(request, config);
  if (caller instanceof NextResponse) return caller;
  try {
    return json(await openable(caller, saveId));
  } catch (error) {
    return failure(error);
  }
}

/** PUT `?file=<index>&offset=<bytes already stored>`: one slice of a file, as the raw request body. */
export async function handleSlice(request: Request, saveId: string, config: VaultConfig = vaultConfig()): Promise<NextResponse> {
  const caller = identify(request, config);
  if (caller instanceof NextResponse) return caller;
  try {
    await authorize(caller, saveId);
    const url = new URL(request.url);
    const file = integer(url.searchParams.get("file"), "file");
    const offset = integer(url.searchParams.get("offset"), "offset");
    const bytes = await readSlice(request, config.limits.maxChunkBytes);
    return json(await appendChunk(config, saveId, file, offset, bytes));
  } catch (error) {
    return failure(error);
  }
}

/**
 * POST `{action: "verify", file}` re-reads one finished file from disk; `{action: "complete"}` builds the save's one
 * archive: it answers `complete` when that is quick, `building` (with `packedBytes`) when it is not, and the sender then
 * asks with GET until it is `complete`. A second `complete` joins the build that is running.
 */
export async function handleAction(request: Request, saveId: string, config: VaultConfig = vaultConfig()): Promise<NextResponse> {
  const caller = identify(request, config);
  if (caller instanceof NextResponse) return caller;
  try {
    await authorize(caller, saveId);
    const body = await parseJsonWithinLimit<unknown>(request, 4096).catch(() => {
      throw new VaultError(400, "invalid_request", "The request is not valid JSON.");
    });
    if (!isRecord(body)) throw new VaultError(400, "invalid_request", "The request is not a JSON object.");
    if (body.action === "verify") {
      if (typeof body.file !== "number" || !Number.isInteger(body.file) || body.file < 0) throw new VaultError(400, "invalid_request", "Verify needs the file number.");
      return json({ ok: true, ...(await verifyFile(config, saveId, body.file)) });
    }
    if (body.action === "complete") return json(await completeSave(config, saveId));
    throw new VaultError(400, "invalid_request", "The action must be verify or complete.");
  } catch (error) {
    return failure(error);
  }
}

/** DELETE: abandon an unfinished save, or delete a finished one from the server. */
export async function handleDelete(request: Request, saveId: string, config: VaultConfig = vaultConfig()): Promise<NextResponse> {
  const caller = identify(request, config);
  if (caller instanceof NextResponse) return caller;
  try {
    await authorize(caller, saveId);
    return json({ removed: await removeSave(config, saveId) });
  } catch (error) {
    return failure(error);
  }
}
