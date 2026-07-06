#!/usr/bin/env bash
# Feature 050: run the b1 (live Nextcloud, headless) suite in PARALLEL against the ephemeral
# nextcloud-testinstance GCE instance instead of a single localhost Docker Nextcloud.
#
# It reads the connection from nextcloud-testinstance/.run/connection.json (produced by `make up`),
# points the b1 env at it (NEXTCLOUD_SERVER_URL/USER/PASSWORD win over .env via process.env), and skips
# the instance's self-signed (`tls internal`) certificate. Bring the instance up first:
#   ( cd "$INSTANCE_DIR" && make up && make status )
# then run this, then tear the instance down:
#   ( cd "$INSTANCE_DIR" && make down )
# The ephemeral external IP changes on every `make up`; reading connection.json here means the b1 env
# always follows the current instance with no manual .env edit.
set -euo pipefail

# INSTANCE_DIR is the canonical name; CLUSTER_DIR stays supported for backward compatibility.
INSTANCE_DIR="${INSTANCE_DIR:-${CLUSTER_DIR:-$HOME/workspace/siosig/nextcloud-testinstance}}"
CONN="$INSTANCE_DIR/.run/connection.json"
WORKERS="${B1_WORKERS:-12}"

if [ ! -f "$CONN" ]; then
  echo "ERROR: $CONN not found. Bring the instance up first: ( cd $INSTANCE_DIR && make up )" >&2
  exit 1
fi

NEXTCLOUD_SERVER_URL="$(jq -r .dav_base_url "$CONN")"
NEXTCLOUD_USER="$(jq -r .admin_user "$CONN")"
NEXTCLOUD_PASSWORD="$(jq -r .admin_password "$CONN")"
export NEXTCLOUD_SERVER_URL NEXTCLOUD_USER NEXTCLOUD_PASSWORD
export NEXTCLOUD_VAULT_NAME=""                 # operate under the admin WebDAV root
export NODE_TLS_REJECT_UNAUTHORIZED=0          # instance uses a self-signed certificate (tls internal)
# Feature 051: the "N" actor (direct server-FS change + occ files:scan) needs SSH + the data dir.
NEXTCLOUD_SSH_TARGET="$(jq -r .ssh_target "$CONN")"
NEXTCLOUD_DATA_HOST="$(jq -r .data_host "$CONN")"
export NEXTCLOUD_SSH_TARGET NEXTCLOUD_DATA_HOST

# The perf benchmark (etagSkip.perf) is tuned for localhost latency and is meaningless over the WAN
# hop from the control node to the VM's external IP — exclude it by default. Set B1_INCLUDE_PERF=1 to
# keep it (only sensible from `make test-remote` on the VM itself).
IGNORE=()
if [ "${B1_INCLUDE_PERF:-0}" != "1" ]; then IGNORE=(--testPathIgnorePatterns '/perf/'); fi

echo "b1 → ${NEXTCLOUD_SERVER_URL}  (user=${NEXTCLOUD_USER}, workers=${WORKERS}, perf=${B1_INCLUDE_PERF:-0})"
exec ./node_modules/.bin/jest --config jest.b1.config.js --maxWorkers="${WORKERS}" "${IGNORE[@]}" "$@"
