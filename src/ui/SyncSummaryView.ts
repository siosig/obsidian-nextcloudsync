import { App, Modal } from 'obsidian';
import { SyncSessionSummary } from '../types';

export class SyncSummaryView extends Modal {
  constructor(app: App, private readonly summary: SyncSessionSummary | null) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, summary } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Last sync session' });

    if (!summary) {
      contentEl.createEl('p', { text: 'No sync session has been run yet.' });
      return;
    }

    const started = new Date(summary.startedAt).toLocaleString();
    const completed = summary.completedAt ? new Date(summary.completedAt).toLocaleString() : 'In progress…';
    const duration = summary.completedAt
      ? `${((summary.completedAt - summary.startedAt) / 1000).toFixed(1)}s`
      : '—';

    const table = contentEl.createEl('table');
    const addRow = (label: string, value: string) => {
      const row = table.insertRow();
      row.insertCell(0).setText(label);
      row.insertCell(1).setText(value);
    };

    addRow('Started', started);
    addRow('Completed', completed);
    addRow('Duration', duration);
    addRow('↑ Uploaded', String(summary.uploadedCount));
    addRow('↓ Downloaded', String(summary.downloadedCount));
    addRow('⟷ Merged', String(summary.mergedCount));
    addRow('⚠️ Conflicted', String(summary.conflictedCount));
    addRow('✗ Errors', String(summary.errorCount));

    if (summary.retriedFiles.length > 0) {
      contentEl.createEl('h3', { text: 'Files queued for retry' });
      const ul = contentEl.createEl('ul');
      summary.retriedFiles.forEach(f => ul.createEl('li', { text: f }));
    }

    contentEl.createEl('button', { text: 'Close' })
      .addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
