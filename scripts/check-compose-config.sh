#!/usr/bin/env sh
# Validates docker-compose.yml against the release configuration matrix by
# rendering each configuration with `docker compose config --format json` and
# checking the published port, bind address, mount sources, and read-only model
# mount. JSON is used because the YAML renderer folds long paths across lines.
#
# Run from the repository root on the host:
#
#   scripts/check-compose-config.sh
#
# The script never starts containers and does not read your `.env` file, so it
# checks the compose file itself rather than your local settings.
set -eu

cd "$(dirname "$0")/.."

if ! docker compose version >/dev/null 2>&1; then
  echo "error: docker compose is not available on PATH" >&2
  exit 1
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/taskboards-compose-check.XXXXXX")"
# Compose renders normalized absolute paths, so normalize ours the same way.
scratch="$(cd "$scratch" && pwd -P)"
trap 'rm -rf "$scratch"' EXIT

failures=0
current=""

# render NAME [VAR=VALUE ...]
# Renders the compose file with only the given variables set, using an empty
# env file so the developer's own `.env` does not leak into the check.
render() {
  current="$1"
  shift
  : > "$scratch/empty.env"
  env -u TASKBOARDS_PORT -u TASKBOARDS_BIND_ADDRESS -u TASKBOARDS_DATA_DIR \
    -u TASKBOARDS_UPLOADS_DIR -u TASKBOARDS_MODEL_DIR -u TASKBOARDS_MODEL_FILE \
    -u TASKBOARDS_DEBUG \
    "$@" docker compose --env-file "$scratch/empty.env" config --format json \
    > "$scratch/rendered.json" 2> "$scratch/stderr.txt" || {
    echo "FAIL [$current]: docker compose config exited non-zero" >&2
    cat "$scratch/stderr.txt" >&2
    failures=$((failures + 1))
    return 1
  }
}

# expect PATTERN DESCRIPTION
# Asserts that the rendered config contains PATTERN (grep -F, fixed string).
expect() {
  if grep -qF -- "$1" "$scratch/rendered.json"; then
    return 0
  fi
  echo "FAIL [$current]: missing $2" >&2
  echo "  expected fragment: $1" >&2
  failures=$((failures + 1))
}

# expect_mount SOURCE TARGET [READ_ONLY]
# Asserts a bind mount from SOURCE to TARGET. Compose renders each mount as one
# JSON object with "type", "source", "target", and an optional "read_only" key;
# SOURCE must already be absolute and normalized.
expect_mount() {
  mount_source="$1"
  mount_target="$2"
  mount_read_only="${3:-false}"
  if awk -v src="$mount_source" -v tgt="$mount_target" -v ro="$mount_read_only" '
    function unquote(v) { sub(/^[^:]*: "/, "", v); sub(/",?$/, "", v); return v }
    /^ *\{ *$/ { inobj = 1; ty = ""; s = ""; t = ""; r = "false"; next }
    inobj && /^ *"type": / { ty = unquote($0) }
    inobj && /^ *"source": / { s = unquote($0) }
    inobj && /^ *"target": "/ { t = unquote($0) }
    inobj && /^ *"read_only": true/ { r = "true" }
    /^ *\},? *$/ {
      if (inobj && ty == "bind" && s == src && t == tgt && r == ro) found = 1
      inobj = 0
    }
    END { exit found ? 0 : 1 }
  ' "$scratch/rendered.json"; then
    return 0
  fi
  echo "FAIL [$current]: missing bind mount $mount_source -> $mount_target (read_only=$mount_read_only)" >&2
  failures=$((failures + 1))
}

repo="$(pwd)"

# 1. Defaults: loopback binding, port 8142, repo-relative storage and model.
render default
expect '"host_ip": "127.0.0.1"' 'loopback bind address'
expect '"published": "8142"' 'default published port'
expect '"target": 8142' 'container port'
expect '"TASKBOARDS_EMBEDDING_MODEL_PATH": "/models/bge-small-en-v1.5-f32.gguf"' 'default model path env'
expect_mount "$repo/data" /data
expect_mount "$repo/uploads" /uploads
expect_mount "$repo/models-gguf" /models true

# 2. Custom port.
render custom-port TASKBOARDS_PORT=9911
expect '"host_ip": "127.0.0.1"' 'loopback bind address'
expect '"published": "9911"' 'custom published port'
expect '"target": 8142' 'container port unchanged'

# 3. Custom storage directories, including paths with spaces.
storage="$scratch/my taskboards"
mkdir -p "$storage/data dir" "$storage/upload files"
render custom-storage \
  TASKBOARDS_DATA_DIR="$storage/data dir" \
  TASKBOARDS_UPLOADS_DIR="$storage/upload files"
expect_mount "$storage/data dir" /data
expect_mount "$storage/upload files" /uploads

# 4. Custom model directory and file name, with a space in the directory.
models="$scratch/gguf models"
mkdir -p "$models"
render custom-model \
  TASKBOARDS_MODEL_DIR="$models" \
  TASKBOARDS_MODEL_FILE=custom-embedding-q8.gguf
expect_mount "$models" /models true
expect '"TASKBOARDS_EMBEDDING_MODEL_PATH": "/models/custom-embedding-q8.gguf"' 'custom model path env'

# 5. LAN exposure with release mode.
render lan TASKBOARDS_BIND_ADDRESS=0.0.0.0 TASKBOARDS_DEBUG=
expect '"host_ip": "0.0.0.0"' 'LAN bind address'
expect '"published": "8142"' 'default published port'
expect '"TASKBOARDS_DEBUG": ""' 'release mode debug flag'

if [ "$failures" -ne 0 ]; then
  echo "compose config check failed with $failures problem(s)" >&2
  exit 1
fi

echo "compose config check passed: default, custom-port, custom-storage, custom-model, lan"
