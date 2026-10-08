// A blank `logsFolder` puts the file at the vault root.
export function joinLogPath(logsFolder: string, filename: string): string {
  const folder = (logsFolder ?? '').replace(/\/+$/, '').trim();
  return folder ? `${folder}/${filename}` : filename;
}

// Plain text, so .txt: a .md extension makes editors render it as Markdown. Obsidian hides .txt in
// the File Explorer unless "Detect all file extensions" is on; the file is still written and syncable.
// The host token keeps devices from colliding when another device's log syncs into this vault.
export function debugLogPath(logsFolder: string, host: string): string {
  return joinLogPath(logsFolder, `nextcloud-debug_${host}.txt`);
}

// Syncing the file being appended to errors (the atomic-write rename races the live append:
// "Destination file already exists!") and churns forever. Narrow on purpose: only THIS device's
// file (other devices' logs still sync) and only while logging is on (docs/spec.md §9.1).
export function isActiveOwnLog(
  path: string,
  opts: { logsFolder: string; host: string; loggingEnabled: boolean },
): boolean {
  if (!opts.loggingEnabled) return false;
  return path === debugLogPath(opts.logsFolder, opts.host);
}
