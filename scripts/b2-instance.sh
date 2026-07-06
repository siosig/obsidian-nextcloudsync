#!/usr/bin/env bash
# Run the b2 (real Obsidian UI, wdio) smoke suite against the ephemeral nextcloud-testinstance GCE
# instance. Mirrors scripts/b1-cluster.sh: it reads the connection from
# nextcloud-testinstance/.run/connection.json (produced by `make up`) and points the b2 env at it.
#
# b2's smoke suite only needs NEXTCLOUD_* to be PRESENT (it seeds/saves settings and checks a status
# surfaces); it does not depend on a working TLS round-trip, so the instance's self-signed cert is
# fine. The plugin under test is the repo-root build output (main.js), so build first:
#   pnpm build
# Bring the instance up first, then run this, then tear it down:
#   ( cd "$INSTANCE_DIR" && make up && make status )
#   ( cd "$INSTANCE_DIR" && make down )
# The ephemeral external IP changes on every `make up`; reading connection.json here means the b2 env
# always follows the current instance with no manual .env edit.
set -euo pipefail

# INSTANCE_DIR is the canonical name; CLUSTER_DIR stays supported for backward compatibility.
INSTANCE_DIR="${INSTANCE_DIR:-${CLUSTER_DIR:-$HOME/workspace/siosig/nextcloud-testinstance}}"
CONN="$INSTANCE_DIR/.run/connection.json"

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

echo "b2 → ${NEXTCLOUD_SERVER_URL}  (user=${NEXTCLOUD_USER})"
# Linux/CI needs a display; wrap wdio in xvfb-run when one is available (a real display works too).
if command -v xvfb-run >/dev/null 2>&1 && [ -z "${DISPLAY:-}" ]; then
  exec xvfb-run -a ./node_modules/.bin/wdio run wdio.conf.mts "$@"
fi
exec ./node_modules/.bin/wdio run wdio.conf.mts "$@"
