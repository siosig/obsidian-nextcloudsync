import { App, Modal, Notice, Setting } from 'obsidian';
import { FileVersion } from '../types';
import { confirmModal } from './ConfirmModal';

// Instance field, not a DOM attribute: restoring version A then B while A is pending would run two onRestore calls
// on the same file concurrently (last-write-wins).
export class BusyGate {
  private busy = false;

  tryEnter(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  leave(): void {
    this.busy = false;
  }
}

export class VersionHistoryModal extends Modal {
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
            // Guarded at modal level: while one restore (including its confirmation) is in flight, clicks on any Restore button are ignored.
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
