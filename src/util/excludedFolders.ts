// Pure helpers for the user-managed "Excluded folders" sync filter.
//
// A file is excluded when its vault-relative path matches a registered entry at a
// folder boundary (prefix match): entry itself, or anything under "entry/". This is
// intentionally NOT a substring match, so "Attachments" never captures "Attachments-old".
// No glob/wildcard support — folder-prefix only — to keep the setting fool-proof.

/**
 * Machine-managed vault-root folders that are ALWAYS excluded from sync, independent of the user's
 * excludedFolders list. Matched with the same folder-boundary rule as user entries
 * (`isUnderExcludedFolder`), so only these exact folders and their descendants are excluded — never
 * same-prefix siblings (`.github`, `.trashcan`) or same-prefix files (`.gitignore`).
 *
 *  - `.git`   — a machine-managed repository; piecewise file sync corrupts it (discussion #6).
 *  - `.trash` — Obsidian's device-local trash; syncing it clutters every device and churns against
 *               the plugin's own trashFile-based deletion (remote delete → local .trash → re-upload).
 *
 * This is a TARGETED list, not a blanket "all dotfolders" rule: other root dot content (`.archive/`,
 * `.env`) must keep syncing (Task 7 / collectDotPaths).
 */
export const HARD_EXCLUDED_FOLDERS: readonly string[] = ['.git', '.trash'];

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

/**
 * Candidate folders for the "Add excluded folder" input suggestion (feature 029). The match pool is
 * every vault folder that is NOT already excluded — neither registered exactly nor nested under a
 * registered entry — and whose normalized path contains `query` (case-insensitive substring). The
 * vault root is never a candidate (excluding it would stop all syncing). Output preserves the input
 * order, so pass a sorted `allFolders` for sorted suggestions. Pure — no Obsidian/DOM access.
 */
export function filterExcludableFolders(
  allFolders: readonly string[],
  excluded: readonly string[],
  query: string,
): string[] {
  const q = query.trim().toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of allFolders) {
    const folder = normalizeExcludedFolder(raw);
    if (folder === null) continue;                          // vault root / empty → skip
    if (seen.has(folder)) continue;                         // de-dup normalized paths
    if (isUnderExcludedFolder(folder, excluded)) continue;  // already excluded (self or nested)
    if (q.length > 0 && !folder.toLowerCase().includes(q)) continue; // substring filter
    seen.add(folder);
    out.push(folder);
  }
  return out;
}
