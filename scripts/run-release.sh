#!/usr/bin/env sh
# Starts the app in release mode: the container builds the API and UI into
# dist/ and serves both from the compiled Express server on port 8142.
#
#   scripts/run-release.sh [extra docker compose up args]
#
# Pass --build to rebuild the image first.
set -eu

cd "$(dirname "$0")/.."

export TASKBOARDS_DEBUG=
exec docker compose up "$@"
