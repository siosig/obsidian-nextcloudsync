# Android (Redroid) image for the local Docker test suite (ncs-suite).
#
# The container runs privileged under the AppArmor profile next to this file, which stops Android from
# rewriting host-wide kernel state. The image only adds what Android needs to boot under that profile.
FROM busybox:1.38.0-musl@sha256:ea2b9914a16a4ac1981994af97b318f7c7d4db76b580c56177f08bf76f4a0be8 AS tools

FROM redroid/redroid:13.0.0-latest@sha256:41e5f0c1ff27a4a474c474e5595168cedf6c40fc5dd102c5617f48c80f511e9e AS android

# The profile lets lmkd open /proc/pressure/memory for writing, and to AppArmor a chown or chmod is a
# write too, so init must not be the one to change that file's owner and mode. lmkd does not need it.
FROM tools AS init-rc
COPY --from=android /system/etc/init/hw/init.rc /init.rc
RUN [ "$(grep -cE '^ +(chown system system|chmod 0664) /proc/pressure/memory$' /init.rc)" = 2 ] \
 && sed -i -E '\#^ +(chown system system|chmod 0664) /proc/pressure/memory$#d' /init.rc

FROM android
COPY --from=tools /bin/busybox /suite/busybox
COPY entrypoint.sh /suite/entrypoint.sh
COPY --from=init-rc /init.rc /system/etc/init/hw/init.rc
ENTRYPOINT ["/suite/busybox", "sh", "/suite/entrypoint.sh"]
