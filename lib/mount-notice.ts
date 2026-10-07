/**
 * omp's `xdev-mount-notice` custom message tells the MODEL which `xd://` tools
 * were mounted or unmounted. Its `content` is a prompt for the model (it
 * opens with `<system-notice>` and lists every tool's description), never a
 * sentence for a person, and from omp 18.7 it is also written for the roster
 * Cody registers when a chat starts — every one of Cody's own host tools,
 * before the first message. The toast exists for one thing only: MCP servers
 * changing under a live chat. So it is decided from the structured `details`
 * ({added, removed} tool names) and worded here; anything that is not an MCP
 * tool is not news to the person.
 */

const MCP_TOOL_PREFIX = "mcp__";

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The toast text for a mount notice, or null when it is not about MCP tools. */
export function describeMcpMountChange(details: unknown, text = ""): string | null {
  if (details && typeof details === "object") {
    const record = details as { added?: unknown; removed?: unknown };
    const added = names(record.added).filter((name) => name.startsWith(MCP_TOOL_PREFIX));
    const removed = names(record.removed).filter((name) => name.startsWith(MCP_TOOL_PREFIX));
    if (added.length === 0 && removed.length === 0) return null;
    const parts: string[] = [];
    if (added.length > 0) parts.push(`${count(added.length, "MCP tool")} added`);
    if (removed.length > 0) parts.push(`${count(removed.length, "MCP tool")} removed`);
    return `${parts.join(", ")}.`;
  }
  // An engine that sends no details: only a notice that names an MCP tool is about MCP.
  return text.includes(MCP_TOOL_PREFIX) ? "The MCP tools available to this chat changed." : null;
}
