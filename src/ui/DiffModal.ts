import { App, Modal } from 'obsidian';
import { MergePreview } from '../types';
import { renderDiffSections } from './diffRender';

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

    // Header cells mirror the diff-row layout (gutter, marker, text).
    const headers = contentEl.createDiv({ cls: 'ncs-diff-headers' });
    for (const txt of [beforeLabel, 'After (merge result)']) {
      headers.createDiv({ cls: 'ncs-diff-gutter' });
      headers.createDiv({ cls: 'ncs-diff-marker' });
      headers.createDiv({ text: txt, cls: 'ncs-diff-header-cell' });
    }

    const scrollEl = contentEl.createDiv({ cls: 'ncs-diff-scroll' });
    const firstChangedEl = renderDiffSections(scrollEl, beforeText, preview.after);

    // Scroll after layout settles so the first changed line is centred.
    if (firstChangedEl) {
      const target = firstChangedEl;
      window.requestAnimationFrame(() => target.scrollIntoView({ block: 'center' }));
    }
  }
}
