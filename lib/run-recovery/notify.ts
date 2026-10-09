import { getEngineSession } from "../harness/engine-sessions";
import { buildBody, buildTitle, projectTag } from "../notifications/compose";
import type { NotificationDraft } from "../notifications/dispatch";
import { readSessionHeader, resolveSessionPath } from "../session-reader";
import { displaySessionTitle } from "../session-title";
import { noticeBody, type RecoveryOutcome } from "./text";

/**
 * Telling the owner Cody picked a chat's run up again, gave up on it, or
 * could not.
 *
 * It rides the `error` kind (Problems group, whose description already says
 * "the engine stopped unexpectedly"), so the owner's own switches and the
 * "I am looking at that chat" silence apply untouched. Delivery is dispatch's
 * business; this only says WHAT happened. Never throws: a notification is not
 * worth breaking a recovery for.
 */

const UNTITLED = "Untitled chat";

/** What the caller already knows about the chat, so a live one need not be looked up. */
export interface ChatHint {
  sessionFile?: string;
  cwd?: string;
}

export interface ChatDescription {
  title: string;
  project: string | null;
}

/** The chat's name as the sidebar shows it: its own file's title, else the engine's index, else "Untitled chat". */
export async function describeChat(sessionId: string, hint: ChatHint = {}): Promise<ChatDescription> {
  try {
    const row = getEngineSession(sessionId);
    let title = displaySessionTitle(row?.title);
    let cwd = hint.cwd ?? row?.cwd;
    if (!title && hint.sessionFile) {
      const header = readSessionHeader(hint.sessionFile);
      title = displaySessionTitle(header?.title);
      cwd ??= header?.cwd;
    }
    if (!title) {
      const file = await resolveSessionPath(sessionId);
      const header = file ? readSessionHeader(file) : null;
      title = displaySessionTitle(header?.title);
      cwd ??= header?.cwd;
    }
    return { title: title ?? UNTITLED, project: projectTag(cwd) };
  } catch {
    return { title: UNTITLED, project: null };
  }
}

export interface RecoveryNotifyDeps {
  zoneFor: (sessionId: string) => string;
  describeChat: (sessionId: string, hint?: ChatHint) => Promise<ChatDescription>;
  send: (draft: NotificationDraft) => unknown;
}

export function composeRecoveryNotification(sessionId: string, outcome: RecoveryOutcome, chat: ChatDescription, zone: string): NotificationDraft {
  return {
    event: "error",
    sessionId,
    title: buildTitle("error", chat.title),
    body: buildBody(noticeBody(outcome, zone)),
    tags: chat.project ? [chat.project] : [],
  };
}

export async function notifyRecovery(
  sessionId: string,
  outcome: RecoveryOutcome,
  hint: ChatHint | undefined,
  deps: RecoveryNotifyDeps,
): Promise<void> {
  try {
    const chat = await deps.describeChat(sessionId, hint);
    deps.send(composeRecoveryNotification(sessionId, outcome, chat, deps.zoneFor(sessionId)));
  } catch (error) {
    console.warn("[run-recovery] could not send a notification:", error instanceof Error ? error.message : error);
  }
}
