/**
 * Where the chat finds the trust questions its session's devices are asking.
 *
 * The operation manager lives in the page, inside the device bridge connection of one session
 * (lib/devices/client.ts). The chat that owns that session renders the question in its input dock, but it must
 * not import the bridge: the bridge pulls in every protocol implementation, and a chat that has no device never
 * opens a device socket. So each manager registers itself here when it is created, by session id, and the chat
 * reads and answers through the hub. A session with no device has no entry and an empty list.
 *
 * The hub holds no trust of its own and grants none: `respond` hands the person's click to the manager that
 * asked, and it is the only way a question gets answered.
 */

import type { DeviceTrustAnswer, DeviceTrustAnswerResult, DeviceTrustRequest } from "./trust";

/** The part of a DeviceOperationManager the hub needs, typed here so the chat never imports the page's protocol code. */
export interface TrustQuestionSource {
  trustRequests(): readonly DeviceTrustRequest[];
  subscribeTrust(listener: () => void): () => void;
  answerTrust(requestId: string, answer: DeviceTrustAnswer): Promise<DeviceTrustAnswerResult>;
}

export const NO_TRUST_REQUESTS: readonly DeviceTrustRequest[] = Object.freeze([]);

interface Entry {
  source: TrustQuestionSource;
  requests: readonly DeviceTrustRequest[];
  unsubscribe: () => void;
}

/** Whether two lists are the same questions with the same number waiting: a manager notifies on every trust change, most of which are not these. */
function sameRequests(left: readonly DeviceTrustRequest[], right: readonly DeviceTrustRequest[]): boolean {
  return left.length === right.length && left.every((request, index) => request.id === right[index].id && request.waiting === right[index].waiting);
}

export class DeviceTrustHub {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();

  /** Registers the manager that answers for `sessionId`, replacing any earlier one. Returns the way to withdraw it. */
  register(sessionId: string, source: TrustQuestionSource): () => void {
    this.entries.get(sessionId)?.unsubscribe();
    const entry: Entry = { source, requests: Object.freeze([...source.trustRequests()]), unsubscribe: () => {} };
    entry.unsubscribe = source.subscribeTrust(() => {
      const next = source.trustRequests();
      if (sameRequests(entry.requests, next)) return;
      entry.requests = Object.freeze([...next]);
      this.notify(sessionId);
    });
    this.entries.set(sessionId, entry);
    this.notify(sessionId);
    return () => {
      entry.unsubscribe();
      if (this.entries.get(sessionId) !== entry) return;
      this.entries.delete(sessionId);
      this.notify(sessionId);
    };
  }

  /** The open questions for a session, oldest first. The same array until something changes. */
  requests(sessionId: string): readonly DeviceTrustRequest[] {
    return this.entries.get(sessionId)?.requests ?? NO_TRUST_REQUESTS;
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.listeners.get(sessionId) === listeners) this.listeners.delete(sessionId);
    };
  }

  /** The person's answer, from the card's Allow or Deny. Rejects when the session has no manager or the question is gone. */
  respond(sessionId: string, requestId: string, answer: DeviceTrustAnswer): Promise<DeviceTrustAnswerResult> {
    const entry = this.entries.get(sessionId);
    if (!entry) return Promise.reject(new Error("This chat has no device waiting for an answer."));
    return entry.source.answerTrust(requestId, answer);
  }

  private notify(sessionId: string): void {
    for (const listener of [...(this.listeners.get(sessionId) ?? [])]) listener();
  }
}

/** The page's one hub: the bridge's managers and the chat may sit in different bundles, so the instance is shared through the global scope. */
export const deviceTrustHub: DeviceTrustHub = ((globalThis as typeof globalThis & { __codyDeviceTrustHub?: DeviceTrustHub }).__codyDeviceTrustHub ??= new DeviceTrustHub());
