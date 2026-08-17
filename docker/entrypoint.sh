#!/bin/sh
set -eu

# Cody in a container listens on 0.0.0.0 — that is only safe behind auth.
# No password is needed up front: with CODY_REQUIRE_ACCOUNTS=1 the app locks
# every surface behind /login from the very first request, and a fresh
# instance shows only the first-run setup screen where the opener creates the
# admin account. CODY_PASSWORD stays optional (it adds the env-managed `cody`
# Basic Auth account for scripts). CODY_ALLOW_NO_AUTH=1 keeps the fully-open
# mode for containers behind an authenticating reverse proxy.
if [ "${CODY_ALLOW_NO_AUTH:-}" != "1" ]; then
  CODY_REQUIRE_ACCOUNTS=1
  export CODY_REQUIRE_ACCOUNTS
fi

mkdir -p "${HOME}" "${PI_CODING_AGENT_DIR}" /workspace

# Engines installed from the picker (claude, codex, …) land in a persistent
# npm prefix under /data so they survive image updates; put its bin dir on
# PATH ahead of the image's own so an updated engine wins over a stale
# preinstalled one.
CODY_TOOLS_DIR="${CODY_TOOLS_DIR:-${PI_CODING_AGENT_DIR}/tools}"
export CODY_TOOLS_DIR
mkdir -p "${CODY_TOOLS_DIR}/bin"
PATH="${CODY_TOOLS_DIR}/bin:${PATH}"
export PATH

exec node --experimental-strip-types /app/bin/cody-server.js -H 0.0.0.0 -p "${PORT:-30177}"
