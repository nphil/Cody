import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "./paths";

/**
 * The one symlink dance every isolated omp child uses, instead of three
 * near-identical copies of it.
 *
 * Before this, `lib/rpc-manager.ts`'s sidebar chat and
 * `lib/model-presets/research.ts`'s web-research planner each grew their own
 * version of "empty `mcp.json`, real credentials symlinked in": the same
 * fix, the same trap (a missing target must be skipped, never linked
 * dangling), written twice. Distill and the session namer needed it a
 * third time — see AGENTS.md's "Distill" and "Sidebar chat" sections — which
 * is the point at which three copies of one idea become a shared module
 * instead of a third copy.
 *
 * omp reads user-scope MCP servers from `<agent dir>/mcp.json` and has NO
 * flag or setting to suppress it: `--no-tools`/`--no-extensions` cover its
 * own builtins and extension discovery, not this file. Measured on a real
 * install, a print-mode child that inherited two ordinary MCP servers took
 * 45-58 seconds just to connect to them before answering at all; the same
 * child against an isolated dir answers in a few seconds. An isolated child
 * still needs the user's OWN credentials, providers and model config, so
 * those are SYMLINKED in — never copied, because a copy would not receive an
 * OAuth token's own refresh, and the real agent.db is already opened from
 * concurrent omp processes today (SQLite puts `-wal`/`-shm` beside the
 * symlink TARGET, not the link, so this is safe).
 */

/** What an isolated child can see of the real agent dir by default. A caller
 * with no attachments to send (the web-research planner) may pass a shorter
 * list; nothing needs a LONGER one, since NOTHING beyond these five ever
 * matters to a one-shot print-mode run. */
const DEFAULT_LINKED_FILES = ["agent.db", "models.yml", "models.yaml", "config.yml", "config.yaml", "blobs"] as const;

const EMPTY_MCP_CONFIG = '{"mcpServers":{}}\n';

/**
 * Build or refresh one isolated agent dir: an explicitly empty `mcp.json`,
 * plus symlinks for whichever of `files` exist in the real agent dir.
 *
 * Idempotent and cheap enough to call before every spawn: an existing,
 * correct symlink is left alone; a stale one (pointing somewhere else — a
 * profile switch, a moved install) is replaced; a target that does not
 * exist yet (a fresh install with no `agent.db` until its first
 * credential) is skipped rather than linked dangling.
 */
export function linkIsolatedAgentDir(targetDir: string, files: readonly string[] = DEFAULT_LINKED_FILES): void {
  mkdirSync(targetDir, { recursive: true });
  const mcpPath = path.join(targetDir, "mcp.json");
  let currentMcp: string | null = null;
  try { currentMcp = readFileSync(mcpPath, "utf8"); } catch { /* absent */ }
  if (currentMcp !== EMPTY_MCP_CONFIG) writeFileSync(mcpPath, EMPTY_MCP_CONFIG, { mode: 0o600 });

  const sourceDir = getAgentDir();
  for (const name of files) {
    const target = path.join(sourceDir, name);
    const link = path.join(targetDir, name);
    if (!existsSync(target)) continue;
    try {
      if (readlinkSync(link) === target) continue;
      rmSync(link);
    } catch { /* not a link, or absent */ }
    try { symlinkSync(target, link); } catch { /* raced with another spawn */ }
  }
}

/**
 * A reusable, process-wide isolated agent dir for one-shot print-mode
 * children that need no per-run isolation of their own: Distill
 * (`lib/distill/runner.ts`) and the session namer (`lib/session-namer.ts`).
 * Both need exactly the same file set and neither is a security boundary
 * against the other (they already run against the same real agent dir
 * concurrently today), so they share ONE directory — created once per
 * process, under omp's own agent dir tree so it is obviously Cody-owned
 * state and never a user workspace, and re-validated (not recreated) on
 * every call.
 *
 * The web-research planner (`lib/model-presets/research.ts`) does NOT use
 * this: it reads untrusted web content for most of its turn, so it keeps its
 * own fresh, cleaned-up-per-run directory instead of a shared, longer-lived
 * one — see that module's doc comment for the security reasoning.
 */
export function getOneShotAgentDir(): string {
  const dir = path.join(getAgentDir(), "cody-one-shot-agent");
  linkIsolatedAgentDir(dir);
  return dir;
}
