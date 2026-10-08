// Within this window of "now" or the last sync, change detection hashes even if (mtime, size) match:
// some mobile filesystems have 1-2 s mtime granularity, so a same-size edit would be missed
// (docs/spec.md §4.4).
export const SIGNATURE_SAFETY_WINDOW_MS = 2000;

// Larger files are hashed lazily at upload time, bounding memory/CPU of the initial scan on mobile.
export const MAX_HASH_SIZE = 20 * 1024 * 1024;

// Byte budget for the ByteSemaphore: `requestUrl` buffers whole bodies, so bytes (not just count)
// must be bounded to avoid OOM (docs/plan.md §11).
export const MAX_INFLIGHT_BYTES_DESKTOP = 100 * 1024 * 1024;
export const MAX_INFLIGHT_BYTES_MOBILE = 30 * 1024 * 1024;

// Response nodes parsed before yielding to the event loop (anti-ANR).
export const PARSE_YIELD_EVERY = 100;

// Root-ETag short-circuit: after this many consecutive short-circuited full scans, force a real one.
// Bounds drift of a remote file that is untracked since the last real scan (docs/spec.md §8a.5).
export const FORCE_FULL_SCAN_EVERY = 20;

// Mass-delete circuit breaker: floor and fraction of the tracked set (docs/spec.md §8).
export const MASS_DELETE_MIN = 20;
export const MASS_DELETE_FRACTION = 0.2;

// Exceeding this signals a partial/failed remote listing: a healthy one rarely loses a large
// fraction of the vault at once.
export function massDeleteLimit(trackedCount: number): number {
  return Math.max(MASS_DELETE_MIN, Math.floor(trackedCount * MASS_DELETE_FRACTION));
}

// Honours the `massDeleteLimit` setting: -1 (default) = automatic, 0 = unlimited (breaker off),
// N > 0 = fixed limit. Any other negative value is treated as automatic.
export function effectiveMassDeleteLimit(configured: number, trackedCount: number): number {
  if (configured === 0) return Number.POSITIVE_INFINITY;
  if (configured > 0) return configured;
  return massDeleteLimit(trackedCount);
}

export function isMassDeletionGuarded(candidateCount: number, trackedCount: number): boolean {
  return candidateCount > massDeleteLimit(trackedCount);
}

// First-run default only. navigator.deviceMemory is capped at 8 and undefined on iOS (WKWebView),
// where the conservative 3 applies.
export function resolveConcurrencyDefault(deviceMemoryGB: number | undefined): number {
  if (deviceMemoryGB == null) return 3;
  if (deviceMemoryGB >= 8) return 16;
  if (deviceMemoryGB >= 4) return 8;
  return 4;
}

// Only an EMPTY body for a file advertised as non-empty is anomalous. A size mismatch is deliberately
// not flagged: Obsidian's `requestUrl` on iOS reports a slightly different byte count (e.g. 1948 vs
// 1949) while the server is consistent, so a mismatch check refuses legitimate downloads.
export function isAnomalousRemoteContent(remoteSize: number, receivedBytes: number): boolean {
  return remoteSize > 0 && receivedBytes === 0;
}

// `maxFileSizeMB` <= 0 means unlimited.
export function isOverFileSizeLimit(byteLength: number, maxFileSizeMB: number): boolean {
  if (maxFileSizeMB <= 0) return false;
  return byteLength / 1024 / 1024 > maxFileSizeMB;
}

// Network type is undetectable on iOS (no navigator.connection), so the setting is ignored there.
export function isCellularBlocked(
  syncOnWifiOnly: boolean,
  isIosApp: boolean,
  connectionType: string | undefined,
): boolean {
  if (!syncOnWifiOnly || isIosApp) return false;
  return connectionType === 'cellular';
}
