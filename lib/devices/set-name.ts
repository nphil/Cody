/**
 * What an agent may call a backup (`set` on the device tools). One rule, read by the tool layer, which refuses a bad name
 * before anything reaches the browser, and by the page's operation manager, which trusts nothing the server sends.
 *
 * No control character is ever allowed: the panel makes up names for sets a person combines, and those start with one, so
 * no agent's name can be mistaken for them (see ./artifact-sets.ts).
 */

export const MAX_SET_NAME_CHARS = 80;

/** What an agent is told when its name is refused. */
export const SET_NAME_RULE = `set must be 1 to ${MAX_SET_NAME_CHARS} characters without control characters.`;

/** The name without surrounding spaces, or undefined when what is left is empty, too long or holds a control character. */
export function usableSetName(value: string): string | undefined {
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_SET_NAME_CHARS && !/\p{Cc}/u.test(name) ? name : undefined;
}
