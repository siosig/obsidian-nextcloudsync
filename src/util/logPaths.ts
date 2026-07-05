/**
 * Vault-relative path of this device's single log file. It lives in the user-chosen
 * `logsFolder`; when it is blank the file sits at the vault root.
 */

/** Join a (possibly blank) folder with a filename, stripping trailing slashes. Blank ⇒ root. */
export function joinLogPath(logsFolder: string, filename: string): string {
  const folder = (logsFolder ?? '').replace(/\/+$/, '').trim();
  return folder ? `${folder}/${filename}` : filename;
}

// The log file holds plain text, not Markdown, so it uses a .txt extension — a .md extension
// makes editors render it as Markdown and garble the output. Note: Obsidian hides .txt in the
// File Explorer unless "Detect all file extensions" is on, and Quick Switcher never lists it
// (it indexes notes only); the file is still written and syncable. See the setting's help text.

/**
 * Per-device debug-log path: `<logsFolder>/nextcloud-debug_<host>.txt`. A single file per device
 * carries every log line (feature 052 folded the old separate sync-log into this one file). The
 * host token keeps devices from colliding when another device's log syncs into this vault.
 */
export function debugLogPath(logsFolder: string, host: string): string {
  return joinLogPath(logsFolder, `nextcloud-debug_${host}.txt`);
}

/**
 * True when `path` is THIS device's log file while it is currently being WRITTEN (logging is on).
 * The file must be kept out of sync: the plugin appends to it during a sync, so syncing it both
 * errors (the atomic-write rename races the live append → Obsidian throws "Destination file
 * already exists!") and churns forever.
 *
 * The exclusion is intentionally narrow:
 *   - only THIS device's `host` path (another device's log is not written here, so it stays
 *     syncable — cross-device log collection still works),
 *   - only while logging is ON. Turn logging OFF and the now-static file becomes an ordinary
 *     synced file again.
 */
export function isActiveOwnLog(
  path: string,
  opts: { logsFolder: string; host: string; loggingEnabled: boolean },
): boolean {
  if (!opts.loggingEnabled) return false;
  return path === debugLogPath(opts.logsFolder, opts.host);
}
