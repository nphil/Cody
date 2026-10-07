import { handleBegin, handleList } from "@/lib/devices/artifact-vault-http";

export const dynamic = "force-dynamic";

/**
 * `GET ?sessionId=<chat>[&unfinished=1]` - the finished saves of the artifact vault this account may open, newest first,
 * each ONE .zip archive, with its path and size and every file's name, size and SHA-256 (the page matches its own files
 * against them to show what is already on the server).
 *
 * `POST` - announce a save: `{sessionId, label, key?, timeZone?, files: [{name, size, sha256, ...}]}`. Answers the save's
 * status: the files already stored (a retry carries on from there), or `existing` when the same save is already complete.
 * See lib/devices/artifact-vault.ts for the whole protocol.
 */
export const GET = (request: Request) => handleList(request);
export const POST = (request: Request) => handleBegin(request);
