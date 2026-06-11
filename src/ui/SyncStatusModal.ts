import { App, Modal, Setting } from 'obsidian';
import { SyncErrorDetail, SyncSessionSummary } from '../types';

export interface SyncStatusReport {
  summary: SyncSessionSummary | null;
  conflictedFiles: string[];
  retryFiles: string[];
}

/**
 * Opened by clicking the status bar item. Shows the last sync summary and the files that
 * currently need attention: conflicts and the retry queue. Clicking a file opens it.
 */
export class SyncStatusModal extends Modal {
  constructor(app: App, private readonly report: SyncStatusReport) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, report } = this;
    contentEl.empty();
    this.setTitle('Sync status');

    // Last session summary
    const s = report.summary;
    if (s) {
      const when = new Date(s.startedAt).toLocaleString();
      contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: `Last sync: ${when}  ·  ↑ ${s.uploadedCount}  ↓ ${s.downloadedCount}  `
          + `⚠️ ${s.conflictCount}  ✗ ${s.errorCount}`,
      });
    } else {
      contentEl.createEl('p', { text: 'No sync has run yet in this session.', cls: 'setting-item-description' });
    }

    this.addFileSection('⚠️ Conflicts', report.conflictedFiles,
      'Files with unresolved conflict markers. Open one to resolve it (search #conflict too).');
    this.addFileSection('✗ Queued for retry', report.retryFiles,
      'Files that failed and will be retried on the next sync.');
    this.addErrorSection(s?.errors ?? []);

    if (report.conflictedFiles.length === 0 && report.retryFiles.length === 0
        && (s?.errors.length ?? 0) === 0) {
      contentEl.createEl('p', { text: '🟢 No conflicts or pending retries.' });
    }
  }

  /** What went wrong in the last session: one row per error, with the file (clickable) and reason. */
  private addErrorSection(errors: SyncErrorDetail[]): void {
    if (errors.length === 0) return;
    const { contentEl } = this;
    new Setting(contentEl).setName(`✗ Errors in last sync (${errors.length})`).setHeading();
    contentEl.createEl('p', {
      text: 'What failed during the last sync and why. These reset on the next sync.',
      cls: 'setting-item-description',
    });

    const list = contentEl.createEl('div', { cls: 'ncs-status-list' });
    for (const e of errors) {
      const row = list.createEl('div', { cls: 'ncs-status-row' });
      row.createEl('div', { text: e.path || '(entire sync session)' });
      row.createEl('div', { text: e.message, cls: 'setting-item-description' });
      if (e.path) {
        row.addEventListener('click', () => {
          void this.app.workspace.openLinkText(e.path, '', false);
          this.close();
        });
      }
    }
  }

  private addFileSection(title: string, files: string[], desc: string): void {
    if (files.length === 0) return;
    const { contentEl } = this;
    new Setting(contentEl).setName(`${title} (${files.length})`).setHeading();
    contentEl.createEl('p', { text: desc, cls: 'setting-item-description' });

    const list = contentEl.createEl('div', { cls: 'ncs-status-list' });
    for (const path of files) {
      const row = list.createEl('div', { text: path, cls: 'ncs-status-row' });
      row.addEventListener('click', () => {
        void this.app.workspace.openLinkText(path, '', false);
        this.close();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
