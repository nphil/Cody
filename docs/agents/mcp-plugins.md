# MCP, plugins, skills and update notifications

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- MCP configuration (`lib/omp/mcp-config.ts`, `/api/mcp`, `components/McpConfig.tsx`)
- Plugins and skills
- Update notifications (`/api/omp-update`, `/api/app-update`)

### MCP configuration (`lib/omp/mcp-config.ts`, `/api/mcp`, `components/McpConfig.tsx`)
- Project MCP config resolution order: `.omp/mcp.json`, `.omp/.mcp.json`,
  `mcp.json`, `.mcp.json` at the git top level (falls back to cwd for
  non-git dirs). Server definitions support `stdio`, `http`, and `sse`;
  exactly one of `command`/`url` is required and validated before any write.
- Writes are atomic (temp file + rename), preserve unrelated top-level keys
  (`disabledServers`, `enabledServers`, `$schema`, ...), and support rename via
  `previousName`.
- **Both writable scopes go through one target.** `writeMcpServer(target, …)`
  and `deleteMcpServer(target, …)` take `{scope: "user" | "project", cwd?}`:
  `"project"` resolves `cwd` as above and REQUIRES it, `"user"` is
  `getUserMcpPath()` (`<agent dir>/mcp.json`) and ignores it. Same cross-process
  lockfile mutex, same atomic rename for both. `/api/mcp` POST/DELETE default to
  `scope: "project"`, so a caller written before user scope existed is unchanged.
- **A user-level secret never reaches the browser** (`lib/mcp-secrets.ts`, a
  pure module because `components/` may not import `lib/omp/*`). GET serves the
  user config with every `headers`/`env` value replaced by
  `MCP_SECRET_SENTINEL`; `writeMcpServer` merges each sentinel back from the
  same locked snapshot it writes, and REFUSES the write when nothing is stored
  for that key — a save can never blank a credential the form did not show. The
  editor renders the sentinel as `••••••••` and swaps it back on submit. Project
  configs are served raw: that file lives in the repo the user can already read.
- **User scope is admin-only** (`userScopeDenied` in the route): every session
  loads those servers, and a stdio entry there is a command that runs in
  everyone's sessions; the `url` cannot be masked and can itself be the
  credential (an ha-mcp webhook). So the full user config rides GET only for an
  admin, user-scope POST/PUT/DELETE answer 403 `admin_required` otherwise, and
  a member gets the name/status rows plus `canManageUser: false`, which hides
  the Add button. The no-accounts open instance is exempt, as `/api/models/seen`
  already is: the viewer there IS the administrator. Project scope stays open —
  that file lives in a workspace the member can already edit from a session.
- **Enable/disable is the user file's `disabledServers`**, not the server's own
  `enabled` flag: omp reads that denylist from the USER path only and it always
  wins (`src/mcp/config.ts`). `setUserServerDisabled(name, disabled)` owns it —
  the key is dropped when the list empties, a rename carries the entry, and a
  delete removes it (otherwise the name keeps a ghost row and silently
  suppresses a future server). Reached over PUT `{action, scope:"user", name}`;
  PUT without `action` is still the validate-only check.
- The MCP settings live under Settings › Extensions › MCP. A `SegmentedControl`
  picks the scope ("This project" / "All sessions"); only the project scope is
  workspace-gated, because a user-level server is exactly what is configurable
  without a project. Server list rows
  show a config-derived status dot
  (valid+enabled / disabled / invalid) — no live-connectivity probe exists in
  the RPC protocol, so failures surface as toasts (`toast.error`) from the
  editor actions, not inline text.
- The endpoint is guarded by the same allowed-root rules as `/api/files` — for
  the project scope. A user-scope call carries no cwd and is not root-checked.

### Load on demand (`lib/on-demand-mcp/`, `lib/omp/on-demand-mcp.ts`, `lib/omp/on-demand-chats.ts`, `lib/omp/extensions/cody-on-demand-mcp.ts`)
- **Why.** omp puts every tool of every configured MCP server into every request of every chat. `rea` (reverse engineering, ~229 tools) costs ~14,038 tokens per request (56,152 characters on omp 18.8.3, 55,007 on 18.19.0); omp 18.19.0 with `computer.enabled` inlines another ~22,000 characters into the `eval` tool description. Load on demand turns those into one ~100-token tool plus a pay-when-used mount.
- **Registry.** `<getAgentDir()>/cody-on-demand-mcp.json`: `{"version":1,"servers":{"<name>":{"purpose":"one line telling when to load it","config":{<an omp mcp.json server entry>}}}}`. omp never reads it. `lib/omp/on-demand-mcp.ts` is the store (`readOnDemandServers`, `writeOnDemandServer`, `deleteOnDemandServer`, `setServerOnDemand`; same lock/atomic-rename helpers and secret masking as `mcp.json`; a corrupt file is never overwritten; a bad entry becomes a `problems` line and never hides the others). `setServerOnDemand` writes the destination before it removes the source, so an interrupted move leaves the server in both places, not neither. stdio and http servers only (legacy sse stays in `mcp.json`); a disabled server must be enabled first.
- **Extension.** Loaded by omp with `--extension` on omp engines only. It depends on `lib/on-demand-mcp/*` (Node built-ins only; the repo's own small MCP client `mcp-client.ts`). `load_tools {server}` connects, lists tools and `registerTool`s each as `mcp__<server>_<tool>` (same name omp would mint; omp shows them under its xd:// devices and adds a one-time `<system-notice>` inventory to the next prompt). The mount is recorded with `appendEntry("cody-on-demand-mcp", {server, action})` in the chat's own session file; `session_start/switch/branch/tree` replay those entries and remount, and `before_agent_start` waits up to 25 s (omp caps a handler at 30 s) so the first request after a resume already has the tools. A restore that fails adds ONE hidden `cody-on-demand-restore` custom message (guarded by `noteIsLive`), NEVER a replaced system prompt: omp re-announces the whole xd:// catalog (~6.6k tokens) whenever a handler returns a `systemPrompt`. The extension registers no `tool_call`/`tool_result` handler (that would turn off `task.speculativeLaunch`).
- **`computer`.** Not an MCP server: omp builds its tool set (and the long `eval` description) at engine start, so only a restart changes it. `lib/omp/cody-launch-defaults-computer.yml` (per-key layer, dropped when config.yml says `computer.enabled: true`) keeps it off; `load_tools {computer}` returns `details.codyOnDemand = {server:"computer", action}`; `AgentSessionWrapper.applyOnDemandSignal` (from the `tool_execution_end` frame, parser `onDemandSignalFromEvent`) stores the flag per chat in `<agent dir>/cody-on-demand-chats.json` and calls `restartForRoutingWhenIdle`, which waits for `agent_end`; the relaunch passes `lib/omp/cody-on-demand-computer-on.yml` as the LAST `PI_CONFIG_FILES` layer and `CODY_ON_DEMAND_COMPUTER=on`. The restart interrupts nothing mid-turn but the tools exist from the user's NEXT message, so the agent tells the user to send the request again. The flag follows a fork (`copySessionToolsets`) and a rename onto omp's real id, and is forgotten when the chat is deleted.
- **API/UI.** `GET /api/mcp` adds `onDemand {path, servers[{name,type,purpose,valid,config?}], problems, computer{onDemand,supported}}` (`config` admin-only, masked). PUT `{action:"ondemand", scope:"user", name, onDemand, purpose?}` moves a user-level server; PUT `{action:"computer", onDemand}` writes `computer.enabled` (false = on demand) and answers 400 when the engine has no such setting; POST/DELETE take `onDemand:true` for registry entries. All admin-only like user scope. Settings > Extensions > MCP shows a "Load on demand" switch per user-level server, an "On demand" section (edit purpose, move back, delete) and a built-in "Desktop control" row.
- **ACP engines: unsupported.** They take MCP servers from their own config, never load the omp extension, and hide the MCP surface (`capabilities.mcp` false). `bin/cody-display-mcp.js` and its drift test are unchanged.
- **Known limits.** (1) A subagent (omp `task`) loads the extension too, but a `computer` signal from inside a subagent never reaches the host chat. (2) `rea`-style servers cost a start-up (npx) on first load and on every resume that remounts them. (3) An instance whose config.yml already says `computer.enabled: true` gets no saving until it is set to false (the Desktop control switch writes it).

### Plugins and skills
- `/api/plugins` shells out to the user's `omp plugin` CLI (`list/install/uninstall/enable/disable/upgrade`, `--json` where available) — never the Bun-only SDK. `lib/omp/plugin-cli.ts` holds the shared `execFile`/loose-JSON-parse helpers (`runOmpCli`, `parseJsonLoose`), used by both `/api/plugins` and `/api/plugins/marketplace`.
- **`plugin upgrade` targets.** omp 18.4.5+ accepts a bare marketplace plugin name and npm/git-installed plugins; 18.3.x accepts only `name@marketplace` (anything else exits with "Invalid plugin ID"). `/api/plugins` `update` already forwards the source verbatim (works on both, 18.3.x just refuses npm plugins), and the marketplace route's `parsePluginId` check is an input guard, not a workaround, and stays so a bare name never reaches an 18.3.x engine.
- **Plugin marketplace** (`/api/plugins/marketplace`, `lib/omp/marketplace.ts`, `components/PluginMarketplace.tsx`): browse data is a pure-Node read of `marketplaces.json` (the registry of `omp plugin marketplace add`ed catalogs, at `getMarketplacesRegistryPath()`) plus each marketplace's cached `marketplace.json` catalog (`getPluginsDir()`'s cache dir, `~` expanded) — no child process. `lib/omp/paths.ts`'s `getOmpDataRoot()` is the shared root for both (`~/.omp`, or its XDG equivalent): omp's own `DirResolver` gates XDG activation on the SAME `PI_CODING_AGENT_DIR`-override check for config-root-scoped paths (plugins, marketplaces) as for agent-scoped ones, so `getOmpDataRoot()` reuses the existing `xdgDataAgentRoot()` value rather than re-deriving a separate check — the override disables XDG resolution instance-wide, not per-category. Installed-state (which catalog plugins are already installed, at what version/scope) comes from `omp plugin list --json`, same as `/api/plugins`. Every mutation (add/remove/update marketplace, install/uninstall/upgrade a plugin) shells out to the CLI; name/id segments are validated against omp's own `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$` rule before reaching argv.
- **Bundled plugin versions.** `readMarketplaceCatalog` now shows a bundled (`source: "./…"`) plugin's own `.claude-plugin/plugin.json` / `plugin.json` version before the catalog entry's, matching what `omp plugin upgrade` installs (18.11+).
- `/api/skills` uses `lib/skills-service.ts`, a pure-Node scanner mirroring the ACTIVE engine's discovery. omp: project `.omp/skills` (walk-up), `~/.omp/agent/skills`, then the `.claude` / `.agent(s)` / `.codex` / `.github` compat dirs and managed skills. pi: a narrower set (`buildPiScanRoots`).
- **The scan is one level deep.** Every root sits inside a repo or a user config dir, so a recursive walk would list every vendored, checked-out or archived `SKILL.md` as a loaded skill.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent universal`, which installs into the ecosystem-standard `.agents/skills` dirs omp reads; project installs run with the selected cwd.
- **The surface reports what it can do.** `GET /api/skills` returns `installScopes` and `canToggle` beside the skills, so the store hides a scope selector or a Check button for an engine whose installer cannot honour them, rather than rendering a control that fails.
- **The composer's skill lookup is capability-gated.** `ChatInput` fetches `/api/skills` to dim dormant skills in the `/` palette; it reads `capabilities.skills` off the flag set AppShell threads down. Without that gate, Claude Code and Codex (`skills: false`) ran a full filesystem scan on every `/` keystroke.
- The skill store (`components/SkillsStore.tsx`, `/api/skills/store`, `lib/skills-registry.ts`) talks to skills.sh's public endpoints — `/api/search` (fuzzy for one word, semantic over descriptions for phrases) and `/api/download/{owner}/{repo}/{slug}` for SKILL.md details. The documented `/api/v1/*` surface needs a Vercel OIDC token, so browse views are category-seeded searches, never a scraped ranking. Well-known (non-GitHub) sources install as whole-provider bundles (`https://<domain>`) because the CLI has no per-skill selector for them; the UI says so.

### Update notifications (`/api/omp-update`, `/api/app-update`)
- Automatic in-app self-updating has been removed in favor of explicit user notifications and manual terminal commands.
- `GET /api/app-update` returns `updateAvailable`, the exact terminal command, and `managedBy` naming the channel that ships to this deployment. A container install (detected via `/.dockerenv`) is compared against the latest `nphil/Cody` GitHub release and updated with `docker pull ghcr.io/nphil/cody:latest`; anything else queries the npm registry for `@nphil/cody` and uses the detected install manager (`bun` vs `npm` via `detectInstallMethod`), e.g. `npm install -g @nphil/cody` or `bun add -g @nphil/cody`.
- `POST /api/omp-update` (`action: "check"`) runs `omp update --check` and returns `updateAvailable` plus `updateCommand: "omp update"`.
- `POST /api/omp-update` (`action: "restart"`) restarts active OMP sessions after a manual CLI update.
- Notifications in `AppShell` and the Cody card in Settings › System
  (`components/settings/SystemUpdates.tsx`) present the update notification
  alongside copyable terminal update commands.

