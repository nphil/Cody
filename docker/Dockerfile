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
# Chromium's ~430MB — the one deliberately heavy passenger):
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
#                      run. Deliberately NO ffmpeg and NO GStreamer: nothing
#                      in the app consumes them yet, and they would dwarf this.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git gh curl wget ca-certificates procps openssh-client openssh-server \
    python3 python3-pip python3-venv \
    ripgrep jq nano less unzip zip \
    chromium fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
    libegl1 libegl-mesa0 \
    libva-drm2 intel-media-va-driver vainfo \
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

ENTRYPOINT ["cody-entrypoint"]
