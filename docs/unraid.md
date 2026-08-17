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
| GPU Device (advanced) | Optional `/dev/dri` for Intel GPU acceleration — see [Hardware GPU acceleration](#hardware-gpu-acceleration-optional) |
| NVIDIA Visible Devices (advanced) | Optional, for an NVIDIA card; needs the Nvidia Driver plugin and `--runtime=nvidia` |
| NVIDIA Driver Capabilities (advanced) | Optional; must include `video` or hardware encode stays unavailable |

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

## Full-fidelity previews behind HTTPS (optional)

When the agent starts a dev server, the Preview panel embeds it. It picks the
best option that actually works, in this order:

1. **Direct** — a real iframe against the dev server's own origin. Free and
   automatic when Cody runs on the machine you are browsing from (the desktop
   shell, an on-device build, plain `npm run dev`). From another device it
   additionally needs the dev server bound to `0.0.0.0` rather than
   `127.0.0.1`, and Cody itself reached over plain HTTP — a browser blocks an
   `http://` iframe inside an `https://` page as mixed content.
2. **Gateway** — only when **Preview Domain** (`CODY_PREVIEW_BASE_URL`) is set.
3. **Streamed** — a server-side Chromium ships frames over Cody's own
   authenticated WebSocket. Always available, needs nothing of your network.

So if you reach Cody through a reverse proxy on HTTPS, previews land on the
streamed renderer: correct and interactive, but a video of the page rather than
the page. Setting **Preview Domain** restores a real iframe there. It needs a
wildcard you terminate TLS on — one DNS record and one proxy route:

- DNS: `*.preview.example.com` → your reverse proxy.
- A certificate covering `*.preview.example.com` (a `*.example.com` wildcard
  does **not** cover it — a wildcard matches exactly one label).
- A proxy route sending that wildcard to this container's WebUI port. Caddy,
  for instance: `*.preview.example.com { reverse_proxy cody-host:30177 }` with
  whatever DNS-01 issuer you already use.
- Template variable: `https://preview.example.com`.

Cody then mints a random single-use hostname under that domain per request and
reverse-proxies it to the dev server *from inside the container*, stripping
cookies and auth headers so the iframe never carries your Cody credentials. It
works even when the dev server listens only on loopback, since the proxy hop
happens container-side. Leave the variable empty and none of this machinery is
constructed — no listener, no route table, no change to the CSP.

The panel names the rung it chose: a badge in the preview subtitle bar, plus a
pill on first open. If it says **Streamed** when you expected **Direct**, the
dev server is almost always bound to `127.0.0.1` only.

## Hardware GPU acceleration (optional)

The streamed preview rung runs a headless Chromium inside the container and
ships JPEG frames over Cody's WebSocket. By default that is software all the
way through: the CPU rasterizes the page *and* encodes every frame. Passing a
GPU in moves rasterization onto the GPU and leaves the CPU to the encode.

Nothing needs installing in the container — the image already carries the Intel
VAAPI userspace (iHD driver, libva, `vainfo`) and the native EGL entry point
Chromium's ANGLE backend needs, about 15MB in total.

All of this is opt-in. With no GPU passed through the container behaves exactly
as it always has, and says so once at startup:

```
[Cody] GPU: no passthrough devices — previews use software rendering
```

### Intel QuickSync / VAAPI — the primary path

One template field, under **Show more settings**:

| Field | Value |
| --- | --- |
| GPU Device | `/dev/dri` |

Pass the whole `/dev/dri` directory, not a single `renderD128` node — Chromium
enumerates the directory. Apply, and the container recreates with the device
attached. Nothing else changes.

### NVIDIA NVENC — optional

Requires the Unraid **Nvidia Driver** plugin (which you already run):

| Field | Value |
| --- | --- |
| NVIDIA Visible Devices | `all`, or a GPU UUID from `nvidia-smi -L` |
| NVIDIA Driver Capabilities | `compute,utility,video` — or `all` |
| Extra Parameters | `--runtime=nvidia` |

**The one that bites:** `NVIDIA_DRIVER_CAPABILITIES` must contain `video`. The
value copied around most often is `compute,utility`, which silently omits NVENC
— the card shows up in `nvidia-smi`, everything looks configured, and hardware
encode is simply never offered, with no error naming the cause. Cody checks this
at startup and warns when it finds NVIDIA devices without `video`.

Without `--runtime=nvidia` in Extra Parameters, both variables do nothing at all.

### Verifying it worked

1. **The container log**, on the Docker tab. One line names what was found:

   ```
   [Cody] GPU: Intel render node /dev/dri/renderD128 — previews render with GPU rasterization
   ```

2. **VAAPI**, from a Cody terminal. This is the check that proves QuickSync is
   reachable, and it must name the `iHD` driver:

   ```bash
   vainfo --display drm --device /dev/dri/renderD128
   ```

   Expect `Driver version: Intel iHD driver ...` followed by a profile list, and
   look for an H.264 entry point beginning `VAEntrypointEnc` — `EncSliceLP` is
   the low-power VDENC encoder Gen9.5 uses. That line is the hardware encoder.
   `Failed to open the given device!` means the device did not actually reach the
   container; `vaInitialize failed` usually means it did, but the render node is
   not readable by the container's user.

   The image installs `intel-media-va-driver` from Debian main, not the
   `-non-free` variant, and that is deliberate rather than a compromise: the
   `+dfsg` repack strips only Xe-HPM/Xe-XPM (Arc, DG1) kernels and a profiling
   tool, so H.264 encode on Gen9.5 is entirely present.

3. **NVIDIA**, if you configured it:

   ```bash
   nvidia-smi
   ```

   `nvidia-smi` is provided by the host driver through the NVIDIA runtime, not by
   this image, so its presence is itself the proof the runtime is wired up.

4. **Open a preview** and look at the log again. When Chromium reaches real
   hardware it prints the GL renderer it got:

   ```
   [Cody] display: GPU rasterization on /dev/dri/renderD128 — ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 ...)
   ```

   If the GPU stack is broken, that line is replaced by a downgrade line and the
   preview keeps working on the software path — a broken driver costs you a log
   line, never your preview:

   ```
   [Cody] display: GPU launch failed on /dev/dri/renderD128 (...) — falling back to software rendering
   ```

   Trust that renderer string rather than Chromium's own `chrome://gpu` table.
   Measured on this image with the GPU flags but no usable device, `chrome://gpu`
   reported *"Rasterization: Hardware accelerated"* while the renderer was
   actually `llvmpipe` — a CPU rasterizer wearing a hardware label. The renderer
   string has to mention `Intel`/`Mesa Intel` (or `NVIDIA`); `llvmpipe`,
   `swrast` or `SwiftShader` all mean software.

### What it buys now, and what it buys later

**Now:** page rasterization and compositing move off the CPU, so the CPU that is
already JPEG-encoding every frame has less to do, and the frame-rate ceiling
rises. That ceiling is real — on this host the software path tops out well under
30 fps once the captured frame gets large.

**Later:** hardware H.264/AV1 *encode*. This is the bigger prize and it is not
available yet, because today's rung encodes JPEG through Chromium's CDP
screencast, which neither QuickSync nor NVENC accelerates. A codec-based
provider is what turns the GPU into a bandwidth and latency win; passing the
device through now is what lets that land as a config change rather than a
redeployment. See `docs/streaming.md`.

### NVENC concurrent sessions

One caveat specific to this deployment shape, worth knowing before you plan
around NVENC: consumer GeForce cards cap the number of **simultaneous NVENC
encode sessions** in the driver. That cap has been raised repeatedly — 2, then 3
(2020), 5 (2023), and 8 with Linux driver 550.54.14 or newer — and NVIDIA's
own SDK notes describe it as 8 **per system** on non-qualified GPUs. Data-center
and professional cards are unrestricted.

Two consequences. Cody is one container serving many sessions, so once a codec
provider exists each live streamed preview wants its own encode session and they
contend for that pool. And because the limit is per *system*, anything else on
the box using NVENC — Plex, Jellyfin, Frigate — draws from the same budget; a
GeForce card is a shared resource, not this container's to spend. Intel
QuickSync has no comparable session cap, which is the other reason it is the
documented default here.

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

The **New Terminal** action in Cody follows the same engine-then-shell flow,
but only for that newly created browser PTY. Cody's task runner, server
subprocesses, agent tool calls, and non-interactive SSH commands never pass
through the auto-engine wrapper and remain ordinary command processes.

SSH sessions run as root with home at the persistent `/data/home`, the same
identity the web terminals use — so engine sign-in state, shell history and
dotfiles are shared, and the container's dev tools (git, `gh`, python3,
ripgrep, jq) are on PATH. Host keys persist in `appdata/cody/ssh`, so the
server identity survives image updates. The usual caveat applies: SSH here
is root on the container with full access to `/data` and `/workspace` —
keep the port on your LAN or behind a VPN.
