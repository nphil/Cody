#!/bin/bash
# Mirror this server's toolchains and caches onto a Cody worker at the SAME absolute paths, so run_on_worker
# can run a project there as if it were here (docs/agents/workers.md, "Same paths" and "Mirroring a worker").
#
# Run it where the toolchains live (the Cody container), with rsync and an ssh alias for the worker:
#   WORKER=my-worker scripts/sync-worker-mirror.sh [--dry-run]
#
# It copies an explicit list and nothing else: never ~/.ssh, tokens, agent.db or any credential store, and
# it never deletes anything on the worker. Safe to re-run (only changed files move); run it after installing
# a toolchain or a venv on the server. Of the worker-only parts (node/bun/python 3.11 under
# <work root>/root<anchor>/home/.local/share/cody-worker, and <work root>/env.sh) it writes only the ffmpeg
# wrappers described below.
set -eu

WORKER=${WORKER:?set WORKER to the ssh destination of the worker}
WORK_ROOT=${WORK_ROOT:-/srv/cody-work}
ANCHOR=${ANCHOR:-/data}
SRC_HOME=${SRC_HOME:-$ANCHOR/home}
DEST="$WORKER:$WORK_ROOT/root$ANCHOR/home"
# A venv or cache directory to mirror under ~/.cache; edit the list for your own projects.
CACHES=${CACHES:-"reprise-venv hazel-venv sbx-venv speechdock-vad-venv jdk-17-temurin cody-build-tools"}
TC="$SRC_HOME/.cache/toolchains"

rs() { rsync -aH --no-o --no-g --mkpath --partial --info=stats1 -e ssh "$@"; }
step() { echo "=== $(date +%T) $*"; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

step cargo-bin;     rs "$@" "$SRC_HOME/.cargo/bin/" "$DEST/.cargo/bin/"
step rustup;        rs "$@" --exclude=downloads --exclude=tmp --exclude='toolchains/*/share/doc' "$SRC_HOME/.rustup/" "$DEST/.rustup/"
step local-bin;     rs "$@" --exclude=__pycache__ "$SRC_HOME/.local/bin/" "$DEST/.local/bin/"
step uv;            rs "$@" "$SRC_HOME/.local/share/uv/" "$DEST/.local/share/uv/"
if [ -d "$SRC_HOME/.local/go" ]; then
  step go;          rs "$@" "$SRC_HOME/.local/go/" "$DEST/.local/go/"
fi
step toolchains;    rs "$@" --exclude='omp-*' --exclude='*.log' "$SRC_HOME/toolchains/" "$DEST/toolchains/"
for name in $CACHES; do
  step "cache/$name"; rs "$@" "$SRC_HOME/.cache/$name/" "$DEST/.cache/$name/"
done

# ~/.cache/toolchains: swift, the Android NDK and SDK, the JDK, and the Debian 12 sysroot the swift and TV builds
# link against. Downloads (debs, archives) and Gradle's own cache stay behind. The sysroot's links into the server's
# system /lib arrive as real files: the worker's glibc may be newer, and its libc cannot link the sysroot.
if [ -d "$TC" ]; then
  (cd "$TC" && find . -type l \( -lname '/lib/*' -o -lname '/lib64/*' -o -lname '/usr/lib/*' -o -lname '/usr/lib64/*' \) \
    | sed 's|^\.||' | sort) > "$tmp/system-links"
  step cache/toolchains
  rs "$@" --exclude=/debs/ --exclude=/gradle-home/ --exclude='/*.tar.gz' --exclude='/*.sig' \
    --exclude-from="$tmp/system-links" "$TC/" "$DEST/.cache/toolchains/"
  if [ -s "$tmp/system-links" ]; then
    step "cache/toolchains: $(wc -l < "$tmp/system-links") system library links as files"
    rs "$@" --copy-links --files-from="$tmp/system-links" "$TC/" "$DEST/.cache/toolchains/"
  fi
  # The sysroot reaches swift's own headers and libraries through ~/tmp/toolchains (a link to ~/.cache/toolchains).
  if [ -L "$SRC_HOME/tmp/toolchains" ]; then
    step tmp/toolchains-link; rs "$@" "$SRC_HOME/tmp/toolchains" "$DEST/tmp/"
  fi
  # Swift's clang otherwise compiles C and C++ dependencies (swift-crypto's BoringSSL) against the worker's own
  # glibc headers, and `swift test` fails to link on glibc 2.38+ (__isoc23_*). Point it at the same sysroot.
  if [ -d "$TC/swift/usr/bin" ] && [ -d "$TC/sysroot" ]; then
    printf '%s\n' "# Written by scripts/sync-worker-mirror.sh: compile C and C++ against the sysroot Swift links with." \
      "--sysroot=$TC/sysroot" > "$tmp/x86_64-unknown-linux-gnu.cfg"
    step swift-clang-sysroot
    rs "$@" --checksum --no-times "$tmp/x86_64-unknown-linux-gnu.cfg" "$DEST/.cache/toolchains/swift/usr/bin/"
  fi
fi

# The server's ffmpeg and ffprobe with the libraries they load (glibc excepted: the worker's own is used), behind
# wrappers in the worker-only bin directory that comes first on a job's PATH. A worker distro's ffmpeg reports some
# stream details differently (Reprise's media tests failed on Debian 13's ffmpeg 7.1), so jobs get the server's.
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  ver=$(ffmpeg -version | sed -n '1s/^ffmpeg version \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')
  ff="$SRC_HOME/.local/share/cody-worker/ffmpeg-${ver:?cannot read the server ffmpeg version}"
  ldd "$(command -v ffmpeg)" "$(command -v ffprobe)" | awk '$2 == "=>" && $3 ~ /^\// { print $3 }' | sort -u \
    | grep -Ev '/(libc|libm|libdl|libpthread|librt|libresolv|libmvec|libanl|libutil|libnsl|libBrokenLocale|libthread_db|libnss_[a-z_]+|ld-linux[-a-z0-9_]*)\.so' \
    > "$tmp/ffmpeg-libs"
  for name in ffmpeg ffprobe; do
    cat > "$tmp/$name" <<EOF
#!/bin/sh
# Written by scripts/sync-worker-mirror.sh: the server's ffmpeg $ver with its own libraries, so media results match the server.
d=$ff
LD_LIBRARY_PATH=\$d/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH} exec "\$d/bin/$name" "\$@"
EOF
    chmod 755 "$tmp/$name"
  done
  step "ffmpeg-$ver: 2 programs, $(wc -l < "$tmp/ffmpeg-libs") libraries"
  rs "$@" --copy-links "$(command -v ffmpeg)" "$(command -v ffprobe)" "$DEST/.local/share/cody-worker/ffmpeg-$ver/bin/"
  rs "$@" --copy-links --no-relative --files-from="$tmp/ffmpeg-libs" / "$DEST/.local/share/cody-worker/ffmpeg-$ver/lib/"
  rs "$@" --checksum --no-times "$tmp/ffmpeg" "$tmp/ffprobe" "$DEST/.local/share/cody-worker/bin/"
fi
step "done"
