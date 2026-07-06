import { App, Modal, Notice, Setting } from 'obsidian';
import { FileVersion } from '../types';
import { confirmModal } from './ConfirmModal';

/**
 * Tracks whether a restore is currently in flight, as an instance field (not a DOM attribute), so it
 * survives independently of any one Restore button. Without this, clicking Restore on version A and
 * then, while it's still pending, clicking Restore on version B would run two `onRestore` calls
 * concurrently against the same file with an undefined final result (last-write-wins). Mirrors
 * CompareModal's instance-field `busy` pattern (see `runStrategy`). (G6-2)
 */
export class BusyGate {
  private busy = false;

  /** Marks busy and returns true, unless already busy (then a no-op false). */
  tryEnter(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  leave(): void {
    this.busy = false;
  }
}

/**
 * Modal that lists the server-side versions of the active note and restores the selected one (US2).
 * The actual restore work is delegated to the onRestore callback (SRP).
 */
export class VersionHistoryModal extends Modal {
  /** Modal-level in-flight guard (G6-2): only one restore (across all version rows) runs at a time. */
  private readonly restoreGate = new BusyGate();

  constructor(
    app: App,
    private readonly filePath: string,
    private readonly versions: FileVersion[],
    private readonly onRestore: (version: FileVersion) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle('Version history');
    contentEl.createEl('p', { text: this.filePath, cls: 'setting-item-description' });

    if (this.versions.length === 0) {
      contentEl.createEl('p', { text: 'No server version history for this file.' });
      return;
    }

    for (const version of this.versions) {
      const date = new Date(version.lastModified).toLocaleString();
      const sizeKb = (version.size / 1024).toFixed(1);
      new Setting(contentEl)
        .setName(date)
        .setDesc(`${sizeKb} KB`)
        .addButton(btn => btn
          .setButtonText('Restore')
          .setClass('mod-warning')
          .onClick(async () => {
            // Guarded by a modal-level instance field (G6-2): while one restore is in flight
            // (including its confirmation dialog), a click on any other version's Restore button
            // (this one or another row) is ignored until the first settles.
            if (!this.restoreGate.tryEnter()) return;
            try {
              const confirmed = await confirmModal(this.app, {
                title: 'Restore version',
                message:
                  `Restore "${this.filePath}" to the version from ${date}? ` +
                  'Unsaved local changes to this file will be overwritten.',
                cta: 'Restore',
                destructive: true,
              });
              if (!confirmed) return;
              await this.onRestore(version);
              new Notice(`✅ Restored ${this.filePath} (${date})`, 5000);
              this.close();
            } catch (err) {
              new Notice(`❌ Restore failed: ${(err as Error).message}`, 6000);
            } finally {
              this.restoreGate.leave();
            }
          }));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
