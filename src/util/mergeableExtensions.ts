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
