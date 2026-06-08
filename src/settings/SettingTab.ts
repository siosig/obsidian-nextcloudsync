import { App, PluginSettingTab, Setting, Notice, SecretComponent } from 'obsidian';
import type ObsidianNextcloudsync from '../main';
import { DavSyncSettings, LoginFlowError } from '../types';
import { LoginFlowV2 } from '../auth/LoginFlowV2';

/** SecretStorage 上の既定シークレット ID（ユーザーが「リンク…」で別 ID を選ぶことも可能）。 */
const DEFAULT_PASSWORD_SECRET_ID = 'obsidian-nextcloudsync-password';
/** 旧バージョンが localStorage に保存していたパスワードのキー（移行用）。 */
const LEGACY_CREDENTIALS_KEY = 'obsidian-nextcloudsync-password';

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
      .setDesc('Nextcloud app password. Click "Link…" to store it in Obsidian\'s encrypted Secret Storage (never saved in data.json). Generate at Settings → Security → Devices & Sessions.')
      .addComponent((el) => new SecretComponent(this.app, el)
        .setValue(this.plugin.settings.passwordSecretId || DEFAULT_PASSWORD_SECRET_ID)
        .onChange(async (secretId) => {
          // SecretComponent が返すのはシークレットの参照 ID（実値は secretStorage 側）。
          this.plugin.settings.passwordSecretId = secretId;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Log in via browser (Nextcloud)')
      .setDesc('Use Nextcloud Login Flow v2 to obtain an app password automatically. Requires the Server URL above. Falls back to manual entry on non-Nextcloud servers.')
      .addButton(btn => btn
        .setButtonText('Log in via browser')
        .onClick(async () => {
          await this.runLoginFlow();
        }));

    new Setting(containerEl)
      .setName('Sync Folder')
      .setDesc('Fixed to this Vault\'s name. The entire Vault is synced under a remote folder named after the Vault.')
      .addText(text => text
        .setValue(this.app.vault.getName())
        .setDisabled(true));

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
      .setName('Chunk threshold (MB)')
      .setDesc('Files larger than this are uploaded in chunks (Nextcloud only). Smaller files use a single request.')
      .addSlider(slider => slider
        .setLimits(1, 500, 1)
        .setValue(this.plugin.settings.uploadChunkThresholdMB)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.uploadChunkThresholdMB = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Maximum file size (MB)')
      .setDesc('Absolute limit. Files larger than this are skipped with a warning.')
      .addSlider(slider => slider
        .setLimits(50, 4096, 50)
        .setValue(this.plugin.settings.maxFileSizeMB)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxFileSizeMB = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Chunked upload')
      .setDesc('Upload large files in chunks instead of skipping them (Nextcloud only).')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.chunkedUploadEnabled)
        .onChange(async (value) => {
          this.plugin.settings.chunkedUploadEnabled = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Experimental Features' });

    new Setting(containerEl)
      .setName('File Locking (Experimental)')
      .setDesc('⚠️ When enabled, files are locked on the server during updates to prevent concurrent-edit conflicts. Requires the Nextcloud Files Locking app. Default off.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.fileLockingEnabled)
        .onChange(async (value) => {
          this.plugin.settings.fileLockingEnabled = value;
          await this.plugin.saveSettings();
        }));

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

  /**
   * Login Flow v2 を実行し、成功時にユーザー名とアプリパスワードを設定する。
   * パスワードは SecretStorage に保存し data.json には平文保存しない（FR-002）。
   */
  private async runLoginFlow(): Promise<void> {
    const serverUrl = this.plugin.settings.serverUrl.trim();
    if (!serverUrl) {
      new Notice('Please enter the Server URL first.');
      return;
    }
    const serverBaseUrl = serverUrl.replace(/\/remote\.php.*$/, '').replace(/\/$/, '');

    try {
      const init = await LoginFlowV2.start(serverBaseUrl);
      window.open(init.loginUrl, '_blank');
      new Notice('Waiting for browser approval… (up to 3 minutes)', 8000);

      const result = await LoginFlowV2.poll(init);
      if (result.status === 'success') {
        this.plugin.settings.username = result.loginName;
        saveAppPassword(this.app, DEFAULT_PASSWORD_SECRET_ID, result.appPassword);
        this.plugin.settings.passwordSecretId = DEFAULT_PASSWORD_SECRET_ID;
        await this.plugin.saveSettings();
        await this.plugin.initSyncEngine();
        new Notice(`✅ Logged in as ${result.loginName}`, 6000);
        this.display(); // 設定欄を再描画
      } else if (result.status === 'timeout') {
        new Notice('⏱️ Login timed out. Please try again.', 6000);
      } else {
        new Notice('This server does not support Login Flow. Please enter an app password manually.', 8000);
      }
    } catch (err) {
      if (err instanceof LoginFlowError && err.reason === 'unsupported') {
        new Notice('This server does not support Login Flow. Please enter an app password manually.', 8000);
      } else {
        new Notice(`❌ Login failed: ${(err as Error).message}`, 6000);
      }
    }
  }
}

/**
 * SecretStorage からアプリパスワードを取得する。
 * secretId が未設定、または該当シークレットが無い場合は、旧 localStorage 保存値へフォールバックする
 * （旧バージョンからの移行を壊さないため）。
 */
export function loadAppPassword(app: App, secretId: string): string | null {
  const id = secretId || DEFAULT_PASSWORD_SECRET_ID;
  const secret = app.secretStorage.getSecret(id);
  if (secret) return secret;
  // 移行フォールバック: 旧 localStorage に残っていれば利用する。
  return app.loadLocalStorage(LEGACY_CREDENTIALS_KEY);
}

/**
 * アプリパスワードを SecretStorage に保存する（暗号化管理・data.json には保存しない）。
 * Login Flow v2 で取得したパスワードの保存に使用する。
 */
export function saveAppPassword(app: App, secretId: string, value: string): void {
  const id = secretId || DEFAULT_PASSWORD_SECRET_ID;
  app.secretStorage.setSecret(id, value);
}
