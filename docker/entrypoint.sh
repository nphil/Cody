#!/bin/sh
set -eu

# PID 1 has one duty nothing else can do for it: `wait()` on the processes the
# kernel reparents onto it when their own parent dies. Node does not do it — it
# reaps only children it spawned itself — so under a node PID 1 every reparented
# process that exits becomes a zombie forever, holding a PID-table entry that no
# `pkill` can free, because a zombie is already dead and only that `wait()`
# removes it. Measured in a live container after one evening of preview testing:
# 533 of them, all PPID 1, up to 2.5 hours old.
#
# So hand PID 1 to an init that does the job, and re-exec this same script as its
# child. Everything below is then unchanged and simply runs one level down: the
# profile scripts, sshd, the GPU/X/encoder probes, and the closing `exec node`
# that leaves the server as tini's own direct child — which is what keeps
# `docker stop` working, since tini forwards SIGTERM/SIGINT straight to that
# child. No `-g`: group-signalling would race node's orderly shutdown against a
# parallel SIGTERM to sshd and the display stack, and nothing asked for that.
#
# The `$$` test is the whole guard, and it is exact: after the exec this script is
# tini's child, never PID 1, so it cannot loop. Under `--pid=host` it is never PID
# 1 either and correctly does nothing, because the host's init already reaps.
#
# DO NOT "simplify" this into the Dockerfile's ENTRYPOINT. That looks like the
# obvious spelling and it does not work on the deployment this project exists for.
# Unraid's native per-container Tailscale integration rewrites the entrypoint at
# CREATE time, outside the image: its rendered `docker create` carries
#   --entrypoint='/opt/unraid/tailscale'
#   -v '/usr/local/share/docker/tailscale_container_hook':'/opt/unraid/tailscale'
# so the image's own ENTRYPOINT is replaced wholesale, the hook runs first, and it
# execs this script. An `ENTRYPOINT ["tini", ...]` would therefore be dropped on
# the floor there with no warning at all: PID 1 would still be node, the zombies
# would keep accumulating, and the fix would look installed. Deciding it HERE is
# load-bearing, not belt-and-braces — the hook execs us, so we are still PID 1,
# and we still get to hand that over.
if [ "$$" = "1" ] && [ -x /usr/bin/tini ]; then
  exec /usr/bin/tini -- "$0" "$@"
fi

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
# boot. What it publishes is the signal lib/display reads to pick its Chromium
# launch flags and its renderer:
#   CODY_GPU                vendors found, or "none" — a human/diagnostic summary
#   CODY_GPU_RENDER_NODE    the DRM render node, empty when there is none
#   CODY_GPU_ENCODER        "h264_vaapi" when hardware H.264 encode is usable,
#                           empty otherwise. The streamed preview gates its
#                           video path on exactly this and stays on its JPEG
#                           path when it is empty.
#   CODY_GPU_ENCODER_DEVICE the render node to pass as ffmpeg -vaapi_device
#   CODY_X_BACKENDS         ordered, strongest first, comma separated: which X
#                           display backends can host the page, e.g.
#                           "xwayland,xvfb". Empty means no X at all, so the
#                           session stays on the headless JPEG path. This and
#                           CODY_GPU_ENCODER are independent axes: the first
#                           says what can render the page, the second whether
#                           its frames can be encoded, and the video path needs
#                           both.
#   CODY_X_RUNTIME_DIR      XDG_RUNTIME_DIR for weston's socket, created 0700
#                           here because weston refuses to start without one
#   CODY_FFMPEG_BIN         absolute ffmpeg path, so nothing shell-resolves it
#   CODY_XVFB_BIN           absolute Xvfb path, likewise
#   CODY_WESTON_BIN         absolute weston path, likewise
#   CODY_XWAYLAND_BIN       absolute Xwayland path, likewise
#   CODY_WESTON_SHELL       absolute path to a weston shell module that forks no
#                           helper clients, empty when this build has none. The
#                           default shell forks two per session and does not
#                           take them with it when it dies.
#   CODY_SETPRIV_BIN        absolute setpriv path when it can arm PR_SET_PDEATHSIG,
#                           empty otherwise. The display stack spawns through it
#                           so the kernel kills its children if this server is
#                           killed outright, which no handler of ours could.
# provider.ts gates GPU rasterization on CODY_GPU_RENDER_NODE specifically,
# because a render node is the thing Mesa needs; NVIDIA's nodes do not provide
# one unless /dev/dri is also passed through.
#
# Render nodes are RANKED, never taken in readdir order: a host can expose
# several and the numbering is host-specific. On the owner's box renderD128 is
# an NVIDIA P40 (no Mesa/VAAPI stack in this image) and renderD129 is the Intel
# UHD 630 that actually rasterizes and encodes, so first-match would pick the
# wrong device the moment the container is given all of /dev/dri. Intel/AMD win
# over NVIDIA/unknown, and every node found is logged with its vendor so a
# wrong pick is visible in the boot log instead of inferred from a slow preview.
CODY_GPU_RENDER_NODE=""
CODY_GPU_VENDOR=""
_nodes=""
_rank=9
for _node in /dev/dri/renderD*; do
  [ -e "${_node}" ] || continue
  # PCI vendor id straight from sysfs, so the log names the real device
  # instead of assuming the Intel case.
  case "$(cat "/sys/class/drm/${_node##*/}/device/vendor" 2>/dev/null || true)" in
    0x8086) _vendor="Intel"; _r=1 ;;
    0x1002) _vendor="AMD"; _r=1 ;;
    0x10de) _vendor="NVIDIA"; _r=3 ;;
    *) _vendor="DRM"; _r=4 ;;
  esac
  _nodes="${_nodes}${_nodes:+, }${_node##*/} ${_vendor}"
  if [ "${_r}" -lt "${_rank}" ]; then
    _rank="${_r}"
    CODY_GPU_RENDER_NODE="${_node}"
    CODY_GPU_VENDOR="${_vendor}"
  fi
done
if [ -n "${_nodes}" ]; then
  echo "[Cody] GPU: DRM render nodes: ${_nodes}"
fi

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

# Which X display backends can host the page, strongest first. Chromium renders
# into an X display rather than headless whenever the video path is in play,
# because an encoder needs raw frames and CDP's screencast only emits JPEG/PNG.
# There are two rungs and the difference is measured, not stylistic:
#   xwayland  Xwayland on a headless weston. Weston renders through the DRM
#             render node (no DRM master, no card node needed), so Xwayland can
#             hand Chromium DRI3 and Chromium keeps HARDWARE rasterization:
#             glRenderer reads "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630
#             (CFL GT2))" and a rAF paint benchmark holds 60.2 fps at 2560x1600,
#             60.0 fps while capture+encode runs alongside it.
#   xvfb      plain Xvfb. No DRI3, so Mesa falls back to llvmpipe: the same
#             benchmark gives 34.7 fps, and 22.3 fps under capture+encode. It
#             stays as the rung for hosts with no usable render node, or when
#             weston will not start.
# Absent both, the session renders headless and streams JPEG exactly as before.
# Note for whoever spawns these: weston's own `--xwayland` module runs Xwayland
# ROOTLESS, which leaves the X root window empty and makes x11grab capture pure
# black. Xwayland has to be spawned separately, rooted, which also pins the
# display number per session.
CODY_X_BACKENDS=""
CODY_X_RUNTIME_DIR="${CODY_X_RUNTIME_DIR:-/run/cody-x}"
CODY_WESTON_BIN="$(command -v weston 2>/dev/null || true)"
CODY_WESTON_SHELL=""
CODY_XWAYLAND_BIN="$(command -v Xwayland 2>/dev/null || true)"
CODY_XVFB_BIN="$(command -v Xvfb 2>/dev/null || true)"

# A headless compositor needs no desktop furniture, and weston's DEFAULT shell
# module is what forks `weston-desktop-shell` and `weston-keyboard` — two helper
# clients per session which the compositor does not take with it when it dies.
# kiosk-shell.so forks nothing at all, measured on this image's weston 10.0.1:
# the default shell spawns both helpers, kiosk spawns zero children, while the
# rooted Xwayland still comes up, glRenderer still reads "ANGLE (Intel, Mesa
# Intel(R) UHD Graphics 630 (CFL GT2), OpenGL ES 3.2 Mesa 22.3.6)", and a capture
# of the X root is byte-identical (same mean luma, same encoded size). Not
# spawning a helper beats killing one.
# An ABSOLUTE path is published, never the bare module name: weston resolves a
# relative one against its compiled-in MODULEDIR, which we would be guessing, and
# a wrong guess is not a warning — weston exits, the xwayland rung fails, and the
# session silently demotes to software rasterization on Xvfb. A path already
# stat()ed here cannot do that. Empty means this weston has no such module and
# gets its default shell, which is why the provider tears down by process GROUP
# regardless.
for _shell in /usr/lib/*/weston/kiosk-shell.so /usr/lib/weston/kiosk-shell.so \
  /usr/local/lib/*/weston/kiosk-shell.so; do
  if [ -e "${_shell}" ]; then CODY_WESTON_SHELL="${_shell}"; break; fi
done

# Nothing in userspace can clean up after SIGKILL, because no handler of ours
# runs — so the kernel holds the leash instead. setpriv arms PR_SET_PDEATHSIG on
# each child of the display stack, and the kernel kills that child the moment
# this server dies, however it dies. Measured on this image: `kill -9` on the
# server left 21 live strays behind (weston, Xwayland and a nine-process Chromium
# tree, every one of them reparented to PID 1) without this, and zero with it.
# Chromium is deliberately not wrapped and needs no wrapping: it exits on its own
# once Xwayland is gone.
# Probed by RUNNING it, not by looking for the binary: --pdeathsig is a newer
# util-linux option than setpriv itself. Empty is a supported configuration — a
# dev shell outside this image can set CODY_X_BACKENDS by hand — and costs only
# this last line of defence: every ordinary exit path still tears the group down.
CODY_SETPRIV_BIN=""
if setpriv --pdeathsig SIGKILL true 2>/dev/null; then
  CODY_SETPRIV_BIN="$(command -v setpriv 2>/dev/null || true)"
fi
if [ -n "${CODY_WESTON_BIN}" ] && [ -n "${CODY_XWAYLAND_BIN}" ] \
  && [ -n "${CODY_GPU_RENDER_NODE}" ] \
  && { [ "${CODY_GPU_VENDOR}" = "Intel" ] || [ "${CODY_GPU_VENDOR}" = "AMD" ]; }; then
  CODY_X_BACKENDS="xwayland"
fi
if [ -n "${CODY_XVFB_BIN}" ]; then
  CODY_X_BACKENDS="${CODY_X_BACKENDS}${CODY_X_BACKENDS:+,}xvfb"
fi
if [ -n "${CODY_X_BACKENDS}" ]; then
  # weston refuses to start without a 0700 XDG_RUNTIME_DIR, so hand the
  # provider one that already exists instead of one it has to create per
  # session. /run is tmpfs here, which is where a socket directory belongs.
  if mkdir -p "${CODY_X_RUNTIME_DIR}" 2>/dev/null; then
    chmod 700 "${CODY_X_RUNTIME_DIR}" 2>/dev/null || true
  fi
  echo "[Cody] GPU: X display backends: ${CODY_X_BACKENDS} (strongest first)"
  # Stated at boot because the absence of either is invisible at runtime: it
  # looks exactly like a working session that happens to leave debris behind.
  echo "[Cody] GPU: X teardown: weston shell ${CODY_WESTON_SHELL:-<default, forks 2 helper clients>}, parent-death signal ${CODY_SETPRIV_BIN:-<unavailable>}"
else
  echo "[Cody] GPU: no X display backend — previews render headless"
fi

# Hardware H.264 needs three things true at once, and the provider has to know
# which renderer it may offer before the first client connects: a render node
# whose vendor has a Mesa/VAAPI encode stack in this image (Intel or AMD — the
# NVIDIA path would be NVENC and is not wired up), an ffmpeg carrying
# h264_vaapi, and a VAAPI driver that really exposes an H.264 encode entrypoint
# (vainfo answers in ~35ms, and it is the difference between "an Intel GPU is
# present" and "this Intel GPU can encode" — decode-only and encode-less parts
# exist). Any of them missing is a supported configuration, not a fault: the
# session streams JPEG instead. So this states the reason in one calm line and
# moves on. The X backend above is the other half of the requirement; the video
# path needs a non-empty value from both.
CODY_GPU_ENCODER=""
CODY_GPU_ENCODER_DEVICE=""
CODY_FFMPEG_BIN="$(command -v ffmpeg 2>/dev/null || true)"
_why=""
if [ -z "${CODY_GPU_RENDER_NODE}" ]; then
  _why="no DRM render node"
elif [ "${CODY_GPU_VENDOR}" != "Intel" ] && [ "${CODY_GPU_VENDOR}" != "AMD" ]; then
  _why="${CODY_GPU_VENDOR} render node, and VAAPI encode needs Intel or AMD"
elif [ -z "${CODY_FFMPEG_BIN}" ]; then
  _why="no ffmpeg on PATH"
elif [ -z "${CODY_X_BACKENDS}" ]; then
  _why="no X display backend to capture"
elif ! "${CODY_FFMPEG_BIN}" -hide_banner -encoders 2>/dev/null | grep -q h264_vaapi; then
  _why="this ffmpeg has no h264_vaapi encoder"
elif command -v vainfo >/dev/null 2>&1 && ! vainfo --display drm --device "${CODY_GPU_RENDER_NODE}" 2>/dev/null | grep -q 'VAProfileH264.*VAEntrypointEncSlice'; then
  _why="${CODY_GPU_VENDOR} VAAPI driver exposes no H.264 encode entrypoint"
else
  CODY_GPU_ENCODER="h264_vaapi"
  CODY_GPU_ENCODER_DEVICE="${CODY_GPU_RENDER_NODE}"
fi
if [ -n "${CODY_GPU_ENCODER}" ]; then
  echo "[Cody] GPU: h264_vaapi encode on ${CODY_GPU_ENCODER_DEVICE} — previews stream H.264"
else
  echo "[Cody] GPU: no hardware H.264 (${_why}) — previews stream JPEG"
fi
export CODY_GPU CODY_GPU_RENDER_NODE CODY_GPU_ENCODER CODY_GPU_ENCODER_DEVICE \
  CODY_X_BACKENDS CODY_X_RUNTIME_DIR CODY_WESTON_SHELL CODY_SETPRIV_BIN \
  CODY_FFMPEG_BIN CODY_XVFB_BIN CODY_WESTON_BIN CODY_XWAYLAND_BIN
unset _node _nodes _r _rank _shell _vendor _why CODY_GPU_VENDOR CODY_GPU_NVIDIA

# Containers keep the wide bind (Docker port mapping needs it, and auth is
# always on). The Windows desktop shell overrides with 127.0.0.1: inside WSL2
# loopback is still forwarded to the host, and a wider bind would become
# LAN-reachable under user-enabled mirrored networking.
exec node --experimental-strip-types /app/bin/cody-server.js -H "${CODY_BIND_HOST:-0.0.0.0}" -p "${PORT:-30177}"
