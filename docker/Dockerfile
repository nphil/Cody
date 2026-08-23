# syntax=docker/dockerfile:1.7
#
# Cody, engine-free — built for self-hosted deployments like Unraid. The image
# ships ONLY the workspace; coding engines (omp, Claude Code, Codex, …) are
# installed from the onboarding picker into the persistent /data tools prefix,
# where they update independently of this image.
#
#   docker build -f docker/Dockerfile -t cody:latest .
#   docker run -p 30177:30177 \
#     -v /path/to/appdata:/data -v /path/to/projects:/workspace cody:latest

FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
# node-pty compiles a native addon here; the full bookworm image carries the
# toolchain so the slim runtime below does not have to.
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

# The container doubles as the dev box the agent works in, so it carries a
# curated set of everyday tools on top of the slim Debian base (~120MB, plus
# Chromium's ~430MB and the encode/capture toolchain's 190MB — the two
# deliberately heavy passengers):
#   git/gh:            version control + GitHub CLI
#   python3(+pip/venv): scripts, tooling, agent-written code
#   ripgrep/jq:        search and JSON plumbing agents and humans both use
#   nano/less/unzip/zip: quality of life in SSH/terminal sessions
#   openssh-server:    direct SSH into the workspace (entrypoint-managed,
#                      only enabled when credentials are configured)
#   procps/curl:       healthcheck + debug
#   chromium/fonts:    headless renderer behind the preview_screenshot host
#                      tool, the Preview panel's capture button, and the
#                      zero-config streamed Preview provider — the agent
#                      seeing its own work is core product, and a post-hoc
#                      apt install would not survive image updates.
#                      Fonts cover what previews and screenshots must render
#                      faithfully: Latin metrics (liberation), CJK (Cody
#                      ships ja/zh-CN UIs and the owner's apps use them),
#                      and emoji.
#   libegl1/libegl-mesa0: GPU rasterization for the streamed preview, but only
#                      once the host passes /dev/dri in. ANGLE's gl-egl
#                      backend dlopens the NATIVE libEGL.so.1, which the slim
#                      base does not carry — Chromium's own bundled
#                      /usr/lib/chromium/libEGL.so is ANGLE's front-end, not a
#                      driver — so without these two the GPU flags are a
#                      silent no-op ("Could not dlopen native EGL:
#                      libEGL.so.1"). Mesa's DRI drivers (iris_dri.so, for the
#                      host's UHD 630) and libgbm/libdrm already arrive as
#                      chromium dependencies, so this is only the EGL entry
#                      point: 435KB.
#   libva + iHD:       Intel VAAPI userspace, so QuickSync is usable the
#                      moment passthrough is granted instead of after an image
#                      rebuild. intel-media-va-driver ships iHD_drv_video.so
#                      (covers Gen8+; the host's UHD 630 is Gen9.5) and is
#                      13.8MB of the 15.2MB this whole group costs — the
#                      driver IS the cost, and it is the part that makes
#                      hardware encode possible at all. vainfo is the
#                      diagnosis command docs/unraid.md tells the operator to
#                      run.
#   ffmpeg:            the H.264 encoder for the streamed preview. One
#                      subprocess per session, `-f x11grab` in and Annex-B
#                      H.264 out on a pipe, encoded by `h264_vaapi` on the
#                      passed-through iGPU. Deliberately NOT GStreamer: a byte
#                      stream on stdout is the whole contract, so there is no
#                      pipeline to negotiate, and the multi-quality fanout that
#                      makes GStreamer worth its plugin surface is for many
#                      viewers of one desktop, which Cody does not have.
#                      Debian's build is the one that matters here: measured
#                      `ffmpeg -encoders` on this image lists h264_vaapi (plus
#                      hevc/vp8/vp9/mjpeg_vaapi), and `-devices` lists x11grab,
#                      so no custom build is needed. It is also the single
#                      most expensive line in this file after Chromium: 86
#                      packages, 160.2 MiB measured, of which the ffmpeg
#                      package itself is only 0.7 MiB — the cost is Debian's
#                      dependency closure for libavfilter/libavcodec (libflite
#                      25.8, libcodec2 16.1, libx265 15.6, libavcodec 14.3,
#                      libavfilter 12.1, librsvg 10.6 MiB), none of which this
#                      pipeline touches. A `--disable-everything` build of just
#                      x11grab + h264_vaapi + the h264 muxer would be a
#                      fraction of that; it is a build-stage project, not a
#                      reason to reach for a second media framework.
#   weston + xwayland: the X display Chromium renders into and the encoder
#                      captures — the preferred one of two rungs, and the
#                      reason it exists is measured. Chromium against a bare
#                      Xvfb lands on llvmpipe, because Xvfb has no DRI3 for
#                      Mesa to accelerate through, and the container is given a
#                      render node but no card node so a real Xorg is not an
#                      option either. A headless weston renders through the
#                      render node itself (no DRM master, no card node) and
#                      Xwayland on top of it hands Chromium the DRI3 it needs.
#                      Measured, same page and same rAF paint benchmark:
#                      headless 44.4 fps and Xvfb 34.7 fps (llvmpipe) against
#                      60.2 fps here, with glRenderer naming
#                      "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL
#                      GT2))" — and under concurrent x11grab+h264_vaapi it
#                      holds 60.0 fps where the Xvfb rung falls to 22.3. So
#                      this is what keeps hardware rasterization AND hardware
#                      encode at the same time instead of trading one for the
#                      other. 25 packages, 27.1 MiB measured (weston 4.3,
#                      iso-codes 2.9, libgstreamer 2.7 + plugins-base 2.5,
#                      libspa 2.4, xwayland 2.3, …). The GStreamer and PipeWire
#                      libraries in that list arrive as libweston's
#                      remoting/screen-share plugin dependencies and nothing
#                      loads them: 5.3 MiB of shared objects, not a media
#                      framework in the pipeline.
#                      Xwayland must be spawned SEPARATELY, not via weston's
#                      `--xwayland` module: that one runs rootless, which
#                      leaves the X root window empty and makes x11grab capture
#                      pure black (measured: an all-zero frame from a display
#                      where Chromium was demonstrably rendering). Rooted
#                      Xwayland gives a real root drawable, and spawning it
#                      ourselves also pins the display number per session.
#   xvfb:              the fallback X display, for a host with no usable render
#                      node or a weston that will not start. Same capture and
#                      encode path, software rasterization. Chromium renders
#                      into either as a normal X client rather than headless,
#                      because a video encoder needs raw frames and CDP's
#                      Page.startScreencast only ever emits encoded JPEG/PNG.
#                      Capturing an X display is also how an X11 desktop or an
#                      Android emulator window gets streamed later: same
#                      provider, different process inside the display. 5
#                      packages, 3.0 MiB measured (xvfb 2.1, x11-xkb-utils
#                      0.5, libxfont2 0.2, libunwind8 0.2, xserver-common 0.1).
#                      Chromium's own X client libs (libx11, libxcb*,
#                      libxcomposite, libxdamage, libxrandr, libxkbcommon, …)
#                      already arrive as chromium dependencies, so nothing else
#                      is needed to run it against a display. Deliberately NO
#                      x11-xserver-utils: xrandr would be the only reason to
#                      want it and the encoder resizes by moving the capture
#                      rectangle inside a root window allocated at the session
#                      ceiling, while its xrdb hard-depends on cpp and would
#                      drag a 36.0 MiB C preprocessor into the image.
#                      Encode/capture group total: +190.3 MiB.
#   tini:              an init for PID 1. Node is not one: it reaps only the
#                      children it spawned itself, so anything that gets
#                      reparented onto it — a helper client whose parent died,
#                      the far side of a `kill -9` — becomes a permanent zombie
#                      that `pkill` cannot touch, because a zombie is already
#                      dead and only a `wait()` by PID 1 removes it. Measured in
#                      a live container after one evening of preview testing:
#                      533 processes in state Z, all with PPID 1, up to 2.5 hours
#                      old, each holding a PID-table entry for the life of the
#                      container. The display stack no longer produces such
#                      orphans (see docker/entrypoint.sh and
#                      lib/display/h264-provider.ts), but "no orphans" is a
#                      property of code we keep changing, while reaping is a
#                      property of the image — and it covers what is not ours:
#                      the same census found zombie dpkg, tailscale and engine
#                      processes. 749 kB measured, the whole cost of the group.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git gh curl wget ca-certificates procps openssh-client openssh-server \
    python3 python3-pip python3-venv \
    ripgrep jq nano less unzip zip \
    chromium fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
    libegl1 libegl-mesa0 \
    libva-drm2 intel-media-va-driver vainfo \
    ffmpeg xvfb weston xwayland \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /run/sshd

# No engine is baked in — but omp is a Bun program (`#!/usr/bin/env bun`,
# `engines: { bun: ">=1.3.14" }`), so the runtime that a picker-installed omp
# needs must already be here: npm installs it happily and then every
# invocation dies with "env: 'bun': No such file or directory" without Bun on
# PATH. Bun ships as a single static executable, so copying it out of the
# official image is enough — no second package manager, no install script.
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
RUN bun --version

# Same reasoning for uv: Hermes is a Python program on PyPI, so the picker
# installs it with `uv tool install` into Cody's persistent tools prefix
# (UV_TOOL_DIR / UV_TOOL_BIN_DIR). uv is a single static binary, so it is
# copied out of its official image rather than piping an installer to a
# shell — same trust model as bun above, and no third package manager.
# Pinned, not :latest — a floating base makes two builds of the same commit
# produce different images, and uv is on the critical path of installing an
# engine. Bump it deliberately, the way node:22-bookworm-slim is bumped.
COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /uvx /usr/local/bin/
RUN uv --version

ENV NODE_ENV=production \
  HOME=/data/home \
  PI_CODING_AGENT_DIR=/data/agent \
  CODY_HARNESS=omp \
  CODY_CHROMIUM_BIN=/usr/bin/chromium \
  PORT=30177 \
  TERM=xterm-256color

WORKDIR /app
COPY --from=build /app/package.json /app/next.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/bin ./bin
COPY --from=build /app/lib ./lib

COPY docker/entrypoint.sh /usr/local/bin/cody-entrypoint
RUN chmod 0755 /usr/local/bin/cody-entrypoint

# 30177 = WebUI (PORT env), 2222 = SSH (CODY_SSH_PORT env; the daemon only
# starts when CODY_SSH_PASSWORD is set or authorized keys exist — see
# entrypoint).
EXPOSE 30177 2222
VOLUME ["/data", "/workspace"]
# The container always runs with auth on (accounts are required from the
# first request), so an unauthenticated probe of / normally answers 307 or
# 401. Only a connection failure or a 5xx is unhealthy, so match on the
# status line rather than curl's --fail.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD sh -c 'code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/") && [ -n "$code" ] && [ "$code" -lt 500 ]' || exit 1

# Unchanged on purpose, even though tini now runs as PID 1: cody-entrypoint hands
# PID 1 to tini itself, on the one condition that it is PID 1 to begin with.
#
# Writing `ENTRYPOINT ["tini", "--", "cody-entrypoint"]` here is the obvious
# spelling and it is WRONG for this image, because this line is not always what
# runs. Unraid's native per-container Tailscale integration rewrites the entrypoint
# at create time: its rendered `docker create` carries
# `--entrypoint='/opt/unraid/tailscale'` alongside a bind mount of the hook, so the
# image's ENTRYPOINT is discarded and tini would silently never be PID 1 on the
# primary deployment. The hook execs cody-entrypoint, which is still PID 1, so the
# decision belongs there. See the comment on the re-exec in docker/entrypoint.sh
# before changing either line.
ENTRYPOINT ["cody-entrypoint"]
