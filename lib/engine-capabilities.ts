"use client";

/**
 * The ONE client-side read of `/api/info`: what the active engine can serve,
 * who it is, and which version of it is installed.
 *
 * `/api/info` answers the same three facts for the whole page load, so asking
 * for them is memoized here and every caller shares one request. AppShell
 * loads the snapshot on mount and threads `capabilities` / `engine` down as
 * props — that remains the way any component with a props path should get
 * them, because a prop is synchronous and testable where a promise is
 * neither. This module is what the props are made of, and the escape hatch
 * for the few callers with no props path at all.
 *
 * The default is permissive: an unreachable or older `/api/info` must not
 * strip the UI down to the smallest engine's surface, so only an explicit
 * `false` gates anything and a failed load reports no engine rather than a
 * wrong one.
 */

/** Identity of the active engine, mirroring `InfoResponse["engine"]`. */
export interface EngineIdentity {
  id: string;
  displayName: string;
  shortName: string;
  experimental: boolean;
}

export interface EngineInfoSnapshot {
  /** Raw capability flags; absent keys mean "not reported", never "false". */
  capabilities: Record<string, unknown>;
  /** Null when `/api/info` could not be read or reported no engine. */
  engine: EngineIdentity | null;
  /** Runtime probe of the ACTIVE engine's binary; null when it is absent. */
  version: string | null;
}

const EMPTY: EngineInfoSnapshot = { capabilities: {}, engine: null, version: null };

interface InfoPayload {
  capabilities?: unknown;
  engine?: Partial<EngineIdentity> | null;
  ompVersion?: unknown;
}

function readSnapshot(data: InfoPayload | null): EngineInfoSnapshot {
  if (!data) return EMPTY;
  const capabilities = data.capabilities;
  const engine = data.engine;
  return {
    capabilities: capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
      ? (capabilities as Record<string, unknown>)
      : {},
    engine: engine && typeof engine.id === "string"
      ? {
        id: engine.id,
        displayName: engine.displayName ?? engine.id,
        shortName: engine.shortName ?? engine.id,
        experimental: engine.experimental === true,
      }
      : null,
    // The field is named for the founding engine but carries whatever
    // `harness.getVersion()` answered, so it is the ACTIVE engine's version.
    version: typeof data.ompVersion === "string" && data.ompVersion !== "" ? data.ompVersion : null,
  };
}

let pending: Promise<EngineInfoSnapshot> | null = null;

/** The active engine's flags, identity and version — fetched once per page. */
export function loadEngineInfo(): Promise<EngineInfoSnapshot> {
  pending ??= fetch("/api/info", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data: InfoPayload | null) => readSnapshot(data))
    .catch(() => EMPTY);
  return pending;
}

/** True unless the server explicitly reported this capability as false. */
export async function engineSupports(flag: string): Promise<boolean> {
  return (await loadEngineInfo()).capabilities[flag] !== false;
}
