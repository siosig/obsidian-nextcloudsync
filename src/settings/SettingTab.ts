import { App, Platform, PluginSettingTab, Setting, Notice, SecretComponent, ButtonComponent, TextComponent } from 'obsidian';
import type ObsidianNextcloudsync from '../main';
import { LoginFlowError, DavSyncSettings } from '../types';
import { parseMergeableExtensions, formatMergeableExtensions } from '../util/mergeableExtensions';
import { FolderInputSuggest } from '../ui/FolderInputSuggest';
import { LoginFlowV2 } from '../auth/LoginFlowV2';
import { MIN_NEXTCLOUD_VERSION, isSupportedNextcloudVersion } from '../util/version';
import { CONFIG_SYNC_CATEGORIES } from '../sync/ConfigSyncResolver';
import { TOOLTIPS, SERVER_URL_DESC, SIGN_IN_HELP, SIGN_IN_MANUAL_DIVIDER, CONFIG_CATEGORY_TOOLTIP } from './tooltips';
import { makeSetting } from './settingFactory';
import { normalizeExcludedFolder } from '../util/excludedFolders';

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

    makeSetting(containerEl)
      .setName('Sync now')
      .setDesc('Sync this vault with Nextcloud. Available once the server URL, username and app password are set.')
      .setTooltip(TOOLTIPS.syncNow)
      .addButton(btn => {
        syncNowButton = btn;
        btn.setButtonText('Sync now')
          .setCta()
          .setDisabled(!isReadyToSync())
          .onClick(async () => { await this.plugin.runSyncNow(); });
      });

    new Setting(containerEl).setName('Nextcloud').setHeading();

    makeSetting(containerEl)
      .setName('Server URL')
      .setDesc(SERVER_URL_DESC)
      .setTooltip(TOOLTIPS.serverUrl)
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

    // Sign-in guidance: explain there is no separate "login" action and that the two
    // sign-in paths (browser vs manual) are alternatives. Shown on all platforms.
    containerEl.createEl('p', { text: SIGN_IN_HELP, cls: 'setting-item-description' });

    // Recommended path first (CTA), then a divider, then the manual fields.
    makeSetting(containerEl)
      .setName('Log in via browser (Nextcloud) — recommended')
      .setDesc('Use Nextcloud login flow v2 to obtain an app password automatically. Requires the server URL above. Falls back to manual entry on non-nextcloud servers.')
      .setTooltip(TOOLTIPS.loginViaBrowser)
      .addButton(btn => {
        loginButton = btn;
        btn
          .setButtonText('Log in via browser')
          .setCta()
          .setDisabled(this.plugin.settings.serverUrl.trim().length === 0)
          .onClick(async () => {
            await this.runLoginFlow();
          });
      });

    containerEl.createEl('p', { text: SIGN_IN_MANUAL_DIVIDER, cls: 'setting-item-description ncs-signin-divider' });

    makeSetting(containerEl)
      .setName('Username')
      .setDesc('Nextcloud username (vault-specific). Only needed for manual sign-in.')
      .setTooltip(TOOLTIPS.username)
      .addText(text => text
        .setValue(this.plugin.settings.username)
        .onChange(async (value) => {
          this.plugin.settings.username = value.trim();
          refreshSyncNow();
          refreshAuthWarning();
          await this.plugin.saveSettings();
        }));

    makeSetting(containerEl)
      .setName('App password')
      .setDesc('Nextcloud app password (only for manual sign-in). Click "Link…" to store it in Obsidian\'s encrypted Secret Storage (never saved in data.json). Generate at Settings → Security → Devices & Sessions.')
      .setTooltip(TOOLTIPS.appPassword)
      .addComponent((el) => new SecretComponent(this.app, el)
        .setValue(this.plugin.settings.passwordSecretId || DEFAULT_PASSWORD_SECRET_ID)
        .onChange(async (secretId) => {
          // SecretComponent returns the secret's reference ID (the actual value stays in secretStorage).
          this.plugin.settings.passwordSecretId = secretId;
          refreshSyncNow();
          refreshAuthWarning();
          await this.plugin.saveSettings();
        }));

    makeSetting(containerEl)
      .setName('Sync folder')
      .setDesc('Fixed to this vault\'s name. The entire vault is synced under a remote folder named after the vault.')
      .setTooltip(TOOLTIPS.syncFolder)
      .addText(text => text
        .setValue(this.app.vault.getName())
        .setDisabled(true));

    // Read-only display of the effective WebDAV sync target (Server URL + Sync Folder).
    targetSetting = makeSetting(containerEl)
      .setName('Sync target (WebDAV)')
      .setDesc(this.syncTargetUrl())
      .setTooltip(TOOLTIPS.syncTarget);
    targetSetting.descEl.addClass('ncs-break-all');

    // Feature 033: the "File locking (experimental)" toggle was removed. Locking is always off —
    // If-Match optimistic concurrency provides lost-update safety without the LOCK/UNLOCK overhead.

    new Setting(containerEl).setName('Sync').setHeading();

    // Startup sync (both platforms). Default ON desktop / OFF mobile (resolved at first run).
    makeSetting(containerEl)
      .setName('Sync on startup')
      .setDesc('Run one sync shortly after Obsidian starts. On mobile this is off by default.')
      .setTooltip(TOOLTIPS.syncOnStartup)
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncOnStartupEnabled)
        .onChange(async (value) => {
          this.plugin.settings.syncOnStartupEnabled = value;
          await this.plugin.saveSettings();
        }));

    this.addNumberSlider(containerEl, {
      name: 'Startup sync delay (seconds)',
      desc: 'Wait this many seconds after startup before the startup sync.',
      tooltip: TOOLTIPS.startupSyncDelay,
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
      tooltip: TOOLTIPS.syncInterval,
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
      tooltip: TOOLTIPS.networkTimeout,
      min: 5, max: 120, step: 5,
      get: () => this.plugin.settings.networkTimeoutSeconds,
      set: (v) => { this.plugin.settings.networkTimeoutSeconds = v; },
    });

    this.addNumberSlider(containerEl, {
      name: 'Network concurrency',
      desc: 'Number of simultaneous WebDAV requests. Higher is faster but uses more memory/connections. Mobile defaults to a lower value.',
      tooltip: TOOLTIPS.networkConcurrency,
      min: 1, max: 16, step: 1,
      get: () => this.plugin.settings.networkConcurrency,
      set: (v) => { this.plugin.settings.networkConcurrency = v; },
    });

    // Wi-Fi only. Network type is undetectable on iOS (no navigator.connection), so disable there.
    makeSetting(containerEl)
      .setName('Sync on Wi-Fi only')
      .setDesc(Platform.isIosApp
        ? 'Not available on iOS (no network-type API). The app cannot tell Wi-Fi from cellular here.'
        : 'Skip syncing while on a cellular connection (Wi-Fi and wired are allowed).')
      .setTooltip(TOOLTIPS.syncOnWifiOnly)
      .then(s => { if (Platform.isIosApp) s.setDisabled(true); })
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncOnWifiOnly && !Platform.isIosApp)
        .setDisabled(Platform.isIosApp)
        .onChange(async (value) => {
          this.plugin.settings.syncOnWifiOnly = value;
          await this.plugin.saveSettings();
        }));

    makeSetting(containerEl)
      .setName('Sync on file change')
      .setDesc(Platform.isMobile
        ? 'Disabled on mobile (the OS suspends background work). Use "Sync on startup" or "Sync now".'
        : 'Immediately sync when a local Markdown file is modified (a short delay after you stop editing). Works alongside the periodic sync interval.')
      .setTooltip(TOOLTIPS.syncOnFileChange)
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.watchOnChangeEnabled && !Platform.isMobile)
        .setDisabled(Platform.isMobile)
        .onChange(async (value) => {
          this.plugin.settings.watchOnChangeEnabled = value;
          await this.plugin.saveSettings();
        }));

    // Feature 033: "Compare with remote" is always available (the explorer menu item and the
    // compare-with-remote command are registered unconditionally in main.ts), and "Chunk threshold"
    // is removed — the chunk threshold is platform-derived (50 MB desktop / 20 MB mobile).

    this.addNumberSlider(containerEl, {
      name: 'Maximum file size (MB)',
      desc: 'Files larger than this are skipped with a warning. 0 = unlimited. On mobile a low limit avoids out-of-memory crashes.',
      tooltip: TOOLTIPS.maxFileSize,
      min: 0, max: 4096, step: 10,
      get: () => this.plugin.settings.maxFileSizeMB,
      set: (v) => { this.plugin.settings.maxFileSizeMB = v; },
    });

    // Feature 033: the "Chunked upload" toggle was removed — chunked upload is always on (still
    // gated by the server-capability probe).

    // ── Conflict resolution ─────────────────────────────────────────────────────
    // Feature 030: frontmatter strategy, merge-failure policy and mergeable extensions are
    // user-editable. "Error" holds the file; switch to Remote/Local and re-sync, or use the
    // file's "Compare with remote" Push/Pull, to resolve.
    new Setting(containerEl).setName('Conflict resolution').setHeading();

    makeSetting(containerEl)
      .setName('Auto merge (experimental)')
      .setDesc('⚠️ when enabled, conflicts are auto-merged using reconcile-text. Results may be unexpected. Ensure Nextcloud version history is enabled before activating.')
      .setTooltip(TOOLTIPS.autoMerge)
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoMergeEnabled)
        .onChange(async (value) => {
          this.plugin.settings.autoMergeEnabled = value;
          await this.plugin.saveSettings();
        }));

    makeSetting(containerEl)
      .setName('Frontmatter conflict strategy')
      .setDesc('How to handle a note whose frontmatter differs on both sides. Keep one side and merge the body, or hold the file to resolve it yourself.')
      .setTooltip(TOOLTIPS.frontmatterConflictStrategy)
      .addDropdown(dd => dd
        .addOption('remote-wins', 'Remote')
        .addOption('local-wins', 'Local')
        .addOption('conflict', 'Error')
        .setValue(this.plugin.settings.frontmatterConflictStrategy)
        .onChange(async (value) => {
          this.plugin.settings.frontmatterConflictStrategy = value as DavSyncSettings['frontmatterConflictStrategy'];
          await this.plugin.saveSettings();
        }));

    // Feature 033: the "Max conflict regions" slider was removed — auto-merge never downgrades a
    // clean merge to inline markers on region count (always unlimited).

    makeSetting(containerEl)
      .setName('On merge failure')
      .setDesc('What to do when an automatic merge cannot complete: overwrite with one side, or hold the file. A held file resolves on a later sync once you pick a side, or via the file\'s compare-with-remote command.')
      .setTooltip(TOOLTIPS.conflictFailurePolicy)
      .addDropdown(dd => dd
        .addOption('remote-wins', 'Remote')
        .addOption('local-wins', 'Local')
        .addOption('error', 'Error')
        .setValue(this.plugin.settings.conflictFailurePolicy)
        .onChange(async (value) => {
          this.plugin.settings.conflictFailurePolicy = value as DavSyncSettings['conflictFailurePolicy'];
          await this.plugin.saveSettings();
        }));

    makeSetting(containerEl)
      .setName('Auto-merge file types')
      .setDesc('Comma-separated file extensions eligible for automatic merge, such as md, txt or py. Clear the field to disable auto-merge entirely — every conflict then uses the merge-failure policy above.')
      .setTooltip(TOOLTIPS.mergeableExtensions)
      .addText(text => text
        .setPlaceholder('Comma-separated extensions')
        .setValue(formatMergeableExtensions(this.plugin.settings.mergeableExtensions))
        .onChange(async (value) => {
          this.plugin.settings.mergeableExtensions = parseMergeableExtensions(value);
          await this.plugin.saveSettings();
        }));

    // ── Excluded folders ───────────────────────────────────────────────────────
    // User-managed list of vault-relative folders that are never synced (feature 027).
    // Folder-prefix match; additive on top of the permanent dotfolder/plugins/state-DB
    // hard exclusions. The list re-renders via render() after each add/remove.
    new Setting(containerEl).setName('Excluded folders').setHeading();

    makeSetting(containerEl)
      .setName('Excluded folders')
      .setDesc('Folders that are never synced — neither uploaded nor downloaded. Matched by folder prefix at a folder boundary, additive on top of the dotfolders, config plugins folder, and plugin state that are already excluded automatically.')
      .setTooltip(TOOLTIPS.excludedFolders);

    const excluded = this.plugin.settings.excludedFolders ?? [];
    for (const folder of excluded) {
      makeSetting(containerEl)
        .setName(folder)
        .addExtraButton(btn => btn
          .setIcon('trash')
          .setTooltip('Remove')
          .onClick(async () => {
            this.plugin.settings.excludedFolders =
              (this.plugin.settings.excludedFolders ?? []).filter(f => f !== folder);
            await this.plugin.saveSettings();
            this.render();
          }));
    }

    let excludeInput: TextComponent | null = null;
    const addExcluded = async (raw: string) => {
      const norm = normalizeExcludedFolder(raw);
      if (!norm) { new Notice('Enter a folder path inside the vault.'); return; }
      const list = this.plugin.settings.excludedFolders ?? [];
      if (list.includes(norm)) { new Notice(`"${norm}" is already excluded.`); return; }
      this.plugin.settings.excludedFolders = [...list, norm];
      await this.plugin.saveSettings();
      this.render();
    };

    makeSetting(containerEl)
      .setName('Add excluded folder')
      .setDesc('Choose a vault folder to stop syncing. Start typing to pick from matching folders, or open the full folder picker.')
      .setTooltip(TOOLTIPS.addExcludedFolder)
      .addText(text => {
        excludeInput = text;
        text.setPlaceholder('e.g. .git or Attachments/Large media');
        // Inline suggestions: vault folders not already excluded, filtered by what you type.
        new FolderInputSuggest(
          this.app,
          text.inputEl,
          () => this.plugin.settings.excludedFolders,
          (path) => { void addExcluded(path); },
        );
      })
      .addButton(btn => btn
        .setButtonText('Add')
        .setCta()
        .onClick(() => { void addExcluded(excludeInput?.getValue() ?? ''); }));

    // ── Config folder (.obsidian) ──────────────────────────────────────────────
    // Category-level opt-in for the config folder (issue #1), modelled on Obsidian native
    // Sync's "Vault configuration sync". Community plugins and the plugin's own state DB are
    // never synced and have no toggle (enforced in ConfigSyncResolver). The per-category rows
    // are folded away while the master is OFF and re-rendered when it changes.
    new Setting(containerEl).setName(`Config folder (${configDir})`).setHeading();

    makeSetting(containerEl)
      .setName('Sync config folder')
      .setDesc(`Opt in to syncing parts of the ${configDir} config folder across devices. Off by default — only notes and other vault files sync. Community plugins are never synced (their files stay device-local). A synced change to core-plugin settings may need an Obsidian restart to take effect on the other device.`)
      .setTooltip(TOOLTIPS.syncConfigFolder)
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncConfigFolder)
        .onChange(async (value) => {
          this.plugin.settings.syncConfigFolder = value;
          await this.plugin.saveSettings();
          // Re-render so the per-category toggles fold away / reappear (their values persist
          // in settings across the toggle).
          this.render();
        }));

    if (this.plugin.settings.syncConfigFolder) {
      for (const category of CONFIG_SYNC_CATEGORIES) {
        makeSetting(containerEl)
          .setName(category.label)
          .setDesc(category.description)
          .setTooltip(TOOLTIPS[CONFIG_CATEGORY_TOOLTIP[category.key]])
          .addToggle(toggle => toggle
            .setValue(this.plugin.settings.configSync[category.key])
            .onChange(async (value) => {
              this.plugin.settings.configSync[category.key] = value;
              await this.plugin.saveSettings();
            }));
      }
    }

    new Setting(containerEl).setName('Debug').setHeading();

    // The single Debug control. The device name (auto-derived <platform>-<deviceId>) and the log
    // location (vault root) are fixed — feature 032 removed their inputs to converge every user onto
    // one path. The sync log (all operations) and debug log (verbose) verbosity are also fixed.
    makeSetting(containerEl)
      .setName('Enable logging (troubleshooting)')
      .setDesc('Write a per-device sync log and a verbose debug log to the vault root while troubleshooting. The device name is derived automatically and the log location is fixed to the vault root. Turn this off and delete the log files when finished.')
      .setTooltip(TOOLTIPS.loggingEnabled)
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.loggingEnabled)
        .onChange(async (value) => {
          this.plugin.settings.loggingEnabled = value;
          await this.plugin.saveSettings();
          // Dump a fresh settings snapshot as soon as logging is turned on.
          if (value) void this.plugin.logSettingsSnapshot();
        }));

    new Setting(containerEl).setName('Maintenance').setHeading();

    makeSetting(containerEl)
      .setName('Reset vault index')
      .setDesc('Clear this device\'s sync tracking index so the plugin returns to its first-install state. No vault or remote files are deleted; the next sync performs a full re-scan. Use this if the sync state looks inconsistent.')
      .setTooltip(TOOLTIPS.resetVaultIndex)
      .addButton(btn => btn
        .setButtonText('Reset')
        // `mod-warning` is the destructive-button class; setDestructive() needs 1.13.0 > minAppVersion.
        .setClass('mod-warning')
        .onClick(() => {
          void this.plugin.resetVaultIndex();
        }));

    makeSetting(containerEl)
      .setName('Last session summary')
      .setDesc('Open the sync status dialog: recent activity grouped by sync run, conflicts, retries, and errors.')
      .setTooltip(TOOLTIPS.lastSessionSummary)
      .addButton(btn => btn
        .setButtonText('View')
        .onClick(() => {
          // Open the full Sync Status dialog (desktop and mobile), not just a one-line toast. On
          // mobile this is the only way to reach it (no status bar). openSyncStatus handles the
          // not-configured case with its own notice.
          this.plugin.openSyncStatus();
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
      tooltip?: string;
      get: () => number;
      set: (value: number) => void;
      /** Optional side-effect run after the value is persisted (e.g. re-apply a live timer). */
      apply?: () => void | Promise<void>;
    },
  ): void {
    const setting = makeSetting(containerEl).setName(opts.name);
    if (opts.desc) setting.setDesc(opts.desc);
    if (opts.tooltip) setting.setTooltip(opts.tooltip);

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
function saveAppPassword(app: App, secretId: string, value: string): void {
  const id = secretId || DEFAULT_PASSWORD_SECRET_ID;
  app.secretStorage.setSecret(id, value);
}
