# Cody Android app — architecture plan

Status: **design doc, no code yet.** This is the blueprint for the native
Android tablet client. Target hardware for the first build is the owner's
Snapdragon 8 Elite tablet (Adreno 830 GPU, Hexagon NPU, 12–16 GB RAM);
distribution is sideloaded APK / GitHub releases, not the Play Store — that
choice is load-bearing (see [Termux integration](#termux-integration)).

The one-sentence version: **one tablet-optimized UI, two swappable
backends** — the default backend is the Cody server on Unraid reached over
Tailscale, and the offline backend is a self-contained brain on the tablet
itself (Termux userland + on-device models on the GPU/NPU). The mode switch
is Cody's engine-picker idea applied one level up: instead of swapping the
engine behind the server, swap the entire backend behind the UI.

## Goals

- Tablet-first UI/UX for the things Cody already does: chat with an agent,
  files, git, terminals, tasks, preview.
- **Online mode (default):** thin client to the Cody container on Unraid via
  Tailscale. Full Linux/x86, full engine capabilities, cloud models.
- **Offline mode:** fully functional with zero network. Real local terminal
  (not streamed), local models on the Snapdragon's GPU/NPU, models fetched
  from Hugging Face ahead of time. A trimmed but genuine coding assistant.
- **Local assist:** even in online mode, trivially easy LLM tasks can run on
  the on-device model to save tokens and latency.

## One UI, two backends

The app defines a single backend interface shaped by the server's existing
HTTP API (the routes under `app/api/` — that surface is the contract, which
is why AGENTS.md/CLAUDE.md insist it stays clean). Two implementations:

| | `RemoteBackend` | `LocalBackend` |
| --- | --- | --- |
| Transport | HTTP + SSE/WS to the Unraid container | in-process calls on the tablet |
| Auth | Cody account login → session cookie | none (device is the trust boundary) |
| Engine | whatever the server has active (omp, …) | built-in lite agent, later real engines in Termux |
| Models | cloud providers via the server | local GGUF/QNN models |
| Terminal | streamed server PTY | **real local PTY in the Termux userland** |
| Files/git | server workspace | on-device workspace (Termux `$HOME` or shared storage) |
| Sessions | server-owned, per-account | device-owned, stored locally |

Rules that keep this honest:

- The UI is written against the interface, never against a transport. Every
  screen the web client gates on capability flags, the app gates the same
  way — offline mode simply reports a smaller capability set (no checkpoints
  at first, no skills, no preview), and the UI hides what the backend can't
  do, exactly like the web UI does for lesser engines.
- Mode switching is explicit — a toggle in settings plus an offer to switch
  when the server is unreachable. No silent fallback: the user always knows
  which brain they're talking to (a persistent badge shows remote/local).
- Session stores stay separate (a server session and a device session are
  different objects). Sync-back of offline sessions is a later phase, not a
  launch requirement.

### What the app consumes from the server (online mode)

The current API surface the `RemoteBackend` maps onto: `accounts/*` (login,
me, avatar), `engines` (+ install/select for admin), `sessions/*` (list,
state, context, export, auto-name, subagents), `agent/*` (new, events
stream, bash-output), `files/*`, `git/*` (status, diff, mutate),
`terminals/*`, `tasks/*`, `checkpoints`, `models*`, `info`, `home`,
`cwd/*`, `projects`, `worktrees`. Event delivery is the same SSE/WS streams
the web client uses.

Server-side work this implies (small, do when the app starts):

- **Token auth for native clients.** Cookie auth works but is awkward on
  mobile; add a personal-access-token / bearer option next to the cookie —
  same accounts, same session-ownership model.
- **Document the API** (`docs/api.md`) as routes stabilize — the app is the
  first consumer that isn't in this repo.

## Offline mode

Three layers, each independently useful:

```
┌───────────────────────────────────────────────┐
│ Cody app (Kotlin) — UI + LocalBackend         │
│  ├─ built-in lite agent loop (phase 2)        │
│  ├─ terminal emulator view (real local PTY)   │
│  └─ HF model manager                          │
├───────────────────────────────────────────────┤
│ Termux userland (companion app or embedded)   │
│  ├─ shell, git, python, node — real dev tools │
│  ├─ proot-distro (Debian) → glibc userland    │
│  │   └─ full engines: omp / codex / claude    │
│  └─ llama.cpp llama-server on localhost:port  │
├───────────────────────────────────────────────┤
│ Snapdragon 8 Elite                            │
│  ├─ Adreno GPU  ← llama.cpp OpenCL backend    │
│  ├─ Hexagon NPU ← Qualcomm Genie/QNN (phase 3)│
│  └─ CPU fallback (always works)               │
└───────────────────────────────────────────────┘
```

### Termux integration

Termux provides the Linux userland: shell, git, python, node, ssh — the
"basic dev tools" story from the Docker image, on-device. Two integration
depths, in order:

1. **Companion app (start here).** Require Termux installed alongside; the
   Cody app drives it through the `RUN_COMMAND` intent API
   (`com.termux.permission.RUN_COMMAND`) and shares a workspace directory.
   Clean licensing, nothing to fork, and Termux stays independently useful.
2. **Embedded terminal (the "real in-app terminal").** Embed Termux's
   `terminal-view`/`terminal-emulator` libraries and bootstrap so the PTY
   lives inside the Cody app itself — the in-app terminal is then a real
   local shell, not a stream. Those libraries are **GPLv3**, which is the
   reason sideload distribution matters: the app (or at least the terminal
   module) must be GPL-compatible and Play Store policy against executing
   downloaded code is moot. Decide the license boundary before writing this
   module, not after.

Either way, the engine-first behavior mirrors SSH into the Docker
container: opening the in-app terminal in offline mode drops into the
active local engine's CLI, `exit` falls back to a plain shell.

### Engines on-device — the honest matrix

- **Built-in lite agent (the phase-2 workhorse).** A small Kotlin-native
  agent loop inside the app: local model + a minimal tool set (read/write/
  edit files, run commands in the Termux userland, grep). This is the
  "light coding" mode — fully controllable, no userland gymnastics, easy to
  point at whichever local runtime is fastest. It deliberately reuses
  Cody's event vocabulary so the chat UI renders it like any other engine.
- **Real engines under proot (the power option).** Termux is bionic-libc,
  so Bun (omp's runtime) and prebuilt engine binaries don't run natively.
  `proot-distro` gives a glibc Debian/Ubuntu rootfs inside Termux where
  `npm install` of omp/Codex/Claude Code works the same as on the server,
  reusing the tools-prefix convention. proot costs syscall overhead —
  acceptable for CLI agents, and each engine points its model provider at
  the localhost inference endpoint. Treat per-engine viability as something
  to verify on the actual tablet, not assume.

### On-device inference (Snapdragon 8 Elite)

- **GPU path — the workhorse.** llama.cpp's OpenCL backend is tuned for
  Adreno (Qualcomm contributed it). Run `llama-server` in Termux exposing
  an **OpenAI-compatible endpoint on localhost** — that one decision makes
  local inference "just another provider" for the lite agent, for engines
  under proot, and for anything else. Model format: GGUF straight from
  Hugging Face.
- **NPU path — phase 3.** Qualcomm AI Engine Direct (QNN) via the Genie
  SDK, models from Qualcomm AI Hub. Much better perf/watt but a restricted
  model catalog and real integration work. Best first use: the small
  utility model (titles, summaries), where the catalog restriction doesn't
  hurt.
- **CPU fallback** always works; it's the compatibility floor.
- **RAM realism:** a Q4_K_M 7B coder model (Qwen2.5-Coder-7B class) is
  ~4.7 GB plus KV cache — comfortable on 12 GB. A 14B Q4 (~8.5 GB) only
  fits the 16 GB configuration with short contexts. Suggested loadout: one
  7B–14B coder model for real work + one 1.5–3B utility model for cheap
  tasks (the same model the online mode's local-assist uses).

### Hugging Face integration

A model manager screen in the app: browse/search the HF Hub filtered to
GGUF (later QNN) artifacts, token auth for gated models, resumable
downloads into device storage, and a RAM-aware quantization advisor
("this device runs Q4_K_M of this model well; Q8 will not fit").
Downloading happens online, obviously — offline mode's model library is
provisioned ahead of time, like syncing music before a flight.

## Local assist (online mode + local model)

Default mode is online — but the on-device model earns its keep there too.
A task-class allowlist routes trivially easy jobs locally instead of
spending server/cloud tokens:

- session title generation (what `sessions/[id]/auto-name` does server-side
  today — the app can do it locally and skip the call)
- commit-message drafts in the git panel
- quick "explain this selection" / summarize-buffer actions
- possibly inline completions later

Policy lives client-side (the server API doesn't change), it's a user
toggle, and routing is never silent — the remote/local badge shows which
model answered. Anything agentic or tool-using always goes to the server in
online mode.

## Phasing

1. **Phase 1 — online thin client.** Tablet UI over `RemoteBackend` against
   the existing API. Immediately useful (today the fallback is the web UI in
   a browser tab); forces the token-auth and api-docs work; no on-device
   anything yet.
2. **Phase 2 — offline foundation.** Termux companion integration, HF model
   manager, llama.cpp localhost endpoint, built-in lite agent, explicit
   mode switch, local-assist routing in online mode.
3. **Phase 3 — power features.** NPU/Genie for the utility model, real
   engines under proot-distro, embedded terminal module (GPL boundary
   decided), offline-session sync-back, and whatever Phase 1–2 usage proves
   out.

## Open questions (decide before the phase that needs them)

- License boundary for embedding GPLv3 Termux libraries (Phase 3).
- Which engines actually run acceptably under proot on the tablet — verify
  omp-under-Bun-under-proot on real hardware early, it's the riskiest bet.
- Whether offline sessions ever merge into the server's per-account store,
  or stay a separate device-local history forever (simpler, maybe fine).
- iOS: none of the offline layer ports (no Termux, no sideloaded userland);
  the iOS app is Phase-1-shaped only. Keep that in mind before sharing UI
  code across platforms.
