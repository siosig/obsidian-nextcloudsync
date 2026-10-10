# Runs as PID 1 ahead of Android's init, on the one binary this image can execute that early.
#
# init aborts the boot unless it can write three host-wide sysctls. Each gets a private file bound
# over it: init writes and reads back its own value, and the host keeps the value it had.
set -eu
bb=/suite/busybox
$bb mkdir -p /suite/sysctl
for key in kernel/kptr_restrict vm/mmap_rnd_bits vm/mmap_rnd_compat_bits; do
  private="/suite/sysctl/${key##*/}"
  $bb cat "/proc/sys/$key" > "$private"
  $bb mount -o bind "$private" "/proc/sys/$key"
done
exec /init qemu=1 androidboot.hardware=redroid "$@"
