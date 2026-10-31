// Loaded by omp for the main session and inherited by its delegated sessions.
// This is guidance, not authority to perform an otherwise prohibited action.
export const GATE_GUIDANCE = `HomeLabber gate procedure (subagents follow it independently):
Discover available HomeLabber tools first. Before any new command or grant request, inspect approval_list_requests and approval_list_grants for your caller token when those tools are offered. Tokens may be shared by multiple agents: a listed request or grant is not proof it belongs to you or covers this task. Do not share approvals or silently use another agent's grant. Match the exact server, command, pinned files, remaining uses and expiry. Group fixed related work in one exact approval_request_plan when appropriate and available. Use a standing grant only when explicitly authorized for that exact scope; signed software releases still require Nitin's separate explicit approval for each release.
If a request is pending or executing, poll approval_wait using its original id; after reconnect use approval_list_requests to recover the same id if offered. If the request cannot be recovered, stop rather than issue a replacement. For uncertain or execution_unknown, inspect state; retrySafe:false means never repeat the action. Stop if unresolved. Denied, expired or paused means stop, not a workaround. Never bypass an available gate with SSH or punt the command to the user. This procedure does not override Principle 0 or authorize any action it reserves to Nitin.`;

type Api = { on(event: "before_agent_start", handler: (event: { systemPrompt: string[] }) => { systemPrompt: string[] }): void };

export default function codyHomelabberGate(api: Api): void {
  api.on("before_agent_start", ({ systemPrompt }) => ({
    systemPrompt: systemPrompt.includes(GATE_GUIDANCE) ? systemPrompt : [...systemPrompt, GATE_GUIDANCE],
  }));
}
