import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";
import { requireEngine } from "@/lib/engine-guard";
import { resolveOmpBin } from "@/lib/omp/omp-cli";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

/**
 * Render a session to self-contained HTML by shelling out to the user's omp
 * binary: `omp --export <sessionPath> <outPath>` (the output path is the first
 * positional argument; verified against oh-my-pi main.ts/flag-tables.ts).
 */
async function exportSession(filePath: string, outputPath: string): Promise<void> {
  const bin = resolveOmpBin();
  if (!bin) {
    throw new Error("omp binary not found. Install oh-my-pi or set CODY_OMP_BIN.");
  }
  await execFileAsync(bin, ["--export", filePath, outputPath], {
    cwd: tmpdir(),
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const inline = new URL(req.url).searchParams.get("inline") === "1";

  try {
    // The renderer is `omp --export`, and nothing else implements it. The
    // Export item is gated client-side on `chatExtras`, which pi also has, so
    // on a pi-only box this answered "omp binary not found" — a missing
    // dependency, when the truth is that pi has no exporter.
    const gate = requireEngine("omp", "Session HTML export");
    if ("response" in gate) return gate.response;
    const resolved = await resolveSessionPathOr404(id, req);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const tempDir = join(tmpdir(), "cody-export");
    mkdirSync(tempDir, { recursive: true });

    const sessionBase = basename(filePath, ".jsonl");
    const fileName = `omp-session-${sessionBase}.html`;
    const outputPath = join(tempDir, `${randomUUID()}.html`);

    try {
      await exportSession(filePath, outputPath);

      const html = readFileSync(outputPath, "utf8");
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": getContentDisposition(fileName, inline),
          "Cache-Control": "no-cache",
          // Same rendering allowances the document had under the global
          // policy, plus frame-ancestors 'self' so the top-bar history panel
          // can frame it (per spec this also supersedes X-Frame-Options).
          // Mirrors the docx preview in /api/files.
          // cdnjs is allowed in script-src because the exporter renders the
          // transcript client-side with SRI-pinned marked and highlight.js from
          // that CDN; blocking it silently yields an empty transcript. This
          // makes the rendered transcript depend on outbound access to cdnjs.
          "Content-Security-Policy": "default-src 'none'; img-src 'self' data: blob: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } finally {
      rmSync(outputPath, { force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("omp binary not found")) {
      return NextResponse.json({ error: message, code: "omp_not_found" }, { status: 500 });
    }
    return apiErrorResponse(error);
  }
}
