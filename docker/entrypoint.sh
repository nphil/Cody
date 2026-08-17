#!/bin/sh
set -eu

# Cody in a container listens on 0.0.0.0 — that is only safe behind auth.
# Auth comes from either CODY_PASSWORD (the env-managed bootstrap account) or
# user accounts already created in the persisted account store; require one of
# the two unless the operator explicitly opts out (e.g. the container sits
# behind an authenticating reverse proxy).
# The app accepts the pre-fork OMP_WEB_PASSWORD too (lib/env.ts), so the gate
# must recognize it or a documented-working config is refused at the door.
ACCOUNTS_FILE="${CODY_ACCOUNTS_DIR:-${PI_CODING_AGENT_DIR}/cody-accounts}/accounts.json"
if [ -z "${CODY_PASSWORD:-}" ] && [ -z "${OMP_WEB_PASSWORD:-}" ] && [ "${CODY_ALLOW_NO_AUTH:-}" != "1" ] \
  && ! { [ -f "${ACCOUNTS_FILE}" ] && grep -q '"username"' "${ACCOUNTS_FILE}"; }; then
  echo "No password is set (CODY_PASSWORD, or the legacy OMP_WEB_PASSWORD) and no" >&2
  echo "user accounts exist yet at ${ACCOUNTS_FILE}." >&2
  echo "Set a password (Basic Auth / login username: cody), or set CODY_ALLOW_NO_AUTH=1" >&2
  echo "only if an authenticating reverse proxy fronts this container. Once accounts" >&2
  echo "exist, the password variable may be removed." >&2
  exit 1
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
