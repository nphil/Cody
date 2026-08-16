import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { jsonError, requireAdmin } from "@/lib/auth/http";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { deleteUser, findUserById, listUsers, toPublicUser, updateUser } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

/**
 * Admin: edit or remove one account. Role changes, password resets (no current
 * password needed — that is the point of an admin reset; the reset bumps
 * tokenVersion so the target's sessions all die).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  const { id } = await params;
  const target = findUserById(id);
  if (!target) return jsonError("Account not found", 404);

  let body: { fullName?: unknown; role?: unknown; password?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 4_096);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  const { fullName, role, password } = body;

  if (role !== undefined && role !== "admin" && role !== "member") return jsonError("Role must be admin or member", 400);
  if (role === "member" && target.role === "admin") {
    if (target.envManaged === true) return jsonError("The environment-managed account is always an administrator", 400);
    const otherAdmins = listUsers().some((user) => user.id !== id && user.role === "admin");
    if (!otherAdmins) return jsonError("Cannot demote the last administrator", 400);
  }
  if (password !== undefined) {
    if (target.envManaged === true) return jsonError("This account's password is the CODY_PASSWORD environment variable", 400, "env_managed");
    if (typeof password !== "string") return jsonError("Password must be a string", 400);
    const passwordError = validatePasswordStrength(password);
    if (passwordError) return jsonError(passwordError, 400);
  }

  const passwordHash = typeof password === "string" ? await hashPassword(password) : null;
  const updated = updateUser(id, (record) => {
    if (typeof fullName === "string" && fullName.trim()) record.fullName = fullName.trim().slice(0, 80);
    if (role === "admin" || role === "member") record.role = role;
    if (passwordHash) {
      record.passwordHash = passwordHash;
      record.tokenVersion += 1;
    }
  });
  return NextResponse.json({ user: toPublicUser(updated) }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;
  const { id } = await params;
  if (id === resolved.user.id) return jsonError("You cannot delete the account you are signed in with", 400);
  try {
    deleteUser(id);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
