// Feature 056: mass-delete breaker report notes. When a breaker fires, the Sync status dialog's
// error row used to be clickable via the same `openLinkText` path as a real per-file error — but the
// breaker's `path` is a pseudo-label (e.g. "(dir mass-delete breaker)"), not a real vault file, so
// clicking it silently CREATED an empty note with that literal name (a bug). Instead, clicking now
// (re)writes a single fixed-name report note with the full candidate list and opens THAT — giving the
// user a real, scrollable/searchable Obsidian document to review at leisure, without cramming
// potentially hundreds of paths into the compact dialog.
//
// Fixed, single filename per breaker (not per-timestamp): re-generated fresh each time it's opened,
// so it never accumulates stale copies. Excluded from sync (see isSystemExcluded) since it's a
// device-local diagnostic snapshot, not vault content worth syncing.

/** Vault-root filename for the directory mass-delete breaker's report note (fixed, always overwritten). */
export const DIR_BREAKER_REPORT_FILENAME = 'nextcloud-sync-dir-breaker-report.md';

/** Vault-root filename for the file mass-delete breaker's report note (fixed, always overwritten). */
export const FILE_BREAKER_REPORT_FILENAME = 'nextcloud-sync-file-breaker-report.md';

/**
 * Markdown content for the directory mass-delete breaker report: every skipped candidate, grouped by
 * which side it would have been removed from. `deleteRemote` entries are still present on the remote
 * but missing locally (the breaker refused to delete them from the remote); `trashLocal` entries are
 * still present locally but missing on the remote (the breaker refused to trash them locally).
 */
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

/**
 * Markdown content for the file (absence-deletion) mass-delete breaker report: every file that
 * appears deleted on the remote, which the breaker refused to delete locally.
 */
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
