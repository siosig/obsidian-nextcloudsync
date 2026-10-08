// Normalizes the free-text "Auto-merge file types" setting to the storage form (lowercase, no
// leading dot, de-duplicated, first-appearance order). An all-blank input yields [], which disables
// auto-merge: every conflict then routes to conflictFailurePolicy.

export function parseMergeableExtensions(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(/[,\s]+/)) {
    const ext = raw.trim().toLowerCase().replace(/^\.+/, '');
    if (ext.length === 0 || seen.has(ext)) continue;
    seen.add(ext);
    out.push(ext);
  }
  return out;
}

export function formatMergeableExtensions(exts: readonly string[]): string {
  return exts.join(', ');
}

// Single source of the Auto Merge File / Other File classification, shared by ConflictResolver
// (which strategy applies) and SyncEngine (whether to keep a merge base). No extension = Other File.
export function isAutoMergeFileType(path: string, autoMergeFileTypes: readonly string[]): boolean {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot <= slash || dot === path.length - 1) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return (autoMergeFileTypes ?? [])
    .map((e) => e.trim().replace(/^\.+/, '').toLowerCase())
    .filter((e) => e.length > 0)
    .includes(ext);
}

// Markdown has its own frontmatter strategy regardless of the Auto-Merge classification, and a merge
// base is recorded for every `.md` so frontmatter set-merge can detect deletions even when `md` is
// not an Auto Merge File type (docs/spec.md §6.1).
export function isMarkdown(path: string): boolean {
  return /\.md$/i.test(path);
}
