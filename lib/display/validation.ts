import type { DisplayRequestInput, DisplayRequestMode } from "./types";

const MODES = new Set<DisplayRequestMode>(["auto", "stream", "native"]);

export function normalizeLoopbackUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("A preview URL is required");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Preview URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Preview URL must use http or https");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
    throw new Error("Preview URL must target localhost or 127.0.0.1");
  }
  if (url.username || url.password) throw new Error("Preview URL must not include credentials");
  return url.toString();
}

export function parseDisplayRequestInput(value: unknown): Required<Pick<DisplayRequestInput, "url" | "mode">> & Pick<DisplayRequestInput, "title"> {
  if (!value || typeof value !== "object") throw new Error("Preview request must be an object");
  const input = value as Record<string, unknown>;
  const mode = input.mode === undefined ? "auto" : input.mode;
  if (typeof mode !== "string" || !MODES.has(mode as DisplayRequestMode)) throw new Error("Preview mode must be auto, stream, or native");
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 160) : undefined;
  return { url: normalizeLoopbackUrl(input.url), mode: mode as DisplayRequestMode, ...(title ? { title } : {}) };
}
