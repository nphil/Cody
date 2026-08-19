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
  (new image → Apply Update), while **engines** update in-app — Settings ›
  System & Updates checks every installed engine and offers an Update action
  when a newer version is known (updating the active engine restarts its
  live sessions). Engine updates go to `/data/agent/tools`, so they stick
  across container recreates and never require a new image.
- The agent **engine** is chosen in the UI: a one-time picker after the
  first admin signs in, and later under Settings → User Accounts → Agent
  engine (install and switch; updates live in System & Updates). No engine
  ships in the image — omp, Claude Code and Codex all install on demand
  into `/data/agent/tools`, which survives image updates. Claude/Codex
  sign-in state lives under `/data/home` — run `claude` or `codex login`
  once in a Cody terminal, or pass `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
  as extra container variables. See `docs/harnesses.md`.
- omp is a **Bun** program (`engines: bun >= 1.3.14`), so the image carries the
  Bun binary alongside Node. Installing omp with npm onto a Node-only image
  looks like it works and then fails at every invocation with
  `env: 'bun': No such file or directory`.
- PID 1 in the container is **tini**, not Node. Node reaps only the children it
  spawned itself, so anything the kernel reparents onto it — a browser helper
  whose parent died, the far side of a kill — would stay a zombie for the life of
  the container, holding a PID slot that no `pkill` can free. `entrypoint.sh`
  hands PID 1 to tini and re-execs itself as tini's child; `docker stop` still
  reaches Node's graceful shutdown, because tini forwards SIGTERM to it. This is
  done in the script rather than in the image's `ENTRYPOINT` deliberately: if you
  enable Unraid's built-in **Tailscale** integration for this container, Unraid
  adds `--entrypoint='/opt/unraid/tailscale'` when it creates it, which discards
  the image's own `ENTRYPOINT` entirely. The hook then execs `entrypoint.sh`, so
  the arrangement survives — but an `ENTRYPOINT`-based init would not, and would
  fail silently.

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

The streamed preview rung runs a Chromium inside the container and ships frames
over Cody's WebSocket. By default that is software all the way through: the CPU
rasterizes the page *and* encodes every frame as JPEG. Passing a GPU in moves
rasterization onto the GPU and, on Intel, unlocks the hardware H.264 encoder,
which is the larger win of the two — it is what turns a 33 Mbit/s JPEG stream
into a few hundred kbit/s of video.

Nothing needs installing in the container — the image already carries the Intel
VAAPI userspace (iHD driver, libva, `vainfo`, about 15MB), the native EGL entry
point Chromium's ANGLE backend needs, and the encode/capture toolchain the video
path uses: `ffmpeg` with `h264_vaapi`, a headless `weston` plus `Xwayland` for
Chromium to render into with hardware rasterization intact, and `Xvfb` as the
software fallback display — 190MB in total.

All of this is opt-in. With no GPU passed through the container behaves exactly
as it always has, and says so once at startup:

```
[Cody] GPU: no passthrough devices — previews use software rendering
[Cody] GPU: X display backends: xvfb (strongest first)
[Cody] GPU: no hardware H.264 (no DRM render node) — previews stream JPEG
```

### Intel QuickSync / VAAPI — the primary path

One template field, under **Show more settings**:

| Field | Value |
| --- | --- |
| GPU Device | `/dev/dri` |

That field is a **Device** entry in the container template — value `/dev/dri`,
which Unraid turns into `--device=/dev/dri` on the `docker run` line. Pass the
whole directory, not a single `renderD…` node: Chromium enumerates the
directory, and the node numbering is host-specific (see below), so a template
that names one node keeps working right up until a driver update or a new card
renumbers it. Apply, and the container recreates with the device attached.
Nothing else changes.

**Which node is the Intel one?** `renderD128` is *not* a reliable answer. The
numbers are assigned in device-probe order, so on a box with a discrete card the
iGPU can land on `renderD129` or higher — on the owner's host `renderD128` is an
NVIDIA Tesla P40 and `renderD129` is the Intel UHD 630. Ask sysfs, from any
shell on the host or in the container:

```bash
for d in /sys/class/drm/render*/device; do echo "$d $(cat $d/vendor)"; done
```

Run inside the container and the answer covers the whole host, because `/sys` is
the host's — on the owner's box that prints `renderD128 0x10de` and
`renderD129 0x8086` even though only `renderD129` is passed in. (`card*/device`
works too and reports the same vendor ids, but the glob also matches connector
directories like `card1-HDMI-A-1` that have no `vendor` file.)

`0x8086` is Intel, `0x1002` AMD, `0x10de` NVIDIA. Cody does the same lookup at
startup, prefers an Intel/AMD node over an NVIDIA/unknown one no matter what
order the kernel listed them in, and logs every node it found with its vendor —
so you can pass all of `/dev/dri` and let it choose:

```
[Cody] GPU: DRM render nodes: renderD128 NVIDIA, renderD129 Intel
[Cody] GPU: Intel render node /dev/dri/renderD129 — previews render with GPU rasterization
```

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

1. **The container log**, on the Docker tab. Four lines name what was found,
   which node was chosen, which display backend will host the page, and whether
   the video path is available (substitute your own node number — see above, it
   is host-specific):

   ```
   [Cody] GPU: DRM render nodes: renderD128 NVIDIA, renderD129 Intel
   [Cody] GPU: Intel render node /dev/dri/renderD129 — previews render with GPU rasterization
   [Cody] GPU: X display backends: xwayland,xvfb (strongest first)
   [Cody] GPU: h264_vaapi encode on /dev/dri/renderD129 — previews stream H.264
   ```

   The backend list is ordered strongest first and is what the streamed preview
   walks down: `xwayland` is Xwayland on a headless weston, which keeps hardware
   rasterization; `xvfb` is the software-rasterized fallback; an empty list means
   the preview renders headless and streams JPEG. A rung that fails to start at
   session time falls through to the next one, so the worst case is a slower
   preview, never a broken one.

   When the last line instead reads `no hardware H.264 (…) — previews stream
   JPEG`, the parenthesis is the reason: `no DRM render node`, `NVIDIA render
   node, and VAAPI encode needs Intel or AMD`, `no X display backend to
   capture`, `this ffmpeg has no h264_vaapi encoder`, or `Intel VAAPI driver
   exposes no H.264 encode entrypoint`. It is a statement of configuration, not
   a failure — previews keep working on the JPEG path.

2. **VAAPI**, from a Cody terminal. This is the check that proves QuickSync is
   reachable, and it must name the `iHD` driver:

   ```bash
   vainfo --display drm --device /dev/dri/renderD129
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

3. **Hardware H.264**, from a Cody terminal. `vainfo` says the entry point
   exists; this proves ffmpeg can actually drive it. It writes three seconds of
   synthetic video and should take well under a second:

   ```bash
   ffmpeg -f lavfi -i testsrc2=size=1280x800:rate=30 -t 3 \
     -vaapi_device /dev/dri/renderD129 -vf 'format=nv12,hwupload' \
     -c:v h264_vaapi -f h264 /tmp/x.h264
   ```

   The proof of hardware use is in ffmpeg's own log, not in the file appearing:

   ```
   [h264_vaapi] Using VAAPI profile VAProfileH264High (7).
   [h264_vaapi] Using VAAPI entrypoint VAEntrypointEncSliceLP (8).
   [h264_vaapi] RC mode: CQP.
   frame=   90 fps=0.0 q=-0.0 Lsize=    2766kB time=00:00:03.00 bitrate=7552.4kbits/s speed=13.2x
   ```

   `speed=13.2x` at 1280x800 is the iGPU; a software fallback cannot reach it.
   Measured on the owner's UHD 630 the same test runs 2.97x realtime at
   2560x1600 and 1.27x at 3840x2400, and the driver refuses anything larger than
   4096x4096 outright (`Hardware does not support encoding at size 5120x3200
   (constraints: width 32-4096 height 32-4096)`).

4. **NVIDIA**, if you configured it:

   ```bash
   nvidia-smi
   ```

   `nvidia-smi` is provided by the host driver through the NVIDIA runtime, not by
   this image, so its presence is itself the proof the runtime is wired up.

5. **Open a preview** and look at the log again. When Chromium reaches real
   hardware it prints the GL renderer it got:

   ```
   [Cody] display: GPU rasterization on /dev/dri/renderD129 — ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 ...)
   ```

   If the GPU stack is broken, that line is replaced by a downgrade line and the
   preview keeps working on the software path — a broken driver costs you a log
   line, never your preview:

   ```
   [Cody] display: GPU launch failed on /dev/dri/renderD129 (...) — falling back to software rendering
   ```

   Trust that renderer string rather than Chromium's own `chrome://gpu` table.
   Measured on this image with the GPU flags but no usable device, `chrome://gpu`
   reported *"Rasterization: Hardware accelerated"* while the renderer was
   actually `llvmpipe` — a CPU rasterizer wearing a hardware label. The renderer
   string has to mention `Intel`/`Mesa Intel` (or `NVIDIA`); `llvmpipe`,
   `swrast` or `SwiftShader` all mean software.

### What it buys, measured on this host

The passthrough is live on the owner's box (`/dev/dri/renderD129`, UHD 630), so
these are measurements rather than expectations.

**Rasterization.** Chromium reports
`ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL ES 3.2)` and
`rasterization: enabled_force`. A rAF-capped paint loop reached **59.4 fps at
2560x1600 and 59.4 fps at 2880x1800**, against **41.2 fps and 32.7 fps** for the
same page with `--disable-gpu` (SwiftShader). So the GPU removes the resolution
penalty entirely up to retina sizes: the software path degrades as the frame
grows, the hardware path does not.

**Encode.** With rasterization solved, bandwidth became the binding constraint —
JPEG at q90 costs 68.9 KB per frame at 2560x1600 (33.5 Mbit/s) and 82.2 KB at
2880x1800 (40 Mbit/s), every frame, forever, because JPEG has no notion of what
did not change. `h264_vaapi` on the same chip encodes a live animated page at
2560x1600/30 for **235–352 kbit/s** (2 s and 1 s keyframe intervals
respectively), and even a pathological full-frame-motion synthetic source stays
at 14.3 Mbit/s — under half the JPEG floor. That is roughly **100x less
bandwidth** for real UI content, at 2.97x realtime encode headroom.

The encoder on this generation has exactly one rate-control mode, CQP
(`vainfo` shows `VAEntrypointEncSliceLP` only, and the driver rejects CBR/VBR/
QVBR outright), so quality is set by a fixed QP rather than a target bitrate.
HEVC is decode-only here and there is no VP9 or AV1 encode at all, which is why
H.264 is the codec Cody streams.

**Why the video path needs weston.** Chromium has to render into an X display
for the encoder to capture raw frames, and the choice of X server decides
whether rasterization stays on the GPU. Measured here with the same page and the
same rAF paint loop, three ways:

| Display backend | Chromium's `glRenderer` | Paint fps | With capture+encode running |
| --- | --- | --- | --- |
| headless (the JPEG path) | `ANGLE (Intel, … UHD Graphics 630 (CFL GT2))` | 44.4 @2559x1456 | — |
| `Xvfb` | `ANGLE (Mesa/X.org, llvmpipe …)` | 34.7 @2559x1599 | 22.3 |
| `Xwayland` on headless `weston` | `ANGLE (Intel, … UHD Graphics 630 (CFL GT2))` | 60.2 @2559x1599 | 60.0 |

Xvfb has no DRI3, so Mesa falls back to the llvmpipe CPU rasterizer and the page
then competes with the capture for CPU. A headless weston renders through the
DRM render node itself — no DRM master and no `card` node required, which is
exactly the access `--device=/dev/dri` grants — and Xwayland on top of it hands
Chromium back DRI3. That rung holds the 60 Hz cap even while the encoder runs,
which is why it is preferred and Xvfb is only the fallback.

See `docs/streaming.md` for how the provider uses this.

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
