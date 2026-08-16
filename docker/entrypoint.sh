#!/bin/sh
set -eu

# Cody in a container listens on 0.0.0.0 — that is only safe behind auth.
# Require a password unless the operator explicitly opts out (e.g. the
# container sits behind an authenticating reverse proxy).
if [ -z "${CODY_PASSWORD:-}" ] && [ "${CODY_ALLOW_NO_AUTH:-}" != "1" ]; then
  echo "CODY_PASSWORD is not set." >&2
  echo "Set it (Basic Auth username: cody), or set CODY_ALLOW_NO_AUTH=1 only if an" >&2
  echo "authenticating reverse proxy fronts this container." >&2
  exit 1
fi

mkdir -p "${HOME}" "${PI_CODING_AGENT_DIR}" /workspace

exec node --experimental-strip-types /app/bin/cody-server.js -H 0.0.0.0 -p "${PORT:-30177}"
