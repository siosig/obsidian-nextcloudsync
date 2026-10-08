// A file is excluded when its path equals an entry or lies under "entry/" (folder-boundary prefix
// match, not substring: "Attachments" never captures "Attachments-old"). No globs, to keep the
// setting fool-proof.

// Always excluded, independent of the user's list; same folder-boundary rule, so `.github`,
// `.trashcan` and `.gitignore` are not captured (docs/spec.md §9.3a).
//  - `.git`:   piecewise file sync corrupts a repository (discussion #6).
//  - `.trash`: Obsidian's device-local trash; syncing it churns against trashFile-based deletion.
// Targeted on purpose, not "all dotfolders": other root dot content (`.archive/`, `.env`) must sync.
export const HARD_EXCLUDED_FOLDERS: readonly string[] = ['.git', '.trash'];

// Returns null when the input denotes the whole vault: excluding the root would stop all syncing.
export function normalizeExcludedFolder(input: string): string | null {
  if (typeof input !== 'string') return null;
  let p = input.trim();
  if (p.length === 0) return null;
  p = p.replace(/\\/g, '/');
  p = p.replace(/\/{2,}/g, '/');
  p = p.replace(/^\.\//, '');
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (p.length === 0 || p === '.') return null;
  return p;
}

// Case-sensitive, matching Obsidian's logical vault paths.
export function isUnderExcludedFolder(path: string, folders: readonly string[]): boolean {
  if (!folders || folders.length === 0) return false;
  for (const entry of folders) {
    if (!entry) continue;
    if (path === entry || path.startsWith(entry + '/')) return true;
  }
  return false;
}

// Suggestions for the "Add excluded folder" input. Output preserves input order, so pass a sorted
// `allFolders` for sorted suggestions.
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
    if (folder === null) continue;
    if (seen.has(folder)) continue;
    if (isUnderExcludedFolder(folder, excluded)) continue;
    if (q.length > 0 && !folder.toLowerCase().includes(q)) continue;
    seen.add(folder);
    out.push(folder);
  }
  return out;
}
