import { homelabberBaseFromMcpUrl } from "../homelabber-approval";
import { readUserMcpConfig } from "./mcp-config";

/**
 * The web origin of HomeLabber, learned from omp's user-level `mcp.json`: the
 * `homelabber` server's URL is where its MCP route lives, and the web UI —
 * including the page where a backup code approves a request — is served from
 * the same origin. Null when no such server is configured or its URL is no
 * help (an IP address, say; see `homelabberBaseFromMcpUrl`).
 *
 * Only the ORIGIN comes out of this function. The server's `headers` and `env`
 * (bearer tokens) are never touched, and neither are the URL's path and query,
 * which can themselves be the credential (`lib/mcp-secrets.ts`).
 */
export function homelabberBaseFromConfig(): string | null {
  const server = readUserMcpConfig().servers.find(({ name }) => name.toLowerCase() === "homelabber");
  return server ? homelabberBaseFromMcpUrl(server.config.url) : null;
}
