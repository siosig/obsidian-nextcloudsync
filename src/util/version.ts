// A recommended minimum, not a hard gate: older servers still connect and sync (features degrade via
// capability detection) and the settings screen shows a recommendation banner.
export const MIN_NEXTCLOUD_VERSION = '33';

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// An empty/unknown version counts as supported: no warning on missing data.
export function isSupportedNextcloudVersion(version: string): boolean {
  if (!version) return true;
  return compareVersions(version, MIN_NEXTCLOUD_VERSION) >= 0;
}
