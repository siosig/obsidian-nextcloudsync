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
