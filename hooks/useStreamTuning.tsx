"use client";

import { useSyncExternalStore, createContext, useContext, type ReactNode } from "react";
import { getStreamTuning, subscribeStreamTuning, type StreamTuning } from "@/lib/stream-tuning";

const StreamTuningContext = createContext<StreamTuning | null>(null);

/**
 * Live stream tuning: the playground's draft (React context) when inside a
 * StreamTuningProvider, else the global localStorage-backed store. Both hooks
 * run unconditionally — the store subscription is cheap and the rules of
 * hooks forbid gating it on the context value.
 */
export function useStreamTuning(): StreamTuning {
  const ctx = useContext(StreamTuningContext);
  const stored = useSyncExternalStore(subscribeStreamTuning, getStreamTuning, getStreamTuning);
  return ctx ?? stored;
}

export function StreamTuningProvider({ children, value }: { children: ReactNode; value?: StreamTuning }) {
  return <StreamTuningContext.Provider value={value ?? null}>{children}</StreamTuningContext.Provider>;
}
