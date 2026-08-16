import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/auth/http";
import { getAvatarsDir } from "@/lib/auth/paths";
import { findUserById } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** Any signed-in account may see any avatar (they appear beside shared UI like
 * the admin user list). The stored filename is a fresh UUID per upload, so the
 * response can be cached hard — a new picture is a new URL. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  const { id } = await params;
  const user = findUserById(id);
  if (!user?.avatar) return jsonError("No profile picture", 404);
  // parseUser validated the stored filename shape, so this join cannot leave
  // the avatars dir; resolve defensively anyway.
  const filePath = path.join(getAvatarsDir(), user.avatar);
  if (path.dirname(filePath) !== getAvatarsDir()) return jsonError("No profile picture", 404);

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    return jsonError("No profile picture", 404);
  }
  const extension = path.extname(user.avatar).slice(1);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
