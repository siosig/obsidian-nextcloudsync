import { App, Modal } from 'obsidian';
import { MergePreview } from '../types';
import { renderDiffSections } from './diffRender';

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
    this.modalEl.addClass('ncs-diff-modal');
    this.setTitle('Merge preview');
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl, preview } = this;
    contentEl.empty();

    contentEl.createEl('p', { text: preview.path, cls: 'setting-item-description' });

    const status = preview.clean
      ? 'Auto-merge resolves cleanly.'
      : (preview.localExists && preview.remoteExists
        ? 'Auto-merge cannot resolve this — a real sync would write conflict markers (shown on the right).'
        : 'One side only — would be copied as-is.');
    contentEl.createEl('p', { text: `${status}  Nothing was synced.`, cls: 'setting-item-description' });

    // Left-source toggle
    const controls = contentEl.createDiv({ cls: 'ncs-diff-controls' });
    const makeBtn = (label: string, src: 'local' | 'remote') => {
      const b = controls.createEl('button', { text: label, cls: 'ncs-diff-btn' });
      if (this.leftSource === src) b.addClass('mod-cta');
      b.addEventListener('click', () => { this.leftSource = src; this.render(); });
    };
    makeBtn('Before: Local', 'local');
    if (preview.remoteExists) makeBtn('Before: Remote', 'remote');

    const beforeText = this.leftSource === 'remote' ? preview.remote : preview.local;
    const beforeLabel = this.leftSource === 'remote' ? 'Remote (before)' : 'Local (before)';

    // Column header row (gutter + marker + text flex, mirroring the diff-row layout)
    const headers = contentEl.createDiv({ cls: 'ncs-diff-headers' });
    for (const txt of [beforeLabel, 'After (merge result)']) {
      headers.createDiv({ cls: 'ncs-diff-gutter' });  // gutter spacer
      headers.createDiv({ cls: 'ncs-diff-marker' });  // marker spacer
      headers.createDiv({ text: txt, cls: 'ncs-diff-header-cell' });
    }

    // Scrollable diff body (frontmatter + body sections), rendered via the shared renderer.
    const scrollEl = contentEl.createDiv({ cls: 'ncs-diff-scroll' });
    const firstChangedEl = renderDiffSections(scrollEl, beforeText, preview.after);

    // Auto-scroll to the first changed line after layout settles.
    if (firstChangedEl) {
      const target = firstChangedEl;
      window.requestAnimationFrame(() => target.scrollIntoView({ block: 'center' }));
    }
  }
}
