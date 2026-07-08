/** Pure decision helpers for mobile-related sync limits. Kept side-effect free for testability. */

/**
 * Safety window (ms) for the stat-signature fast-path. When a file's mtime is within this window of
 * "now" or the last sync-completion time, change detection forces a content hash even if the
 * (mtime, size) signature matches — because some mobile filesystems have 1–2 s mtime granularity, so
 * a same-size in-place edit made within that window would otherwise be missed. See research R2.
 */
export const SIGNATURE_SAFETY_WINDOW_MS = 2000;

/**
 * Files larger than this are not pre-hashed during the local scan (their hash is computed lazily at
 * upload time). Bounds peak memory/CPU of the initial scan on mobile. See research R6.
 */
export const MAX_HASH_SIZE = 20 * 1024 * 1024;

/**
 * Total in-flight bytes allowed across concurrent transfers (the byte budget for the ByteSemaphore).
 * `requestUrl` buffers whole bodies in memory, so concurrency must be bounded by bytes, not just
 * count, to avoid OOM. Desktop is generous; mobile is tight. A single file larger than the budget is
 * admitted alone. See research R5.
 */
export const MAX_INFLIGHT_BYTES_DESKTOP = 100 * 1024 * 1024;
export const MAX_INFLIGHT_BYTES_MOBILE = 30 * 1024 * 1024;

/** Number of PROPFIND/REPORT response nodes to parse before yielding to the event loop (anti-ANR). */
export const PARSE_YIELD_EVERY = 100;

/**
 * Root-ETag short-circuit (spec 023): after this many CONSECUTIVE short-circuited full-scans (where
 * the vault root ETag matched the stored one and the remote listing was rebuilt from State), force a
 * real full scan even on a match. Bounds the rare drift of a remote file that exists but is untracked
 * after the last real scan, while keeping ~95% of unchanged syncs fast. See specs/main/spec.md §8a.
 */
export const FORCE_FULL_SCAN_EVERY = 20;

/** Mass-delete circuit breaker: floor and fraction of the tracked set (specs/main/spec.md §8). */
export const MASS_DELETE_MIN = 20;
export const MASS_DELETE_FRACTION = 0.2;

/**
 * Upper bound on how many "remotely absent" tracked files may be deleted locally in one full-scan
 * reconciliation: `max(20, floor(20% of tracked))`. A healthy full listing rarely loses a large
 * fraction of the vault at once, so exceeding this signals a partial/failed remote listing.
 */
export function massDeleteLimit(trackedCount: number): number {
  return Math.max(MASS_DELETE_MIN, Math.floor(trackedCount * MASS_DELETE_FRACTION));
}

/**
 * Feature 049: the effective mass-delete limit honouring the user's `massDeleteLimit` setting.
 *   -1 (default) → the automatic dynamic {@link massDeleteLimit} (safe default);
 *    0           → unlimited (breaker off — opt-in, risky);
 *    N > 0       → a fixed absolute limit.
 * Any other negative value is treated as automatic (defensive).
 */
export function effectiveMassDeleteLimit(configured: number, trackedCount: number): number {
  if (configured === 0) return Number.POSITIVE_INFINITY;
  if (configured > 0) return configured;
  return massDeleteLimit(trackedCount);
}

/**
 * True when the number of local-deletion candidates exceeds {@link massDeleteLimit} for the tracked
 * set — i.e. the mass-delete circuit breaker should fire and refuse the bulk local deletion.
 */
export function isMassDeletionGuarded(candidateCount: number, trackedCount: number): boolean {
  return candidateCount > massDeleteLimit(trackedCount);
}

/**
 * Resolve the default network concurrency from device memory, identical on every platform (no
 * Platform branch). navigator.deviceMemory is capped at 8 by the browser and is undefined on iOS
 * (WKWebView) — an unknown value keeps a conservative 3. Sync of many small files is round-trip
 * bound, so concurrency scales with available RAM; the >=8 tier preserves the established desktop
 * default of 16. Existing users keep their saved value (this only sets the first-run default).
 */
export function resolveConcurrencyDefault(deviceMemoryGB: number | undefined): number {
  if (deviceMemoryGB == null) return 3;
  if (deviceMemoryGB >= 8) return 16;
  if (deviceMemoryGB >= 4) return 8;
  return 4;
}

/**
 * Server-anomaly guard (spec 025, report §4.5): true when downloaded remote content must NOT be
 * applied over a local file because the server returned an EMPTY body for a file it advertised as
 * non-empty (PROPFIND getcontentlength > 0) — the clear "server returned nothing / 0-byte" anomaly
 * (S3-mount glitch, ETag not bumped, etc.). A legitimate empty file is NOT flagged: it advertises
 * size 0 and a 0-byte body agree (remoteSize === 0 → false).
 *
 * IMPORTANT (spec 025 fix): we deliberately do NOT flag a non-zero size MISMATCH. On real clients the
 * downloaded `arrayBuffer.byteLength` does not reliably equal the server's content-length — Obsidian's
 * `requestUrl` on iOS reports a slightly different byte count (e.g. 1948 → 1949, scaling with
 * multi-byte/Japanese content), while the server itself is consistent (verified: PROPFIND == GET
 * Content-Length == actual bytes). Treating any mismatch as an anomaly produced massive false
 * positives that REFUSED legitimate downloads (a remote→local sync gap). Only a genuinely empty
 * received body is treated as anomalous.
 */
export function isAnomalousRemoteContent(remoteSize: number, receivedBytes: number): boolean {
  return remoteSize > 0 && receivedBytes === 0;
}

/**
 * True when a file exceeds the configured maximum size and should be skipped.
 * `maxFileSizeMB` of 0 means "unlimited" (never skip).
 */
export function isOverFileSizeLimit(byteLength: number, maxFileSizeMB: number): boolean {
  if (maxFileSizeMB <= 0) return false; // 0 (or negative) = unlimited
  return byteLength / 1024 / 1024 > maxFileSizeMB;
}

/**
 * Cap on how many skipped-file paths are collected as a representative sample during a sync run
 * (e.g. paths skipped for exceeding `maxFileSizeMB`). The full count is tracked separately, so the UI
 * can show the first `MAX_SKIPPED_PATHS_SAMPLE` paths plus an "…and N more" summary line without
 * holding every skipped path in memory for large vaults.
 */
export const MAX_SKIPPED_PATHS_SAMPLE = 10;

/**
 * True when syncing should be skipped because "Wi-Fi only" is on and the connection is cellular.
 * Network type is undetectable on iOS (no navigator.connection), so the setting is ignored there.
 */
export function isCellularBlocked(
  syncOnWifiOnly: boolean,
  isIosApp: boolean,
  connectionType: string | undefined,
): boolean {
  if (!syncOnWifiOnly || isIosApp) return false;
  return connectionType === 'cellular';
}
