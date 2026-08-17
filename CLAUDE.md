# CLAUDE.md — project preferences for agents working on Cody

Architecture and codebase knowledge live in **AGENTS.md** (read it first) and
`docs/harnesses.md`. This file is the owner's workflow preferences — the
rules that govern *how* to work on this repo, regardless of which agent or
model is doing the work.

## Git & releases (the rules that matter most)

- **`main` is the only branch.** Commit and push directly to `main`. Never
  create feature branches; delete any that appear. Pull requests are not
  part of this workflow.
- **Every push to `main` IS a release.** CI (.github/workflows/docker.yml)
  builds the container, runs the smoke gate, and republishes
  `ghcr.io/nphil/cody:latest`, which the owner's Unraid server pulls.
  Therefore: never push unverified work. The bar before any push:
  `npm run typecheck && npm run lint && npm test && npm run build`, plus a
  real exercise of whatever changed (route smoke via jiti, a Playwright
  pass, or a live local server — match the verification to the change).
- **Watch CI after every push** until the run for your head commit is green
  (~4–8 min; longer since the smoke test installs omp in-container). Use a
  scheduled check-in (send_later or equivalent) rather than polling. If CI
  fails, diagnosing and pushing the fix is part of the same task — the
  smoke gate blocks publishing, so a red run means the release didn't
  happen, not that the server broke.
- The smoke test is a **contract**, not a formality: it pins the locked
  first boot, first-run admin signup, in-app omp install, Basic-Auth
  compatibility, and SSH bring-up. When behavior changes deliberately,
  update the contract in the same commit.
- Never put model identifiers in commits, PR text, or code comments.
  Commit messages: imperative subject that names the user-visible outcome,
  body explaining why (see `git log` for the house style).

## Delegation & token strategy

The owner runs complex jobs through an orchestrator + subagents and wants
tokens conserved deliberately:

- The **orchestrator** (whatever model is driving) does architecture,
  contracts, tricky seams, and review synthesis itself; it **delegates bulk
  implementation, exploration, and translation to subagents**.
- Pick subagent models by role, not by brand: routine/mechanical work goes
  to a **cheaper, faster model**; only genuinely hard slices (protocol
  design, integration surgery, adversarial review verification) get a
  **top-tier model**. When running under Claude Code that maps to
  Sonnet-class vs Opus-class — but Cody's whole point is engine
  flexibility, so under omp/Codex/other engines use the equivalent tiers of
  whatever model family is configured. Do not hard-code Claude model names
  into workflows or scripts.
- Adversarial review is **token-lean by default**: a few focused reviewer
  lenses over the actual diff, findings must carry a traced failure
  scenario, empty result is acceptable. No broad re-review of code the
  suite already covers.
- Give subagents precise file-scoped briefs (disjoint files when parallel),
  demand honest verification reports, and re-verify the merged tree
  centrally afterwards.

## Conventions worth not re-discovering

- i18n: user-facing chat/login/panel strings go through `lib/i18n`
  (en + ja + zh-CN, all three, real translations); the Settings panel's
  own copy is deliberately English-only. `lib/api-contract.test.mjs` pins
  some literal UI strings — check it before rewording.
- All Cody-level state (accounts, engine selection, session owners, engine
  session index, tools prefix, checkpoints) lives in the instance data dir
  via `lib/omp/paths.getAgentDir()` — never under an engine's own dir.
- The UI hides what an engine can't do (capability flags); the server fails
  soft with the `"unsupported"` error code. Keep both halves in sync.
- READMEs exist ×3 (en/ja/zh-CN) and must stay in lockstep; Cody is NOT
  published to npm — source or Docker only.
- Keep the README's "100% vibecoded" disclaimer intact.

## Deployment context

- Production is a Docker container on the owner's **Unraid** server
  (reachable over Tailscale), installed from `ghcr.io/nphil/cody:latest`
  with the template in `docker/unraid-template.xml`; walkthrough in
  `docs/unraid.md`. The image is engine-free; engines install from the
  onboarding picker into `/data/agent/tools`.
- Fresh-install UX the owner expects: open WebUI → first-run setup mints
  the admin (no password env needed) → engine picker → work. SSH
  (optional, `CODY_SSH_PASSWORD`) lands in the active engine's CLI.

## Owner's roadmap notes (see the task list for live state)

- Switchyard (NVIDIA) as a model-routing layer under the engines —
  config-level now, a settings surface once it stabilizes.
- Preview panel → universal display surface (host allowlist, optional
  noVNC virtual display, Android-emulator side-container recipe).
- Native Android tablet / iOS clients — architecture plan in
  `docs/android.md` (one UI, two backends: online thin client over
  Tailscale by default, fully-offline mode via Termux + on-device
  GPU/NPU models). Keep the HTTP API surface clean and documented; it is
  the contract those clients will consume.
- More engines (Pi, Cline, Cursor, …) via `docs/harnesses.md`'s checklist.
