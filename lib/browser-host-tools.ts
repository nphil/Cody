// The tools and URI scheme Cody's browser window gives the agent. They live in
// one module because TWO places must agree on them byte for byte: the browser
// (hooks/useAgentSession.ts registers them on every stream connect) and the
// server (lib/rpc-manager.ts publishes them to every engine child it spawns,
// whether or not any browser is attached).
//
// Why the server publishes them itself: the roster is part of what the model
// is sent before the conversation. A chat woken with no browser attached (an
// agent's message, a schedule, a retry after idle disposal) used to start
// without these three tools, and one a browser woke started with them, so the
// request prefix flipped between two shapes at consecutive restarts and each
// flip re-wrote the whole chat into the provider's prompt cache (measured:
// 44 of 49 cache losses of 4-60 minutes, about 17 million tokens in 12 days).
// With no browser attached a call is refused at once (rpc-manager
// rejectUnexpectedHostTool), exactly as before the tools were advertised.
//
// Browser-free and import-free so the client bundle and omp's own Bun runtime
// can both load it. Changing a description here changes every chat's prefix
// once: do it deliberately.
import type { HostToolDefinition, HostUriSchemeDefinition } from "./pi-types";

export const BROWSER_HOST_TOOLS: readonly HostToolDefinition[] = [
  {
    name: "open_url",
    description: "Open a URL in a new browser tab. Loopback URLs (localhost / 127.0.0.1) open in Cody's embedded Preview panel instead.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "notify",
    description: "Show a browser notification to the user.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        message: { type: "string", description: "Optional notification body." },
      },
      required: ["title"],
    },
  },
  {
    name: "open_file",
    description: "Open a file in the workspace file viewer.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute or workspace-relative file path." } },
      required: ["path"],
    },
  },
];

/** `pi-web://clipboard` reads and writes the user's clipboard through the web UI (best effort: the browser may gate clipboard reads behind a permission prompt). */
export const BROWSER_HOST_URI_SCHEMES: readonly HostUriSchemeDefinition[] = [
  {
    scheme: "pi-web",
    description: "Browser-integrated resources: pi-web://clipboard reads/writes the user's clipboard via the web UI.",
    writable: true,
  },
];

const BROWSER_TOOL_NAMES = new Set(BROWSER_HOST_TOOLS.map((tool) => tool.name));

export function isBrowserHostTool(name: string): boolean {
  return BROWSER_TOOL_NAMES.has(name);
}
