---
name: improving-cody
description: Use when developing, debugging, or extending Cody itself — the workspace is the Cody repo. Covers the self-development loop (you may be running inside the app you are editing), verification gates, and the stability-first engineering priorities.
---

# Improving Cody with Cody

You are working on Cody's own codebase — and quite possibly *through* Cody:
the chat UI carrying this conversation may be served by the very dev server
whose code you are editing. That is a supported, intended workflow. Use it.

## Priorities (in order)

1. **Stability** — Cody is self-hosted and every push to `main` is a release
   (see CLAUDE.md). Never push unverified work; a broken main breaks the
   owner's running instance.
2. **Robustness** — handle the failure path, not just the demo path: wedged
   child processes, dropped SSE connections, engines that reject commands
   with code `"unsupported"`.
3. **Flexibility** — Cody is a thin UI over swappable engines (omp, Claude
   Code, Codex). Never bind engine-neutral code to one engine; the seam is
   CI-enforced by `lib/architecture.test.mjs`. Capability flags hide
   surfaces, they never render broken ones.

Read `AGENTS.md` first (codebase map, traps), then `CLAUDE.md` (workflow
gates). Both are authoritative over this skill.

## The self-development loop

```bash
node_modules/.bin/tsc --noEmit   # typecheck
npm run lint
npm test                          # full suite, ~5s
npm run dev                       # port 30178 — NEVER `next build` in dev
```

- **Do not kill the dev server that is serving your own session.** If the
  user is chatting with you through `localhost:30178`, restarting that
  process kills the session mid-turn. Verify risky changes on a second
  instance instead:
  `node --experimental-strip-types bin/cody-server.js --dev -p 30179`.
- **Auth-gated verification**: a verification instance can be isolated with
  `CODY_ACCOUNTS_DIR=<empty tmp dir>`; create a throwaway admin via
  `POST /api/accounts/signup`, keep the cookie. Seed a workspace by
  navigating to `/?cwd=<path>`.
- **See your own work.** When running under Cody, you have host tools:
  `open_preview` (show a URL in the Preview panel), `preview_screenshot`
  (capture and *look at* the rendered result), `read_app_logs` (browser
  console + failed requests). Use screenshot + logs after every UI change —
  visual claims without them are guesses.
- Next.js in this repo differs from training data: read the guides in
  `node_modules/next/dist/docs/` before writing Next-specific code.

## Making changes that last

- Clean cutovers only: migrate every caller, delete the old path in the same
  change. No shims, no parallel conventions.
- New engine-neutral code goes through `@/lib/harness`, never `lib/omp/*`
  directly (the architecture test will fail the build otherwise).
- Cody-level state (accounts, checkpoints, engine selection, session owners)
  lives in the instance data dir and must survive engine switches.
- Design tokens only (`app/globals.css`) — no hardcoded colors; icons from
  `lucide-react`; primitives from `components/ui/`.
- Update `AGENTS.md` (file map + design decisions) in the same commit as any
  structural change, so the next agent inherits the map you had.
