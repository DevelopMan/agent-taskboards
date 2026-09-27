#!/usr/bin/env sh
# Runs the continuous integration checks exactly as GitHub Actions does: builds
# the project's Docker image, then runs each npm check in a throwaway container
# from that image. Dependencies are installed only inside the image, never on
# the host.
#
# Run from any directory on the host:
#
#   scripts/ci.sh                  # build the image, then run every check
#   scripts/ci.sh test lint        # build the image, then run only these checks
#   scripts/ci.sh --no-build test  # reuse an image that is already built
#
# Checks: lockfile (scripts/lockfile.mjs check), typecheck, lint, test, and
# build run in the image; compose-config (scripts/check-compose-config.sh) runs
# on the host. The image never contains the optional embedding model, so its
# test skips itself.
#
# TASKBOARDS_CI_IMAGE sets the image tag (default agent-taskboards:ci).
# TASKBOARDS_CI_PLATFORM builds and runs another architecture, for example
# linux/amd64 on Apple Silicon to reproduce the amd64 CI lane under emulation.
# The script stops at the first failing check and exits non-zero.
set -eu

cd "$(dirname "$0")/.."

image="${TASKBOARDS_CI_IMAGE:-agent-taskboards:ci}"
platform="${TASKBOARDS_CI_PLATFORM:-}"
build=1

if [ "${1:-}" = "--no-build" ]; then
  build=0
  shift
fi

if [ "$#" -eq 0 ]; then
  set -- lockfile typecheck lint test build compose-config
fi

# Reject unknown checks before spending time on the image build.
for check in "$@"; do
  case "$check" in
    lockfile|typecheck|lint|test|build|compose-config) ;;
    *)
      echo "error: unknown check '$check'" >&2
      echo "  expected: lockfile, typecheck, lint, test, build, compose-config" >&2
      exit 2
      ;;
  esac
done

if [ "$build" -eq 1 ]; then
  echo "==> docker build -t $image ${platform:+--platform $platform }."
  docker build ${platform:+--platform "$platform"} -t "$image" .
fi

for check in "$@"; do
  case "$check" in
    compose-config)
      echo "==> scripts/check-compose-config.sh"
      scripts/check-compose-config.sh
      ;;
    lockfile)
      echo "==> node scripts/lockfile.mjs check (in $image)"
      docker run --rm ${platform:+--platform "$platform"} "$image" node scripts/lockfile.mjs check
      ;;
    *)
      echo "==> npm run $check (in $image)"
      docker run --rm ${platform:+--platform "$platform"} -e CI=true "$image" npm run "$check"
      ;;
  esac
done

echo "==> CI checks passed: $*"
