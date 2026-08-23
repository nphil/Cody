import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { promisify } from "util";
import { requireEngine } from "@/lib/engine-guard";
import { resolveOmpBin } from "@/lib/omp/omp-cli";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { getHarness } from "@/lib/harness";

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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] as string));
}

/**
 * The exporter-missing answer, as a page rather than a JSON error: the Full
 * History panel puts this URL in an iframe and never runs the body through the
 * client's error formatter, so a JSON payload lands in front of the user as raw
 * text. It names omp as the missing *renderer* and the engine that is actually
 * running, because on a pi box "install oh-my-pi" is advice for the wrong
 * product. English only — the iframe request carries no locale.
 */
function exporterMissingPage(engineName: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Full history unavailable</title>
<style>
  :root { color-scheme: light dark }
  html, body { background: transparent; color: CanvasText }
  body { margin: 0; padding: 20px; font: 13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif }
  h1 { margin: 0 0 10px; font-size: 14px; font-weight: 600 }
  p { margin: 0 0 8px; max-width: 60ch; opacity: .85 }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px }
</style></head><body>
<h1>Full history is unavailable</h1>
<p>Cody renders full history with omp's exporter, and omp is not installed on this instance.</p>
<p>Active engine: ${escapeHtml(engineName)}. Install omp from Settings &rarr; Agent engine, or set <code>CODY_OMP_BIN</code>, to turn this panel on.</p>
</body></html>`;
}

/**
 * Render a session to self-contained HTML by shelling out to the user's omp
 * binary: `omp --export <sessionPath> <outPath>` (the output path is the first
 * positional argument; verified against oh-my-pi main.ts/flag-tables.ts).
 */
async function exportSession(bin: string, filePath: string, outputPath: string): Promise<void> {
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
    // The renderer is `omp --export`, and nothing else implements it — but pi
    // writes the SAME session .jsonl (see lib/harness/pi.ts), so omp renders a
    // pi transcript correctly and this worked on any box with omp installed.
    // Refusing for pi outright would take that away; the honest gate is the
    // transport, not the engine id. The ACP engines keep their own storage and
    // have no such file, so they still refuse.
    //
    // A pi-only box still lands on the resolveOmpBin() null check below, which
    // names the missing renderer rather than pretending pi has one.
    const harness = getHarness();
    if (!harness.rpcUi) {
      const gate = requireEngine("omp", "Session HTML export");
      if ("response" in gate) return gate.response;
    }
    const bin = resolveOmpBin();
    if (!bin) {
      return new Response(exporterMissingPage(harness.displayName), {
        status: 500,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const resolved = await resolveSessionPathOr404(id, req);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const tempDir = join(tmpdir(), "cody-export");
    mkdirSync(tempDir, { recursive: true });

    const sessionBase = basename(filePath, ".jsonl");
    const fileName = `${harness.id}-session-${sessionBase}.html`;
    const outputPath = join(tempDir, `${randomUUID()}.html`);

    try {
      await exportSession(bin, filePath, outputPath);

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
    return apiErrorResponse(error);
  }
}
