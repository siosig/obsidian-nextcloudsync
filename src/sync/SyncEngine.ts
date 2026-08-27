import { App, Notice, Platform, TFolder, Vault, normalizePath } from 'obsidian';
import {
  DavSyncSettings,
  FileState,
  FileVersion,
  NextcloudFeatures,
  RemoteFileInfo,
  RemoteDirInfo,
  DirState,
  SyncSessionSummary,
  SyncFileOp,
  SyncHistoryDetail,
  SyncHistoryEntry,
  SyncTokenExpiredError,
  NetworkError,
  FileLockedError,
  PreconditionFailedError,
  RemoteCompareResult,
  ConflictResolution,
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
import { DeletionService } from './deletion/DeletionService';
import { isMarkdown } from '../util/mergeableExtensions';
import { SyncHistoryStore } from '../data/SyncHistoryStore';
import { IStatusBar } from '../ui/StatusBarItem';
import { WebDAVFactory } from '../network/WebDAVFactory';
import { IWebDAVClient } from '../network/IWebDAVClient';
import { RenameTracker } from './RenameTracker';
import { ConflictResolver, hasOrphanMarker } from './ConflictResolver';
import { ConfigSyncResolver } from './ConfigSyncResolver';
import { sha256 } from '../util/hash';
import { FIXED, chunkThresholdMB } from '../util/fixedSyncConfig';
import { FileLogger } from '../util/FileLogger';
import {
  isCellularBlocked, MAX_HASH_SIZE,
  MAX_INFLIGHT_BYTES_DESKTOP, MAX_INFLIGHT_BYTES_MOBILE, effectiveMassDeleteLimit,
  isAnomalousRemoteContent,
} from '../util/limits';
import { createLimiter, ByteSemaphore } from '../util/ConcurrencyLimiter';
import { buildMirrorPlan, MirrorPlan, MirrorResult, LocalFileEntry } from './mirrorPlan';
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

/** The local-side fields of a compare result, shared by every `compareWithRemote` outcome. */
type CompareLocalSide = Pick<
  RemoteCompareResult,
  'path' | 'localExists' | 'localMtime' | 'localChecksum' | 'localText' | 'localSize'
>;

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
  /** Progress counters updated during a sync run (reset each run). */
  private syncProgress = { processed: 0, total: 0 };
  /** Feature 046: number of watch-mode single-file/folder ops currently propagating to the remote.
   *  Drives the status bar so the user can see immediate (watch) propagation happening. */
  private watchInFlight = 0;
  /**
   * Feature 064 (C-5): paths whose watch-mode single-file sync arrived while a full sync was running.
   * Held in memory only — losing them on a plugin reload is harmless because the next full sync
   * detects the same local change anyway (self-healing); persisting them would add a second, weaker
   * source of truth for "what changed locally".
   */
  private readonly watchPendingPaths = new Set<string>();
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
    this.remoteListing = new RemoteListingSource({
      stateDB: opts.stateDB,
      isNextcloud: () => this.features?.isNextcloud === true,
      networkConcurrency: () => Math.max(1, this.opts.settings.networkConcurrency),
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
  private beginWatchActivity(): void {
    this.watchInFlight++;
    if (!this.running) this.opts.statusBar.setStatus('syncing');
  }
  private endWatchActivity(): void {
    this.watchInFlight = Math.max(0, this.watchInFlight - 1);
    if (this.watchInFlight === 0 && !this.running) this.opts.statusBar.setStatus('idle');
  }

  /**
   * Sync ONE locally-changed file (watch mode). No-ops if the content is unchanged.
   *
   * Feature 064 (GitHub issue #23): this used to PUT the local body straight to the server —
   * no PROPFIND, no base comparison, and (because it passed `etag: null`) no If-Match either. Any
   * edit made on another device since our last sync was therefore overwritten silently: no conflict,
   * no merge, no notice. Since "Sync on file change" defaults to ON on desktop, that was the DEFAULT
   * path to losing data. The fix is not to bolt a precondition onto the blind upload but to give this
   * path the one thing it lacked — the remote's current state — and then hand it to the SAME
   * classifier the full sync uses (processRemoteFile). Watch mode and "Sync now" now converge on
   * identical results (contract C-3); nothing about the decision lives here.
   */
  async syncSingleFile(path: string): Promise<void> {
    if (this.isSystemExcluded(path)) return;
    // C-5: never run alongside a full sync. The multi-step resolve below (stat → compare → write →
    // push) must not interleave with the full sync's writes to the same file, so defer the path and
    // re-evaluate it once the run finishes — deferring rather than dropping keeps the edit from being
    // missed when the full sync had already passed this file.
    if (this.running) {
      this.watchPendingPaths.add(path);
      void this.opts.logger?.log(`watch: full sync in progress → deferred ${path}`);
      return;
    }
    const stat = await this.opts.localAdapter.stat(path);
    if (!stat) return; // already deleted before the debounce fired
    const base = this.opts.stateDB.getFile(path);
    // FR-006: decide "nothing changed" from LOCAL data only, before touching the network. The stat
    // signature fast-path (P0-A) answers most saves without even reading the file; a signature miss
    // falls back to hashing. Only a real content change is worth a round-trip.
    if (base && this.isLocallyUnchanged(base, stat)) return;
    const data = await this.opts.localAdapter.readBinary(path);
    const localHash = await sha256(data);
    if (base && localHash === base.localHash) return; // content unchanged (e.g. mtime-only touch)

    await this.ensureClient();
    // A real (not dummy) summary: its counters are what tells us whether to notify the user (C-6),
    // and processRemoteFile/handleConflict already maintain them exactly as they do in a full sync.
    const summary = this.initSummary();
    const conflictsBefore = this.conflictEncounters;
    this.beginWatchActivity();
    try {
      const remote = await this.client!.statFile(path);
      if (remote) {
        // The whole classification (upload / download / conflict → merge, If-Match from remote.etag,
        // size guards, marker re-entrancy, feature-063 untracked handling) is the full sync's code.
        void this.opts.logger?.log(`watch: remote state fetched → classifying ${path}`);
        await this.processFileWithRetry(remote, summary);
      } else {
        // C-1 row 4: not on the server at all → a plain create. A precondition would be wrong here
        // (If-Match against a non-existent resource always fails), so keep the synthetic null etag.
        void this.opts.logger?.log(`watch: not on remote → upload as new ${path}`);
        await this.uploadFile(
          path, localHash, base?.remoteId ?? localHash, base?.idType ?? 'sha256',
          { path, fileId: base?.remoteFileId ?? null, checksum: null, etag: null, size: stat.size, lastModified: stat.mtime },
          summary,
        );
      }
      // Watch-mode single-file op: coalesce the state write via a trailing debounce so rapid
      // edits don't each rewrite the whole state file (P0-B). onunload flushes any pending save.
      this.opts.stateDB.requestSave();
      await this.opts.historyStore?.save(); // persist the entry recorded by the branch above
    } catch (err) {
      // FR-009: never lose the edit. A network failure queues the path so the next sync re-evaluates
      // it; the local file is untouched either way.
      console.warn(`[SyncEngine] Single-file sync failed for ${path}:`, err);
      void this.opts.logger?.log(`watch: FAILED ${path} — ${(err as Error).message}`, 'error');
      this.recordError(summary, path, err);
      if (err instanceof NetworkError) this.retryQueue.push(path);
    } finally {
      this.endWatchActivity();
    }
    this.notifyWatchOutcome(path, summary, conflictsBefore);
  }

  /**
   * C-6: watch mode runs unattended, so it stays silent for the routine outcomes (upload, download,
   * nothing to do) and speaks up only when the user has to know — the sync failed, or the two sides
   * had diverged and something had to be decided about it.
   *
   * `conflictsBefore` is the conflictEncounters value captured before the operation: a conflict
   * settled by a deterministic strategy shows up in NO summary counter (it is recorded as a plain
   * upload/download), and that is exactly the case where one side's content was dropped. Notifying
   * only on merged/conflicted would stay silent about the most destructive resolution of all.
   */
  private notifyWatchOutcome(path: string, summary: SyncSessionSummary, conflictsBefore: number): void {
    if (summary.errorCount > 0) {
      new Notice(`❌ Sync failed: ${path}`, 6000);
      return;
    }
    if (summary.conflictedCount > 0) {
      new Notice(`⚠️ Conflict in ${path} — the note holds both versions; review and resolve it.`, 8000);
      return;
    }
    if (summary.mergedCount > 0) {
      new Notice(`🔀 Merged remote changes into ${path}`, 6000);
      return;
    }
    if (this.conflictEncounters > conflictsBefore) {
      new Notice(`🔀 ${path} changed on both sides — resolved by your conflict settings.`, 6000);
    }
  }

  /**
   * C-5: re-evaluate every path whose watch-mode sync was deferred by a full sync. Called once the
   * run has finished (running === false). The set is drained into a local copy first so a path
   * deferred again mid-drain (it cannot be — running is false — but also so re-entry is impossible)
   * never loops. Failures are per-path and already handled inside syncSingleFile.
   */
  private async drainWatchPending(): Promise<void> {
    if (this.watchPendingPaths.size === 0) return;
    const paths = [...this.watchPendingPaths];
    this.watchPendingPaths.clear();
    void this.opts.logger?.log(`watch: full sync finished → re-evaluating ${paths.length} deferred path(s)`);
    for (const p of paths) {
      await this.syncSingleFile(p);
    }
  }

  /**
   * Delete a single file from the remote when it was deleted locally (watch mode).
   *
   * Feature 064 (C-2): this used to DELETE unconditionally. `deleteFile(path, expectedRemoteId)`
   * reads like a guarded delete, but every client ignores that argument (blind DELETE, spec 023), so a
   * note another device had just edited was removed anyway — the full sync's delete path has guarded
   * against exactly that since spec 023, and this one did not. It now runs the SAME guard
   * (applyLocalDeletion): delete only while the server's recomputed checksum still matches our base,
   * otherwise restore the remote copy locally instead of destroying it.
   */
  async deleteSingleFile(path: string): Promise<void> {
    if (this.isSystemExcluded(path)) return;
    const base = this.opts.stateDB.getFile(path);
    if (!base) return; // not tracked — nothing to do on remote
    // C-2 row 1: during a full sync, do nothing — and do NOT defer either. The running scan detects a
    // tracked path that is gone locally and propagates the deletion itself, so queuing it here would
    // only risk a second delete against a path the scan already handled.
    if (this.running) {
      void this.opts.logger?.log(`watch: full sync in progress → deletion of ${path} left to the running scan`);
      return;
    }
    await this.ensureClient();
    const summary = this.initSummary();
    const conflictsBefore = this.conflictEncounters;
    this.beginWatchActivity();
    try {
      const remote = await this.client!.statFile(path);
      if (!remote) {
        // C-2 row 3: already absent on the server — that IS the desired end state. Stop tracking it.
        void this.opts.logger?.log(`watch: already gone on remote → dropping tracking for ${path}`);
        this.recordHistory(path, 'deleted');
        this.opts.stateDB.deleteFile(path);
        this.dropMergeBase(path); // feature 038: file gone → drop its merge base
        this.dropCleanSnapshot(path); // feature 044: file gone → drop any captured clean sides
      } else {
        const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
        const idType: FileState['idType'] = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');
        // Shared with the full sync: deletes on a checksum match, restores the remote copy when it
        // diverged, and does nothing when the server cannot prove the copy is unchanged. It owns the
        // StateDB cleanup too — including the G1-2 rule of keeping the entry when the DELETE fails,
        // so a failed delete is retried instead of coming back as a re-download.
        await this.applyLocalDeletion(remote, base, remoteId, idType, summary);
        if (!this.opts.stateDB.getFile(path)) this.dropCleanSnapshot(path);
      }
      this.opts.stateDB.requestSave(); // coalesced watch-mode save (P0-B)
      await this.opts.historyStore?.save();
    } catch (err) {
      console.warn(`[SyncEngine] Single-file delete failed for ${path}:`, err);
      void this.opts.logger?.log(`watch: delete FAILED ${path} — ${(err as Error).message}`, 'error');
      this.recordError(summary, path, err);
    } finally {
      this.endWatchActivity();
    }
    this.notifyWatchOutcome(path, summary, conflictsBefore);
  }

  /** MOVE a single file on the remote when it was renamed/moved locally. */
  async renameSingleFile(oldPath: string, newPath: string): Promise<void> {
    if (this.isSystemExcluded(oldPath) && this.isSystemExcluded(newPath)) return;
    await this.ensureClient();
    const rt = this.getOrCreateRenameTracker();
    this.beginWatchActivity();
    try {
      await rt.applyLocalRename(oldPath, newPath);
      this.opts.stateDB.requestSave(); // coalesced watch-mode save (P0-B)
    } catch (err) {
      console.warn(`[SyncEngine] Single-file rename failed ${oldPath} → ${newPath}:`, err);
    } finally {
      this.endWatchActivity();
    }
  }

  /**
   * Feature 046 (watch-mode folder propagation): create a single folder on the remote immediately
   * when it is created locally (MKCOL). Idempotent — a folder that already exists on the server is a
   * no-op (405 swallowed), which also makes it safe against a stray download-created-folder event.
   */
  async createSingleFolder(path: string): Promise<void> {
    if (this.isSystemExcluded(path)) return;
    await this.ensureClient();
    this.beginWatchActivity();
    try {
      await this.client!.createDirectory(path); // idempotent: existing folder → harmless
      this.opts.stateDB.setDir({ path, remoteFileId: null });
      this.opts.stateDB.requestSave(); // coalesced watch-mode save
      void this.opts.logger?.log(`watch: folder created → MKCOL ${path}`);
    } catch (err) {
      console.warn(`[SyncEngine] Single-folder create failed for ${path}:`, err);
    } finally {
      this.endWatchActivity();
    }
  }

  /**
   * Feature 046: delete a single folder on the remote immediately when it is deleted locally. Only a
   * TRACKED folder (present in the StateDB directory set) is propagated — an untracked folder was
   * never on the server, so deleting it locally is a no-op remotely (mirrors deleteSingleFile). The
   * remote delete routes through the Nextcloud trashbin (recoverable); a 404 is the desired end state.
   */
  async deleteSingleFolder(path: string): Promise<void> {
    if (this.isSystemExcluded(path)) return;
    if (!this.opts.stateDB.getDir(path)) return; // untracked → nothing to do on the remote
    await this.ensureClient();
    this.beginWatchActivity();
    let succeeded = false;
    try {
      await this.client!.deleteCollection(path); // trashbin; 404 handled inside as success
      void this.opts.logger?.log(`watch: folder deleted → remote collection removed ${path}`);
      succeeded = true;
    } catch (err) {
      console.warn(`[SyncEngine] Single-folder delete failed for ${path}:`, err);
    } finally {
      this.endWatchActivity();
    }
    // BUG G1-2 fix: only drop the tracked directory when the remote delete actually succeeded (see
    // deleteSingleFile for the full rationale) — otherwise the next sync would re-create it locally.
    if (!succeeded) return;
    this.opts.stateDB.deleteDir(path);
    this.opts.stateDB.requestSave();
  }

  /**
   * Feature 046: MOVE a single folder on the remote immediately when it is renamed/moved locally.
   * Collections are moved with the same WebDAV MOVE as files; the server moves the whole subtree.
   * Any child-file rename events Obsidian fires alongside are handled best-effort by renameSingleFile
   * (their 404s are harmless because the parent MOVE already relocated them) and converge next sync.
   */
  async renameSingleFolder(oldPath: string, newPath: string): Promise<void> {
    if (this.isSystemExcluded(oldPath) && this.isSystemExcluded(newPath)) return;
    await this.ensureClient();
    this.beginWatchActivity();
    try {
      await this.client!.moveFile(oldPath, newPath); // MOVE works for collections too
      this.opts.stateDB.deleteDir(oldPath);
      this.opts.stateDB.setDir({ path: newPath, remoteFileId: null });
      this.opts.stateDB.requestSave();
      void this.opts.logger?.log(`watch: folder renamed → MOVE ${oldPath} → ${newPath}`);
    } catch (err) {
      console.warn(`[SyncEngine] Single-folder rename failed ${oldPath} → ${newPath}:`, err);
    } finally {
      this.endWatchActivity();
    }
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
  private captureCleanSides(
    path: string, local: string, remote: string,
    localMtime: number, localSize: number, remoteInfo: RemoteFileInfo,
  ): void {
    if (!this.opts.cleanSideStore) return;
    this.opts.cleanSideStore.set(path, {
      local, remote,
      localMtime, remoteMtime: remoteInfo.lastModified || 0,
      localSize, remoteSize: remoteInfo.size,
    });
    this.opts.cleanSideStore.requestSave();
  }

  /** Drop the captured clean sides for `path` (on resolution / convergence / deletion) — no leak (044). */
  private dropCleanSnapshot(path: string): void {
    if (!this.opts.cleanSideStore) return;
    if (this.opts.cleanSideStore.get(path) === undefined) return;
    this.opts.cleanSideStore.delete(path);
    this.opts.cleanSideStore.requestSave();
  }

  /**
   * Feature 044 self-heal safety net: after a sync, drop the captured clean sides of any path that is
   * no longer marker-conflicted in StateDB (converged via a prefer-side / clean-merge / hand-resolve /
   * download). This keeps captures bounded to currently-conflicted files (FR-008/SC-003) regardless of
   * which convergence path ran, without threading a drop into every call site.
   */
  private sweepResolvedSnapshots(): void {
    const store = this.opts.cleanSideStore;
    if (!store) return;
    for (const path of store.paths()) {
      if (!this.opts.stateDB.getFile(path)?.isConflicted) this.dropCleanSnapshot(path);
    }
  }

  /**
   * Feature 044 recovery: the captured clean-side metrics for a marker-conflicted `path`, or null when
   * no snapshot exists. Force-resolution uses this to decide whether to recover from the snapshot
   * (present) or fall back to current-content push/pull (absent). Implements CompareEngine (044).
   */
  cleanSideMetrics(path: string): CleanSideMetrics | null {
    const snap = this.opts.cleanSideStore?.get(path);
    if (!snap) return null;
    return { localMtime: snap.localMtime, remoteMtime: snap.remoteMtime, localSize: snap.localSize, remoteSize: snap.remoteSize };
  }

  /** Feature 044 recovery: restore the captured clean REMOTE side (or fall back to pull if none). */
  async applyCleanRemote(path: string): Promise<void> {
    const snap = this.opts.cleanSideStore?.get(path);
    if (!snap) { await this.pullRemoteToLocal(path); return; }
    await this.applyCleanSide(path, snap.remote, 'remote');
  }

  /** Feature 044 recovery: restore the captured clean LOCAL side (or fall back to push if none). */
  async applyCleanLocal(path: string): Promise<void> {
    const snap = this.opts.cleanSideStore?.get(path);
    if (!snap) { await this.pushLocalToRemote(path); return; }
    await this.applyCleanSide(path, snap.local, 'local');
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
  async resolveSkippedDir(
    path: string,
    category: 'deleteRemote' | 'trashLocal',
    choice: 'remote' | 'local',
  ): Promise<void> {
    await this.ensureClient();
    if (category === 'deleteRemote') {
      if (choice === 'remote') {
        // Remote is correct: undo the apparent local deletion by recreating the folder locally.
        await this.opts.app.vault.adapter.mkdir(normalizePath(path));
        this.opts.stateDB.setDir({ path, remoteFileId: null });
      } else {
        // Local absence is correct: let the deletion proceed on the remote.
        await this.client!.deleteCollection(path);
        this.opts.stateDB.deleteDir(path);
      }
    } else {
      if (choice === 'remote') {
        // Remote absence is correct: let the deletion proceed locally.
        const folder = this.opts.app.vault.getAbstractFileByPath(path);
        if (folder instanceof TFolder) await this.opts.app.fileManager.trashFile(folder);
        this.opts.stateDB.deleteDir(path);
      } else {
        // Local is correct: undo the apparent remote deletion by recreating it on the remote.
        await this.client!.createDirectory(path);
        this.opts.stateDB.setDir({ path, remoteFileId: null });
      }
    }
    this.opts.stateDB.requestSave();
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
  async resolveAllSkippedDirs(choice: 'remote' | 'local'): Promise<{ resolved: number; failed: number }> {
    if (this.running) throw new Error('Cannot resolve skipped directories — sync in progress');
    const errors = this.lastSummary?.errors;
    const entry = errors?.find((e) => e.path === '(dir mass-delete breaker)' && e.dirBreakerSkipped);
    if (!entry?.dirBreakerSkipped) return { resolved: 0, failed: 0 };

    const candidates: { path: string; category: 'deleteRemote' | 'trashLocal' }[] = [
      ...entry.dirBreakerSkipped.deleteRemote.map((path) => ({ path, category: 'deleteRemote' as const })),
      ...entry.dirBreakerSkipped.trashLocal.map((path) => ({ path, category: 'trashLocal' as const })),
    ];

    let resolved = 0;
    const failedDeleteRemote: string[] = [];
    const failedTrashLocal: string[] = [];
    for (const { path, category } of candidates) {
      try {
        await this.resolveSkippedDir(path, category, choice);
        resolved++;
      } catch {
        (category === 'deleteRemote' ? failedDeleteRemote : failedTrashLocal).push(path);
      }
    }

    const failed = failedDeleteRemote.length + failedTrashLocal.length;
    if (failed === 0) {
      const idx = errors!.indexOf(entry);
      if (idx >= 0) errors!.splice(idx, 1);
    } else {
      entry.dirBreakerSkipped = { deleteRemote: failedDeleteRemote, trashLocal: failedTrashLocal };
    }
    return { resolved, failed };
  }

  /**
   * Write `content` (a captured clean side) to BOTH local and remote so the conflict converges on a
   * real, marker-free version. Uploads first (if that fails, nothing local changes and the file stays
   * conflicted — no false "resolved"), then writes local, converges StateDB (isConflicted:false),
   * records the new merge base, and drops the snapshot. (CSS-2/CSS-4/CSS-6)
   */
  private async applyCleanSide(path: string, content: string, side: 'local' | 'remote'): Promise<void> {
    const { client } = await this.ensureClient();
    const data = new TextEncoder().encode(content).buffer;
    const mtime = Date.now();
    const remote = await this.fetchRemoteInfo(path);

    const lockToken = await this.acquireLock(path);
    try {
      const outcome = await this.uploadStrategy!.upload(client, path, data, mtime);
      if (outcome === 'skipped') throw new Error(`Upload skipped (over the size limit): ${path}`);
    } finally {
      await this.releaseLock(path, lockToken);
    }

    await this.opts.localAdapter.atomicWriteBinary(path, data);
    await this.opts.localAdapter.setMtime(path, mtime);

    const localHash = await sha256(data);
    this.recordHistory(path, 'uploaded', undefined, {
      localHash, remoteId: localHash, remoteIdType: 'sha256',
      localSize: data.byteLength, remoteSize: remote?.size,
    });
    this.opts.stateDB.setFile(await this.withLocalSignature({
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: data.byteLength, mtime,
      remoteFileId: remote?.fileId ?? null, isConflicted: false,
    }, remote?.lastModified));
    // Both sides now hold the clean content → it is the new merge base; the snapshot has served its
    // purpose and is dropped (no leak).
    this.recordMergeBase(path, content);
    this.dropCleanSnapshot(path);
    await this.opts.stateDB.save();
    await this.opts.historyStore?.save();
    void this.opts.logger?.log(`conflict: force-resolved from clean ${side} snapshot (both sides converged) → ${path}`);
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
  async planRemoteMirror(onPhase?: (label: string) => void): Promise<MirrorPlan> {
    // Lazily build (and cache) the WebDAV client + features, exactly like a normal sync does — the
    // client is only created on first sync, so a mirror invoked before any sync must connect here.
    onPhase?.('Connecting to the server…');
    let client: IWebDAVClient;
    try {
      ({ client } = await this.ensureClient());
    } catch (err) {
      return buildMirrorPlan([], [], [], () => false, false, `Not connected to the server: ${(err as Error).message}`);
    }

    // 1. Authoritative remote listing (no short-circuit). Failure ⇒ abort gate (zero deletions).
    onPhase?.('Reading the remote file list…');
    let remoteFiles: RemoteFileInfo[];
    try {
      remoteFiles = await client.getFiles('');
    } catch (err) {
      return buildMirrorPlan([], [], [], () => false, false, `Failed to list the remote: ${(err as Error).message}`);
    }

    // 2. Local files.
    onPhase?.('Comparing with local files…');
    const localStats = new Map<string, { size: number; mtime: number }>();
    await this.collectLocalStats('', localStats);
    for (const p of await this.configSync.enumerateIncludedPaths()) {
      const st = await this.opts.localAdapter.stat(p);
      if (st) localStats.set(p, { size: st.size, mtime: st.mtime });
    }

    // 2a. Populate missing server-side checksums for files present on BOTH sides — server-computed,
    //     no download (Nextcloud ChecksumUpdatePlugin), same as a normal sync. Without this, files put
    //     on the server by another tool (the common migration case) carry no checksum, so every one
    //     would be re-downloaded even when byte-identical. Best-effort: unsupported servers leave the
    //     checksum null and those files fall back to download (still correct, just not skipped).
    onPhase?.('Checking server checksums…');
    await this.remoteListing.resolveRemoteChecksums(client, remoteFiles, localStats);

    onPhase?.('Checking local files…');
    // Only hash a local file when its remote counterpart now carries a checksum we can compare against
    // (otherwise it would be downloaded regardless, so hashing would be wasted I/O).
    const remoteChecksum = new Map(remoteFiles.map((r) => [r.path, r.checksum] as const));
    const localFiles: LocalFileEntry[] = [];
    for (const [path] of localStats) {
      let hash = '';
      const cs = remoteChecksum.get(path);
      if (cs != null && !this.isSystemExcluded(path)) {
        try {
          hash = await sha256(await this.opts.localAdapter.readBinary(path));
        } catch {
          hash = '';
        }
      }
      localFiles.push({ path, hash });
    }

    // 3. Local folders (empty ones included) for local-only folder deletion.
    const vault = this.opts.app.vault as Vault & { getAllFolders?: (includeRoot?: boolean) => TFolder[] };
    const localDirs = (vault.getAllFolders?.() ?? []).map((f) => f.path).filter((p) => p && p !== '/');

    return buildMirrorPlan(remoteFiles, localFiles, localDirs, (p) => this.isSystemExcluded(p), true);
  }

  /**
   * Apply a Pull-mirror plan produced by {@link planRemoteMirror}: download everything the remote has
   * (or that differs), delete local-only files/folders (via the user's Obsidian "Deleted files"
   * setting — recoverable), then reconcile StateDB to the remote so the next normal sync converges to
   * zero diff (FR-011 / SC-002). The caller must pass an `ok:true` plan and have aborted in-flight sync.
   */
  async applyRemoteMirror(plan: MirrorPlan, onProgress?: (done: number, total: number) => void): Promise<MirrorResult> {
    const result: MirrorResult = { downloaded: 0, deleted: 0, skipped: plan.skipCount, errors: [] };
    if (!plan.ok) return result;

    const summary = this.initSummary();

    // Progress reporting: identical surface to a normal "Sync now" — the status bar on desktop and the
    // single result toast on mobile (NoticeStatusBar), driven via setStatus/setProgress/tickProgress
    // and closed with setSyncComplete. Total = every action item (downloads + file/folder deletions).
    const total = plan.downloads.length + plan.deleteFiles.length + plan.deleteDirs.length;
    this.syncProgress = { processed: 0, total };
    this.opts.statusBar.setStatus('syncing');
    if (total > 0) this.opts.statusBar.setProgress(0, total);
    onProgress?.(0, total);
    // Advance the status-bar progress AND the dialog progress (feature 049) together.
    const tick = (): void => {
      this.tickProgress();
      onProgress?.(this.syncProgress?.processed ?? 0, total);
    };

    // 1. Downloads (remote wins — forced overwrite, not a 3-way merge).
    for (const remote of plan.downloads) {
      const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
      const idType: FileState['idType'] = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');
      try {
        const before = summary.downloadedCount;
        await this.downloadFile(remote, remoteId, idType, summary);
        if (summary.downloadedCount > before) result.downloaded++;
      } catch (err) {
        result.errors.push({ path: remote.path, message: (err as Error).message });
      }
      tick();
    }

    // 2. Delete local-only files (processRemoteDeletion honors the trash setting + cleans StateDB).
    for (const path of plan.deleteFiles) {
      try {
        await this.processRemoteDeletion(path, summary);
        result.deleted++;
      } catch (err) {
        result.errors.push({ path, message: (err as Error).message });
      }
      tick();
    }

    // 3. Delete local-only folders child→parent (trashFile handles TFolder), then drop dir tracking.
    for (const path of plan.deleteDirs) {
      try {
        await this.processRemoteDeletion(path, summary);
        this.opts.stateDB.deleteDir(path);
        result.deleted++;
      } catch (err) {
        result.errors.push({ path, message: (err as Error).message });
      }
      tick();
    }

    // 4. Reconcile StateDB to the remote so the next sync sees no diff (self-healing, FR-011).
    const eligibleRemote = plan.remoteFiles.filter((r) => !this.isSystemExcluded(r.path));
    const downloadSet = new Set(plan.downloads.map((d) => d.path));
    // 4a. Skipped files (content already matched): downloadFile did NOT run for them, so ensure they
    //     are tracked as unchanged (localHash === remoteId) — otherwise an untracked-but-present file
    //     would be misread as a conflict next sync and break convergence.
    for (const remote of eligibleRemote) {
      if (downloadSet.has(remote.path)) continue; // already tracked by downloadFile
      const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
      const idType: FileState['idType'] = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');
      const existing = this.opts.stateDB.getFile(remote.path);
      const localHash = remote.checksum ?? existing?.localHash ?? remoteId;
      this.opts.stateDB.setFile(await this.withLocalSignature({
        path: remote.path, localHash, remoteId, idType,
        size: remote.size, mtime: remote.lastModified || (existing?.mtime ?? 0),
        remoteFileId: remote.fileId, isConflicted: false,
      }, remote.lastModified));
    }
    // 4b. Drop any tracked file the remote no longer has (deleteFiles already dropped their entries;
    //     this also clears entries whose local file was absent locally but still tracked).
    const remoteSet = new Set(eligibleRemote.map((r) => r.path));
    for (const fs of this.opts.stateDB.getAllFiles()) {
      if (!this.isSystemExcluded(fs.path) && !remoteSet.has(fs.path)) {
        this.opts.stateDB.deleteFile(fs.path);
        this.dropMergeBase(fs.path);
      }
    }
    // 4c. Force a real full scan next sync (never short-circuit) so convergence is genuinely verified.
    this.opts.stateDB.setRemoteRootEtag(null);
    this.opts.stateDB.setSyncToken('');

    // Close the progress surface with a result — exactly like a normal sync. On mobile this replaces
    // the "🔄 Syncing…" toast with the outcome (and auto-dismisses); on desktop it updates the bar.
    // Deletions are reflected in summary.downloadedCount (processRemoteDeletion increments it), matching
    // how a normal sync reports remote-deletions-applied-locally.
    summary.errorCount = result.errors.length;
    this.opts.statusBar.setSyncComplete(0, summary.downloadedCount, 0, result.errors.length);

    void this.opts.logger?.log(
      `mirror: applied — downloaded=${result.downloaded}, deleted=${result.deleted}, skipped=${result.skipped}, errors=${result.errors.length}`,
    );
    return result;
  }

  getLastSessionSummary(): SyncSessionSummary | null {
    return this.lastSummary;
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

  getUnresolvedConflictCount(): Promise<number> {
    return Promise.resolve(this.opts.stateDB.countConflicted());
  }

  /**
   * Read-only comparison of one file against its remote counterpart, for the explorer
   * "Compare with remote" popup. Fetches remote metadata + content (never mutates) and computes
   * modification times, byte-level SHA-256 checksums (so the match indicator is valid for binary
   * files too), and decoded text for the diff (text-eligible files only). Failures are captured in
   * the returned `state` (`remote-missing` / `error`) rather than thrown.
   */
  async compareWithRemote(path: string): Promise<RemoteCompareResult> {
    await this.ensureClient();
    const textEligible = this.textEligible(path);

    // Local side
    const stat = await this.opts.localAdapter.stat(path);
    const localExists = stat != null;
    let localChecksum: string | null = null;
    let localText: string | null = null;
    if (localExists) {
      const localBytes = await this.opts.localAdapter.readBinary(path);
      localChecksum = await sha256(localBytes);
      if (textEligible) localText = new TextDecoder().decode(localBytes);
    }

    const local: CompareLocalSide = {
      path,
      localExists,
      localMtime: stat?.mtime ?? null,
      localChecksum,
      localText,
      localSize: stat?.size ?? null,
    };

    try {
      const remote = await this.fetchRemoteInfo(path);
      if (!remote) return this.compareWithoutRemote(local, 'remote-missing');

      // Size guard (spec 035, FR-011): never fetch an oversized remote body just to diff it (the
      // fetch itself can OOM on Android). Show the metadata comparison (sizes/mtimes) but no line
      // diff — the same shape as a binary/non-text file (remoteText null, diffAvailable false).
      if (this.isRemoteOverSizeLimit(remote)) {
        const sizeMB = remote.size / 1024 / 1024;
        new Notice(
          `⚠️ File too large to preview: ${path} (${sizeMB.toFixed(1)} MB > ${this.opts.settings.maxFileSizeMB} MB)`,
        );
        return {
          ...local, state: 'ok', remoteExists: true,
          remoteMtime: remote.lastModified ?? null,
          remoteChecksum: remote.checksum ?? null,
          checksumMatch: local.localChecksum != null && remote.checksum != null && local.localChecksum === remote.checksum,
          remoteText: null, diffAvailable: false,
          remoteSize: remote.size ?? null,
        };
      }

      const remoteBytes = await this.client!.downloadFile(path);
      // Hash the actual bytes (not the server-reported checksum) so checksumMatch is guaranteed
      // consistent with the diff: identical bytes ⇔ match ⇔ empty diff.
      const remoteChecksum = await sha256(remoteBytes);
      const remoteText = textEligible ? new TextDecoder().decode(remoteBytes) : null;
      return {
        ...local, state: 'ok', remoteExists: true,
        remoteMtime: remote.lastModified ?? null,
        remoteChecksum,
        checksumMatch: localChecksum != null && localChecksum === remoteChecksum,
        remoteText, diffAvailable: textEligible && localExists,
        remoteSize: remote.size ?? null,
      };
    } catch (err) {
      return this.compareWithoutRemote(local, 'error', (err as Error)?.message ?? String(err));
    }
  }

  /**
   * Build a compare result for the two cases where no remote content is available — the remote file
   * is missing, or the fetch failed. Both carry the local side and null remote fields; `error` adds
   * a message. Centralizes the otherwise-duplicated "no remote" field set.
   */
  private compareWithoutRemote(
    local: CompareLocalSide, state: 'remote-missing' | 'error', errorMessage?: string,
  ): RemoteCompareResult {
    return {
      ...local, state, errorMessage,
      remoteExists: false, remoteMtime: null, remoteChecksum: null, checksumMatch: false,
      remoteText: null, diffAvailable: false, remoteSize: null,
    };
  }

  /**
   * Manual resolution (push): overwrite the REMOTE file with the local content. Reuses the upload
   * strategy + lock handling, records an 'uploaded' history entry, and converges StateDB so the
   * next sync sees no spurious change. Rejects on failure so the caller can surface it (and records
   * nothing in that case).
   */
  async pushLocalToRemote(path: string): Promise<void> {
    const { client } = await this.ensureClient();
    const stat = await this.opts.localAdapter.stat(path);
    if (!stat) throw new Error(`Local file not found: ${path}`);
    const localData = await this.opts.localAdapter.readBinary(path);
    const localHash = await sha256(localData);
    const remote = await this.fetchRemoteInfo(path); // null ⇒ creating the remote from local

    const lockToken = await this.acquireLock(path);
    try {
      const outcome = await this.uploadStrategy!.upload(client, path, localData, stat.mtime);
      if (outcome === 'skipped') throw new Error(`Upload skipped (over the size limit): ${path}`);
    } finally {
      await this.releaseLock(path, lockToken);
    }

    this.recordHistory(path, 'uploaded', undefined, {
      localHash, remoteId: localHash, remoteIdType: 'sha256',
      localSize: stat.size, remoteSize: remote?.size,
    });
    this.opts.stateDB.setFile(await this.withLocalSignature({
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: stat.size, mtime: stat.mtime,
      remoteFileId: remote?.fileId ?? null, isConflicted: false,
    }, remote?.lastModified));
    await this.opts.stateDB.save();
    await this.opts.historyStore?.save();
  }

  /**
   * Manual resolution (pull): overwrite the LOCAL file with the remote content. The write is marked
   * as the plugin's own (atomicWriteBinary registers an ignore) so the modify watcher does not echo
   * it back as an upload. Records a 'downloaded' history entry and converges StateDB. Rejects on
   * failure (local left unchanged when the download fails before any write).
   */
  async pullRemoteToLocal(path: string): Promise<void> {
    const { client } = await this.ensureClient();
    const remote = await this.fetchRemoteInfo(path);
    if (!remote) throw new Error(`Remote file not found: ${path}`);

    // Size guard (spec 035, FR-011): refuse a manual pull of an oversized remote (the download would
    // risk OOM). Surface a clear error to the caller (symmetric with pushLocalToRemote throwing on an
    // oversized upload). Local file and StateDB are left untouched.
    if (this.isRemoteOverSizeLimit(remote)) {
      const sizeMB = remote.size / 1024 / 1024;
      throw new Error(`File too large to download (${sizeMB.toFixed(1)} MB > ${this.opts.settings.maxFileSizeMB} MB): ${path}`);
    }

    const remoteData = await client.downloadFile(path);
    await this.opts.localAdapter.atomicWriteBinary(path, remoteData);
    if (remote.lastModified) await this.opts.localAdapter.setMtime(path, remote.lastModified);

    const localHash = await sha256(remoteData);
    const remoteId = remote.checksum ?? localHash;
    const mtime = remote.lastModified || (await this.opts.localAdapter.stat(path))?.mtime || Date.now();
    this.recordHistory(path, 'downloaded', undefined, {
      localHash, remoteId, remoteIdType: 'sha256',
      localSize: remoteData.byteLength, remoteSize: remote.size,
    });
    this.opts.stateDB.setFile(await this.withLocalSignature({
      path, localHash, remoteId, idType: 'sha256',
      size: remote.size, mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    }, remote.lastModified));
    await this.opts.stateDB.save();
    await this.opts.historyStore?.save();
  }

  /** Binds the configured Auto Merge File types for {@link isTextEligible}. */
  private textEligible(path: string): boolean {
    return isTextEligible(path, this.opts.settings.autoMergeFileTypes);
  }

  /** Fetch a single remote file's metadata via PROPFIND; null when the remote file is absent. */
  private async fetchRemoteInfo(path: string): Promise<RemoteFileInfo | null> {
    const infos = await this.client!.getFiles(path);
    if (infos.length === 0) return null;
    return infos.find(i => i.path === path) ?? infos[0];
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
    const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
    const idType = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');

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
      await this.downloadFile(remote, remoteId, idType, summary);
    } else {
      // Both changed: Conflicted
      await this.handleConflict(remote.path, base, remote, remoteId, idType, summary);
    }
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

  private async handleConflict(
    path: string, base: FileState | undefined, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    this.conflictEncounters++; // C-6: lets the watch path notice a conflict settled without a counter
    // Size guard (spec 035, FR-010): a both-sides conflict needs the remote body to merge, but an
    // oversized remote cannot be fetched without risking OOM. Skip the download, keep local untouched,
    // and flag the file conflicted so the UI surfaces it. Do NOT queue a retry — re-fetching would
    // fail the same way every sync until the cap is raised; raising it lets the next sync merge
    // normally (self-healing). Leave the StateDB Base hashes untouched so the divergence persists.
    if (this.isRemoteOverSizeLimit(remote)) {
      this.warnDownloadSkipped(path, remote.size);
      if (base) this.opts.stateDB.setFile({ ...base, isConflicted: true });
      void this.opts.logger?.log(`conflict: remote over size limit (${remote.size}B > ${this.opts.settings.maxFileSizeMB}MB), skipped → ${path}`);
      return;
    }

    // Capture local stat (size + mtime) BEFORE writing any merge result: needed both for the
    // max(local, remote) mtime stamp on a merge write and for the biggest-size / latest-mtime
    // deterministic strategies (feature 037).
    const localStatBefore = await this.opts.localAdapter.stat(path);
    const localMtimeBefore = localStatBefore?.mtime ?? 0;
    const localSizeBefore = localStatBefore?.size ?? 0;

    // Feature 037: a single per-type strategy replaces the former three conflict settings. The
    // ConflictResolver classifies the path (Auto Merge File / Other File) and applies its strategy.
    // Config-folder JSON (appearance.json, etc.) has no special branch any more: its extension is not
    // in autoMergeFileTypes, so it falls to `otherFileStrategy` (default latest-mtime = newest-wins),
    // which never writes markers — JSON-safe, single path (FR-013).
    const resolver = new ConflictResolver(this.opts.app, this.opts.localAdapter, {
      autoMergeFileTypes: this.opts.settings.autoMergeFileTypes,
      autoMergeFileStrategy: this.opts.settings.autoMergeFileStrategy,
      otherFileStrategy: this.opts.settings.otherFileStrategy,
      deviceId: this.opts.settings.deviceId,
      frontmatterStrategy: this.opts.settings.frontmatterStrategy,
      conflictStrategy: this.opts.settings.conflictStrategy,
    });
    const ctx = {
      localSize: localSizeBefore,
      remoteSize: remote.size,
      localMtime: localMtimeBefore,
      remoteMtime: remote.lastModified || 0,
    };

    // The `merge` strategy needs the decoded text of both sides; so does EVERY markdown file (feature
    // 047), which splits frontmatter from body and resolves them independently regardless of the body
    // strategy. Non-markdown deterministic strategies decide from size/mtime alone, so defer their
    // remote download until we know it is required.
    let remoteData: ArrayBuffer | undefined;
    let decision: ConflictResolution;
    if (resolver.strategyFor(path) === 'merge' || isMarkdown(path)) {
      const localContent = await this.opts.localAdapter.read(path);
      remoteData = await this.client!.downloadFile(remote.path);
      const remoteContent = new TextDecoder().decode(remoteData);
      // Feature 038: pass the stored common ancestor (last-synced body) as the 3-way merge base so
      // reconcile does not duplicate blocks both sides share. Empty when no base is known yet
      // (migration / first conflict); the expansion guard (037) then prevents a corrupt write and the
      // next convergence seeds the base (self-healing).
      const base = this.opts.baseStore?.get(path) ?? '';
      // Feature 041: a lone half-marker left by an incomplete manual resolution used to trap the file
      // in a permanent safe-hold (never pushed → the orphan line survived on the server → re-conflict
      // every sync). It is now merged normally and self-heals; record that we bypassed the re-entrancy
      // guard so the recovery is visible in the debug log.
      if (hasOrphanMarker(localContent) || hasOrphanMarker(remoteContent)) {
        void this.opts.logger?.log(`conflict: orphan marker detected, bypassing re-entrancy guard (self-heal) → ${path}`);
      }
      decision = resolver.decide(path, base, localContent, remoteContent, ctx);
      // Feature 044: a marker write (clean:false) is the ONLY resolution that overwrites both clean
      // sides (local body on disk + remote body on the server). Capture them NOW — before the switch
      // runs resolveByWrite — so force-resolution can later recover a real clean version instead of the
      // marker content. Clean auto-merges (clean:true) and the deterministic strategies capture nothing.
      if (decision.action === 'write' && !decision.clean) {
        this.captureCleanSides(path, localContent, remoteContent, localMtimeBefore, localSizeBefore, remote);
      }
    } else {
      decision = resolver.decide(path, '', '', '', ctx);
    }

    switch (decision.action) {
      case 'safe-hold':
        // Non-text file under the merge strategy (FR-005a): writing conflict markers would corrupt
        // it, so leave BOTH sides untouched and only flag the entry conflicted. NOT an error and NOT
        // retried; the StateDB Base hashes stay as-is so the divergence persists for manual resolution.
        if (base) this.opts.stateDB.setFile({ ...base, isConflicted: true });
        summary.conflictedCount++;
        this.recordHistory(path, 'conflicted');
        void this.opts.logger?.log(`conflict: non-text under merge → safe-hold, both sides untouched → ${path}`);
        return;

      case 'no-op':
        // Deterministic tie — equal size (biggest-size) or equal mtime (latest-mtime) — FR-009: leave
        // BOTH sides untouched, do NOT flag conflicted, do NOT count an error. The next sync
        // re-evaluates once either side changes (self-healing); the StateDB is left untouched.
        void this.opts.logger?.log(`conflict: deterministic tie → no-op, both sides untouched → ${path}`);
        // Root-ETag short-circuit safety (spec 023 §8a.5): a tie deliberately leaves the two sides
        // DIVERGENT (local ≠ remote) with the StateDB untouched and nothing pushed — so the remote root
        // ETag is unchanged and no summary counter rises. Unlike the conflicted / error / retry
        // outcomes, finalizeScan's convergence gate cannot see this standing divergence. If the
        // short-circuit stayed armed, the next sync would rebuild the remote listing from the stale
        // StateDB, misread the tie as a local-only change, and silently upload the local side —
        // overwriting the other device's edit (data loss). Force a real scan next time so the tie is
        // re-detected. Self-healing: once a real scan converges, it re-arms the short-circuit.
        this.opts.stateDB.setRemoteRootEtag(null);
        return;

      case 'prefer-local':
        await this.resolveByPreferLocal(path, remote, summary);
        return;

      case 'prefer-remote':
        if (!remoteData) remoteData = await this.client!.downloadFile(remote.path);
        await this.resolveByPreferRemote(path, remote, remoteData, remoteId, idType, summary);
        return;

      case 'write':
        await this.resolveByWrite(path, decision.content, decision.clean, remote, remoteId, idType, localMtimeBefore, summary);
        return;
    }
  }

  /** 'write' action: write merged/marker content locally, then push it to the server to converge. */
  private async resolveByWrite(
    path: string, content: string, clean: boolean, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], localMtimeBefore: number, summary: SyncSessionSummary,
  ): Promise<void> {
    await this.opts.localAdapter.atomicWrite(path, content);

    // Apply max(local, remote) mtime to the local file.
    // Remote mtime update via PROPPATCH is not supported on Nextcloud (live property, silently ignored);
    // X-OC-MTime on upload already handles mtime for newly uploaded files.
    const maxMtime = Math.max(localMtimeBefore, remote.lastModified || 0) || Date.now();
    await this.opts.localAdapter.setMtime(path, maxMtime);

    // Push the merged result back to the server so BOTH sides converge. Without this the merge stays
    // local-only: the server keeps the old remote copy, every later sync re-detects the same conflict,
    // and the merge never reaches other devices.
    const mergedData = await this.opts.localAdapter.readBinary(path);
    const mergedHash = await sha256(mergedData);
    let uploaded = false;
    try {
      const lockToken = await this.acquireLock(path);
      try {
        const outcome = await this.uploadStrategy!.upload(this.client!, path, mergedData, maxMtime);
        if (outcome !== 'skipped') { summary.uploadedCount++; uploaded = true; this.recordHistory(path, 'uploaded'); }
      } finally {
        await this.releaseLock(path, lockToken);
      }
    } catch (err) {
      // Locked by someone else or a transient failure → keep the conflict and retry next sync.
      this.retryQueue.push(path);
      if (!(err instanceof FileLockedError)) {
        void this.opts.logger?.log(`conflict: merge upload failed (${(err as Error).message}); queued retry → ${path}`);
      }
    }

    const stat = await this.opts.localAdapter.stat(path);
    const prior = this.opts.stateDB.getFile(path);
    const nextState: FileState = {
      path,
      // Claiming the merged body as the local baseline is only truthful once it reached the server.
      // Feature 063: when the push failed, recording it here made the NEXT sync read "local
      // unchanged + remote unchanged" and take the converged arm — which even clears isConflicted —
      // so the merge stayed local forever and never reached the other devices. The G1-1 flag alone
      // cannot prevent that (nothing consumes it on the converged arm). Keeping the previous
      // baseline instead leaves a genuine local change for the next sync to detect and re-push.
      localHash: uploaded ? mergedHash : (prior?.localHash ?? ''),
      // When the merged content is on the server, record it as the synced remote id so the next sync
      // sees both sides as identical (converged) instead of re-detecting the conflict.
      remoteId: uploaded ? mergedHash : remoteId,
      idType: uploaded ? 'sha256' : idType,
      size: stat?.size ?? 0, mtime: maxMtime,
      remoteFileId: remote.fileId,
      // BUG G1-1 fix: isConflicted must also stay true when the upload failed, even for a clean
      // merge — remoteId/idType above are already gated on `uploaded`; without this the committed
      // state pairs the OLD remoteId with the NEW localHash and isConflicted:false, which the next
      // sync reads as "converged" and never retries pushing the merge result.
      isConflicted: !clean || !uploaded,
    };
    // Stamp the post-write stat signature ONLY when the state describes the body actually on disk.
    // After a failed push the recorded localHash deliberately differs from the file, so a signature
    // would let the local-unchanged fast path skip the re-hash that drives the retry.
    this.opts.stateDB.setFile(
      uploaded ? await this.withLocalSignature(nextState, remote.lastModified) : nextState,
    );
    const mergeDetail: SyncHistoryDetail = {
      localHash: mergedHash,
      remoteId: uploaded ? mergedHash : remoteId,
      remoteIdType: uploaded ? 'sha256' : idType,
      localSize: stat?.size ?? 0,
      remoteSize: remote.size,
    };
    if (clean) {
      summary.mergedCount++;
      this.recordHistory(path, 'merged', undefined, mergeDetail);
      // Feature 038: a clean merge that reached the server means both sides now hold the merged
      // content → it is the new common ancestor. If the upload failed (retry queued), the sides have
      // NOT converged yet, so do not advance the base.
      if (uploaded) this.recordMergeBase(path, content);
    } else {
      summary.conflictedCount++;
      this.recordHistory(path, 'conflicted', undefined, mergeDetail);
    }
    void this.opts.logger?.log(`conflict: ${clean ? 'auto-merged clean' : 'wrote conflict markers'}, uploaded=${uploaded} → ${path}`);
  }

  /** 'local-wins' action: overwrite the remote with the local copy. On failure, do NOT mark resolved. */
  private async resolveByPreferLocal(
    path: string, remote: RemoteFileInfo, summary: SyncSessionSummary,
  ): Promise<void> {
    const stat = await this.opts.localAdapter.stat(path);
    const mtime = stat?.mtime ?? Date.now();
    const localData = await this.opts.localAdapter.readBinary(path);
    const localHash = await sha256(localData);
    try {
      const lockToken = await this.acquireLock(path);
      try {
        const outcome = await this.uploadStrategy!.upload(this.client!, path, localData, mtime);
        if (outcome === 'skipped') {
          // Size limit etc.: leave the conflict for the user; do not mark resolved.
          this.retryQueue.push(path);
          return;
        }
      } finally {
        await this.releaseLock(path, lockToken);
      }
    } catch (err) {
      // Upload failed → keep the conflict unresolved and retry next sync (never mark converged).
      this.recordError(summary, path, err);
      this.retryQueue.push(path);
      if (!(err instanceof FileLockedError)) {
        void this.opts.logger?.log(`conflict: prefer-local upload failed (${(err as Error).message}); queued retry → ${path}`);
      }
      return;
    }
    summary.uploadedCount++;
    this.recordHistory(path, 'local-wins', undefined, {
      localHash, remoteId: localHash, remoteIdType: 'sha256',
      localSize: stat?.size ?? localData.byteLength, remoteSize: remote.size,
    });
    this.opts.stateDB.setFile(await this.withLocalSignature({
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: stat?.size ?? localData.byteLength, mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    }, remote.lastModified));
    // Feature 038: both sides now hold the local body → it is the new merge base.
    this.recordMergeBase(path, new TextDecoder().decode(localData));
    void this.opts.logger?.log(`conflict: resolved by prefer-local (remote overwritten) → ${path}`);
  }

  /** 'remote-wins' action: overwrite the local with the remote copy. */
  private async resolveByPreferRemote(
    path: string, remote: RemoteFileInfo, remoteData: ArrayBuffer,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    // Server-anomaly guard (spec 025): never overwrite local with a body whose length disagrees with
    // the advertised remote size (0-byte / truncated). Keep the conflict unresolved and retry.
    if (isAnomalousRemoteContent(remote.size, remoteData.byteLength)) {
      this.recordError(summary, path, new Error(`Refused prefer-remote overwrite: advertised ${remote.size} bytes but body is ${remoteData.byteLength} (server anomaly)`));
      this.retryQueue.push(path);
      void this.opts.logger?.log(`conflict: prefer-remote REFUSED anomalous remote (size ${remote.size}≠${remoteData.byteLength}) → kept local, queued retry → ${path}`);
      return;
    }
    try {
      await this.opts.localAdapter.atomicWriteBinary(path, remoteData);
      if (remote.lastModified) {
        await this.opts.localAdapter.setMtime(path, remote.lastModified);
      }
    } catch (err) {
      // Local write failed → keep the conflict unresolved and retry next sync.
      this.recordError(summary, path, err);
      this.retryQueue.push(path);
      void this.opts.logger?.log(`conflict: prefer-remote write failed (${(err as Error).message}); queued retry → ${path}`);
      return;
    }
    const localHash = await sha256(remoteData);
    const mtime = remote.lastModified || (await this.opts.localAdapter.stat(path))?.mtime || Date.now();
    summary.downloadedCount++;
    this.recordHistory(path, 'remote-wins', undefined, {
      localHash, remoteId, remoteIdType: idType,
      localSize: remoteData.byteLength, remoteSize: remote.size,
    });
    this.opts.stateDB.setFile(await this.withLocalSignature({
      path, localHash, remoteId, idType,
      size: remote.size, mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    }, remote.lastModified));
    // Feature 038: both sides now hold the remote body → it is the new merge base.
    this.recordMergeBase(path, new TextDecoder().decode(remoteData));
    void this.opts.logger?.log(`conflict: resolved by prefer-remote (local overwritten) → ${path}`);
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
  private async reconcileDirectories(summary: SyncSessionSummary, cachedDirs?: RemoteDirInfo[]): Promise<void> {
    let remoteDirInfos: RemoteDirInfo[];
    if (cachedDirs) {
      // Root-ETag short-circuit (spec 023): remote unchanged since the last real scan, so the tracked
      // directory set IS the remote set — skip the getDirectories('') Depth:infinity PROPFIND.
      remoteDirInfos = cachedDirs;
    } else {
      try {
        remoteDirInfos = await this.client!.getDirectories('');
      } catch (err) {
        void this.opts.logger?.log(`dir-sync: listing failed — skip this session: ${(err as Error).message}`);
        return; // self-heal next sync
      }
    }

    const norm = (p: string): string => p.replace(/\/+$/, '');
    const remoteDirs = new Map(remoteDirInfos.map(d => [norm(d.path), d]));
    const vault = this.opts.app.vault as Vault & { getAllFolders?: (includeRoot?: boolean) => TFolder[] };
    const localDirs = new Set(
      (vault.getAllFolders?.() ?? []).map(f => f.path).filter(p => p && p !== '/'),
    );
    const tracked = new Map(this.opts.stateDB.getAllDirs().map(d => [d.path, d]));

    const all = new Set<string>(
      [...remoteDirs.keys(), ...localDirs, ...tracked.keys()].filter(p => p !== '' && !this.isSystemExcluded(p)),
    );

    const mkcolRemote: string[] = []; // L !R !T — created here → push to remote
    const mkdirLocal: string[] = [];  // !L R !T — created elsewhere → create here
    const deleteRemote: string[] = []; // !L R T — deleted here → remove on remote
    const trashLocal: string[] = [];   // L !R T — deleted elsewhere → remove here
    const ensureTracked: DirState[] = []; // L R — keep tracked
    const dropTracked: string[] = [];  // !L !R T — gone everywhere → forget

    for (const p of all) {
      const L = localDirs.has(p), R = remoteDirs.has(p), T = tracked.has(p);
      if (L && R) ensureTracked.push({ path: p, remoteFileId: remoteDirs.get(p)!.fileId });
      else if (L && !R) (T ? trashLocal : mkcolRemote).push(p);
      else if (!L && R) (T ? deleteRemote : mkdirLocal).push(p);
      else if (T) dropTracked.push(p);
    }

    // Circuit breaker on the destructive set (a partial listing would make many dirs look deleted).
    const denom = Math.max(tracked.size, remoteDirs.size, localDirs.size);
    if (deleteRemote.length + trashLocal.length > this.effectiveMassDeleteLimit(denom)) {
      void this.opts.logger?.log(`dir-sync: SKIPPED ${deleteRemote.length + trashLocal.length} dir deletions — exceeds safety limit; likely a partial listing`);
      // Record as an error so the root-ETag short-circuit convergence gate (spec 023 §8a.5) invalidates
      // the stored etag and the next sync really re-scans instead of short-circuiting on stale State.
      const skippedDeleteRemote = [...deleteRemote];
      const skippedTrashLocal = [...trashLocal];
      this.recordError(
        summary, '(dir mass-delete breaker)',
        new Error(`Skipped ${deleteRemote.length + trashLocal.length} dir deletions — exceeds safety limit`),
        undefined,
        { deleteRemote: skippedDeleteRemote, trashLocal: skippedTrashLocal },
      );
      deleteRemote.length = 0;
      trashLocal.length = 0;
    }

    const shallowFirst = (a: string, b: string): number => a.split('/').length - b.split('/').length;
    const deepFirst = (a: string, b: string): number => b.split('/').length - a.split('/').length;

    // CREATE remote (parents before children).
    for (const p of mkcolRemote.sort(shallowFirst)) {
      if (this.cancelled) break;
      try {
        await this.client!.createDirectory(p);
        this.opts.stateDB.setDir({ path: p, remoteFileId: remoteDirs.get(p)?.fileId ?? null });
        this.recordHistory(p, 'uploaded');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir create (remote) failed: ${(err as Error).message}` });
      }
    }
    // CREATE local (parents before children).
    for (const p of mkdirLocal.sort(shallowFirst)) {
      if (this.cancelled) break;
      try {
        await this.opts.app.vault.adapter.mkdir(normalizePath(p));
        this.opts.stateDB.setDir({ path: p, remoteFileId: remoteDirs.get(p)?.fileId ?? null });
        this.recordHistory(p, 'downloaded');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir create (local) failed: ${(err as Error).message}` });
      }
    }
    // DELETE remote (children before parents; probe + optional lock).
    for (const p of deleteRemote.sort(deepFirst)) {
      if (this.cancelled) break;
      let token: string | null = null;
      try {
        token = await this.acquireLock(p);
        if (!(await this.client!.isRemoteDirEmpty(p))) {
          void this.opts.logger?.log(`dir-sync: remote dir not empty yet — keeping → ${p}`);
          continue; // children pending — self-heal next sync
        }
        await this.client!.deleteCollection(p);
        this.opts.stateDB.deleteDir(p);
        summary.deletedCount++;
        this.recordHistory(p, 'deleted');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir delete (remote) failed: ${(err as Error).message}` });
      } finally {
        await this.releaseLock(p, token);
      }
    }
    // TRASH local (children before parents).
    for (const p of trashLocal.sort(deepFirst)) {
      if (this.cancelled) break;
      const folder = this.opts.app.vault.getAbstractFileByPath(p);
      try {
        if (folder instanceof TFolder) await this.opts.app.fileManager.trashFile(folder);
        this.opts.stateDB.deleteDir(p);
        this.recordHistory(p, 'deleted');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir delete (local) failed: ${(err as Error).message}` });
      }
    }
    for (const d of ensureTracked) this.opts.stateDB.setDir(d);
    for (const p of dropTracked) this.opts.stateDB.deleteDir(p);
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
          await this.downloadFile(remote, remote.checksum ?? remote.etag ?? String(remote.size), remote.checksum ? 'sha256' : 'etag', summary);
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
        const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
        const idType: FileState['idType'] = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');
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

