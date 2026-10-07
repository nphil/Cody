"use client";

import { useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { OMP_ENGINE_ID } from "@/components/SettingsTabs";
import { forkChat, isForkUnsupported, subscribeForkSupport } from "@/lib/fork-session";
import { translate } from "@/lib/i18n";

/** Whether this page may offer forking a chat: omp is the engine (only it has
 *  `fork`) and has not said it cannot. Until the engine is known, no. */
export function useForkAvailable(engineId: string | null | undefined): boolean {
  const unsupported = useSyncExternalStore(subscribeForkSupport, isForkUnsupported, () => false);
  return engineId === OMP_ENGINE_ID && !unsupported;
}

/** Which control asked: a copy of the whole chat says so while it works. */
export type ForkKind = "fork" | "duplicate";

/**
 * Fork a chat and tell the person how it went. Resolves with the new chat's id
 * for the caller to switch to, or null when nothing was created (the reason
 * has already been shown).
 */
export async function forkChatWithFeedback(sessionId: string, entryId: string | undefined, kind: ForkKind): Promise<string | null> {
  // A copy can wait on a cold start of the engine, with no button of its own to show it.
  const pending = kind === "duplicate" ? toast.info(translate("fork.duplicating")) : undefined;
  const outcome = await forkChat(sessionId, entryId);
  if (pending !== undefined) toast.close(pending);
  switch (outcome.status) {
    case "forked":
      toast.success(translate(kind === "duplicate" ? "fork.duplicatedTitle" : "fork.forkedTitle"), translate("fork.createdBody"));
      return outcome.sessionId;
    case "busy":
      toast.info(translate("fork.busy"));
      break;
    case "unsupported":
      toast.info(translate("fork.unsupported"));
      break;
    case "cancelled":
      toast.info(translate("fork.cancelled"));
      break;
    case "failed":
      toast.error(translate("fork.failed"), outcome.message || undefined, { clamp: true });
      break;
  }
  return null;
}
