import { randomUUID } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { jsonError, requireUser } from "@/lib/auth/http";
import { getAvatarsDir } from "@/lib/auth/paths";
import { toPublicUser, updateUser } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

/** The client downscales to 256px before uploading (AccountSettings), so 2 MiB
 * of headroom is generous rather than tight. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Content sniffing over trusting the reported MIME type. */
function detectImageExtension(bytes: Buffer): "png" | "jpg" | "webp" | null {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export async function POST(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  let form: FormData;
  try {
    form = await parseFormDataWithinLimit(request, MAX_UPLOAD_BYTES);
  } catch (error) {
    return jsonError(error instanceof RequestBodyTooLargeError ? "Image is too large (2 MB max)" : "Invalid upload", 400);
  }
  const file = form.get("avatar");
  if (!(file instanceof File)) return jsonError("Attach the image as the `avatar` form field", 400);

  const bytes = Buffer.from(await file.arrayBuffer());
  const extension = detectImageExtension(bytes);
  if (!extension) return jsonError("Profile pictures must be PNG, JPEG or WebP", 400);

  const dir = getAvatarsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filename = `${randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(dir, filename), bytes, { mode: 0o600 });

  const previous = resolved.user.avatar;
  const updated = updateUser(resolved.user.id, (record) => { record.avatar = filename; });
  if (previous) {
    try { fs.rmSync(path.join(dir, previous), { force: true }); } catch { /* orphan is harmless */ }
  }
  return NextResponse.json({ user: toPublicUser(updated) }, { headers: { "Cache-Control": "no-store" } });
}

export function DELETE(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;
  const previous = resolved.user.avatar;
  const updated = updateUser(resolved.user.id, (record) => { delete record.avatar; });
  if (previous) {
    try { fs.rmSync(path.join(getAvatarsDir(), previous), { force: true }); } catch { /* orphan is harmless */ }
  }
  return NextResponse.json({ user: toPublicUser(updated) }, { headers: { "Cache-Control": "no-store" } });
}
