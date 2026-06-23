// Spec clause catalog (machine-checkable coverage source of truth).
//
// Replaces the per-suite "conformance" mechanism: every in-scope spec clause is
// listed here, and coverage.test.ts statically maps clauses -> tests by scanning
// test names for the clause id (bare, e.g. "CF-2"/"FR-019") or an explicit
// [SPEC:<id>] tag. A clause with no matching test and no `waiver` FAILS the
// meta-test (uncovered). A clause with a non-empty `waiver` is reported as a
// pending spec-vs-implementation adjudication (NOT a failure) — this is how the
// known live-server findings F1..F5 (report/mock_test.md §7) stay visible
// instead of passing silently.
//
// Stored as a typed TS module (not YAML) to avoid adding a parser dependency.

export type Layer = 'a' | 'b-1' | 'b-2';

export interface Clause {
  id: string;
  source: string;
  layer: Layer;
  /** Non-empty => pending adjudication (spec vs implementation), not a failure. */
  waiver?: string;
}

// Findings reused as waiver reasons (report/mock_test.md §7).
const F1 = 'F1: server returns 415 for sync-collection REPORT -> getSyncToken null, incremental sync unusable; behaviour adjudication pending';
const F3 = 'F3: files_lock is owner-based -> 423 not reproducible with same app password; needs a second user';
const CHK_CORRUPT = 'post-assembly checksum corruption cannot be induced against an uncontrolled live server';
const SF_AGG = 'sync-folder subcategory aggregated under CG/SF-1; dedicated split deferred (not yet a test)';
// Deferred b-1 end-to-end stubs (it.skip): traced + documented but not yet executed against a live
// server / SyncEngine harness. Surfaced as waivers (pending adjudication) instead of silently passing
// via the skipped test's title — the coverage scanner now ignores skipped-test traceability.
const DEFER_HARNESS = 'b-1 e2e deferred (it.skip) — engine-level, needs a SyncEngine harness';
const DEFER_SERVER = 'b-1 e2e deferred (it.skip) — cannot force the required live-server condition from a test';

export const CLAUSES: Clause[] = [
  // --- CN: connection/auth ---
  { id: 'CN-1', source: 'report/mock_test.md §3.A', layer: 'b-1' },
  { id: 'CN-2', source: 'report/mock_test.md §3.A', layer: 'b-1' },
  { id: 'CN-3', source: 'report/mock_test.md §3.A', layer: 'b-1', waiver: DEFER_SERVER },
  { id: 'CN-4', source: 'report/mock_test.md §3.A', layer: 'b-1' },
  { id: 'CN-5', source: 'report/mock_test.md §3.A', layer: 'b-1' },
  // --- UP/DL/DEL/MV: CRUD ---
  { id: 'UP-1', source: 'report/mock_test.md §3.B', layer: 'b-1' },
  { id: 'UP-2', source: 'report/mock_test.md §3.B', layer: 'b-1' },
  { id: 'UP-3', source: 'report/mock_test.md §3.B', layer: 'b-1' },
  { id: 'UP-4', source: 'report/mock_test.md §3.B', layer: 'b-1' },
  { id: 'UP-5', source: 'report/mock_test.md §3.B', layer: 'a' },
  { id: 'DL-1', source: 'report/mock_test.md §3.B', layer: 'b-1' },
  { id: 'DL-2', source: 'report/mock_test.md §3.B', layer: 'b-1' },
  { id: 'DEL-1', source: 'report/mock_test.md §3.B', layer: 'b-1' },
  { id: 'DEL-2', source: 'report/mock_test.md §3.B', layer: 'b-1' },
  // Mass-delete circuit breaker threshold (specs/main/spec.md §8): extracted to a pure helper and verified
  // at layer a (massDeletion.test.ts). The b-1 full-scan e2e remains a deferred it.skip (SF-1 waiver).
  { id: 'DEL-3', source: 'specs/main/spec.md §8 (mass-delete circuit breaker)', layer: 'a' },
  { id: 'MV-1', source: 'report/mock_test.md §3.B', layer: 'b-1' },
  { id: 'MV-2', source: 'report/mock_test.md §3.B', layer: 'b-1' },
  // --- SZ: size boundary ---
  { id: 'SZ-1', source: 'report/mock_test.md §3.C', layer: 'b-1' },
  { id: 'SZ-2', source: 'report/mock_test.md §3.C', layer: 'b-1' },
  { id: 'SZ-3', source: 'report/mock_test.md §3.C', layer: 'b-1' },
  { id: 'SZ-4', source: 'report/mock_test.md §3.C', layer: 'b-1' },
  { id: 'SZ-5', source: 'report/mock_test.md §3.C', layer: 'b-1' },
  { id: 'SZ-6', source: 'report/mock_test.md §3.C', layer: 'b-1' },
  { id: 'SZ-7', source: 'report/mock_test.md §3.C', layer: 'b-1' },
  // --- CHK: chunked ---
  { id: 'CHK-1', source: 'report/mock_test.md §3.D', layer: 'b-1' },
  { id: 'CHK-2', source: 'report/mock_test.md §3.D', layer: 'b-1' },
  { id: 'CHK-3', source: 'report/mock_test.md §3.D', layer: 'b-1', waiver: CHK_CORRUPT },
  { id: 'CHK-4', source: 'report/mock_test.md §3.D', layer: 'b-1', waiver: DEFER_SERVER },
  // --- LK: locking ---
  { id: 'LK-1', source: 'report/mock_test.md §3.E', layer: 'b-1', waiver: DEFER_HARNESS },
  { id: 'LK-2', source: 'report/mock_test.md §3.E', layer: 'b-1' },
  { id: 'LK-3', source: 'report/mock_test.md §3.E', layer: 'b-1', waiver: DEFER_HARNESS },
  { id: 'LK-4', source: 'report/mock_test.md §3.E', layer: 'b-1', waiver: F3 },
  { id: 'LK-5', source: 'report/mock_test.md §3.E', layer: 'b-1', waiver: F3 },
  // --- CF: conflict resolution ---
  { id: 'CF-1', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  { id: 'CF-2', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  { id: 'CF-3', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  { id: 'CF-4', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  { id: 'CF-5', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  { id: 'CF-6', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  { id: 'CF-7', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  { id: 'CF-8', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  // CF-9 (conflict-region cap) is fully verified at layer a by MergeEngine's positive-cap test
  // (mergeUnlimited.test.ts, tagged [SPEC:CF-9]); the b-1 live write is redundant (it.skip).
  { id: 'CF-9', source: 'specs/main/spec.md §6.2 (maxConflictRegions cap)', layer: 'a' },
  { id: 'CF-10', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  { id: 'CF-11', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  // F4 resolved in 0.7.1 (993de3c): Diff3Strategy now uses diff3Merge; verified at layer a.
  { id: 'CF-12', source: 'specs/main/spec.md §6.2 / §18 (F4 resolved)', layer: 'a' },
  { id: 'CF-13', source: 'report/mock_test.md §3.F', layer: 'b-1', waiver: 'CF-13 If-Match 412 → conflict routing: b-1 e2e deferred (it.skip, engine-level); the 412→PreconditionFailedError client unit is exercised at layer a' },
  // F5 resolved (2026-06-21, option a): MergeEngine.mergeText now feeds the real diff3 region count
  // to the maxConflictRegions breaker, so body conflicts reach conflictFailurePolicy when the cap is
  // exceeded. Verified at layer a (mergeEngine.test.ts).
  { id: 'CF-14', source: 'specs/main/spec.md §6.2 / §18 (F5 resolved)', layer: 'a' },
  // --- RT: retry queue ---
  // retryQueue enqueue policy (specs/main/spec.md §6.3): NetworkError → retry, other errors → record only.
  // Verified at layer a via the real processFileWithRetry wiring (retryQueue.test.ts).
  { id: 'RT-1', source: 'specs/main/spec.md §6.3 (retryQueue)', layer: 'a' },
  // --- CG: config-folder categories ---
  { id: 'CG-1', source: 'report/mock_test.md §3.G', layer: 'b-1' },
  { id: 'CG-2', source: 'report/mock_test.md §3.G', layer: 'b-1' },
  { id: 'CG-3', source: 'report/mock_test.md §3.G', layer: 'b-1' },
  { id: 'CG-4', source: 'report/mock_test.md §3.G', layer: 'b-1' },
  { id: 'CG-5', source: 'report/mock_test.md §3.G', layer: 'b-1' },
  { id: 'CG-6', source: 'report/mock_test.md §3.G', layer: 'b-1' },
  { id: 'CG-7', source: 'report/mock_test.md §3.G', layer: 'b-1' },
  { id: 'CG-8', source: 'report/mock_test.md §3.G', layer: 'b-1' },
  { id: 'CG-9', source: 'report/mock_test.md §3.G', layer: 'b-1' },
  { id: 'CG-10', source: 'report/mock_test.md §3.G', layer: 'b-1', waiver: DEFER_HARNESS },
  // --- SF: sync-folder ---
  { id: 'SF-1', source: 'report/mock_test.md §3.G', layer: 'b-1', waiver: 'SF-1 full-scan deletion safety: b-1 e2e deferred (it.skip) — needs a SyncEngine harness; the mass-delete circuit-breaker threshold is verified at layer a (DEL-3)' },
  { id: 'SF-2', source: 'report/mock_test.md §3.G', layer: 'b-1', waiver: SF_AGG },
  { id: 'SF-3', source: 'report/mock_test.md §3.G', layer: 'b-1', waiver: SF_AGG },
  { id: 'SF-4', source: 'report/mock_test.md §3.G', layer: 'b-1', waiver: SF_AGG },
  // --- TK: sync-token ---
  { id: 'TK-1', source: 'report/mock_test.md §3.H', layer: 'b-1', waiver: F1 },
  { id: 'TK-2', source: 'report/mock_test.md §3.H', layer: 'b-1', waiver: F1 },
  // --- VR: versions ---
  { id: 'VR-1', source: 'report/mock_test.md §3.I', layer: 'b-1' },
  { id: 'VR-2', source: 'report/mock_test.md §3.I', layer: 'b-1' },
  { id: 'VR-3', source: 'report/mock_test.md §3.I', layer: 'b-1' },
  { id: 'VR-4', source: 'report/mock_test.md §3.I', layer: 'b-1' },
  // --- ST: status ---
  { id: 'ST-1', source: 'report/mock_test.md §3', layer: 'b-1' },
  // --- INIT: install initial state (lifecycle) ---
  { id: 'INIT-1', source: 'report/mock_test.md §7.3', layer: 'b-1' },
  { id: 'INIT-2', source: 'report/mock_test.md §7.3', layer: 'b-1' },
  { id: 'INIT-3', source: 'report/mock_test.md §7.3', layer: 'b-1' },
  // --- MD: multi-device convergence (lifecycle) ---
  { id: 'MD-1', source: 'spec 019 FR-014', layer: 'b-1' },
  { id: 'MD-2', source: 'spec 019 FR-014', layer: 'b-1' },
  { id: 'MD-3', source: 'spec 019 FR-014', layer: 'b-1' },
  // --- PR: pause / resume mid-sync (lifecycle) ---
  { id: 'PR-1', source: 'spec 019 FR-016', layer: 'b-1' },
  { id: 'PR-2', source: 'spec 019 FR-016', layer: 'b-1' },
  // --- LOG: active-log self-sync exclusion ---
  { id: 'LOG-1', source: 'specs/main/spec.md §9.1', layer: 'a' },
  // --- file-mix distribution ---
  { id: 'FR-017', source: 'spec 019', layer: 'a' },
  // --- spec 019 (this feature's own requirements: traceability mechanism) ---
  { id: 'FR-002', source: 'spec 019 (coverage map)', layer: 'a' },
  { id: 'FR-003', source: 'spec 019 (deviation visibility)', layer: 'a' },
  { id: 'FR-025', source: 'spec 019 (b-2 UI)', layer: 'b-2' },
  // --- spec 020 (settings tooltips + sign-in clarity); FR-001/005/010 shared above ---
  { id: 'FR-006', source: 'spec 020 (exhaustive tooltip catalog)', layer: 'a' },
  { id: 'FR-007', source: 'spec 020 (Server URL desc / 405)', layer: 'a' },
  { id: 'FR-014', source: 'spec 020 (no new settings)', layer: 'a' },
  // --- DP: directory propagation (spec 021, specs/main/spec.md §8a) ---
  // DP-1..15 are all covered at layer a (dirSync.test.ts); DP-e2e / DP-e2e-empty at b-1.
  { id: 'DP-1',  source: 'specs/main/spec.md §8a.1 (local-only untracked → MKCOL)', layer: 'a' },
  { id: 'DP-2',  source: 'specs/main/spec.md §8a.1 (remote-only untracked → mkdir)', layer: 'a' },
  { id: 'DP-3',  source: 'specs/main/spec.md §8a.1 (tracked local-absent → DELETE remote)', layer: 'a' },
  { id: 'DP-4',  source: 'specs/main/spec.md §8a.1 (tracked remote-absent → trash local)', layer: 'a' },
  { id: 'DP-5',  source: 'specs/main/spec.md §8a.1 (present both → keep tracking)', layer: 'a' },
  { id: 'DP-6',  source: 'specs/main/spec.md §8a.1 (absent both tracked → drop)', layer: 'a' },
  { id: 'DP-7',  source: 'specs/main/spec.md §8a.1 (system-excluded → no create/delete)', layer: 'a' },
  { id: 'DP-8',  source: 'specs/main/spec.md §8a.1 (create ordering: shallow-first)', layer: 'a' },
  { id: 'DP-9',  source: 'specs/main/spec.md §8a.1 (delete ordering: deep-first)', layer: 'a' },
  { id: 'DP-10', source: 'specs/main/spec.md §8a.1 (non-empty probe skips delete)', layer: 'a' },
  { id: 'DP-11', source: 'specs/main/spec.md §8a.1 (circuit breaker)', layer: 'a' },
  { id: 'DP-12', source: 'specs/main/spec.md §8a.1 (lock ON wraps delete)', layer: 'a' },
  { id: 'DP-13', source: 'specs/main/spec.md §8a.1 (lock OFF no lock)', layer: 'a' },
  { id: 'DP-14', source: 'specs/main/spec.md §8a.1 (self-healing: one failed delete continues)', layer: 'a' },
  { id: 'DP-15', source: 'specs/main/spec.md §8a.1 (self-healing: listing failure skips session)', layer: 'a' },
  { id: 'DP-e2e',       source: 'specs/main/spec.md §8a.1 (cross-device empty-dir pruning e2e)', layer: 'b-1' },
  { id: 'DP-e2e-empty', source: 'specs/main/spec.md §8a.1 (empty dir created on A propagates to remote + B)', layer: 'b-1' },
  // --- DR: directory rename convergence (spec 021, specs/main/spec.md §8a.2) ---
  { id: 'DR-local',      source: 'specs/main/spec.md §8a.2 (local rename propagates via MOVE + dir reconcile)', layer: 'b-1' },
  { id: 'DR-concurrent', source: 'specs/main/spec.md §8a.2 (concurrent rename vs create converges without data loss)', layer: 'b-1' },
  // --- ES: root-ETag short-circuit (spec 023, specs/main/spec.md §8a.5) ---
  { id: 'ES-1',  source: 'specs/main/spec.md §8a.5 (full-scan path fetches root ETag)', layer: 'a' },
  { id: 'ES-2',  source: 'specs/main/spec.md §8a.5 (root ETag match → short-circuit, skip getFiles∞)', layer: 'a' },
  { id: 'ES-3',  source: 'specs/main/spec.md §8a.5 (rebuilt listing is complete → deletion safety unchanged)', layer: 'a' },
  { id: 'ES-4',  source: 'specs/main/spec.md §8a.5 (rebuilt files read as remote-unchanged by idType)', layer: 'a' },
  { id: 'ES-5',  source: 'specs/main/spec.md §8a.5 (mismatch / null → real full scan)', layer: 'a' },
  { id: 'ES-6',  source: 'specs/main/spec.md §8a.5 (stored ETag updated only on real scan → self-heal)', layer: 'a' },
  { id: 'ES-7',  source: 'specs/main/spec.md §8a.5 (first run / no stored ETag / non-Nextcloud → real scan)', layer: 'a' },
  { id: 'ES-8',  source: 'specs/main/spec.md §8a.5 (FORCE_FULL_SCAN_EVERY forces a real scan, resets count)', layer: 'a' },
  { id: 'ES-9',  source: 'specs/main/spec.md §8a.5 (remoteRootEtag/skipCount persist + pre-023 back-compat)', layer: 'a' },
  { id: 'ES-10', source: 'specs/main/spec.md §8a.5 (short-circuit also skips getDirectories∞ via rebuilt dirs)', layer: 'a' },
  // --- SG/WB: download safety guards (spec 025, specs/main/spec.md §9) ---
  { id: 'SG-1', source: 'specs/main/spec.md §9 (advertised size > received ⇒ anomalous remote)', layer: 'a' },
  { id: 'SG-2', source: 'specs/main/spec.md §9 (anomalous download refused: no overwrite, Base kept, retry)', layer: 'a' },
  { id: 'SG-3', source: 'specs/main/spec.md §9 (legitimate empty not flagged — zero false positives)', layer: 'a' },
  { id: 'SG-4', source: 'specs/main/spec.md §9 (guard applies to download and prefer-remote overwrite)', layer: 'a' },
  { id: 'WB-1', source: 'specs/main/spec.md §9 (atomicWriteBinary read-back: size matches ⇒ ok)', layer: 'a' },
  { id: 'WB-2', source: 'specs/main/spec.md §9 (atomicWriteBinary read-back: mismatch/missing ⇒ throws)', layer: 'a' },
  // --- Core functional requirements asserted at the pure-logic layer ---
  { id: 'FR-001', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-005', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-008', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-010', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-011', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-019', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-020', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
];
