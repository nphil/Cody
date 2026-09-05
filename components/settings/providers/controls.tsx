"use client";

/**
 * Small shared pieces of the Providers hub: the brand tile a row wears, the
 * button styles the directory / picker / detail share, the status words a
 * row's winning method reads as, and the one invalidation every change in
 * the hub ends with.
 */
import { invalidateSettingsRoutes } from "@/hooks/useSettingsData";
import { ProviderBrandTile } from "@/components/ModelsConfig";
import { isSubscriptionLogin, type ProviderRow } from "@/lib/provider-directory";

export const buttonStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "6px 12px",
  minHeight: 32,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
  touchAction: "manipulation" as const,
  whiteSpace: "nowrap" as const,
} as const;

export const primaryButtonStyle = { ...buttonStyle, background: "var(--accent)", borderColor: "var(--accent)", color: "var(--on-accent)" } as const;
export const quietButtonStyle = { ...buttonStyle, fontWeight: 500, color: "var(--text-muted)" } as const;
export const dangerButtonStyle = { ...buttonStyle, color: "var(--status-error)", borderColor: "color-mix(in srgb, var(--status-error) 40%, var(--border))" } as const;

export const sectionTitleStyle = { margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: "var(--text-muted)" } as const;

export const cardStyle = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-panel)",
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column" as const,
  gap: 10,
  minWidth: 0,
} as const;

/** Settings draws provider brands in colour at tile size (ModelsConfig's
 * lobehub set); the tile keeps every mark, coloured or mono, on one ground. */
export function ProviderTile({ brand, size = 28 }: { brand: string; size?: number }) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-subtle)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <ProviderBrandTile id={brand} size={Math.round(size * 0.57)} />
    </span>
  );
}

/** "Models come from the session" is what an ACP engine's rows say; the
 * server sends the same words as `reason`, matched here by prefix. */
export const SESSION_MODELS_REASON = "Models come from the session";

export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The winning method as the row's status line reads it. */
export function describeWinning(row: ProviderRow, shortName: string): { tone: "ok" | "warn" | "muted"; text: string } {
  if (row.disabled) return { tone: "warn", text: `Disabled in ${shortName}` };
  if (!row.connected) return { tone: "muted", text: "Not connected" };
  const winner = row.methods.find((method) => method.winning);
  if (!winner || winner.state !== "connected") return { tone: "ok", text: "Connected" };
  switch (winner.kind) {
    case "oauth":
    case "device":
      // omp's roster lists its API-key vendors as sign-ins; "authenticated"
      // there means a key is stored in omp's own store, not a subscription.
      return { tone: "ok", text: isSubscriptionLogin(winner) ? "Signed in" : `Key stored in ${shortName}` };
    case "key":
      return { tone: "ok", text: "Key saved in Cody" };
    case "env":
      return { tone: "ok", text: "Key from container" };
    case "custom":
      return { tone: "ok", text: hostOf(row.endpoint?.baseUrl) ?? "Custom endpoint" };
    default:
      return { tone: "ok", text: "Connected" };
  }
}

export function pluralModels(count: number): string {
  return `${count} model${count === 1 ? "" : "s"}`;
}

/** The count clause of a row's status line, or what stands in for it. */
export function describeModels(row: ProviderRow): string | null {
  if (row.modelCount !== null) return pluralModels(row.modelCount);
  if (row.pending) return "Counting…";
  if (row.reason?.startsWith(SESSION_MODELS_REASON)) return SESSION_MODELS_REASON;
  return null;
}

/** "Region not set": an optional variable the winning key method lacks. */
export function missingOptionalHint(row: ProviderRow): string | null {
  const key = row.methods.find((method) => (method.kind === "key" || method.kind === "env") && method.state === "connected");
  const missing = (key?.variables ?? []).filter((variable) => variable.optional && !variable.stored && !variable.fromEnvironment);
  if (missing.length === 0) return null;
  return `${missing.map((variable) => variable.label).join(", ")} not set`;
}

/** Every read a provider change can have moved: the hub itself, the model
 * catalog and its new-models diff, the sign-in roster, the key flags and
 * models.yml. */
export function invalidateProviderReads(): void {
  for (const route of ["/api/providers", "/api/models", "/api/models/new", "/api/auth/providers", "/api/provider-keys", "/api/models-config", "/api/omp-settings"]) {
    invalidateSettingsRoutes(route, { exact: route === "/api/omp-settings" || route === "/api/models" });
  }
}
