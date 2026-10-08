#!/usr/bin/env bash
# Runner entry point: runs ONE test layer inside the runner container.
# Invoked as `docker compose run --rm runner <a|b1|b2|b3|b4>` by tests/docker/run.sh.
#
# Exit codes (see specs/092-docker-test-suite/contracts/suite-entry.md):
#   0 tests passed   1 tests failed   2 environment preparation failed
# Never use `set -x` here: secrets pass through this script's environment.
set -euo pipefail

# Tuned by measurement (specs/092-docker-test-suite/impl-notes.md); not user-configurable.
readonly B1_MAX_WORKERS=8
readonly B3_TEST_TIMEOUT_SECONDS=3600
readonly ANDROID_WAIT_SECONDS=300
readonly EXPECTED_ANDROID_API=33

layer="${1:-}"
out_dir=/out

fail_env() { echo "suite-entry: $*" >&2; exit 2; }

# Mask the two secrets that reach this container, then hand ownership of /out back to the host user.
finish() {
  local rc=$?
  set +e
  local secret f
  for secret in "$(cat /run/secrets/nc_admin_password 2>/dev/null)" "$(cat /run/secrets/nc_user2_password 2>/dev/null)"; do
    [ -n "$secret" ] || continue
    grep -rlF -- "$secret" "$out_dir" 2>/dev/null | while IFS= read -r f; do
      sed -i "s/$secret/***/g" "$f"
    done
  done
  chown -R "${SUITE_HOST_UID:-0}:${SUITE_HOST_GID:-0}" "$out_dir" 2>/dev/null
  exit "$rc"
}
trap finish EXIT

copy_source() {
  git -c safe.directory='*' -C /src ls-files -z -co --exclude-standard \
    | tar -C /src --null -T - -cf - | tar -C /work -xf -
  # specs/ is gitignored but one a-layer test reads a mockup under it.
  tar -C /src -cf - specs | tar -C /work -xf -
  if compgen -G "/work/.env" >/dev/null || compgen -G "/work/.env.*" >/dev/null; then
    fail_env "an .env file reached the work directory; the suite never reads .env"
  fi
}

load_secrets() {
  if [ -r /run/secrets/nc_admin_password ]; then NEXTCLOUD_PASSWORD="$(cat /run/secrets/nc_admin_password)"; export NEXTCLOUD_PASSWORD; fi
  if [ -r /run/secrets/nc_user2_password ]; then NEXTCLOUD_PASSWORD2="$(cat /run/secrets/nc_user2_password)"; export NEXTCLOUD_PASSWORD2; fi
}

wait_nextcloud() {
  local i
  for i in $(seq 1 30); do
    if curl --cacert /run/suite/ca.crt -fsS https://nc.test/status.php 2>/dev/null | grep -q '"installed":true'; then
      return 0
    fi
    sleep 2
  done
  fail_env "Nextcloud did not answer over TLS with the run CA within 60 seconds"
}

# ---------------------------------------------------------------- layers

run_a() {
  cd /work
  pnpm test
}

run_b4() {
  cd /work
  local i code
  for i in $(seq 1 40); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X PROPFIND -H 'Depth: 0' -u "$B4_USER:$B4_PASSWORD" "$B4_SERVER_URL" || true)"
    [ "$code" = 207 ] && break
    sleep 0.25
  done
  [ "$code" = 207 ] || fail_env "plain WebDAV server did not answer PROPFIND Depth:0 with 207"
  # The fixture must refuse Depth:infinity; a 207 would silently change what the tests exercise.
  code="$(curl -s -o /dev/null -w '%{http_code}' -X PROPFIND -H 'Depth: infinity' -u "$B4_USER:$B4_PASSWORD" "$B4_SERVER_URL" || true)"
  [ "$code" != 207 ] || fail_env "plain WebDAV server accepted Depth:infinity"
  pnpm test:b4
}

run_b1() {
  cd /work
  local rc=0
  pnpm exec jest --config jest.b1.config.js --maxWorkers="$B1_MAX_WORKERS" --testPathIgnorePatterns '/perf/' || rc=1
  pnpm exec jest --config jest.b1.config.js --runInBand --testPathPatterns '/perf/' || rc=1
  return "$rc"
}

run_b2() {
  cd /work
  local nssdb="$HOME/.pki/nssdb"
  mkdir -p "$nssdb"
  certutil -d "sql:$nssdb" -N --empty-password
  certutil -d "sql:$nssdb" -A -t "C,," -n ncs-suite -i /run/suite/ca.crt
  pnpm build || fail_env "pnpm build failed"
  xvfb-run -a pnpm test:b2
}

adb_serial_ready() {
  adb -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | grep -qx 1 \
    && adb -s "$ANDROID_SERIAL" shell pm list packages >/dev/null 2>&1
}

prepare_android() {
  mkdir -p "$out_dir/b3"
  local deadline=$((SECONDS + ANDROID_WAIT_SECONDS))
  until adb connect "$ANDROID_SERIAL" 2>/dev/null | grep -q connected; do
    echo "adb connect retry at ${SECONDS}s" >>"$B3_RETRY_RECORD"
    [ "$SECONDS" -lt "$deadline" ] || fail_env "adb could not connect to $ANDROID_SERIAL"
    sleep 2
  done
  until adb_serial_ready; do
    echo "boot wait retry at ${SECONDS}s" >>"$B3_RETRY_RECORD"
    [ "$SECONDS" -lt "$deadline" ] || fail_env "Android did not finish booting"
    sleep 2
  done
  local api
  api="$(adb -s "$ANDROID_SERIAL" shell getprop ro.build.version.sdk | tr -d '\r')"
  [ "$api" = "$EXPECTED_ANDROID_API" ] || fail_env "Android API level is '$api', expected $EXPECTED_ANDROID_API"
  adb -s "$ANDROID_SERIAL" shell ls "/system/etc/security/cacerts/${SUITE_CA_HASH}.0" >/dev/null 2>&1 \
    || fail_env "the run CA is not visible in the Android system trust store"
  export ANDROID_API_LEVEL="$api" ANDROID_CA_INJECTED=true
}

write_b3_diagnostics() {
  {
    echo "== adb devices"; adb devices 2>&1
    echo "== meminfo (head)"; adb -s "$ANDROID_SERIAL" shell cat /proc/meminfo 2>&1 | head -5
    echo "== logcat lmkd/am_kill (tail)"; adb -s "$ANDROID_SERIAL" logcat -d 2>&1 | grep -E 'lmkd|am_kill' | tail -200
    echo "== packages"; adb -s "$ANDROID_SERIAL" shell pm list packages 2>&1 | grep -iE 'obsidian|appium'
  } >"$out_dir/b3/host-diagnostics.txt" 2>&1 || true
}

run_b3() {
  cd /work
  pnpm build || fail_env "pnpm build failed"
  prepare_android
  local rc=0
  timeout "$B3_TEST_TIMEOUT_SECONDS" pnpm test:b3 || rc=$?
  if [ "$rc" -ne 0 ]; then
    write_b3_diagnostics
    [ "$rc" -eq 124 ] && fail_env "b-3 timed out after ${B3_TEST_TIMEOUT_SECONDS}s"
    return 1
  fi
}

# ---------------------------------------------------------------- dispatch

case "$layer" in a|b1|b2|b3|b4) ;; *) fail_env "unknown layer '$layer' (expected a|b1|b2|b3|b4)" ;; esac

[ -z "${NODE_TLS_REJECT_UNAUTHORIZED:-}" ] || fail_env "NODE_TLS_REJECT_UNAUTHORIZED must not be set; the suite trusts the run CA instead"

copy_source
load_secrets
case "$layer" in b1|b2|b3) wait_nextcloud ;; esac

rc=0
"run_$layer" || rc=$?
# Anything non-zero that was not already an environment failure (exit 2 above) is a test failure.
[ "$rc" -eq 0 ] || exit 1
