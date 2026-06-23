import { App, Modal, Setting } from 'obsidian';
import { SyncErrorDetail, SyncFileOp, SyncHistoryEntry } from '../types';
import {
  ALL_FILTER_OPS,
  filterReport,
  groupByRun,
  makeDefaultFilterState,
  StatusFilterState,
  SyncStatusReport,
} from './statusFilter';
import { formatClock24 } from './timeFormat';

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
    /**
     * Session-lifetime status filter selection, owned by the plugin and shared across opens so
     * the choice persists until Obsidian restarts. Defaults to all-checked when omitted.
     */
    private readonly filterState: StatusFilterState = makeDefaultFilterState(),
    /** Called after every filter toggle so the host can persist the selection (FR-011/013). */
    private readonly onFilterChange?: () => void,
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

    // Status filter row: one checkbox per status. Toggling mutates the shared (session) selection
    // and re-renders, so every section below reflects the filter immediately.
    this.addFilterRow();

    // Last session summary (unfiltered totals for the session — a summary, not a list).
    const s = report.summary;
    if (s) {
      // 24h absolute clock (HH:mm, date-prefixed across midnight) — consistent with the per-run /
      // per-entry timestamps below; locale-dependent toLocaleString() (12h/AM-PM) is avoided (spec §13).
      const when = formatClock24(s.startedAt, Date.now());
      contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: `Last sync: ${when}  ·  ↑ ${s.uploadedCount}  ↓ ${s.downloadedCount}  `
          + `⟷ ${s.mergedCount}  ⚠️ ${s.conflictedCount}  ✗ ${s.errorCount}`,
      });
    } else {
      contentEl.createEl('p', { text: 'No sync has run yet in this session.', cls: 'setting-item-description' });
    }

    // Apply the status filter to every section.
    const filtered = filterReport(report, this.filterState.checked);

    this.addHistorySection(filtered.history);

    this.addFileSection('⚠️ Conflicts', filtered.conflictedFiles,
      'Files with unresolved conflict markers. Open one to resolve it (search #conflict too).');
    this.addFileSection('✗ Queued for retry', filtered.retryFiles,
      'Files that failed and will be retried on the next sync.');
    this.addErrorSection(filtered.errors);

    if (filtered.history.length === 0 && filtered.conflictedFiles.length === 0
        && filtered.retryFiles.length === 0 && filtered.errors.length === 0) {
      const allUnchecked = this.filterState.checked.size === 0;
      contentEl.createEl('p', {
        text: allUnchecked
          ? 'No statuses selected — check a status above to show entries.'
          : 'No entries match the selected statuses.',
      });
    }
  }

  /** Render the per-status filter checkboxes (icon + label), wired to the shared selection. */
  private addFilterRow(): void {
    new Setting(this.contentEl)
      .setName('Filter by status')
      .setDesc('Show only the selected statuses. All on by default; your selection is remembered.');
    // Render the chips as a FULL-WIDTH block under the setting (not inside the narrow Setting
    // control column, which squeezed and overlapped the checkboxes on mobile).
    const row = this.contentEl.createDiv({ cls: 'ncs-status-filter' });
    for (const op of ALL_FILTER_OPS) {
      const { icon, text } = OP_LABEL[op];
      const label = row.createEl('label', { cls: 'ncs-status-filter-item', attr: { title: text } });
      const cb = label.createEl('input', { type: 'checkbox' });
      cb.checked = this.filterState.checked.has(op);
      label.toggleClass('is-checked', cb.checked); // chip reflects state for at-a-glance contrast
      cb.addEventListener('change', () => {
        if (cb.checked) this.filterState.checked.add(op);
        else this.filterState.checked.delete(op);
        label.toggleClass('is-checked', cb.checked);
        this.onFilterChange?.(); // persist the selection immediately (survives restart)
        this.render();
      });
      label.createSpan({ cls: 'ncs-status-filter-text', text: `${icon} ${text}` });
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
    // Group the (already-filtered) entries by the sync run that produced them, newest run first, and
    // head each group with a separator showing that run's start time in 24-hour absolute format, so a
    // user can tell which sync execution every line belongs to.
    for (const group of groupByRun(history)) {
      list.createEl('div', {
        cls: 'ncs-history-run-sep',
        text: `— sync ${formatClock24(group.runStartedAt, now)} —`,
      });
      for (const e of group.entries) {
        const op = OP_LABEL[e.op];
        const row = list.createEl('div', { cls: 'ncs-status-row' });
        // One compact line per entry: a leading status icon (hover shows the word) conveys the
        // outcome, then the path, then the entry's own 24-hour time.
        const line = row.createEl('div', { cls: 'ncs-history-line' });
        line.createSpan({ cls: 'ncs-history-icon', text: op.icon, attr: { 'aria-label': op.text, title: op.text } });
        line.createSpan({ cls: 'ncs-history-path', text: e.path });
        line.createSpan({ cls: 'ncs-history-time', text: formatClock24(e.at, now) });
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
