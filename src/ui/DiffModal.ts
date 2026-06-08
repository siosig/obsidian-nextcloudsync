import { App, Modal } from 'obsidian';
import { MergePreview } from '../types';

type Row = { left?: string; right?: string; type: 'same' | 'del' | 'add' };

/** Line-level LCS diff. */
function lineDiff(aText: string, bText: string): Row[] {
  const a = aText.split('\n');
  const b = bText.split('\n');
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: Row[] = [];
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
function splitFm(text: string): { fm: string; body: string; hasFm: boolean } {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!m) return { fm: '', body: text, hasFm: false };
  return { fm: m[0], body: text.slice(m[0].length).replace(/^\n/, ''), hasFm: true };
}

/**
 * Debug-mode merge preview. Shows the "before" (local / remote toggle) on the left and the
 * "after" (what a real sync would write) on the right. Frontmatter and body are rendered as
 * distinct sections, each with its own line-level diff highlighting:
 *   • Frontmatter section — amber tint for the section header; del/add rows highlighted in red/green
 *   • Body section — plain background header; same del/add highlighting
 * Read-only — opening this changes nothing.
 */
export class DiffModal extends Modal {
  private leftSource: 'local' | 'remote' = 'local';

  constructor(app: App, private readonly preview: MergePreview) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.style.width = 'min(1100px, 95vw)';
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl, preview } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Merge preview' });
    contentEl.createEl('p', { text: preview.path, cls: 'setting-item-description' });

    const status = preview.clean
      ? 'Auto-merge resolves cleanly.'
      : (preview.localExists && preview.remoteExists
        ? 'Auto-merge cannot resolve this — a real sync would write conflict markers (shown on the right).'
        : 'One side only — would be copied as-is.');
    contentEl.createEl('p', { text: `${status}  Nothing was synced.`, cls: 'setting-item-description' });

    // Left-source toggle
    const controls = contentEl.createDiv();
    controls.style.margin = '4px 0 8px';
    const makeBtn = (label: string, src: 'local' | 'remote') => {
      const b = controls.createEl('button', { text: label });
      if (this.leftSource === src) b.addClass('mod-cta');
      b.style.marginRight = '6px';
      b.addEventListener('click', () => { this.leftSource = src; this.render(); });
    };
    makeBtn('Before: Local', 'local');
    if (preview.remoteExists) makeBtn('Before: Remote', 'remote');

    const beforeText = this.leftSource === 'remote' ? preview.remote : preview.local;
    const beforeLabel = this.leftSource === 'remote' ? 'Remote (before)' : 'Local (before)';

    // Split both sides into frontmatter + body
    const bSplit = splitFm(beforeText);
    const aSplit = splitFm(preview.after);

    // Column header row
    const headers = contentEl.createDiv();
    headers.style.display = 'flex';
    headers.style.fontWeight = 'bold';
    headers.style.borderBottom = '1px solid var(--background-modifier-border)';
    for (const txt of [beforeLabel, 'After (merge result)']) {
      const h = headers.createDiv({ text: txt });
      h.style.flex = '1'; h.style.padding = '4px 8px';
    }

    // Scrollable diff body
    const scrollEl = contentEl.createDiv();
    scrollEl.style.maxHeight = '60vh';
    scrollEl.style.overflow = 'auto';
    scrollEl.style.fontFamily = 'var(--font-monospace)';
    scrollEl.style.fontSize = '12px';
    scrollEl.style.whiteSpace = 'pre-wrap';
    scrollEl.style.wordBreak = 'break-word';

    const cellBg = {
      del:  'rgba(255, 89, 89, 0.20)',
      add:  'rgba(83, 200, 110, 0.20)',
      same: 'transparent',
    } as const;

    // Render a section header and return the first changed row element (for auto-scroll).
    const addSectionHeader = (label: string, changedCount: number): HTMLElement => {
      const header = scrollEl.createDiv();
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.fontWeight = 'bold';
      header.style.fontSize = '11px';
      header.style.letterSpacing = '0.05em';
      header.style.textTransform = 'uppercase';
      header.style.position = 'sticky';
      header.style.top = '0';
      header.style.zIndex = '1';
      header.style.padding = '2px 8px';
      header.style.background = changedCount > 0 ? 'rgba(255, 185, 0, 0.18)' : 'var(--background-secondary)';
      header.style.borderBottom = '1px solid var(--background-modifier-border)';
      header.style.color = changedCount > 0 ? 'var(--text-warning)' : 'var(--text-muted)';
      const icon = changedCount > 0 ? '⚠' : '✓';
      const detail = changedCount > 0 ? `differs  (${changedCount} line${changedCount > 1 ? 's' : ''})` : 'identical';
      header.createSpan({ text: `${label}  ${icon} ${detail}` });
      return header;
    };

    // Render a block of aligned diff rows; returns the first changed row element (or null).
    const addRows = (rows: Row[]): HTMLElement | null => {
      let firstChanged: HTMLElement | null = null;
      for (const row of rows) {
        const line = scrollEl.createDiv();
        line.style.display = 'flex';
        if (row.type !== 'same' && !firstChanged) firstChanged = line;
        const left = line.createDiv({ text: row.left ?? '' });
        const right = line.createDiv({ text: row.right ?? '' });
        left.style.flex = '1'; right.style.flex = '1';
        left.style.padding = '0 8px'; right.style.padding = '0 8px';
        left.style.borderRight = '1px solid var(--background-modifier-border)';
        left.style.background  = row.type === 'del' ? cellBg.del : 'transparent';
        right.style.background = row.type === 'add' ? cellBg.add : 'transparent';
      }
      return firstChanged;
    };

    // Frontmatter section (show only when at least one side has frontmatter)
    let firstChangedEl: HTMLElement | null = null;
    if (bSplit.hasFm || aSplit.hasFm) {
      const fmRows = lineDiff(bSplit.fm, aSplit.fm);
      const fmChangedCount = fmRows.filter(r => r.type !== 'same').length;
      addSectionHeader('Frontmatter', fmChangedCount);
      const el = addRows(fmRows);
      if (el && !firstChangedEl) firstChangedEl = el;
    }

    // Body section
    const bodyRows = lineDiff(bSplit.body, aSplit.body);
    const bodyChangedCount = bodyRows.filter(r => r.type !== 'same').length;
    if (bSplit.hasFm || aSplit.hasFm) {
      addSectionHeader('Body', bodyChangedCount);
    }
    const el = addRows(bodyRows);
    if (el && !firstChangedEl) firstChangedEl = el;

    if (scrollEl.children.length === 0) {
      scrollEl.createDiv({ text: '(empty)', cls: 'setting-item-description' });
    }

    // Auto-scroll to the first changed line after layout settles.
    if (firstChangedEl) {
      const target = firstChangedEl;
      requestAnimationFrame(() => target.scrollIntoView({ block: 'center' }));
    }
  }
}
