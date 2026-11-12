# Core sections: verbatim archive of what AGENTS.md keeps in place

← Back to [AGENTS.md](../../AGENTS.md) · AGENTS.md keeps the live copy of these sections (and is authoritative for them); this is the verbatim archive.

Sections in this file:
- Git Workflow (project rule)
- Quick Start
- Improving Cody with Cody (self-development)
- Architecture
- Key Design Decisions & Traps

# Cody - Development Notes

> Owner workflow preferences (release discipline, delegation/token strategy,
> deployment context) live in **CLAUDE.md**; this file is the codebase map.

## Git Workflow (project rule)

`main` is the only long-lived branch and is always the latest, up-to-date state.
Commit and push directly to `main` — do not open feature branches, and delete any
that appear once their work is merged. Keep the branch list clean: `main` locally,
`origin/main` remotely, nothing else.

## Quick Start

```bash
npm run dev   # port 30178
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
Tests: `npm test` (`scripts/test.mjs`) — runs the whole suite under a private
`TMPDIR` that is deleted afterwards, because many tests `mkdtemp` and never
remove what they made (one run used to leave ~50 dirs in `/tmp`). Add new test
globs to its `SUITES` list.
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

The dev server needs the `omp` binary installed (on `PATH`, or set `CODY_OMP_BIN`).
All live-agent features go through it; session browsing works without it.

## Improving Cody with Cody (self-development)

Cody is developed through Cody: the agent reading this may be running inside
the app it is editing, with Cody's host tools available (`open_preview`,
`preview_screenshot`, `read_app_logs`) to see and verify its own work. This is
intended — use it. The playbook, including the do-not-kill-your-own-session
rule and how to verify on an isolated second instance, is the committed skill
`.claude/skills/improving-cody/SKILL.md` (discovered by Claude Code natively
and by omp via its `.claude` compat provider). Priorities when changing this
codebase: stability first (every push to `main` is a release), then
robustness, then flexibility — never bind engine-neutral code to one engine.

---

## Architecture

Cody never imports `@oh-my-pi/*` or `@earendil-works/*` packages (they are
Bun-only and cannot run inside Node/Next). See `DESIGN.md` for the full porting
contract.

```
Browser                Next.js Server                    omp child process
  │                        │                                    │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/       │
  ├─ GET /api/sessions/[id] reads .jsonl file directly          │
  ├─ GET /api/agent/running/events ───▶ running id SSE          │
  │                        │                                    │
  ├─ send message ─────────▶ POST /api/agent/[id]               │
  │                        │   startRpcSession() ── spawn ─────▶│ omp --mode rpc-ui
  │                        │   sendCommand({type:"prompt"}) ───▶│ (NDJSON stdio)
  │                        │                                    │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events         │
  │                        │   onFrame() ◀── event frames ──────│
  │◀── data: {...} ─────────│                                    │
```

**Session browsing** (read-only): pure-Node parsing of omp session `.jsonl`
files via `lib/session-reader.ts` — no child process involved.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` spawns
`omp --mode rpc-ui` (one process per active session) through
`lib/omp/rpc-process.ts`.

Shared foundations in `lib/omp/`:

- `paths.ts` — Node port of omp's directory resolution (`~/.omp/agent`,
  profiles, XDG, session dir slugs).
- `omp-cli.ts` — locate/probe the installed `omp` binary (`resolveOmpBin`,
  `getOmpVersion`).
- `rpc-process.ts` — process + NDJSON protocol layer (`RpcProcess`).

---

## Key Design Decisions & Traps

