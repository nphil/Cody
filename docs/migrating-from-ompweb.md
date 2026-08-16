# Migrating from omp-web to Cody

Cody is the continuation of the omp-web fork. Migration is deliberately
boring: agent data is untouched and old configuration keeps working. This page
is the complete list of what changes.

## What migrates automatically (do nothing)

- **Sessions, skills, models, MCP config, everything under the agent dir** —
  Cody reads the same native OMP state at `~/.omp/agent`
  (`PI_CODING_AGENT_DIR` honored) that omp-web read. There is no data
  migration; both UIs can even point at the same agent dir during the
  cut-over.
- **Environment variables** — every `OMP_WEB_*` name still works
  (`OMP_WEB_PASSWORD`, `OMP_WEB_OMP_BIN`, `OMP_WEB_HOSTNAME`,
  `OMP_WEB_NO_OPEN`, …). The `CODY_*` spelling is preferred and wins when
  both are set. Existing service files and scripts run unmodified.
- **Browser preferences** — theme, language, panel widths, composer prefs
  migrate from omp-web's storage keys automatically on first load,
  per browser.

## What you must change

1. **The command**: `ompweb` → `cody` (same default port 30177, same flags).
   Uninstall the old global to avoid stale binaries:
   `npm uninstall -g @kahme247/ompweb`.
2. **Install source**: `@nphil/cody` is not on npm yet — run from a checkout
   (`npm ci && npm run build && npm start`), or use the Docker bundle in
   `docker/` (recommended for Unraid — see `docs/unraid.md`).
3. **Basic Auth username changed**: `omp` → `cody`. Update saved browser
   credentials, reverse-proxy health checks, and any script doing
   `curl -u omp:...`.

## New state Cody creates

- `<agentDir>/cody-checkpoints/` — shadow git repositories backing workspace
  checkpoints (automatic pre-prompt snapshots + restore). Include it in
  backups if you want restore points to survive; deleting it only loses
  those restore points, never project files.
- `<project>/.cody/tasks.json` — optional per-project task definitions for
  the Tasks panel.

## What's new since omp-web (orient yourself)

The right panel is a seven-tool workspace: Files, Git (status, diffs,
stage/unstage/discard/commit, checkpoints), Terminal, Preview (embedded dev
server view with detach), Tasks, Updates, Info. Both side panels have
draggable grab handles. See the README feature list; design notes live in
`docs/specs/`.

## Project direction (for maintainers)

Cody is a **standalone web UI that consumes agent harnesses** — omp today,
Pi/Hermes/others as adapters tomorrow. It does not grow its own agent. In
practice:

- New features default to the harness-neutral side (panels, git, terminals,
  checkpoints are already neutral).
- Anything that must touch harness internals goes through `lib/harness/`
  (contract + capability flags) or is listed in `docs/harnesses.md`'s
  coupling map — that document is the porting checklist for a new harness
  and must stay truthful.
- `AGENTS.md` is the development entry point (file map, commands, gotchas);
  `DESIGN.md` is the product contract, including how to learn from the
  upstreams (kahme247/ompweb, jmfederico/pi-web, oh-my-pi) without merging
  them blindly.
