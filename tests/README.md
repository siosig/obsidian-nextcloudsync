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
```

**Host prerequisites**: Docker with Compose 2.23.1 or newer. `b3` and `all` also need the kernel's
`binder` support (the `binder_linux` module) because the Android runtime is a Redroid container —
`grep -w binder /proc/filesystems` must print a line. Redroid needs no hardware virtualisation.

| Exit code | Meaning |
|---|---|
| 0 | every test passed |
| 1 | a test failed |
| 2 | the environment could not be prepared (image build, start-up, CA check, Android boot, timeout) |
| 3 | a prerequisite is missing, so nothing ran (no Docker, old Compose, no binder, another run in progress, bad argument) |
| 130 | interrupted (everything is cleaned up first) |

What the entry point guarantees:

- The repository working tree is left untouched. The only host path written is the git-ignored
  `.test-output/`; a run that passes deletes its own subdirectory, a failed run keeps it for diagnostics.
- Containers, networks and the per-run volumes are removed when the run ends, however it ends. Only two
  cache volumes (`ncs-suite-cache-obsidian`, `ncs-suite-cache-obsidian-android`) and the images stay.
- One run at a time (a second one exits with 3).
- Credentials and the TLS certificate authority are generated for each run, passed to the containers
  from memory, and masked in any diagnostics. The repo-root `.env` is never read or mounted.
- Tests trust the per-run CA instead of switching certificate checks off (Node, the desktop Electron
  and the Android system trust store).

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

**Release gating**: a beta release requires `bash tests/docker/run.sh all` to pass (exit 3 aborts it too);
a stable release runs no tests, because it promotes code whose every layer already passed at the beta.

**Measured cycle times** (this suite's own host, 16 vCPU, warm caches unless noted):

| Layer | Wall time |
|---|---|
| a | about 23 s |
| b-4 | about 8 s |
| b-1 | about 8 min (8 jest workers) |
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
`a-no-nextcloud/spec-coverage/clauses.ts`. Tests reference a clause by a bare id
in the test name (e.g. `CF-2`, `FR-019`) or an explicit tag via
`spec()` from `a-no-nextcloud/support/specRef.ts`:

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

The `afterTest` collector (`tests/b3-android-ui/support/diagnostics.ts`) runs through the `browser`
session, so when session creation itself fails it can collect nothing; the files above cover that gap.

Do not `adb install` by hand to prepare the device: `wdio-obsidian-service` reads the installed version
with `dumpsys` and then runs `removeApp` → `installApp`, and a hand-installed version that disagrees can
make that check fail.
