#!/usr/bin/env sh
# Rebuilds the image and starts the app in debug/watch mode.
#
#   scripts/run-build.sh [extra docker compose up args]
set -eu

cd "$(dirname "$0")/.."

export TASKBOARDS_DEBUG=1
exec docker compose up --build "$@"
