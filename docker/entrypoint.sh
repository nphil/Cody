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
# lives. Edited directly in /etc/passwd: usermod refuses to touch root while
# root is running the entrypoint ("user root is currently used by process 1").
sed -i "s#^\(root:[^:]*:0:0:[^:]*\):[^:]*:#\1:${HOME}:#" /etc/passwd
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

# ---------------------------------------------------------------------------
# GPU capability probe. Passthrough is opt-in on the host (Unraid: a --device
# for /dev/dri, and/or the Nvidia Driver plugin's runtime), so on a default
# install these devices are simply absent — a fully supported configuration,
# not a fault. This block therefore reports, never warns, and never fails the
# boot. What it publishes is the signal lib/display/provider.ts reads to pick
# its Chromium launch flags:
#   CODY_GPU              vendors found, or "none" — a human/diagnostic summary
#   CODY_GPU_RENDER_NODE  the DRM render node, empty when there is none
# provider.ts gates GPU rasterization on CODY_GPU_RENDER_NODE specifically,
# because a render node is the thing Mesa needs; NVIDIA's nodes do not provide
# one unless /dev/dri is also passed through.
CODY_GPU_RENDER_NODE=""
CODY_GPU_VENDOR=""
for _node in /dev/dri/renderD*; do
  [ -e "${_node}" ] || continue
  CODY_GPU_RENDER_NODE="${_node}"
  # PCI vendor id straight from sysfs, so the log names the real device
  # instead of assuming the Intel case.
  case "$(cat "/sys/class/drm/${_node##*/}/device/vendor" 2>/dev/null || true)" in
    0x8086) CODY_GPU_VENDOR="Intel" ;;
    0x1002) CODY_GPU_VENDOR="AMD" ;;
    0x10de) CODY_GPU_VENDOR="NVIDIA" ;;
    *) CODY_GPU_VENDOR="DRM" ;;
  esac
  break
done

CODY_GPU_NVIDIA=""
for _node in /dev/nvidia[0-9]*; do
  if [ -e "${_node}" ]; then
    CODY_GPU_NVIDIA=1
    break
  fi
done

if [ -n "${CODY_GPU_RENDER_NODE}" ]; then
  CODY_GPU="$(echo "${CODY_GPU_VENDOR}" | tr '[:upper:]' '[:lower:]')"
  if [ -n "${CODY_GPU_NVIDIA}" ] && [ "${CODY_GPU}" != "nvidia" ]; then
    CODY_GPU="${CODY_GPU},nvidia"
  fi
  echo "[Cody] GPU: ${CODY_GPU_VENDOR} render node ${CODY_GPU_RENDER_NODE} — previews render with GPU rasterization"
elif [ -n "${CODY_GPU_NVIDIA}" ]; then
  CODY_GPU="nvidia"
  echo "[Cody] GPU: NVIDIA nodes present but no /dev/dri render node — previews use software rendering (add a /dev/dri device to the container for GPU rasterization)"
else
  CODY_GPU="none"
  echo "[Cody] GPU: no passthrough devices — previews use software rendering"
fi
# NVENC is the one capability the common NVIDIA_DRIVER_CAPABILITIES default
# ("compute,utility") silently omits, and the symptom is a codec that simply
# never appears. Say so once, only when an NVIDIA GPU is actually attached.
if [ -n "${CODY_GPU_NVIDIA}" ]; then
  case ",${NVIDIA_DRIVER_CAPABILITIES:-}," in
    *,all,* | *,video,*) ;;
    *) echo "[Cody] GPU: NVIDIA_DRIVER_CAPABILITIES='${NVIDIA_DRIVER_CAPABILITIES:-unset}' does not include 'video' — NVENC will be unavailable (use 'compute,utility,video' or 'all')" ;;
  esac
fi
export CODY_GPU CODY_GPU_RENDER_NODE
unset _node CODY_GPU_VENDOR CODY_GPU_NVIDIA

# Containers keep the wide bind (Docker port mapping needs it, and auth is
# always on). The Windows desktop shell overrides with 127.0.0.1: inside WSL2
# loopback is still forwarded to the host, and a wider bind would become
# LAN-reachable under user-enabled mirrored networking.
exec node --experimental-strip-types /app/bin/cody-server.js -H "${CODY_BIND_HOST:-0.0.0.0}" -p "${PORT:-30177}"
