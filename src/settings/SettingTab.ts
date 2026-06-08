import { App, PluginSettingTab, Setting, Notice, SecretComponent, ButtonComponent } from 'obsidian';
import type ObsidianNextcloudsync from '../main';
import { DavSyncSettings, LoginFlowError } from '../types';
import { LoginFlowV2 } from '../auth/LoginFlowV2';
import { MIN_NEXTCLOUD_VERSION, isSupportedNextcloudVersion } from '../util/version';

/** Default secret ID in SecretStorage (users can pick a different ID via "Link…"). */
const DEFAULT_PASSWORD_SECRET_ID = 'obsidian-nextcloudsync-password';
/** Key under which older versions stored the password in localStorage (for migration). */
const LEGACY_CREDENTIALS_KEY = 'obsidian-nextcloudsync-password';

export class NextcloudSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianNextcloudsync) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Nextcloud Sync Settings' });

    // Recommendation banner: shown when the last-connected server is below the recommended
    // Nextcloud version. This no longer blocks syncing — it only advises an upgrade.
    const serverVersion = this.plugin.settings.lastKnownServerVersion;
    if (serverVersion && !isSupportedNextcloudVersion(serverVersion)) {
      const warn = containerEl.createEl('div', {
        text: `⚠️ Connected Nextcloud server is ${serverVersion}. Nextcloud ${MIN_NEXTCLOUD_VERSION} (Hub 26 "Winter") or later is recommended; some features may be unavailable or degrade on older servers.`,
      });
      warn.style.cssText =
        'border-left: 3px solid var(--text-warning, #d08770); background: var(--background-secondary);'
        + ' padding: 8px 12px; margin: 8px 0 16px; border-radius: 4px;';
    }

    // Multi-Vault notice
    containerEl.createEl('p', {
      text: 'Settings are stored per-Vault. Each Vault can have a different Nextcloud server and user.',
      cls: 'setting-item-description',
    });

    // Holds the Login Flow button so the Server URL field can enable/disable it live.
    let loginButton: ButtonComponent | null = null;
    // Holds the sync-target display so the Server URL field can refresh it live.
    let targetSetting: Setting | null = null;

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Nextcloud WebDAV endpoint (e.g. https://cloud.example.com/remote.php/dav/files/alice/)')
      .addText(text => text
        .setPlaceholder('https://cloud.example.com/remote.php/dav/files/alice/')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.settings.serverUrl = value.trim();
          loginButton?.setDisabled(this.plugin.settings.serverUrl.length === 0);
          targetSetting?.setDesc(this.syncTargetUrl());
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
          // SecretComponent returns the secret's reference ID (the actual value stays in secretStorage).
          this.plugin.settings.passwordSecretId = secretId;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Log in via browser (Nextcloud)')
      .setDesc('Use Nextcloud Login Flow v2 to obtain an app password automatically. Requires the Server URL above. Falls back to manual entry on non-Nextcloud servers.')
      .addButton(btn => {
        loginButton = btn;
        btn
          .setButtonText('Log in via browser')
          .setDisabled(this.plugin.settings.serverUrl.trim().length === 0)
          .onClick(async () => {
            await this.runLoginFlow();
          });
      });

    new Setting(containerEl)
      .setName('Sync Folder')
      .setDesc('Fixed to this Vault\'s name. The entire Vault is synced under a remote folder named after the Vault.')
      .addText(text => text
        .setValue(this.app.vault.getName())
        .setDisabled(true));

    // Read-only display of the effective WebDAV sync target (Server URL + Sync Folder).
    targetSetting = new Setting(containerEl)
      .setName('Sync target (WebDAV)')
      .setDesc(this.syncTargetUrl());
    targetSetting.descEl.style.wordBreak = 'break-all';

    this.addNumberSlider(containerEl, {
      name: 'Sync Interval (minutes)', desc: '0 = manual sync only',
      min: 0, max: 60, step: 1,
      get: () => this.plugin.settings.syncIntervalMinutes,
      set: (v) => { this.plugin.settings.syncIntervalMinutes = v; },
    });

    this.addNumberSlider(containerEl, {
      name: 'Network Timeout (seconds)',
      min: 5, max: 120, step: 5,
      get: () => this.plugin.settings.networkTimeoutSeconds,
      set: (v) => { this.plugin.settings.networkTimeoutSeconds = v; },
    });

    new Setting(containerEl)
      .setName('Sync on file change')
      .setDesc('Immediately sync when a local Markdown file is modified (a short delay after you stop editing). Works alongside the periodic sync interval.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.watchOnChangeEnabled)
        .onChange(async (value) => {
          this.plugin.settings.watchOnChangeEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync bookmarks')
      .setDesc('The .obsidian config folder is excluded from sync. Enable this to also sync Obsidian bookmarks (.obsidian/bookmarks.json) across devices.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncBookmarks)
        .onChange(async (value) => {
          this.plugin.settings.syncBookmarks = value;
          await this.plugin.saveSettings();
        }));

    this.addNumberSlider(containerEl, {
      name: 'Chunk threshold (MB)',
      desc: 'Files larger than this are uploaded in chunks (Nextcloud only). Smaller files use a single request.',
      min: 1, max: 500, step: 1,
      get: () => this.plugin.settings.uploadChunkThresholdMB,
      set: (v) => { this.plugin.settings.uploadChunkThresholdMB = v; },
    });

    this.addNumberSlider(containerEl, {
      name: 'Maximum file size (MB)',
      desc: 'Absolute limit. Files larger than this are skipped with a warning.',
      min: 50, max: 4096, step: 50,
      get: () => this.plugin.settings.maxFileSizeMB,
      set: (v) => { this.plugin.settings.maxFileSizeMB = v; },
    });

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
      .setName('Debug mode')
      .setDesc('When enabled, "Sync Now" shows a dry-run plan (per-file local/remote paths and the action: upload, download, merge, etc.) instead of actually syncing.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.debugMode)
        .onChange(async (value) => {
          this.plugin.settings.debugMode = value;
          await this.plugin.saveSettings();
        }));

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
      .setName('Frontmatter Conflict Strategy (Auto Merge)')
      .setDesc('When local and remote frontmatter differ: "Conflict markers" inserts markers for the whole file (safest). "Local wins" / "Remote wins" keeps that side\'s frontmatter and still merges the body.')
      .addDropdown(drop => drop
        .addOption('conflict', 'Conflict markers (safe default)')
        .addOption('local-wins', 'Local wins (keep local frontmatter)')
        .addOption('remote-wins', 'Remote wins (use remote frontmatter)')
        .setValue(this.plugin.settings.frontmatterConflictStrategy)
        .onChange(async (value) => {
          this.plugin.settings.frontmatterConflictStrategy = value as 'conflict' | 'local-wins' | 'remote-wins';
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
          await this.plugin.runSyncNow();
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
   * Compute the effective WebDAV sync target URL (Server URL + this Vault's folder).
   * Shown read-only so the user can confirm where the Vault will be synced.
   */
  private syncTargetUrl(): string {
    const base = this.plugin.settings.serverUrl.trim().replace(/\/+$/, '');
    if (!base) return '(enter the Server URL above)';
    return `${base}/${this.app.vault.getName()}`;
  }

  /**
   * Add a numeric slider setting. It includes a numeric popup while dragging (dynamic tooltip)
   * and a label that always shows the current value.
   */
  private addNumberSlider(
    containerEl: HTMLElement,
    opts: {
      name: string;
      desc?: string;
      min: number;
      max: number;
      step: number;
      get: () => number;
      set: (value: number) => void;
    },
  ): void {
    const setting = new Setting(containerEl).setName(opts.name);
    if (opts.desc) setting.setDesc(opts.desc);

    // Current-value label (always shown to the left of the slider).
    const valueLabel = setting.controlEl.createSpan({ cls: 'setting-item-description' });
    valueLabel.style.marginRight = '8px';
    valueLabel.setText(String(opts.get()));

    setting.addSlider(slider => slider
      .setLimits(opts.min, opts.max, opts.step)
      .setValue(opts.get())
      .setDynamicTooltip()
      .onChange(async (value) => {
        opts.set(value);
        valueLabel.setText(String(value));
        await this.plugin.saveSettings();
      }));
  }

  /**
   * Run Login Flow v2 and, on success, set the username and app password.
   * The password is stored in SecretStorage and never saved in plaintext in data.json (FR-002).
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
        this.display(); // Re-render the settings panel
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
 * Retrieve the app password from SecretStorage.
 * If secretId is unset or the secret does not exist, fall back to the legacy localStorage value
 * (to avoid breaking migration from older versions).
 */
export function loadAppPassword(app: App, secretId: string): string | null {
  const id = secretId || DEFAULT_PASSWORD_SECRET_ID;
  const secret = app.secretStorage.getSecret(id);
  if (secret) return secret;
  // Migration fallback: use the legacy localStorage value if it remains.
  return app.loadLocalStorage(LEGACY_CREDENTIALS_KEY);
}

/**
 * Save the app password to SecretStorage (encrypted; never stored in data.json).
 * Used to store the password obtained via Login Flow v2.
 */
export function saveAppPassword(app: App, secretId: string, value: string): void {
  const id = secretId || DEFAULT_PASSWORD_SECRET_ID;
  app.secretStorage.setSecret(id, value);
}
