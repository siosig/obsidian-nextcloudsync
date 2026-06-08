/**
 * Nextcloud server version handling.
 *
 * The plugin's Nextcloud-specific features target Nextcloud 33 (Hub 26 "Winter") and
 * later. Older servers are no longer hard-blocked: the plugin still connects and syncs
 * (features degrade via capability detection), but the settings screen surfaces a
 * recommendation banner. This is therefore a *recommended* minimum, not a hard gate.
 */
export const MIN_NEXTCLOUD_VERSION = '33';

/** Compare dotted version strings. Returns <0, 0, or >0 like a numeric comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Whether a detected Nextcloud version meets the recommended minimum.
 * An empty/unknown version is treated as supported (we don't warn on missing data).
 */
export function isSupportedNextcloudVersion(version: string): boolean {
  if (!version) return true;
  return compareVersions(version, MIN_NEXTCLOUD_VERSION) >= 0;
}
