/**
 * Vault-relative paths of the two per-device log files. Both live in the user-chosen
 * `logsFolder`; when it is blank the files sit at the vault root.
 */

/** Join a (possibly blank) folder with a filename, stripping trailing slashes. Blank ⇒ root. */
export function joinLogPath(logsFolder: string, filename: string): string {
  const folder = (logsFolder ?? '').replace(/\/+$/, '').trim();
  return folder ? `${folder}/${filename}` : filename;
}

/** Per-device sync-log path: `<logsFolder>/nextcloud-sync_sync_<host>.md`. */
export function syncLogPath(logsFolder: string, host: string): string {
  return joinLogPath(logsFolder, `nextcloud-sync_sync_${host}.md`);
}

/** Per-device debug-log path: `<logsFolder>/nextcloud-sync_debug_<host>.md`. */
export function debugLogPath(logsFolder: string, host: string): string {
  return joinLogPath(logsFolder, `nextcloud-sync_debug_${host}.md`);
}
