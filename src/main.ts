import { App, Plugin, Notice, Platform, TFile, TFolder, TAbstractFile, debounce } from 'obsidian';
import { DavSyncSettings, DEFAULT_SETTINGS, FeatureUnsupportedError, SyncHistoryEntry, SyncSessionSummary } from './types';
import { NextcloudSyncSettingTab } from './settings/SettingTab';
import { SyncEngine } from './sync/SyncEngine';
import { VersionHistoryModal } from './ui/VersionHistoryModal';
import { SyncStatusModal } from './ui/SyncStatusModal';
import { StatusFilterState, makeDefaultFilterState, serializeFilter, deserializeFilter } from './ui/statusFilter';
import { CompareModal } from './ui/CompareModal';
import { applyForceResolution, applyBulkForceResolution, FORCE_CHOICES, ForceChoice } from './ui/forceResolution';
import { confirmModal } from './ui/ConfirmModal';
import { FileLogger } from './util/FileLogger';
import { isSyncTmpPath, LocalAdapter } from './data/LocalAdapter';
import type { MergeBaseStore } from './data/MergeBaseStore';
import { v4 as uuidv4 } from './util/uuid';
import { hostToken, LogPlatform } from './util/hostToken';
import { migrateConfigSyncCategories, migrateBookmarksToConfigSync, migrateStartupToggleToDelay, migrateConflictSettingsToStrategies, pruneObsoleteSettings, resetDebugIdentityFields, applyMobileFirstRunDefaults } from './util/settingsMigration';
import { debugLogPath, syncLogPath, isActiveOwnLog } from './util/logPaths';
import { SyncLogWriter, formatResolution } from './log/SyncLogWriter';
import { autoNetworkConcurrency } from './util/platformDefaults';

const MIN_OBSIDIAN_VERSION = '1.11.4';

export default class ObsidianNextcloudsync extends Plugin {
  settings!: DavSyncSettings;
  syncEngine?: SyncEngine;

  /** True while a Pull-mirror (feature 045) is running, to guard against double-invocation. */
  private mirrorInProgress = false;
  /** Shared with SyncEngine; its ignore list marks the plugin's own writes for the watchers. */
  localAdapter?: LocalAdapter;
  /** Merge base store (feature 038); flushed on unload so a debounced base write is not lost. */
  baseStore?: MergeBaseStore;
  /** Clean-side snapshot store (feature 044); flushed on unload so a debounced write is not lost. */
  cleanSideStore?: import('./data/CleanSideStore').CleanSideStore;
  /** Diagnostic file logger (writes a per-device debug log while the debug log is enabled). */
  logger!: FileLogger;
  /** Per-device sync-log writer (appends one block per sync when the sync log is enabled). */
  syncLogWriter!: SyncLogWriter;
  /**
   * Status filter for the Sync Status dialog. Held here (not on the modal, which is recreated per
   * open) so the selection persists across reopens. Hydrated from settings on load and saved on every
   * change, so it now survives an Obsidian restart too.
   */
  private readonly statusFilterState: StatusFilterState = makeDefaultFilterState();

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

    // Restore the persisted Sync Status filter selection (all-on when nothing was saved).
    this.statusFilterState.checked = deserializeFilter(this.settings.statusFilter).checked;

    // Generate deviceId if not set (also used to label diagnostic-log lines per device).
    if (!this.settings.deviceId) {
      this.settings.deviceId = uuidv4();
      await this.saveSettings();
    }

    // Diagnostic logger: appends to a per-device debug log while the debug log is enabled (all
    // platforms). Logging still performs a real sync — identical behavior on desktop and mobile.
    // The file is named with this device's host token so multiple devices never collide, and each
    // line is gated by the configured verbosity level.
    this.logger = new FileLogger(
      this.app.vault.adapter,
      () => this.settings.loggingEnabled,
      () => 'verbose' as const,
      this.manifest.version,
      this.hostToken(),
      () => debugLogPath(this.settings.logsFolder, this.hostToken()),
    );
    void this.logger.log(`plugin loaded (obsidian=${currentVersion})`);
    // Record a full settings snapshot at the top of each debug-log session.
    void this.logSettingsSnapshot();

    // Per-device sync log: appends one block per sync (binary version + conflict-resolution
    // settings header, then one line per qualifying operation) while the sync log is enabled.
    this.syncLogWriter = new SyncLogWriter(
      this.app.vault.adapter,
      () => this.settings.loggingEnabled,
      () => syncLogPath(this.settings.logsFolder, this.hostToken()),
    );

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

    // Explorer "Compare with remote" context-menu item. Always available when a single file is
    // selected and the sync engine is configured.
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      // Available on mobile too (long-press menu). The diff is a pure Modal + LCS with no Electron
      // deps, and the layout collapses to a single column on narrow screens.
      if (!(file instanceof TFile)) return; // single file only
      if (!this.syncEngine) return;          // engine must be configured
      menu.addItem(item => item
        .setTitle('Compare with remote')
        .setIcon('git-compare')
        .onClick(() => { new CompareModal(this.app, file.path, this.syncEngine!).open(); }));
    }));

    // Command-palette entry — the reliable entry point on mobile (works on desktop too). Active only
    // when a file is open and the engine is configured.
    this.addCommand({
      id: 'compare-with-remote',
      name: 'Compare with remote',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const ok = file instanceof TFile && !!this.syncEngine;
        if (ok && !checking) new CompareModal(this.app, file.path, this.syncEngine!).open();
        return ok;
      },
    });

    // Defer the heavy work to layout-ready. Registering vault listeners during `onload` is a
    // documented pitfall: the `create` event fires once per file while the vault initializes, so
    // a fresh start would flood the watcher. onLayoutReady runs after that initial pass. The
    // SyncEngine (and its lazy startup sync) is also initialized here to keep `onload` lightweight.
    this.app.workspace.onLayoutReady(() => {
      // Initialize SyncEngine (lazy — only when settings are complete).
      if (this.settings.serverUrl && this.settings.username) {
        void this.initSyncEngine();
      }

      // Watch mode: react to individual file events with lightweight single-file operations.
      // Full vault sync is reserved for manual Sync Now and the periodic interval.
      // Watch mode is disabled on mobile (OS suspends background work).
      const guard = (file: TAbstractFile): file is TFile =>
        this.settings.watchOnChangeEnabled && file instanceof TFile; // false on mobile (applied in loadSettings)

      // Vault events caused by the plugin itself (downloads / conflict writes use atomic
      // tmp-write → rename) must not be propagated back to the server, or every download
      // turns into a spurious upload/MOVE/DELETE storm. SyncEngine marks its own writes in
      // the LocalAdapter ignore list; tmp paths are filtered unconditionally.
      const isOwnSyncEvent = (path: string): boolean =>
        isSyncTmpPath(path) || (this.localAdapter?.shouldIgnore(path) ?? false);

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
        if (!guard(file) || isOwnSyncEvent(file.path)) return;
        pendingUploads.add(file.path);
        debouncedUpload();
      }));
      // Feature 046: folders (TFolder) propagate immediately via single-folder ops; files keep the
      // debounced upload path. watchOn() is the master gate (false on mobile via loadSettings).
      const watchOn = (): boolean => this.settings.watchOnChangeEnabled;
      this.registerEvent(this.app.vault.on('create', (file: TAbstractFile) => {
        if (!watchOn() || isOwnSyncEvent(file.path)) return;
        if (file instanceof TFolder) { void this.syncEngine?.createSingleFolder(file.path); return; }
        if (!(file instanceof TFile)) return;
        pendingUploads.add(file.path);
        debouncedUpload();
      }));
      this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => {
        if (!watchOn()) return;
        pendingUploads.delete(file.path); // cancel any pending upload for this path
        if (isOwnSyncEvent(file.path)) return; // e.g. atomic write replacing the old copy
        if (file instanceof TFolder) { void this.syncEngine?.deleteSingleFolder(file.path); return; }
        void this.syncEngine?.deleteSingleFile(file.path);
      }));
      this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (!watchOn()) return;
        pendingUploads.delete(oldPath);
        // tmp → target renames are the tail of the plugin's own atomic writes.
        if (isOwnSyncEvent(oldPath) || isOwnSyncEvent(file.path)) return;
        if (file instanceof TFolder) { void this.syncEngine?.renameSingleFolder(oldPath, file.path); return; }
        void this.syncEngine?.renameSingleFile(oldPath, file.path);
      }));
    });
  }

  /**
   * Run "Sync Now". On the very first sync (no recorded state), the engine performs a full scan and
   * applies the initial plan directly. Shared by the command and the settings button.
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

  /**
   * (Re)start or stop periodic auto-sync to match the current settings. Called at engine init
   * and whenever the "Sync interval" setting changes, so a new interval takes effect immediately
   * without a plugin reload. Desktop-only — on mobile the OS suspends background timers, so this
   * always stops the timer there.
   */
  applyAutoSyncInterval(): void {
    if (!this.syncEngine) return;
    if (!Platform.isMobile && this.settings.syncIntervalMinutes > 0) {
      this.syncEngine.startAutoSync(this.settings.syncIntervalMinutes);
    } else {
      this.syncEngine.stopAutoSync();
    }
  }

  /**
   * Open the Sync Status dialog. Reachable from the desktop status-bar click AND the settings
   * "Last session summary" button, on both desktop and mobile (the dialog itself is platform-agnostic).
   * The filter selection is persisted: every toggle saves it to settings so it survives a restart.
   */
  openSyncStatus(): void {
    if (!this.syncEngine) {
      new Notice('Configure the server settings first.');
      return;
    }
    new SyncStatusModal(
      this.app,
      () => this.syncEngine!.getStatusReport(),
      () => this.runSyncNow(),
      this.statusFilterState,
      () => {
        this.settings.statusFilter = serializeFilter(this.statusFilterState);
        void this.saveSettings();
      },
      // Feature 041: force-resolve one conflicted file now. Failures surface as a Notice and leave the
      // file conflicted (the modal re-renders either way); a tie (equal mtime/size) is a silent no-op.
      async (path: string, choice: ForceChoice) => {
        try {
          await applyForceResolution(this.syncEngine!, path, choice);
        } catch (err) {
          new Notice(`Could not resolve "${path}": ${(err as Error).message}`);
        }
      },
      // Feature 042: force-resolve every currently-listed conflict with one chosen action. The
      // host owns the confirmation (destructive, irreversible) and the single aggregate result
      // Notice; applyBulkForceResolution itself never rejects (per-file failures are tallied).
      async (choice: ForceChoice, paths: string[]) => {
        const n = paths.length;
        const label = FORCE_CHOICES.find(c => c.id === choice)?.label ?? choice;
        const ok = await confirmModal(this.app, {
          title: 'Resolve all conflicts',
          message: `Force-resolve all ${n} conflicts using "${label}"? This overwrites files and cannot be undone.`,
          cta: 'Apply to all',
          cancel: 'Cancel',
          destructive: true,
        });
        if (!ok) return;
        const { resolved, noop, failed } = await applyBulkForceResolution(this.syncEngine!, paths, choice);
        new Notice(`Resolved ${resolved} of ${n} conflicts`
          + (noop ? `; ${noop} unchanged` : '') + (failed ? `; ${failed} failed` : ''));
      },
    ).open();
  }

  /**
   * Maintenance action: reset this device's sync tracking index ("Vault index") to the first-install
   * empty state after an explicit confirmation. No vault or remote files are deleted; the next sync
   * performs a full re-scan. Works whether or not the sync engine is configured: with an engine it
   * aborts any in-flight sync first; without one it resets the on-disk state file directly.
   */
  async resetVaultIndex(): Promise<void> {
    const confirmed = await confirmModal(this.app, {
      title: 'Reset vault index',
      message:
        "Clear this device's sync tracking index and return to the first-install state. " +
        'No vault or remote files are deleted. The next sync will perform a full re-scan.',
      cta: 'Reset',
      cancel: 'Cancel',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      if (this.syncEngine) {
        await this.syncEngine.resetIndex();
      } else {
        // Unconfigured: no engine/StateDB instance exists, but a stale state file may remain on disk.
        const { StateDB } = await import('./data/StateDB');
        const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        await StateDB.resetFile(this.app.vault.adapter, pluginDir, this.settings.deviceId);
      }
      new Notice('Vault index reset. The next sync will perform a full re-scan.');
    } catch (err) {
      new Notice(`❌ Failed to reset the Vault index: ${(err as Error).message}`, 6000);
    }
  }

  /**
   * Maintenance action (feature 045): mirror this device from the remote — overwrite the local vault
   * to exactly match the remote (download everything the remote has, delete local files/folders the
   * remote lacks via the Obsidian trash setting). Shows the download/delete counts for confirmation
   * before applying; cancelling is a no-op. Bypasses the mass-delete breaker but aborts if the remote
   * listing cannot be obtained (zero deletions). Works only when the sync engine is configured.
   */
  async runRemoteMirror(): Promise<void> {
    const engine = this.syncEngine;
    if (!engine) {
      new Notice('Sign in to Nextcloud before mirroring from the remote.', 6000);
      return;
    }
    if (this.mirrorInProgress) return; // guard against double-invocation
    this.mirrorInProgress = true;
    try {
      await engine.abortAndWait();

      const plan = await engine.planRemoteMirror();
      if (!plan.ok) {
        new Notice(`❌ Mirror aborted: ${plan.reason ?? 'could not read the remote'} (no files were changed).`, 8000);
        return;
      }

      const deleteCount = plan.deleteFiles.length + plan.deleteDirs.length;
      const confirmed = await confirmModal(this.app, {
        title: 'Mirror from remote',
        message:
          `This will make this device exactly match the remote:\n\n` +
          `• Download: ${plan.downloads.length} file(s)\n` +
          `• Delete locally: ${deleteCount} file(s)/folder(s) not on the remote ` +
          `(moved to your Obsidian trash — recoverable)\n\n` +
          `Unsynced local changes will be discarded. This cannot be undone except from the trash.`,
        cta: 'Mirror from remote',
        cancel: 'Cancel',
        destructive: true,
      });
      if (!confirmed) return; // no-op (FR-004)

      // Progress + result are surfaced by the sync engine through the SAME status-bar surface as a
      // normal "Sync now": a live progress bar on desktop and a single "🔄 Syncing… N/total" → result
      // toast on mobile (driven inside applyRemoteMirror via setStatus/setProgress/setSyncComplete).
      await engine.applyRemoteMirror(plan);
    } catch (err) {
      new Notice(`❌ Mirror from remote failed: ${(err as Error).message}`, 8000);
    } finally {
      this.mirrorInProgress = false;
    }
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

  /** The platform bucket used in the default host token and log labels. */
  private logPlatform(): LogPlatform {
    return Platform.isIosApp ? 'ios' : Platform.isAndroidApp ? 'android' : 'desktop';
  }

  /**
   * Stable, filename-safe per-device host token used to name both log files and label debug-log
   * lines. Derived from the user-facing Device name, defaulting to `<platform>-<deviceId6>`.
   */
  private hostToken(): string {
    return hostToken(this.settings.deviceName, this.logPlatform(), this.settings.deviceId);
  }

  /**
   * Append this session's outcomes to the per-device sync log. The session header carries the
   * binary version and all merge-related settings; each line carries the per-file marker,
   * checksums and sizes. No-op when the sync log is disabled.
   */
  private async appendSyncLog(entries: SyncHistoryEntry[], summary: SyncSessionSummary): Promise<void> {
    const resolution = formatResolution({
      autoMergeFileStrategy: this.settings.autoMergeFileStrategy,
      otherFileStrategy: this.settings.otherFileStrategy,
      autoMergeFileTypes: this.settings.autoMergeFileTypes,
    });
    await this.syncLogWriter.append(entries, {
      at: summary.startedAt,
      version: this.manifest.version,
      resolution,
      level: 'all',
    });
  }

  /**
   * Write a snapshot of every setting value to the debug log (US4 request). Logged at `error`
   * level so it always appears while the debug log is enabled, regardless of the verbosity level.
   * The actual app password is never stored here — `passwordSecretId` is only a SecretStorage key.
   */
  async logSettingsSnapshot(): Promise<void> {
    const snapshot = JSON.stringify(this.settings);
    await this.logger.log(`settings snapshot: ${snapshot}`, 'error');
  }

  onunload(): void {
    this.syncEngine?.stopAutoSync();
    // Two-Phase Termination: signal an in-flight sync to stop pulling new work (phase 1), then flush
    // any pending debounced state save so a coalesced watch-mode update is not lost on teardown (phase 2).
    this.syncEngine?.requestStop();
    void this.syncEngine?.flushState();
    void this.baseStore?.flush();
    void this.cleanSideStore?.flush();
    this.localAdapter?.dispose();
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData() ?? {}) as Partial<DavSyncSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

    // Start from the two-key defaults, then fold any persisted configSync into the new model:
    // migrateConfigSyncCategories collapses the old five-key shape into {bookmarks, others}
    // (feature 029); migrateBookmarksToConfigSync handles the even older standalone syncBookmarks.
    this.settings.configSync = { ...DEFAULT_SETTINGS.configSync };
    migrateConfigSyncCategories(saved, this.settings);
    migrateBookmarksToConfigSync(saved, this.settings);
    // Mobile first-run defaults: override before pruning so they are persisted immediately.
    if (Platform.isMobile) {
      applyMobileFirstRunDefaults(saved, this.settings);
    }
    // networkConcurrency: derived from device RAM on first run (the persisted value is kept as-is).
    if (saved.networkConcurrency === undefined) {
      this.settings.networkConcurrency = autoNetworkConcurrency();
    }

    // Feature 034 (rev): the "Sync on startup" toggle was folded into the startup-delay slider
    // (0 = no startup sync). Convert any persisted toggle state before it is pruned below.
    migrateStartupToggleToDelay(saved, this.settings);

    // Feature 037: fold the three removed conflict settings (autoMergeEnabled / conflictFailurePolicy
    // / frontmatterConflictStrategy + mergeableExtensions) into the per-type strategy model before the
    // obsolete keys are pruned below.
    migrateConflictSettingsToStrategies(saved, this.settings);

    // Feature 032: the Debug section no longer exposes a device name or a log folder. Force both back
    // to their auto/fixed sentinels so every user converges onto the single path (device name derived,
    // logs at the vault root), discarding any custom value an older version persisted.
    const debugReset = resetDebugIdentityFields(saved, this.settings);

    // Drop obsolete persisted keys (e.g. the removed `debugMode` and the leftover
    // `logLevel` / `syncResults*` fields from an earlier 0.3.0-beta), then persist the cleaned
    // settings so data.json no longer carries them (or no longer carries a stale Debug identity).
    const removed = pruneObsoleteSettings(this.settings as unknown as Record<string, unknown>);
    if (removed.length > 0 || debugReset) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async initSyncEngine(): Promise<void> {
    const { StateDB } = await import('./data/StateDB');
    const { MergeBaseStore } = await import('./data/MergeBaseStore');
    const { SyncHistoryStore } = await import('./data/SyncHistoryStore');
    const { StatusBarItem } = await import('./ui/StatusBarItem');
    const { NoticeStatusBar } = await import('./ui/NoticeStatusBar');
    const { WebDAVFactory } = await import('./network/WebDAVFactory');
    const { loadAppPassword } = await import('./settings/SettingTab');

    const localAdapter = new LocalAdapter(this.app.vault.adapter, this.app.vault);
    this.localAdapter = localAdapter;
    const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const stateDB = new StateDB(this.app.vault.adapter, pluginDir, this.settings.deviceId);
    await stateDB.load();
    // Feature 038: last-synced bodies (merge base) for true 3-way conflict merges. Separate file.
    const baseStore = new MergeBaseStore(this.app.vault.adapter, pluginDir, this.settings.deviceId);
    await baseStore.load();
    this.baseStore = baseStore;
    // Feature 044: captured clean sides of marker-conflicted notes so force-resolution recovers a real
    // clean version rather than the marker content. Separate per-device file (like the merge base).
    const { CleanSideStore } = await import('./data/CleanSideStore');
    const cleanSideStore = new CleanSideStore(this.app.vault.adapter, pluginDir, this.settings.deviceId);
    await cleanSideStore.load();
    this.cleanSideStore = cleanSideStore;
    const historyStore = new SyncHistoryStore(this.app.vault.adapter, pluginDir);
    await historyStore.load();

    // Mobile has no visible status bar (addStatusBarItem is unavailable there), so feedback is
    // surfaced as a single reused Notice toast via NoticeStatusBar. Both implement IStatusBar, so
    // the sync engine needs no platform branching.
    // On desktop, clicking the status bar opens the sync-status dialog (conflicts / retries).
    const statusBar = Platform.isMobile
      ? new NoticeStatusBar()
      : new StatusBarItem(this.addStatusBarItem(), () => this.openSyncStatus());
    const password = loadAppPassword(this.app, this.settings.passwordSecretId);
    const webdavFactory = new WebDAVFactory(this.app, this.settings, password, (m) => void this.logger.log(`net: ${m}`));

    this.syncEngine = new SyncEngine({
      app: this.app,
      settings: this.settings,
      localAdapter,
      stateDB,
      baseStore,
      cleanSideStore,
      statusBar,
      historyStore,
      webdavFactory,
      pluginDir,
      configDir: this.app.vault.configDir,
      // Keep this device's own log file out of sync while its output toggle is on (it is being
      // appended to during the sync). Evaluated live, from the same settings + host token the
      // loggers use, so it follows the Sync log / Debug log toggles and any logsFolder change.
      isActiveLogFile: (path) => isActiveOwnLog(path, {
        logsFolder: this.settings.logsFolder,
        host: this.hostToken(),
        loggingEnabled: this.settings.loggingEnabled,
      }),
      logger: this.logger,
      onFeatures: (features) => {
        // Record the server version so the settings screen can recommend an upgrade
        // when it is below the supported minimum. Persist only on change.
        if (features.version && features.version !== this.settings.lastKnownServerVersion) {
          this.settings.lastKnownServerVersion = features.version;
          void this.saveSettings();
        }
      },
      onSessionComplete: (entries, summary) => this.appendSyncLog(entries, summary),
    });

    // Periodic auto-sync is desktop-only (mobile OS suspends background timers).
    this.applyAutoSyncInterval();

    // Startup sync: user-configurable via the startup-delay slider (the toggle was folded in).
    // 0 = no startup sync; 1–10 = seconds to wait before it. Default 1 (enabled, 1 s).
    if (this.settings.startupSyncDelaySeconds > 0) {
      const delayMs = this.settings.startupSyncDelaySeconds * 1000;
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
