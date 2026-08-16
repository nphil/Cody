# Cody and agent harnesses

Cody's web UI is being split from the coding-agent harness underneath it. The
goal: the same UI packages with [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi)
today, and can host Pi or another comparable agent by implementing one adapter
plus the porting checklist below — without forking the UI.

## The seam: `lib/harness/`

- `lib/harness/types.ts` — the `HarnessAdapter` contract: identity
  (id / display name / binary name), binary resolution + version probing,
  agent/session directory layout, and `HarnessCapabilities` flags
  (liveSessions, models, skills, plugins, mcp, nativeSettings, updates).
  A harness that lacks a capability should get its UI surface hidden, not
  broken.
- `lib/harness/omp.ts` — the omp adapter (all capabilities on).
- `lib/harness/index.ts` — `getHarness()`: selected by the `CODY_HARNESS`
  environment variable (default `omp`), failing loudly on unknown values.

Consumers wired through the seam so far: `/api/info` (harness id, name,
version, agent dir) — deliberately small, because the honest state of the
split is the map below, not a facade that pretends the UI is already
harness-neutral.

## Coupling map (the porting checklist)

Everything that still imports `lib/omp/*` directly. Adding a second harness
means either implementing the equivalent behavior behind the adapter, or
gating the surface off via a capability flag.

**Session model** (the biggest piece — transcript format + live RPC):

- `lib/session-reader.ts` — parses omp's session `.jsonl` layout
- `lib/rpc-manager.ts` — spawns `omp --mode rpc-ui`, NDJSON protocol
- `lib/subagent-history.ts`, `lib/project-registry.ts`
- `app/api/agent/[id]`, `app/api/agent/new`, `app/api/sessions/**`

**Configuration surfaces** (gate off via capability flags if absent):

- models: `app/api/models*`, `app/api/model-roles`, `app/api/providers/enable`,
  `app/api/auth/**` (credential handling is omp-specific by design)
- native settings: `app/api/omp-settings`
- skills: `lib/skills-service.ts`, `app/api/skills/**`
- plugins: `app/api/plugins` (shells out to `omp plugin`)
- mcp: `app/api/mcp`
- updates: `app/api/omp-update`, `app/api/omp-version`

**Harness-neutral already** (no port needed): the panel shell, file
explorer/viewer, terminals, the whole git surface (status/diff/mutate),
checkpoints (`lib/checkpoints.ts` uses omp only for the agent-dir location of
its shadow repos), tasks, preview, themes, i18n, storage.

## Packaging with a harness

The Docker image under `docker/` bundles Cody with omp for exactly this
purpose (see `docs/unraid.md` for the Unraid deployment). The harness the
image ships is a build argument, so a Pi-based image is the same Dockerfile
with a different install spec once a `pi` adapter exists.

## Adding a harness, concretely

1. Implement `HarnessAdapter` in `lib/harness/<id>.ts`; register it in
   `lib/harness/index.ts`.
2. Set capability flags honestly — every `false` must hide its Settings tab /
   panel surface (wire the flags through `/api/info` to the client).
3. Work through the coupling map top-down: session reading first (the sidebar
   and transcripts), live RPC second (chat), config surfaces last.
4. Run the suite: `npm run typecheck && npm run lint && npm test`.
