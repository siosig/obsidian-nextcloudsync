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
  constructor(
    app: App,
    private readonly vaultName: string,
    private readonly entries: SyncPlanEntry[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Sync preview (debug mode)' });

    // Summary counts per action.
    const counts = new Map<SyncAction, number>();
    for (const e of this.entries) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
    const summary = Array.from(counts.entries())
      .map(([action, n]) => `${ACTION_LABEL[action]}: ${n}`)
      .join('   ');
    contentEl.createEl('p', {
      text: this.entries.length === 0 ? 'No files to compare.' : `${this.entries.length} file(s)   ${summary}`,
      cls: 'setting-item-description',
    });
    contentEl.createEl('p', {
      text: 'Nothing was synced. Turn off Debug mode to run a real sync.',
      cls: 'setting-item-description',
    });

    // One line per file: action mark + local path + remote path.
    const pre = contentEl.createEl('pre');
    pre.style.maxHeight = '50vh';
    pre.style.overflow = 'auto';
    pre.style.whiteSpace = 'pre';
    pre.style.fontSize = '12px';

    const lines = this.entries.map((e) => {
      const local = e.localExists ? e.path : '—';
      const remote = e.remoteExists ? `${this.vaultName}/${e.path}` : '—';
      return `${ACTION_LABEL[e.action].padEnd(18)}  L: ${local}\n${''.padEnd(20)}  R: ${remote}`;
    });
    pre.setText(lines.join('\n'));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
