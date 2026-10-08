# Nextcloud image for the local Docker test suite (ncs-suite).
#
# files_lock, files_versions and files_trashbin are bundled with the upstream
# image (/usr/src/nextcloud/apps), so nothing is downloaded here: the
# post-installation hook only enables them.
FROM nextcloud:34-apache

# Runs once, right after `occ maintenance:install` (the official entrypoint
# executes it as www-data). It must be executable or the entrypoint skips it.
COPY --chmod=0755 hooks/post-installation/10-suite.sh /docker-entrypoint-hooks.d/post-installation/10-suite.sh

# HTTP endpoint used by the b-1 "N actor" sidecar (nc-fsops), served with
# `php -S 0.0.0.0:8080 /opt/fsops/router.php` from this same image. The
# directory is created first because `COPY --chmod` would otherwise apply 0644
# to the parent it creates, making it untraversable for www-data.
RUN install -d -m 0755 /opt/fsops
COPY --chmod=0644 fsops/router.php /opt/fsops/router.php
