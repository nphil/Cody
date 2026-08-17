function previewFrameSource(): string | null {
  const raw = process.env.CODY_PREVIEW_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const base = new URL(raw);
    if ((base.protocol !== "http:" && base.protocol !== "https:") || base.pathname !== "/") return null;
    return `${base.protocol}//*.${base.host}`;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy(): string {
  const frameSources = ["'self'", "http://localhost:*", "http://127.0.0.1:*", "https://localhost:*", "https://127.0.0.1:*"];
  const native = previewFrameSource();
  if (native) frameSources.push(native);
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `frame-src ${frameSources.join(" ")}`,
    "object-src 'none'",
    "worker-src 'self'",
    "img-src 'self' data: blob: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
    "font-src 'self' data:",
  ].join("; ");
}
