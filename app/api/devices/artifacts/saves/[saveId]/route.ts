import { handleAction, handleDelete, handleSlice, handleStatus } from "@/lib/devices/artifact-vault-http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ saveId: string }> };

/**
 * One save of the artifact vault (lib/devices/artifact-vault.ts).
 *
 * `GET` - its status: every file's stored length and whether it verified, and while the archive is being written how
 * much is packed (`state: "building"`), or why the last attempt stopped (`buildError`).
 * `PUT ?file=<index>&offset=<bytes already stored>` - one slice of a file as the raw body (at most 8 MiB, with a
 * Content-Length); the offset must equal what is stored, so a retry never duplicates or skips a byte.
 * `POST {action:"verify", file}` - re-read one finished file from disk and check its SHA-256;
 * `POST {action:"complete"}` - pack the files into the save's one archive, re-read it, and give it its final name: answers
 * `complete`, or `building` when that takes longer than a request should wait (ask with GET until it is `complete`).
 * `DELETE` - abandon an unfinished save (stopping its archive build) or delete a finished one.
 */
export const GET = async (request: Request, { params }: Context) => handleStatus(request, (await params).saveId);
export const PUT = async (request: Request, { params }: Context) => handleSlice(request, (await params).saveId);
export const POST = async (request: Request, { params }: Context) => handleAction(request, (await params).saveId);
export const DELETE = async (request: Request, { params }: Context) => handleDelete(request, (await params).saveId);
