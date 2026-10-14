"use client";

import { useEffect, useId, useSyncExternalStore } from "react";
import type { SideQuestions } from "@/hooks/useSideQuestions";

/**
 * Side questions are asked about the MAIN chat, so their state lives with it:
 * `useSideQuestions` runs inside the chat's `useAgentSession`, next to the
 * event stream that carries their frames. They are SHOWN in the Side Bar, which
 * sits in AppShell's right panel, on another branch of the tree.
 *
 * This bridge carries the one to the other without making AppShell render. A
 * streaming answer changes the state once per animation frame, and AppShell
 * holds far too much to be rebuilt at that rate. ChatWindow publishes, the Side
 * Bar subscribes, and nothing in between hears about it.
 *
 * One chat publishes at a time. When a chat is replaced the old one's release
 * and the new one's first publish can land in either order, so a release only
 * counts for the publisher that made it.
 */
export interface SideQuestionsBridge {
  subscribe: (listener: () => void) => () => void;
  /** The published state, or null while no chat has any (none open, or one that cannot have them). */
  getSnapshot: () => SideQuestions | null;
  publish: (owner: string, value: SideQuestions) => void;
  /** Withdraw `owner`'s state. A no-op when someone else has published since. */
  release: (owner: string) => void;
}

/** AppShell → Side Bar: "show the This chat view". Each request has its own token. */
export interface SideQuestionsRequest {
  token: number;
  /** Also put the cursor in the question box (a bare `/btw`). */
  focus: boolean;
}

export const NO_SIDE_QUESTIONS_REQUEST: SideQuestionsRequest = { token: 0, focus: false };

export function createSideQuestionsBridge(): SideQuestionsBridge {
  let current: { owner: string; value: SideQuestions } | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => current?.value ?? null,
    publish(owner, value) {
      if (current?.owner === owner && current.value === value) return;
      current = { owner, value };
      notify();
    },
    release(owner) {
      if (current?.owner !== owner) return;
      current = null;
      notify();
    },
  };
}

const subscribeNothing = () => () => {};
const readNothing = (): null => null;

/** The main chat's side questions, kept on the bridge for as long as the chat is mounted. */
export function usePublishSideQuestions(bridge: SideQuestionsBridge | undefined, sideQuestions: SideQuestions): void {
  const owner = useId();
  useEffect(() => {
    bridge?.publish(owner, sideQuestions);
  }, [bridge, owner, sideQuestions]);
  useEffect(() => () => bridge?.release(owner), [bridge, owner]);
}

/** What the main chat has published, or null. Re-renders only when that changes.
 *  The server render reads the same snapshot: nothing publishes there (the Side
 *  Bar is client-only), so it is null either way. */
export function useBridgedSideQuestions(bridge: SideQuestionsBridge | undefined): SideQuestions | null {
  const read = bridge?.getSnapshot ?? readNothing;
  return useSyncExternalStore(bridge?.subscribe ?? subscribeNothing, read, read);
}
