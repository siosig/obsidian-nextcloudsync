# Test suite layout (spec-driven)

The suite is organised by **classification**, and the folders mirror it 1:1. The
goal: when a test fails, its spec tag tells you *which clause* to adjudicate —
spec is the source of truth; a deviation is fixed in code, or the clause is
updated (waiver) if the implementation is intentionally the canonical one.

| Folder | Class | Needs Nextcloud | Needs UI | Command | CI |
|---|---|:--:|:--:|---|:--:|
| `a-no-nextcloud/` | a | ✗ | ✗ | `bash tests/docker/run.sh a` (or `pnpm test` on a machine with Node) | ✓ |
| `b1-nextcloud-headless/` | b-1 | ✓ | ✗ | `bash tests/docker/run.sh b1` | ✗ |
| `b2-nextcloud-ui/` | b-2 | ✓ | ✓ (wdio, desktop Electron) | `bash tests/docker/run.sh b2` | ✗ |
| `b3-android-ui/` | b-3 | ✓ | ✓ (wdio + Appium, Android) | `bash tests/docker/run.sh b3` | ✗ |
| `b4-plain-webdav/` | b-4 | **✗ (deliberately NOT Nextcloud)** | ✗ | `bash tests/docker/run.sh b4` | ✗ |
| `fixtures/` | shared | — | — | — | — |

## Running the suite (Docker only)

Every layer runs in containers through one entry point, `tests/docker/run.sh`. Nothing else is
installed on the host: the runner image carries Node, pnpm, a JDK, the Android platform tools and
Xvfb, and the Nextcloud, WebDAV and Android services are containers too.

```
bash tests/docker/run.sh <a|b1|b2|b3|b4|all>     # `all` = a, b4, b1, b2, b3 in that order
bash tests/docker/run.sh --changed <layer|all>   # skip a layer that already passed on exactly this working tree
```

**Host prerequisites**: Docker with Compose 2.23.1 or newer. `b3` and `all` also need two things from
the host, because the Android runtime is a Redroid container (it needs no hardware virtualisation):

- the kernel's `binder` support (the `binder_linux` module) — `grep -w binder /proc/filesystems` must
  print a line;
- AppArmor, with the suite's profile for the Android container loaded:
  `sudo apparmor_parser -r tests/docker/redroid/apparmor.profile`. That lasts until the next reboot;
  copy the file into `/etc/apparmor.d/` to have it loaded at boot. "Android and the host kernel" below
  explains what it is for.

| Exit code | Meaning |
|---|---|
| 0 | every test passed |
| 1 | a test failed |
| 2 | the environment could not be prepared (image build, start-up, CA check, Android boot, timeout), or the Android container changed the host's kernel state |
| 3 | a prerequisite is missing, so nothing ran (no Docker, old Compose, no binder, no AppArmor profile, another run in progress, bad argument) |
| 130 | interrupted (everything is cleaned up first) |

What the entry point guarantees:

- The repository working tree is left untouched. The only host path written is the git-ignored
  `.test-output/`; a run that passes deletes its own subdirectory, a failed run keeps it for diagnostics.
- A layer that passes is recorded in `.test-output/passed/<layer>` together with the identity of the working
  tree it ran on (see "Reusing a recorded pass" below).
- Containers, networks and the per-run volumes are removed when the run ends, however it ends. Only two
  cache volumes (`ncs-suite-cache-obsidian`, `ncs-suite-cache-obsidian-android`) and the images stay.
- One run at a time (a second one exits with 3).
- Credentials and the TLS certificate authority are generated for each run, passed to the containers
  from memory, and masked in any diagnostics. The repo-root `.env` is never read or mounted.
- Tests trust the per-run CA instead of switching certificate checks off (Node, the desktop Electron
  and the Android system trust store).

### Android and the host kernel

Redroid has to run as a privileged container, and Android's `init` treats the kernel it sees as its
own. Left alone, every boot rewrites settings that are not namespaced and so belong to the whole host:
`kernel.*` and `vm.*` sysctls (it empties `kernel.modprobe`, which stops the kernel from loading
modules on demand), the owners and modes of files under `/proc` and `/sys`, and the mount options of
tracefs and debugfs. They stay that way until the host reboots.

Three things in `tests/docker/redroid/` prevent this:

- `apparmor.profile` confines the container. Writes under `/proc` and `/sys` are allowed only where
  they belong to the container itself (its processes, its network sysctls, its cgroup, its bpffs), the
  host-wide filesystems cannot be mounted, and the clock and the kernel's modules are out of reach. AppArmor counts a `chown` or `chmod` as a write, so owners
  and modes are covered too. The host has to load the profile (see the prerequisites); `run.sh` exits
  with 3 when it is not enforced.
- `entrypoint.sh` runs ahead of `init` and binds a private file over each of the three sysctls `init`
  refuses to boot without writing (`kernel.kptr_restrict`, `vm.mmap_rnd_bits`, `vm.mmap_rnd_compat_bits`).
- `Dockerfile` drops the two `init.rc` lines that change the owner and mode of `/proc/pressure/memory`,
  so that the profile can let the low-memory killer open that file for writing.

`run.sh` records the host's kernel and vm sysctls, the owners and modes at the top of `/proc`
(`/proc/pressure` included) and of the tracing, debug, pstore and power directories of `/sys`, and
the registered binary formats before Android starts, and compares them once it is gone, however the
run ended. A difference is kept in `host/host-state.diff` and turns a run that would have passed into
exit code 2. The comparison reads as the user who runs the suite, so the few sysctls only root can
read are not in it.

The number at the end of the profile's name is the version of its rules, and `run.sh` asks for exactly
the name in the file. After a change to the rules the host therefore has to load the file again before
Android will start; the profile it loaded earlier stays behind under its old name until it is removed
(`sudo apparmor_parser -R <old file>`) or the host reboots.

Each Android boot leaves `apparmor="DENIED"` lines for the profile in the host's kernel log.
They are the profile at work, not a fault. Two side effects remain and are harmless: `init` writes its
boot log to the kernel log, and the kernel loads a few networking modules on Android's behalf
(`inet_diag`, `af_key`, the `xfrm` tunnels), which stay loaded until the host reboots.

Layers:

- **a** — pure logic + the spec-coverage meta-test. No network, no UI.
- **b-1** — a live Nextcloud (PostgreSQL, Redis for file locking, `files_lock`/versions/trash-bin enabled,
  TLS in front) plus a second user for the lock-holder tests. The "N actor" tests, which change files
  directly in the server's data directory, go through a small side-car (`nc-fsops`) instead of SSH.
  Under the suite, a missing server feature or missing env value **fails** the test instead of skipping it.
  Tests that are `it.skip` stubs in the source (with the reason written next to them) are not environment
  skips and stay as they are.
- **b-2** — the real desktop Obsidian UI via `wdio-obsidian-service` (downloads Obsidian into a cache
  volume), run under Xvfb. Smoke + main wiring only.
- **b-3** — the real Obsidian **on an Android runtime** (Capacitor, not Electron) via `wdio-obsidian-service`
  + Appium, in a Redroid container (Android 13, **API 33**). It covers only what the Capacitor runtime
  changes: app background/foreground transitions, real-filesystem limits and the mobile `requestUrl`
  implementation. API 33 is pinned because from API 34 the system CA store moves into the conscrypt APEX
  and a per-run CA can no longer be placed in it by a file mount. Not parallelisable.
- **b-4** — a live **plain WebDAV** server (Apache httpd + `mod_dav` in a container). This is the
  one layer that is deliberately *not* Nextcloud, and that is its entire reason to exist: b-1/b-2/b-3
  all point at Nextcloud, so the plugin's documented degradation for non-Nextcloud servers was never
  exercised by anything but mocks — which is how a dispatch bug survived long enough for a user to
  report it (feature 073). Apache refuses `PROPFIND Depth: infinity` by default, so it also exercises
  the `Depth: 1` recursion that `StandardWebDAVClient` was written for. It never reads `NEXTCLOUD_*` —
  letting those leak in would quietly turn this back into another Nextcloud test.

The b-1 worker count is fixed at 8 in `tests/docker/runner/bin/suite-entry.sh`, chosen from 4, 8 and 12
workers (three runs each); 8 is within 10% of the fastest. The only failures in those runs were MD-3
(a stale `If-Match` validator must be refused with 412), which turned out to be unrelated to the
worker count: Nextcloud's local storage keeps a file's cached etag when an overwrite lands in the
same `storage_mtime` second, and the test uploaded without an mtime, so about one run in four the
"stale" etag was still current. MD-3 now sends distinct mtimes, as the sync engine always does, and
asserts that the etag really changed before the conditional upload.

**Reusing a recorded pass**: the identity of the working tree is a hash over every tracked or
untracked-but-not-ignored file, by path and content. Committing or merging the same files does not change it;
changing, adding or removing any such file does. `--changed` skips a layer whose recorded pass carries the
identity of the current tree and runs the others, so the layers that passed while a change was being written are
not run again for the release of that same tree. Without `--changed` every requested layer runs. A pass is
recorded only when the tree is the same at the end of the layer as at the start, and only the latest pass of
each layer is kept. The record does not expire: it says nothing about a newer Obsidian or Nextcloud image, so
run without `--changed` when the environment, not the code, is what changed.

The pre-push hook uses the same record: it runs `bash tests/docker/run.sh --changed a`, so a push of a tree whose
layer a already passed runs no tests, and a push that does run them leaves a record for the next one (a release
pushes the branch and then the tag, on the same tree). Where the suite cannot run (exit 2 or 3: no Docker, or
another run holds the lock) the hook falls back to `pnpm test`, which records nothing.

**Release gating**: a beta release requires every layer to have passed on the tree being released:
`bash tests/docker/run.sh --changed all` must exit 0 (exit 3 aborts it too);
a stable release runs no tests, because it promotes code whose every layer already passed at the beta.

**Measured cycle times** (this suite's own host, 16 vCPU, warm caches unless noted):

| Layer | Wall time |
|---|---|
| a | about 23 s |
| b-4 | about 8 s |
| b-1 | about 8 min (8 jest workers; measured 4 / 8 / 12 workers: about 9.5 / 8 / 7.3 min) |
| b-2 | about 1 min 20 s |
| b-3 | about 3 min 20 s |
| first-ever image build (no cache) | runner about 78 s, Nextcloud about 13 s |

File naming: `*.test.ts` (a), `*.b1.test.ts` (b-1), `*.b2.test.ts` (b-2), `*.b3.test.ts` (b-3), `*.b4.test.ts` (b-4).

## Dedup rule (one behaviour, one class)

The canonical class for a behaviour is **b-1 (live)** whenever a real-server check
is meaningful. `a` keeps only pure logic with no live counterpart. Do **not** test
the same behaviour in both `a` and `b-1`.

Walk the classes in order and stop at the first that can express the behaviour:

1. Pure logic, no live counterpart → **a**
2. Needs a real server, no UI → **b-1**
3. Needs the real Obsidian UI, and desktop Electron can reproduce it → **b-2**
4. None of the above can reproduce it, because it comes from the Capacitor runtime
   (background/foreground transitions, real-filesystem limits, the mobile HTTP
   implementation) → **b-3**

A behaviour only belongs in b-3 if you can state in one sentence why the other three
cannot reproduce it. If you cannot, it belongs in one of them. Note that desktop
"mobile emulation" (`app.emulateMobile`) is **not** a b-3 substitute: it flips the UI
mode (`Platform.isMobile`) while still running on Electron/Chromium/Node, so it
reproduces none of the above.

## Spec tagging & the coverage map

Every clause the suite must cover lives in
`a-no-nextcloud/spec-coverage/clauses.ts`. Tests reference a clause only by an
explicit `[SPEC:<id>]` tag — in the test name, or in a comment that labels an
assertion inside an active test — or through `spec()` from
`a-no-nextcloud/support/specRef.ts`, which renders the same tag. A bare id such as
`CF-2` does not count: ids like `FR-014` recur across features with different
meanings, and a bare match once made an unrelated test look like coverage.

Comments that point at the specification must use the form `docs/spec.md §N` or `docs/plan.md §N`. The `DOC-1` check
fails when the referenced section does not exist; `DOC-2` fails when a comment names a private path (the specs or
report directories) or carries a feature-number history marker.

```ts
import { spec } from '../support/specRef';
it(`${spec('CF-2', 'FR-008')} same-line conflict skips`, () => { /* ... */ });
```

`a-no-nextcloud/spec-coverage/coverage.test.ts` (runs under `pnpm test`) scans
**all** test files and FAILS if any in-scope clause has no test (`uncovered`) or a
`[SPEC:<id>]` tag points at an unknown clause (typo). Clauses with a non-empty
`waiver` are reported as **pending adjudication** (not failures) — this keeps the
known spec-vs-implementation deviations visible:

- **F1** server returns 415 for sync-collection → incremental sync unusable (TK-*)
- **F3** missing-file LOCK behaviour is server-specific, so LK-5 cannot be asserted reliably

(F4 — Diff3Strategy misreading node-diff3 → frontmatter conflict strategy inert — was
fixed in 0.7.1 (993de3c) and is no longer a waiver; CF-12 is now verified at layer a.)

## Adjudicating a failure

1. Find the clause id in the failing test name.
2. If the code violates the clause → fix the code (spec wins).
3. If the clause is permanently out of step with intended behaviour → add a
   `waiver` in `clauses.ts` and open a follow-up to update the spec / fix `src`.
   (`src/` is not changed by the test-reorg work itself.)

## Reading a b-3 run where session creation fails for every test

An error such as

`Activity name '.md.obsidian.MainActivity' used to start the app doesn't exist or cannot be launched!`

does **not** mean the configured activity name is wrong. `appium-adb` retries `am start` once with a `.`
prepended to the activity name when the first attempt answers `Error: Activity class ... does not exist`,
and the exception carries the name from the **retry**. Neither `wdio.android.conf.mts` nor
`wdio-obsidian-service` passes `appActivity`, so searching for it finds nothing.

The real cause is that the app is not on the device at that moment. Look first at the diagnostics kept
under `.test-output/<run_id>/` after a failed run:

- `b3/host-diagnostics.txt` — the device state (`adb devices`, memory, low-memory-killer lines, installed
  packages: is `md.obsidian` there?)
- `b3/appium-server.log` — the order of `installApp` / `removeApp` / `am start` during session creation
- `host/redroid.log` and `host/redroid-state.txt` — the Android container's own log and whether it was OOM-killed
- `host/host-state.diff` — present only when the host's kernel state changed during the run (see
  "Android and the host kernel")

The `afterTest` collector (`tests/b3-android-ui/support/diagnostics.ts`) runs through the `browser`
session, so when session creation itself fails it can collect nothing; the files above cover that gap.

Do not `adb install` by hand to prepare the device: `wdio-obsidian-service` reads the installed version
with `dumpsys` and then runs `removeApp` → `installApp`, and a hand-installed version that disagrees can
make that check fail.
