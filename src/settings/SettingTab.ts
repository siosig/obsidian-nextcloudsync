import { App, Platform, PluginSettingTab, Setting, Notice, SecretComponent, ButtonComponent, TextComponent } from 'obsidian';
import type ObsidianNextcloudsync from '../main';
import { LoginFlowError } from '../types';
import { FolderSuggestModal } from '../ui/FolderSuggestModal';
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
      authWarningEl.createSpan({ text: '⚠️ ' });
      authWarningEl.createEl('strong', { text: 'Not signed in yet' });
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

    new Setting(containerEl).setName('Nextcloud').setHeading();

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

    new Setting(containerEl)
      .setName('File locking (experimental)')
      .setDesc('⚠️ when enabled, files are locked on the server during updates to prevent concurrent-edit conflicts. Requires the Nextcloud files locking app. Default off.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.fileLockingEnabled)
        .onChange(async (value) => {
          this.plugin.settings.fileLockingEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName('Sync').setHeading();

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
      // Apply immediately so a new interval (or enabling/disabling from 0) takes effect without
      // a plugin reload — previously the timer kept the value from load time.
      apply: () => this.plugin.applyAutoSyncInterval(),
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

    new Setting(containerEl).setName('Merge').setHeading();

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

    this.addNumberSlider(containerEl, {
      name: 'Max conflict regions (auto merge)',
      desc: 'If more regions conflict than this threshold, fall back to inline markers. 0 = unlimited (never fall back on region count).',
      min: 0, max: 20, step: 1,
      get: () => this.plugin.settings.maxConflictRegions,
      set: (v) => { this.plugin.settings.maxConflictRegions = v; },
    });

    new Setting(containerEl)
      .setName('Mergeable file extensions')
      .setDesc('Comma-separated list of extensions eligible for text merge (e.g. "md, txt"). Files with other extensions are never merged; on conflict the failure policy below is applied directly. Leave the dot off.')
      .addText(text => text
        .setPlaceholder('Extensions separated by commas')
        .setValue((this.plugin.settings.mergeableExtensions ?? []).join(', '))
        .onChange(async (value) => {
          // Normalize: split on comma, trim, strip leading dots, lowercase, drop empties, dedup.
          const exts = value
            .split(',')
            .map(e => e.trim().replace(/^\.+/, '').toLowerCase())
            .filter(e => e.length > 0);
          this.plugin.settings.mergeableExtensions = [...new Set(exts)];
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('On merge failure')
      .setDesc('What to do when a merge does not cleanly resolve (file not mergeable, auto-merge off, or merge failed). "error" leaves both sides untouched and retries next sync (safe default). "conflict markers" applies to text files only; other files fall back to error.')
      .addDropdown(drop => drop
        .addOption('error', 'Error — leave untouched, retry (safe default)')
        .addOption('local-wins', 'Local wins — overwrite remote with local')
        .addOption('remote-wins', 'Remote wins — overwrite local with remote')
        .addOption('conflict-markers', 'Conflict markers — keep both versions (text only)')
        .setValue(this.plugin.settings.conflictFailurePolicy)
        .onChange(async (value) => {
          this.plugin.settings.conflictFailurePolicy =
            value as 'error' | 'local-wins' | 'remote-wins' | 'conflict-markers';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName('Debug').setHeading();

    new Setting(containerEl)
      .setName('Device name')
      .setDesc('Names this device in log filenames (nextcloud-sync_sync_<device>.md). Leave blank to use a platform + id default. Filesystem-unsafe characters are replaced automatically.')
      .addText(text => text
        .setPlaceholder(this.plugin.defaultHostToken())
        .setValue(this.plugin.settings.deviceName)
        .onChange(async (value) => {
          this.plugin.settings.deviceName = value;
          await this.plugin.saveSettings();
        }));

    let logFolderText: TextComponent | null = null;
    new Setting(containerEl)
      .setName('Log folder')
      .setDesc('Vault folder where the sync log and debug log are written. Leave blank for the vault root.')
      .addText(text => {
        logFolderText = text;
        text
          .setPlaceholder('Vault root')
          .setValue(this.plugin.settings.logsFolder)
          .onChange(async (value) => {
            this.plugin.settings.logsFolder = value.replace(/\/+$/, '').trim();
            await this.plugin.saveSettings();
          });
      })
      // "Browse…" opens a fuzzy folder picker (Templater-style) that fills the field.
      .addButton(btn => btn
        .setButtonText('Browse…')
        .onClick(() => {
          new FolderSuggestModal(this.app, (path) => {
            this.plugin.settings.logsFolder = path;
            logFolderText?.setValue(path);
            void this.plugin.saveSettings();
          }).open();
        }));

    new Setting(containerEl)
      .setName('Sync log')
      .setDesc('Append a per-device log of sync operations (with the plugin version and conflict-resolution settings) to nextcloud-sync_sync_<device>.md.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncLogEnabled)
        .onChange(async (value) => {
          this.plugin.settings.syncLogEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync log level')
      .setDesc('Choose how much the sync log records. Important events only covers conflicts, merges, side-wins and errors; all operations also records routine uploads, downloads and deletions.')
      .addDropdown(drop => drop
        .addOption('important', 'Important events only (conflicts, merges, errors)')
        .addOption('all', 'All operations')
        .setValue(this.plugin.settings.syncLogLevel)
        .onChange(async (value) => {
          this.plugin.settings.syncLogLevel = value as 'important' | 'all';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Debug log')
      .setDesc('Append a per-device diagnostic log (with the plugin version and a snapshot of all settings) to nextcloud-sync_debug_<device>.md. Syncing runs normally. Turn this off and delete the file when finished.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.debugLogEnabled)
        .onChange(async (value) => {
          this.plugin.settings.debugLogEnabled = value;
          await this.plugin.saveSettings();
          // Dump a fresh settings snapshot as soon as the debug log is turned on.
          if (value) void this.plugin.logSettingsSnapshot();
        }));

    new Setting(containerEl)
      .setName('Debug log level')
      .setDesc('Verbosity of the debug log: "error" records only failures; "debug" adds normal flow; "verbose" adds the most detail.')
      .addDropdown(drop => drop
        .addOption('error', 'Error (failures only)')
        .addOption('debug', 'Debug (normal flow)')
        .addOption('verbose', 'Verbose (most detail)')
        .setValue(this.plugin.settings.debugLogLevel)
        .onChange(async (value) => {
          this.plugin.settings.debugLogLevel = value as 'error' | 'debug' | 'verbose';
          await this.plugin.saveSettings();
        }));

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
            `↑ ${summary.uploadedCount}  ↓ ${summary.downloadedCount}  ⟷ ${summary.mergedCount}  ⚠️ ${summary.conflictedCount}  ✗ ${summary.errorCount}`,
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
      /** Optional side-effect run after the value is persisted (e.g. re-apply a live timer). */
      apply?: () => void | Promise<void>;
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
      .setDisabled(opts.disabled ?? false)
      .onChange(async (value) => {
        opts.set(value);
        valueLabel.setText(String(value));
        await this.plugin.saveSettings();
        await opts.apply?.();
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
      void this.plugin.logger.log(`login: ERROR — ${(err as Error).message}`, 'error');
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
