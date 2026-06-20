// Shared frontmatter-aware, line-level LCS diff rendering. Used by DiffModal (merge preview)
// and CompareModal (local vs remote compare) so both render diffs identically (DRY).

export type DiffRow = { left?: string; right?: string; type: 'same' | 'del' | 'add' };

/** Line-level LCS diff between two texts. */
export function lineDiff(aText: string, bText: string): DiffRow[] {
  const a = aText.split('\n');
  const b = bText.split('\n');
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { rows.push({ left: a[i], right: b[j], type: 'same' }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ left: a[i], type: 'del' }); i++; }
    else { rows.push({ right: b[j], type: 'add' }); j++; }
  }
  while (i < m) { rows.push({ left: a[i], type: 'del' }); i++; }
  while (j < n) { rows.push({ right: b[j], type: 'add' }); j++; }
  return rows;
}

/** Split a document into its frontmatter block and body. */
export function splitFm(text: string): { fm: string; body: string; hasFm: boolean } {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!m) return { fm: '', body: text, hasFm: false };
  return { fm: m[0], body: text.slice(m[0].length).replace(/^\n/, ''), hasFm: true };
}

/** Append a "Frontmatter ⚠ differs (N lines)" / "✓ identical" section header. */
function addSectionHeader(scrollEl: HTMLElement, label: string, changedCount: number): void {
  const header = scrollEl.createDiv({ cls: 'ncs-diff-section-header' });
  if (changedCount > 0) header.addClass('is-changed');
  const icon = changedCount > 0 ? '⚠' : '✓';
  const detail = changedCount > 0 ? `differs  (${changedCount} line${changedCount > 1 ? 's' : ''})` : 'identical';
  header.createSpan({ text: `${label}  ${icon} ${detail}` });
}

/** Render aligned diff rows into scrollEl; returns the first changed row element (or null). */
function addRows(scrollEl: HTMLElement, rows: DiffRow[]): HTMLElement | null {
  let firstChanged: HTMLElement | null = null;
  let lNum = 0, rNum = 0;
  for (const row of rows) {
    if (row.left !== undefined) lNum++;
    if (row.right !== undefined) rNum++;
    const line = scrollEl.createDiv({ cls: 'ncs-diff-row' });
    if (row.type !== 'same' && !firstChanged) firstChanged = line;

    // Left: line-number gutter + marker + text
    line.createDiv({ text: row.left !== undefined ? String(lNum) : '', cls: 'ncs-diff-gutter' });
    const lMarker = line.createDiv({ text: row.type === 'del' ? '−' : ' ', cls: 'ncs-diff-marker' });
    const left = line.createDiv({ text: row.left ?? '', cls: 'ncs-diff-cell ncs-diff-cell-left' });

    // Right: line-number gutter + marker + text
    line.createDiv({ text: row.right !== undefined ? String(rNum) : '', cls: 'ncs-diff-gutter' });
    const rMarker = line.createDiv({ text: row.type === 'add' ? '+' : ' ', cls: 'ncs-diff-marker' });
    const right = line.createDiv({ text: row.right ?? '', cls: 'ncs-diff-cell' });

    if (row.type === 'del') { lMarker.addClass('is-del'); left.addClass('is-del'); }
    if (row.type === 'add') { rMarker.addClass('is-add'); right.addClass('is-add'); }
  }
  return firstChanged;
}

/**
 * Render a frontmatter-aware diff of `beforeText` (left) vs `afterText` (right) into `scrollEl`.
 * Frontmatter and body are diffed as separate sections (each with its own header) when either
 * side has frontmatter. Returns the first changed row element so callers can auto-scroll to it.
 */
export function renderDiffSections(scrollEl: HTMLElement, beforeText: string, afterText: string): HTMLElement | null {
  const bSplit = splitFm(beforeText);
  const aSplit = splitFm(afterText);
  let firstChangedEl: HTMLElement | null = null;

  if (bSplit.hasFm || aSplit.hasFm) {
    const fmRows = lineDiff(bSplit.fm, aSplit.fm);
    addSectionHeader(scrollEl, 'Frontmatter', fmRows.filter(r => r.type !== 'same').length);
    const el = addRows(scrollEl, fmRows);
    if (el && !firstChangedEl) firstChangedEl = el;
    addSectionHeader(scrollEl, 'Body', lineDiff(bSplit.body, aSplit.body).filter(r => r.type !== 'same').length);
  }

  const el = addRows(scrollEl, lineDiff(bSplit.body, aSplit.body));
  if (el && !firstChangedEl) firstChangedEl = el;

  if (scrollEl.children.length === 0) {
    scrollEl.createDiv({ text: '(empty)', cls: 'setting-item-description' });
  }
  return firstChangedEl;
}
