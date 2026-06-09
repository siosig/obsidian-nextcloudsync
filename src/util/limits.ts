/** Pure decision helpers for mobile-related sync limits. Kept side-effect free for testability. */

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
