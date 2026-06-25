// Pure helpers for the user-managed "Excluded folders" sync filter.
//
// A file is excluded when its vault-relative path matches a registered entry at a
// folder boundary (prefix match): entry itself, or anything under "entry/". This is
// intentionally NOT a substring match, so "Attachments" never captures "Attachments-old".
// No glob/wildcard support — folder-prefix only — to keep the setting fool-proof.

/**
 * Normalize a user-entered folder path into the canonical vault-relative form used for
 * storage and comparison, or return null when the input denotes the whole vault (and
 * therefore must be rejected, since excluding the root would stop all syncing).
 *
 * Steps (fixed order): trim → backslashes to "/" → collapse repeated slashes →
 * strip a leading "./" → strip leading/trailing slashes. Empty result → null.
 */
export function normalizeExcludedFolder(input: string): string | null {
  if (typeof input !== 'string') return null;
  let p = input.trim();
  if (p.length === 0) return null;
  p = p.replace(/\\/g, '/');
  p = p.replace(/\/{2,}/g, '/');
  p = p.replace(/^\.\//, '');
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  // A bare "." (current dir) collapses to the vault root → reject.
  if (p.length === 0 || p === '.') return null;
  return p;
}

/**
 * True when `path` (vault-relative, "/"-separated) falls under any excluded entry —
 * either equal to the entry or nested beneath it at a folder boundary. Case-sensitive,
 * matching Obsidian's logical vault paths. An empty list never excludes anything.
 */
export function isUnderExcludedFolder(path: string, folders: readonly string[]): boolean {
  if (!folders || folders.length === 0) return false;
  for (const entry of folders) {
    if (!entry) continue;
    if (path === entry || path.startsWith(entry + '/')) return true;
  }
  return false;
}
