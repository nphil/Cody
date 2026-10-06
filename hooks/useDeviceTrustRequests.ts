"use client";

import { useCallback, useSyncExternalStore } from "react";
import { deviceTrustHub, NO_TRUST_REQUESTS } from "@/lib/devices/trust-hub";
import type { DeviceTrustAnswer, DeviceTrustAnswerResult, DeviceTrustRequest } from "@/lib/devices/trust";

const subscribeNothing = () => () => {};
const emptyRequests = (): readonly DeviceTrustRequest[] => NO_TRUST_REQUESTS;

/**
 * The "Let the agent control <device>?" questions this chat's session is waiting on, and the way to answer them.
 *
 * It reads through the page-global trust hub and never imports the device bridge (lib/devices/client.ts): a chat
 * with no device must not load any protocol code or open a device socket. A session whose bridge has not started has
 * no entry in the hub, so its list is the shared empty one.
 */
export function useDeviceTrustRequests(sessionId: string | null): {
  requests: readonly DeviceTrustRequest[];
  respond: (requestId: string, answer: DeviceTrustAnswer) => Promise<DeviceTrustAnswerResult>;
} {
  const subscribe = useCallback(
    (listener: () => void) => (sessionId ? deviceTrustHub.subscribe(sessionId, listener) : subscribeNothing()),
    [sessionId],
  );
  const snapshot = useCallback(
    () => (sessionId ? deviceTrustHub.requests(sessionId) : NO_TRUST_REQUESTS),
    [sessionId],
  );
  const requests = useSyncExternalStore(subscribe, snapshot, emptyRequests);
  const respond = useCallback(
    (requestId: string, answer: DeviceTrustAnswer) => {
      if (!sessionId) return Promise.reject(new Error("This chat has no device waiting for an answer."));
      return deviceTrustHub.respond(sessionId, requestId, answer);
    },
    [sessionId],
  );
  return { requests, respond };
}
