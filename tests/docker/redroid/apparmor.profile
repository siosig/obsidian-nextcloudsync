# AppArmor profile for the Android (Redroid) container of the test suite.
#
# Redroid runs privileged, and Android's init treats the kernel it sees as its own: it writes
# kernel.* and vm.* sysctls, changes owners and modes under /proc and /sys, and mounts tracefs and
# debugfs with options. None of that is namespaced, so without this profile every boot rewrites the
# host. The profile leaves the container unrestricted except for that host-wide surface.
#
# Writes under /proc and /sys are an allowlist: only what belongs to the container's own namespaces
# is writable. AppArmor treats chmod and chown as writes, so this covers owners and modes too.
#
# It guards against what Android does on its own, not against hostile code: root in a privileged
# container has other ways out. The host must load it before the suite can start Android
# (tests/README.md), and run.sh compares the host's state before and after each Android run.
#
# Raise the number in the profile name with every change to the rules. run.sh asks for exactly this
# name, so a host that still carries the previous rules is refused before Android starts.

profile ncs-suite-redroid-1 flags=(attach_disconnected,mediate_deleted) {
  capability,
  # The wall clock, the kernel's time zone and the set of loaded modules are the host's.
  deny capability sys_time,
  deny capability sys_module,
  network,
  signal,
  ptrace,
  pivot_root,
  umount,
  mount,

  # A second mount of these reconfigures the one host-wide instance (init passes gid= and mode=).
  deny mount fstype=tracefs,
  deny mount fstype=debugfs,
  # Host-wide and not needed by the suite.
  deny mount fstype=configfs,
  deny mount fstype=binfmt_misc,
  deny mount fstype=securityfs,
  deny mount fstype=devtmpfs,
  # init mounts a fresh procfs over /proc at boot, which would hide the private files the entrypoint
  # binds there, and a fresh procfs or sysfs anywhere else would sit outside the path rules below.
  # Bind mounts of the existing two are not blocked; Android makes none.
  deny mount fstype=proc,
  deny mount fstype=sysfs,
  deny umount /proc/**,

  # Everything outside /proc and /sys.
  / rwlk,
  /{[^ps]**,p,p[^r]**,pr,pr[^o]**,pro,pro[^c]**,proc[^/]**,s,s[^y]**,sy,sy[^s]**,sys[^/]**} rwlkmix,

  /proc/ r,
  /proc/** r,
  /sys/ r,
  /sys/** r,

  # Per-process entries; /proc/self, /proc/thread-self and /proc/net resolve to these.
  /proc/[0-9]*/** rwlk,
  # Network sysctls belong to the container's network namespace.
  /proc/sys/net/** w,
  # init aborts unless it can write these; the entrypoint binds a private file over each.
  /proc/sys/kernel/kptr_restrict w,
  /proc/sys/vm/mmap_rnd_bits w,
  /proc/sys/vm/mmap_rnd_compat_bits w,
  # lmkd registers its memory-pressure triggers here; a trigger lives only as long as its file handle.
  # The image drops init's chown and chmod of this file, which would outlive the container.
  /proc/pressure/memory w,

  # The container's own cgroup subtree and its own bpffs instance.
  /sys/fs/cgroup/ rw,
  /sys/fs/cgroup/** rwlk,
  /sys/fs/bpf/ rw,
  /sys/fs/bpf/** rwlk,
}
