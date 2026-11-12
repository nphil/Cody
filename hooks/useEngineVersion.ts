"use client";

import { useEffect, useState } from "react";
import { loadEngineInfo } from "@/lib/engine-capabilities";

/**
 * The active engine's version (e.g. "18.19.0"), from the `/api/info` snapshot
 * every surface shares — one request per page load. `null` until it arrives
 * and when the engine could not be read, so a caller gating on a release must
 * treat `null` as "not known to be new enough" (`engineAtLeast` does).
 */
export function useEngineVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadEngineInfo().then((info) => {
      if (!cancelled) setVersion(info.version);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}
