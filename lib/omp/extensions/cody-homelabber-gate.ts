// Loaded by omp for the main session and inherited by its delegated sessions.
// This is guidance, not authority to perform an otherwise prohibited action.
//
// Each agent gets the procedure as ONE hidden message, never as a system-prompt
// change: omp reads any `before_agent_start` result that carries a `systemPrompt`
// as a replaced prompt, and answers by re-announcing its whole tool list (the
// xd:// catalog, thousands of tokens) as a user message. The message is added once
// per live context: a conversation that already holds it, back to its last
// compaction or `/clear`, gets nothing, and one that lost it gets it with the next prompt.
export const GATE_GUIDANCE = `HomeLabber gate procedure (subagents follow it independently):
Discover available HomeLabber tools first. Before any new command or grant request, inspect approval_list_requests and approval_list_grants for your caller token when those tools are offered. Tokens may be shared by multiple agents: a listed request or grant is not proof it belongs to you or covers this task. Do not share approvals or silently use another agent's grant. Match the exact server, command, pinned files, remaining uses and expiry. Group fixed related work in one exact approval_request_plan when appropriate and available. Use a standing grant only when explicitly authorized for that exact scope; signed software releases still require Nitin's separate explicit approval for each release.
If a request is pending or executing, poll approval_wait using its original id; after reconnect use approval_list_requests to recover the same id if offered. If the request cannot be recovered, stop rather than issue a replacement. For uncertain or execution_unknown, inspect state; retrySafe:false means never repeat the action. Stop if unresolved. Denied, expired or paused means stop, not a workaround. Never bypass an available gate with SSH or punt the command to the user. This procedure does not override Principle 0 or authorize any action it reserves to Nitin.`;

/** The type of the hidden message; lib/message-display.ts HIDDEN_CUSTOM_TYPES keeps it out of the transcript. */
export const GATE_CUSTOM_TYPE = "cody-gate-guidance";

type Session = { sessionManager?: { getBranch?: () => unknown } };

type HiddenMessage = { customType: string; content: string; display: false; attribution: "agent" };

type Api = { on(event: "before_agent_start", handler: (event: unknown, ctx: Session) => { message?: HiddenMessage }): void };

/**
 * Whether the conversation the model will read already holds `content` as its
 * newest `customType` note. omp keeps a note from `before_agent_start` as a
 * `custom_message` entry, so the answer is in the branch. A compaction folds the
 * messages before it into a summary and `/clear` drops them, so a note before
 * either is gone. A branch that cannot be read counts as "not there": a repeated
 * note costs a few hundred tokens, a missing procedure costs more.
 */
export function noteIsLive(ctx: Session, customType: string, content: string): boolean {
  let branch: unknown;
  try {
    branch = ctx.sessionManager?.getBranch?.();
  } catch {
    return false;
  }
  if (!Array.isArray(branch)) return false;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry: unknown = branch[index];
    if (typeof entry !== "object" || entry === null || !("type" in entry)) continue;
    if (entry.type === "compaction" || entry.type === "reset_boundary") return false;
    if (entry.type === "custom_message" && "customType" in entry && entry.customType === customType) return "content" in entry && entry.content === content;
  }
  return false;
}

export default function codyHomelabberGate(api: Api): void {
  api.on("before_agent_start", (_event, ctx) => {
    if (noteIsLive(ctx, GATE_CUSTOM_TYPE, GATE_GUIDANCE)) return {};
    return { message: { customType: GATE_CUSTOM_TYPE, content: GATE_GUIDANCE, display: false, attribution: "agent" } };
  });
}
