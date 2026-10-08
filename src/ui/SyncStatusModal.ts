import { App, Modal, Setting } from 'obsidian';
import { SyncErrorDetail, SyncFileOp, SyncHistoryEntry } from '../types';
import {
  DIR_BREAKER_REPORT_FILENAME,
  FILE_BREAKER_REPORT_FILENAME,
  formatDirBreakerReportNote,
  formatFileBreakerReportNote,
} from './breakerReport';
import { FORCE_CHOICES, ForceChoice } from './forceResolution';
import {
  ALL_FILTER_OPS,
  filterReport,
  groupByRun,
  makeDefaultFilterState,
  StatusFilterState,
  SyncStatusReport,
} from './statusFilter';
import { formatClock24 } from './timeFormat';

// Survives render() (instance field, not a DOM attribute): a mid-flight re-render (filter toggle, "Sync now" completing)
// recreates a non-disabled Apply button whose click would re-run the same resolution concurrently (last-write-wins).
// Keyed by path because several conflicts resolve independently; the bulk "Apply to all" action uses its own instance.
export class KeyedBusyGate {
  private readonly inFlight = new Set<string>();

  tryEnter(key: string): boolean {
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return true;
  }

  leave(key: string): void {
    this.inFlight.delete(key);
  }
}

const BULK_RESOLVE_KEY = 'bulk';

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

// The report provider (not a one-shot snapshot) is injected so the dialog re-renders from a fresh report when a sync completes.
export class SyncStatusModal extends Modal {
  private readonly resolveGate = new KeyedBusyGate();
  // Separate instance from resolveGate so a bulk action can never collide with a per-file key.
  private readonly bulkResolveGate = new KeyedBusyGate();
  // Separate instance from the conflict gates above so the two bulk capabilities can never collide.
  private readonly dirBreakerBulkResolveGate = new KeyedBusyGate();

  constructor(
    app: App,
    private readonly getReport: () => SyncStatusReport,
    private readonly onSyncNow: () => Promise<void>,
    // Owned by the plugin and shared across opens; defaults to all-checked when omitted.
    private readonly filterState: StatusFilterState = makeDefaultFilterState(),
    private readonly onFilterChange?: () => void,
    // When omitted, conflicts stay click-to-open only. The host surfaces failures and leaves the file conflicted;
    // this modal just re-renders.
    private readonly onForceResolve?: (path: string, choice: ForceChoice) => Promise<void>,
    // The HOST owns the confirmation and the aggregate result Notice; this modal passes the filtered target paths,
    // disables Apply while the batch runs and re-renders. When omitted, no bulk row is rendered.
    private readonly onBulkForceResolve?: (choice: ForceChoice, paths: string[]) => Promise<void>,
    // Bulk-resolve for the paths the dir mass-delete breaker skipped ("remote" matches the remote side, "local" the mirror).
    // The host owns the confirmation and Notice; when omitted, no bulk row is rendered for the dir breaker.
    private readonly onResolveDirBreaker?: (choice: 'remote' | 'local') => Promise<void>,
    // Second entry point to "Mirror from remote"; the host's runRemoteMirror() owns the whole flow (confirmation, Notice,
    // mirrorInProgress guard). When omitted, no button is rendered.
    private readonly onMirrorFromRemote?: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle('Sync status');

    // The Mirror button (only when the host wired onMirrorFromRemote) is mod-warning; it delegates entirely to the host's
    // runRemoteMirror(), then re-renders.
    const topActions = new Setting(contentEl).addButton(btn => btn
      .setButtonText('Sync now')
      .setCta()
      .onClick(async () => {
        await this.onSyncNow();
        this.render();
      }));
    if (this.onMirrorFromRemote) {
      topActions.addButton(btn => btn
        .setButtonText('Mirror from remote')
        // `mod-warning` is the destructive-button class; setDestructive() needs 1.13.0 > minAppVersion
        // (same rationale as the Settings-tab button).
        .setClass('mod-warning')
        .onClick(async () => {
          await this.onMirrorFromRemote!();
          this.render();
        }));
    }

    const report = this.getReport();

    this.addFilterRow();

    const s = report.summary;
    if (s) {
      // 24h clock like the per-entry timestamps; toLocaleString() is avoided because it is locale-dependent (12h/AM-PM) (docs/spec.md §13).
      const when = formatClock24(s.startedAt, Date.now());
      contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: `Last sync: ${when}  ·  ↑ ${s.uploadedCount}  ↓ ${s.downloadedCount}  `
          + `⟷ ${s.mergedCount}  ⚠️ ${s.conflictedCount}  ✗ ${s.errorCount}`,
      });
    } else {
      contentEl.createEl('p', { text: 'No sync has run yet in this session.', cls: 'setting-item-description' });
    }

    const filtered = filterReport(report, this.filterState.checked);

    this.addHistorySection(filtered.history);

    this.addConflictSection(filtered.conflictedFiles);
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

  private addFilterRow(): void {
    new Setting(this.contentEl)
      .setName('Filter by status')
      .setDesc('Show only the selected statuses. All on by default; your selection is remembered.');
    // Full-width block under the setting: the narrow Setting control column squeezed and overlapped the checkboxes on mobile.
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
    const list = contentEl.createDiv({ cls: 'ncs-status-list ncs-history-list' });
    // A single-entry group already shows its own time on the row, so only MULTI-entry groups get a run-start separator.
    for (const group of groupByRun(history)) {
      if (group.entries.length > 1) {
        list.createDiv({
          cls: 'ncs-history-run-sep',
          text: `— sync ${formatClock24(group.runStartedAt, now)} —`,
        });
      }
      for (const e of group.entries) {
        const op = OP_LABEL[e.op];
        const row = list.createDiv({ cls: 'ncs-status-row' });
        const line = row.createDiv({ cls: 'ncs-history-line' });
        line.createSpan({ cls: 'ncs-history-icon', text: op.icon, attr: { 'aria-label': op.text, title: op.text } });
        line.createSpan({ cls: 'ncs-history-path', text: e.path });
        line.createSpan({ cls: 'ncs-history-time', text: formatClock24(e.at, now) });
        if (e.op === 'error' && e.message) {
          row.createDiv({ text: e.message, cls: 'setting-item-description ncs-history-errmsg' });
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

  private async openReportNote(filename: string, content: string): Promise<void> {
    await this.app.vault.adapter.write(filename, content);
    await this.app.workspace.openLinkText(filename, '', false);
    this.close();
  }

  private addErrorSection(errors: SyncErrorDetail[]): void {
    if (errors.length === 0) return;
    const { contentEl } = this;
    new Setting(contentEl).setName(`✗ Errors in last sync (${errors.length})`).setHeading();
    contentEl.createEl('p', {
      text: 'What failed during the last sync and why. These reset on the next sync.',
      cls: 'setting-item-description',
    });

    const list = contentEl.createDiv({ cls: 'ncs-status-list' });
    for (const e of errors) {
      const row = list.createDiv({ cls: 'ncs-status-row' });
      row.createDiv({ text: e.path || '(entire sync session)' });
      row.createDiv({ text: e.message, cls: 'setting-item-description' });

      if (e.dirBreakerSkipped) {
        // Pseudo-label rows never open e.path (that would create an empty note with the pseudo-label as its name);
        // they write and open a report note listing every skipped directory.
        const skipped = e.dirBreakerSkipped;
        row.createDiv({
          text: 'Click to open a report note listing every skipped directory.',
          cls: 'setting-item-description',
        });
        row.addEventListener('click', () => {
          void this.openReportNote(DIR_BREAKER_REPORT_FILENAME, formatDirBreakerReportNote(skipped));
        });
        if (this.onResolveDirBreaker) this.addDirBreakerBulkResolveRow(list, skipped);
      } else if (e.skippedPaths) {
        // Same for the file (absence-deletion) breaker: report note only, no bulk-resolve action.
        const all = e.skippedPaths.all;
        row.createDiv({
          text: 'Click to open a report note listing every skipped file.',
          cls: 'setting-item-description',
        });
        row.addEventListener('click', () => {
          void this.openReportNote(FILE_BREAKER_REPORT_FILENAME, formatFileBreakerReportNote(all));
        });
      } else if (e.path) {
        row.addEventListener('click', () => {
          void this.app.workspace.openLinkText(e.path, '', false);
          this.close();
        });
      }
    }
  }

  // One bulk row for all skipped directories, directly under the error row; no per-item controls.
  private addDirBreakerBulkResolveRow(
    list: HTMLElement,
    skipped: { deleteRemote: string[]; trashLocal: string[] },
  ): void {
    const total = skipped.deleteRemote.length + skipped.trashLocal.length;
    const bulkRow = list.createDiv({ cls: 'setting-item ncs-bulk-conflict-row' });
    bulkRow.addEventListener('click', (evt) => evt.stopPropagation()); // don't trigger the error row's own click
    const info = bulkRow.createDiv({ cls: 'setting-item-info' });
    info.createDiv({ cls: 'setting-item-name', text: `Resolve all ${total} skipped directories` });
    info.createDiv({
      cls: 'setting-item-description',
      text: '"Use remote" recreates/keeps the remote side; "Use local" recreates/keeps the local side.',
    });
    const control = bulkRow.createDiv({ cls: 'setting-item-control' });
    const select = control.createEl('select', { cls: 'dropdown ncs-conflict-select' });
    select.createEl('option', { text: 'Use remote', value: 'remote' });
    select.createEl('option', { text: 'Use local', value: 'local' });
    const applyBtn = control.createEl('button', { text: 'Apply', cls: 'ncs-conflict-apply mod-warning' });
    applyBtn.addEventListener('click', () => {
      if (!this.dirBreakerBulkResolveGate.tryEnter('dir-breaker-bulk')) return;
      applyBtn.disabled = true;
      void this.onResolveDirBreaker!(select.value as 'remote' | 'local').then(() => {
        this.dirBreakerBulkResolveGate.leave('dir-breaker-bulk');
        this.render();
      });
    });
  }

  private addConflictSection(files: string[]): void {
    if (files.length === 0) return;
    const { contentEl } = this;
    new Setting(contentEl).setName(`⚠️ Conflicts (${files.length})`).setHeading();
    contentEl.createEl('p', {
      text: this.onForceResolve
        ? 'Files still in conflict. Open one to resolve it by hand, or pick an action and Apply to force-resolve it now.'
        : 'Files still in conflict. Open one to resolve it by hand.',
      cls: 'setting-item-description',
    });

    // Gated on onBulkForceResolve; targets exactly the filtered set passed to this method.
    if (this.onBulkForceResolve) {
      const bulkRow = contentEl.createDiv({ cls: 'setting-item ncs-bulk-conflict-row' });
      const info = bulkRow.createDiv({ cls: 'setting-item-info' });
      info.createDiv({ cls: 'setting-item-name', text: `Apply to all ${files.length} conflicts` });
      info.createDiv({
        cls: 'setting-item-description',
        text: 'Applies the chosen action to every conflicted file currently listed below.',
      });
      const control = bulkRow.createDiv({ cls: 'setting-item-control' });
      const select = control.createEl('select', { cls: 'dropdown ncs-conflict-select' });
      for (const c of FORCE_CHOICES) select.createEl('option', { text: c.label, value: c.id });
      const applyBtn = control.createEl('button', { text: 'Apply to all', cls: 'ncs-conflict-apply mod-warning' });
      applyBtn.addEventListener('click', () => {
        // Guarded by an instance field, not just `applyBtn.disabled`: a mid-flight re-render recreates this button,
        // so a DOM-only guard would let a stale click re-trigger the resolution.
        if (!this.bulkResolveGate.tryEnter(BULK_RESOLVE_KEY)) return;
        applyBtn.disabled = true;
        void this.onBulkForceResolve!(select.value as ForceChoice, files).then(() => {
          this.bulkResolveGate.leave(BULK_RESOLVE_KEY);
          this.render();
        });
      });
    }

    const list = contentEl.createDiv({ cls: 'ncs-status-list' });
    for (const path of files) {
      const row = list.createDiv({ cls: 'ncs-status-row ncs-conflict-row' });
      const nameEl = row.createSpan({ text: path, cls: 'ncs-conflict-path' });
      nameEl.addEventListener('click', () => {
        void this.app.workspace.openLinkText(path, '', false);
        this.close();
      });
      if (!this.onForceResolve) continue;

      // A resolved file drops out of the list because its conflicted flag is cleared.
      const controls = row.createDiv({ cls: 'ncs-conflict-controls' });
      const select = controls.createEl('select', { cls: 'dropdown ncs-conflict-select' });
      for (const c of FORCE_CHOICES) select.createEl('option', { text: c.label, value: c.id });
      const applyBtn = controls.createEl('button', { text: 'Apply', cls: 'ncs-conflict-apply' });
      applyBtn.addEventListener('click', () => {
        // Guarded by an instance field keyed on `path`, not just `applyBtn.disabled`: a mid-flight re-render recreates this
        // button, so a DOM-only guard would let a stale click re-trigger this resolution.
        if (!this.resolveGate.tryEnter(path)) return;
        applyBtn.disabled = true;
        // The host handles failures (Notice) and never rejects here; a still-conflicted file stays listed.
        void this.onForceResolve!(path, select.value as ForceChoice).then(() => {
          this.resolveGate.leave(path);
          this.render();
        });
      });
    }
  }

  private addFileSection(title: string, files: string[], desc: string): void {
    if (files.length === 0) return;
    const { contentEl } = this;
    new Setting(contentEl).setName(`${title} (${files.length})`).setHeading();
    contentEl.createEl('p', { text: desc, cls: 'setting-item-description' });

    const list = contentEl.createDiv({ cls: 'ncs-status-list' });
    for (const path of files) {
      const row = list.createDiv({ text: path, cls: 'ncs-status-row' });
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
