#!/bin/bash
set -uo pipefail

# Cloud-session bootstrap. The Claude environment's own hook
# (/usr/local/bin/tailscale-connect) joins the tailnet; what it does NOT do
# is install the system ssh client that `tailscale ssh` shells out to, so
# every `tailscale ssh root@beastnas` fails with "no system 'ssh' command
# found" until someone installs it by hand. Do it here, every session.

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

if ! command -v ssh >/dev/null 2>&1; then
  apt-get install -y openssh-client >/dev/null 2>&1 \
    || { apt-get update >/dev/null 2>&1 && apt-get install -y openssh-client >/dev/null 2>&1; } \
    || { echo "openssh-client install failed - tailscale ssh will not work" >&2; exit 0; }
fi
echo "openssh-client present - tailscale ssh ready"
