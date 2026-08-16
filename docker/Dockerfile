# syntax=docker/dockerfile:1.7
#
# Cody bundled with an agent harness (omp by default) — built for self-hosted
# deployments like Unraid. The harness is a build argument: once another
# adapter exists in lib/harness, the same image recipe ships it by changing
# HARNESS_INSTALL_SPEC.
#
#   docker build -f docker/Dockerfile -t cody:latest .
#   docker run -p 30177:30177 -e CODY_PASSWORD=change-me \
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

# git: Git panel, checkpoints and worktrees. procps/curl: healthcheck + debug.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates procps openssh-client \
  && rm -rf /var/lib/apt/lists/*

# omp is a Bun program: its entrypoint is `#!/usr/bin/env bun` and the package
# declares `engines: { bun: ">=1.3.14" }`. npm installs it happily on a Node
# image and then every invocation dies with "env: 'bun': No such file or
# directory", so the runtime needs the Bun binary on PATH. Bun ships as a single
# static executable, so copying it out of the official image is enough — no
# second package manager, no install script.
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

# The bundled harness. @oh-my-pi/pi-coding-agent ships the `omp` binary.
# `omp --version` is the build's gate: it fails the image if the harness cannot
# actually run here (a Bun that is too old for its engines range, for one).
ARG HARNESS_INSTALL_SPEC=@oh-my-pi/pi-coding-agent@latest
RUN npm install -g --no-audit --no-fund "${HARNESS_INSTALL_SPEC}" \
  && npm cache clean --force \
  && bun --version \
  && omp --version

ENV NODE_ENV=production \
  HOME=/data/home \
  PI_CODING_AGENT_DIR=/data/agent \
  CODY_HARNESS=omp \
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

EXPOSE 30177
VOLUME ["/data", "/workspace"]
# 401 means the server is up and correctly demanding auth — the normal state,
# since the entrypoint requires a password. Only a connection failure or a 5xx
# is unhealthy, so match on the status line rather than curl's --fail.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD sh -c 'code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/") && [ -n "$code" ] && [ "$code" -lt 500 ]' || exit 1

ENTRYPOINT ["cody-entrypoint"]
