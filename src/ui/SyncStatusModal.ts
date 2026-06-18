import { App, Modal, Setting } from 'obsidian';
import { SyncErrorDetail, SyncFileOp, SyncHistoryEntry, SyncSessionSummary } from '../types';

export interface SyncStatusReport {
  summary: SyncSessionSummary | null;
  conflictedFiles: string[];
  retryFiles: string[];
  /** Per-file sync outcomes within the last 24h, newest first. */
  history: SyncHistoryEntry[];
}

/** Status glyph + accessible label for each recorded file outcome. */
const OP_LABEL: Record<SyncFileOp, { icon: string; text: string }> = {
  uploaded: { icon: '↑', text: 'Uploaded' },
  downloaded: { icon: '↓', text: 'Downloaded' },
  deleted: { icon: '🗑', text: 'Deleted' },
  merged: { icon: '⟷', text: 'Merged' },
  conflicted: { icon: '⚠️', text: 'Conflicted' },
  'local-wins': { icon: '⬆', text: 'Local wins' },
  'remote-wins': { icon: '⬇', text: 'Remote wins' },
  error: { icon: '✗', text: 'Error' },
};

/** Compact "5m ago" / "2h ago" / "just now" label for a past timestamp. */
function formatAgo(at: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
}

/**
 * Opened by clicking the status bar item (desktop only). Shows the last sync summary and the
 * files that currently need attention: conflicts and the retry queue. Clicking a file opens it.
 *
 * A "Sync Now" button at the top triggers a manual sync via the injected `onSyncNow` callback
 * (wired to the plugin's runSyncNow). The dialog stays open and re-renders from a fresh report
 * when the sync completes, so the report provider — not a one-shot snapshot — is injected.
 */
export class SyncStatusModal extends Modal {
  constructor(
    app: App,
    private readonly getReport: () => SyncStatusReport,
    private readonly onSyncNow: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  /** Build (or rebuild) the dialog body from a freshly queried report. Safe to call repeatedly. */
  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle('Sync status');

    // Top action: run a manual sync, then re-render with the new session's report.
    new Setting(contentEl).addButton(btn => btn
      .setButtonText('Sync now')
      .setCta()
      .onClick(async () => {
        await this.onSyncNow();
        this.render();
      }));

    const report = this.getReport();

    // Last session summary
    const s = report.summary;
    if (s) {
      const when = new Date(s.startedAt).toLocaleString();
      contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: `Last sync: ${when}  ·  ↑ ${s.uploadedCount}  ↓ ${s.downloadedCount}  `
          + `⟷ ${s.mergedCount}  ⚠️ ${s.conflictedCount}  ✗ ${s.errorCount}`,
      });
    } else {
      contentEl.createEl('p', { text: 'No sync has run yet in this session.', cls: 'setting-item-description' });
    }

    this.addHistorySection(report.history);

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

  /**
   * Per-file sync activity in the last 24 hours (successes included), newest first. The list is
   * scrollable (capped height with a vertical scrollbar) so a busy sync session stays compact.
   */
  private addHistorySection(history: SyncHistoryEntry[]): void {
    const { contentEl } = this;
    new Setting(contentEl).setName(`🕒 Recent activity · last 24h (${history.length})`).setHeading();

    if (history.length === 0) {
      contentEl.createEl('p', {
        text: 'No files synced in the last 24 hours.',
        cls: 'setting-item-description',
      });
      return;
    }

    const now = Date.now();
    const list = contentEl.createEl('div', { cls: 'ncs-status-list ncs-history-list' });
    for (const e of history) {
      const op = OP_LABEL[e.op];
      const row = list.createEl('div', { cls: 'ncs-status-row' });
      // One compact line per entry: a leading status icon (hover shows the word) conveys the
      // outcome, then the path, then a muted relative time — no separate status-word line.
      const line = row.createEl('div', { cls: 'ncs-history-line' });
      line.createSpan({ cls: 'ncs-history-icon', text: op.icon, attr: { 'aria-label': op.text, title: op.text } });
      line.createSpan({ cls: 'ncs-history-path', text: e.path });
      line.createSpan({ cls: 'ncs-history-time', text: formatAgo(e.at, now) });
      // Errors keep their reason on a second, muted line; the icon already encodes the status.
      if (e.op === 'error' && e.message) {
        row.createEl('div', { text: e.message, cls: 'setting-item-description ncs-history-errmsg' });
      }
      // Deleted files no longer exist locally — don't make them clickable (would recreate the note).
      if (e.op === 'deleted') {
        row.addClass('ncs-status-row-static');
      } else {
        row.addEventListener('click', () => {
          void this.app.workspace.openLinkText(e.path, '', false);
          this.close();
        });
      }
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
