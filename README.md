# Cody

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

Cody is a self-hosted web workspace for coding agents. The interface — session browsing, real-time chat, files, git, persistent terminals, settings — stays constant while the **engine** underneath is swappable: [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) is the founding, fully-featured engine, with Claude Code and Codex available as experimental engines you can install and switch to from the UI (see [docs/harnesses.md](docs/harnesses.md)). The container ships with everyday dev tools (git, `gh`, python3, ripgrep, jq) and optional SSH access that lands directly in the active engine's CLI.

Cody is a fork of [kahme247/ompweb](https://github.com/kahme247/ompweb) — see [Credits](#credits).

![Cody — light theme](docs/screenshot-light.png)

<details>
<summary>Dark theme</summary>

![Cody — dark theme](docs/screenshot-dark.png)

</details>

## Requirements

- [omp](https://github.com/can1357/oh-my-pi) installed and on your `PATH` (or point `CODY_OMP_BIN` at the binary)
- Node.js 22.19.0 or newer (`node --version`)

## Quick Start

**Run without installing:**

```bash
npx @nphil/cody@latest
```

**Or install globally:**

```bash
npm install -g @nphil/cody
cody
```

Then open [http://127.0.0.1:30177](http://127.0.0.1:30177). The CLI will try to open the browser automatically after the server is ready. Cody listens on `127.0.0.1` by default.

**Options:**

```bash
cody --port 8080              # custom port
cody --hostname 0.0.0.0       # expose on a trusted network
cody -p 8080 -H 0.0.0.0       # combine options
cody --no-open                # do not open the browser automatically

PORT=8080 cody                # environment variable is also supported
CODY_HOSTNAME=0.0.0.0 cody    # explicit network exposure
CODY_PASSWORD='a-long-random-password' cody # require Basic Auth (username: cody)
CODY_NO_OPEN=1 cody           # useful when running as a background service
```

Cody has a user account system: a themed login screen, self-service signup (the first human account becomes the administrator), per-account profiles with pictures, and per-account chat sessions. Setting `CODY_PASSWORD` enables the built-in `cody` account — it signs in on the login screen and still works as HTTP Basic Auth for scripts and health probes. With neither a password nor any created account, authentication is off (the local-dev default); creating the first account turns it on, and `CODY_REQUIRE_ACCOUNTS=1` (which the Docker entrypoint sets) closes even that zero-account window so a fresh container only offers the first-run setup screen. None of this encrypts traffic, so remote use still requires HTTPS through a trusted reverse proxy or VPN.

### Security and troubleshooting

- The server binds to `127.0.0.1` by default. A non-loopback hostname is an explicit opt-in and should only be used behind a trusted network boundary; Cody is not safe to expose publicly.
- File APIs are allow-listed to the selected workspace, its valid Git worktrees, session-referenced directories, and explicitly selected roots. Paths are canonicalized to reject traversal and symlink escapes.
- Browser terminals can execute anything the Cody server account can execute. They are restricted to allow-listed workspace roots, require the same authentication as the rest of the app, and reject cross-origin WebSocket upgrades.
- `omp` is resolved from `CODY_OMP_BIN` first, then `PATH`. If live chat cannot start, run `omp --version` in the same terminal or set `CODY_OMP_BIN` to the executable's absolute path.
- Session history remains native OMP JSONL. OMP owns live-session writes; Cody reads the files directly and only performs explicit title, archive, and delete maintenance when it is not racing a live OMP write.
- Session archive uses OMP's native `archive/sessions/<cwd>/<file>.jsonl.gz` layout and moves sibling artifacts with the transcript; the original JSONL bytes are preserved inside the gzip.

## Features

- **Pick work back up**: browse previous omp conversations by project without digging through terminal history or session paths.
- **Try different directions safely**: continue from an earlier message or fork a session into a separate route.
- **Keep the sidebar tidy**: archive an inactive session without deleting its native transcript, or delete it explicitly when it is no longer needed.
- **Work across branches**: switch Git worktrees from the sidebar so new sessions and the Explorer follow the checkout you choose.
- **Chat beside the project**: browse files on the left and preview source, docs, images, audio, and PDFs on the right while the agent works.
- **Use a real terminal in the workspace**: open multiple persistent xterm sessions in the right panel for shells and TUIs such as `vim`, `lazygit`, `htop`, and `omp`, with reconnect, resize, clipboard, and mobile soft-key support.
- **A full workspace panel, pi-web style**: the right panel is a tabbed toolset — Files, Git, Terminal, Tasks, Updates, Info. The Git tab shows branch, ahead/behind, the changed-file list and per-file diffs (read-only); Tasks runs commands from `.cody/tasks.json` into persistent terminals; Updates consolidates Cody/OMP/skills update checks; Info shows versions and workspace diagnostics with one-click copy.
- **See session state clearly**: context usage, cost, compaction state, and system prompt details are visible from the top bar.
- **Configure less from the terminal**: manage models, login/API keys, model tests, native OMP controls (advisor, approval, Bash policy, thinking, compaction, memory, auto-learn, retry/fallback), skills, plugins, and project MCP servers from the web UI.
- **MCP management in Settings**: a dedicated MCP tab lists installed project servers with status (enabled / disabled / invalid), supports add/edit/rename/validate/remove, and surfaces configuration failures as corner toasts.
- **Keep OMP current**: check the installed runtime version, update it, and restart active sessions from Settings when needed.
- **Stay informed**: opt into browser notifications when an agent finishes, and check installed skills for updates.
- **Jump anywhere with ⌘K**: a command palette (⌘K / Ctrl+K) for switching sessions, starting new ones, and toggling the theme.
- **Pick a look that suits you**: ten theme families, each with a paired light and dark variant, built on a token-driven UI kit (Base UI primitives, cmdk, lucide icons) with WCAG AA-verified contrast.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PORT` | Server port (default `30177`; `-p/--port` wins) |
| `CODY_HOSTNAME` | Bind hostname (default `127.0.0.1`; `-H/--hostname` wins) |
| `CODY_PASSWORD` | Optional password for the built-in `cody` account (login screen and HTTP Basic Auth) |
| `CODY_REQUIRE_ACCOUNTS` | `1` forces auth on even with zero accounts (fresh instance shows only first-run setup; the Docker entrypoint sets this) |
| `CODY_ALLOW_SIGNUP` | Set `0` to hide "Create an account" on the login screen (admins can still add accounts) |
| `CODY_ACCOUNTS_DIR` | Where user accounts are stored (default `<agent dir>/cody-accounts`) |
| `CODY_NO_OPEN` | Set to `1`/`true` to skip auto-opening the browser |
| `CODY_OMP_BIN` | Absolute path to the `omp` binary when it is not on `PATH` |
| `PI_CODING_AGENT_DIR` | Point at another omp agent directory (default `~/.omp/agent`) |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Standard proxy variables for server-side requests |

Every `CODY_` variable above also accepts its pre-fork `OMP_WEB_` spelling (`OMP_WEB_PASSWORD`, `OMP_WEB_OMP_BIN`, …), so an existing ompweb setup keeps working after upgrading. When both are set, the `CODY_` name wins. Browser-side preferences are likewise migrated from ompweb's storage keys the first time Cody loads, so theme, language, sidebar width and the rest carry over.

## Architecture

Cody is a Node-hosted Next.js app that drives your installed `omp` binary — it does not embed the agent:

- **Live sessions**: spawns `omp --mode rpc-ui` (NDJSON over stdio), one child process per active session, so the agent version is always exactly what you have installed. It negotiates RPC v2 when the installed OMP advertises it, uses bounded chunk reassembly for large frames, and falls back to v1 for older versions.
- **Session browsing**: reads omp's session files (`~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`) directly; title, archive, and delete are narrow native-file maintenance operations guarded against live OMP writes.
- **Models and auth**: RPC commands against the omp child process; the Models panel edits `models.yml` in the omp agent directory.
- **Native settings**: the General/MCP settings panels read and write the allow-listed subset of `~/.omp/agent/config.yml` (or `config.yaml` fallback), preserving unrelated keys and comments. Changes apply to new and restarted sessions.
- **Skills and plugins**: scans omp's skill directories (`~/.omp/agent/skills`, project `.omp/skills`, and compat dirs) and shells out to `omp plugin` for plugin management.
- **MCP servers**: project servers are managed through OMP's native locations (`.omp/mcp.json`, then compatibility files) at the git top level, validated against the stdio/http/sse schema and written atomically.
- **File access**: file browsing and preview are scoped to the selected project directory and working directories that appear in sessions.
- **Terminal sessions**: the custom Node launcher serves Next.js and same-origin terminal WebSockets on one port. Each tab owns a server-side `node-pty` shell in an authorized workspace; shells survive browser disconnects until explicitly closed or the Cody server shuts down.
- **Forks vs in-session branches**: Fork creates a new `.jsonl` file. "Edit from here" creates another branch inside the same session file.

## Self-hosting and engines

`docker/` packages Cody engine-free for home servers; `docs/unraid.md`
walks through the Unraid deployment (template included). The engine is
chosen at onboarding (or later in Settings → User Accounts → Agent engine):
omp, Claude Code and Codex all install on demand into a persistent prefix
that survives image updates, and each updates independently from the same
card. Engine credentials are the engine's own — run `claude` or
`codex login` once in a Cody terminal, or set `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` on the container. The adapter contract and the checklist
for adding more engines (Pi, Cline, …) live in `docs/harnesses.md`.

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

Cody supports English, Simplified Chinese (简体中文), and Japanese (日本語) with translated UI strings across all three languages. The language is auto-detected from `navigator.language` and can be switched at runtime via the language menu in the top bar. The choice persists across sessions.

- Dictionaries: `lib/i18n/locales/{en,zh-CN,ja}.json`
- Framework: `lib/i18n/index.tsx` — a lightweight store built on `useSyncExternalStore` with `{var}` interpolation and plural support (`.one`/`.other`)
- API error messages are translated via stable error codes (`errors.<code>`) looked up client-side

## Quality

- **Accessibility**: WCAG AA compliant — Lighthouse a11y score 100/100, keyboard navigation throughout, focus-visible rings, ARIA roles
- **Performance**: memoized list components, RAF-gated scroll/mouse handlers, debounced search, streaming JSONL reader, ETag-cached session listing
- **Resilience**: graceful shutdown of spawned omp processes (process-group kill), error boundaries, atomic session file rewrites
- **Tests**: a focused test suite covering session parsing, terminal input, markdown rendering, message display, native settings, and MCP configuration

## Credits

Cody is a fork of [kahme247/ompweb](https://github.com/kahme247/ompweb) (MIT) — join the [OMPWEB Discord](https://discord.gg/evqgGzRfM5) for the upstream project.

ompweb is itself a fork of [agegr/pi-web](https://github.com/agegr/pi-web) (MIT), the web UI for the [earendil/pi-mono](https://github.com/earendil-works/pi) pi coding agent, adapted for [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).

## License

MIT
