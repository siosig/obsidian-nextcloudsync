import { App, Modal, Setting } from 'obsidian';
import { SyncErrorDetail, SyncFileOp, SyncHistoryEntry } from '../types';
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

/**
 * Tracks which force-resolution operations (keyed by file path) are currently in flight, surviving
 * `render()` (an instance field, not a DOM attribute). Without this, a re-render triggered mid-flight
 * by an unrelated interaction (a filter toggle, or "Sync now" completing) recreates a fresh,
 * non-disabled Apply button, and clicking it re-triggers the same resolution concurrently with the
 * still-pending first call (last-write-wins loses one). Mirrors CompareModal's instance-field `busy`
 * pattern (see `runStrategy`); keyed here because several conflicts may be resolved independently. The
 * bulk "Apply to all" action uses its own separate instance (a single, unkeyed slot) so it can't
 * collide with a per-file key. (G6-1)
 */
export class KeyedBusyGate {
  private readonly inFlight = new Set<string>();

  /** Marks `key` as in flight and returns true, unless it's already in flight (then a no-op false). */
  tryEnter(key: string): boolean {
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return true;
  }

  leave(key: string): void {
    this.inFlight.delete(key);
  }
}

/** Fixed key used with a dedicated `KeyedBusyGate` instance for the bulk "Apply to all" action. */
const BULK_RESOLVE_KEY = 'bulk';

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
  /** Per-file force-resolve guard (G6-1), keyed by path; survives `render()`. */
  private readonly resolveGate = new KeyedBusyGate();
  /** Bulk "Apply to all" force-resolve guard (G6-1); a separate instance so it can never collide
   * with a per-file key in `resolveGate`. */
  private readonly bulkResolveGate = new KeyedBusyGate();

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
    /**
     * Feature 041: force-resolve one conflicted file with the chosen action (executed immediately).
     * When omitted, the conflict list stays click-to-open only (no per-file controls). The host is
     * responsible for surfacing any failure (Notice) and leaving the file conflicted; this modal just
     * re-renders afterwards to reflect the new state.
     */
    private readonly onForceResolve?: (path: string, choice: ForceChoice) => Promise<void>,
    /**
     * Feature 042: force-resolve every currently-listed conflict at once with a single chosen
     * action. Responsibility split (BRC): the HOST owns the "are you sure?" confirmation and the
     * single aggregate result Notice ("Resolved N of M conflicts..."); this MODAL only hands the
     * host the filtered target path set (the same array backing the list below), disables the
     * Apply button while the batch runs, and re-renders once the host's promise settles. When
     * omitted, no bulk row is rendered (capability gate — same click-to-open-only degradation as
     * `onForceResolve` omitted for per-file rows).
     */
    private readonly onBulkForceResolve?: (choice: ForceChoice, paths: string[]) => Promise<void>,
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

  /**
   * Conflicts section. Each row shows the (clickable) path plus — when `onForceResolve` is wired — a
   * force-resolution dropdown (remote / local / latest modified / biggest size) and an Apply button
   * that executes the choice immediately and re-renders (feature 041). Without `onForceResolve` it
   * degrades to a plain click-to-open list. When `onBulkForceResolve` is also wired, a single
   * "Apply to all N conflicts" row is rendered above the per-file list, targeting this same
   * (already-filtered) `files` array (feature 042).
   */
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

    // Feature 042 (BRC-12): bulk-resolve row, gated on onBulkForceResolve, sitting above the
    // per-file list. It targets exactly the filtered set passed to this method.
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
        // Guarded by an instance field (G6-1), not just `applyBtn.disabled` — a re-render mid-flight
        // (e.g. a filter toggle) recreates this button from scratch, so a DOM-only guard would not
        // survive it and a stale click could re-trigger the bulk resolution concurrently.
        if (!this.bulkResolveGate.tryEnter(BULK_RESOLVE_KEY)) return;
        applyBtn.disabled = true;
        void this.onBulkForceResolve!(select.value as ForceChoice, files).then(() => {
          this.bulkResolveGate.leave(BULK_RESOLVE_KEY);
          this.render();
        });
      });
    }

    const list = contentEl.createEl('div', { cls: 'ncs-status-list' });
    for (const path of files) {
      const row = list.createEl('div', { cls: 'ncs-status-row ncs-conflict-row' });
      const nameEl = row.createEl('span', { text: path, cls: 'ncs-conflict-path' });
      nameEl.addEventListener('click', () => {
        void this.app.workspace.openLinkText(path, '', false);
        this.close();
      });
      if (!this.onForceResolve) continue;

      // Per-file force resolution: a dropdown of the four actions + an Apply button. Executes now and
      // re-renders; a resolved file drops out of the list because its conflicted flag is cleared.
      const controls = row.createEl('div', { cls: 'ncs-conflict-controls' });
      const select = controls.createEl('select', { cls: 'dropdown ncs-conflict-select' });
      for (const c of FORCE_CHOICES) select.createEl('option', { text: c.label, value: c.id });
      const applyBtn = controls.createEl('button', { text: 'Apply', cls: 'ncs-conflict-apply' });
      applyBtn.addEventListener('click', () => {
        // Guarded by an instance field keyed on `path` (G6-1), not just `applyBtn.disabled` — a
        // re-render mid-flight (e.g. "Sync now" completing) recreates this button from scratch, so a
        // DOM-only guard would not survive it and a stale click could re-trigger this resolution
        // concurrently with the still-pending first call.
        if (!this.resolveGate.tryEnter(path)) return;
        applyBtn.disabled = true;
        // The host handles failures (Notice) and never rejects here; re-render reflects the new state
        // (a still-conflicted file stays listed, a resolved one disappears).
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
