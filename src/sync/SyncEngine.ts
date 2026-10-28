import { App, Notice, Platform, apiVersion } from 'obsidian';
import { CreationTimeAligner } from './ctime/CreationTimeAligner';
import { uploadCreationTimeMs } from '../util/creationTime';
import {
  DavSyncSettings,
  FileState,
  FileVersion,
  NextcloudFeatures,
  RemoteFileInfo,
  RemoteDirInfo,
  SyncSessionSummary,
  SyncFileOp,
  SyncHistoryDetail,
  SyncHistoryEntry,
  SyncTokenExpiredError,
  NetworkError,
  PreconditionFailedError,
  RemoteCompareResult,
  RemoteRootMissingError,
  SyncErrorDetail,
} from '../types';
import { LocalAdapter } from '../data/LocalAdapter';
import { StateDB } from '../data/StateDB';
import type { MergeBaseStore } from '../data/MergeBaseStore';
import type { CleanSideStore } from '../data/CleanSideStore';
import type { CleanSideMetrics } from '../ui/compareResolution';
import {
  parentDir as parentDirOf,
  isTextEligible,
  isLocallyUnchanged as isLocallyUnchangedPure,
  isSystemExcluded as isSystemExcludedPure,
} from './policy';
import { LocalScanner } from './scan/LocalScanner';
import { RemoteListingSource } from './scan/RemoteListingSource';
import { SyncJournal } from './session/SyncJournal';
import { MergeBaseRecorder } from './session/MergeBaseRecorder';
import { withLocalSignature } from '../data/localSignature';
import { TransferService } from './transfer/TransferService';
import { VersionService } from './versions/VersionService';
import { remoteIdOf } from './remoteIdentity';
import { checksumProvesIdentical, convergedState } from './identity/contentIdentity';
import { DeletionService } from './deletion/DeletionService';
import { ResolutionService } from './resolution/ResolutionService';
import { ConflictApplier } from './conflict/ConflictApplier';
import { DirectoryReconciler } from './directory/DirectoryReconciler';
import { WatchOperations } from './watch/WatchOperations';
import { MirrorService } from './mirror/MirrorService';
import { SyncHistoryStore } from '../data/SyncHistoryStore';
import { IStatusBar } from '../ui/StatusBarItem';
import { WebDAVFactory } from '../network/WebDAVFactory';
import { IWebDAVClient } from '../network/IWebDAVClient';
import { RenameTracker } from './RenameTracker';
import { ConfigSyncResolver } from './ConfigSyncResolver';
import { PluginSyncCoordinator } from './plugins/PluginSyncCoordinator';
import { partitionPluginManifestsLast, pluginDirPath } from './plugins/pluginPaths';
import { fileSameContent } from './plugins/bundleDirection';
import { collectCommunityPluginCandidates, type PluginCandidateList } from './plugins/candidates';
import { computeSyncScopeFingerprint } from './plugins/scopeFingerprint';
import { dropSubtreeTracking } from './deletion/subtreeTracking';
import { sha256 } from '../util/hash';
import { FIXED, chunkThresholdMB } from '../util/fixedSyncConfig';
import { FileLogger } from '../util/FileLogger';
import {
  isCellularBlocked, MAX_HASH_SIZE,
  MAX_INFLIGHT_BYTES_DESKTOP, MAX_INFLIGHT_BYTES_MOBILE, effectiveMassDeleteLimit,
} from '../util/limits';
import { createLimiter, ByteSemaphore } from '../util/ConcurrencyLimiter';
import { MirrorPlan, MirrorResult } from './mirrorPlan';
import { IUploadStrategy } from './upload/IUploadStrategy';
import { SimpleUploadStrategy } from './upload/SimpleUploadStrategy';
import { ChunkedUploadStrategy } from './upload/ChunkedUploadStrategy';

interface InitialSyncPlan {
  uploads: string[];
  downloads: string[];
  conflicts: string[];
  deletes: string[];
  unchanged: string[];
}

interface SyncEngineOptions {
  app: App;
  settings: DavSyncSettings;
  localAdapter: LocalAdapter;
  stateDB: StateDB;
  baseStore?: MergeBaseStore;
  // Clean sides of marker-conflicted notes, so force-resolution restores real content instead of markers (docs/spec.md §6.4).
  cleanSideStore?: CleanSideStore;
  statusBar: IStatusBar;
  historyStore?: SyncHistoryStore;
  webdavFactory: WebDAVFactory;
  pluginDir: string;
  configDir: string;
  // Host-owned predicate for this device's active log files, which must stay out of sync (docs/spec.md §9.1).
  isActiveLogFile?: (path: string) => boolean;
  // True while the user is typing into `path`. Consulted before any REMOTE -> LOCAL write, because writing under the cursor
  // discards edits; uploads are unaffected (docs/spec.md §5.7b).
  isBeingEdited?: (path: string) => boolean;
  logger?: FileLogger;
  // Lets the host persist the server version without coupling the engine to settings persistence.
  onFeatures?: (features: NextcloudFeatures) => void;
  // Plugin ids whose code was written and that still need an Obsidian restart. Shared with the host so it
  // outlives engine re-creation; a fresh set when omitted.
  pluginsAwaitingRestart?: Set<string>;
}

export class SyncEngine {
  private autoSyncHandle: number | null = null;
  private lastSummary: SyncSessionSummary | null = null;
  private retryQueue: string[] = [];
  private client: IWebDAVClient | null = null;
  private features: NextcloudFeatures | null = null;
  private uploadStrategy: IUploadStrategy | null = null;
  // Balking flag: a second syncManual() call returns immediately.
  private running = false;
  // Set by requestStop(): workers stop pulling new work, while the run's finally block still saves state.
  private cancelled = false;
  // Lets abortAndWait() await a running sync's wind-down (including its final state save) before a reset.
  private currentRun: Promise<void> | null = null;
  private readonly journal: SyncJournal;

  private readonly mergeBase: MergeBaseRecorder;
  // One aligner shared by transfer, resolution and conflicts (docs/spec.md §9.7).
  private readonly creationTime: CreationTimeAligner;
  private readonly transfer: TransferService;

  private readonly versions: VersionService;

  private readonly deletion: DeletionService;

  private readonly resolution: ResolutionService;

  private readonly conflicts: ConflictApplier;

  private readonly directories: DirectoryReconciler;

  private readonly watch: WatchOperations;

  private readonly mirror: MirrorService;
  private syncProgress = { processed: 0, total: 0 };
  // Monotonic; read as a delta around one watch operation to learn whether it touched a conflict.
  // Summary counters cannot say: conflicts settled by a deterministic strategy count as plain uploads/downloads.
  private conflictEncounters = 0;
  // Local deletions the outbound breaker held back this session; they stay tracked and are neither deleted on the
  // server nor re-downloaded (docs/spec.md §8).
  private outboundDeletionsHeld: ReadonlySet<string> = new Set();
  private renameTracker: RenameTracker | null = null;
  // Single source of truth for which config-folder paths sync (shared by isSystemExcluded, the remote filter
  // and the remote-deletion scope guard).
  private readonly configSync: ConfigSyncResolver;

  private readonly pluginsAwaitingRestart: Set<string>;
  // This plugin's own folder name, derived from `pluginDir` so there is a single source for it.
  private readonly ownPluginId: string;
  private readonly plugins: PluginSyncCoordinator;

  private readonly localScanner: LocalScanner;

  // Accessors, not values: capabilities arrive later (ensureClient) and settings can change.
  private readonly remoteListing: RemoteListingSource;

  constructor(private readonly opts: SyncEngineOptions) {
    this.pluginsAwaitingRestart = opts.pluginsAwaitingRestart ?? new Set();
    // Tolerates a bare engine built without a plugin folder (some suites construct one with only the fields they use).
    const pluginDir: string = opts.pluginDir ?? '';
    this.ownPluginId = pluginDir.slice(pluginDir.lastIndexOf('/') + 1);
    this.plugins = new PluginSyncCoordinator({
      configDir: opts.configDir,
      ownId: this.ownPluginId,
      settings: opts.settings,
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      awaitingRestart: this.pluginsAwaitingRestart,
      obsidianVersion: apiVersion,
      isMobile: () => Platform.isMobile,
      now: () => Date.now(),
      notify: (m, t) => { new Notice(m, t); },
      logger: opts.logger,
    });
    this.configSync = new ConfigSyncResolver({
      configDir: opts.configDir,
      settings: opts.settings,
      pluginDir: opts.pluginDir,
      localAdapter: opts.localAdapter,
      pluginGate: this.plugins,
    });
    this.localScanner = new LocalScanner({
      localAdapter: opts.localAdapter,
      isSystemExcluded: (p) => this.isSystemExcluded(p),
      isUnderConfigDir: (p) => this.configSync.isUnderConfigDir(p),
      enumerateIncludedConfigPaths: () => this.configSync.enumerateIncludedPaths(),
    });
    this.journal = new SyncJournal({ historyStore: opts.historyStore, logger: opts.logger });
    this.mergeBase = new MergeBaseRecorder({
      baseStore: opts.baseStore,
      autoMergeFileTypes: () => this.opts.settings.autoMergeFileTypes,
      isPluginPath: (p) => this.plugins.isPluginPath(p),
    });
    this.creationTime = new CreationTimeAligner({
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      isBeingEdited: (p) => this.opts.isBeingEdited?.(p) ?? false,
      logger: opts.logger,
    });
    this.transfer = new TransferService({
      creationTime: this.creationTime,
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      localWrite: this.plugins,
      journal: this.journal,
      mergeBase: this.mergeBase,
      maxFileSizeMB: () => this.opts.settings.maxFileSizeMB,
      hasFilesLocking: () => this.features?.hasFilesLocking === true,
      // Keyed on the connected client, not the server's self-report: only NextcloudClient fills in `checksum`.
      clientReportsChecksums: () => this.features?.isNextcloud === true,
      queueRetry: (p) => { this.retryQueue.push(p); },
      logger: opts.logger,
    });
    this.versions = new VersionService({ localAdapter: opts.localAdapter, stateDB: opts.stateDB });
    this.deletion = new DeletionService({
      app: opts.app,
      stateDB: opts.stateDB,
      journal: this.journal,
      mergeBase: this.mergeBase,
      transfer: this.transfer,
      isSystemExcluded: (p) => this.isSystemExcluded(p),
      dropCleanSnapshot: (p) => this.resolution.dropCleanSnapshot(p),
      markOwnEvent: (p) => this.opts.localAdapter.ignore(p),
      logger: opts.logger,
    });
    this.resolution = new ResolutionService({
      creationTime: this.creationTime,
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      historyStore: opts.historyStore,
      cleanSideStore: opts.cleanSideStore,
      localWrite: this.plugins,
      journal: this.journal,
      mergeBase: this.mergeBase,
      transfer: this.transfer,
      autoMergeFileTypes: () => this.opts.settings.autoMergeFileTypes,
      maxFileSizeMB: () => this.opts.settings.maxFileSizeMB,
      logger: opts.logger,
    });
    this.conflicts = new ConflictApplier({
      creationTime: this.creationTime,
      app: opts.app,
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      baseStore: opts.baseStore,
      journal: this.journal,
      mergeBase: this.mergeBase,
      transfer: this.transfer,
      resolution: this.resolution,
      localWrite: this.plugins,
      pluginConflictRule: (p) => this.plugins.conflictRuleFor(p),
      resolverConfig: () => ({
        autoMergeFileTypes: this.opts.settings.autoMergeFileTypes,
        autoMergeFileStrategy: this.opts.settings.autoMergeFileStrategy,
        otherFileStrategy: this.opts.settings.otherFileStrategy,
        deviceId: this.opts.settings.deviceId,
        frontmatterStrategy: this.opts.settings.frontmatterStrategy,
        conflictStrategy: this.opts.settings.conflictStrategy,
      }),
      maxFileSizeMB: () => this.opts.settings.maxFileSizeMB,
      queueRetry: (p) => { this.retryQueue.push(p); },
      onConflictEncountered: () => { this.conflictEncounters++; },
      logger: opts.logger,
    });
    this.directories = new DirectoryReconciler({
      app: opts.app,
      stateDB: opts.stateDB,
      journal: this.journal,
      transfer: this.transfer,
      mergeBase: this.mergeBase,
      dropCleanSnapshot: (p) => this.resolution.dropCleanSnapshot(p),
      markOwnEvent: (p) => this.opts.localAdapter.ignore(p),
      isSystemExcluded: (p) => this.isSystemExcluded(p),
      massDeleteLimit: () => this.opts.settings.massDeleteLimit,
      isCancelled: () => this.cancelled,
      logger: opts.logger,
    });
    this.watch = new WatchOperations({
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      historyStore: opts.historyStore,
      statusBar: opts.statusBar,
      journal: this.journal,
      mergeBase: this.mergeBase,
      transfer: this.transfer,
      deletion: this.deletion,
      resolution: this.resolution,
      isSystemExcluded: (p) => this.isSystemExcluded(p),
      isPluginPath: (p) => this.plugins.isPluginPath(p),
      connect: () => this.connection(),
      renameTracker: () => this.getOrCreateRenameTracker(),
      isBlockedByWifiOnly: () => this.isBlockedByWifiOnly(),
      isSyncRunning: () => this.running,
      processFile: (remote, summary) => this.processFileWithRetry(remote, summary),
      queueRetry: (p) => { this.retryQueue.push(p); },
      conflictEncounters: () => this.conflictEncounters,
      massDeleteLimit: () => this.effectiveMassDeleteLimit(opts.stateDB.getAllFiles().length),
      logger: opts.logger,
    });
    this.remoteListing = new RemoteListingSource({
      stateDB: opts.stateDB,
      isNextcloud: () => this.features?.isNextcloud === true,
      networkConcurrency: () => Math.max(1, this.opts.settings.networkConcurrency),
      logger: opts.logger,
    });
    this.mirror = new MirrorService({
      app: opts.app,
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      statusBar: opts.statusBar,
      journal: this.journal,
      mergeBase: this.mergeBase,
      plugins: this.plugins,
      transfer: this.transfer,
      deletion: this.deletion,
      localScanner: this.localScanner,
      remoteListing: this.remoteListing,
      progress: {
        begin: (total) => { this.syncProgress = { processed: 0, total }; },
        tick: () => { this.tickProgress(); return this.syncProgress.processed; },
      },
      enumerateIncludedConfigPaths: () => this.configSync.enumerateIncludedPaths(),
      isSystemExcluded: (p) => this.isSystemExcluded(p),
      persist: async () => {
        await opts.stateDB.save();
        await opts.baseStore?.flush();
        await opts.historyStore?.save();
      },
      connect: async () => (await this.ensureClient()).client,
      logger: opts.logger,
    });
  }

  private getOrCreateRenameTracker(): RenameTracker {
    if (!this.renameTracker) {
      this.renameTracker = new RenameTracker(this.opts.stateDB, this.client!);
    }
    return this.renameTracker;
  }

  /** Lists community plugins on this device and (when reachable) the server for the picker. */
  async listCommunityPluginCandidates(): Promise<PluginCandidateList> {
    let client: IWebDAVClient | null;
    try {
      await this.ensureClient();
      client = this.client;
    } catch (err) {
      void this.opts.logger?.log(`plugins: server unavailable for candidate listing — ${(err as Error).message}`);
      client = null;
    }
    return collectCommunityPluginCandidates({
      localAdapter: this.opts.localAdapter,
      client,
      configDir: this.opts.configDir,
      ownId: this.ownPluginId,
      isMobile: Platform.isMobile,
      logger: this.opts.logger,
    });
  }

  private async ensureClient(): Promise<{ client: IWebDAVClient; features: NextcloudFeatures }> {
    if (!this.client || !this.features) {
      const { client, features } = await this.opts.webdavFactory.createClient();
      this.client = client;
      this.features = features;
      // Chunked upload needs the account-only uploads namespace, which a public link share lacks (docs/spec.md §3);
      // the threshold is platform-derived (docs/spec.md §15.1.2).
      const uploadConfig = { maxFileSizeMB: this.opts.settings.maxFileSizeMB, uploadChunkThresholdMB: chunkThresholdMB(Platform.isMobile) };
      this.uploadStrategy = (FIXED.chunkedUploadEnabled && features.isNextcloud && features.hasAccountDav)
        ? new ChunkedUploadStrategy(uploadConfig)
        : new SimpleUploadStrategy(uploadConfig);
      this.opts.onFeatures?.(features);
    }
    return { client: this.client, features: this.features };
  }

  // navigator.connection.type exists only on Chromium/Android: desktop leaves it undefined (never blocks)
  // and iOS has no navigator.connection (the setting is ignored there).
  private isBlockedByWifiOnly(): boolean {
    const conn = (navigator as Navigator & { connection?: { type?: string } }).connection;
    return isCellularBlocked(this.opts.settings.syncOnWifiOnly, Platform.isIosApp, conn?.type);
  }

  async syncManual(opts: { manual?: boolean } = {}): Promise<void> {
    // Mobile has no status bar; NoticeStatusBar surfaces state there. The early returns below need explicit
    // notices because they exit before any toast exists.
    void this.opts.logger?.log(`sync: start (manual=${opts.manual === true})`);
    if (this.running) {
      void this.opts.logger?.log('sync: skipped — already running');
      if (Platform.isMobile) new Notice('⏳ A sync is already in progress.');
      return;
    }
    if (this.isBlockedByWifiOnly()) { // "Wi-Fi only" enabled and on cellular
      void this.opts.logger?.log('sync: skipped — Wi-Fi-only and on cellular');
      if (Platform.isMobile) new Notice('Sync skipped — you are on cellular and Wi-Fi only sync is on.', 6000);
      return;
    }
    // Set the balking flag synchronously (before any await) so a concurrent call still balks.
    this.running = true;
    this.cancelled = false;
    const run = this.runSyncSession(opts.manual === true);
    this.currentRun = run;
    try {
      await run;
    } finally {
      this.currentRun = null;
      // The run is over, so deferred watch edits can be evaluated. Best-effort: a failure must not propagate out of "Sync now".
      try {
        await this.drainWatchPending();
      } catch (err) {
        console.warn('[SyncEngine] Deferred watch-mode sync failed:', err);
      }
    }
  }

  private async runSyncSession(manual: boolean): Promise<void> {
    // Created before the try so catch/finally can reference them even if the first step fails.
    const summary = this.initSummary();
    this.journal.beginRun(summary.startedAt);

    const cancelled = false;
    try {
      // Connect INSIDE the try: if ensureClient() threw or hung outside it, the finally that clears `running` would be
      // skipped and the engine would balk forever as "already running".
      void this.opts.logger?.log('sync: connecting (ensureClient)');
      await this.ensureClient();
      this.plugins.begin();
      this.invalidateRootEtagOnScopeChange();
      this.syncProgress = { processed: 0, total: 0 };
      this.opts.statusBar.setStatus('syncing', { automatic: !manual });

      const isFirstSync = !this.opts.stateDB.getSyncToken() && this.opts.stateDB.getAllFiles().length === 0;

      if (isFirstSync) {
        await this.initialSync(summary);
      } else {
        await this.incrementalSync(summary);
      }
    } catch (err) {
      console.error('[SyncEngine] Sync failed:', err);
      void this.opts.logger?.log(`sync: FAILED — ${(err as Error).message}`, 'error');
      new Notice(`❌ Sync failed: ${(err as Error).message}`, 6000);
      this.recordError(summary, '', err);
    } finally {
      // Clear `running` FIRST: the teardown below can throw (state/history save), which would otherwise leave the
      // engine permanently "running".
      this.running = false;
      this.journal.endRun();

      void this.opts.logger?.log(
        `sync: done up=${summary.uploadedCount} down=${summary.downloadedCount} ` +
        `del=${summary.deletedCount} merged=${summary.mergedCount} conflicted=${summary.conflictedCount} err=${summary.errorCount} cancelled=${cancelled}`,
      );
      this.logSessionErrors(summary);
      summary.completedAt = Date.now();
      this.lastSummary = summary;
      this.opts.stateDB.setLastSyncTime(Date.now());
      this.finishPluginSession(summary);
      await this.persistAfterSession();
      const conflictCount = this.opts.stateDB.countConflicted();
      this.opts.statusBar.setSyncComplete(
        summary.uploadedCount, summary.downloadedCount,
        conflictCount, summary.errorCount,
      );
      // Result display is owned by the status bar surface (StatusBarItem / NoticeStatusBar) via setSyncComplete.
    }
  }

  // A changed sync scope (or a state saved before the fingerprint existed) makes the stored root ETag
  // meaningless: files that were out of scope never entered the tracked listing a short-circuit rebuilds
  // (docs/spec.md §8a.5).
  private invalidateRootEtagOnScopeChange(): void {
    const { syncConfigFolder, configSync, excludedFolders, syncedCommunityPlugins } = this.opts.settings;
    const fingerprint = computeSyncScopeFingerprint({ syncConfigFolder, configSync, excludedFolders, syncedCommunityPlugins });
    if (this.opts.stateDB.getSyncScopeFingerprint() === fingerprint) return;
    this.opts.stateDB.setRemoteRootEtag(null);
    this.opts.stateDB.setSyncScopeFingerprint(fingerprint);
  }

  // Best-effort: a plugin-session failure must not escape the finally and mask the original error.
  private finishPluginSession(summary: SyncSessionSummary): void {
    try {
      const out = this.plugins.finish();
      summary.pluginsNeedingRestart = out.pluginsNeedingRestart;
      if (out.invalidateRootEtag) this.opts.stateDB.setRemoteRootEtag(null);
    } catch (e) {
      void this.opts.logger?.log(`sync: plugin session finish failed — ${(e as Error).message}`, 'error');
    }
  }

  // Best-effort: a save failure must not escape the finally and mask the original error.
  private async persistAfterSession(): Promise<void> {
    try {
      await this.opts.stateDB.save();
      await this.opts.historyStore?.save();
    } catch (persistErr) {
      console.error('[SyncEngine] Post-sync persistence failed:', persistErr);
      void this.opts.logger?.log(`sync: post-sync save failed — ${(persistErr as Error).message}`, 'error');
    }
  }

  // Selects the listed plugins for this session, then forgets tracking of plugins that must not be treated as
  // removed from the server (docs/spec.md §7).
  private async preparePluginSession(client: IWebDAVClient, remoteFiles: readonly RemoteFileInfo[]): Promise<void> {
    await this.plugins.prepare(client, remoteFiles);
    this.dropStalePluginTracking();
  }

  private dropStalePluginTracking(): void {
    for (const id of this.plugins.staleTrackedIds()) {
      dropSubtreeTracking({
        stateDB: this.opts.stateDB,
        mergeBase: this.mergeBase,
        dropCleanSnapshot: (p) => this.resolution.dropCleanSnapshot(p),
      }, pluginDirPath(id, this.opts.configDir));
    }
  }

  private logSessionErrors(summary: SyncSessionSummary): void {
    this.journal.logSessionErrors(summary);
  }



  syncSingleFile(path: string): Promise<void> {
    return this.watch.syncSingleFile(path);
  }

  private drainWatchPending(): Promise<void> {
    return this.watch.drainPending();
  }

  deleteSingleFile(path: string): Promise<void> {
    return this.watch.deleteSingleFile(path);
  }

  renameSingleFile(oldPath: string, newPath: string): Promise<void> {
    return this.watch.renameSingleFile(oldPath, newPath);
  }

  createSingleFolder(path: string): Promise<void> {
    return this.watch.createSingleFolder(path);
  }

  deleteSingleFolder(path: string): Promise<void> {
    return this.watch.deleteSingleFolder(path);
  }

  renameSingleFolder(oldPath: string, newPath: string): Promise<void> {
    return this.watch.renameSingleFolder(oldPath, newPath);
  }

  startAutoSync(intervalMinutes: number): void {
    this.stopAutoSync();
    const ms = intervalMinutes * 60 * 1000;
    this.autoSyncHandle = window.setInterval(() => {
      void this.syncManual();
    }, ms);
  }

  stopAutoSync(): void {
    if (this.autoSyncHandle !== null) {
      window.clearInterval(this.autoSyncHandle);
      this.autoSyncHandle = null;
    }
  }

  async flushState(): Promise<void> {
    await this.opts.stateDB.flush();
    await this.opts.baseStore?.flush();
    await this.opts.cleanSideStore?.flush();
  }

  // massDeleteLimit: -1 = automatic dynamic limit, 0 = unlimited (breaker off), N > 0 = fixed limit (docs/spec.md §8).
  private effectiveMassDeleteLimit(tracked: number): number {
    return effectiveMassDeleteLimit(this.opts.settings.massDeleteLimit, tracked);
  }

  private recordMergeBase(path: string, body: ArrayBuffer): void {
    this.mergeBase.recordBytes(path, body);
  }

  private dropMergeBase(path: string): void {
    this.mergeBase.drop(path);
  }

  private captureCleanSides(
    path: string, local: string, remote: string,
    localMtime: number, localSize: number, remoteInfo: RemoteFileInfo,
  ): void {
    this.resolution.captureCleanSides(path, local, remote, localMtime, localSize, remoteInfo);
  }

  private dropCleanSnapshot(path: string): void {
    this.resolution.dropCleanSnapshot(path);
  }

  private sweepResolvedSnapshots(): void {
    this.resolution.sweepResolvedSnapshots();
  }

  cleanSideMetrics(path: string): CleanSideMetrics | null {
    return this.resolution.cleanSideMetrics(path);
  }

  async applyCleanRemote(path: string): Promise<void> {
    return this.resolution.applyCleanRemote(await this.connection(), path);
  }

  async applyCleanLocal(path: string): Promise<void> {
    return this.resolution.applyCleanLocal(await this.connection(), path);
  }

  // "remote" makes local match remote, "local" makes remote match local (directory create/delete).
  // Throws on failure without touching StateDB (docs/spec.md §8).
  async resolveSkippedDir(
    path: string,
    category: 'deleteRemote' | 'trashLocal',
    choice: 'remote' | 'local',
  ): Promise<void> {
    const { client } = await this.ensureClient();
    return this.directories.resolveSkippedDir(client, path, category, choice);
  }

  // Mutates lastSummary.errors in place, so the next getStatusReport() reflects the outcome. Refuses during a full sync:
  // reconcileDirectories writes the same StateDB directory rows, risking a mkdir-then-trash flicker on one path.
  async resolveAllSkippedDirs(choice: 'remote' | 'local'): Promise<{ resolved: number; failed: number }> {
    if (this.running) throw new Error('Cannot resolve skipped directories — sync in progress');
    const { client } = await this.ensureClient();
    return this.directories.resolveAllSkippedDirs(client, this.lastSummary, choice);
  }


  // Phase 1 of termination: signal workers to stop pulling work; the run's finally block still persists state.
  requestStop(): void {
    this.cancelled = true;
  }

  // Waits for the run's final state save so a following reset cannot interleave with it. Never throws.
  async abortAndWait(): Promise<void> {
    this.requestStop();
    const run = this.currentRun;
    if (run) {
      try { await run; } catch { /* runSyncSession swallows its own errors */ }
    }
  }

  // Resets only the tracking index; no vault or remote file is touched, so the next sync runs as a first sync.
  async resetIndex(): Promise<void> {
    await this.abortAndWait();
    await this.opts.stateDB.reset();
  }

  // Read-only. The listing is a real PROPFIND (no root-ETag short-circuit); on failure the plan is ok:false so nothing is
  // deleted. The mass-delete limit is deliberately not consulted: the user declared the remote authoritative (docs/spec.md §14).
  planRemoteMirror(onPhase?: (label: string) => void): Promise<MirrorPlan> {
    return this.mirror.planRemoteMirror(onPhase);
  }

  // Uses the already-resolved client: apply always follows a plan, and planRemoteMirror is what connects.
  applyRemoteMirror(
    plan: MirrorPlan, onProgress?: (done: number, total: number) => void,
  ): Promise<MirrorResult> {
    return this.mirror.applyRemoteMirror(this.client!, plan, onProgress);
  }

  getLastSessionSummary(): SyncSessionSummary | null {
    return this.lastSummary;
  }

  // Persisted, so it survives restarts and is stamped by every sync; the resume trigger uses it as its cooldown
  // baseline (docs/spec.md §5.8).
  getLastSyncTime(): number {
    return this.opts.stateDB.getLastSyncTime();
  }

  getStatusReport(): {
    summary: SyncSessionSummary | null;
    conflictedFiles: string[];
    retryFiles: string[];
    history: SyncHistoryEntry[];
  } {
    const conflictedFiles = this.opts.stateDB.getAllFiles()
      .filter(f => f.isConflicted)
      .map(f => f.path);
    return {
      summary: this.lastSummary,
      conflictedFiles,
      retryFiles: [...this.retryQueue],
      history: this.opts.historyStore?.recent() ?? [],
    };
  }

  getUnresolvedConflictCount(): Promise<number> {
    return this.resolution.getUnresolvedConflictCount();
  }

  async compareWithRemote(path: string): Promise<RemoteCompareResult> {
    const { client } = await this.ensureClient();
    return this.resolution.compareWithRemote(client, path);
  }


  async pushLocalToRemote(path: string): Promise<void> {
    return this.resolution.pushLocalToRemote(await this.connection(), path);
  }

  async pullRemoteToLocal(path: string): Promise<void> {
    const { client } = await this.ensureClient();
    return this.resolution.pullRemoteToLocal(client, path);
  }

  private textEligible(path: string): boolean {
    return isTextEligible(path, this.opts.settings.autoMergeFileTypes);
  }

  private fetchRemoteInfo(path: string): Promise<RemoteFileInfo | null> {
    return this.resolution.fetchRemoteInfo(this.client!, path);
  }

  // Deliberately does not connect: the conflict paths run inside an already-connected sync.
  private currentConnection(): { client: IWebDAVClient; uploadStrategy: IUploadStrategy } {
    return { client: this.client!, uploadStrategy: this.uploadStrategy! };
  }

  private async connection(): Promise<{ client: IWebDAVClient; uploadStrategy: IUploadStrategy }> {
    const { client } = await this.ensureClient();
    return { client, uploadStrategy: this.uploadStrategy! };
  }


  private initSummary(): SyncSessionSummary {
    return this.journal.newSummary();
  }

  private recordError(
    summary: SyncSessionSummary,
    path: string,
    err: unknown,
    skippedPaths?: SyncErrorDetail['skippedPaths'],
    dirBreakerSkipped?: { deleteRemote: string[]; trashLocal: string[] },
  ): void {
    this.journal.recordError(summary, path, err, skippedPaths, dirBreakerSkipped);
  }

  private recordHistory(path: string, op: SyncFileOp, message?: string, detail?: SyncHistoryDetail): void {
    this.journal.recordHistory(path, op, message, detail);
  }

  // A missing vault folder proves nothing about individual files, so local wins and nothing is deleted locally (docs/spec.md §8).
  // The MKCOL is the proof: 201 = truly absent (reset and re-upload); 405 = the 404 listing was wrong, so change nothing.
  private async reseedFromLocal(summary: SyncSessionSummary): Promise<void> {
    const outcome = await this.client!.createVaultRoot();
    if (outcome === 'exists') {
      void this.opts.logger?.log(
        'sync: vault folder listing said 404 but MKCOL says it exists — treating the listing as failed; nothing changed',
        'error',
      );
      throw new Error('Vault folder listing failed (server reported it missing, but it exists). Nothing was changed; will retry on the next sync.');
    }
    void this.opts.logger?.log('sync: vault folder missing on the server → created it; re-seeding from local (tracking reset, no local deletions)');
    new Notice('The vault folder was missing on the server. It has been re-created and this vault is being re-uploaded from this device.', 8000);
    // Reset rather than force-upload: the first-run path already uploads every local file and MKCOLs every local folder
    // against an empty remote.
    await this.opts.stateDB.reset();
    await this.initialSync(summary);
  }

  private async initialSync(summary: SyncSessionSummary): Promise<void> {
    const client = this.client!;
    // With nothing tracked, a missing vault folder just means the server has nothing; the first upload creates the hierarchy
    // (also covers the re-seed path).
    let remoteFiles: RemoteFileInfo[];
    try {
      remoteFiles = await client.getFiles('');
    } catch (err) {
      if (!(err instanceof RemoteRootMissingError)) throw err;
      void this.opts.logger?.log('sync: INITIAL — no vault folder on the server yet; the first upload will create it');
      remoteFiles = [];
    }
    await this.preparePluginSession(client, remoteFiles);
    const localFiles = await this.scanLocalFiles();

    // Server-computed checksums (no download) let identical files count as unchanged rather than conflicts.
    await this.remoteListing.resolveRemoteChecksums(client, remoteFiles, localFiles);

    const plan = await this.buildInitialPlan(localFiles, remoteFiles);
    // With no recorded state, every local file the server lacks is an UPLOAD, including files deleted on another device
    // (resurrection path); the plan is logged for that reason.
    void this.opts.logger?.log(
      `sync: INITIAL sync (empty state) plan — up=${plan.uploads.length} down=${plan.downloads.length} ` +
      `unchanged=${plan.unchanged.length} conflicts=${plan.conflicts.length}. ` +
      `uploads(resurrection candidates)=[${plan.uploads.slice(0, 30).join(', ')}${plan.uploads.length > 30 ? ', …' : ''}]`,
      'verbose',
    );

    await this.executePlan(plan, remoteFiles, summary, localFiles);

    // A complete listing, so directory create/delete can be reconciled.
    await this.reconcileDirectories(summary);

    const token = await client.getSyncToken();
    this.opts.stateDB.setSyncToken(token);
  }

  private async incrementalSync(summary: SyncSessionSummary): Promise<void> {
    const client = this.client!;
    let remoteFiles: RemoteFileInfo[];
    // True when remoteFiles is the COMPLETE listing (absence implies remote deletion); false on the token path's partial diff.
    let isFullScan = false;
    // Non-null when the root-ETag short-circuit rebuilt the directory list from State; reuse it to skip getDirectories('') (docs/spec.md §8a.5).
    let fullScanCachedDirs: RemoteDirInfo[] | null = null;

    const existingToken = this.opts.stateDB.getSyncToken();
    // A missing vault folder can surface from any listing call below, including the token-expired fallback, hence one guard
    // around both. Nextcloud answers the token REPORT with 415 (docs/spec.md §18), so that branch is unreachable there.
    try {
      if (existingToken) {
        try {
          const changes = await client.getChanges(existingToken);
          this.opts.stateDB.setSyncToken(changes.newSyncToken);
          remoteFiles = changes.modified;
          void this.opts.logger?.log(`sync: incremental via token (modified=${changes.modified.length}, remote-deleted=${changes.deleted.length})`);

          // Apply remote renames (fileId-based) before deletions so a rename is not seen as delete + new upload.
          const rt = this.getOrCreateRenameTracker();
          const remoteRenames = rt.detectRemoteRenames(remoteFiles);
          for (const [oldPath, newPath] of remoteRenames) {
            await rt.applyRemoteRename(oldPath, newPath);
          }

          for (const deletedPath of changes.deleted) {
            await this.processRemoteDeletion(deletedPath, summary);
          }
        } catch (err) {
          if (err instanceof SyncTokenExpiredError) {
            // Fall back to a full scan (the root-ETag short-circuit may rebuild the listing from State).
            const listing = await this.obtainFullScanListing(client);
            remoteFiles = listing.remoteFiles;
            fullScanCachedDirs = listing.cachedDirs;
            isFullScan = true;
            const token = await client.getSyncToken();
            this.opts.stateDB.setSyncToken(token);
            void this.opts.logger?.log(`sync: sync-token expired → FULL SCAN (remote=${remoteFiles.length}, shortCircuit=${listing.cachedDirs != null}, nextToken=${token ? 'obtained' : 'NULL'}). Remote deletions detected by absence (full-scan reconciliation)`);
          } else {
            throw err;
          }
        }
      } else {
        // No prior token (the common Nextcloud case: sync-collection REPORT is unsupported, docs/spec.md §18), so every sync lands here.
        const listing = await this.obtainFullScanListing(client);
        remoteFiles = listing.remoteFiles;
        fullScanCachedDirs = listing.cachedDirs;
        isFullScan = true;
        const token = await client.getSyncToken();
        this.opts.stateDB.setSyncToken(token);
        void this.opts.logger?.log(`sync: FULL SCAN, no prior token (remote=${remoteFiles.length}, shortCircuit=${listing.cachedDirs != null}, nextToken=${token ? 'obtained' : 'NULL'}). Remote deletions detected by absence (full-scan reconciliation)`);
      }
    } catch (err) {
      if (!(err instanceof RemoteRootMissingError)) throw err;
      await this.reseedFromLocal(summary);
      return;
    }

    summary.retriedFiles = this.retryQueue.splice(0);

    await this.preparePluginSession(client, remoteFiles);
    await this.guardOutboundDeletions(summary);
    const eligible = remoteFiles.filter(f => !this.isSystemExcluded(f.path));
    this.syncProgress = { processed: 0, total: eligible.length };
    if (eligible.length > 0) this.opts.statusBar.setProgress(0, eligible.length);
    // Bounded parallel; uploads to the same directory are serialized to avoid 423s. A plugin's manifest.json goes last so a
    // half-written bundle never advertises a new version (docs/spec.md §7).
    const { rest, manifests } = partitionPluginManifestsLast(eligible, (f) => f.path, this.opts.configDir);
    await this.runFileBatch(
      [...rest, ...manifests],
      (r) => r.path,
      (r) => r.size,
      async (r) => { await this.processFileWithRetry(r, summary); this.tickProgress(); },
      true,
    );

    await this.processLocalModifications(remoteFiles, summary, isFullScan);

    // Only a COMPLETE listing can show directory absence; the token path's partial diff cannot.
    if (isFullScan) await this.reconcileDirectories(summary, fullScanCachedDirs ?? undefined);

    // Drop captured clean sides for paths that converged, keeping snapshots bounded to currently-conflicted files.
    this.sweepResolvedSnapshots();

    // Arm the root-ETag short-circuit only after a fully converged scan: with unresolved files, State may be stale against
    // an unchanged root ETag, and a short-circuit would resolve the remote change as local-wins and overwrite the other device's edit.
    // Invalidating the ETag forces a real full scan next time; convergence re-arms it (docs/spec.md §8a.5).
    if (summary.conflictedCount > 0 || summary.errorCount > 0 || this.retryQueue.length > 0) {
      this.opts.stateDB.setRemoteRootEtag(null);
    }
  }

  private async processFileWithRetry(remote: RemoteFileInfo, summary: SyncSessionSummary): Promise<void> {
    try {
      await this.processRemoteFile(remote, summary);
    } catch (err) {
      if (err instanceof NetworkError) {
        console.warn(`[SyncEngine] Error syncing ${remote.path}, queuing retry:`, err);
        this.retryQueue.push(remote.path);
        this.recordError(summary, remote.path, err);
      } else {
        // Local I/O errors (ENOENT, EACCES, etc.) must not abort the entire session.
        console.warn(`[SyncEngine] Error syncing ${remote.path}:`, err);
        void this.opts.logger?.log(`sync: error on ${remote.path} — ${(err as Error).message}`, 'error');
        this.recordError(summary, remote.path, err);
      }
    }
  }

  // The decision (including the safety-window guard) lives in ./policy; clock and last-sync time are accessors so StateDB
  // is consulted only when needed.
  private isLocallyUnchanged(base: FileState, stat: { mtime: number; size: number }): boolean {
    return isLocallyUnchangedPure(base, stat, {
      now: () => Date.now(),
      lastSyncTime: () => this.opts.stateDB.getLastSyncTime(),
    });
  }

  private withLocalSignature(fs: FileState, remoteMtime?: number | null): Promise<FileState> {
    return withLocalSignature(this.opts.localAdapter, fs, remoteMtime);
  }

  // Concurrency is capped by networkConcurrency AND by in-flight bytes (ByteSemaphore): requestUrl buffers whole bodies,
  // so a count-only cap would OOM on large files. With serializeByDir, same-directory workers run sequentially to avoid
  // directory-lock 423s. Workers must handle their own errors and never reject the batch (docs/plan.md §11).
  private async runFileBatch<T>(
    items: T[],
    pathOf: (it: T) => string,
    sizeOf: (it: T) => number,
    worker: (it: T) => Promise<void>,
    serializeByDir: boolean,
  ): Promise<void> {
    if (items.length === 0) return;
    const max = Math.max(1, this.opts.settings.networkConcurrency);
    const limiter = createLimiter(max);
    const budget = new ByteSemaphore(Platform.isMobile ? MAX_INFLIGHT_BYTES_MOBILE : MAX_INFLIGHT_BYTES_DESKTOP);
    const dirChains = new Map<string, Promise<void>>();

    const tasks = items.map((it) => limiter(async () => {
      // After requestStop(), queued workers no-op so no further network calls start.
      if (this.cancelled) return;
      const runOne = async (): Promise<void> => {
        const release = await budget.acquire(Math.max(0, sizeOf(it)));
        try {
          await worker(it);
        } finally {
          release();
        }
      };
      if (!serializeByDir) {
        await runOne();
        return;
      }
      const dir = parentDirOf(pathOf(it));
      const prev = dirChains.get(dir) ?? Promise.resolve();
      // Chain regardless of the previous task's outcome so one failure doesn't wedge the directory.
      const run = prev.then(runOne, runOne);
      dirChains.set(dir, run.then(() => undefined, () => undefined));
      await run;
    }));
    await Promise.all(tasks);
  }

  private async processRemoteFile(remote: RemoteFileInfo, summary: SyncSessionSummary): Promise<void> {
    const base = this.opts.stateDB.getFile(remote.path);
    const localStat = await this.opts.localAdapter.stat(remote.path);
    const { remoteId, idType } = remoteIdOf(remote);

    const remoteChanged = !base || base.remoteId !== remoteId;
    let localChanged = false;
    let localHash = base?.localHash ?? '';

    if (localStat && base) {
      // Skip reading/hashing while the post-write stat signature still matches; unlike on-disk mtime, it is valid on mobile
      // (docs/plan.md §4).
      if (!this.isLocallyUnchanged(base, localStat)) {
        const buf = await this.opts.localAdapter.readBinary(remote.path);
        localHash = await sha256(buf);
        localChanged = localHash !== base.localHash;
      }
    } else if (localStat) {
      // The file exists on both sides with no baseline: treating that as "local unchanged" would download over a local edit
      // (issue #23). Hash it and treat it as changed unless provably equal, so the both-changed arm resolves it as a conflict.
      const buf = await this.opts.localAdapter.readBinary(remote.path);
      localHash = await sha256(buf);
      localChanged = true;
    } else {
      localChanged = false;
    }

    const plugin = { localPresent: localStat !== null, localHash, localChanged, remoteId, idType };
    if (await this.applyPluginFileAction(remote, base, plugin, summary)) return;

    // Previously synced but gone locally: this device deleted it. Propagate rather than re-download (which resurrects it).
    if (!localStat && base) {
      if (this.outboundDeletionsHeld.has(remote.path)) return;
      await this.applyLocalDeletion(remote, base, remoteId, idType, summary);
      return;
    }

    // Identical content is never transferred, whatever the baseline says (docs/spec.md §5.3a).
    if (localStat && (remoteChanged || localChanged)
        && localStat.size === remote.size && checksumProvesIdentical(remote, localHash)) {
      void this.opts.logger?.log(`sync: content identical to the remote (checksum) → state converged, no transfer → ${remote.path}`);
      this.opts.stateDB.setFile(await this.withLocalSignature(convergedState(remote, localHash, localStat), remote.lastModified));
      await this.creationTime.align(this.client!, remote, localStat);
      return;
    }

    if (!remoteChanged && !localChanged) {
      // A converged baseline records the same size on both sides. A mismatch despite matching ids means the baseline is
      // inconsistent (typical without a content checksum, idType 'etag'), so reconcile via conflict resolution instead of skipping.
      if (base && localStat && localStat.size !== base.size) {
        void this.opts.logger?.log(
          `sync: divergent baseline detected (idType=${idType}, localSize=${localStat.size}, baseSize=${base.size}) → reconciling ${remote.path}`,
        );
        await this.handleConflict(remote.path, base, remote, remoteId, idType, summary);
        return;
      }
      // Converged: clear a stale conflict flag so the conflict count does not stay stuck.
      if (base?.isConflicted) {
        this.opts.stateDB.setFile({ ...base, isConflicted: false });
      }
      await this.creationTime.align(this.client!, remote, localStat);
      return;
    }

    if (localChanged && !remoteChanged) {
      await this.uploadOrConflict(remote, base, localHash, remoteId, idType, summary);
    } else if (!localChanged && remoteChanged) {
      if (this.deferIfBeingEdited(remote.path, 'download')) return;
      await this.downloadFile(remote, remoteId, idType, summary);
    } else {
      if (this.deferIfBeingEdited(remote.path, 'conflict')) return;
      await this.handleConflict(remote.path, base, remote, remoteId, idType, summary);
    }
  }

  // If-Match 412: the remote changed between PROPFIND and PUT, so treat it as a conflict instead of overwriting (docs/spec.md §6.5).
  private async uploadOrConflict(
    remote: RemoteFileInfo, base: FileState | undefined, localHash: string,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    try {
      await this.uploadFile(remote.path, localHash, remoteId, idType, remote, summary);
    } catch (err) {
      if (!(err instanceof PreconditionFailedError)) throw err;
      void this.opts.logger?.log(`upload: If-Match 412 (remote changed during sync) → conflict → ${remote.path}`);
      await this.handleConflict(remote.path, base, remote, remoteId, idType, summary);
    }
  }

  // Applies the bundle direction of a listed plugin to one of its code or data files. Returns true when the file was
  // handled here; false leaves it to the regular decision (docs/spec.md §7).
  private async applyPluginFileAction(
    remote: RemoteFileInfo, base: FileState | undefined,
    side: { localPresent: boolean; localHash: string; localChanged: boolean; remoteId: string; idType: FileState['idType'] },
    summary: SyncSessionSummary,
  ): Promise<boolean> {
    const action = this.plugins.fileAction(remote.path, {
      localPresent: side.localPresent, remotePresent: true, tracked: base !== undefined,
      sameContent: fileSameContent({
        localHash: side.localPresent ? side.localHash : null, remote, base: base ?? null, localChanged: side.localChanged,
      }),
    });
    switch (action) {
      case 'download':
        if (!this.deferIfBeingEdited(remote.path, 'download')) await this.downloadFile(remote, side.remoteId, side.idType, summary);
        return true;
      case 'upload':
        await this.uploadOrConflict(remote, base, side.localHash, side.remoteId, side.idType, summary);
        return true;
      case 'hold':
        await this.handleConflict(remote.path, base, remote, side.remoteId, side.idType, summary);
        return true;
      case 'skip':
        return true;
      default:
        return false;
    }
  }

  // True when a listed plugin file exists on one side only and the bundle direction says it must stay there.
  private pluginSkips(path: string, side: 'local-only' | 'remote-only'): boolean {
    if (!this.plugins.isPluginPath(path)) return false;
    return this.plugins.fileAction(path, {
      localPresent: side === 'local-only', remotePresent: side === 'remote-only',
      tracked: !!this.opts.stateDB.getFile(path), sameContent: false,
    }) === 'skip';
  }

  // Defers the whole decision, not just the write: a new baseline is recorded with it, and skipping only the write would
  // leave StateDB claiming a body the file does not hold. Uploads are never deferred; they leave the file alone (docs/spec.md §5.7b).
  private deferIfBeingEdited(path: string, what: 'download' | 'conflict'): boolean {
    if (!this.opts.isBeingEdited?.(path)) return false;
    void this.opts.logger?.log(`${what}: deferred — "${path}" is being edited right now`);
    this.retryQueue.push(path);
    return true;
  }

  private applyLocalDeletion(
    remote: RemoteFileInfo, base: FileState, remoteId: string, idType: FileState['idType'],
    summary: SyncSessionSummary,
  ): Promise<'deleted' | 'restored' | 'kept'> {
    return this.deletion.applyLocalDeletion(this.client!, remote, base, remoteId, idType, summary);
  }


  private uploadFile(
    path: string, localHash: string, remoteId: string,
    idType: FileState['idType'], remote: RemoteFileInfo,
    summary: SyncSessionSummary,
  ): Promise<void> {
    return this.transfer.uploadFile(
      this.client!, this.uploadStrategy!, path, localHash, remoteId, idType, remote, summary,
    );
  }



  async listVersions(path: string): Promise<FileVersion[]> {
    const { client, features } = await this.ensureClient();
    return this.versions.listVersions(client, features, path);
  }

  async restoreVersion(path: string, version: FileVersion): Promise<void> {
    const { client, features } = await this.ensureClient();
    return this.versions.restoreVersion(client, features, path, version);
  }

  private acquireLock(path: string): Promise<string | null> {
    return this.transfer.acquireLock(this.client!, path);
  }

  private releaseLock(path: string, token: string | null): Promise<void> {
    return this.transfer.releaseLock(this.client!, path, token);
  }

  private isRemoteOverSizeLimit(remote: RemoteFileInfo): boolean {
    return this.transfer.isRemoteOverSizeLimit(remote);
  }

  private warnDownloadSkipped(path: string, sizeBytes: number): void {
    this.transfer.warnDownloadSkipped(path, sizeBytes);
  }

  private downloadFile(
    remote: RemoteFileInfo, remoteId: string,
    idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    return this.transfer.downloadFile(this.client!, remote, remoteId, idType, summary);
  }


  private handleConflict(
    path: string, base: FileState | undefined, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.handleConflict(
      this.currentConnection(), path, base, remote, remoteId, idType, summary,
    );
  }

  private resolveByPreferLocal(
    path: string, remote: RemoteFileInfo, summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.resolveByPreferLocal(this.currentConnection(), path, remote, summary);
  }

  private resolveByPreferRemote(
    path: string, remote: RemoteFileInfo, remoteData: ArrayBuffer,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.resolveByPreferRemote(
      path, remote, remoteData, remoteId, idType, summary, this.currentConnection().client,
    );
  }

  private resolveByWrite(
    path: string, content: string, clean: boolean, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.resolveByWrite(
      this.currentConnection(), path, content, clean, remote, remoteId, idType, summary,
    );
  }


  private async processRemoteDeletion(path: string, summary: SyncSessionSummary): Promise<void> {
    const outcome = await this.deletion.processRemoteDeletion(path, summary);
    // The entry kept for the retry describes a file the server no longer has. A short-circuit would rebuild the
    // listing from State, report it as still on the server, and never retry (docs/spec.md §8a.5).
    if (outcome.status === 'failed') this.opts.stateDB.setRemoteRootEtag(null);
  }

  // Outbound mass-delete breaker: a vault that suddenly lost many tracked files (bulk delete, failed mount, another
  // tool) must not empty the server and, through it, every other device. Same limit as the absence-deletion breaker
  // in processLocalModifications. Held paths stay tracked and are left for the user (docs/spec.md §8).
  private async guardOutboundDeletions(summary: SyncSessionSummary): Promise<void> {
    this.outboundDeletionsHeld = new Set();
    const tracked = this.opts.stateDB.getAllFiles();
    const candidates: string[] = [];
    for (const { path } of tracked) {
      if (this.isSystemExcluded(path) || this.plugins.isPluginPath(path)) continue;
      if (!(await this.opts.localAdapter.stat(path))) candidates.push(path);
    }
    const limit = this.effectiveMassDeleteLimit(tracked.length);
    if (candidates.length <= limit) return;

    this.outboundDeletionsHeld = new Set(candidates);
    void this.opts.logger?.log(`delete-remote: HELD ${candidates.length} local deletions, exceeds safety limit (${limit})`);
    new Notice(
      `${candidates.length} files are missing on this device and were not deleted on the server. `
      + 'To restore them, reset the vault index and sync. To delete them on the server, set the mass-delete limit to 0 for one sync.',
      15000,
    );
    // Recorded as an error so the status dialog lists the paths and the root-ETag short-circuit is invalidated.
    this.recordError(summary, '(outbound mass-delete breaker)',
      new Error(`Held ${candidates.length} local deletions, exceeds safety limit ${limit}`),
      { all: candidates, direction: 'outbound' });
  }

  private async processLocalModifications(
    remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary, isFullScan = false,
  ): Promise<void> {
    const remotePathSet = new Set(remoteFiles.map(f => f.path));

    const localStats = new Map<string, { size: number; mtime: number }>();
    await this.collectLocalStats('', localStats);
    // The config folder is not scanned recursively, so inject the enabled config-sync category files.
    for (const p of await this.configSync.enumerateIncludedPaths()) {
      const st = await this.opts.localAdapter.stat(p);
      if (st) localStats.set(p, { size: st.size, mtime: st.mtime });
    }

    // Cheap synchronous pre-filter, then bounded-parallel upload; the content-hash check stays in the worker because it needs a read.
    const uploadCandidates = [...localStats.entries()].filter(([path, st]) => {
      if (remotePathSet.has(path) || this.pluginSkips(path, 'local-only')) return false;
      const base = this.opts.stateDB.getFile(path);
      // Skip files whose post-write stat signature is unchanged (no read, no hash); an mtime filter is always false on mobile.
      return !(base && this.isLocallyUnchanged(base, st));
    });
    await this.runFileBatch(
      uploadCandidates,
      ([path]) => path,
      ([, st]) => st.size,
      async ([path, st]) => {
        const base = this.opts.stateDB.getFile(path);
        const data = await this.opts.localAdapter.readBinary(path);
        const localHash = await sha256(data);
        if (base && localHash === base.localHash) return;
        // For new files, use the local hash as remoteId (= the server checksum after upload).
        const remoteId = base?.remoteId ?? localHash;
        const idType: FileState['idType'] = base?.idType ?? 'sha256';
        void this.opts.logger?.log(`upload: ${path} (${base ? 'modified, re-upload' : 'new local file'})`);
        try {
          await this.uploadFile(
            path, localHash, remoteId, idType,
            { path, fileId: base?.remoteFileId ?? null, checksum: null, etag: null, size: st.size, lastModified: st.mtime, creationTime: 0 },
            summary,
          );
        } catch (err) {
          // One failing file (e.g. a server-side 403) must not abort the whole session.
          console.warn(`[SyncEngine] Upload failed for ${path}:`, err);
          void this.opts.logger?.log(`upload: FAILED ${path} — ${(err as Error).message}`);
          this.recordError(summary, path, err);
          if (err instanceof NetworkError) this.retryQueue.push(path);
        }
      },
      true,
    );

    const rt = this.getOrCreateRenameTracker();
    // New (unsynced) local files, for hash-based rename detection.
    const newLocalFiles = new Map<string, { hash: string; size: number }>();
    for (const [path, st] of localStats) {
      if (!this.opts.stateDB.getFile(path)) {
        const data = await this.opts.localAdapter.readBinary(path);
        const hash = await sha256(data);
        newLocalFiles.set(path, { hash, size: st.size });
      }
    }

    const missingPaths = this.opts.stateDB.getAllFiles()
      .map(f => f.path)
      .filter(p => !this.isSystemExcluded(p) && !localStats.has(p) && !remotePathSet.has(p));

    const localRenames = rt.detectLocalRenamesByHash(missingPaths, newLocalFiles);

    for (const [oldPath, newPath] of localRenames) {
      try {
        await rt.applyLocalRename(oldPath, newPath);
      } catch (err) {
        console.warn(`[SyncEngine] Local rename ${oldPath} → ${newPath} failed:`, err);
        this.recordError(summary, newPath, err);
      }
    }

    // Remaining missing paths are genuine local deletions. deleteLocallyMissing asks about the path directly and routes anything
    // still present through the usual proof path: a listing that lost a file must not get it destroyed on the server (issue #46).
    // Watch mode shares it, so a scan and a single vault event decide identically.
    for (const path of missingPaths) {
      if (localRenames.has(path) || this.outboundDeletionsHeld.has(path)) continue;
      const fileState = this.opts.stateDB.getFile(path);
      if (!fileState) continue;
      void this.opts.logger?.log(`delete-remote: locally deleted, propagating to server → ${path}`);
      try {
        await this.deletion.deleteLocallyMissing(this.client!, path, fileState, summary);
      } catch (err) {
        // An unanswerable probe or failed DELETE keeps the tracking entry so the next sync retries; dropping it would
        // re-download the file and revert the user's deletion.
        console.warn(`[SyncEngine] Failed to delete ${path} from remote:`, err);
        void this.opts.logger?.log(`delete-remote: probe FAILED, keeping tracking for retry → ${path} — ${(err as Error).message}`);
        this.recordError(summary, path, err);
      }
    }

    // Full scan only: a tracked file present locally but missing from the COMPLETE listing was deleted on the server; remove it
    // locally (recoverable via "Deleted files"). An empty listing is deliberately acted on (issue #50): it is no failure in
    // disguise (a non-207 or a root 404 throws), and refusing left files in State that the root-ETag short-circuit rebuilt as
    // "still on the server", so the vault never converged. The breaker and per-candidate 404 re-check below guard partial listings (docs/spec.md §8).
    if (isFullScan) {
      // Compare real content, not mtime, so a local edit that did not bump mtime is never lost.
      const candidates: string[] = [];
      for (const fileState of this.opts.stateDB.getAllFiles()) {
        const path = fileState.path;
        if (this.isSystemExcluded(path) || remotePathSet.has(path)) continue;
        if (!localStats.has(path)) continue;
        const data = await this.opts.localAdapter.readBinary(path);
        if (await sha256(data) !== fileState.localHash) continue;
        candidates.push(path);
      }

      // Circuit breaker: too many apparent remote deletions means a partial or failed listing, so refuse.
      const tracked = this.opts.stateDB.getAllFiles().length;
      const limit = this.effectiveMassDeleteLimit(tracked);
      if (candidates.length > limit) {
        void this.opts.logger?.log(`delete-local: SKIPPED ${candidates.length} absence-deletions — exceeds safety limit (${limit}); likely a partial remote listing`);
        new Notice(`⚠️ ${candidates.length} files look deleted on the server — skipped to avoid mass deletion. Re-sync to retry.`, 10000);
        // An unresolved state: record it as an error so the UI surfaces it and the root-ETag short-circuit is invalidated;
        // otherwise "re-sync to retry" would never re-evaluate the deletions (docs/spec.md §8a.5).
        this.recordError(summary, '(mass-delete breaker)', new Error(`Skipped ${candidates.length} absence-deletions — exceeds safety limit ${limit}`), {
          all: candidates,
        });
        return;
      }

      // Re-verify each candidate with a targeted PROPFIND so a false negative in the bulk listing never deletes locally.
      for (const path of candidates) {
        let goneOnServer = false;
        try { goneOnServer = !(await this.client!.remoteExists(path)); } catch { goneOnServer = false; }
        if (!goneOnServer) {
          void this.opts.logger?.log(`delete-local: re-check found it still on server — keeping → ${path}`);
          continue;
        }
        void this.opts.logger?.log(`delete-local: remote deletion confirmed (absence + 404 re-check) → ${path}`);
        await this.processRemoteDeletion(path, summary);
      }
    }
  }

  // Runs only on a COMPLETE listing. Directories are first-class entities, never deleted merely for being empty
  // (docs/spec.md §8a.1, docs/plan.md §16).
  private reconcileDirectories(summary: SyncSessionSummary, cachedDirs?: RemoteDirInfo[]): Promise<void> {
    return this.directories.reconcileDirectories(this.client!, summary, cachedDirs);
  }

  private async buildInitialPlan(
    localFiles: Map<string, { size: number; mtime: number }>,
    remoteFiles: RemoteFileInfo[],
  ): Promise<InitialSyncPlan> {
    const uploads: string[] = [];
    const downloads: string[] = [];
    const conflicts: string[] = [];
    const unchanged: string[] = [];
    const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));

    for (const [path, lf] of localFiles) {
      const remote = remoteMap.get(path);
      if (!remote) { if (!this.pluginSkips(path, 'local-only')) uploads.push(path); continue; }
      if (remote.size !== lf.size) { conflicts.push(path); continue; }
      // Hash only to prove "unchanged", and only when the server supplied a checksum; otherwise (or above the size gate)
      // fall back to conflict resolution without reading the file.
      if (!remote.checksum || lf.size > MAX_HASH_SIZE) { conflicts.push(path); continue; }
      const localHash = await sha256(await this.opts.localAdapter.readBinary(path));
      if (localHash === remote.checksum) unchanged.push(path);
      else conflicts.push(path);
    }
    for (const remote of remoteFiles) {
      if (this.isSystemExcluded(remote.path)) continue;
      if (!localFiles.has(remote.path) && !this.pluginSkips(remote.path, 'remote-only')) downloads.push(remote.path);
    }
    return { uploads, downloads, conflicts, unchanged, deletes: [] };
  }

  private async executePlan(
    plan: InitialSyncPlan, remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary,
    localFiles: Map<string, { size: number; mtime: number }>,
  ): Promise<void> {
    // The caller already scanned the vault, so reuse the stat map; hashing is deferred to upload time.
    const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));
    const actionFiles = plan.uploads.length + plan.downloads.length + plan.conflicts.length;
    this.syncProgress = { processed: 0, total: actionFiles };
    if (actionFiles > 0) this.opts.statusBar.setProgress(0, actionFiles);

    await this.runFileBatch(
      plan.uploads,
      (path) => path,
      (path) => localFiles.get(path)?.size ?? 0,
      async (path) => {
        try {
          const lf = localFiles.get(path);
          if (!lf) return;
          const data = await this.opts.localAdapter.readBinary(path);
          // Hash from the bytes just read; reused for the OC-Checksum upload header so the client does not hash twice.
          const localHash = await sha256(data);
          // The local creation time is read before the upload; a server value for the same path is honoured (docs/spec.md §9.7).
          const before = await this.opts.localAdapter.stat(path);
          const ctime = uploadCreationTimeMs(before?.ctime, remoteMap.get(path)?.creationTime ?? 0);
          const outcome = await this.uploadStrategy!.upload(this.client!, path, data, lf.mtime, { precomputedSha256: localHash, ctime });
          if (outcome === 'skipped') { this.tickProgress(); return; }
          summary.uploadedCount++;
          this.recordHistory(path, 'uploaded');
          const stat = await this.opts.localAdapter.stat(path);
          this.opts.stateDB.setFile(await this.withLocalSignature({ path, localHash, remoteId: localHash, idType: 'sha256', size: lf.size, mtime: stat?.mtime ?? 0, remoteFileId: null, isConflicted: false }));
          // This batch bypasses uploadFile, so it seeds its own merge base; without it a later concurrent edit duplicates shared blocks.
          this.recordMergeBase(path, data);
        } catch (err) { this.recordError(summary, path, err); this.retryQueue.push(path); }
        this.tickProgress();
      },
      true,
    );

    // A plugin's manifest.json is written after every other code file of its bundle (docs/spec.md §7): downloads' rest,
    // then conflicts' rest, then the manifests.
    const dl = partitionPluginManifestsLast(plan.downloads, (path) => path, this.opts.configDir);
    const cf = partitionPluginManifestsLast(plan.conflicts, (path) => path, this.opts.configDir);
    await this.downloadPlanned(dl.rest, remoteMap, summary);

    // Identical on both sides: seed State with no transfer and no local write (the local mtime is left unchanged).
    for (const path of plan.unchanged) {
      const lf = localFiles.get(path);
      const remote = remoteMap.get(path);
      if (!lf || !remote) continue;
      const mtime = remote.lastModified || lf.mtime;
      // Classified unchanged only after localHash === remote.checksum, so the checksum is the content hash for both sides.
      this.opts.stateDB.setFile(await this.withLocalSignature({
        path, localHash: remote.checksum!, remoteId: remote.checksum!, idType: 'sha256',
        size: lf.size, mtime, remoteFileId: remote.fileId, isConflicted: false,
      }, remote.lastModified));
      await this.creationTime.align(this.client!, remote);
    }

    await this.resolvePlannedConflicts(cf.rest, remoteMap, summary);
    await this.downloadPlanned(dl.manifests, remoteMap, summary);
    await this.resolvePlannedConflicts(cf.manifests, remoteMap, summary);
  }

  private async downloadPlanned(
    paths: string[], remoteMap: Map<string, RemoteFileInfo>, summary: SyncSessionSummary,
  ): Promise<void> {
    // No directory serialization: each worker writes a distinct local file.
    await this.runFileBatch(
      paths,
      (path) => path,
      (path) => remoteMap.get(path)?.size ?? 0,
      async (path) => {
        try {
          const remote = remoteMap.get(path)!;
          const { remoteId, idType } = remoteIdOf(remote);
          await this.downloadFile(remote, remoteId, idType, summary);
        } catch (err) { this.recordError(summary, path, err); this.retryQueue.push(path); }
        this.tickProgress();
      },
      false,
    );
  }

  private async resolvePlannedConflicts(
    paths: string[], remoteMap: Map<string, RemoteFileInfo>, summary: SyncSessionSummary,
  ): Promise<void> {
    for (const path of paths) {
      try {
        const remote = remoteMap.get(path)!;
        const { remoteId, idType } = remoteIdOf(remote);
        await this.handleConflict(path, undefined, remote, remoteId, idType, summary);
      } catch (err) { this.recordError(summary, path, err); this.retryQueue.push(path); }
      this.tickProgress();
    }
  }

  private tickProgress(): void {
    this.syncProgress.processed = Math.min(this.syncProgress.processed + 1, this.syncProgress.total);
    if (this.syncProgress.total > 0) {
      this.opts.statusBar.setProgress(this.syncProgress.processed, this.syncProgress.total);
    }
  }


  private scanLocalFiles(): Promise<Map<string, { size: number; mtime: number }>> {
    return this.localScanner.scanLocalFiles();
  }

  private collectLocalStats(_dir: string, out: Map<string, { size: number; mtime: number }>): Promise<void> {
    return this.localScanner.collectLocalStats(out);
  }

  private obtainFullScanListing(
    client: IWebDAVClient,
  ): Promise<{ remoteFiles: RemoteFileInfo[]; cachedDirs: RemoteDirInfo[] | null }> {
    return this.remoteListing.obtainFullScanListing(client);
  }

  private rebuildRemoteFilesFromState(): RemoteFileInfo[] {
    return this.remoteListing.rebuildRemoteFilesFromState();
  }

  private rebuildRemoteDirsFromState(): RemoteDirInfo[] {
    return this.remoteListing.rebuildRemoteDirsFromState();
  }

  // Rules and the remote-deletion scope guard live in ./policy so they can be tested without an engine. Community
  // plugin files are decided by the ConfigSyncResolver.isIncluded gate: only the files of a plugin listed for this
  // session pass, every other path under plugins/ is excluded.
  private isSystemExcluded(path: string): boolean {
    return isSystemExcludedPure(path, {
      excludedFolders: this.opts.settings?.excludedFolders ?? [],
      isUnderConfigDir: (p) => this.configSync.isUnderConfigDir(p),
      isConfigPathIncluded: (p) => this.configSync.isIncluded(p),
      isActiveLogFile: this.opts.isActiveLogFile,
    });
  }
}

