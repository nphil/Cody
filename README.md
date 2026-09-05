# Cody

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

Cody is a self-hosted web workspace for coding agents — an IDE you keep, with an **engine you can swap**. The interface stays constant (session browsing, real-time chat, files, git, persistent terminals, tasks, settings) while the coding agent underneath is chosen at onboarding and can be replaced any time: [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) is the founding, fully-featured engine; **Pi** ([pi.dev](https://pi.dev), omp's ancestor), **Claude Code** and **Codex** are available as experimental engines. Agents evolve fast — Cody lets you switch the internals without giving up your workspace.

Cody is a fork of [kahme247/ompweb](https://github.com/kahme247/ompweb) — see [Credits](#credits).

> **⚠️ 100% vibecoded.** This entire project is built by coding agents, for
> running coding agents. It works on the author's machines — install and
> experiment at your own risk.

![Cody — light theme](docs/screenshot-light.png)

<details>
<summary>Dark theme</summary>

![Cody — dark theme](docs/screenshot-dark.png)

</details>

<details>
<summary>Engine onboarding</summary>

![Choose your coding engine](docs/screenshot-engines.png)

</details>

## Getting started (Docker, recommended)

The container is the primary way to run Cody. It ships **engine-free** and
needs no configuration beyond two mounts and a port:

```bash
docker run -d -p 30177:30177 \
  -v /path/to/appdata:/data -v /path/to/projects:/workspace \
  ghcr.io/nphil/cody:latest
```

Then open the WebUI:

1. **First-run setup** — the instance is locked from its very first request;
   the only reachable page walks you through creating your account, which
   becomes the administrator. No password variables needed.
2. **Choose your coding engine** — pick omp (recommended), Pi, Claude Code,
   or Codex. Cody installs it into the persistent `/data` tools prefix, where it
   survives image updates and updates independently.
3. Add `/workspace/<your-project>` as a workspace and start working.

For Unraid there is a ready-made template and a full walkthrough in
[docs/unraid.md](docs/unraid.md). The image also carries everyday dev tools
(git, `gh`, python3 with pip/venv, ripgrep, jq) and optional **SSH access**
that lands directly in the active engine's CLI — exit the engine and you are
in a plain shell (see [SSH](#ssh-into-the-container)).

### Running from source (bare metal / development)

Cody is not published to npm — outside Docker, run it from a checkout.
Requires Node.js 22.19+ and an engine on `PATH` (omp for the full
experience):

```bash
git clone https://github.com/nphil/Cody && cd Cody
npm install
npm run dev            # development server on 127.0.0.1:30178

npm run build          # production build…
npm start              # …served on 127.0.0.1:30177 (start:lan for 0.0.0.0)
```

## Cody Desktop (Windows)

A native Windows app: a small Tauri shell (no bundled Chromium or Node in
the shell process) hosting the exact same UI, with the Cody server and
engines running inside a dedicated WSL2 distro built from the same image as
the Docker deployment.

Download the installer from the
[`desktop-latest` release](https://github.com/nphil/Cody/releases/tag/desktop-latest)
(`cody-desktop-*-x64-setup.exe`). Requires Windows 10 (2004+) or 11, x64,
and WSL2 — the installer guides you through enabling it if it's missing. An
NVIDIA GPU is optional, for local models running inside the distro.

**Status: experimental.** Full architecture in
[docs/windows.md](docs/windows.md).

## Engines

| Engine | Status | What you get |
| --- | --- | --- |
| **omp** (oh-my-pi) | Founding engine — every surface enabled | Full chat (thinking levels, forking, compaction, steering, subagents), models & providers, skills, plugins, MCP, native settings, updates |
| **Pi** (pi.dev) | Experimental | Live chat over Pi's native RPC — streamed replies, tool activity, steering, aborts; a settings panel read from Pi's own docs, skills, provider sign-in (Claude Pro/Max, ChatGPT, GitHub Copilot) and API keys |
| **Claude Code** | Experimental | Chat over ACP: streamed replies, tool activity, approvals in chat, the agent's own permission modes (Manual / Accept edits / Plan / Auto), model picker, session resume; sign in with a Claude subscription or an API key |
| **Codex** | Experimental | The same ACP surface: approvals, approval levels, model picker; sign in with ChatGPT (device code) or an API key |
| **Hermes** | Experimental | ACP chat with approvals, modes and a model picker; memory browser, skills, a settings panel from Hermes' own defaults; sign in with Nous Portal, Claude Pro/Max, ChatGPT and more |

- **Install & update from the UI**: the onboarding picker and
  Settings → System → Engines install engines on demand and give
  each an **Update** button, next to its version check. Updating the
  active engine restarts live sessions so nothing runs a stale binary.
- **One place for API keys**: Settings → Providers takes a provider
  key once (Anthropic, OpenAI, OpenRouter, Gemini, Bedrock, …) and hands it to
  every engine as an environment variable, the same way a key set on the
  container would reach it — so switching engines never means re-entering
  credentials. Subscriptions sign in from the same hub: a Claude Pro/Max
  account, ChatGPT for Codex, Nous Portal for Hermes, GitHub Copilot and the
  rest run the engine's OWN login headless — Cody shows the URL, and when the
  browser cannot reach the container you paste the code or the final
  redirect URL back (or type a device code where the provider uses one).
  omp's model registry lives in the same hub, in a provider's own detail view.
- **Local models stay reachable**: omp's model registry takes custom
  providers; Codex supports `--oss`/custom `model_provider` endpoints; the
  Claude engine honors `ANTHROPIC_BASE_URL`. Any OpenAI/Anthropic-compatible
  gateway (vLLM, Ollama, a routing proxy like NVIDIA Switchyard) plugs in
  underneath whichever engine you run.
- **Capability-gated UI**: surfaces an engine cannot serve are hidden, not
  broken — with Claude/Codex active, settings collapse to Cody's own tabs
  and omp-only composer controls disappear.
- **Adding engines**: one adapter per engine. The contract and checklist
  (Cline, Cursor, …) live in [docs/harnesses.md](docs/harnesses.md).
- Experimental engines run non-interactively with file edits auto-accepted
  inside the workspace, and their transcript history is session-local (no
  replay across server restarts yet).

## User accounts

A themed login screen, self-service signup, per-account profiles with
pictures, and per-account chat sessions. The first human account becomes the
administrator; admins manage the roster, roles, signup policy
(`CODY_ALLOW_SIGNUP=0` restricts creation to admins) and the engine.
Passwords are scrypt-hashed on disk; browser sessions are signed cookies.
Setting `CODY_PASSWORD` additionally enables the built-in `cody` account,
which also answers HTTP Basic Auth for scripts and health probes.

Outside the container, auth is off until the first account exists (the
local-dev default); in the container, `CODY_REQUIRE_ACCOUNTS=1` (set by the
entrypoint) locks a fresh instance down to first-run setup from the very
first request. None of this encrypts traffic — remote use needs HTTPS via a
reverse proxy or a VPN.

## SSH into the container

Set `CODY_SSH_PASSWORD` (or put public keys in
`/data/home/.ssh/authorized_keys`) and map port `2222` — without credentials
the daemon never starts. Interactive logins land **directly in the active
engine's CLI**; exiting the engine drops to a normal shell instead of
closing the connection (`CODY_NO_AUTO_ENGINE=1` skips straight to a shell).
SSH shares the persistent `/data/home` with the web terminals — same engine
sign-in state, history, and dotfiles — and host keys persist across image
updates.

## Features

- **Pick work back up**: browse previous conversations by project without digging through terminal history or session paths.
- **Try different directions safely**: continue from an earlier message or fork a session into a separate route.
- **Keep the sidebar tidy**: archive an inactive session without deleting its native transcript, or delete it explicitly when it is no longer needed.
- **Work across branches**: switch Git worktrees from the sidebar so new sessions and the Explorer follow the checkout you choose.
- **Chat beside the project**: browse files on the left and preview source, docs, images, audio, and PDFs on the right while the agent works.
- **Use a real terminal in the workspace**: each newly created xterm starts in the active engine CLI, then becomes a persistent plain shell when the engine exits; reconnect, resize, clipboard, and configurable mobile soft keys are built in.
- **A full workspace panel**: Files, Git (status, diffs, staging, commits), Terminal, Tasks (`.cody/tasks.json`), Updates, Info — plus workspace checkpoints and an embedded app preview with detach.
- **See what the agent builds, live**: when the assistant starts a local dev server, the embedded preview opens automatically once its URL answers — and on omp the agent can open it deliberately with the `open_preview` tool.
- **The agent sees its own work**: a `preview_screenshot` tool renders the app in a bundled headless Chromium on the server, so the model can screenshot what it built, look at the image, and iterate — the screenshot shows up right in the chat, and a camera button on the Preview panel attaches one to your next message.
- **The agent reads its app's console**: the preview Chromium's uncaught exceptions, `console.error` output, failed fetches and 4xx/5xx responses are captured into a bounded per-session ring, and a `read_app_logs` tool hands the model a deduped digest — a render loop logging thousands of identical lines arrives as one entry with a count. When something new breaks, a single line is appended to the next preview tool result rather than streaming logs into the conversation.
- **Streaming that reads like typing, not teleporting**: replies render through a buffered reveal that absorbs token bursts and stalls into a steady cadence — tool-call boxes and their streaming input included — with shipped defaults and a `/dev/stream-tuner` playground for retuning the feel.
- **See session state clearly**: context usage, cost, compaction state, and system prompt details in the top bar (engine-dependent), plus an icon-only context ring in the composer that shifts color as usage crosses thresholds and clicks open to a compact summary of used/available/limit, token traffic, and models used.
- **Configure less from the terminal**: models, provider auth, native omp controls (advisor, approvals, thinking, compaction, memory, retry/fallback), skills, plugins, and project MCP servers — all from Settings when the engine supports them.
- **Discover skills in-app**: search the public [skills.sh](https://skills.sh) registry from Settings and install skills into your project or user scope without leaving the workspace.
- **Stay current in-app**: version checks and one-click updates for the engine; Cody itself updates with the container image.
- **Stay informed**: browser notifications when an agent finishes; skill update checks.
- **Jump anywhere with ⌘K**: a command palette for switching sessions, starting new ones, and toggling the theme.
- **Pick a look that suits you**: twenty theme families inspired by popular editor colorways, each with paired light/dark variants, on a token-driven UI kit with WCAG AA-verified contrast; English, 简体中文 and 日本語 UI.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PORT` | Server port (default `30177`; `-p/--port` wins) |
| `CODY_HOSTNAME` | Bind hostname (default `127.0.0.1`; `-H/--hostname` wins; the container binds `0.0.0.0`) |
| `CODY_PASSWORD` | Optional password for the built-in `cody` account (login screen and HTTP Basic Auth) |
| `CODY_REQUIRE_ACCOUNTS` | `1` forces auth on even with zero accounts (fresh instance shows only first-run setup; the Docker entrypoint sets this) |
| `CODY_ALLOW_SIGNUP` | Set `0` to hide "Create an account" on the login screen (admins can still add accounts) |
| `CODY_ALLOW_NO_AUTH` | `1` disables the container's account lock — only behind an authenticating reverse proxy |
| `CODY_SSH_PASSWORD` / `CODY_SSH_PORT` | Enable SSH into the container / change its port (default `2222`) |
| `CODY_HARNESS` | Deployment-default engine before anyone picks in the UI (default `omp`; the persisted UI choice wins) |
| `CODY_TOOLS_DIR` | Persistent prefix for UI-installed engines (default `<agent dir>/tools`) |
| `CODY_OMP_BIN` / `CODY_CLAUDE_BIN` / `CODY_CODEX_BIN` | Absolute path overrides for engine binaries |
| `CODY_ACCOUNTS_DIR` | Where user accounts are stored (default `<agent dir>/cody-accounts`) |
| `PI_CODING_AGENT_DIR` | The instance data dir (default `~/.omp/agent`; `/data/agent` in the container) |
| `CODY_NO_OPEN` | Set to `1`/`true` to skip auto-opening the browser |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Standard proxy variables for server-side requests |

Every `CODY_` variable also accepts its pre-fork `OMP_WEB_` spelling, so an
existing ompweb setup keeps working after upgrading; browser preferences are
migrated from ompweb's storage keys on first load.

## Security notes

- Bare-metal Cody binds `127.0.0.1` by default; non-loopback exposure is an explicit opt-in for trusted networks only. Cody is not safe to expose publicly without HTTPS in front.
- The web perimeter: unauthenticated pages redirect to `/login`, APIs answer 401, and the terminal WebSocket enforces the same credentials plus same-origin upgrades.
- File APIs are allow-listed to the selected workspace, its valid Git worktrees, session-referenced directories, and explicitly selected roots; paths are canonicalized against traversal and symlink escapes.
- Browser terminals (and SSH, if enabled) execute as the container's user with full access to `/data` and `/workspace` — scope those mounts deliberately.
- Experimental engines auto-accept file edits inside the workspace while a turn runs.

## Architecture

Cody is a Node-hosted Next.js app that drives an installed engine binary — it embeds no agent:

- **The engine seam** (`lib/harness/`): an adapter per engine — identity, capability flags, binary probing, install spec, and a live-session factory. Runtime selection is persisted in the instance data dir; capability flags gate every engine-specific surface.
- **omp sessions**: spawns `omp --mode rpc-ui` (NDJSON over stdio), one child per active session, negotiating RPC v2 with bounded chunk reassembly when available. Session history is omp's native JSONL, read directly and maintained (title/archive/delete) without racing live writes.
- **Claude Code / Codex / Hermes sessions**: one long-lived process per session speaking the [Agent Client Protocol](https://agentclientprotocol.com) over stdio, translated server-side into the same event stream the UI renders. ACP is the only transport here with a real approval channel, so these engines can stop mid-turn and ask; abort cancels the turn, and resume uses the engine's native session id. The agent's own permission mode (Claude's Manual / Accept edits / Plan / Auto, Codex's approval levels, Hermes' Default / Accept Edits / Don't Ask) is a picker in the composer, next to the model.
- **Engine install/update**: npm against a persistent prefix the runtime resolves first — install and update are the same operation, and updating the active engine restarts its live sessions.
- **omp configuration surfaces**: models/`models.yml`, allow-listed `config.yml` settings, skills discovery, `omp plugin`, and project MCP servers (`.omp/mcp.json`) — all through the binary or its native files, all capability-gated.
- **Terminals**: a custom Node launcher serves Next.js and same-origin terminal WebSockets on one port; each tab owns a server-side `node-pty` shell that survives browser disconnects.
- **Accounts**: JSON store + scrypt hashes beside the rest of the instance state; session privacy via an ownership sidecar keyed by session id, engine-agnostic.

## Development

```bash
npm install
npm run dev
```

The local dev server runs at [http://127.0.0.1:30178](http://127.0.0.1:30178).

Common checks:

```bash
npm run typecheck      # type check
npm run lint           # ESLint (zero warnings enforced)
npm test               # run test suite
npm run build          # production build
```

Avoid running `next build` / `npm run build` during local development. It writes to `.next/` and can interfere with the dev server; leave builds for release work.

## Internationalization

Cody supports English, Simplified Chinese (简体中文), and Japanese (日本語) with translated UI strings across all three languages. The language is auto-detected from `navigator.language` and can be switched at runtime from Settings. The choice persists across sessions.

- Dictionaries: `lib/i18n/locales/{en,zh-CN,ja}.json`
- Framework: `lib/i18n/index.tsx` — a lightweight store built on `useSyncExternalStore` with `{var}` interpolation and plural support (`.one`/`.other`)
- API error messages are translated via stable error codes (`errors.<code>`) looked up client-side

## Quality

- **Accessibility**: WCAG AA compliant — Lighthouse a11y score 100/100, keyboard navigation throughout, focus-visible rings, ARIA roles
- **Performance**: memoized list components, RAF-gated scroll/mouse handlers, debounced search, streaming JSONL reader, ETag-cached session listing
- **Resilience**: graceful shutdown of spawned engine processes (process-group kill), error boundaries, atomic state-file rewrites
- **Tests**: 450+ tests covering session parsing, the auth system, the engine seam and stream translators, terminal input, markdown rendering, native settings, and MCP configuration; CI smoke-tests the container's full first-run flow (locked boot → admin signup → in-app engine install) before any image is published

## Credits

Cody is a fork of [kahme247/ompweb](https://github.com/kahme247/ompweb) (MIT) — join the [OMPWEB Discord](https://discord.gg/evqgGzRfM5) for the upstream project.

ompweb is itself a fork of [agegr/pi-web](https://github.com/agegr/pi-web) (MIT), the web UI for the [earendil/pi-mono](https://github.com/earendil-works/pi) pi coding agent, adapted for [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).

## License

MIT
