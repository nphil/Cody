"use client";

import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { LiveToolEntry, LiveToolOutputStore } from "@/lib/live-tool-output";

/** The live-output store of the chat on screen (provided by ChatWindow). Absent
 * in a subagent transcript, whose calls never stream into it. */
export const LiveToolOutputContext = createContext<LiveToolOutputStore | null>(null);

const NO_SUBSCRIBE = () => () => {};
const NO_ENTRY = () => undefined;

/** The live entry of one running call, re-rendering only when THAT call's tail changes. */
export function useLiveToolOutput(toolCallId: string): LiveToolEntry | undefined {
  const store = useContext(LiveToolOutputContext);
  const subscribe = useMemo(
    () => (store ? (onChange: () => void) => store.subscribe(toolCallId, onChange) : NO_SUBSCRIBE),
    [store, toolCallId],
  );
  const snapshot = useMemo(() => (store ? () => store.get(toolCallId) : NO_ENTRY), [store, toolCallId]);
  return useSyncExternalStore(subscribe, snapshot, NO_ENTRY);
}
