#!/usr/bin/env bash
# The single entry point of the Docker test suite.
#   bash tests/docker/run.sh <a|b1|b2|b3|b4|all>
#
# Exit codes (see specs/092-docker-test-suite/contracts/run-cli.md):
#   0 passed   1 tests failed   2 environment preparation failed
#   3 prerequisite missing (could not run)   130 interrupted
# Never use `set -x` and never print `docker compose config`: per-run secrets live in this
# shell's environment and in the compose project only.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
suite="$repo/tests/docker"
project=ncs-suite
cache_volumes=(ncs-suite-cache-obsidian ncs-suite-cache-obsidian-android)
min_compose=2.23.1

usage() { echo "usage: bash tests/docker/run.sh <a|b1|b2|b3|b4|all>" >&2; exit 3; }
die() { local code=$1; shift; echo "run.sh: $*" >&2; exit "$code"; }

[ "$#" -eq 1 ] || usage
case "$1" in a|b1|b2|b3|b4|all) layer_arg="$1" ;; *) usage ;; esac

compose() { docker compose -f "$suite/compose.yml" -p "$project" "$@"; }

# ------------------------------------------------------------ prerequisites (exit 3)

check_host() {
  local cmd
  for cmd in docker flock base64 sha256sum git; do
    command -v "$cmd" >/dev/null 2>&1 || die 3 "'$cmd' is required on the host"
  done
  docker info >/dev/null 2>&1 || die 3 "the Docker daemon is not reachable"
  local have
  have="$(docker compose version --short 2>/dev/null || true)"
  [ -n "$have" ] || die 3 "Docker Compose v2 is required (>= $min_compose)"
  [ "$(printf '%s\n%s\n' "$min_compose" "${have#v}" | sort -V | head -n1)" = "$min_compose" ] \
    || die 3 "Docker Compose $have is older than $min_compose"
  [ -d "$repo/.git" ] || die 3 "run this from a normal clone: git worktrees are not supported"
}

check_binder() {
  grep -qw binder /proc/filesystems \
    || die 3 "binder is not available on this host (kernel module binder_linux); see tests/README.md"
}

# ------------------------------------------------------------ image tags (R-11)

hash_files() {
  [ "$#" -gt 0 ] || die 2 "no files to hash for an image tag"
  cat "$@" | sha256sum | cut -c1-12
}
# Tracked plus untracked-but-not-ignored files, so the tag is right before the first commit too.
list_files() { git ls-files -co --exclude-standard -- "$@" | LC_ALL=C sort; }

compute_tags() {
  cd "$repo"
  SUITE_RUNNER_TAG="$(hash_files tests/docker/runner/Dockerfile tests/docker/runner/Dockerfile.dockerignore package.json pnpm-lock.yaml pnpm-workspace.yaml)"
  # shellcheck disable=SC2046
  SUITE_NEXTCLOUD_TAG="$(hash_files $(list_files tests/docker/nextcloud))"
  # shellcheck disable=SC2046
  SUITE_WEBDAV_TAG="$(hash_files $(list_files tests/b4-plain-webdav/docker))"
  export SUITE_RUNNER_TAG SUITE_NEXTCLOUD_TAG SUITE_WEBDAV_TAG
}

ensure_image() { # <service> <image-name> <tag>
  local service=$1 name=$2 tag=$3
  if ! docker image inspect "$name:$tag" >/dev/null 2>&1; then
    # Compose interpolates every service in the file even for a build; the run-only variables are
    # placeholders here and have no effect on the image.
    SUITE_CA_HASH=build-only SUITE_CA_CERT_PEM= SUITE_TLS_CERT_PEM= SUITE_TLS_KEY_PEM= \
    SUITE_NC_ADMIN_PASSWORD= SUITE_NC_USER2_PASSWORD= SUITE_NC_DB_PASSWORD= \
      compose build "$service" >&2 || die 2 "building image $name:$tag failed"
    docker image ls --format '{{.Repository}}:{{.Tag}}' "$name" | grep -v ":$tag\$" | xargs -r docker image rm >/dev/null 2>&1 || true
  fi
}

ensure_images_for() { # <layer>
  case "$1" in
    b4) ensure_image webdav ncs-suite-webdav "$SUITE_WEBDAV_TAG" ;;
    b1|b2|b3) ensure_image nc-app ncs-suite-nextcloud "$SUITE_NEXTCLOUD_TAG" ;;
  esac
  ensure_image runner ncs-suite-runner "$SUITE_RUNNER_TAG"
}

# ------------------------------------------------------------ cleanup (R-13)

cleanup() {
  compose --profile '*' down -v --remove-orphans --timeout 10 >/dev/null 2>&1 || true
}
on_exit() { local rc=$?; trap - EXIT; cleanup; exit "$rc"; }
on_signal() { trap - EXIT; cleanup; exit 130; }

# ------------------------------------------------------------ per-run material (R-5)

load_run_material() {
  local line name value
  while IFS= read -r line; do
    name="${line%%=*}"; value="$(printf '%s' "${line#*=}" | base64 -d)"
    printf -v "$name" '%s' "$value"
    export "${name?}"
  done < <(docker run --rm --network none -v "$suite/runner/bin:/b:ro" --entrypoint bash "ncs-suite-runner:$SUITE_RUNNER_TAG" /b/gen-run-material.sh) \
    || die 2 "generating the run material failed"
  [ -n "${SUITE_NC_ADMIN_PASSWORD:-}" ] || die 2 "run material is incomplete"
}

mask_secrets() { # stdin -> stdout
  local text secret
  text="$(cat)"
  for secret in "$SUITE_NC_ADMIN_PASSWORD" "$SUITE_NC_USER2_PASSWORD" "$SUITE_NC_DB_PASSWORD"; do
    text="${text//"$secret"/***}"
  done
  printf '%s\n' "$text"
}

save_host_diagnostics() { # failed b3 run
  local dir="$SUITE_OUT_DIR/host" svc
  mkdir -p "$dir"
  for svc in redroid nc-app nc-edge nc-fsops; do
    compose logs --no-color "$svc" 2>&1 | mask_secrets >"$dir/$svc.log" || true
  done
  local cid
  cid="$(compose ps -a -q redroid 2>/dev/null || true)"
  [ -z "$cid" ] || docker inspect -f 'OOMKilled={{.State.OOMKilled}}' "$cid" >"$dir/redroid-state.txt" 2>&1 || true
}

# ------------------------------------------------------------ one layer

run_layer() { # <layer>
  local layer=$1 profiles=() rc=0
  case "$layer" in
    b4) profiles=(--profile webdav) ;;
    b1|b2) profiles=(--profile nc) ;;
    b3) profiles=(--profile nc --profile android) ;;
  esac

  SUITE_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$layer"
  SUITE_OUT_DIR="$repo/.test-output/$SUITE_RUN_ID"
  SUITE_HOST_UID="$(id -u)"; SUITE_HOST_GID="$(id -g)"
  export SUITE_RUN_ID SUITE_OUT_DIR SUITE_HOST_UID SUITE_HOST_GID
  mkdir -p "$SUITE_OUT_DIR"

  ensure_images_for "$layer"
  load_run_material

  if [ "${#profiles[@]}" -gt 0 ]; then
    compose "${profiles[@]}" up -d --wait >&2 || { cleanup; die 2 "starting the services for $layer failed"; }
  fi

  compose --profile runner run --rm runner "$layer" || rc=$?
  [ "$rc" -eq 0 ] || { [ "$layer" != b3 ] || save_host_diagnostics; }

  cleanup
  if [ "$rc" -eq 0 ]; then
    rm -rf "$SUITE_OUT_DIR"
  else
    echo "run.sh: layer $layer failed (rc=$rc); diagnostics kept in $SUITE_OUT_DIR" >&2
  fi
  return "$rc"
}

# ------------------------------------------------------------ main

check_host
case "$layer_arg" in b3|all) check_binder ;; esac

mkdir -p "$repo/.test-output"
exec 9>"$repo/.test-output/.lock"
flock -n 9 || die 3 "another run of the suite is in progress"

trap on_exit EXIT
trap on_signal INT TERM

# A previous run that died hard may have left its project behind.
if [ -n "$(compose --profile '*' ps -a -q 2>/dev/null || true)" ]; then cleanup; fi

for vol in "${cache_volumes[@]}"; do docker volume inspect "$vol" >/dev/null 2>&1 || docker volume create "$vol" >/dev/null; done
compute_tags

if [ "$layer_arg" = all ]; then
  for layer in a b4 b1 b2 b3; do
    echo "run.sh: ===== layer $layer =====" >&2
    rc=0; run_layer "$layer" || rc=$?
    [ "$rc" -eq 0 ] || exit "$rc"
  done
else
  rc=0; run_layer "$layer_arg" || rc=$?
  exit "$rc"
fi
