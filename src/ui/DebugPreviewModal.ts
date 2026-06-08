import { App, Modal } from 'obsidian';
import { SyncAction, SyncPlanEntry } from '../types';

/** Display label and mark for each sync action. */
const ACTION_LABEL: Record<SyncAction, string> = {
  'upload': '⬆️ UPLOAD',
  'download': '⬇️ DOWNLOAD',
  'merge': '🔀 MERGE',
  'conflict': '⚠️ CONFLICT',
  'unchanged': '➖ UNCHANGED',
  'delete-local': '🗑️ DELETE(local)',
  'delete-remote': '🗑️ DELETE(remote)',
};

/**
 * Debug dry-run preview (US: debug mode). Lists every file with its local and remote
 * path and the action a sync would take — one file per line. Read-only; nothing is synced.
 */
export class DebugPreviewModal extends Modal {
  /** Active action filter; null shows every file. */
  private filter: SyncAction | null = null;

  constructor(
    app: App,
    private readonly vaultName: string,
    private readonly entries: SyncPlanEntry[],
    /** Invoked when the user clicks a file row (debug merge preview). */
    private readonly onSelect?: (entry: SyncPlanEntry) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('ncs-debug-modal');
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Sync preview (debug mode)' });

    // Counts per action (insertion order follows ACTION_LABEL for a stable chip order).
    const counts = new Map<SyncAction, number>();
    for (const e of this.entries) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);

    contentEl.createEl('p', {
      text: this.entries.length === 0 ? 'No files to compare.' : `${this.entries.length} file(s)`,
      cls: 'setting-item-description',
    });

    // Clickable filter chips: "All" plus one per present action. Clicking narrows the list;
    // clicking the active chip again clears the filter.
    const chips = contentEl.createDiv({ cls: 'ncs-debug-chips' });

    const makeChip = (label: string, value: SyncAction | null) => {
      const active = this.filter === value;
      const chip = chips.createEl('button', { text: label });
      if (active) chip.addClass('mod-cta');
      chip.addEventListener('click', () => {
        this.filter = active ? null : value; // toggle off when re-clicking the active chip
        this.render();
      });
    };
    makeChip(`All: ${this.entries.length}`, null);
    for (const [action, n] of counts) makeChip(`${ACTION_LABEL[action]}: ${n}`, action);

    const shown = this.filter ? this.entries.filter(e => e.action === this.filter) : this.entries;

    contentEl.createEl('p', {
      text: this.filter
        ? `Showing ${shown.length} ${ACTION_LABEL[this.filter]} file(s). Click a file to preview its merge.`
        : 'Nothing was synced. Click a file to preview its merge. Turn off Debug mode to run a real sync.',
      cls: 'setting-item-description',
    });

    // One clickable row per file: action mark + local path + remote path.
    const list = contentEl.createDiv({ cls: 'ncs-debug-list' });

    for (const e of shown) {
      const local = e.localExists ? e.path : '—';
      const remote = e.remoteExists ? `${this.vaultName}/${e.path}` : '—';

      const row = list.createDiv({ cls: 'ncs-debug-row' });
      row.setText(`${ACTION_LABEL[e.action].padEnd(18)}  L: ${local}\n${''.padEnd(20)}  R: ${remote}`);
      row.addEventListener('click', () => this.onSelect?.(e));
    }
  }
}
