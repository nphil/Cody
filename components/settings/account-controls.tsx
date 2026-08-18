"use client";

import { AlertCircle } from "lucide-react";
import { useCallback, useState } from "react";

/**
 * The small control vocabulary the account panels share: three button styles,
 * the busy/error pair every action in them needs, a fetch wrapper that keeps the
 * server's machine-readable error code, and the inline error line.
 *
 * These live outside AccountSettings so the access-token section can use the
 * same buttons and the same request semantics without importing back into the
 * panel that renders it. English-only, like the rest of the settings dialog.
 */

export const smallButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 30,
  padding: "4px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 12,
  cursor: "pointer",
} as const;

export const primaryButtonStyle = {
  ...smallButtonStyle,
  border: "none",
  background: "var(--accent-strong)",
  color: "var(--on-accent)",
  fontWeight: 600,
} as const;

export const dangerButtonStyle = {
  ...smallButtonStyle,
  color: "var(--status-error)",
  borderColor: "color-mix(in srgb, var(--status-error) 45%, transparent)",
} as const;

export function useAsyncAction(): [boolean, string | null, (run: () => Promise<void>) => void, (message: string | null) => void] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invoke = useCallback((run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void run()
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(false));
  }, []);
  return [busy, error, invoke, setError];
}

/**
 * Carries the `code` alongside the prose, because a caller that must explain one
 * specific refusal (a bearer credential being told it cannot mint a token) has
 * to branch on the code — the message is prose and is not a contract.
 */
export class ApiError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(message: string, code: string | null, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!response.ok) throw new ApiError(body?.error || `HTTP ${response.status}`, body?.code ?? null, response.status);
  return body as T;
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--status-error)", fontSize: 12 }}>
      <AlertCircle size={13} aria-hidden style={{ flexShrink: 0 }} /> {message}
    </div>
  );
}
