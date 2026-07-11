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
// spec 042 (bulk conflict resolution): jest runs with testEnvironment: 'node' (no `document`, no real
// Modal/Setting instantiation — same constraint as SNI-5/SNI-6 and the FRC UI clauses), so
// SyncStatusModal DOM rendering + main.ts host-wiring clauses are waived to the b-2 UI layer /
// quickstart manual check; the pure batch-logic core they depend on is covered by BRC-1..7/9.
const BRC_DOM =
  'DOM/host wiring verified via quickstart manual check (specs/042-bulk-resolve-conflicts/quickstart.md); ' +
  'batch logic core covered by BRC-1..7,9 (forceResolution.test.ts, layer a)';
// spec 056 (mass-delete breaker report notes + dir bulk-resolve): SyncStatusModal.addErrorSection /
// addDirBreakerBulkResolveRow DOM rendering (click opens a report note; the dir-only bulk-resolve
// row) cannot be exercised under jest's testEnvironment: 'node' (no `document`) — same constraint as
// BRC_DOM/SNI-5/SNI-6. The pure logic it depends on (report note formatting, resolveSkippedDir/
// resolveAllSkippedDirs, sync exclusion) is covered at layer a by MDV-6..9.
const MDV_DOM =
  'DOM rendering verified via quickstart manual check ' +
  '(specs/056-massdelete-breaker-report-bulk-resolve/quickstart.md); ' +
  'pure logic covered by MDV-6..9 (dirSync.test.ts/breakerReport.test.ts, layer a)';

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
  // CF-9 (conflict-region cap) removed by feature 048: there is no region-count cap any more — each body
  // conflict region is resolved by conflictStrategy, not counted against a threshold.
  { id: 'CF-10', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  { id: 'CF-11', source: 'report/mock_test.md §3.F', layer: 'b-1' },
  // F4 resolved in 0.7.1 (993de3c): Diff3Strategy now uses diff3Merge; verified at layer a.
  { id: 'CF-12', source: 'specs/main/spec.md §6.2 / §18 (F4 resolved)', layer: 'a' },
  { id: 'CF-13', source: 'report/mock_test.md §3.F', layer: 'b-1', waiver: 'CF-13 If-Match 412 → conflict routing: b-1 e2e deferred (it.skip, engine-level); the 412→PreconditionFailedError client unit is exercised at layer a' },
  // F5 resolved (2026-06-21, option a): MergeEngine.mergeText now feeds the real diff3 region count
  // to the maxConflictRegions breaker, so body conflicts reach conflictFailurePolicy when the cap is
  // exceeded. Verified at layer a (mergeEngine.test.ts).
  { id: 'CF-14', source: 'specs/main/spec.md §6.2 / §18 (F5 resolved)', layer: 'a' },
  // --- CSF: conflict strategy by file type (feature 037) ---
  { id: 'CSF-1', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md', layer: 'a' },
  { id: 'CSF-2', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md', layer: 'a' },
  { id: 'CSF-3', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md', layer: 'a' },
  { id: 'CSF-4', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md (FR-005a)', layer: 'a' },
  { id: 'CSF-5', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md (FR-005b / SC-009)', layer: 'a' },
  { id: 'CSF-6', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md', layer: 'a' },
  { id: 'CSF-7', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md', layer: 'a' },
  { id: 'CSF-8', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md', layer: 'a' },
  { id: 'CSF-9', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md (FR-009)', layer: 'a' },
  { id: 'CSF-10', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md', layer: 'a' },
  { id: 'CSF-11', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md (R3 migration)', layer: 'a' },
  { id: 'CSF-12', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md (FR-013)', layer: 'a' },
  { id: 'CSF-13', source: 'specs/037-conflict-strategy-by-filetype/contracts/conflict-strategy.md (FR-010)', layer: 'a' },
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
  // --- CONC: concurrency / running-guard integrity ---
  { id: 'CONC-1', source: 'specs/main/spec.md §5 (a failed ensureClient must not strand the running guard; feature 053)', layer: 'a' },
  // --- NET: network request timeout (feature 054) ---
  { id: 'NET-1', source: 'specs/main/spec.md §5.6 (networkTimeoutSeconds bounds every WebDAV request so a hang cannot lock the engine)', layer: 'a' },
  // --- BUG: findbugs 2026-07-06 high-priority data-safety / concurrency fixes (feature 055) ---
  { id: 'G1-1', source: 'specs/main/spec.md §18.1 (a merge upload failure keeps the file flagged; the merge result is never silently dropped)', layer: 'a' },
  { id: 'G1-2', source: 'specs/main/spec.md §18.1 (StateDB tracking is cleared only on a successful remote delete; a real failure keeps the entry so the deletion retries)', layer: 'a' },
  { id: 'G4-1', source: 'specs/main/spec.md §18.1 (atomicWrite keeps the tmp copy when rename fails after the target was removed — never loses the sole surviving copy)', layer: 'a' },
  { id: 'G4-2', source: 'specs/main/spec.md §18.1 (store load() recovers from a surviving tmp when a crash landed between remove and rename)', layer: 'a' },
  { id: 'G5-1', source: 'specs/main/spec.md §18.1 (chunked upload carries the If-Match precondition like single PUT — large files are not exempt from optimistic concurrency)', layer: 'a' },
  { id: 'G6-1', source: 'specs/main/spec.md §18.1 (force-resolve / bulk-resolve are guarded by an instance field that survives re-render, preventing double execution)', layer: 'a' },
  { id: 'G6-2', source: 'specs/main/spec.md §18.1 (version Restore is guarded by a modal-level in-flight gate)', layer: 'a' },
  { id: 'G7-2', source: 'specs/main/spec.md §18.1 (mobile watch-mode is gated at runtime on Platform.isMobile, not only by first-run defaulting)', layer: 'a' },
  { id: 'G3-1', source: 'specs/main/spec.md §18.1 (empty-base merge never silently fuses two divergent sides at the character level; line-preserving unions stay clean)', layer: 'a' },
  { id: 'G3-3', source: 'specs/main/spec.md §18.1 (MergeEngine.merge for non-markdown never splits a leading --- block as frontmatter — a one-sided in-block edit is 3-way merged, not discarded)', layer: 'a' },
  // --- LOG: active-log self-sync exclusion + write-failure visibility ---
  { id: 'LOG-1', source: 'specs/main/spec.md §9.1', layer: 'a' },
  { id: 'LOG-2', source: 'specs/main/spec.md §12 (log write failures surface as a Notice)', layer: 'a' },
  // --- EXCL-HARD: machine-managed folders (.git/.trash) permanently excluded from sync ---
  { id: 'EXCL-HARD-1', source: 'specs/main/spec.md §9.3 (.git and .trash are hard-excluded regardless of the user list; targeted, not blanket — .archive/.env still sync)', layer: 'a' },
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
  // DP-12 (lock ON wraps delete) removed in feature 033 — file locking is always off (see FX-4).
  { id: 'DP-13', source: 'specs/main/spec.md §8a.1 (no lock around delete — locking always off, 033)', layer: 'a' },
  { id: 'DP-14', source: 'specs/main/spec.md §8a.1 (self-healing: one failed delete continues)', layer: 'a' },
  { id: 'DP-15', source: 'specs/main/spec.md §8a.1 (self-healing: listing failure skips session)', layer: 'a' },
  { id: 'DP-e2e',       source: 'specs/main/spec.md §8a.1 (cross-device empty-dir pruning e2e)', layer: 'b-1' },
  { id: 'DP-e2e-empty', source: 'specs/main/spec.md §8a.1 (empty dir created on A propagates to remote + B)', layer: 'b-1' },
  // --- FX: fixed sync config (feature 033 — five low-value settings removed from the UI) ---
  { id: 'FX-1', source: 'specs/main/spec.md §15 (fixed values: locking off, chunked on, regions unlimited)', layer: 'a' },
  { id: 'FX-2', source: 'specs/main/spec.md §15 (chunked upload always on, gated by server capability)', layer: 'a' },
  { id: 'FX-3', source: 'specs/main/spec.md §15 (chunk threshold platform-derived: 50 desktop / 20 mobile)', layer: 'a' },
  { id: 'FX-4', source: 'specs/main/spec.md §15 (file locking always off; If-Match is the lost-update guard)', layer: 'a' },
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
  { id: 'ES-11', source: 'specs/main/spec.md §8a.5 (tie no-op invalidates root ETag → next sync re-scans; no silent local-wins upload)', layer: 'a' },
  // --- SG/WB: download safety guards (spec 025, specs/main/spec.md §9) ---
  { id: 'SG-1', source: 'specs/main/spec.md §9 (advertised size > received ⇒ anomalous remote)', layer: 'a' },
  { id: 'SG-2', source: 'specs/main/spec.md §9 (anomalous download refused: no overwrite, Base kept, retry)', layer: 'a' },
  { id: 'SG-3', source: 'specs/main/spec.md §9 (legitimate empty not flagged — zero false positives)', layer: 'a' },
  { id: 'SG-4', source: 'specs/main/spec.md §9 (guard applies to download and prefer-remote overwrite)', layer: 'a' },
  { id: 'WB-1', source: 'specs/main/spec.md §9 (atomicWriteBinary read-back: size matches ⇒ ok)', layer: 'a' },
  { id: 'WB-2', source: 'specs/main/spec.md §9 (atomicWriteBinary read-back: mismatch/missing ⇒ throws)', layer: 'a' },
  // --- DSG: download-side Maximum file size guard (spec 035, specs/main/spec.md §9) ---
  { id: 'DSG-1', source: 'specs/main/spec.md §9 (sync download skips oversized remote before GET; no fetch/write/Base/retry, not an error)', layer: 'a' },
  { id: 'DSG-2', source: 'specs/main/spec.md §9 (delete-vs-edit restore routes through the same download guard)', layer: 'a' },
  { id: 'DSG-3', source: 'specs/main/spec.md §9 (conflict both-changed × oversized remote: skip, keep local, flag conflicted, no retry)', layer: 'a' },
  { id: 'DSG-4', source: 'specs/main/spec.md §9 (compare/diff preview oversized: no body fetch, metadata only)', layer: 'a' },
  { id: 'DSG-5', source: 'specs/main/spec.md §9 (manual pull oversized: throws clear error, no fetch)', layer: 'a' },
  { id: 'DSG-6', source: 'specs/main/spec.md §9 (maxFileSizeMB=0 unlimited: downloads regardless of size)', layer: 'a' },
  { id: 'DSG-7', source: 'specs/main/spec.md §9 (size exactly at cap is allowed — boundary)', layer: 'a' },
  { id: 'DSG-8', source: 'specs/main/spec.md §9 (self-healing: raising the cap downloads the once-skipped file)', layer: 'a' },
  // --- SNI: slider numeric input (spec 036) ---
  { id: 'SNI-1', source: 'specs/036-slider-numeric-input (numeric input clamps out-of-range to bounds)', layer: 'a' },
  { id: 'SNI-2', source: 'specs/036-slider-numeric-input (invalid/empty/NaN input reverts to current value)', layer: 'a' },
  { id: 'SNI-3', source: 'specs/036-slider-numeric-input (off-grid integers in range accepted)', layer: 'a' },
  { id: 'SNI-4', source: 'specs/036-slider-numeric-input (decimals rounded to integers then clamped)', layer: 'a' },
  { id: 'SNI-5', source: 'specs/036-slider-numeric-input (slider<->numeric input two-way sync)', layer: 'a', waiver: 'DOM wiring verified via quickstart manual check; logic core covered by SNI-1..4' },
  { id: 'SNI-6', source: 'specs/036-slider-numeric-input (numeric input commits on blur/Enter, not per keystroke)', layer: 'a', waiver: 'DOM event wiring verified via quickstart manual check' },
  { id: 'SNI-11', source: 'specs/036-slider-numeric-input (existing 5 sliders ranges/defaults unchanged)', layer: 'a' },
  // --- MB: merge base store for true 3-way merge (spec 038) ---
  { id: 'MB-1', source: 'specs/038-merge-base-store (base present → shared blocks not duplicated)', layer: 'a' },
  { id: 'MB-2', source: 'specs/038-merge-base-store (repeated conflicts stay clean as base advances)', layer: 'a' },
  { id: 'MB-3', source: 'specs/038-merge-base-store (base absent → empty-base duplication caught by expansion guard)', layer: 'a' },
  { id: 'MB-4', source: 'specs/038-merge-base-store (converge seeds base → next merge clean; self-healing)', layer: 'a' },
  { id: 'MB-5', source: 'specs/038-merge-base-store (download records base)', layer: 'a' },
  { id: 'MB-6', source: 'specs/038-merge-base-store (upload records base)', layer: 'a' },
  { id: 'MB-7', source: 'specs/038-merge-base-store (clean merge that reached server records base; markers do not)', layer: 'a' },
  { id: 'MB-8', source: 'specs/038-merge-base-store (prefer-local/prefer-remote incl. biggest-size/latest-mtime record base)', layer: 'a' },
  { id: 'MB-9', source: 'specs/038-merge-base-store (initial seed is lazy — no eager content read; seeds at first transfer)', layer: 'a', waiver: 'lazy by design (perf): covered by MB-5/MB-6 first-transfer seeding, not an eager initial-sync read' },
  { id: 'MB-10', source: 'specs/038-merge-base-store (deletion drops base)', layer: 'a' },
  { id: 'MB-11', source: 'specs/038-merge-base-store (non-Auto-Merge / binary files do not store base)', layer: 'a' },
  { id: 'MB-12', source: 'specs/038-merge-base-store (MergeBaseStore persistence round-trip)', layer: 'a' },
  { id: 'MB-13', source: 'specs/038-merge-base-store (base/file mismatch converges next sync; guard is the backstop)', layer: 'a', waiver: 'crash-consistency convergence covered by MB-3/MB-4 self-healing; no separate forced-crash harness' },
  { id: 'MB-14', source: 'specs/038-merge-base-store (no new DavSyncSettings key)', layer: 'a' },
  // --- MM: merge-marker re-entrancy guard + nested-marker backstop + base-aware 3-way (spec 039) ---
  { id: 'MM-1', source: 'specs/039-merge-marker-reentrancy (local already has plugin markers → safe-hold, no merge)', layer: 'a' },
  { id: 'MM-2', source: 'specs/039-merge-marker-reentrancy (remote already has plugin markers → safe-hold)', layer: 'a' },
  { id: 'MM-3', source: 'specs/039-merge-marker-reentrancy (markers removed → merge resumes single-level; self-healing)', layer: 'a' },
  { id: 'MM-4', source: 'specs/039-merge-marker-reentrancy (both sides carry markers → safe-hold, never wrap markers in markers)', layer: 'a' },
  { id: 'MM-5', source: 'specs/039-merge-marker-reentrancy (bare git-style <<<<<<< HEAD in prose is NOT re-entrant; no false positive)', layer: 'a' },
  { id: 'MM-6', source: 'specs/039-merge-marker-reentrancy (nested/stacked plugin markers detected)', layer: 'a' },
  { id: 'MM-7', source: 'specs/039-merge-marker-reentrancy (single well-formed region NOT flagged nested; no false positive)', layer: 'a' },
  { id: 'MM-8', source: 'specs/039-merge-marker-reentrancy (real base + non-overlapping edits → clean merge keeping both, no markers)', layer: 'a' },
  { id: 'MM-9', source: 'specs/039-merge-marker-reentrancy (real base + same-line edits → single-level conflict markers)', layer: 'a' },
  { id: 'MM-10', source: 'specs/039-merge-marker-reentrancy (empty base → legacy reconcile path preserved, no crash)', layer: 'a' },
  { id: 'MM-11', source: 'specs/039-merge-marker-reentrancy (b1: 2 devices same-file concurrent edit → markers → re-sync stays non-expanding, non-nested)', layer: 'b-1', waiver: 'live-server e2e; a-layer MM-1..10 prove the guard/backstop/3-way logic deterministically' },
  // --- OM: orphan-marker self-heal (spec 041, FR-001..006) ---
  { id: 'OM-1', source: 'specs/041-orphan-marker-selfheal-force-resolve (lone closing marker → NOT safe-hold, merges/self-heals)', layer: 'a' },
  { id: 'OM-2', source: 'specs/041-orphan-marker-selfheal-force-resolve (lone opening marker → NOT safe-hold, merges)', layer: 'a' },
  { id: 'OM-3', source: 'specs/041-orphan-marker-selfheal-force-resolve (orphan on the remote side → NOT safe-hold, merges)', layer: 'a' },
  { id: 'OM-4', source: 'specs/041-orphan-marker-selfheal-force-resolve (identical orphan both sides → clean marker-free convergence)', layer: 'a' },
  // --- FRC: per-file force conflict resolution from the status dialog (spec 041, FR-007..016) ---
  { id: 'FRC-1', source: 'specs/041-orphan-marker-selfheal-force-resolve (remote → pull, overwrite local with remote)', layer: 'a' },
  { id: 'FRC-2', source: 'specs/041-orphan-marker-selfheal-force-resolve (local → push, overwrite remote with local)', layer: 'a' },
  { id: 'FRC-3', source: 'specs/041-orphan-marker-selfheal-force-resolve (latest modified → newer side wins via push/pull)', layer: 'a' },
  { id: 'FRC-4', source: 'specs/041-orphan-marker-selfheal-force-resolve (biggest size → bigger side wins via push/pull)', layer: 'a' },
  { id: 'FRC-5', source: 'specs/041-orphan-marker-selfheal-force-resolve (tie equal mtime/size → no-op, no notice)', layer: 'a' },
  { id: 'FRC-6', source: 'specs/041-orphan-marker-selfheal-force-resolve (overwrite failure propagates → file stays conflicted)', layer: 'a' },
  // --- BRC: bulk conflict resolution from the status dialog (spec 042, contracts/bulk-resolve.md) ---
  // BRC-1..7 and BRC-9 are the pure `applyBulkForceResolution` fan-out (src/ui/forceResolution.ts),
  // verified directly at layer a (forceResolution.test.ts, tagged [SPEC:BRC-*]). BRC-8/10..21 are
  // SyncStatusModal DOM rendering + main.ts host wiring (see BRC_DOM above), waived to the b-2 UI
  // layer / quickstart manual check.
  { id: 'BRC-1', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-005 / SC-003: bulk outcome === per-file outcome)', layer: 'a' },
  { id: 'BRC-2', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-013: sequential processing, paths order)', layer: 'a' },
  { id: 'BRC-3', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-013 / SC-004: per-file rejection caught, batch continues)', layer: 'a' },
  { id: 'BRC-4', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (resolved+noop+failed === paths.length invariant)', layer: 'a' },
  { id: 'BRC-5', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (edge: empty paths list → {0,0,0}, engine untouched)', layer: 'a' },
  { id: 'BRC-6', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (edge: N=1 tallies into a single bucket)', layer: 'a' },
  { id: 'BRC-7', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-009: batch promise never rejects)', layer: 'a' },
  { id: 'BRC-8', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-001 / mockup: bulk row placed after heading+description, before per-file list)', layer: 'a', waiver: BRC_DOM },
  // BRC-9's DOM row-label count (FR-004/SC-002) is a rendering concern (waived, see BRC_DOM), but its
  // "count = the filtered target set, not an arbitrary set" invariant is exercised directly by the
  // tagged forceResolution.test.ts case (filterReport-derived subset drives applyBulkForceResolution).
  { id: 'BRC-9', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-004 / SC-002: count === filtered.conflictedFiles.length)', layer: 'a' },
  { id: 'BRC-10', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-002: bulk dropdown iterates the same FORCE_CHOICES array as the per-file dropdown)', layer: 'a', waiver: 'single-source-of-truth verified by "FORCE_CHOICES lists the four options in order" (forceResolution.test.ts); DOM iteration itself is ' + BRC_DOM },
  { id: 'BRC-11', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-003 / mockup: mod-warning button + ncs-bulk-conflict-row container)', layer: 'a', waiver: BRC_DOM },
  { id: 'BRC-12', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-010: bulk row rendered only when onBulkForceResolve is provided — capability gate)', layer: 'a', waiver: BRC_DOM },
  { id: 'BRC-13', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-006: per-file rows/controls unchanged alongside the bulk row)', layer: 'a', waiver: BRC_DOM },
  { id: 'BRC-14', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (edge: N=0 never renders the bulk row, addConflictSection early-return)', layer: 'a', waiver: BRC_DOM },
  { id: 'BRC-15', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-011: click guard — disabled button no-ops, else disable then invoke callback)', layer: 'a', waiver: BRC_DOM },
  { id: 'BRC-16', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-008 / FR-009: re-render on settle, click handler never throws)', layer: 'a', waiver: BRC_DOM },
  { id: 'BRC-17', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-012: confirmModal destructive:true reused; decline/dismiss touches no file)', layer: 'a', waiver: BRC_DOM },
  { id: 'BRC-18', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-012 / Key Entities: confirm message states count N + action, not limited to last sync)', layer: 'a', waiver: BRC_DOM },
  { id: 'BRC-19', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-014: exactly one aggregate Notice after the batch, never one per file)', layer: 'a', waiver: BRC_DOM },
  { id: 'BRC-20', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (FR-007: engine loop iterates only the filtered paths set)', layer: 'a', waiver: BRC_DOM },
  { id: 'BRC-21', source: 'specs/042-bulk-resolve-conflicts/contracts/bulk-resolve.md (SC-006 / FR-006: existing per-file onForceResolve wiring unchanged — no regression to feature 041)', layer: 'a', waiver: BRC_DOM },
  // --- TN: atomic-write temp-file naming under the 255-byte NAME_MAX (spec 026) ---
  { id: 'TN-1', source: 'specs/main/spec.md §9 (final name ≤255B always writes; temp suffix length not leaked)', layer: 'a' },
  { id: 'TN-2', source: 'specs/main/spec.md §9 (temp name length independent of target name length)', layer: 'a' },
  { id: 'TN-3', source: 'specs/main/spec.md §9 (temp names unique per target within a directory)', layer: 'a' },
  { id: 'TN-4', source: 'specs/main/spec.md §9 (temp name deterministic for a given target)', layer: 'a' },
  { id: 'TN-5', source: 'specs/main/spec.md §9 (temp file in target directory ⇒ atomic rename)', layer: 'a' },
  { id: 'TN-6', source: 'specs/main/spec.md §9 (final name >255B ⇒ friendly name-too-long error)', layer: 'a' },
  { id: 'TN-7', source: 'specs/main/spec.md §9 (non-length errors pass through untranslated)', layer: 'a' },
  { id: 'TN-8', source: 'specs/main/spec.md §9 (isSyncTmpPath new+legacy suffix; temp cleaned on failure)', layer: 'a' },
  // --- Core functional requirements asserted at the pure-logic layer ---
  { id: 'FR-001', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-005', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-008', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-010', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-011', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-019', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  { id: 'FR-020', source: 'specs/001-nextcloudsync-plugin', layer: 'a' },
  // Feature 028 (settings simplification): the README settings-defaults tables match the code.
  { id: 'SC-005', source: 'specs/028-settings-simplification', layer: 'a' },
  // Feature 032 (debug settings reduction): the Debug section is a single toggle; device name is
  // auto-derived and logs go to the vault root (both fixed); existing custom values reset on load.
  { id: 'DBG-1', source: 'specs/032-debug-settings-reduction (single Debug toggle)', layer: 'a' },
  { id: 'DBG-2', source: 'specs/032-debug-settings-reduction (auto device name + vault-root logs)', layer: 'a' },
  { id: 'DBG-3', source: 'specs/032-debug-settings-reduction (custom values reset to the fixed path)', layer: 'a' },
  // Feature 034 (slider range/step): the numeric settings sliders get new min/max/step, sourced from
  // SLIDER_LIMITS and mirrored by the mockup. Off-grid defaults stay non-destructive. The 034-rev
  // amendment folds the "Sync on startup" toggle into the startup-delay slider (0 = off) with a
  // migration, and exposes networkConcurrency 0 (floored to 1 by consumers).
  { id: 'SLD-1', source: 'specs/main/spec.md §15.1-slider (limits match the contract)', layer: 'a' },
  { id: 'SLD-2', source: 'specs/main/spec.md §15.1-slider (max % step === 0, no fractional final step)', layer: 'a' },
  { id: 'SLD-3', source: 'specs/main/spec.md §15.1-slider (on-grid defaults reachable)', layer: 'a' },
  { id: 'SLD-4', source: 'specs/main/spec.md §15.1-slider (off-grid defaults tolerated, non-destructive)', layer: 'a' },
  { id: 'SLD-5', source: 'specs/main/spec.md §15.1-slider (sliderLimits is a pure constant module)', layer: 'a' },
  { id: 'SLD-6', source: 'specs/main/spec.md §15.1-slider (desktop mockup mirrors SLIDER_LIMITS)', layer: 'a' },
  { id: 'SLD-7', source: 'specs/main/spec.md §15.1-slider (startup-delay 0 = off folds the toggle; migrateStartupToggleToDelay converges saved state)', layer: 'a' },
  { id: 'SLD-8', source: 'specs/main/spec.md §15.1-slider (networkConcurrency 0 floors to effective 1 at consumers)', layer: 'a' },
  // Feature 043 (harden frontmatter merge): the frontmatter path is resolved STRUCTURALLY through
  // Obsidian's official getFrontMatterInfo / parseYaml / stringifyYaml / parseFrontMatterStringArray
  // — conflict-marker lines NEVER enter a `---` block, and list fields merge as a base-aware 3-way SET
  // so deletions propagate (server-rewrite case) and near-duplicate spellings collapse to one entry.
  { id: 'HFM-1', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-004: parse/serialize via parseYaml/stringifyYaml; production no longer imports raw js-yaml)', layer: 'a' },
  { id: 'HFM-2', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-006: base-aware SET 3-way — agree→that, disagree→side≠base, both/one-side delete→absent, adds kept)', layer: 'a' },
  { id: 'HFM-3', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-007: no base → deduplicated union, adds preserved, deletions undetectable)', layer: 'a' },
  { id: 'HFM-4', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-008: items normalized via parseFrontMatterStringArray, #tag/tag/whitespace collapse to one)', layer: 'a' },
  { id: 'HFM-5', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-006: stable order base-first-then-additions, deterministic, no mtime dependence for arrays)', layer: 'a' },
  { id: 'HFM-6', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-009: scalar conflicts via existing frontmatterScalarConflictPolicy; nested objects stay opaque scalars)', layer: 'a' },
  { id: 'HFM-7', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-005: unparseable side → merge returns success:false, never partial frontmatter with marker lines)', layer: 'a' },
  { id: 'HFM-8', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-003: split via getFrontMatterInfo — body --- break not mistaken for delimiter, CRLF tolerated)', layer: 'a' },
  { id: 'HFM-9', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-001: diff3 fallback NEVER invoked on frontmatter text — zero marker lines in a --- block)', layer: 'a' },
  { id: 'HFM-10', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-005: unparseable side → whole-side pick per scalar policy, latest-mtime/remote-win/local-win)', layer: 'a' },
  { id: 'HFM-11', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-002: nested-marker backstop still holds; combined with HFM-9 markers cannot originate in frontmatter)', layer: 'a' },
  // HFM-12 (FR-010) is a regression meta-clause: the refactor must not change body merge, deterministic
  // strategies, re-entrancy/self-heal, or clean auto-merge. It is verified by the pre-existing
  // merge/marker/base corpus (feature 038/039/040/041 clauses MB-*/CF-*, plus the untagged
  // clean-merge/body tests in mergeEngine.test.ts) staying green — not by a single new assertion.
  { id: 'HFM-12', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-010: no behavioural regression to body merge/strategies/self-heal)', layer: 'a', waiver: 'regression meta-clause; guaranteed by the pre-existing merge/marker/base corpus staying green under the refactor, not by a dedicated new test' },
  { id: 'HFM-13', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (FR-011: merged note converges — re-merge yields identical frontmatter, no marker growth, no array growth)', layer: 'a' },
  { id: 'HFM-14', source: 'specs/043-harden-frontmatter-merge/contracts/frontmatter-merge.md (layer-a Obsidian double: getFrontMatterInfo/parseYaml/stringifyYaml/parseFrontMatterStringArray per documented semantics)', layer: 'a' },
  // Feature 043 live multi-device situations (real Docker Nextcloud, pnpm test:b1). The two scenarios
  // the user asked to cover end-to-end: (1) two devices edit the same note's frontmatter; (2) a
  // server-side program rewrites the remote frontmatter out of band (the reported real bug).
  { id: 'FM-B1-1', source: 'specs/043-harden-frontmatter-merge (D deletes+adds a tag / M adds a tag → base-aware set merge: deletion propagates, both adds kept, no frontmatter marker, converges)', layer: 'b-1' },
  { id: 'FM-B1-2', source: 'specs/043-harden-frontmatter-merge (D and M change the same scalar → existing frontmatterScalarConflictPolicy decides one winner, no marker)', layer: 'b-1' },
  { id: 'FM-B1-3', source: 'specs/043-harden-frontmatter-merge (server rewrites tags [t1,t2,t3]→[t2,t3,t4] out of band, local drifted → set merge deletes t1, no union resurrection)', layer: 'b-1' },
  { id: 'FM-B1-4', source: 'specs/043-harden-frontmatter-merge (server rewrite with CRLF + trailing-space fences → getFrontMatterInfo split → no marker inside frontmatter)', layer: 'b-1' },
  { id: 'FM-B1-5', source: 'specs/043-harden-frontmatter-merge (after a set merge, repeated no-edit syncs converge — no churn, no marker growth, no tag growth)', layer: 'b-1' },
  // Feature 044 (conflict clean-side snapshot): capture both clean sides at marker-conflict time so
  // force-resolution ("Use remote"/"Use local"/Latest/Biggest) recovers a REAL clean version instead
  // of the marker-corrupted current content. Internal store, no new user setting.
  { id: 'CSS-1', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-001: capture both clean sides before a marker write overwrites them)', layer: 'a' },
  { id: 'CSS-2', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-002: Use remote/local restore the captured clean remote/local, not current marker content)', layer: 'a' },
  { id: 'CSS-3', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-003: Latest/Biggest dispatch by snapshot metrics; equal metric → no-op)', layer: 'a' },
  { id: 'CSS-4', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-004: after recovery note is marker-free, both sides converge, flag clears only when clean)', layer: 'a' },
  { id: 'CSS-5', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-005: no snapshot → fall back to current pull/push, never error)', layer: 'a' },
  { id: 'CSS-6', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-006: snapshot dropped at every convergence/resolution point — no leak)', layer: 'a' },
  { id: 'CSS-7', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-007: no user-facing setting; DEFAULT_SETTINGS gains no key)', layer: 'a' },
  { id: 'CSS-8', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-008: at rest, snapshot count == currently marker-conflicted file count)', layer: 'a' },
  // CSS-9 (FR-009) is a regression meta-clause: no behavioural change to body merge, clean auto-merge,
  // marker self-heal, deterministic strategies, safe-hold, or size holds. Guaranteed by the pre-existing
  // conflict/merge/force-resolution corpus (CSF-*/MM-*/OM-*/FRC-*/MB-*) staying green under the change.
  { id: 'CSS-9', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-009: no regression to existing conflict/merge/force-resolution behavior)', layer: 'a', waiver: 'regression meta-clause; guaranteed by the pre-existing conflict/merge/force-resolution corpus staying green under the change, not by a dedicated new test' },
  { id: 'CSS-10', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-010: persist to disk, survive restart — save→load round-trip)', layer: 'a' },
  { id: 'CSS-11', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-011: a repeat marker conflict overwrites the snapshot with the two most recent clean sides)', layer: 'a' },
  { id: 'CSS-12', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (FR-012: capture only on the marker-write path; safe-hold/size-hold/clean-merge/deterministic capture nothing)', layer: 'a' },
  { id: 'CSS-13', source: 'specs/044-conflict-clean-snapshot/contracts/clean-side-recovery.md (CleanSideStore: atomic tmp→rename, debounce, flush, corrupt→empty)', layer: 'a' },
  { id: 'CSS-B1-1', source: 'specs/044-conflict-clean-snapshot (live 2-device: marker conflict → Use remote recovers clean remote, both converge)', layer: 'b-1' },
  { id: 'CSS-B1-2', source: 'specs/044-conflict-clean-snapshot (live 2-device: marker conflict → Use local recovers clean local, both converge)', layer: 'b-1' },
  { id: 'CSS-B1-3', source: 'specs/044-conflict-clean-snapshot (live: after recovery, a further no-edit sync converges — no marker growth, no snapshot leak)', layer: 'b-1' },
  // Feature 045 (Remote-authoritative Pull mirror): a Maintenance "Mirror from remote" button forces
  // this device's vault to exactly match the remote — download what the remote has, delete local-only
  // files/folders (via the Obsidian trash setting, recoverable), skip content-identical files. Bypasses
  // the mass-delete breaker COUNT limit but gates on a COMPLETE remote listing.
  { id: 'MIR-1', source: 'specs/045-remote-mirror-pull/spec.md (FR-002/005/006/007/010/016: buildMirrorPlan classifies download / delete files+folders(child→parent) / skip; exclusions honored; counts for the dialog)', layer: 'a' },
  { id: 'MIR-2', source: 'specs/045-remote-mirror-pull/spec.md (FR-009/SC-005: listing-completeness gate — an incomplete/failed remote listing yields ok:false and zero deletions)', layer: 'a' },
  { id: 'MIR-3', source: 'specs/045-remote-mirror-pull/spec.md (FR-008/011/SC-002: applyRemoteMirror deletes local-only via trash, reconciles StateDB to the remote (converges to zero diff), and bypasses the mass-delete breaker count limit)', layer: 'a' },
  { id: 'MIR-B1-1', source: 'specs/045-remote-mirror-pull (live: mass local-only download+delete not halted by the breaker; vault ends equal to the remote)', layer: 'b-1', waiver: 'deferred b-1 end-to-end stub (it.skip): needs a live Nextcloud; validated manually via quickstart until executed' },
  { id: 'MIR-B1-2', source: 'specs/045-remote-mirror-pull (live: local-only folder deletion incl. empty, child→parent; listing-failure gate performs zero deletions)', layer: 'b-1', waiver: 'deferred b-1 end-to-end stub (it.skip): needs a live Nextcloud; validated manually via quickstart until executed' },
  { id: 'MIR-B1-3', source: 'specs/045-remote-mirror-pull (live: the sync immediately after a mirror converges with zero upload/download/delete — self-healing)', layer: 'b-1', waiver: 'deferred b-1 end-to-end stub (it.skip): needs a live Nextcloud; validated manually via quickstart until executed' },
  // Feature 046 (watch-mode folder propagation): with "Sync on file change" on, folder create/delete/
  // rename propagate to the remote immediately (MKCOL / trashbin delete / MOVE), mirroring the file
  // path. Status bar reflects the immediate propagation. File path is unchanged (non-regression).
  { id: 'WF-1', source: 'specs/046-watch-folder-propagation/spec.md (FR-001/005/006/008: createSingleFolder MKCOL, idempotent, exclusions honored; status-bar activity)', layer: 'a' },
  { id: 'WF-2', source: 'specs/046-watch-folder-propagation/spec.md (FR-002: deleteSingleFolder — tracked-only, trashbin/recoverable, untracked no-op, exclusions honored)', layer: 'a' },
  { id: 'WF-3', source: 'specs/046-watch-folder-propagation/spec.md (FR-003/010: renameSingleFolder MOVE, retarget tracking, exclusions honored)', layer: 'a' },
  { id: 'WF-B1-1', source: 'specs/046-watch-folder-propagation (live: folder create/delete/rename propagate immediately as MKCOL/collection-delete/MOVE)', layer: 'b-1', waiver: 'deferred b-1 end-to-end stub (it.skip): needs a live Nextcloud; validated manually via quickstart until executed' },
  { id: 'WF-B1-2', source: 'specs/046-watch-folder-propagation (live: after an immediate folder-op failure, the next full sync converges remote==local — self-healing)', layer: 'b-1', waiver: 'deferred b-1 end-to-end stub (it.skip): needs a live Nextcloud; validated manually via quickstart until executed' },
  // --- MDV: mass-delete breaker skipped-paths visibility (feature 055) + report notes/dir bulk-resolve (feature 056) ---
  { id: 'MDV-2', source: 'specs/main/spec.md §8 (file mass-delete breaker records skippedPaths.all, full/uncapped)', layer: 'a' },
  { id: 'MDV-4', source: 'specs/main/spec.md §8 (ordinary errors unaffected — regression)', layer: 'a' },
  { id: 'MDV-5', source: 'specs/main/spec.md §8 (breaker report notes excluded from sync — isSystemExcluded)', layer: 'a' },
  { id: 'MDV-6', source: 'specs/056-massdelete-breaker-report-bulk-resolve/spec.md (dir mass-delete breaker records dirBreakerSkipped, full/uncapped/category-split)', layer: 'a' },
  { id: 'MDV-7', source: 'specs/056-massdelete-breaker-report-bulk-resolve/spec.md (report note formatting: full listing, no truncation, per-category counts)', layer: 'a' },
  { id: 'MDV-8', source: 'specs/056-massdelete-breaker-report-bulk-resolve/spec.md (resolveSkippedDir: 4 category×choice branches)', layer: 'a' },
  { id: 'MDV-9', source: 'specs/056-massdelete-breaker-report-bulk-resolve/spec.md (resolveAllSkippedDirs: aggregation, in-place mutation, running-guard)', layer: 'a' },
  { id: 'MDV-10', source: 'specs/056-massdelete-breaker-report-bulk-resolve/spec.md (SyncStatusModal: click opens report note, dir-only bulk-resolve row)', layer: 'a', waiver: MDV_DOM },
  // --- OL: open-leaf survives sync (feature 057, GitHub issue #15) ---
  { id: 'OL-1', source: 'specs/main/spec.md §9.5 (text file open -> in-place vault.modify, no delete event)', layer: 'a' },
  { id: 'OL-2', source: 'specs/main/spec.md §9.5 (binary file open -> in-place vault.modifyBinary, no delete event)', layer: 'a' },
  { id: 'OL-3', source: 'specs/main/spec.md §9.5 (not-open file / no workspace injected -> existing tmp-write/remove/rename path unchanged)', layer: 'a' },
];
