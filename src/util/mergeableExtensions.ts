// Pure helper for the user-editable "Auto-merge file types" setting (feature 030).
//
// The settings field is a free-text, comma/whitespace-separated list of file extensions. This
// normalizes it into the canonical storage form used by SyncEngine.isMergeable: lowercase, no
// leading dot, trimmed, de-duplicated, blanks dropped. An all-blank input yields [] — which
// disables auto-merge entirely (every conflict then routes to conflictFailurePolicy).

/**
 * Parse a comma/whitespace-separated extension list into normalized, de-duplicated extensions
 * (lowercase, no leading dot). Order of first appearance is preserved.
 */
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

/** Format a stored extension list back into the comma-separated text shown in the input. */
export function formatMergeableExtensions(exts: readonly string[]): string {
  return exts.join(', ');
}

/**
 * True when `path`'s extension is one of the configured Auto Merge File types (case-insensitive).
 * A file without an extension is an Other File. Single source of truth for the Auto Merge File /
 * Other File classification, shared by ConflictResolver (which strategy applies) and SyncEngine
 * (whether to keep a merge base for the file, feature 038).
 */
export function isAutoMergeFileType(path: string, autoMergeFileTypes: readonly string[]): boolean {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot <= slash || dot === path.length - 1) return false; // no extension → Other File
  const ext = path.slice(dot + 1).toLowerCase();
  return (autoMergeFileTypes ?? [])
    .map((e) => e.trim().replace(/^\.+/, '').toLowerCase())
    .filter((e) => e.length > 0)
    .includes(ext);
}
