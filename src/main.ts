import { App, Plugin, Notice, Platform, TFile, TFolder, TAbstractFile, debounce } from 'obsidian';
import { DavSyncSettings, DEFAULT_SETTINGS, FeatureUnsupportedError } from './types';
import { NextcloudSyncSettingTab } from './settings/SettingTab';
import { SyncEngine } from './sync/SyncEngine';
import { VersionHistoryModal } from './ui/VersionHistoryModal';
import { SyncStatusModal } from './ui/SyncStatusModal';
import { StatusFilterState, makeDefaultFilterState, serializeFilter, deserializeFilter } from './ui/statusFilter';
import { CompareModal } from './ui/CompareModal';
import { applyForceResolution, applyBulkForceResolution, FORCE_CHOICES, ForceChoice } from './ui/forceResolution';
import { confirmModal } from './ui/ConfirmModal';
import { openMirrorFromRemoteModal } from './ui/MirrorFromRemoteModal';
import { registerSyncRibbon } from './ui/syncRibbon';
import { registerMirrorRibbon, registerStatusCommands } from './ui/statusEntryPoints';
import { FileLogger } from './util/FileLogger';
import { onAppResume, makeResumeSyncHandler } from './util/appResume';
import { isSyncTmpPath, LocalAdapter } from './data/LocalAdapter';
import type { MergeBaseStore } from './data/MergeBaseStore';
import { v4 as uuidv4 } from './util/uuid';
import { hostToken, LogPlatform } from './util/hostToken';
import { migrateConfigSyncCategories, migrateBookmarksToConfigSync, migrateStartupToggleToDelay, migrateConflictSettingsToStrategies, migrateFrontmatterScalarPolicyToStrategy, migrateMarkdownAutoMergeType, pruneObsoleteSettings, resetDebugIdentityFields, applyMobileFirstRunDefaults } from './util/settingsMigration';
import { debugLogPath, isActiveOwnLog } from './util/logPaths';
import { autoNetworkConcurrency } from './util/platformDefaults';

const MIN_OBSIDIAN_VERSION = '1.13.0';

// How long after a keystroke a file counts as "being edited". Shared by the upload debounce and the
// write-deferral guard and must stay one number: a shorter guard would reopen the window the guard
// exists to close (docs/spec.md §5.7b).
const EDIT_WINDOW_MS = 2000;

export default class ObsidianNextcloudsync extends Plugin {
  settings!: DavSyncSettings;
  syncEngine?: SyncEngine;

  // Guards against double-invocation of the Pull-mirror.
  private mirrorInProgress = false;
  // Shared with SyncEngine; its ignore list marks the plugin's own writes for the watchers.
  localAdapter?: LocalAdapter;
  // Desktop status-bar element (undefined on mobile). Tracked so `initSyncEngine` can remove it on
  // re-init instead of leaking a duplicate item on every re-login.
  private statusBarEl?: HTMLElement;
  // In-flight `initSyncEngine`: concurrent callers (onLayoutReady and an early `runSyncNow`) await
  // it instead of each initializing. Cleared on settle so a later call (re-login) starts fresh.
  private initializingEngine?: Promise<void>;
  // Flushed on unload so a debounced base write is not lost.
  baseStore?: MergeBaseStore;
  // Flushed on unload so a debounced write is not lost.
  cleanSideStore?: import('./data/CleanSideStore').CleanSideStore;
  logger!: FileLogger;
  // Held here, not on the modal (recreated per open), so the selection survives reopens; also
  // hydrated from and saved to settings so it survives a restart.
  private readonly statusFilterState: StatusFilterState = makeDefaultFilterState();
  // Last user edit time per path, to keep sync from writing under the cursor. Not the debounce's
  // pending set: that is cleared when the debounce fires, exactly when the triggered sync begins.
  private readonly lastLocalEdit = new Map<string, number>();

  async onload(): Promise<void> {
    const currentVersion = (this.app as App & { appVersion?: string }).appVersion ?? '';
    if (currentVersion && this.compareVersions(currentVersion, MIN_OBSIDIAN_VERSION) < 0) {
      new Notice(
        `Nextcloud Sync requires Obsidian ${MIN_OBSIDIAN_VERSION} or later. Current: ${currentVersion}`,
        0,
      );
      return;
    }

    await this.loadSettings();

    this.statusFilterState.checked = deserializeFilter(this.settings.statusFilter).checked;

    if (!this.settings.deviceId) {
      this.settings.deviceId = uuidv4();
      await this.saveSettings();
    }

    // The file is named with this device's host token so multiple devices never collide. A failed
    // write surfaces as a Notice (never a thrown error) so "logging on yet no file" is not silent.
    this.logger = new FileLogger(
      this.app.vault.adapter,
      () => this.settings.loggingEnabled,
      () => 'verbose' as const,
      this.manifest.version,
      this.hostToken(),
      () => debugLogPath(this.settings.logsFolder, this.hostToken()),
      (err) => new Notice(`Nextcloud Sync: could not write the log file — ${(err as Error)?.message ?? String(err)}`, 8000),
    );
    void this.logger.log(`plugin loaded (obsidian=${currentVersion})`);
    void this.logSettingsSnapshot();

    this.addSettingTab(new NextcloudSyncSettingTab(this.app, this));

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: async () => {
        await this.runSyncNow();
      },
    });

    // Ribbon entry point for the same manual sync (issue #19). On mobile the ribbon bar is hidden, but
    // Obsidian republishes ribbon actions in the navigation bar's "Open menu".
    registerSyncRibbon(this);

    // Both manual actions are two taps on mobile (no status bar to click); the commands cover the
    // Sync Status dialog and allow a toolbar pin or hotkey. See src/ui/statusEntryPoints.ts.
    registerMirrorRibbon(this);
    registerStatusCommands(this);

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

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      // Also on mobile (long-press menu): the diff is a pure Modal + LCS with no Electron deps.
      if (!(file instanceof TFile)) return;
      if (!this.syncEngine) return;
      menu.addItem(item => item
        .setTitle('Compare with remote')
        .setIcon('git-compare')
        .onClick(() => { new CompareModal(this.app, file.path, this.syncEngine!).open(); }));
    }));

    // Command-palette entry: the reliable entry point on mobile.
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

    // Vault listeners must not be registered in `onload`: `create` fires once per file while the vault
    // initializes and would flood the watcher. onLayoutReady runs after that initial pass.
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.serverUrl && this.settings.username) {
        void this.initSyncEngine();
      }

      // Watch mode: single-file operations; full sync is left to manual Sync Now and the interval.
      // Runs on every platform: on mobile it only fires in the foreground, and whatever it misses is
      // found by the next full sync. "Wi-Fi only" is enforced inside each operation (docs/spec.md §5.7c).
      const guard = (file: TAbstractFile): file is TFile =>
        this.settings.watchOnChangeEnabled && file instanceof TFile;

      // The plugin's own writes (atomic tmp-write -> rename) must not propagate back, or every download
      // becomes a spurious upload/MOVE/DELETE storm. SyncEngine marks them in the LocalAdapter
      // ignore list; tmp paths are always filtered.
      const isOwnSyncEvent = (path: string): boolean =>
        isSyncTmpPath(path) || (this.localAdapter?.shouldIgnore(path) ?? false);

      // Batches paths over the debounce window so each keystroke does not cost a request.
      const pendingUploads = new Set<string>();
      const debouncedUpload = debounce(() => {
        const paths = [...pendingUploads];
        pendingUploads.clear();
        for (const path of paths) {
          void this.syncEngine?.syncSingleFile(path);
        }
      }, EDIT_WINDOW_MS, true);

      this.registerEvent(this.app.vault.on('modify', (file: TAbstractFile) => {
        if (!guard(file) || isOwnSyncEvent(file.path)) return;
        this.lastLocalEdit.set(file.path, Date.now());
        pendingUploads.add(file.path);
        debouncedUpload();
      }));
      // Folders propagate immediately via single-folder ops; files use the debounced upload.
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
        pendingUploads.delete(file.path);
        if (isOwnSyncEvent(file.path)) return; // e.g. atomic write replacing the old copy
        if (file instanceof TFolder) { void this.syncEngine?.deleteSingleFolder(file.path); return; }
        void this.syncEngine?.deleteSingleFile(file.path);
      }));
      this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (!watchOn()) return;
        pendingUploads.delete(oldPath);
        // tmp -> target renames are the tail of the plugin's own atomic writes.
        if (isOwnSyncEvent(oldPath) || isOwnSyncEvent(file.path)) return;
        if (file instanceof TFolder) { void this.syncEngine?.renameSingleFolder(oldPath, file.path); return; }
        void this.syncEngine?.renameSingleFile(oldPath, file.path);
      }));

      // Sync on foreground resume, on every platform (docs/spec.md §5.8). The cooldown inside the
      // handler keeps a burst of app switches from becoming a burst of syncs.
      this.register(onAppResume(makeResumeSyncHandler({
        getEngine: () => this.syncEngine,
        getLastSyncTime: () => this.syncEngine?.getLastSyncTime() ?? 0,
        log: (message) => { void this.logger.log(message); },
        // Startup sync off means no automatic sync at all (issue #49); read at call time.
        startupSyncEnabled: () => this.settings.startupSyncDelaySeconds > 0,
      })));
    });
  }

  async runSyncNow(): Promise<void> {
    void this.logger.log('sync: "Sync now" clicked');
    // Credentials may have been entered after startup (first-time setup).
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

  // Desktop-only: on mobile the OS suspends background timers, so the timer is always stopped there.
  applyAutoSyncInterval(): void {
    if (!this.syncEngine) return;
    if (!Platform.isMobile && this.settings.syncIntervalMinutes > 0) {
      this.syncEngine.startAutoSync(this.settings.syncIntervalMinutes);
    } else {
      this.syncEngine.stopAutoSync();
    }
  }

  // The editor may be ahead of what is on disk, so a remote->local write would land under the cursor.
  // Prunes as it reads, so the map stays the size of what is actually being edited.
  isBeingEdited(path: string): boolean {
    const at = this.lastLocalEdit.get(path);
    if (at === undefined) return false;
    if (Date.now() - at < EDIT_WINDOW_MS) return true;
    this.lastLocalEdit.delete(path);
    return false;
  }

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
      // Force-resolve one conflicted file. Failures surface as a Notice and leave it conflicted; a tie
      // (equal mtime/size) is a silent no-op.
      async (path: string, choice: ForceChoice) => {
        try {
          await applyForceResolution(this.syncEngine!, path, choice);
        } catch (err) {
          new Notice(`Could not resolve "${path}": ${(err as Error).message}`);
        }
      },
      // Bulk force-resolve. The host owns the confirmation and the aggregate Notice;
      // applyBulkForceResolution never rejects (per-file failures are tallied).
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
      // Bulk-resolve the paths the dir mass-delete breaker skipped; resolveAllSkippedDirs never
      // rejects (per-path failures are tallied and left for the next attempt).
      async (choice: 'remote' | 'local') => {
        const label = choice === 'remote' ? 'Use remote' : 'Use local';
        const ok = await confirmModal(this.app, {
          title: 'Resolve skipped directories',
          message: `Apply "${label}" to every directory the mass-delete breaker skipped? `
            + 'This creates/deletes directories and cannot be undone.',
          cta: 'Apply to all',
          cancel: 'Cancel',
          destructive: true,
        });
        if (!ok) return;
        const { resolved, failed } = await this.syncEngine!.resolveAllSkippedDirs(choice);
        new Notice(`Resolved ${resolved} skipped directories` + (failed ? `; ${failed} failed` : ''));
      },
      // Second entry point to Mirror from remote; runRemoteMirror owns the confirmation, Notice and guard.
      () => this.runRemoteMirror(),
    ).open();
  }

  // Works without a configured engine: then the on-disk state file is reset directly. With an engine,
  // any in-flight sync is aborted first. No vault or remote files are deleted.
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

  // Overwrites the local vault to match the remote, deleting extras via the Obsidian trash setting.
  // Bypasses the mass-delete breaker but aborts if the remote listing cannot be obtained.
  async runRemoteMirror(): Promise<void> {
    const engine = this.syncEngine;
    if (!engine) {
      new Notice('Sign in to Nextcloud before mirroring from the remote.', 6000);
      return;
    }
    if (this.mirrorInProgress) return;
    this.mirrorInProgress = true;
    try {
      // The dialog opens immediately and plans/confirms/applies inside it, so the network-heavy planning
      // shows live phase labels. Resolves at the terminal state, or when an in-flight apply finishes
      // if dismissed mid-apply.
      await openMirrorFromRemoteModal(this.app, {
        plan: async (onPhase) => {
          onPhase('Stopping the current sync…');
          await engine.abortAndWait();
          return engine.planRemoteMirror(onPhase);
        },
        apply: (plan, onProgress) => engine.applyRemoteMirror(plan, onProgress),
      });
    } catch (err) {
      new Notice(`❌ Mirror from remote failed: ${(err as Error).message}`, 8000);
    } finally {
      this.mirrorInProgress = false;
    }
  }

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

  private logPlatform(): LogPlatform {
    return Platform.isIosApp ? 'ios' : Platform.isAndroidApp ? 'android' : 'desktop';
  }

  private hostToken(): string {
    return hostToken(this.settings.deviceName, this.logPlatform(), this.settings.deviceId);
  }

  logFilePath(): string {
    return debugLogPath(this.settings.logsFolder, this.hostToken());
  }

  // Logged at `error` level so it appears regardless of verbosity. The app password is never in
  // settings: `passwordSecretId` is only a SecretStorage key.
  async logSettingsSnapshot(): Promise<void> {
    const snapshot = JSON.stringify(this.settings);
    await this.logger.log(`settings snapshot: ${snapshot}`, 'error');
  }

  onunload(): void {
    this.teardownSyncEngine();
  }

  // Without this on re-login/account switch, the old engine's auto-sync timer keeps running, its
  // status-bar item is never removed, and two engines read/write the same StateDB concurrently.
  private teardownSyncEngine(): void {
    this.syncEngine?.stopAutoSync();
    // Order matters: signal an in-flight sync to stop pulling new work, then flush pending debounced
    // saves so a coalesced watch-mode update is not lost.
    this.syncEngine?.requestStop();
    void this.syncEngine?.flushState();
    void this.baseStore?.flush();
    void this.cleanSideStore?.flush();
    this.localAdapter?.dispose();
    this.statusBarEl?.remove();
    this.statusBarEl = undefined;
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData() ?? {}) as Partial<DavSyncSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

    // Migrations below must run before pruneObsoleteSettings drops the keys they read.
    this.settings.configSync = { ...DEFAULT_SETTINGS.configSync };
    migrateConfigSyncCategories(saved, this.settings);
    migrateBookmarksToConfigSync(saved, this.settings);
    if (Platform.isMobile) {
      applyMobileFirstRunDefaults(saved, this.settings);
    }
    if (saved.networkConcurrency === undefined) {
      this.settings.networkConcurrency = autoNetworkConcurrency();
    }

    migrateStartupToggleToDelay(saved, this.settings);

    migrateConflictSettingsToStrategies(saved, this.settings);

    migrateFrontmatterScalarPolicyToStrategy(saved, this.settings);

    migrateMarkdownAutoMergeType(this.settings);

    // Device name and log folder are no longer user-settable: force both back to their sentinels.
    const debugReset = resetDebugIdentityFields(saved, this.settings);

    // Persist the cleaned settings so data.json no longer carries obsolete keys or a stale Debug identity.
    const removed = pruneObsoleteSettings(this.settings as unknown as Record<string, unknown>);
    if (removed.length > 0 || debugReset) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // Re-entrant-safe: a call arriving during an in-flight init awaits that same promise. A fresh init
  // first tears down any existing engine (see teardownSyncEngine).
  async initSyncEngine(): Promise<void> {
    if (this.initializingEngine) return this.initializingEngine;
    const promise = this.doInitSyncEngine().finally(() => {
      this.initializingEngine = undefined;
    });
    this.initializingEngine = promise;
    return promise;
  }

  private async doInitSyncEngine(): Promise<void> {
    this.teardownSyncEngine();

    const { StateDB } = await import('./data/StateDB');
    const { MergeBaseStore } = await import('./data/MergeBaseStore');
    const { SyncHistoryStore } = await import('./data/SyncHistoryStore');
    const { StatusBarItem } = await import('./ui/StatusBarItem');
    const { NoticeStatusBar } = await import('./ui/NoticeStatusBar');
    const { WebDAVFactory } = await import('./network/WebDAVFactory');
    const { loadAppPassword } = await import('./settings/SettingTab');

    const localAdapter = new LocalAdapter(this.app.vault.adapter, this.app.vault, this.app.workspace);
    this.localAdapter = localAdapter;
    const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const stateDB = new StateDB(this.app.vault.adapter, pluginDir, this.settings.deviceId);
    await stateDB.load();
    // Last-synced bodies (merge base) for 3-way conflict merges; a separate file.
    const baseStore = new MergeBaseStore(this.app.vault.adapter, pluginDir, this.settings.deviceId);
    await baseStore.load();
    this.baseStore = baseStore;
    // Clean sides of marker-conflicted notes, so force-resolution recovers a real clean version
    // rather than the marker content; a separate per-device file.
    const { CleanSideStore } = await import('./data/CleanSideStore');
    const cleanSideStore = new CleanSideStore(this.app.vault.adapter, pluginDir, this.settings.deviceId);
    await cleanSideStore.load();
    this.cleanSideStore = cleanSideStore;
    const historyStore = new SyncHistoryStore(this.app.vault.adapter, pluginDir);
    await historyStore.load();

    // Mobile has no status bar (addStatusBarItem is unavailable), so NoticeStatusBar shows a reused
    // Notice toast. The raw element is kept on `this.statusBarEl` so a re-init can remove it.
    let statusBarEl: HTMLElement | undefined;
    const statusBar = Platform.isMobile
      ? new NoticeStatusBar()
      : new StatusBarItem(statusBarEl = this.addStatusBarItem(), () => this.openSyncStatus());
    this.statusBarEl = statusBarEl;
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
      // Evaluated live from the same settings and host token as the logger, so it follows the logging
      // toggle (docs/spec.md §9.1).
      isBeingEdited: (path) => this.isBeingEdited(path),
      isActiveLogFile: (path) => isActiveOwnLog(path, {
        logsFolder: this.settings.logsFolder,
        host: this.hostToken(),
        loggingEnabled: this.settings.loggingEnabled,
      }),
      logger: this.logger,
      onFeatures: (features) => {
        // Lets the settings screen recommend an upgrade; persisted only on change.
        if (features.version && features.version !== this.settings.lastKnownServerVersion) {
          this.settings.lastKnownServerVersion = features.version;
          void this.saveSettings();
        }
      },
    });

    this.applyAutoSyncInterval();

    // 0 = no startup sync; 1-10 = seconds to wait.
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
