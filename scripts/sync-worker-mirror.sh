#!/bin/bash
# Mirror this server's toolchains and caches onto a Cody worker at the SAME absolute paths, so run_on_worker
# can run a project there as if it were here (docs/agents/workers.md, "Same paths" and "Mirroring a worker").
#
# Run it where the toolchains live (the Cody container), with rsync and an ssh alias for the worker:
#   WORKER=my-worker scripts/sync-worker-mirror.sh [--dry-run]
#
# It copies an explicit list and nothing else: never ~/.ssh, tokens, agent.db or any credential store, and
# it never deletes anything on the worker. Safe to re-run (only changed files move); run it after installing
# a toolchain or a venv on the server. The worker-only parts (node/bun/python 3.11 under
# <work root>/root<anchor>/home/.local/share/cody-worker, and <work root>/env.sh) are not touched.
set -eu

WORKER=${WORKER:?set WORKER to the ssh destination of the worker}
WORK_ROOT=${WORK_ROOT:-/srv/cody-work}
ANCHOR=${ANCHOR:-/data}
SRC_HOME=${SRC_HOME:-$ANCHOR/home}
DEST="$WORKER:$WORK_ROOT/root$ANCHOR/home"
# A venv or cache directory to mirror under ~/.cache; edit the list for your own projects.
CACHES=${CACHES:-"reprise-venv hazel-venv sbx-venv speechdock-vad-venv jdk-17-temurin cody-build-tools"}

rs() { rsync -aH --no-o --no-g --mkpath --partial --info=stats1 -e ssh "$@"; }
step() { echo "=== $(date +%T) $*"; }

step cargo-bin;     rs "$@" "$SRC_HOME/.cargo/bin/" "$DEST/.cargo/bin/"
step rustup;        rs "$@" --exclude=downloads --exclude=tmp --exclude='toolchains/*/share/doc' "$SRC_HOME/.rustup/" "$DEST/.rustup/"
step local-bin;     rs "$@" --exclude=__pycache__ "$SRC_HOME/.local/bin/" "$DEST/.local/bin/"
step uv;            rs "$@" "$SRC_HOME/.local/share/uv/" "$DEST/.local/share/uv/"
step toolchains;    rs "$@" --exclude='omp-*' --exclude='*.log' "$SRC_HOME/toolchains/" "$DEST/toolchains/"
for name in $CACHES; do
  step "cache/$name"; rs "$@" "$SRC_HOME/.cache/$name/" "$DEST/.cache/$name/"
done
step done
