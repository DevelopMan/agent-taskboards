#!/usr/bin/env sh
# Interactive first-run setup and release launcher. Checks Docker, walks
# through embedding model choice, host port, storage directories, and network
# binding, downloads the chosen model with digest verification, persists the
# tool-managed values in the ignored `.env`, and starts the app in release
# mode.
#
#   scripts/start-local.sh [--reconfigure] [extra docker compose up args]
#
# A valid existing configuration is reused as-is: the script prints the
# resolved settings and launches. Pass --reconfigure to change them. Extra
# arguments (for example `-d`) pass through to `docker compose up`.
#
# TASKBOARDS_MODEL_MANIFEST overrides the built-in curated model manifest with
# a file of `key|file|bytes|sha256|url` lines, for mirrors and tests.
set -eu

cd "$(dirname "$0")/.."

usage() {
  cat <<'EOF'
Usage: scripts/start-local.sh [--reconfigure] [extra docker compose up args]

Configures a local installation interactively (embedding model, host port,
data and uploads directories, network binding), then starts release mode with
`docker compose up --build`. A valid existing configuration is reused; pass
--reconfigure to change it. Extra arguments pass through to docker compose up.
EOF
}

# All failure paths end here so every error names a concrete recovery command.
fail() {
  printf 'error: %s\n' "$1" >&2
  printf 'Recovery: %s\n' "$2" >&2
  exit 1
}

check_prereqs() {
  command -v docker >/dev/null 2>&1 \
    || fail "docker is not installed or not on PATH" \
      "install Docker Desktop or Docker Engine, then re-run scripts/start-local.sh"
  docker compose version >/dev/null 2>&1 \
    || fail "docker compose v2 is not available" \
      "install the Docker Compose plugin, then re-run scripts/start-local.sh"
  docker info >/dev/null 2>&1 \
    || fail "the Docker daemon is not running" \
      "start Docker, then re-run scripts/start-local.sh"
}

# Curated GGUF builds of BAAI/bge-small-en-v1.5. Sizes and digests are pinned
# to the exact files published by CompendiumLabs on Hugging Face.
default_manifest() {
  cat <<'EOF'
f32|bge-small-en-v1.5-f32.gguf|133609568|bf40c42ad7d89382e9ba7376d5c4b73f6b556cb541fab37aaa1da9c320149b65|https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-f32.gguf
q8|bge-small-en-v1.5-q8_0.gguf|36806944|ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514|https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf
q4|bge-small-en-v1.5-q4_k_m.gguf|24808576|363a0a4855dff6c653e06efe3209157debcf7f74e52d0d7c71e2747cd523043e|https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q4_k_m.gguf
f16|bge-small-en-v1.5-f16.gguf|67308128|f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999|https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-f16.gguf
EOF
}

manifest_line() {
  if [ -n "${TASKBOARDS_MODEL_MANIFEST:-}" ]; then
    [ -r "$TASKBOARDS_MODEL_MANIFEST" ] \
      || fail "TASKBOARDS_MODEL_MANIFEST is set but not readable: $TASKBOARDS_MODEL_MANIFEST" \
        "unset TASKBOARDS_MODEL_MANIFEST or point it at a readable manifest file"
    grep "^$1|" "$TASKBOARDS_MODEL_MANIFEST" | head -n 1
  else
    default_manifest | grep "^$1|" | head -n 1
  fi
}

# read_manifest_entry KEY: sets mf_file, mf_bytes, mf_sha, mf_url, mf_mb.
read_manifest_entry() {
  rme_line="$(manifest_line "$1")"
  [ -n "$rme_line" ] \
    || fail "model '$1' is missing from the model manifest" \
      "fix or unset TASKBOARDS_MODEL_MANIFEST, then re-run scripts/start-local.sh"
  mf_file="$(printf '%s' "$rme_line" | cut -d'|' -f2)"
  mf_bytes="$(printf '%s' "$rme_line" | cut -d'|' -f3)"
  mf_sha="$(printf '%s' "$rme_line" | cut -d'|' -f4)"
  mf_url="$(printf '%s' "$rme_line" | cut -d'|' -f5)"
  # The file name becomes part of host and container paths, so a manifest
  # must not be able to redirect the verified download outside the model dir.
  case "$mf_file" in
    ''|*/*|.*)
      fail "manifest entry '$1' has an unsafe file name: $mf_file" \
        "fix or unset TASKBOARDS_MODEL_MANIFEST, then re-run scripts/start-local.sh"
      ;;
  esac
  case "$mf_bytes" in
    ''|*[!0-9]*)
      fail "manifest entry '$1' has a non-numeric size: $mf_bytes" \
        "fix or unset TASKBOARDS_MODEL_MANIFEST, then re-run scripts/start-local.sh"
      ;;
  esac
  mf_mb=$(((mf_bytes + 1048575) / 1048576))
}

check_sha_tool() {
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
    || fail "neither sha256sum nor shasum is available to verify the model" \
      "install coreutils (sha256sum) or perl (shasum), then re-run scripts/start-local.sh"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# A GGUF file starts with the ASCII magic "GGUF".
validate_gguf() {
  [ -f "$1" ] && [ -s "$1" ] && [ "$(head -c 4 "$1" 2>/dev/null)" = "GGUF" ]
}

env_value() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1
}

# Values land unquoted in `.env`, where Docker Compose interpolates `$`,
# treats ` #` as a comment, and where quotes and backslashes change parsing.
# Rejecting those characters keeps the written value identical to the mounted
# one.
valid_path_input() {
  case "$1" in
    ''|*'$'*|*'#'*|*\\*|*'"'*|*"'"*) return 1 ;;
  esac
}

valid_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

config_is_valid() {
  cfg_port="$(env_value TASKBOARDS_PORT)"
  cfg_bind="$(env_value TASKBOARDS_BIND_ADDRESS)"
  cfg_data_dir="$(env_value TASKBOARDS_DATA_DIR)"
  cfg_uploads_dir="$(env_value TASKBOARDS_UPLOADS_DIR)"
  cfg_model_dir="$(env_value TASKBOARDS_MODEL_DIR)"
  cfg_model_file="$(env_value TASKBOARDS_MODEL_FILE)"
  [ -n "$cfg_port" ] && [ -n "$cfg_bind" ] && [ -n "$cfg_data_dir" ] \
    && [ -n "$cfg_uploads_dir" ] && [ -n "$cfg_model_dir" ] \
    && [ -n "$cfg_model_file" ] || return 1
  valid_port "$cfg_port" || return 1
  case "$cfg_bind" in
    127.0.0.1|0.0.0.0) ;;
    *) return 1 ;;
  esac
  validate_gguf "$cfg_model_dir/$cfg_model_file"
}

print_summary() {
  printf 'Configuration:\n'
  printf '  Port:        %s\n' "$cfg_port"
  printf '  Binding:     %s\n' "$cfg_bind"
  printf '  Data dir:    %s\n' "$cfg_data_dir"
  printf '  Uploads dir: %s\n' "$cfg_uploads_dir"
  printf '  Model:       %s/%s\n' "$cfg_model_dir" "$cfg_model_file"
}

# ask QUESTION DEFAULT: prints the prompt and sets `ans`, using DEFAULT for an
# empty answer or end of input.
ask() {
  printf '%s [%s]: ' "$1" "$2"
  IFS= read -r ans || ans=""
  [ -n "$ans" ] || ans="$2"
}

too_many_attempts() {
  fail "no valid answer after 5 attempts" \
    "re-run scripts/start-local.sh --reconfigure and answer the prompts again"
}

prompt_model() {
  read_manifest_entry f32
  pm_f32_mb="$mf_mb"
  read_manifest_entry q8
  pm_q8_mb="$mf_mb"
  read_manifest_entry q4
  pm_q4_mb="$mf_mb"
  read_manifest_entry f16
  pm_f16_mb="$mf_mb"
  pm_attempts=0
  while :; do
    pm_attempts=$((pm_attempts + 1))
    [ "$pm_attempts" -le 5 ] || too_many_attempts
    printf 'Embedding model for local semantic search:\n'
    printf '  1) F32 (default) - %s MB download, full precision; matches the Compose default\n' "$pm_f32_mb"
    printf '  2) Q8 - %s MB, near full quality, smaller download\n' "$pm_q8_mb"
    printf '  3) Q4 - %s MB, smallest download, slightly lower quality\n' "$pm_q4_mb"
    printf '  4) F16 - %s MB, half precision, between Q8 and F32\n' "$pm_f16_mb"
    printf '  5) Use an existing GGUF file on this machine\n'
    ask 'Choose a model' 1
    case "$ans" in
      1) read_manifest_entry f32 ;;
      2) read_manifest_entry q8 ;;
      3) read_manifest_entry q4 ;;
      4) read_manifest_entry f16 ;;
      5) prompt_custom_model; return 0 ;;
      *) printf 'Enter a number from 1 to 5.\n'; continue ;;
    esac
    model_download=1
    cfg_model_dir="./models-gguf"
    cfg_model_file="$mf_file"
    return 0
  done
}

prompt_custom_model() {
  pc_attempts=0
  while :; do
    pc_attempts=$((pc_attempts + 1))
    [ "$pc_attempts" -le 5 ] || too_many_attempts
    printf 'Path to an existing GGUF model file: '
    IFS= read -r pc_path || pc_path=""
    # Resolve symlinks so the recorded directory actually contains the model
    # bytes; a symlink target outside the mounted directory would be broken
    # inside the container.
    pc_resolved="$(readlink -f "$pc_path" 2>/dev/null || true)"
    [ -n "$pc_resolved" ] || pc_resolved="$pc_path"
    if ! validate_gguf "$pc_resolved"; then
      printf 'Not a readable GGUF file (expected the GGUF magic bytes): %s\n' "$pc_path"
      continue
    fi
    pc_dir="$(cd "$(dirname -- "$pc_resolved")" && pwd -P)"
    pc_file="$(basename -- "$pc_resolved")"
    if ! valid_path_input "$pc_dir" || ! valid_path_input "$pc_file"; then
      printf "The model path must not contain \$, #, quotes, or backslashes.\n"
      continue
    fi
    model_download=0
    cfg_model_dir="$pc_dir"
    cfg_model_file="$pc_file"
    return 0
  done
}

prompt_port() {
  pp_default="${cfg_port:-8142}"
  pp_attempts=0
  while :; do
    pp_attempts=$((pp_attempts + 1))
    [ "$pp_attempts" -le 5 ] || too_many_attempts
    ask 'Host port for the UI and API' "$pp_default"
    if valid_port "$ans"; then
      cfg_port="$ans"
      return 0
    fi
    printf 'Enter a port number between 1 and 65535.\n'
  done
}

prompt_bind() {
  pb_attempts=0
  while :; do
    pb_attempts=$((pb_attempts + 1))
    [ "$pb_attempts" -le 5 ] || too_many_attempts
    printf 'Network binding:\n'
    printf '  1) localhost only (recommended) - reachable from this machine\n'
    printf '  2) LAN (0.0.0.0) - reachable from your whole network\n'
    ask 'Choose a binding' 1
    case "$ans" in
      1)
        cfg_bind="127.0.0.1"
        return 0
        ;;
      2)
        printf 'WARNING: LAN mode exposes an UNAUTHENTICATED API. Anyone who can\n'
        printf 'reach this machine on the network can read and change every board.\n'
        printf "Type 'yes' to expose the app to the LAN: "
        IFS= read -r pb_confirm || pb_confirm=""
        if [ "$pb_confirm" = "yes" ]; then
          cfg_bind="0.0.0.0"
        else
          printf 'LAN mode not confirmed; keeping localhost binding.\n'
          cfg_bind="127.0.0.1"
        fi
        return 0
        ;;
      *) printf 'Enter 1 or 2.\n' ;;
    esac
  done
}

# ask_path QUESTION DEFAULT: like ask, but re-prompts until the answer is a
# safe `.env` path value.
ask_path() {
  ap_attempts=0
  while :; do
    ap_attempts=$((ap_attempts + 1))
    [ "$ap_attempts" -le 5 ] || too_many_attempts
    ask "$1" "$2"
    if valid_path_input "$ans"; then
      return 0
    fi
    printf "Paths must not contain \$, #, quotes, or backslashes.\n"
  done
}

prompt_dirs() {
  ask_path 'Data directory (SQLite database)' "${cfg_data_dir:-./data}"
  cfg_data_dir="$ans"
  ask_path 'Uploads directory' "${cfg_uploads_dir:-./uploads}"
  cfg_uploads_dir="$ans"
}

# Downloads the curated model to a temporary file next to the target, verifies
# the pinned size and digest, and renames it into place. The existing model
# file, if any, is only replaced by that final atomic rename.
ensure_curated_model() {
  [ "$model_download" -eq 1 ] || return 0
  check_sha_tool
  em_target="$cfg_model_dir/$cfg_model_file"
  mkdir -p "$cfg_model_dir" \
    || fail "cannot create model directory $cfg_model_dir" \
      "choose a writable model location, then re-run scripts/start-local.sh --reconfigure"
  if [ -f "$em_target" ]; then
    if [ "$(sha256_of "$em_target")" = "$mf_sha" ]; then
      printf 'Model %s already present and verified; skipping download.\n' "$em_target"
      return 0
    fi
    ask "Existing $em_target does not match the pinned digest. Re-download?" Y
    case "$ans" in
      [Yy]*) ;;
      *)
        fail "existing model file $em_target failed digest verification" \
          "re-run scripts/start-local.sh --reconfigure and pick a model, or remove the file: rm \"$em_target\""
        ;;
    esac
  fi
  command -v curl >/dev/null 2>&1 \
    || fail "curl is required to download the embedding model" \
      "install curl, then re-run scripts/start-local.sh"
  em_partial="$em_target.partial"
  trap 'rm -f "$em_partial"' EXIT
  trap 'rm -f "$em_partial"; exit 130' INT
  trap 'rm -f "$em_partial"; exit 143' TERM HUP
  printf 'Downloading %s (%s MB)...\n' "$cfg_model_file" "$mf_mb"
  if ! curl -fSL --retry 3 --connect-timeout 15 -o "$em_partial" "$mf_url"; then
    fail "model download failed from $mf_url" \
      "check your network connection, then re-run scripts/start-local.sh"
  fi
  em_actual_bytes=$(($(wc -c < "$em_partial")))
  [ "$em_actual_bytes" -eq "$mf_bytes" ] \
    || fail "downloaded model has wrong size (expected $mf_bytes bytes, got $em_actual_bytes)" \
      "re-run scripts/start-local.sh to retry the download"
  em_actual_sha="$(sha256_of "$em_partial")"
  [ "$em_actual_sha" = "$mf_sha" ] \
    || fail "downloaded model failed digest verification (expected $mf_sha, got $em_actual_sha)" \
      "re-run scripts/start-local.sh to retry the download"
  mv "$em_partial" "$em_target"
  trap - EXIT INT TERM HUP
  printf 'Installed %s.\n' "$em_target"
}

# set_env_var KEY VALUE: replaces the first `KEY=` line in `.env` (dropping
# duplicates), or appends the key. Comments, blank lines, and unrelated keys
# pass through unchanged.
set_env_var() {
  if [ ! -f .env ]; then
    printf '# Managed by scripts/start-local.sh; see .env.example for documentation.\n' > .env
  fi
  # Copy first so the temporary file inherits the mode of the existing .env,
  # which may hold user secrets tightened to 0600. The value goes through
  # ENVIRON because `awk -v` interprets backslash escapes.
  cp .env ".env.tmp.$$"
  SEV_KEY="$1" SEV_VAL="$2" awk '
    BEGIN { key = ENVIRON["SEV_KEY"]; val = ENVIRON["SEV_VAL"] }
    index($0, key "=") == 1 { if (!done) { print key "=" val; done = 1 }; next }
    { print }
    END { if (!done) print key "=" val }
  ' .env > ".env.tmp.$$" || { rm -f ".env.tmp.$$"; fail "failed to update .env" \
    "check that the repository root is writable, then re-run scripts/start-local.sh"; }
  mv ".env.tmp.$$" .env
}

write_env() {
  set_env_var TASKBOARDS_PORT "$cfg_port"
  set_env_var TASKBOARDS_BIND_ADDRESS "$cfg_bind"
  set_env_var TASKBOARDS_DATA_DIR "$cfg_data_dir"
  set_env_var TASKBOARDS_UPLOADS_DIR "$cfg_uploads_dir"
  set_env_var TASKBOARDS_MODEL_DIR "$cfg_model_dir"
  set_env_var TASKBOARDS_MODEL_FILE "$cfg_model_file"
}

create_dirs() {
  for cd_dir in "$cfg_data_dir" "$cfg_uploads_dir" "$cfg_model_dir"; do
    mkdir -p "$cd_dir" \
      || fail "cannot create directory $cd_dir" \
        "choose a writable location with scripts/start-local.sh --reconfigure"
  done
}

reconfigure=0
for arg in "$@"; do
  shift
  case "$arg" in
    --reconfigure) reconfigure=1 ;;
    -h|--help) usage; exit 0 ;;
    *) set -- "$@" "$arg" ;;
  esac
done

check_prereqs

if [ "$reconfigure" -eq 0 ] && config_is_valid; then
  printf 'Reusing the existing configuration from .env.\n'
  printf 'Run scripts/start-local.sh --reconfigure to change it.\n'
else
  # Seed prompt defaults from any existing .env values.
  cfg_port="$(env_value TASKBOARDS_PORT)"
  cfg_data_dir="$(env_value TASKBOARDS_DATA_DIR)"
  cfg_uploads_dir="$(env_value TASKBOARDS_UPLOADS_DIR)"
  valid_port "${cfg_port:-}" || cfg_port=""
  model_download=0
  prompt_model
  prompt_port
  prompt_bind
  prompt_dirs
  # Ensure the model before writing .env so a failed download leaves the
  # previous configuration untouched.
  ensure_curated_model
  write_env
fi

print_summary
create_dirs
if [ "$cfg_bind" = "0.0.0.0" ]; then
  printf 'Starting Agent Taskboards in release mode on http://<this-machine>:%s\n' "$cfg_port"
else
  printf 'Starting Agent Taskboards in release mode on http://localhost:%s\n' "$cfg_port"
fi
# Shell environment overrides `.env` in Compose, so export the resolved
# settings explicitly; otherwise inherited TASKBOARDS_* variables could launch
# a configuration that differs from the one displayed and validated above
# (including an unacknowledged LAN binding).
export TASKBOARDS_PORT="$cfg_port"
export TASKBOARDS_BIND_ADDRESS="$cfg_bind"
export TASKBOARDS_DATA_DIR="$cfg_data_dir"
export TASKBOARDS_UPLOADS_DIR="$cfg_uploads_dir"
export TASKBOARDS_MODEL_DIR="$cfg_model_dir"
export TASKBOARDS_MODEL_FILE="$cfg_model_file"
export TASKBOARDS_DEBUG=
exec docker compose up --build "$@"
