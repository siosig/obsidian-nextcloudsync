import { App, Plugin, Notice, Platform, TFile, TAbstractFile, debounce } from 'obsidian';
import { DavSyncSettings, DEFAULT_SETTINGS, FeatureUnsupportedError } from './types';
import { NextcloudSyncSettingTab } from './settings/SettingTab';
import { SyncEngine } from './sync/SyncEngine';
import { VersionHistoryModal } from './ui/VersionHistoryModal';
import { SyncStatusModal } from './ui/SyncStatusModal';
import { FileLogger } from './util/FileLogger';
import { v4 as uuidv4 } from './util/uuid';

const MIN_OBSIDIAN_VERSION = '1.12.7';

export default class ObsidianNextcloudsync extends Plugin {
  settings!: DavSyncSettings;
  syncEngine?: SyncEngine;
  /** Diagnostic file logger (writes nextcloud-sync-debug.md while Debug mode is on). */
  logger!: FileLogger;

  async onload(): Promise<void> {
    // Obsidian version check
    const currentVersion = (this.app as App & { appVersion?: string }).appVersion ?? '';
    if (currentVersion && this.compareVersions(currentVersion, MIN_OBSIDIAN_VERSION) < 0) {
      new Notice(
        `Nextcloud Sync requires Obsidian ${MIN_OBSIDIAN_VERSION} or later. Current: ${currentVersion}`,
        0,
      );
      return;
    }

    await this.loadSettings();

    // Generate deviceId if not set (also used to label diagnostic-log lines per device).
    if (!this.settings.deviceId) {
      this.settings.deviceId = uuidv4();
      await this.saveSettings();
    }

    // Diagnostic logger: appends to nextcloud-sync-debug.md while Debug mode is on (all platforms).
    // Debug mode logs and still performs a real sync — identical behavior on desktop and mobile.
    // Each line is tagged with a device label so a synced log from multiple devices is readable.
    this.logger = new FileLogger(this.app.vault.adapter, () => this.settings.debugMode, this.manifest.version, this.deviceLabel());
    void this.logger.log(`plugin loaded (obsidian=${currentVersion})`);

    // Initialize SyncEngine (lazy — only when settings are complete)
    if (this.settings.serverUrl && this.settings.username) {
      await this.initSyncEngine();
    }

    this.addSettingTab(new NextcloudSyncSettingTab(this.app, this));

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: async () => {
        await this.runSyncNow();
      },
    });

    this.addCommand({
      id: 'show-version-history',
      name: 'Show version history',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.syncEngine) return false;
        if (checking) return true;
        void this.showVersionHistory(file);
        return true;
      },
    });

    // Watch mode: react to individual file events with lightweight single-file operations.
    // Full vault sync is reserved for manual Sync Now and the periodic interval.
    // Watch mode is disabled on mobile (OS suspends background work).
    const guard = (file: TAbstractFile): file is TFile =>
      this.settings.watchOnChangeEnabled && !Platform.isMobile && file instanceof TFile;

    // Accumulate paths changed during rapid editing and flush them together after the
    // debounce window so each keystroke does not trigger a separate network request.
    const pendingUploads = new Set<string>();
    const debouncedUpload = debounce(() => {
      const paths = [...pendingUploads];
      pendingUploads.clear();
      for (const path of paths) {
        void this.syncEngine?.syncSingleFile(path);
      }
    }, 2000, true);

    this.registerEvent(this.app.vault.on('modify', (file: TAbstractFile) => {
      if (!guard(file)) return;
      pendingUploads.add(file.path);
      debouncedUpload();
    }));
    this.registerEvent(this.app.vault.on('create', (file: TAbstractFile) => {
      if (!guard(file)) return;
      pendingUploads.add(file.path);
      debouncedUpload();
    }));
    this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => {
      if (!guard(file)) return;
      pendingUploads.delete(file.path); // cancel any pending upload for this path
      void this.syncEngine?.deleteSingleFile(file.path);
    }));
    this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
      if (!guard(file)) return;
      pendingUploads.delete(oldPath);
      void this.syncEngine?.renameSingleFile(oldPath, file.path);
    }));
  }

  /**
   * Run "Sync Now". In debug mode, show a dry-run plan modal instead of syncing.
   * Shared by the command and the settings button.
   */
  async runSyncNow(): Promise<void> {
    void this.logger.log('sync: "Sync now" clicked');
    // Initialize lazily if credentials were entered after startup (e.g. first-time setup).
    if (!this.syncEngine && this.settings.serverUrl && this.settings.username) {
      await this.initSyncEngine();
    }
    if (!this.syncEngine) {
      void this.logger.log('sync: aborted — server settings incomplete');
      new Notice('Configure the server settings first.');
      return;
    }
    await this.syncEngine.syncManual({ manual: true });
  }

  /** Open the sync-status dialog (conflicts / retry queue) from a status-bar click. */
  private showSyncStatus(): void {
    if (!this.syncEngine) {
      new Notice('Configure the server settings first.');
      return;
    }
    new SyncStatusModal(this.app, this.syncEngine.getStatusReport()).open();
  }

  /** Fetch the server-side version history of the active note and show the modal (US2). */
  private async showVersionHistory(file: TFile): Promise<void> {
    const engine = this.syncEngine;
    if (!engine) return;
    try {
      const versions = await engine.listVersions(file.path);
      new VersionHistoryModal(
        this.app,
        file.path,
        versions,
        (version) => engine.restoreVersion(file.path, version),
      ).open();
    } catch (err) {
      if (err instanceof FeatureUnsupportedError) {
        new Notice('No server version history is available for this file.', 6000);
      } else {
        new Notice(`❌ Failed to load version history: ${(err as Error).message}`, 6000);
      }
    }
  }

  /** Short, stable per-device label for diagnostic-log lines (platform + hostname, or deviceId). */
  private deviceLabel(): string {
    const platform = Platform.isIosApp ? 'ios' : Platform.isAndroidApp ? 'android' : 'desktop';
    let host = '';
    if (Platform.isDesktopApp) {
      try {
        // os is a desktop-only Node builtin; this branch never runs on mobile (Platform.isDesktopApp guard).
        // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef, import/no-nodejs-modules
        host = (require('os') as { hostname(): string }).hostname();
      } catch { /* hostname unavailable */ }
    }
    const id = (this.settings.deviceId ?? '').replace(/-/g, '').slice(0, 6);
    return host ? `${platform}/${host}` : `${platform}/${id}`;
  }

  onunload(): void {
    this.syncEngine?.stopAutoSync();
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData() ?? {}) as Partial<DavSyncSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

    // DEFAULT_SETTINGS holds the desktop defaults. On mobile, apply mobile-specific
    // overrides only on first run (key absent from saved data) so existing users keep
    // their values (backward compatible).
    if (Platform.isMobile) {
      if (saved.syncOnStartupEnabled === undefined) this.settings.syncOnStartupEnabled = false;
      if (saved.networkConcurrency === undefined) this.settings.networkConcurrency = 2;
      if (saved.maxFileSizeMB === undefined) this.settings.maxFileSizeMB = 20; // OOM-safe cap
      if (saved.syncOnWifiOnly === undefined) this.settings.syncOnWifiOnly = true;
    }

    // Defensive normalization for the conflict-resolution settings (backward compat / corrupt data).
    if (!Array.isArray(this.settings.mergeableExtensions)) {
      this.settings.mergeableExtensions = [...DEFAULT_SETTINGS.mergeableExtensions];
    }
    const validPolicies = ['error', 'local-wins', 'remote-wins', 'conflict-markers'];
    if (!validPolicies.includes(this.settings.conflictFailurePolicy)) {
      this.settings.conflictFailurePolicy = DEFAULT_SETTINGS.conflictFailurePolicy;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async initSyncEngine(): Promise<void> {
    const { LocalAdapter } = await import('./data/LocalAdapter');
    const { StateDB } = await import('./data/StateDB');
    const { StatusBarItem } = await import('./ui/StatusBarItem');
    const { NullStatusBar } = await import('./ui/NullStatusBar');
    const { WebDAVFactory } = await import('./network/WebDAVFactory');
    const { loadAppPassword } = await import('./settings/SettingTab');

    const localAdapter = new LocalAdapter(this.app.vault.adapter);
    const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const stateDB = new StateDB(this.app.vault.adapter, pluginDir, this.settings.deviceId);
    await stateDB.load();

    // Mobile has no visible status bar and the spec requires no progress display:
    // inject a no-op status bar so the sync engine needs no platform branching.
    // On desktop, clicking the status bar opens the sync-status dialog (conflicts / retries).
    const statusBar = Platform.isMobile
      ? new NullStatusBar()
      : new StatusBarItem(this.addStatusBarItem(), () => this.showSyncStatus());
    const password = loadAppPassword(this.app, this.settings.passwordSecretId);
    const webdavFactory = new WebDAVFactory(this.app, this.settings, password, (m) => void this.logger.log(`net: ${m}`));

    this.syncEngine = new SyncEngine({
      app: this.app,
      settings: this.settings,
      localAdapter,
      stateDB,
      statusBar,
      webdavFactory,
      pluginDir,
      configDir: this.app.vault.configDir,
      logger: this.logger,
      onFeatures: (features) => {
        // Record the server version so the settings screen can recommend an upgrade
        // when it is below the supported minimum. Persist only on change.
        if (features.version && features.version !== this.settings.lastKnownServerVersion) {
          this.settings.lastKnownServerVersion = features.version;
          void this.saveSettings();
        }
      },
    });

    // Periodic auto-sync is desktop-only (mobile OS suspends background timers).
    if (!Platform.isMobile && this.settings.syncIntervalMinutes > 0) {
      this.syncEngine.startAutoSync(this.settings.syncIntervalMinutes);
    }

    // Startup sync: configurable on both platforms. Default ON (desktop) / OFF (mobile).
    if (this.settings.syncOnStartupEnabled) {
      const delayMs = Math.max(0, this.settings.startupSyncDelaySeconds) * 1000;
      window.setTimeout(() => { void this.syncEngine?.syncManual(); }, delayMs);
    }
  }

  private compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }
}
