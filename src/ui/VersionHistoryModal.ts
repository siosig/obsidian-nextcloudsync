import { App, Modal, Notice, Setting } from 'obsidian';
import { FileVersion } from '../types';

/**
 * アクティブノートのサーバーバージョン一覧を表示し、選択した版を復元する Modal（US2）。
 * 復元の実処理は onRestore コールバックに委譲する（SRP）。
 */
export class VersionHistoryModal extends Modal {
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
    contentEl.createEl('h2', { text: 'Version history' });
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
          .setWarning()
          .onClick(async () => {
            const confirmed = window.confirm(
              `Restore "${this.filePath}" to the version from ${date}? ` +
              'Unsaved local changes to this file will be overwritten.',
            );
            if (!confirmed) return;
            try {
              await this.onRestore(version);
              new Notice(`✅ Restored ${this.filePath} (${date})`, 5000);
              this.close();
            } catch (err) {
              new Notice(`❌ Restore failed: ${(err as Error).message}`, 6000);
            }
          }));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
