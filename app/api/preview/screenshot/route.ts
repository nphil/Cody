import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { captureLoopbackScreenshot, ScreenshotError } from "@/lib/preview-screenshot";

// POST /api/preview/screenshot  body: { url: string; width?: number; height?: number }
// Renders a loopback URL in a server-side headless Chromium and returns the
// image with the mime type it was actually encoded as (PNG normally, WebP when
// the page is too heavy for PNG to fit the engine's frame budget — see
// lib/preview-screenshot.ts). The capture happens where the dev server actually
// runs, so it works even when the viewer's browser cannot resolve the app as
// localhost.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { url?: unknown; width?: unknown; height?: unknown } | null;
    if (!body || typeof body.url !== "string" || !body.url.trim()) {
      return NextResponse.json({ error: "url is required", code: "url_required" }, { status: 400 });
    }
    const shot = await captureLoopbackScreenshot(body.url, {
      width: typeof body.width === "number" ? body.width : undefined,
      height: typeof body.height === "number" ? body.height : undefined,
    });
    return NextResponse.json(shot);
  } catch (error) {
    if (error instanceof ScreenshotError) {
      const status = error.code === "invalid_url"
        ? 400
        : error.code === "chromium_missing"
          ? 503
          // Nothing the ladder produced fits the transport budget: that is a
          // payload-size answer, not a render failure.
          : error.code === "too_large" ? 413 : 502;
      return NextResponse.json({ error: error.message, code: error.code, hint: error.hint }, { status });
    }
    return apiErrorResponse(error);
  }
}
