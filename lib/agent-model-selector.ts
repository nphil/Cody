/**
 * What a helper agent's model setting can hold, and how to read one.
 *
 * Shared by Settings › Models › Helper agents, the helper window's "Change
 * model" control and the routes that write the setting, so all three agree on
 * what a valid choice is. No fs and no engine import: the browser loads it.
 *
 * Two kinds of value are ever WRITTEN to `task.agentModelOverrides`:
 *  - a ROLE alias (`@slow`): resolved through the user's model roles, keeps
 *    the role's retry-fallback chain and follows the role when it is
 *    repointed. The recommended choice.
 *  - ONE exact model (`provider/model-id`): pinned, with no fallback chain.
 * Anything else already in the file (a list of models, a bare model name) is
 * read as "custom" and shown as it is, never rewritten unless the user picks
 * something else.
 */

/** A name omp can load an agent under: the frontmatter `name` or the file stem. */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const ROLE_PATTERN = /^@([A-Za-z][A-Za-z0-9_-]{0,31})$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/;
const MAX_SELECTOR_LENGTH = 200;

export type AgentModelSelector =
  | { kind: "role"; selector: string; role: string }
  | { kind: "model"; selector: string; provider: string; modelId: string }
  | { kind: "custom"; selector: string };

export function isAgentName(value: unknown): value is string {
  return typeof value === "string" && AGENT_NAME_PATTERN.test(value);
}

/** `slow` → `@slow`. */
export function roleSelector(role: string): string {
  return `@${role}`;
}

/** Read one stored or typed selector. Null for anything that is not a non-empty string. */
export function parseAgentModelSelector(value: unknown): AgentModelSelector | null {
  if (typeof value !== "string") return null;
  const selector = value.trim();
  if (!selector) return null;
  const role = ROLE_PATTERN.exec(selector);
  if (role) return { kind: "role", selector, role: role[1] };
  if (selector.length <= MAX_SELECTOR_LENGTH && MODEL_PATTERN.test(selector)) {
    const slash = selector.indexOf("/");
    return { kind: "model", selector, provider: selector.slice(0, slash), modelId: selector.slice(slash + 1) };
  }
  return { kind: "custom", selector };
}

/** The canonical string to WRITE for a choice, or null when it is not a role
 * alias or an exact `provider/model` (a custom value is never written). */
export function writableAgentModelSelector(value: unknown): string | null {
  const parsed = parseAgentModelSelector(value);
  return parsed && parsed.kind !== "custom" ? parsed.selector : null;
}
