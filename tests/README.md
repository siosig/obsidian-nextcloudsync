# Test suite layout (spec-driven)

The suite is organised by **classification**, and the folders mirror it 1:1. The
goal: when a test fails, its spec tag tells you *which clause* to adjudicate —
spec is the source of truth; a deviation is fixed in code, or the clause is
updated (waiver) if the implementation is intentionally the canonical one.

| Folder | Class | Needs Nextcloud | Needs UI | Command | Default `pnpm test` / CI |
|---|---|:--:|:--:|---|:--:|
| `a-no-nextcloud/` | a | ✗ | ✗ | `pnpm test` | ✓ |
| `b1-nextcloud-headless/` | b-1 | ✓ | ✗ | `pnpm test:b1` | ✗ |
| `b2-nextcloud-ui/` | b-2 | ✓ | ✓ (wdio, desktop Electron) | `pnpm test:b2` | ✗ |
| `b3-android-ui/` | b-3 | ✓ | ✓ (wdio + Appium, real Android) | `pnpm test:b3:instance` | ✗ |
| `b4-plain-webdav/` | b-4 | **✗ (deliberately NOT Nextcloud)** | ✗ | `pnpm test:b4` | ✗ |
| `fixtures/` | shared | — | — | — | — |

- **a** — pure logic + the spec-coverage meta-test. No network, no UI. Runs everywhere.
- **b-1** — live Nextcloud (localhost Docker) via `.env` `NEXTCLOUD_*`. `--runInBand`. Skips when env absent.
- **b-2** — real Obsidian UI via `wdio-obsidian-service` (downloads & launches Obsidian itself; needs only `NEXTCLOUD_*`). Smoke + main wiring only. Skips when creds/deps absent. Linux/CI: run under `xvfb-run`.
- **b-3** — real Obsidian **on a real Android runtime** (Capacitor, not Electron) via `wdio-obsidian-service` + Appium, on an ephemeral AVD host instance. Covers only what the Capacitor runtime changes: app background/foreground transitions, real-filesystem limits, and the mobile `requestUrl` implementation. **Cannot run on the dev VM** (no hardware virtualisation) — see `~/workspace/siosig/android-testinstance/README.md`. Emulator is pinned to **API 33**: from API 34 the system CA store moved into the conscrypt APEX and the self-signed test cert can no longer be trusted. Not parallelisable. **Part of the stable-release gate** (skippable only when the runtime cannot be provisioned).
  **Measured cycle time** (2026-08-23, `n2-standard-8` + API 33 emulator): scenarios ~1m45s; the whole
  procedure including both instances is ~20 minutes, dominated by AVD host provisioning (~13 min) —
  budget for that, not for the test run.
- **b-4** — a live **plain WebDAV** server (Apache httpd + `mod_dav` in a local container). This is the
  one layer that is deliberately *not* Nextcloud, and that is its entire reason to exist: b-1/b-2/b-3
  all point at Nextcloud, so the plugin's documented degradation for non-Nextcloud servers was never
  exercised by anything but mocks — which is how a dispatch bug survived long enough for a user to
  report it (feature 073). Apache refuses `PROPFIND Depth: infinity` by default, so it also exercises
  the `Depth: 1` recursion that `StandardWebDAVClient` was written for. Needs Docker, **not** a
  Nextcloud instance, and **must not read `NEXTCLOUD_*`** — letting those leak in would quietly turn
  this back into another Nextcloud test. `pnpm test:b4` starts and stops the container itself
  (a local container, unlike the shared cloud instances the other live layers use).

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
- **F3** owner-based file lock → 423 not reproducible with one user (LK-4/5)

(F4 — Diff3Strategy misreading node-diff3 → frontmatter conflict strategy inert — was
fixed in 0.7.1 (993de3c) and is no longer a waiver; CF-12 is now verified at layer a.)

## Adjudicating a failure

1. Find the clause id in the failing test name.
2. If the code violates the clause → fix the code (spec wins).
3. If the clause is permanently out of step with intended behaviour → add a
   `waiver` in `clauses.ts` and open a follow-up to update the spec / fix `src`.
   (`src/` is not changed by the test-reorg work itself.)
