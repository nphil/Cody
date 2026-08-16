# Cody on Unraid

The `docker/` directory packages Cody together with the omp harness in one
container, built for exactly this deployment.

## Install the published image (recommended)

CI publishes `ghcr.io/nphil/cody:latest` (and a version tag) on every push to
`main`. Using the registry image — rather than a local build — is what makes
Unraid's **check for updates** work at all: Unraid compares your running
image's digest against the registry, and a locally-built image has no registry
side to compare with. Make the GHCR package public once (GitHub → Packages →
Cody → Package settings → Change visibility) or add registry credentials in
Unraid, then the normal update-and-apply flow works.

## Install the published image (recommended)

CI publishes `ghcr.io/nphil/cody:latest` (and a version tag) on every push to
`main`. Using the registry image — rather than a local build — is what makes
Unraid's **check for updates** work at all: Unraid compares your running
image's digest against the registry, and a locally-built image has no registry
side to compare against. Make the GHCR package public once (GitHub → Packages
→ Cody → Package settings → Change visibility) or add registry credentials in
Unraid, then the normal update-and-apply flow works.

## Build the image yourself (optional) yourself (optional)

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
