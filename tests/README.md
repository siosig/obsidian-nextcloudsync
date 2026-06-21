# Test suite layout (spec-driven)

The suite is organised by **classification**, and the folders mirror it 1:1. The
goal: when a test fails, its spec tag tells you *which clause* to adjudicate —
spec is the source of truth; a deviation is fixed in code, or the clause is
updated (waiver) if the implementation is intentionally the canonical one.

| Folder | Class | Needs Nextcloud | Needs UI | Command | Default `pnpm test` / CI |
|---|---|:--:|:--:|---|:--:|
| `a-no-nextcloud/` | a | ✗ | ✗ | `pnpm test` | ✓ |
| `b1-nextcloud-headless/` | b-1 | ✓ | ✗ | `pnpm test:b1` | ✗ |
| `b2-nextcloud-ui/` | b-2 | ✓ | ✓ (wdio) | `pnpm test:b2` | ✗ |
| `fixtures/` | shared | — | — | — | — |

- **a** — pure logic + the spec-coverage meta-test. No network, no UI. Runs everywhere.
- **b-1** — live Nextcloud (localhost Docker) via `.env` `NEXTCLOUD_*`. `--runInBand`. Skips when env absent.
- **b-2** — real Obsidian UI via `wdio-obsidian-service` (`OBSIDIAN_*` + `NEXTCLOUD_*`). Smoke + main wiring only. Skips when driver/creds absent.

File naming: `*.test.ts` (a), `*.b1.test.ts` (b-1), `*.b2.test.ts` (b-2).

## Dedup rule (one behaviour, one class)

The canonical class for a behaviour is **b-1 (live)** whenever a real-server check
is meaningful. `a` keeps only pure logic with no live counterpart. Do **not** test
the same behaviour in both `a` and `b-1`.

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
- **F4** Diff3Strategy misreads node-diff3 → frontmatter conflict strategy inert (CF-12)

## Adjudicating a failure

1. Find the clause id in the failing test name.
2. If the code violates the clause → fix the code (spec wins).
3. If the clause is permanently out of step with intended behaviour → add a
   `waiver` in `clauses.ts` and open a follow-up to update the spec / fix `src`.
   (`src/` is not changed by the test-reorg work itself.)
