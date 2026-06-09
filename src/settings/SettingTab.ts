import { App, Platform, PluginSettingTab, Setting, Notice, SecretComponent, ButtonComponent } from 'obsidian';
import type ObsidianNextcloudsync from '../main';
import { LoginFlowError } from '../types';
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
    this.render();
  }

  /**
   * Build the settings UI. Kept separate from display() so the panel can be re-rendered
   * (e.g. after Login Flow) without calling the deprecated PluginSettingTab.display().
   */
  private render(): void {
    const { containerEl } = this;
    const configDir = this.app.vault.configDir;
    containerEl.empty();

    // Prominent "not signed in" banner, pinned to the very top. Populated/cleared by
    // refreshAuthWarning() below and kept in sync live as the credential fields change.
    const authWarningEl = containerEl.createDiv();

    // Recommendation banner: shown when the last-connected server is below the recommended
    // Nextcloud version. This no longer blocks syncing — it only advises an upgrade.
    const serverVersion = this.plugin.settings.lastKnownServerVersion;
    if (serverVersion && !isSupportedNextcloudVersion(serverVersion)) {
      containerEl.createEl('div', {
        text: `⚠️ Connected Nextcloud server is ${serverVersion}. Nextcloud ${MIN_NEXTCLOUD_VERSION} (Hub 26 "Winter") or later is recommended; some features may be unavailable or degrade on older servers.`,
        cls: 'ncs-setting-warning',
      });
    }

    // Multi-Vault notice
    containerEl.createEl('p', {
      text: 'Settings are stored per-vault. Each vault can have a different Nextcloud server and user.',
      cls: 'setting-item-description',
    });

    // Holds the Login Flow button so the Server URL field can enable/disable it live.
    let loginButton: ButtonComponent | null = null;
    // Holds the sync-target display so the Server URL field can refresh it live.
    let targetSetting: Setting | null = null;

    // "Sync now" lives at the top. It stays disabled until authentication is complete
    // (server URL + username + a stored app password), and updates live as fields change.
    let syncNowButton: ButtonComponent | null = null;
    const isReadyToSync = (): boolean => {
      const s = this.plugin.settings;
      // Require a non-empty password string. (loadLocalStorage can return '' for a missing
      // key, and '' != null is true — so a bare null check would wrongly report "ready".)
      const pw = loadAppPassword(this.app, s.passwordSecretId);
      return s.serverUrl.trim().length > 0
        && s.username.trim().length > 0
        && typeof pw === 'string' && pw.length > 0;
    };
    const refreshSyncNow = (): void => { syncNowButton?.setDisabled(!isReadyToSync()); };
    const refreshAuthWarning = (): void => {
      authWarningEl.empty();
      if (isReadyToSync()) { authWarningEl.removeClass('ncs-auth-warning'); return; }
      authWarningEl.addClass('ncs-auth-warning');
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- emphasis heading after the ⚠️ emoji; the rule mis-parses the emoji prefix
      authWarningEl.createEl('strong', { text: '⚠️ Not signed in yet' });
      authWarningEl.createEl('div', {
        text: 'Enter the server URL below, then log in (or fill in a username and app password). Syncing stays disabled until you do.',
      });
    };
    refreshAuthWarning();

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc('Sync this vault with Nextcloud. Available once the server URL, username and app password are set.')
      .addButton(btn => {
        syncNowButton = btn;
        btn.setButtonText('Sync now')
          .setCta()
          .setDisabled(!isReadyToSync())
          .onClick(async () => { await this.plugin.runSyncNow(); });
      });

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
          refreshSyncNow();
          refreshAuthWarning();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Username')
      .setDesc('Nextcloud username (vault-specific)')
      .addText(text => text
        .setValue(this.plugin.settings.username)
        .onChange(async (value) => {
          this.plugin.settings.username = value.trim();
          refreshSyncNow();
          refreshAuthWarning();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('App password')
      .setDesc('Nextcloud app password. Click "Link…" to store it in Obsidian\'s encrypted Secret Storage (never saved in data.json). Generate at Settings → Security → Devices & Sessions.')
      .addComponent((el) => new SecretComponent(this.app, el)
        .setValue(this.plugin.settings.passwordSecretId || DEFAULT_PASSWORD_SECRET_ID)
        .onChange(async (secretId) => {
          // SecretComponent returns the secret's reference ID (the actual value stays in secretStorage).
          this.plugin.settings.passwordSecretId = secretId;
          refreshSyncNow();
          refreshAuthWarning();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Log in via browser (Nextcloud)')
      .setDesc('Use Nextcloud login flow v2 to obtain an app password automatically. Requires the server URL above. Falls back to manual entry on non-nextcloud servers.')
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
      .setName('Sync folder')
      .setDesc('Fixed to this vault\'s name. The entire vault is synced under a remote folder named after the vault.')
      .addText(text => text
        .setValue(this.app.vault.getName())
        .setDisabled(true));

    // Read-only display of the effective WebDAV sync target (Server URL + Sync Folder).
    targetSetting = new Setting(containerEl)
      .setName('Sync target (WebDAV)')
      .setDesc(this.syncTargetUrl());
    targetSetting.descEl.addClass('ncs-break-all');

    // Startup sync (both platforms). Default ON desktop / OFF mobile (resolved at first run).
    new Setting(containerEl)
      .setName('Sync on startup')
      .setDesc('Run one sync shortly after Obsidian starts. On mobile this is off by default.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncOnStartupEnabled)
        .onChange(async (value) => {
          this.plugin.settings.syncOnStartupEnabled = value;
          await this.plugin.saveSettings();
        }));

    this.addNumberSlider(containerEl, {
      name: 'Startup sync delay (seconds)',
      desc: 'Wait this many seconds after startup before the startup sync.',
      min: 0, max: 60, step: 1,
      get: () => this.plugin.settings.startupSyncDelaySeconds,
      set: (v) => { this.plugin.settings.startupSyncDelaySeconds = v; },
    });

    // Periodic auto-sync is disabled on mobile (OS suspends background timers).
    this.addNumberSlider(containerEl, {
      name: 'Sync interval (minutes)',
      desc: Platform.isMobile
        ? 'Disabled on mobile (the OS suspends background timers). Use "Sync on startup" or "Sync now".'
        : '0 = manual sync only',
      min: 0, max: 60, step: 1,
      disabled: Platform.isMobile,
      get: () => this.plugin.settings.syncIntervalMinutes,
      set: (v) => { this.plugin.settings.syncIntervalMinutes = v; },
    });

    this.addNumberSlider(containerEl, {
      name: 'Network timeout (seconds)',
      min: 5, max: 120, step: 5,
      get: () => this.plugin.settings.networkTimeoutSeconds,
      set: (v) => { this.plugin.settings.networkTimeoutSeconds = v; },
    });

    this.addNumberSlider(containerEl, {
      name: 'Network concurrency',
      desc: 'Number of simultaneous WebDAV requests. Higher is faster but uses more memory/connections. Mobile defaults to a lower value.',
      min: 1, max: 16, step: 1,
      get: () => this.plugin.settings.networkConcurrency,
      set: (v) => { this.plugin.settings.networkConcurrency = v; },
    });

    // Wi-Fi only. Network type is undetectable on iOS (no navigator.connection), so disable there.
    new Setting(containerEl)
      .setName('Sync on Wi-Fi only')
      .setDesc(Platform.isIosApp
        ? 'Not available on iOS (no network-type API). The app cannot tell Wi-Fi from cellular here.'
        : 'Skip syncing while on a cellular connection (Wi-Fi and wired are allowed).')
      .then(s => { if (Platform.isIosApp) s.setDisabled(true); })
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncOnWifiOnly && !Platform.isIosApp)
        .setDisabled(Platform.isIosApp)
        .onChange(async (value) => {
          this.plugin.settings.syncOnWifiOnly = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync on file change')
      .setDesc(Platform.isMobile
        ? 'Disabled on mobile (the OS suspends background work). Use "Sync on startup" or "Sync now".'
        : 'Immediately sync when a local Markdown file is modified (a short delay after you stop editing). Works alongside the periodic sync interval.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.watchOnChangeEnabled && !Platform.isMobile)
        .setDisabled(Platform.isMobile)
        .onChange(async (value) => {
          this.plugin.settings.watchOnChangeEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync bookmarks')
      .setDesc(`The ${configDir} config folder is excluded from sync. Enable this to also sync Obsidian bookmarks (${configDir}/bookmarks.json) across devices.`)
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
      desc: 'Files larger than this are skipped with a warning. 0 = unlimited. On mobile a low limit avoids out-of-memory crashes.',
      min: 0, max: 4096, step: 10,
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

    new Setting(containerEl).setName('Experimental features').setHeading();

    new Setting(containerEl)
      .setName('Debug mode')
      .setDesc(Platform.isMobile
        ? 'Not available on mobile.'
        : 'When enabled, "sync now" shows a dry-run plan (per-file local/remote paths and the action: upload, download, merge, etc.) instead of actually syncing. Does not affect logging.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.debugMode && !Platform.isMobile)
        .setDisabled(Platform.isMobile)
        .onChange(async (value) => {
          this.plugin.settings.debugMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Diagnostic logging')
      .setDesc('Append a timestamped action log (with the plugin version) to nextcloud-sync-debug.md at the vault root. Works on desktop and mobile and does NOT change syncing. The log file is synced like any other note, so each device\'s actions are collected together (it may itself show as a conflict when two devices append at once). Turn this off and delete the file when finished.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.diagnosticLogEnabled)
        .onChange(async (value) => {
          this.plugin.settings.diagnosticLogEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('File locking (experimental)')
      .setDesc('⚠️ when enabled, files are locked on the server during updates to prevent concurrent-edit conflicts. Requires the Nextcloud files locking app. Default off.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.fileLockingEnabled)
        .onChange(async (value) => {
          this.plugin.settings.fileLockingEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Auto merge (experimental)')
      .setDesc('⚠️ when enabled, conflicts are auto-merged using reconcile-text. Results may be unexpected. Ensure Nextcloud version history is enabled before activating.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoMergeEnabled)
        .onChange(async (value) => {
          this.plugin.settings.autoMergeEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Frontmatter conflict strategy (auto merge)')
      .setDesc('When local and remote frontmatter differ: "Conflict markers" inserts markers for the whole file (safest). "local wins" / "remote wins" keeps that side\'s frontmatter and still merges the body.')
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
      .setName('Max conflict regions (auto merge)')
      .setDesc('If more regions conflict than this threshold, fall back to inline markers')
      .addSlider(slider => slider
        .setLimits(0, 20, 1)
        .setValue(this.plugin.settings.maxConflictRegions)
        .onChange(async (value) => {
          this.plugin.settings.maxConflictRegions = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName('Actions').setHeading();

    new Setting(containerEl)
      .setName('Last session summary')
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
      disabled?: boolean;
      get: () => number;
      set: (value: number) => void;
    },
  ): void {
    const setting = new Setting(containerEl).setName(opts.name);
    if (opts.desc) setting.setDesc(opts.desc);

    // Current-value label (always shown to the left of the slider).
    const valueLabel = setting.controlEl.createSpan({ cls: 'setting-item-description ncs-slider-value' });
    valueLabel.setText(String(opts.get()));

    setting.addSlider(slider => slider
      .setLimits(opts.min, opts.max, opts.step)
      .setValue(opts.get())
      .setDynamicTooltip()
      .setDisabled(opts.disabled ?? false)
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
    void this.plugin.logger.log('login: "Log in via browser" clicked');
    const serverUrl = this.plugin.settings.serverUrl.trim();
    if (!serverUrl) {
      void this.plugin.logger.log('login: aborted — server URL empty');
      new Notice('Please enter the server URL first.');
      return;
    }
    const serverBaseUrl = serverUrl.replace(/\/remote\.php.*$/, '').replace(/\/$/, '');

    try {
      void this.plugin.logger.log('login: start() POST →');
      const init = await LoginFlowV2.start(serverBaseUrl);
      void this.plugin.logger.log('login: start() ok (loginUrl received)');
      const opened = window.open(init.loginUrl, '_blank');
      void this.plugin.logger.log(`login: window.open → ${opened ? 'opened' : 'BLOCKED (returned null)'}`);
      new Notice('Waiting for browser approval… (up to 3 minutes)', 8000);

      void this.plugin.logger.log('login: polling started');
      const result = await LoginFlowV2.poll(init);
      void this.plugin.logger.log(`login: poll finished — status=${result.status}`);
      if (result.status === 'success') {
        this.plugin.settings.username = result.loginName;
        saveAppPassword(this.app, DEFAULT_PASSWORD_SECRET_ID, result.appPassword);
        this.plugin.settings.passwordSecretId = DEFAULT_PASSWORD_SECRET_ID;
        await this.plugin.saveSettings();
        await this.plugin.initSyncEngine();
        new Notice(`✅ Logged in as ${result.loginName}`, 6000);
        this.render(); // Re-render the settings panel
      } else if (result.status === 'timeout') {
        new Notice('⏱️ login timed out. Please try again.', 6000);
      } else {
        new Notice('This server does not support login flow. Please enter an app password manually.', 8000);
      }
    } catch (err) {
      void this.plugin.logger.log(`login: ERROR — ${(err as Error).message}`);
      if (err instanceof LoginFlowError && err.reason === 'unsupported') {
        new Notice('This server does not support login flow. Please enter an app password manually.', 8000);
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
  return app.loadLocalStorage(LEGACY_CREDENTIALS_KEY) as string | null;
}

/**
 * Save the app password to SecretStorage (encrypted; never stored in data.json).
 * Used to store the password obtained via Login Flow v2.
 */
export function saveAppPassword(app: App, secretId: string, value: string): void {
  const id = secretId || DEFAULT_PASSWORD_SECRET_ID;
  app.secretStorage.setSecret(id, value);
}
