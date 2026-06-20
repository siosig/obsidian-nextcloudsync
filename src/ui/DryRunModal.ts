import { App, Modal } from 'obsidian';

export interface DryRunPlan {
  uploads: string[];
  downloads: string[];
  conflicts: string[];
  deletes: string[];
  /** Files present and identical on both sides (no transfer needed; state is seeded). */
  unchanged: string[];
}

interface DryRunModalOptions {
  /** One-line explanation of what conflict resolution will produce (derived from settings). */
  conflictNote?: string;
  /** Called when a conflicted file row is selected, to open a read-only merge preview. */
  onSelectConflict?: (path: string) => void;
}

export class DryRunModal extends Modal {
  private approved = false;
  private resolve!: (approved: boolean) => void;

  constructor(app: App, private readonly plan: DryRunPlan, private readonly options: DryRunModalOptions = {}) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, plan } = this;
    contentEl.empty();
    this.setTitle('Sync preview (dry run)');

    const stats = contentEl.createEl('p');
    const addStat = (icon: string, count: number, label: string) => {
      stats.appendText(`${icon} `);
      stats.createEl('strong', { text: String(count) });
      stats.appendText(` ${label}   `);
    };
    addStat('↑', plan.uploads.length, 'uploads');
    addStat('↓', plan.downloads.length, 'downloads');
    addStat('=', plan.unchanged.length, 'unchanged');
    addStat('⚠️', plan.conflicts.length, 'conflicts');
    addStat('🗑️', plan.deletes.length, 'deletes');

    if (plan.conflicts.length > 0) {
      contentEl.createEl('h3', { text: 'Conflicts' });
      if (this.options.conflictNote) {
        contentEl.createEl('p', { text: this.options.conflictNote, cls: 'ncs-dryrun-note' });
      }
      const onSelect = this.options.onSelectConflict;
      const ul = contentEl.createEl('ul');
      plan.conflicts.slice(0, 20).forEach(p => {
        const li = ul.createEl('li', { text: p });
        if (onSelect) {
          li.addClass('ncs-dryrun-conflict');
          li.setAttribute('title', 'Preview the merged result');
          li.addEventListener('click', () => onSelect(p));
        }
      });
      if (plan.conflicts.length > 20) ul.createEl('li', { text: `…and ${plan.conflicts.length - 20} more` });
    }

    const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => { this.close(); this.resolve(false); });

    const proceedBtn = btnRow.createEl('button', { text: 'Proceed', cls: 'mod-cta' });
    proceedBtn.addEventListener('click', () => { this.approved = true; this.close(); this.resolve(true); });
  }

  onClose(): void {
    if (this.resolve && !this.approved) this.resolve(false);
  }

  /** Opens modal and returns true if user approved. */
  waitForDecision(): Promise<boolean> {
    return new Promise(resolve => {
      this.resolve = resolve;
      this.open();
    });
  }
}
