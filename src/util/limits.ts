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

/** Bulk-upload eligibility thresholds (Nextcloud `/dav/bulk`). See research R8. */
export const BULK_MAX_FILE_BYTES = 1 * 1024 * 1024;       // per-file cap to qualify for a bulk batch
export const BULK_MAX_BATCH_BYTES = 3 * 1024 * 1024;      // total bytes per bulk request
export const BULK_MAX_BATCH_COUNT = 100;                  // max files per bulk request

/** Number of PROPFIND/REPORT response nodes to parse before yielding to the event loop (anti-ANR). */
export const PARSE_YIELD_EVERY = 100;

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
 * True when a file exceeds the configured maximum size and should be skipped.
 * `maxFileSizeMB` of 0 means "unlimited" (never skip).
 */
export function isOverFileSizeLimit(byteLength: number, maxFileSizeMB: number): boolean {
  if (maxFileSizeMB <= 0) return false; // 0 (or negative) = unlimited
  return byteLength / 1024 / 1024 > maxFileSizeMB;
}

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
