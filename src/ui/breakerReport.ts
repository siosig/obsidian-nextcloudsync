// The breaker's `path` is a pseudo-label, not a real vault file, so opening it would create an empty note with that name.
// Instead a single fixed-name report note is rewritten with the full candidate list and opened.
// Fixed name (not per-timestamp) so it never accumulates stale copies; excluded from sync (isSystemExcluded) as a device-local diagnostic.

export const DIR_BREAKER_REPORT_FILENAME = 'nextcloud-sync-dir-breaker-report.md';

export const FILE_BREAKER_REPORT_FILENAME = 'nextcloud-sync-file-breaker-report.md';

// deleteRemote entries exist on the remote but not locally (the breaker refused to delete them remotely); trashLocal entries are the reverse.
export function formatDirBreakerReportNote(skipped: { deleteRemote: string[]; trashLocal: string[] }): string {
  const lines: string[] = [
    '# Nextcloud Sync — directory mass-delete breaker report',
    '',
    'This note lists every directory the mass-delete safety breaker refused to delete, because too ' +
      'many looked deleted at once (often a sign of a partial or failed remote listing, not a real ' +
      'mass deletion). Nothing has been changed — use "Use remote" / "Use local" in the Sync status ' +
      'dialog to resolve all of them at once, or investigate manually.',
    '',
    `## Missing locally, present on remote — would be deleted from remote (${skipped.deleteRemote.length})`,
    '',
    ...(skipped.deleteRemote.length ? skipped.deleteRemote.map((p) => `- ${p}`) : ['*(none)*']),
    '',
    `## Missing on remote, present locally — would be deleted locally (${skipped.trashLocal.length})`,
    '',
    ...(skipped.trashLocal.length ? skipped.trashLocal.map((p) => `- ${p}`) : ['*(none)*']),
    '',
  ];
  return lines.join('\n');
}

export function formatFileBreakerReportNote(all: string[]): string {
  const lines: string[] = [
    '# Nextcloud Sync — file mass-delete breaker report',
    '',
    'This note lists every file the mass-delete safety breaker refused to delete locally, because too ' +
      'many appeared deleted on the remote at once (often a sign of a partial or failed remote ' +
      'listing, not a real mass deletion). Nothing has been changed locally.',
    '',
    `## Appears deleted on the remote (${all.length})`,
    '',
    ...(all.length ? all.map((p) => `- ${p}`) : ['*(none)*']),
    '',
  ];
  return lines.join('\n');
}
