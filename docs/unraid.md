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

Either way the container must bundle **both** Cody and the harness: Cody
spawns `omp --mode rpc-ui` as a child process over stdio and shares its
filesystem (agent dir + workspace), so they cannot live in separate
containers.

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

Pin the bundled harness if you want reproducible images:

```bash
docker build -f docker/Dockerfile \
  --build-arg HARNESS_INSTALL_SPEC=@oh-my-pi/pi-coding-agent@17.3.5 \
  -t cody:latest .
```

## Install on Unraid

Copy `docker/unraid-template.xml` to
`/boot/config/plugins/dockerMan/templates-user/` on the flash share, then add
the container from the Docker tab ("Add Container" → template "Cody").

The template asks for:

| Setting | Meaning |
| --- | --- |
| WebUI Port | Host port for the interface (default 30177) |
| App Data (`/data`) | Agent state, checkpoints, terminal shell home — keep on appdata |
| Projects (`/workspace`) | The share holding your repositories |
| Password | Basic Auth password (username `cody`). The container refuses to start without one unless `CODY_ALLOW_NO_AUTH=1` is set — do that only behind an authenticating reverse proxy. |
| Anthropic API Key | Optional provider credential for the agent; add other provider env vars the same way |

Then open the WebUI, add `/workspace/<your-project>` as a workspace, and
everything — chat, Git panel, checkpoints, terminals, tasks, preview — runs
against the bundled omp.

## Notes

- Basic Auth is not encryption. Off your LAN, front it with a reverse proxy
  doing HTTPS (SWAG/NPM/Traefik) or reach it over a VPN/Tailscale.
- Terminals run as the container's user with full access to `/data` and
  `/workspace` — scope those mounts to what the agent should touch.
- The in-app "Updates" panel checks versions but self-update is disabled by
  design in a container: update by rebuilding the image (`docker build …`)
  and recreating the container, the Unraid way.
- `CODY_HARNESS` selects the agent adapter (`omp` today; see
  `docs/harnesses.md` for what adding Pi or another harness involves).
- omp is a **Bun** program (`engines: bun >= 1.3.14`), so the image carries the
  Bun binary alongside Node. Installing omp with npm onto a Node-only image
  looks like it works and then fails at every invocation with
  `env: 'bun': No such file or directory`.
