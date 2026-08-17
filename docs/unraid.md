# Cody on Unraid

The `docker/` directory packages Cody together with the omp harness in one
container, built for exactly this deployment.

## Already running an omp-web container?

If you already have a container repository that bundles omp with omp-web,
there are two ways forward. Pick one deliberately — running both would give
you two images racing for the same appdata.

**A. Adapt your existing container repo** (least disruption). Keep its
Dockerfile, image name, Unraid template and update workflow; change only what
it installs for the UI: drop `@kahme247/ompweb` and install Cody instead
(from git — `npm ci && npm run build` — since Cody is not on npm yet), and
change the launch command from `ompweb` to `cody`. Your existing CA entry and
auto-update flow keep working untouched. Cody's own `docker/` and
`.github/workflows/docker.yml` then become redundant — ignore or delete them.

**B. Adopt Cody's packaging** (one repo owns the app and its image). Use the
image and template below and retire the old container. Cleaner long-term,
because packaging lives beside the code it ships, but you re-create the
container entry and its update wiring once.

Either way the engine must run **inside** Cody's container: Cody spawns it
as a child process over stdio and shares its filesystem (agent dir +
workspace), so they cannot live in separate containers. The engine itself
is not baked into the image — it installs from the onboarding picker into
`/data/agent/tools`, which persists across image updates.

## Install the published image (recommended)

CI publishes `ghcr.io/nphil/cody:latest` (and a version tag) on every push to
`main`. Using the registry image — rather than a local build — is what makes
Unraid's **check for updates** work at all: Unraid compares your running
image's digest against the registry, and a locally-built image has no registry
side to compare with. Make the GHCR package public once (GitHub → Packages →
Cody → Package settings → Change visibility) or add registry credentials in
Unraid, then the normal update-and-apply flow works.

### How an update reaches your server

Push to `main` → CI builds the image, smoke-tests it (the harness must run and
the server must answer) and republishes `:latest`, ~4–8 minutes → Unraid's
Docker page shows "update ready" the next time it checks, which is once a day
by default (Settings → Docker → *Check for updates*, or hit **Check for
Updates** on the Docker tab to poll immediately) → **Apply Update** pulls and
recreates the container, a few seconds of downtime.

Running the ShipLog plugin? It resolves this image to the Cody repo and shows
the repo's GitHub Releases as the changelog in the Docker tab. Cutting one is
a manual, deliberate act: dispatch `.github/workflows/docker.yml` with
`version: X.Y.Z` (no leading v) and `notes:` a human-readable changelog — CI
publishes the version-tagged image, creates the `vX.Y.Z` tag and the Release.
Plain pushes to main still republish `:latest` without a release entry.

So: a few minutes to a registry, then however long you let Unraid wait. Nothing
downstream needs a rebuild or a git pull; `/data` and `/workspace` are volumes,
so state and repositories survive the recreate. For hands-off updating, point
something like Watchtower at the container — but on a machine you rely on,
manual **Apply Update** is the safer default.

## Build the image yourself (optional)

On any machine with Docker (or on the Unraid box itself):

```bash
git clone https://github.com/nphil/Cody && cd Cody
docker build -f docker/Dockerfile -t cody:latest .
```

The image ships no engine, so there is nothing engine-related to pin at
build time — engine versions are managed at runtime from Settings → User
Accounts → Agent engine (Install/Update per engine).

## Install on Unraid

Copy `docker/unraid-template.xml` to
`/boot/config/plugins/dockerMan/templates-user/` on the flash share, then add
the container from the Docker tab ("Add Container" → template "Cody").

The template asks for:

| Setting | Meaning |
| --- | --- |
| WebUI Port | Host port for the interface (default 30177) |
| SSH Port | Host port for SSH into the container (container port 2222; inactive until SSH credentials are configured — see below) |
| App Data (`/data`) | Agent state, checkpoints, terminal shell home — keep on appdata |
| Projects (`/workspace`) | The share holding your repositories |
| SSH Password | Optional root password for SSH; leave empty for no SSH (or key-only via authorized_keys) |
| Password (optional, advanced) | Leave empty — first-run setup happens in the browser. Setting it additionally enables the built-in `cody` account over HTTP Basic Auth for scripts and probes. |
| Allow Account Signup | Leave empty to let the login screen offer "Create an account". Set `0` to restrict account creation to administrators. |
| Anthropic API Key | Optional provider credential for the agent; add other provider env vars the same way |

Then open the WebUI: a fresh instance shows the first-run setup screen where
you create your admin account, followed by the engine picker (keep omp, or
install Claude Code/Codex) and a one-time setup wizard — provider sign-ins,
local model endpoints, and a starter primer for the chosen engine. Add `/workspace/<your-project>` as a workspace
and everything — chat, Git panel, checkpoints, terminals, tasks, preview —
runs against the engine you chose.

### User accounts

The container is locked from its very first request: before any account
exists, the only reachable page is the first-run setup, and the person who
completes it becomes the administrator — so open the WebUI and claim the
instance right after starting the container. Further accounts come from the
login screen (unless signup is disabled) or from Settings → User Accounts.
Each account has its own profile — name, picture, password — and sees only
its own chat sessions; sessions from before accounts existed stay visible to
everyone. Account data lives in `/data/agent/cody-accounts` (passwords are
scrypt-hashed), so accounts survive image updates like the rest of appdata.
`CODY_ALLOW_NO_AUTH=1` disables the lock entirely — only for containers
behind an authenticating reverse proxy.

## Notes

- Neither the login cookie nor Basic Auth is encryption. Off your LAN, front
  it with a reverse proxy doing HTTPS (SWAG/NPM/Traefik) or reach it over a
  VPN/Tailscale.
- Terminals run as the container's user with full access to `/data` and
  `/workspace` — scope those mounts to what the agent should touch.
- Updating splits cleanly in two: **Cody itself** updates the Unraid way
  (new image → Apply Update), while the **engine** updates in-app — the
  Updates panel and the System tab check omp's version and offer "Update
  now", and Settings → User Accounts → Agent engine has Update per engine.
  Engine updates go to `/data/agent/tools`, so they stick across container
  recreates and never require a new image.
- The agent **engine** is chosen in the UI: a one-time picker after the
  first admin signs in, and later under Settings → User Accounts → Agent
  engine. No engine ships in the image — omp, Claude Code and Codex all
  install on demand into `/data/agent/tools`, which survives image updates,
  and each has an Update action in the same card (updating the active
  engine restarts its live sessions). Claude/Codex sign-in state lives
  under `/data/home` — run `claude` or `codex login` once in a Cody
  terminal, or pass `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` as extra
  container variables. See `docs/harnesses.md`.
- omp is a **Bun** program (`engines: bun >= 1.3.14`), so the image carries the
  Bun binary alongside Node. Installing omp with npm onto a Node-only image
  looks like it works and then fails at every invocation with
  `env: 'bun': No such file or directory`.

## SSH into the container

Set the **SSH Password** template variable (or drop public keys into
`appdata/cody/home/.ssh/authorized_keys` for key-only auth) and map the SSH
port (container `2222`). Without either credential the daemon never starts.

Connecting with Termius or plain `ssh root@server -p 2222` lands you
**directly in the active coding engine's CLI** (omp, claude, or codex —
whatever the instance's engine is). Exiting the engine drops to a normal
shell rather than closing the connection; `exit` again disconnects. To skip
the engine and go straight to a shell:
`ssh -o SetEnv=CODY_NO_AUTO_ENGINE=1 root@server -p 2222` (or run
`CODY_NO_AUTO_ENGINE=1 bash -l` in the session).

SSH sessions run as root with home at the persistent `/data/home`, the same
identity the web terminals use — so engine sign-in state, shell history and
dotfiles are shared, and the container's dev tools (git, `gh`, python3,
ripgrep, jq) are on PATH. Host keys persist in `appdata/cody/ssh`, so the
server identity survives image updates. The usual caveat applies: SSH here
is root on the container with full access to `/data` and `/workspace` —
keep the port on your LAN or behind a VPN.
