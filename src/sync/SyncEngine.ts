import { App, Notice, Platform } from 'obsidian';
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

/** The categorized first-sync plan produced by buildInitialPlan and consumed by executePlan. */
interface InitialSyncPlan {
  uploads: string[];
  downloads: string[];
  conflicts: string[];
  deletes: string[];
  /** Files present and identical on both sides (no transfer needed; state is seeded). */
  unchanged: string[];
}

interface SyncEngineOptions {
  app: App;
  settings: DavSyncSettings;
  localAdapter: LocalAdapter;
  stateDB: StateDB;
  /** Last-synced bodies used as the 3-way merge base (feature 038). Optional (absent in some tests). */
  baseStore?: MergeBaseStore;
  /**
   * Captured clean sides of marker-conflicted notes, so force-resolution recovers a real clean
   * version rather than the marker content (feature 044). Optional (absent in some tests).
   */
  cleanSideStore?: CleanSideStore;
  statusBar: IStatusBar;
  /** Persisted per-file sync-history log for the status dialog. Optional (absent in some tests). */
  historyStore?: SyncHistoryStore;
  webdavFactory: WebDAVFactory;
  pluginDir: string;
  /** Obsidian's configuration folder (Vault#configDir), e.g. `.obsidian`. User-configurable. */
  configDir: string;
  /**
   * Returns true when `path` is one of this device's per-device log files that is currently being
   * written (its toggle is on), so it must be kept out of sync. Optional (absent in some tests);
   * when omitted, no log-based exclusion is applied. Host owns the host-token/settings details
   * (see `isActiveOwnLog`) to keep SyncEngine decoupled from log-path resolution.
   */
  isActiveLogFile?: (path: string) => boolean;
  /**
   * Returns true while `path` is being actively edited — the user has typed into it within the
   * watch debounce window and the editor may still be ahead of what is on disk.
   *
   * Consulted before any REMOTE -> LOCAL write (download, conflict resolution). Writing under the
   * cursor is how a resolution turns into the user watching their sentence disappear (GitHub issue
   * #42), and no merge is good enough to make that acceptable. Uploads are unaffected: they read
   * the file and leave it alone.
   *
   * Optional (absent in some tests); when omitted nothing is deferred. The host owns the definition
   * because only it sees the vault's modify events.
   */
  isBeingEdited?: (path: string) => boolean;
  /** Diagnostic logger (writes nextcloud-sync-debug.md while Debug mode is on). Optional. */
  logger?: FileLogger;
  /**
   * Invoked once per established connection with the detected server features.
   * Lets the host persist the server version (for the settings recommendation banner)
   * without coupling the sync engine to plugin settings persistence.
   */
  onFeatures?: (features: NextcloudFeatures) => void;
}

export class SyncEngine {
  private autoSyncHandle: number | null = null;
  private lastSummary: SyncSessionSummary | null = null;
  private retryQueue: string[] = [];
  private client: IWebDAVClient | null = null;
  private features: NextcloudFeatures | null = null;
  private uploadStrategy: IUploadStrategy | null = null;
  /** Balking pattern: sync-in-progress flag — a second syncManual() call returns immediately. */
  private running = false;
  /**
   * Two-Phase Termination: set by requestStop() (e.g. plugin onunload). Bounded-parallel workers
   * check it and stop pulling new work, so an in-progress sync winds down cleanly instead of firing
   * more network calls after teardown — important on mobile where the OS may suspend/kill the app.
   * The sync's finally block (state save) still runs, so no partial-progress state is lost.
   */
  private cancelled = false;
  /**
   * The in-flight full-sync run promise (the body of {@link syncManual}), or null when idle. Lets
   * {@link abortAndWait} await a running sync's clean wind-down (including its finally state save)
   * before a maintenance reset clears the tracking index, so the two never interleave.
   */
  private currentRun: Promise<void> | null = null;
  /** Start time of the in-progress full sync (= summary.startedAt); null outside a full sync run. */
  /** Session-scoped recording (feature 074). Owns the run start time that groups history entries. */
  private readonly journal: SyncJournal;

  /** Merge-base eligibility and save-request pairing (feature 074). */
  private readonly mergeBase: MergeBaseRecorder;
  /** Currently held lock tokens (path → token). */
  /** Single-file transfer, locking and size guards (feature 074). Owns the locks it holds. */
  private readonly transfer: TransferService;

  /** Nextcloud version history (feature 074). Takes no part in a sync session. */
  private readonly versions: VersionService;

  /** Deletion propagation, both directions (feature 074). */
  private readonly deletion: DeletionService;

  /** Compare, force-resolution and the clean-side snapshots (feature 074). */
  private readonly resolution: ResolutionService;

  /** Carries out what ConflictResolver decides (feature 074). */
  private readonly conflicts: ConflictApplier;

  /** Directory three-way reconcile and its mass-delete breaker (feature 074). */
  private readonly directories: DirectoryReconciler;

  /** Watch-mode single-path operations (feature 074). Owns its in-flight and deferred sets. */
  private readonly watch: WatchOperations;

  /** Mirror from remote: plan, then apply (feature 074). */
  private readonly mirror: MirrorService;
  /** Progress counters updated during a sync run (reset each run). */
  private syncProgress = { processed: 0, total: 0 };
  /**
   * Feature 064 (C-6): monotonic count of handleConflict entries. Only ever read as a DELTA around a
   * single watch-mode operation, to answer "did this touch a conflict at all?". The summary counters
   * cannot answer that: a conflict settled by a deterministic strategy (local-win / remote-win /
   * biggest-size / latest-mtime) lands in uploadedCount/downloadedCount, indistinguishable from a
   * routine transfer — yet that is precisely the outcome where one side's content was discarded and
   * the user most needs to hear about it.
   */
  private conflictEncounters = 0;
  private renameTracker: RenameTracker | null = null;
  /**
   * Decides which `.obsidian` config-folder paths sync (category-level opt-in, issue #1) and
   * enumerates them for the local scan. Single source of truth shared by `isSystemExcluded`,
   * the remote-file filter, and the remote-deletion scope guard.
   */
  private readonly configSync: ConfigSyncResolver;

  /** Local enumeration (feature 074). Built here because every dependency it needs is stable. */
  private readonly localScanner: LocalScanner;

  /**
   * Remote enumeration (feature 074). `isNextcloud` and `networkConcurrency` are passed as accessors,
   * not values, because capabilities arrive later (ensureClient) and settings can change under us.
   */
  private readonly remoteListing: RemoteListingSource;

  constructor(private readonly opts: SyncEngineOptions) {
    this.configSync = new ConfigSyncResolver({
      configDir: opts.configDir,
      settings: opts.settings,
      pluginDir: opts.pluginDir,
      localAdapter: opts.localAdapter,
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
    });
    this.transfer = new TransferService({
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      journal: this.journal,
      mergeBase: this.mergeBase,
      maxFileSizeMB: () => this.opts.settings.maxFileSizeMB,
      hasFilesLocking: () => this.features?.hasFilesLocking === true,
      // Feature 080: which client is connected, not what the server said about itself. Only
      // NextcloudClient ever fills in `checksum`; StandardWebDAVClient returns null for every file.
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
      logger: opts.logger,
    });
    this.resolution = new ResolutionService({
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      historyStore: opts.historyStore,
      cleanSideStore: opts.cleanSideStore,
      journal: this.journal,
      mergeBase: this.mergeBase,
      transfer: this.transfer,
      autoMergeFileTypes: () => this.opts.settings.autoMergeFileTypes,
      maxFileSizeMB: () => this.opts.settings.maxFileSizeMB,
      logger: opts.logger,
    });
    this.conflicts = new ConflictApplier({
      app: opts.app,
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      baseStore: opts.baseStore,
      journal: this.journal,
      mergeBase: this.mergeBase,
      transfer: this.transfer,
      resolution: this.resolution,
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
      connect: () => this.connection(),
      renameTracker: () => this.getOrCreateRenameTracker(),
      isSyncRunning: () => this.running,
      processFile: (remote, summary) => this.processFileWithRetry(remote, summary),
      queueRetry: (p) => { this.retryQueue.push(p); },
      conflictEncounters: () => this.conflictEncounters,
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

  /**
   * Initialize the WebDAV client, capabilities, and upload strategy exactly once.
   * Inspects capabilities to decide whether extensions like chunked/lock are available (Progressive Enhancement).
   */
  private async ensureClient(): Promise<{ client: IWebDAVClient; features: NextcloudFeatures }> {
    if (!this.client || !this.features) {
      const { client, features } = await this.opts.webdavFactory.createClient();
      this.client = client;
      this.features = features;
      // Feature 033: chunked upload is always on (still gated by server capability), and the chunk
      // threshold is platform-derived (no user input). Both come from the fixed config, not settings.
      const uploadConfig = { maxFileSizeMB: this.opts.settings.maxFileSizeMB, uploadChunkThresholdMB: chunkThresholdMB(Platform.isMobile) };
      this.uploadStrategy = (FIXED.chunkedUploadEnabled && features.isNextcloud)
        ? new ChunkedUploadStrategy(uploadConfig)
        : new SimpleUploadStrategy(uploadConfig);
      this.opts.onFeatures?.(features);
    }
    return { client: this.client, features: this.features };
  }

  /**
   * "Wi-Fi only" gate. Skips when enabled and on a cellular connection.
   * Network type is only detectable on Chromium (desktop / Android); iOS (WebKit) has no
   * `navigator.connection`, so the setting is ignored there (and its toggle is disabled).
   */
  private isBlockedByWifiOnly(): boolean {
    const conn = (navigator as Navigator & { connection?: { type?: string } }).connection;
    return isCellularBlocked(this.opts.settings.syncOnWifiOnly, Platform.isIosApp, conn?.type);
  }

  async syncManual(opts: { manual?: boolean } = {}): Promise<void> {
    // Mobile has no status bar; sync state (progress + result) is surfaced via NoticeStatusBar,
    // which implements IStatusBar and is driven uniformly for every run. The two early-return
    // guidance notices below still need an explicit mobile notice because those paths return
    // before any syncing toast is created. Desktop keeps using the status bar (no popups).
    void this.opts.logger?.log(`sync: start (manual=${opts.manual === true})`);
    // Prevent concurrent runs (avoid clashing with watch mode or scheduled sync).
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
    // Set the balking flag synchronously (before any await) so a concurrent call still balks, then
    // run the body via a tracked promise so abortAndWait() can await this run's clean wind-down.
    this.running = true;
    this.cancelled = false;
    const run = this.runSyncSession();
    this.currentRun = run;
    try {
      await run;
    } finally {
      this.currentRun = null;
      // C-5: the run is over (runSyncSession's finally already cleared `running`), so any watch-mode
      // edit that arrived meanwhile can now be evaluated. Best-effort: a failure here must not
      // propagate out of "Sync now" — the paths stay detectable as local changes for the next sync.
      try {
        await this.drainWatchPending();
      } catch (err) {
        console.warn('[SyncEngine] Deferred watch-mode sync failed:', err);
      }
    }
  }

  /** The actual full-sync session body. Always runs under the {@link syncManual} balking guard. */
  private async runSyncSession(): Promise<void> {
    // Build the summary and tag this run BEFORE the try so the catch/finally can reference them even
    // when the very first step fails.
    const summary = this.initSummary();
    this.journal.beginRun(summary.startedAt); // tag this run's history entries for grouping

    const cancelled = false;
    try {
      // Feature 053: connect INSIDE the guard. ensureClient() (client creation + capabilities probe)
      // can throw (network / auth / capabilities) or hang; if it ran outside this try, a failure would
      // skip the finally that clears `running`, stranding the engine as "sync in progress" forever
      // AND swallowing the real error (no FAILED log) — every later sync then balks with "already
      // running", and a restart's startup sync re-triggers the same failure and re-strands it.
      void this.opts.logger?.log('sync: connecting (ensureClient)');
      await this.ensureClient();
      this.syncProgress = { processed: 0, total: 0 };
      this.opts.statusBar.setStatus('syncing');

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
      // Clear the running flags FIRST. Everything below is best-effort teardown that can throw (a
      // failed stateDB/historyStore save, a persistence I/O error); if the flag were cleared only at
      // the end, such a throw would leave the engine permanently "running" and block every subsequent
      // sync. Resetting up front guarantees the next sync can always start.
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
      // Best-effort persistence: a save failure must not propagate out of the finally (which would
      // mask the original error and, before the flag move above, strand the running flag).
      try {
        await this.opts.stateDB.save();
        await this.opts.historyStore?.save(); // persist this session's per-file outcomes (pruned to 24h)
      } catch (persistErr) {
        console.error('[SyncEngine] Post-sync persistence failed:', persistErr);
        void this.opts.logger?.log(`sync: post-sync save failed — ${(persistErr as Error).message}`, 'error');
      }
      const conflictCount = this.opts.stateDB.countConflicted();
      this.opts.statusBar.setSyncComplete(
        summary.uploadedCount, summary.downloadedCount,
        conflictCount, summary.errorCount,
      );
      // Result display is owned by the status bar surface: StatusBarItem on desktop, and
      // NoticeStatusBar (a result toast) on mobile, both via setSyncComplete above. Genuine
      // failures still surface via the catch-block notice / NextcloudErrorParser.
    }
  }

  /**
   * Feature 065 (issue #25): write every collected per-file failure to the debug log.
   *
   * The summary line alone carries only `err=<count>`. That reporter's log said `err=162` and named
   * none of the 162 paths, so the log — the one artefact a user can hand over — could not locate a
   * single failure. The entries already exist for the status dialog; this puts them where they can
   * be shared.
   *
   * Deliberately uncapped: a truncated list reads as "that was all of them" when it wasn't. Only
   * path and message go in, never the server response body, because these logs get pasted into
   * public issues (NetworkError keeps the body off `message` for the same reason).
   */
  /** @see SyncJournal.logSessionErrors */
  private logSessionErrors(summary: SyncSessionSummary): void {
    this.journal.logSessionErrors(summary);
  }

  // ── Single-file lightweight operations (used by watch mode) ─────────────────
  // These avoid a full vault scan / remote REPORT and only touch the one file.

  /**
   * Feature 046: reflect watch-mode (immediate) propagation on the status bar. Each in-flight
   * single-file/folder op shows "syncing"; when the last one finishes the bar returns to idle. Guarded
   * by `!this.running` so it never fights a concurrent full sync (which owns the status during its run).
   */
  // Delegators to the watch operations (feature 074). These are the plugin's watcher entry points,
  // so they stay on the engine's public surface; the connection is resolved inside the module.

  /** @see WatchOperations.syncSingleFile */
  syncSingleFile(path: string): Promise<void> {
    return this.watch.syncSingleFile(path);
  }

  /** @see WatchOperations.drainPending */
  private drainWatchPending(): Promise<void> {
    return this.watch.drainPending();
  }

  /** @see WatchOperations.deleteSingleFile */
  deleteSingleFile(path: string): Promise<void> {
    return this.watch.deleteSingleFile(path);
  }

  /** @see WatchOperations.renameSingleFile */
  renameSingleFile(oldPath: string, newPath: string): Promise<void> {
    return this.watch.renameSingleFile(oldPath, newPath);
  }

  /** @see WatchOperations.createSingleFolder */
  createSingleFolder(path: string): Promise<void> {
    return this.watch.createSingleFolder(path);
  }

  /** @see WatchOperations.deleteSingleFolder */
  deleteSingleFolder(path: string): Promise<void> {
    return this.watch.deleteSingleFolder(path);
  }

  /** @see WatchOperations.renameSingleFolder */
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

  /** Persist any pending debounced state save now (call from the plugin's onunload). */
  async flushState(): Promise<void> {
    await this.opts.stateDB.flush();
    await this.opts.baseStore?.flush();
    await this.opts.cleanSideStore?.flush();
  }

  /**
   * Feature 038: record the last-synced body of `path` as the 3-way merge base, but ONLY for Auto
   * Merge File types (text) — bases for binary / Other Files are pointless and skipped (FR-005).
   * Called at every convergence point (download / upload / clean merge / one-side-wins / initial
   * seed). The read side (handleConflict) uses the same `isAutoMergeFileType` classification so the
   * two never disagree (FR-009). Persistence is coalesced via the store's debounced save.
   */
  /**
   * Feature 049: the effective mass-delete breaker limit for `tracked` items, honouring the user's
   * `massDeleteLimit` setting. -1 = the automatic dynamic limit (safe default); 0 = unlimited (breaker
   * off, opt-in); N > 0 = a fixed absolute limit. Guards absence-based bulk deletion from a partial
   * remote listing.
   */
  private effectiveMassDeleteLimit(tracked: number): number {
    return effectiveMassDeleteLimit(this.opts.settings.massDeleteLimit, tracked);
  }

  /** @see MergeBaseRecorder.record */
  private recordMergeBase(path: string, content: string): void {
    this.mergeBase.record(path, content);
  }

  /** @see MergeBaseRecorder.drop */
  private dropMergeBase(path: string): void {
    this.mergeBase.drop(path);
  }

  /**
   * Feature 044: capture the two CLEAN sides of a note at conflict-detection time, before a marker
   * write overwrites them. Only called on the marker-write path (clean:false). Metrics are the clean
   * sides' own mtime/size, used later by the Latest/Biggest force-resolution choices.
   */
  // Delegators to the resolution service (feature 074). The connection is resolved here because the
  // client and upload strategy are created lazily and can be replaced.

  /** @see ResolutionService.captureCleanSides */
  private captureCleanSides(
    path: string, local: string, remote: string,
    localMtime: number, localSize: number, remoteInfo: RemoteFileInfo,
  ): void {
    this.resolution.captureCleanSides(path, local, remote, localMtime, localSize, remoteInfo);
  }

  /** @see ResolutionService.dropCleanSnapshot */
  private dropCleanSnapshot(path: string): void {
    this.resolution.dropCleanSnapshot(path);
  }

  /** @see ResolutionService.sweepResolvedSnapshots */
  private sweepResolvedSnapshots(): void {
    this.resolution.sweepResolvedSnapshots();
  }

  /** @see ResolutionService.cleanSideMetrics */
  cleanSideMetrics(path: string): CleanSideMetrics | null {
    return this.resolution.cleanSideMetrics(path);
  }

  /** @see ResolutionService.applyCleanRemote */
  async applyCleanRemote(path: string): Promise<void> {
    return this.resolution.applyCleanRemote(await this.connection(), path);
  }

  /** @see ResolutionService.applyCleanLocal */
  async applyCleanLocal(path: string): Promise<void> {
    return this.resolution.applyCleanLocal(await this.connection(), path);
  }

  /**
   * Feature 056: resolve one skipped mass-delete-breaker directory candidate immediately (not
   * deferred to the next sync). `category` is which side reconcileDirectories would have deleted from
   * (`deleteRemote`: local absent/remote present; `trashLocal`: local present/remote absent). `choice`
   * mirrors the file-conflict force-resolution meaning: "remote" always means "make local match
   * remote", "local" always means "make remote match local" — expressed here as directory create/
   * delete instead of file push/pull. Recreated directories are tracked with `remoteFileId: null`
   * (the same self-healing pattern already used by createSingleFolder/renameSingleFolder — the next
   * full sync's real PROPFIND fills in the real id once both sides exist again). Throws on failure
   * without touching StateDB (the caller, `resolveAllSkippedDirs`, isolates per-path failures).
   */
  /** @see DirectoryReconciler.resolveSkippedDir */
  async resolveSkippedDir(
    path: string,
    category: 'deleteRemote' | 'trashLocal',
    choice: 'remote' | 'local',
  ): Promise<void> {
    const { client } = await this.ensureClient();
    return this.directories.resolveSkippedDir(client, path, category, choice);
  }

  /**
   * Feature 056: bulk-apply one choice to every path in the current `(dir mass-delete breaker)`
   * session error's `dirBreakerSkipped`, sequentially (mirrors applyBulkForceResolution's sequencing
   * and per-path failure isolation — a per-path rejection is tallied, not thrown). On completion,
   * mutates `this.lastSummary.errors` IN PLACE: removes the breaker entry once every path resolved,
   * or narrows its `dirBreakerSkipped` to only the still-failed paths otherwise — so the next
   * `getStatusReport()` (which returns the same `lastSummary` reference, not a clone) reflects the
   * outcome immediately, without waiting for a fresh full sync. Refuses to run while a full sync is
   * in progress (`this.running`): a concurrent reconcileDirectories reads/writes the same StateDB
   * directory rows this touches, so racing it is worth refusing outright rather than risking a
   * mkdir-then-immediately-trash flicker on the same path.
   */
  /**
   * @see DirectoryReconciler.resolveAllSkippedDirs
   *
   * Refuses to run while a full sync is in progress: a concurrent reconcileDirectories reads and
   * writes the same StateDB directory rows this touches, so racing it is worth refusing outright
   * rather than risking a mkdir-then-immediately-trash flicker on the same path.
   */
  async resolveAllSkippedDirs(choice: 'remote' | 'local'): Promise<{ resolved: number; failed: number }> {
    if (this.running) throw new Error('Cannot resolve skipped directories — sync in progress');
    const { client } = await this.ensureClient();
    return this.directories.resolveAllSkippedDirs(client, this.lastSummary, choice);
  }


  /**
   * Two-Phase Termination — phase 1: signal an in-flight sync to stop pulling new work. Idempotent
   * and safe to call any time; the running sync's finally block still persists state (phase 2).
   */
  requestStop(): void {
    this.cancelled = true;
  }

  /**
   * Abort an in-flight sync and wait for it to fully settle (including its finally state save) so a
   * follow-up maintenance reset cannot interleave with the run's persistence. Idempotent and safe to
   * call when idle (resolves immediately). The run handles its own errors, so awaiting never throws.
   */
  async abortAndWait(): Promise<void> {
    this.requestStop();
    const run = this.currentRun;
    if (run) {
      try { await run; } catch { /* runSyncSession swallows its own errors */ }
    }
  }

  /**
   * Maintenance action: abort any in-flight sync, then reset this device's tracking index ("Vault
   * index") to the first-install empty state. The next sync then runs as a first-run sync. No vault
   * or remote file is touched.
   */
  async resetIndex(): Promise<void> {
    await this.abortAndWait();
    await this.opts.stateDB.reset();
  }

  /**
   * Maintenance action (feature 045): compute a Pull-mirror plan — what to download and what local
   * files/folders to delete so this device exactly matches the remote. Side-effect free (reads only),
   * so the caller can show the download/delete counts for confirmation before applying.
   *
   * Safety gate (FR-009): the authoritative listing is a REAL PROPFIND (`getFiles('')`, no root-ETag
   * short-circuit). If it fails, the plan is `ok:false` with empty lists so the caller performs zero
   * deletions. The mass-delete breaker's COUNT limit is intentionally NOT consulted here (FR-008): the
   * user explicitly declared the remote authoritative; this path simply never calls `massDeleteLimit`.
   */
  /** @see MirrorService.planRemoteMirror */
  planRemoteMirror(onPhase?: (label: string) => void): Promise<MirrorPlan> {
    return this.mirror.planRemoteMirror(onPhase);
  }

  /**
   * Apply a Pull-mirror plan produced by {@link planRemoteMirror}: download everything the remote has
   * (or that differs), delete local-only files/folders (via the user's Obsidian "Deleted files"
   * setting — recoverable), then reconcile StateDB to the remote so the next normal sync converges to
   * zero diff (FR-011 / SC-002). The caller must pass an `ok:true` plan and have aborted in-flight sync.
   */
  /**
   * @see MirrorService.applyRemoteMirror
   *
   * Uses the ALREADY-resolved client rather than connecting: apply always follows a plan, and
   * planRemoteMirror is what connects. Adding an ensureClient here would introduce a connect step
   * where the code never had one.
   */
  applyRemoteMirror(
    plan: MirrorPlan, onProgress?: (done: number, total: number) => void,
  ): Promise<MirrorResult> {
    return this.mirror.applyRemoteMirror(this.client!, plan, onProgress);
  }

  getLastSessionSummary(): SyncSessionSummary | null {
    return this.lastSummary;
  }

  /**
   * When the last sync finished, as a persisted wall-clock timestamp (0 if none ever has).
   *
   * Unlike {@link getLastSessionSummary}, which only knows about this process, this survives restarts
   * and is stamped by every sync whatever started it. Feature 079's resume trigger uses it as its
   * cooldown baseline, which is also what stops it from firing on top of the startup sync.
   */
  getLastSyncTime(): number {
    return this.opts.stateDB.getLastSyncTime();
  }

  /**
   * Snapshot for the status-bar dialog: last session summary plus the current lists of
   * conflicted files and files queued for retry (the two things the status bar counts).
   */
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

  /** @see ResolutionService.getUnresolvedConflictCount */
  getUnresolvedConflictCount(): Promise<number> {
    return this.resolution.getUnresolvedConflictCount();
  }

  /** @see ResolutionService.compareWithRemote */
  async compareWithRemote(path: string): Promise<RemoteCompareResult> {
    const { client } = await this.ensureClient();
    return this.resolution.compareWithRemote(client, path);
  }


  /** @see ResolutionService.pushLocalToRemote */
  async pushLocalToRemote(path: string): Promise<void> {
    return this.resolution.pushLocalToRemote(await this.connection(), path);
  }

  /** @see ResolutionService.pullRemoteToLocal */
  async pullRemoteToLocal(path: string): Promise<void> {
    const { client } = await this.ensureClient();
    return this.resolution.pullRemoteToLocal(client, path);
  }

  /** Binds the configured Auto Merge File types for {@link isTextEligible}. */
  private textEligible(path: string): boolean {
    return isTextEligible(path, this.opts.settings.autoMergeFileTypes);
  }

  /** @see ResolutionService.fetchRemoteInfo */
  private fetchRemoteInfo(path: string): Promise<RemoteFileInfo | null> {
    return this.resolution.fetchRemoteInfo(this.client!, path);
  }

  /**
   * The ALREADY-resolved client and upload strategy. Deliberately does not connect: the conflict
   * paths run inside a sync that has connected, and adding an ensureClient here would introduce a
   * connect step where the code never had one.
   */
  private currentConnection(): { client: IWebDAVClient; uploadStrategy: IUploadStrategy } {
    return { client: this.client!, uploadStrategy: this.uploadStrategy! };
  }

  /** The connected client plus its upload strategy, for services that need both. */
  private async connection(): Promise<{ client: IWebDAVClient; uploadStrategy: IUploadStrategy }> {
    const { client } = await this.ensureClient();
    return { client, uploadStrategy: this.uploadStrategy! };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  // Delegators to the session modules (feature 074). They neither bind nor decide; they keep the
  // ~70 existing call sites — and the suites that drive them through the engine — unchanged.

  /** @see SyncJournal.newSummary */
  private initSummary(): SyncSessionSummary {
    return this.journal.newSummary();
  }

  /** @see SyncJournal.recordError */
  private recordError(
    summary: SyncSessionSummary,
    path: string,
    err: unknown,
    skippedPaths?: { all: string[] },
    dirBreakerSkipped?: { deleteRemote: string[]; trashLocal: string[] },
  ): void {
    this.journal.recordError(summary, path, err, skippedPaths, dirBreakerSkipped);
  }

  /** @see SyncJournal.recordHistory */
  private recordHistory(path: string, op: SyncFileOp, message?: string, detail?: SyncHistoryDetail): void {
    this.journal.recordHistory(path, op, message, detail);
  }

  /** First-ever sync: full scan → build plan → execute. */
  private async initialSync(summary: SyncSessionSummary): Promise<void> {
    const client = this.client!;
    const remoteFiles = await client.getFiles('');
    const localFiles = await this.scanLocalFiles();

    // Populate missing server-side checksums (computed by the server, no download) so that
    // files already identical on both sides are recognised as unchanged instead of conflicts.
    await this.remoteListing.resolveRemoteChecksums(client, remoteFiles, localFiles);

    const plan = await this.buildInitialPlan(localFiles, remoteFiles);
    // No recorded state yet, so every local file the server lacks is planned as an UPLOAD —
    // including files that were deleted on another device. This is a resurrection path; log the
    // plan (and the would-be uploads) so a captured log shows whether a "deleted" file is pushed back.
    void this.opts.logger?.log(
      `sync: INITIAL sync (empty state) plan — up=${plan.uploads.length} down=${plan.downloads.length} ` +
      `unchanged=${plan.unchanged.length} conflicts=${plan.conflicts.length}. ` +
      `uploads(resurrection candidates)=[${plan.uploads.slice(0, 30).join(', ')}${plan.uploads.length > 30 ? ', …' : ''}]`,
      'verbose',
    );

    await this.executePlan(plan, remoteFiles, summary, localFiles);

    // Initial sync is always a complete listing → reconcile directory create/delete (DP).
    await this.reconcileDirectories(summary);

    // Save sync-token
    const token = await client.getSyncToken();
    this.opts.stateDB.setSyncToken(token);
  }

  /** Incremental sync using sync-token (falls back to full PROPFIND on 410) */
  private async incrementalSync(summary: SyncSessionSummary): Promise<void> {
    const client = this.client!;
    let remoteFiles: RemoteFileInfo[];
    // True when remoteFiles is the COMPLETE remote listing (so absence implies a remote deletion).
    // False in the token path, where remoteFiles is only the partial set of changed files.
    let isFullScan = false;
    // Set (non-null) when the full scan was short-circuited (spec 023): the directory listing rebuilt
    // from State, fed to reconcileDirectories so it too skips getDirectories('').
    let fullScanCachedDirs: RemoteDirInfo[] | null = null;

    const existingToken = this.opts.stateDB.getSyncToken();
    if (existingToken) {
      try {
        const changes = await client.getChanges(existingToken);
        this.opts.stateDB.setSyncToken(changes.newSyncToken);
        remoteFiles = changes.modified;
        void this.opts.logger?.log(`sync: incremental via token (modified=${changes.modified.length}, remote-deleted=${changes.deleted.length})`);

        // Detect and apply remote renames (fileId-based) before processing deletions,
        // so a rename is not misidentified as delete + new-upload.
        const rt = this.getOrCreateRenameTracker();
        const remoteRenames = rt.detectRemoteRenames(remoteFiles);
        for (const [oldPath, newPath] of remoteRenames) {
          await rt.applyRemoteRename(oldPath, newPath);
        }

        // Handle deletions
        for (const deletedPath of changes.deleted) {
          await this.processRemoteDeletion(deletedPath, summary);
        }
      } catch (err) {
        if (err instanceof SyncTokenExpiredError) {
          // Fallback to full scan (root-ETag short-circuit may rebuild the listing from State — spec 023).
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
      // No prior token (the common Nextcloud case: sync-collection REPORT is unsupported, spec §18 F1,
      // so every sync lands here). Root-ETag short-circuit may rebuild the listing from State (spec 023).
      const listing = await this.obtainFullScanListing(client);
      remoteFiles = listing.remoteFiles;
      fullScanCachedDirs = listing.cachedDirs;
      isFullScan = true;
      const token = await client.getSyncToken();
      this.opts.stateDB.setSyncToken(token);
      void this.opts.logger?.log(`sync: FULL SCAN, no prior token (remote=${remoteFiles.length}, shortCircuit=${listing.cachedDirs != null}, nextToken=${token ? 'obtained' : 'NULL'}). Remote deletions detected by absence (full-scan reconciliation)`);
    }

    // Retry queue files
    const retried = this.retryQueue.splice(0);
    summary.retriedFiles = retried;

    // Process each remote file
    const eligible = remoteFiles.filter(f => !this.isSystemExcluded(f.path));
    this.syncProgress = { processed: 0, total: eligible.length };
    if (eligible.length > 0) this.opts.statusBar.setProgress(0, eligible.length);
    // Bounded-parallel (P1-A): each remote file is processed by one worker; uploads to the same
    // directory are serialized to avoid 423s. processFileWithRetry already handles its own errors.
    await this.runFileBatch(
      eligible,
      (r) => r.path,
      (r) => r.size,
      async (r) => { await this.processFileWithRetry(r, summary); this.tickProgress(); },
      true,
    );

    // Process local modifications (files in stateDB not covered by remote changes)
    await this.processLocalModifications(remoteFiles, summary, isFullScan);

    // Reconcile directory create/delete only from a COMPLETE listing (full scan). The token path's
    // remoteFiles is a partial diff, from which directory absence cannot be read as a deletion.
    // On a short-circuited scan, feed the State-rebuilt directory list so getDirectories('') is skipped.
    if (isFullScan) await this.reconcileDirectories(summary, fullScanCachedDirs ?? undefined);

    // Feature 044 self-heal: drop captured clean sides for any path that converged this sync (no longer
    // conflicted), keeping snapshots bounded to currently-conflicted files regardless of the path taken.
    this.sweepResolvedSnapshots();

    // Root-ETag short-circuit SAFETY (spec 023 §8a.5): only ARM the short-circuit when this scan fully
    // converged (StateDB now mirrors the remote). If any file was left UNRESOLVED — a conflict skipped
    // by the 'error' policy, conflict markers, an error, or a queued retry — StateDB.remoteId may stay
    // stale relative to the actual remote while the remote root ETag is unchanged (no push happened).
    // A later short-circuit would then rebuild the remote listing from that stale State and silently
    // "resolve" the unresolved remote change as local-wins, OVERWRITING the other device's edit (data
    // loss). Invalidating the stored root ETag forces a real full scan next time, so the conflict is
    // re-detected instead. Self-healing: convergence (no conflicts) re-arms it on a later scan.
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
        // Continue with next file (FR-015)
      } else {
        // Local I/O errors (ENOENT, EACCES, etc.) must not abort the entire session.
        console.warn(`[SyncEngine] Error syncing ${remote.path}:`, err);
        void this.opts.logger?.log(`sync: error on ${remote.path} — ${(err as Error).message}`, 'error');
        this.recordError(summary, remote.path, err);
      }
    }
  }

  /**
   * Local-unchanged fast-path (P0-A). Binds the ambient clock and the last-sync time; the decision
   * itself — including the safety-window guard around both — lives in `./policy`, where its
   * boundaries can be exercised without standing up an engine. Both are passed as accessors so the
   * state DB is still consulted only when the check gets that far (see the policy function).
   */
  private isLocallyUnchanged(base: FileState, stat: { mtime: number; size: number }): boolean {
    return isLocallyUnchangedPure(base, stat, {
      now: () => Date.now(),
      lastSyncTime: () => this.opts.stateDB.getLastSyncTime(),
    });
  }

  /** @see withLocalSignature (src/data/localSignature.ts) */
  private withLocalSignature(fs: FileState, remoteMtime?: number | null): Promise<FileState> {
    return withLocalSignature(this.opts.localAdapter, fs, remoteMtime);
  }

  /**
   * Run per-file `worker`s with bounded concurrency (P1-A). Concurrency is capped by the configured
   * `networkConcurrency` (count) AND by total in-flight bytes (ByteSemaphore), because `requestUrl`
   * buffers whole bodies in memory and a count-only cap would OOM on large files (mobile budget is
   * smaller). When `serializeByDir` is true, workers whose paths share a parent directory run
   * sequentially (different directories run in parallel) to avoid Nextcloud directory-lock 423s.
   *
   * Distinct paths are processed by exactly one worker each, and StateDB get/set/delete are synchronous
   * map ops, so per-file state mutations across different paths cannot interleave-corrupt; save() is
   * already serialized by StateDB.saveChain. The byte size is acquired before the worker reads the
   * file. A worker that throws is reported by the caller-supplied worker itself (it must not reject
   * the batch — workers here are expected to handle their own errors, mirroring the prior sequential
   * try/catch per file).
   */
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
    // Per-parent-directory promise chains: each new same-dir task waits on the previous one.
    const dirChains = new Map<string, Promise<void>>();

    const tasks = items.map((it) => limiter(async () => {
      // Two-Phase Termination: once a stop is requested, queued workers no-op so the batch drains
      // without launching further network operations.
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
      // Fast-path: skip reading/hashing when the post-write stat signature still matches (P0-A).
      // The signature (localMtime/localSize) is what we observed right after our own last write, so
      // it is valid on mobile where the on-disk mtime never equals the remote mtime. Only when the
      // signature says "changed" (or is absent, or the file was touched within the safety window) do
      // we read + hash to confirm a real content change against base.localHash.
      if (!this.isLocallyUnchanged(base, localStat)) {
        const buf = await this.opts.localAdapter.readBinary(remote.path);
        localHash = await sha256(buf);
        localChanged = localHash !== base.localHash;
      }
    } else if (localStat) {
      // Feature 063 (issue #23): the file exists on BOTH sides but we have NO recorded baseline, so
      // there is nothing to prove it came from this remote. Treating "no base" as "local unchanged"
      // (the old behaviour, since this branch simply did not exist) let the !localChanged &&
      // remoteChanged arm below download straight over a local edit — silent data loss, e.g. when the
      // same note was created independently on two devices. Hash the local body and treat it as
      // CHANGED unless it provably matches the remote, so the both-changed arm resolves it as a
      // conflict — exactly what initialSync already does via plan.conflicts.
      const buf = await this.opts.localAdapter.readBinary(remote.path);
      localHash = await sha256(buf);
      if (idType === 'sha256' && localHash === remoteId) {
        // Provably the same bytes on both sides: the only thing missing was the record. Seed it and
        // converge without moving any data. Identity is asserted from the SERVER-SUPPLIED CHECKSUM
        // only — an ETag is an opaque, server-defined token that cannot be recomputed from local
        // content, so trusting it here would reintroduce the very overwrite this branch prevents.
        // Without a checksum we fall through to conflict resolution, which fetches the remote and
        // compares the real bytes (a wasted round-trip at worst, never data loss).
        void this.opts.logger?.log(`sync: untracked file matches remote checksum → seeding state, no transfer → ${remote.path}`);
        this.opts.stateDB.setFile(await this.withLocalSignature({
          path: remote.path, localHash, remoteId, idType,
          size: localStat.size, mtime: remote.lastModified || localStat.mtime,
          remoteFileId: remote.fileId, isConflicted: false,
        }, remote.lastModified));
        return;
      }
      localChanged = true;
    } else {
      localChanged = false; // new from remote
    }

    // Previously synced (base exists) but now gone locally → this device deleted it. Propagate the
    // deletion instead of re-downloading it (which resurrects the file) or stranding it on the server.
    if (!localStat && base) {
      await this.applyLocalDeletion(remote, base, remoteId, idType, summary);
      return;
    }

    if (!remoteChanged && !localChanged) {
      // A genuinely converged baseline records the SAME size on both sides. If the
      // recorded base.size disagrees with the actual local size while the ids still
      // "match", the baseline is internally inconsistent (e.g. a prior resolution
      // recorded base.localHash from one side but base.size/remoteId from the other).
      // This happens on servers that supply no content checksum (idType==='etag'),
      // where convergence cannot be proven by hashing alone. Treating it as
      // "unchanged" hides a real local/remote divergence forever, so reconcile it
      // via conflict resolution (downloads remote, compares real content, honors the
      // configured policy) instead of silently skipping.
      if (base && localStat && localStat.size !== base.size) {
        void this.opts.logger?.log(
          `sync: divergent baseline detected (idType=${idType}, localSize=${localStat.size}, baseSize=${base.size}) → reconciling ${remote.path}`,
        );
        await this.handleConflict(remote.path, base, remote, remoteId, idType, summary);
        return;
      }
      // Both sides match what we last synced → the file has converged. If it was previously
      // flagged as conflicted (e.g. an error-policy skip or a prior markers write that has since
      // been resolved), clear that stale flag now so the conflict count does not stay stuck.
      if (base?.isConflicted) {
        this.opts.stateDB.setFile({ ...base, isConflicted: false });
      }
      return; // Unchanged
    }

    if (localChanged && !remoteChanged) {
      try {
        await this.uploadFile(remote.path, localHash, remoteId, idType, remote, summary);
      } catch (err) {
        // P1-B: If-Match 412 means the remote changed between our PROPFIND/REPORT and the PUT — treat
        // it as a both-sides conflict (download remote + resolve) instead of overwriting (lost update).
        if (err instanceof PreconditionFailedError) {
          void this.opts.logger?.log(`upload: If-Match 412 (remote changed during sync) → conflict → ${remote.path}`);
          await this.handleConflict(remote.path, base, remote, remoteId, idType, summary);
        } else {
          throw err;
        }
      }
    } else if (!localChanged && remoteChanged) {
      if (this.deferIfBeingEdited(remote.path, 'download')) return;
      await this.downloadFile(remote, remoteId, idType, summary);
    } else {
      // Both changed: Conflicted
      if (this.deferIfBeingEdited(remote.path, 'conflict')) return;
      await this.handleConflict(remote.path, base, remote, remoteId, idType, summary);
    }
  }

  /**
   * Hold back a REMOTE -> LOCAL write while the user is typing into that file, and queue the path
   * so the next sync decides again.
   *
   * The whole decision is deferred, not just the write. Writing is the last step of a sequence that
   * also records a new baseline, and skipping only the write would leave the state DB claiming a
   * body the file does not hold — the failure feature 063 already paid for once. Deferring costs a
   * few seconds: the debounce window closes shortly after typing stops, and the queued path is
   * re-evaluated with fresh state.
   *
   * Uploads are deliberately NOT deferred. They read the file and leave it alone, so there is
   * nothing to collide with, and holding them back would make "Sync on file change" stop doing the
   * one thing it exists for.
   */
  private deferIfBeingEdited(path: string, what: 'download' | 'conflict'): boolean {
    if (!this.opts.isBeingEdited?.(path)) return false;
    void this.opts.logger?.log(`${what}: deferred — "${path}" is being edited right now`);
    this.retryQueue.push(path);
    return true;
  }

  /**
   * A previously-synced file is gone locally → propagate the local deletion to the server, unless
   * the server copy diverged from what we last synced (then restore it so a remote edit is not lost).
   * The decision uses the server-side checksum (recalc, no download) for reliability; deletions go
   * to the Nextcloud trashbin (recoverable).
   */
  /** @see DeletionService.applyLocalDeletion */
  private applyLocalDeletion(
    remote: RemoteFileInfo, base: FileState, remoteId: string, idType: FileState['idType'],
    summary: SyncSessionSummary,
  ): Promise<void> {
    return this.deletion.applyLocalDeletion(this.client!, remote, base, remoteId, idType, summary);
  }

  // Delegators to the transfer service (feature 074): the client and upload strategy are resolved
  // here (they are created lazily and can be replaced) and handed in on every call.

  /** @see TransferService.uploadFile */
  private uploadFile(
    path: string, localHash: string, remoteId: string,
    idType: FileState['idType'], remote: RemoteFileInfo,
    summary: SyncSessionSummary,
  ): Promise<void> {
    return this.transfer.uploadFile(
      this.client!, this.uploadStrategy!, path, localHash, remoteId, idType, remote, summary,
    );
  }


  // ── US2: Version history ───────────────────────────────────────────────────

  /** @see VersionService.listVersions */
  async listVersions(path: string): Promise<FileVersion[]> {
    const { client, features } = await this.ensureClient();
    return this.versions.listVersions(client, features, path);
  }

  /** @see VersionService.restoreVersion */
  async restoreVersion(path: string, version: FileVersion): Promise<void> {
    const { client, features } = await this.ensureClient();
    return this.versions.restoreVersion(client, features, path, version);
  }

  /** @see TransferService.acquireLock */
  private acquireLock(path: string): Promise<string | null> {
    return this.transfer.acquireLock(this.client!, path);
  }

  /** @see TransferService.releaseLock */
  private releaseLock(path: string, token: string | null): Promise<void> {
    return this.transfer.releaseLock(this.client!, path, token);
  }

  /** @see TransferService.isRemoteOverSizeLimit */
  private isRemoteOverSizeLimit(remote: RemoteFileInfo): boolean {
    return this.transfer.isRemoteOverSizeLimit(remote);
  }

  /** @see TransferService.warnDownloadSkipped */
  private warnDownloadSkipped(path: string, sizeBytes: number): void {
    this.transfer.warnDownloadSkipped(path, sizeBytes);
  }

  /** @see TransferService.downloadFile */
  private downloadFile(
    remote: RemoteFileInfo, remoteId: string,
    idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    return this.transfer.downloadFile(this.client!, remote, remoteId, idType, summary);
  }

  // Delegators to the conflict applier (feature 074). Existing suites drive both of these through
  // the engine, which is where the wiring gets proven.

  /** @see ConflictApplier.handleConflict */
  private handleConflict(
    path: string, base: FileState | undefined, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.handleConflict(
      this.currentConnection(), path, base, remote, remoteId, idType, summary,
    );
  }

  /** @see ConflictApplier.resolveByPreferLocal */
  private resolveByPreferLocal(
    path: string, remote: RemoteFileInfo, summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.resolveByPreferLocal(this.currentConnection(), path, remote, summary);
  }

  /** @see ConflictApplier.resolveByPreferRemote */
  private resolveByPreferRemote(
    path: string, remote: RemoteFileInfo, remoteData: ArrayBuffer,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.resolveByPreferRemote(path, remote, remoteData, remoteId, idType, summary);
  }

  /** @see ConflictApplier.resolveByWrite */
  private resolveByWrite(
    path: string, content: string, clean: boolean, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], localMtimeBefore: number, summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.resolveByWrite(
      this.currentConnection(), path, content, clean, remote, remoteId, idType, localMtimeBefore, summary,
    );
  }


  /** @see DeletionService.processRemoteDeletion */
  private processRemoteDeletion(path: string, summary: SyncSessionSummary): Promise<void> {
    return this.deletion.processRemoteDeletion(path, summary);
  }

  private async processLocalModifications(
    remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary, isFullScan = false,
  ): Promise<void> {
    const remotePathSet = new Set(remoteFiles.map(f => f.path));

    // Scan local files in scope for sync (both new and modified).
    const localStats = new Map<string, { size: number; mtime: number }>();
    await this.collectLocalStats('', localStats);
    // The config folder is not scanned recursively, so explicitly inject the enabled
    // config-sync category files (bookmarks, themes/snippets, appearance, etc.).
    for (const p of await this.configSync.enumerateIncludedPaths()) {
      const st = await this.opts.localAdapter.stat(p);
      if (st) localStats.set(p, { size: st.size, mtime: st.mtime });
    }

    // Pre-filter with the cheap, synchronous checks (already handled remotely; signature fast-path),
    // then upload the survivors with bounded concurrency (P1-A). The content-unchanged hash check
    // stays inside the worker (it requires reading the file).
    const uploadCandidates = [...localStats.entries()].filter(([path, st]) => {
      if (remotePathSet.has(path)) return false; // already handled in the remote-changes loop
      const base = this.opts.stateDB.getFile(path);
      // Fast-path (P0-A): skip known files whose post-write stat signature is unchanged — no read,
      // no hash. Replaces the old `st.mtime <= base.mtime` filter, which was always false on mobile
      // (setMtime no-op) and forced a full-vault rehash every sync.
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
        if (base && localHash === base.localHash) return; // content unchanged
        // For new files, use the local hash as remoteId (= the server checksum after upload).
        const remoteId = base?.remoteId ?? localHash;
        const idType: FileState['idType'] = base?.idType ?? 'sha256';
        void this.opts.logger?.log(`upload: ${path} (${base ? 'modified, re-upload' : 'new local file'})`);
        try {
          await this.uploadFile(
            path, localHash, remoteId, idType,
            { path, fileId: base?.remoteFileId ?? null, checksum: null, etag: null, size: st.size, lastModified: st.mtime },
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

    // Detect local renames and deletions: files in StateDB that are no longer in localStats.
    const rt = this.getOrCreateRenameTracker();
    // Build a map of new (unsynced) local files for hash-based rename detection.
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

    // Remaining missing paths (not renames) are genuine local deletions → delete from remote.
    for (const path of missingPaths) {
      if (localRenames.has(path)) continue; // handled as rename above
      const fileState = this.opts.stateDB.getFile(path);
      if (!fileState) continue;
      void this.opts.logger?.log(`delete-remote: locally deleted, propagating to server → ${path}`);
      try {
        await this.client!.deleteFile(path, fileState.remoteId);
        summary.deletedCount++;
        this.recordHistory(path, 'deleted');
      } catch (err) {
        if (err instanceof NetworkError && err.status === 404) {
          // Already gone from remote — StateDB cleanup is sufficient.
        } else {
          console.warn(`[SyncEngine] Failed to delete ${path} from remote:`, err);
          this.recordError(summary, path, err);
          // BUG G1-2 fix: on a real failure, keep the StateDB tracking entry so the next sync retries
          // the delete — dropping it here would make the next sync see the still-present remote file
          // as "new" and re-download it, silently reverting the user's local deletion.
          continue;
        }
      }
      this.opts.stateDB.deleteFile(path);
      this.dropMergeBase(path); // feature 038: local deletion propagated to remote → drop merge base
    }

    // Full-scan only: detect REMOTE deletions by absence. A previously-synced file still present
    // locally but missing from the COMPLETE remote listing was deleted on the server → remove it
    // locally (via the user's "Deleted files" setting; recoverable). This path is defended against
    // bad inputs (a truncated/partial listing) because acting on it would silently destroy data.
    if (isFullScan && remotePathSet.size > 0) {
      // 1) Build candidates, comparing real content (NOT mtime) so a local edit that did not bump
      //    mtime is never silently lost — same content-vs-base check the upload loop uses.
      const candidates: string[] = [];
      for (const fileState of this.opts.stateDB.getAllFiles()) {
        const path = fileState.path;
        if (this.isSystemExcluded(path) || remotePathSet.has(path)) continue;
        if (!localStats.has(path)) continue; // absent locally too — handled by the missing-paths loop
        const data = await this.opts.localAdapter.readBinary(path);
        if (await sha256(data) !== fileState.localHash) continue; // modified locally → preserve & re-upload
        candidates.push(path);
      }

      // 2) Circuit breaker: a healthy full listing rarely loses a large fraction of the vault at once.
      //    If too many files look "remotely deleted", assume a partial/failed listing and refuse.
      const tracked = this.opts.stateDB.getAllFiles().length;
      const limit = this.effectiveMassDeleteLimit(tracked);
      if (candidates.length > limit) {
        void this.opts.logger?.log(`delete-local: SKIPPED ${candidates.length} absence-deletions — exceeds safety limit (${limit}); likely a partial remote listing`);
        new Notice(`⚠️ ${candidates.length} files look deleted on the server — skipped to avoid mass deletion. Re-sync to retry.`, 10000);
        // Tripping the breaker is an UNRESOLVED state: record it as an error so (a) the UI surfaces it
        // and (b) the root-ETag short-circuit convergence gate (spec 023 §8a.5) invalidates the stored
        // etag — otherwise the next sync would short-circuit on stale State and the "re-sync to retry"
        // advice would never re-evaluate the deletions (the breaker would be stuck silently).
        this.recordError(summary, '(mass-delete breaker)', new Error(`Skipped ${candidates.length} absence-deletions — exceeds safety limit ${limit}`), {
          all: candidates,
        });
        return;
      }

      // 3) Re-verify each candidate is really gone (targeted PROPFIND 404), so a file merely missing
      //    from the bulk listing is never deleted locally on a false negative.
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

  /**
   * Directory reconciliation (DP). Directories are FIRST-CLASS, contentless entities, symmetric
   * with files — a directory is NEVER deleted merely because it holds no file (an empty directory
   * is a legitimate thing a user may keep). Instead, existence differences are propagated like file
   * creates/deletes, tracked in the StateDB so absence means a real deletion, not "never existed":
   *
   *   - local-only & untracked   → the user created it here   → MKCOL on the remote (incl. EMPTY dirs)
   *   - remote-only & untracked  → created on another device   → mkdir locally
   *   - tracked, now local-absent → the user deleted it here   → DELETE the remote collection
   *   - tracked, now remote-absent→ deleted on another device  → trash it locally
   *   - present both sides        → record/keep tracking
   *   - absent both sides         → drop stale tracking
   *
   * Runs only on a COMPLETE listing (full scan); absence from a partial token diff is not a deletion.
   * Safety mirrors file deletion: a `massDeleteLimit` circuit breaker guards a suspiciously large
   * destructive batch (partial/failed listing); a recursive collection DELETE is preceded by an
   * `isRemoteDirEmpty` probe (children are deleted first by ordering + the earlier file phase) and
   * optionally wrapped in a lock when the user enabled `fileLockingEnabled`; every failure is left
   * for the next sync (self-healing).
   */
  /** @see DirectoryReconciler.reconcileDirectories */
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
      if (!remote) { uploads.push(path); continue; }              // new local file — no hash needed
      if (remote.size !== lf.size) { conflicts.push(path); continue; } // size differs — conflict, no hash
      // Sizes match: hash is needed ONLY to prove "unchanged", and only when the server provided a
      // checksum to compare against. Without a server checksum, or for large files exceeding the
      // size-gate, fall back to conflict resolution without reading the file.
      if (!remote.checksum || lf.size > MAX_HASH_SIZE) { conflicts.push(path); continue; }
      const localHash = await sha256(await this.opts.localAdapter.readBinary(path));
      if (localHash === remote.checksum) unchanged.push(path);
      else conflicts.push(path);
    }
    for (const remote of remoteFiles) {
      if (this.isSystemExcluded(remote.path)) continue; // do not import excluded paths (.obsidian, etc.)
      if (!localFiles.has(remote.path)) downloads.push(remote.path);
    }
    return { uploads, downloads, conflicts, unchanged, deletes: [] };
  }

  private async executePlan(
    plan: InitialSyncPlan, remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary,
    localFiles: Map<string, { size: number; mtime: number }>,
  ): Promise<void> {
    // P0-C: the caller (initialSync) already scanned the vault; reuse the stat map instead of
    // re-scanning here. Hashing is deferred to upload time (or was already done in buildInitialPlan
    // for unchanged files, which use remote.checksum as the authoritative hash).
    const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));
    const actionFiles = plan.uploads.length + plan.downloads.length + plan.conflicts.length;
    this.syncProgress = { processed: 0, total: actionFiles };
    if (actionFiles > 0) this.opts.statusBar.setProgress(0, actionFiles);

    // Bounded-parallel uploads (P1-A); same-directory uploads serialized to avoid 423s.
    await this.runFileBatch(
      plan.uploads,
      (path) => path,
      (path) => localFiles.get(path)?.size ?? 0,
      async (path) => {
        try {
          const lf = localFiles.get(path);
          if (!lf) return;
          const data = await this.opts.localAdapter.readBinary(path);
          // Task 3: no pre-hash in the scan; compute the hash now from the bytes we just read so the
          // recorded state has a real content hash (also reused for the OC-Checksum upload header).
          const localHash = await sha256(data);
          // P1-C: reuse the hash we just computed from THIS exact buffer for the OC-Checksum header
          // (safe — same bytes), so the client doesn't hash the file a second time.
          const outcome = await this.uploadStrategy!.upload(this.client!, path, data, lf.mtime, { precomputedSha256: localHash });
          if (outcome === 'skipped') { this.tickProgress(); return; }
          summary.uploadedCount++;
          this.recordHistory(path, 'uploaded');
          const stat = await this.opts.localAdapter.stat(path);
          this.opts.stateDB.setFile(await this.withLocalSignature({ path, localHash, remoteId: localHash, idType: 'sha256', size: lf.size, mtime: stat?.mtime ?? 0, remoteFileId: null, isConflicted: false }));
          // Feature 038: the initial-sync upload also converges this file → seed its merge base.
          // This batch uploads via uploadStrategy directly (not uploadFile), so it needs its own
          // recordMergeBase; without it a file first pushed by initial sync has no base and a later
          // concurrent edit duplicates shared blocks (caught by the M-first b1 matrix case).
          this.recordMergeBase(path, new TextDecoder().decode(data));
        } catch (err) { this.recordError(summary, path, err); this.retryQueue.push(path); }
        this.tickProgress();
      },
      true,
    );

    // Bounded-parallel downloads (P1-A). No directory serialization needed (each writes a distinct
    // local file; remote reads don't contend), so serializeByDir=false.
    await this.runFileBatch(
      plan.downloads,
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

    // Files already identical on both sides: seed the state DB (no transfer needed).
    // Apply remote mtime to local so both sides are in sync.
    for (const path of plan.unchanged) {
      const lf = localFiles.get(path);
      const remote = remoteMap.get(path);
      if (!lf || !remote) continue;
      const mtime = remote.lastModified || lf.mtime;
      if (remote.lastModified) {
        await this.opts.localAdapter.setMtime(path, remote.lastModified);
      }
      // buildInitialPlan classified this file as unchanged only after confirming localHash === remote.checksum,
      // so remote.checksum is the authoritative content hash for both sides.
      this.opts.stateDB.setFile(await this.withLocalSignature({
        path, localHash: remote.checksum!, remoteId: remote.checksum!, idType: 'sha256',
        size: lf.size, mtime, remoteFileId: remote.fileId, isConflicted: false,
      }, remote.lastModified));
    }

    // Files present on both sides with differing content: resolve as conflicts.
    for (const path of plan.conflicts) {
      try {
        const remote = remoteMap.get(path)!;
        const { remoteId, idType } = remoteIdOf(remote);
        await this.handleConflict(path, undefined, remote, remoteId, idType, summary);
      } catch (err) { this.recordError(summary, path, err); this.retryQueue.push(path); }
      this.tickProgress();
    }
  }

  /** Increment progress counter and push to the status bar. */
  private tickProgress(): void {
    this.syncProgress.processed = Math.min(this.syncProgress.processed + 1, this.syncProgress.total);
    if (this.syncProgress.total > 0) {
      this.opts.statusBar.setProgress(this.syncProgress.processed, this.syncProgress.total);
    }
  }

  // Delegators to the scan modules (feature 074). They bind nothing and decide nothing; they exist
  // because the enumeration is reached from several places in this class and, more importantly,
  // because the existing suites drive it through the engine — which is exactly what proves the
  // engine is still wired to the modules rather than merely compiling against them.

  /** @see LocalScanner.scanLocalFiles */
  private scanLocalFiles(): Promise<Map<string, { size: number; mtime: number }>> {
    return this.localScanner.scanLocalFiles();
  }

  /** @see LocalScanner.collectLocalStats — `_dir` has been unused since the Vault-cache switch. */
  private collectLocalStats(_dir: string, out: Map<string, { size: number; mtime: number }>): Promise<void> {
    return this.localScanner.collectLocalStats(out);
  }

  /** @see RemoteListingSource.obtainFullScanListing */
  private obtainFullScanListing(
    client: IWebDAVClient,
  ): Promise<{ remoteFiles: RemoteFileInfo[]; cachedDirs: RemoteDirInfo[] | null }> {
    return this.remoteListing.obtainFullScanListing(client);
  }

  /** @see RemoteListingSource.rebuildRemoteFilesFromState */
  private rebuildRemoteFilesFromState(): RemoteFileInfo[] {
    return this.remoteListing.rebuildRemoteFilesFromState();
  }

  /** @see RemoteListingSource.rebuildRemoteDirsFromState */
  private rebuildRemoteDirsFromState(): RemoteDirInfo[] {
    return this.remoteListing.rebuildRemoteDirsFromState();
  }

  /**
   * Binds this engine's settings and config resolver for {@link isSystemExcludedPure}. The rules —
   * and the remote-deletion scope guard they enforce — live in `./policy`, where they can be tested
   * against a plain context object instead of a whole engine.
   */
  private isSystemExcluded(path: string): boolean {
    return isSystemExcludedPure(path, {
      excludedFolders: this.opts.settings?.excludedFolders ?? [],
      isUnderConfigDir: (p) => this.configSync.isUnderConfigDir(p),
      isConfigPathIncluded: (p) => this.configSync.isIncluded(p),
      isActiveLogFile: this.opts.isActiveLogFile,
    });
  }
}

