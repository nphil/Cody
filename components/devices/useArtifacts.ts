"use client";

import { useEffect, useMemo, useState } from "react";
import { groupArtifactSets } from "@/lib/devices/artifact-sets";
import { deviceArtifacts, type ArtifactSet, type DeviceArtifact, type TransferJob } from "@/lib/devices/artifacts";

export interface ArtifactsState {
  readonly artifacts: readonly DeviceArtifact[];
  /** What the devices produced, grouped into the runs that made them, newest first. */
  readonly sets: readonly ArtifactSet[];
  /** What the person added (firmware, a loader): never grouped. */
  readonly inputs: readonly DeviceArtifact[];
  /** Zips and saves to the server, the person's and the agent's, newest last. */
  readonly transfers: readonly TransferJob[];
  /** Why the files could not be read from this browser's storage, when they could not. */
  readonly error: string | null;
}

/** Every file of a session, its sets and its transfers, kept current while mounted. */
export function useArtifacts(sessionId: string): ArtifactsState {
  const [artifacts, setArtifacts] = useState<readonly DeviceArtifact[]>(() => deviceArtifacts.list(sessionId));
  const [transfers, setTransfers] = useState<readonly TransferJob[]>(() => deviceArtifacts.jobs(sessionId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const stopFiles = deviceArtifacts.subscribe(sessionId, setArtifacts);
    const stopTransfers = deviceArtifacts.subscribeJobs(sessionId, setTransfers);
    deviceArtifacts.hydrate(sessionId).then(() => { if (active) setError(null); }, (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => {
      active = false;
      stopFiles();
      stopTransfers();
    };
  }, [sessionId]);

  const sets = useMemo(() => groupArtifactSets(artifacts), [artifacts]);
  const inputs = useMemo(() => artifacts.filter((artifact) => artifact.kind === "input"), [artifacts]);
  return { artifacts, sets, inputs, transfers, error };
}
