/**
 * Vault-relative paths of the two per-device log files. Both live in the user-chosen
 * `logsFolder`; when it is blank the files sit at the vault root.
 */

/** Join a (possibly blank) folder with a filename, stripping trailing slashes. Blank ⇒ root. */
export function joinLogPath(logsFolder: string, filename: string): string {
  const folder = (logsFolder ?? '').replace(/\/+$/, '').trim();
  return folder ? `${folder}/${filename}` : filename;
}

// The log files hold plain text, not Markdown, so they use a .txt extension —
// a .md extension makes editors render them as Markdown and garble the output.

/** Per-device sync-log path: `<logsFolder>/nextcloud-sync_sync_<host>.txt`. */
export function syncLogPath(logsFolder: string, host: string): string {
  return joinLogPath(logsFolder, `nextcloud-sync_sync_${host}.txt`);
}

/** Per-device debug-log path: `<logsFolder>/nextcloud-sync_debug_<host>.txt`. */
export function debugLogPath(logsFolder: string, host: string): string {
  return joinLogPath(logsFolder, `nextcloud-sync_debug_${host}.txt`);
}

/**
 * True when `path` is one of THIS device's log files that is currently being WRITTEN
 * (its output toggle is on). Such a file must be kept out of sync: the plugin appends to it
 * during a sync, so syncing it both errors (the atomic-write rename races the live append →
 * Obsidian throws "Destination file already exists!") and churns forever.
 *
 * The exclusion is intentionally narrow:
 *   - only THIS device's `host` paths (another device's logs are not written here, so they stay
 *     syncable — cross-device log collection still works),
 *   - only while the corresponding toggle is ON. Turn Sync log / Debug log OFF and the now-static
 *     file becomes an ordinary synced file again.
 */
export function isActiveOwnLog(
  path: string,
  opts: { logsFolder: string; host: string; debugLogEnabled: boolean; syncLogEnabled: boolean },
): boolean {
  if (opts.debugLogEnabled && path === debugLogPath(opts.logsFolder, opts.host)) return true;
  if (opts.syncLogEnabled && path === syncLogPath(opts.logsFolder, opts.host)) return true;
  return false;
}
