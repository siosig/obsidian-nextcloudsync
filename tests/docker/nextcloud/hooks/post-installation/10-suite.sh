#!/bin/sh
# Post-installation hook for the ncs-suite Nextcloud image.
#
# The official entrypoint runs this once, right after `occ maintenance:install`,
# as www-data. Every step must succeed: any failure exits non-zero, which makes
# the entrypoint fail and keeps the readiness marker (step 7) from being written,
# so the container never turns healthy on a half-initialised instance.
#
# Secrets are never placed on a command line and never printed.
set -eu

OCC=/var/www/html/occ
USER2=ncuser2
USER2_PASSWORD_FILE=/run/secrets/nc_user2_password
READY_MARKER=/var/www/html/data/.suite-ready

log() {
  printf '[10-suite] %s\n' "$*"
}

fail() {
  printf '[10-suite] ERROR: %s\n' "$*" >&2
  exit 1
}

# Run occ as www-data. The entrypoint already drops to www-data before running
# hooks; the root branch is a safeguard. Arguments are passed positionally (not
# interpolated into a command string), and `su -p` keeps the environment so
# OC_PASS reaches occ without touching argv.
occ() {
  if [ "$(id -u)" = 0 ]; then
    # shellcheck disable=SC2016 # "$0"/"$@" are expanded by the inner shell.
    su -p -s /bin/sh -c 'exec php "$0" "$@"' www-data "$OCC" "$@"
  else
    php "$OCC" "$@"
  fi
}

# 1. Apps required by the suite (all bundled with the upstream image).
log "enabling files_lock, files_versions, files_trashbin"
occ app:enable files_lock files_versions files_trashbin

# 2. Transactional file locking through Redis.
log "configuring memcache.locking"
occ config:system:set memcache.locking --value='\OC\Memcache\Redis'

# 3. Trust the reverse proxy (TLS edge) on any private network address.
log "configuring trusted_proxies"
occ config:system:set trusted_proxies 0 --value=10.0.0.0/8
occ config:system:set trusted_proxies 1 --value=172.16.0.0/12
occ config:system:set trusted_proxies 2 --value=192.168.0.0/16

# 4. Clients reach the instance through the TLS edge only.
log "configuring overwriteprotocol and overwrite.cli.url"
occ config:system:set overwriteprotocol --value=https
occ config:system:set overwrite.cli.url --value=https://nc.test

# 5. Second account (used by sharing / server-lock tests).
[ -r "$USER2_PASSWORD_FILE" ] || fail "$USER2_PASSWORD_FILE is missing or unreadable"
if occ user:info "$USER2" >/dev/null 2>&1; then
  log "user $USER2 already exists; skipping creation"
else
  log "creating user $USER2"
  OC_PASS="$(cat "$USER2_PASSWORD_FILE")"
  [ -n "$OC_PASS" ] || fail "$USER2_PASSWORD_FILE is empty"
  export OC_PASS
  occ user:add --password-from-env --display-name="$USER2" "$USER2"
  unset OC_PASS
fi

# 6. Verify the resulting state.
log "verifying"
# shellcheck disable=SC2016 # PHP source, not shell.
occ app:list --output=json | php -r '
$apps = json_decode(stream_get_contents(STDIN), true);
foreach (["files_lock", "files_versions", "files_trashbin"] as $app) {
    if (!is_array($apps) || !isset($apps["enabled"][$app])) {
        fwrite(STDERR, "[10-suite] ERROR: app not enabled: $app\n");
        exit(1);
    }
}
'
locking="$(occ config:system:get memcache.locking)"
case "$locking" in
  *Redis*) ;;
  *) fail "memcache.locking is not Redis" ;;
esac
occ user:info "$USER2" >/dev/null || fail "user $USER2 does not exist"

# 7. Readiness marker checked by the container healthcheck.
touch "$READY_MARKER"
log "ready"
