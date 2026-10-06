import { handleAction, handleDelete, handleSlice, handleStatus } from "@/lib/devices/artifact-vault-http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ saveId: string }> };

/**
 * One save of the artifact vault (lib/devices/artifact-vault.ts).
 *
 * `GET` - its status: every file's stored length and whether it verified.
 * `PUT ?file=<index>&offset=<bytes already stored>` - one slice of a file as the raw body (at most 8 MiB, with a
 * Content-Length); the offset must equal what is stored, so a retry never duplicates or skips a byte.
 * `POST {action:"verify", file}` - re-read one finished file from disk and check its SHA-256;
 * `POST {action:"complete"}` - write the manifest and `SHA256SUMS` and give the folder its final name.
 * `DELETE` - abandon an unfinished save or delete a finished one.
 */
export const GET = async (request: Request, { params }: Context) => handleStatus(request, (await params).saveId);
export const PUT = async (request: Request, { params }: Context) => handleSlice(request, (await params).saveId);
export const POST = async (request: Request, { params }: Context) => handleAction(request, (await params).saveId);
export const DELETE = async (request: Request, { params }: Context) => handleDelete(request, (await params).saveId);
