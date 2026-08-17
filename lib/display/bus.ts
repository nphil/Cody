import { randomUUID } from "node:crypto";
import { resolveDisplayCandidates } from "./native-gateway";
import type { DisplayBusEvent, DisplayRequestV1 } from "./types";
import { parseDisplayRequestInput } from "./validation";

interface DisplayBusState {
  latest: Map<string, DisplayRequestV1>;
  aliases: Map<string, string>;
  listeners: Map<string, Set<(event: DisplayBusEvent) => void>>;
}

declare global {
  var __codyDisplayBus: DisplayBusState | undefined;
}

const MAX_SESSIONS = 128;

function bus(): DisplayBusState {
  return globalThis.__codyDisplayBus ??= { latest: new Map(), aliases: new Map(), listeners: new Map() };
}

export function resolveDisplaySessionId(sessionId: string): string {
  let current = sessionId;
  const seen = new Set<string>();
  while (bus().aliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = bus().aliases.get(current)!;
  }
  return current;
}

export async function publishDisplayRequest(sessionId: string, input: unknown): Promise<DisplayRequestV1> {
  if (!sessionId) throw new Error("Display session is required");
  const parsed = parseDisplayRequestInput(input);
  const candidates = await resolveDisplayCandidates(parsed.url, parsed.mode);
  // Resolved AFTER probing: an engine rekey can land while interfaces are
  // being probed, and the request belongs to whoever the session is by then.
  const authoritativeId = resolveDisplaySessionId(sessionId);
  const request: DisplayRequestV1 = {
    version: 1,
    id: randomUUID(),
    sessionId: authoritativeId,
    source: { kind: "web", url: parsed.url },
    title: parsed.title,
    requestedMode: parsed.mode,
    candidates,
    requestedAt: Date.now(),
  };
  const state = bus();
  state.latest.delete(authoritativeId);
  state.latest.set(authoritativeId, request);
  while (state.latest.size > MAX_SESSIONS) state.latest.delete(state.latest.keys().next().value as string);
  for (const listener of state.listeners.get(authoritativeId) ?? []) {
    try { listener({ type: "request", request }); } catch { /* one subscriber cannot break publication */ }
  }
  return request;
}

export function getLatestDisplayRequest(sessionId: string): DisplayRequestV1 | null {
  return bus().latest.get(resolveDisplaySessionId(sessionId)) ?? null;
}

export function subscribeDisplayRequests(sessionId: string, listener: (event: DisplayBusEvent) => void): () => void {
  const authoritativeId = resolveDisplaySessionId(sessionId);
  const state = bus();
  let listeners = state.listeners.get(authoritativeId);
  if (!listeners) state.listeners.set(authoritativeId, listeners = new Set());
  listeners.add(listener);
  listener({ type: "snapshot", request: state.latest.get(authoritativeId) ?? null });
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) state.listeners.delete(authoritativeId);
  };
}

export function aliasDisplaySession(oldId: string, newId: string): void {
  if (!oldId || !newId || oldId === newId) return;
  const state = bus();
  const resolvedNew = resolveDisplaySessionId(newId);
  state.aliases.set(oldId, resolvedNew);
  const prior = state.latest.get(oldId);
  if (prior) {
    state.latest.delete(oldId);
    state.latest.set(resolvedNew, { ...prior, sessionId: resolvedNew });
  }
  const oldListeners = state.listeners.get(oldId);
  if (oldListeners) {
    state.listeners.delete(oldId);
    const destination = state.listeners.get(resolvedNew) ?? new Set();
    for (const listener of oldListeners) destination.add(listener);
    state.listeners.set(resolvedNew, destination);
  }
}

export function resetDisplayBusForTests(): void {
  globalThis.__codyDisplayBus = undefined;
}
