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

# Engines installed from the picker (omp, claude, codex, …) land in a
# persistent npm prefix under /data so they survive image updates; put its
# bin dir on PATH ahead of the image's own so an updated engine always wins.
CODY_TOOLS_DIR="${CODY_TOOLS_DIR:-${PI_CODING_AGENT_DIR}/tools}"
export CODY_TOOLS_DIR
mkdir -p "${CODY_TOOLS_DIR}/bin"
PATH="${CODY_TOOLS_DIR}/bin:${PATH}"
export PATH

# ---------------------------------------------------------------------------
# SSH sessions must see the same world the web terminals do. sshd spawns
# clean login shells that never inherit this process's environment, so bake
# the runtime values into a profile script (sourced alphabetically — env
# first, the engine auto-launch below second), and point root's home at the
# persistent /data/home where engine sign-in state (~/.claude, ~/.codex)
# lives.
usermod -d "${HOME}" root 2>/dev/null || true
cat > /etc/profile.d/00-cody-env.sh <<EOF
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR}"
export CODY_TOOLS_DIR="${CODY_TOOLS_DIR}"
export PATH="${CODY_TOOLS_DIR}/bin:\${PATH}"
export TERM="\${TERM:-xterm-256color}"
EOF

# Interactive SSH logins drop straight into the active coding engine's CLI;
# leaving the engine (exit / Ctrl-C / /quit) lands in a normal shell instead
# of closing the connection. Opt out per-connection with
#   ssh -o SetEnv=CODY_NO_AUTO_ENGINE=1 …  (or: CODY_NO_AUTO_ENGINE=1 bash -l)
cat > /etc/profile.d/50-cody-engine.sh <<'EOF'
if [ -n "${SSH_CONNECTION:-}" ] && [ -t 0 ] && [ -z "${CODY_ENGINE_LAUNCHED:-}" ] \
  && [ "${CODY_NO_AUTO_ENGINE:-}" != "1" ]; then
  export CODY_ENGINE_LAUNCHED=1
  _cody_engine=$(sed -n 's/.*"activeEngine"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' \
    "${PI_CODING_AGENT_DIR}/cody-engine.json" 2>/dev/null || true)
  [ -n "${_cody_engine}" ] || _cody_engine="${CODY_HARNESS:-omp}"
  case "${_cody_engine}" in
    claude) _cody_bin=claude ;;
    codex) _cody_bin=codex ;;
    *) _cody_bin=omp ;;
  esac
  if command -v "${_cody_bin}" >/dev/null 2>&1; then
    printf 'Cody: starting %s — exit the engine to drop to a shell.\n' "${_cody_bin}"
    cd /workspace 2>/dev/null || true
    "${_cody_bin}" || true
    printf 'Cody: %s exited — this is a plain shell now; `exit` closes the connection.\n' "${_cody_bin}"
  else
    printf 'Cody: no engine installed yet (finish onboarding in the WebUI) — plain shell.\n'
  fi
  unset _cody_engine _cody_bin
fi
EOF

# sshd runs only when the operator configured a way in: CODY_SSH_PASSWORD
# (root password login) and/or authorized keys at /data/home/.ssh. Host keys
# persist under /data/ssh so clients like Termius do not see a changed
# identity after every image update.
SSH_AUTH_KEYS="${HOME}/.ssh/authorized_keys"
if [ -n "${CODY_SSH_PASSWORD:-}" ] || [ -s "${SSH_AUTH_KEYS}" ]; then
  mkdir -p /data/ssh "${HOME}/.ssh"
  chmod 700 "${HOME}/.ssh"
  if [ ! -f /data/ssh/ssh_host_ed25519_key ]; then
    ssh-keygen -q -t ed25519 -N "" -f /data/ssh/ssh_host_ed25519_key
  fi
  if [ -n "${CODY_SSH_PASSWORD:-}" ]; then
    echo "root:${CODY_SSH_PASSWORD}" | chpasswd
    SSH_PASSWORD_AUTH=yes
  else
    SSH_PASSWORD_AUTH=no
  fi
  mkdir -p /etc/ssh/sshd_config.d
  cat > /etc/ssh/sshd_config.d/cody.conf <<EOF
Port ${CODY_SSH_PORT:-2222}
HostKey /data/ssh/ssh_host_ed25519_key
PermitRootLogin yes
PasswordAuthentication ${SSH_PASSWORD_AUTH}
EOF
  /usr/sbin/sshd
  echo "[Cody] SSH ready on port ${CODY_SSH_PORT:-2222} (password auth: ${SSH_PASSWORD_AUTH})"
else
  echo "[Cody] SSH disabled — set CODY_SSH_PASSWORD or add keys to /data/home/.ssh/authorized_keys"
fi

exec node --experimental-strip-types /app/bin/cody-server.js -H 0.0.0.0 -p "${PORT:-30177}"
