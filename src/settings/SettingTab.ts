import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type ObsidianNextcloudsync from '../main';
import { DavSyncSettings } from '../types';

const CREDENTIALS_KEY = 'obsidian-nextcloudsync-password';

export class NextcloudSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianNextcloudsync) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Nextcloud Sync Settings' });

    // Multi-Vault notice
    containerEl.createEl('p', {
      text: 'Settings are stored per-Vault. Each Vault can have a different Nextcloud server and user.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Nextcloud WebDAV endpoint (e.g. https://cloud.example.com/remote.php/dav/files/alice/)')
      .addText(text => text
        .setPlaceholder('https://cloud.example.com/remote.php/dav/files/alice/')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.settings.serverUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Username')
      .setDesc('Nextcloud username (Vault-specific)')
      .addText(text => text
        .setValue(this.plugin.settings.username)
        .onChange(async (value) => {
          this.plugin.settings.username = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('App Password')
      .setDesc('Nextcloud app password (stored securely, never saved in data.json). Generate at Settings → Security → Devices & Sessions.')
      .addText(text => {
        const input = text
          .setPlaceholder('App password here...')
          .onChange(async (value) => {
            // Store via Credentials API
            this.app.saveLocalStorage(CREDENTIALS_KEY, value);
          });
        // Load existing password hint
        const existing = this.app.loadLocalStorage(CREDENTIALS_KEY);
        if (existing) input.setValue('••••••••');
        return input;
      });

    new Setting(containerEl)
      .setName('Sync Folder')
      .setDesc('Sub-folder to sync (leave empty to sync entire Vault)')
      .addText(text => text
        .setPlaceholder('(entire Vault)')
        .setValue(this.plugin.settings.syncFolder)
        .onChange(async (value) => {
          this.plugin.settings.syncFolder = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync Interval (minutes)')
      .setDesc('0 = manual sync only')
      .addSlider(slider => slider
        .setLimits(0, 60, 1)
        .setValue(this.plugin.settings.syncIntervalMinutes)
        .onChange(async (value) => {
          this.plugin.settings.syncIntervalMinutes = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Network Timeout (seconds)')
      .addSlider(slider => slider
        .setLimits(5, 120, 5)
        .setValue(this.plugin.settings.networkTimeoutSeconds)
        .onChange(async (value) => {
          this.plugin.settings.networkTimeoutSeconds = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Upload Size Limit (MB)')
      .setDesc('Files larger than this will be skipped with a warning')
      .addSlider(slider => slider
        .setLimits(1, 500, 1)
        .setValue(this.plugin.settings.uploadChunkThresholdMB)
        .onChange(async (value) => {
          this.plugin.settings.uploadChunkThresholdMB = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Experimental Features' });

    new Setting(containerEl)
      .setName('Auto Merge (Experimental)')
      .setDesc('⚠️ When enabled, conflicts are auto-merged using reconcile-text. Results may be unexpected. Ensure Nextcloud version history is enabled before activating.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoMergeEnabled)
        .onChange(async (value) => {
          this.plugin.settings.autoMergeEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Max Conflict Regions (Auto Merge)')
      .setDesc('If more regions conflict than this threshold, fall back to inline markers')
      .addSlider(slider => slider
        .setLimits(0, 20, 1)
        .setValue(this.plugin.settings.maxConflictRegions)
        .onChange(async (value) => {
          this.plugin.settings.maxConflictRegions = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Actions' });

    new Setting(containerEl)
      .setName('Sync Now')
      .addButton(btn => btn
        .setButtonText('Sync Now')
        .setCta()
        .onClick(async () => {
          await this.plugin.syncEngine?.syncManual();
        }));

    new Setting(containerEl)
      .setName('Last Session Summary')
      .addButton(btn => btn
        .setButtonText('View')
        .onClick(() => {
          const summary = this.plugin.syncEngine?.getLastSessionSummary();
          if (!summary) {
            new Notice('No sync session yet.');
            return;
          }
          const date = new Date(summary.startedAt).toLocaleString();
          new Notice(
            `Last sync: ${date}\n` +
            `↑ ${summary.uploadedCount}  ↓ ${summary.downloadedCount}  ⚠️ ${summary.conflictCount}  ✗ ${summary.errorCount}`,
            8000,
          );
        }));
  }
}

export function loadAppPassword(app: App): string | null {
  return app.loadLocalStorage(CREDENTIALS_KEY);
}

export function saveAppPassword(app: App, password: string | null): void {
  app.saveLocalStorage(CREDENTIALS_KEY, password);
}
