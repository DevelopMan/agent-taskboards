#!/usr/bin/env sh
# Starts the app in debug/watch mode (Vite UI on 8142, Express API on 3000)
# using the existing image. Use scripts/run-build.sh to rebuild the image first.
#
#   scripts/run.sh [extra docker compose up args]
#
# TASKBOARDS_DEBUG=1 is forced so a `TASKBOARDS_DEBUG=` line in `.env` does not
# switch this script into release mode.
set -eu

cd "$(dirname "$0")/.."

export TASKBOARDS_DEBUG=1
exec docker compose up "$@"
