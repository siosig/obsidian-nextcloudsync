import { App, Notice, Platform, TFile, TFolder, Vault, normalizePath } from 'obsidian';
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
  FeatureUnsupportedError,
  PreconditionFailedError,
  RemoteCompareResult,
} from '../types';
import { isSyncTmpPath, LocalAdapter } from '../data/LocalAdapter';
import { StateDB } from '../data/StateDB';
import { SyncHistoryStore } from '../data/SyncHistoryStore';
import { IStatusBar } from '../ui/StatusBarItem';
import { WebDAVFactory } from '../network/WebDAVFactory';
import { IWebDAVClient } from '../network/IWebDAVClient';
import { RenameTracker } from './RenameTracker';
import { ConflictResolver } from './ConflictResolver';
import { ConfigSyncResolver } from './ConfigSyncResolver';
import { sha256 } from '../util/hash';
import { FileLogger } from '../util/FileLogger';
import {
  isCellularBlocked, SIGNATURE_SAFETY_WINDOW_MS, MAX_HASH_SIZE,
  MAX_INFLIGHT_BYTES_DESKTOP, MAX_INFLIGHT_BYTES_MOBILE, massDeleteLimit,
} from '../util/limits';
import { createLimiter, ByteSemaphore } from '../util/ConcurrencyLimiter';
import { isSafeVaultRelativePath } from '../network/remotePath';
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
  /**
   * Called once at the end of each sync session, after history is persisted, with that session's
   * per-file outcomes (chronological). Used to append the per-device sync log. Best-effort.
   */
  onSessionComplete?: (entries: SyncHistoryEntry[], summary: SyncSessionSummary) => void | Promise<void>;
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
  private currentRunStartedAt: number | null = null;
  /** Currently held lock tokens (path → token). */
  private readonly heldLocks = new Map<string, string>();
  /** Progress counters updated during a sync run (reset each run). */
  private syncProgress = { processed: 0, total: 0 };
  private renameTracker: RenameTracker | null = null;
  /**
   * Decides which `.obsidian` config-folder paths sync (category-level opt-in, issue #1) and
   * enumerates them for the local scan. Single source of truth shared by `isSystemExcluded`,
   * the remote-file filter, and the remote-deletion scope guard.
   */
  private readonly configSync: ConfigSyncResolver;

  constructor(private readonly opts: SyncEngineOptions) {
    this.configSync = new ConfigSyncResolver({
      configDir: opts.configDir,
      settings: opts.settings,
      pluginDir: opts.pluginDir,
      localAdapter: opts.localAdapter,
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
      this.uploadStrategy = (this.opts.settings.chunkedUploadEnabled && features.isNextcloud)
        ? new ChunkedUploadStrategy(this.opts.settings)
        : new SimpleUploadStrategy(this.opts.settings);
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
    }
  }

  /** The actual full-sync session body. Always runs under the {@link syncManual} balking guard. */
  private async runSyncSession(): Promise<void> {
    void this.opts.logger?.log('sync: connecting (ensureClient)');
    await this.ensureClient();
    this.syncProgress = { processed: 0, total: 0 };
    this.opts.statusBar.setStatus('syncing');
    const summary = this.initSummary();
    this.currentRunStartedAt = summary.startedAt; // tag this run's history entries for grouping

    const cancelled = false;
    try {
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
      void this.opts.logger?.log(
        `sync: done up=${summary.uploadedCount} down=${summary.downloadedCount} ` +
        `del=${summary.deletedCount} merged=${summary.mergedCount} conflicted=${summary.conflictedCount} err=${summary.errorCount} cancelled=${cancelled}`,
      );
      summary.completedAt = Date.now();
      this.lastSummary = summary;
      this.opts.stateDB.setLastSyncTime(Date.now());
      await this.opts.stateDB.save();
      await this.opts.historyStore?.save(); // persist this session's per-file outcomes (pruned to 24h)
      // Append the per-device sync log (best-effort; the writer no-ops when disabled).
      const sessionEntries = this.opts.historyStore?.since(summary.startedAt) ?? [];
      try { await this.opts.onSessionComplete?.(sessionEntries, summary); } catch { /* never break sync */ }
      const conflictCount = this.opts.stateDB.countConflicted();
      this.opts.statusBar.setSyncComplete(
        summary.uploadedCount, summary.downloadedCount,
        conflictCount, summary.errorCount,
      );
      // Result display is owned by the status bar surface: StatusBarItem on desktop, and
      // NoticeStatusBar (a result toast) on mobile, both via setSyncComplete above. Genuine
      // failures still surface via the catch-block notice / NextcloudErrorParser.
      this.running = false;
      this.currentRunStartedAt = null;
    }
  }

  // ── Single-file lightweight operations (used by watch mode) ─────────────────
  // These avoid a full vault scan / remote REPORT and only touch the one file.

  /** Upload a single locally-modified or created file. No-ops if content is unchanged. */
  async syncSingleFile(path: string): Promise<void> {
    if (this.isSystemExcluded(path)) return;
    await this.ensureClient();
    const stat = await this.opts.localAdapter.stat(path);
    if (!stat) return; // already deleted before the debounce fired
    const data = await this.opts.localAdapter.readBinary(path);
    const localHash = await sha256(data);
    const base = this.opts.stateDB.getFile(path);
    if (base && localHash === base.localHash) return; // content unchanged, skip
    const remoteId = base?.remoteId ?? localHash;
    const idType: FileState['idType'] = base?.idType ?? 'sha256';
    const dummySummary = this.initSummary();
    try {
      await this.uploadFile(
        path, localHash, remoteId, idType,
        { path, fileId: base?.remoteFileId ?? null, checksum: null, etag: null, size: stat.size, lastModified: stat.mtime },
        dummySummary,
      );
      // Watch-mode single-file op: coalesce the state write via a trailing debounce so rapid
      // edits don't each rewrite the whole state file (P0-B). onunload flushes any pending save.
      this.opts.stateDB.requestSave();
      await this.opts.historyStore?.save(); // persist any 'uploaded' entry recorded by uploadFile
    } catch (err) {
      console.warn(`[SyncEngine] Single-file upload failed for ${path}:`, err);
    }
  }

  /** Delete a single file from the remote when it was deleted locally. */
  async deleteSingleFile(path: string): Promise<void> {
    if (this.isSystemExcluded(path)) return;
    await this.ensureClient();
    const base = this.opts.stateDB.getFile(path);
    if (!base) return; // not tracked — nothing to do on remote
    try {
      await this.client!.deleteFile(path, base.remoteId);
      this.recordHistory(path, 'deleted');
    } catch (err) {
      if (!(err instanceof NetworkError && err.status === 404)) {
        console.warn(`[SyncEngine] Single-file delete failed for ${path}:`, err);
      }
    }
    this.opts.stateDB.deleteFile(path);
    this.opts.stateDB.requestSave(); // coalesced watch-mode save (P0-B)
    await this.opts.historyStore?.save();
  }

  /** MOVE a single file on the remote when it was renamed/moved locally. */
  async renameSingleFile(oldPath: string, newPath: string): Promise<void> {
    if (this.isSystemExcluded(oldPath) && this.isSystemExcluded(newPath)) return;
    await this.ensureClient();
    const rt = this.getOrCreateRenameTracker();
    try {
      await rt.applyLocalRename(oldPath, newPath);
      this.opts.stateDB.requestSave(); // coalesced watch-mode save (P0-B)
    } catch (err) {
      console.warn(`[SyncEngine] Single-file rename failed ${oldPath} → ${newPath}:`, err);
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

  /** True when `path`'s extension is in the configured mergeable (text) extensions. */
  private textEligible(path: string): boolean {
    const dot = path.lastIndexOf('.');
    if (dot < 0) return false;
    const ext = path.slice(dot + 1).toLowerCase();
    return (this.opts.settings.mergeableExtensions ?? []).includes(ext);
  }

  /** Fetch a single remote file's metadata via PROPFIND; null when the remote file is absent. */
  private async fetchRemoteInfo(path: string): Promise<RemoteFileInfo | null> {
    const infos = await this.client!.getFiles(path);
    if (infos.length === 0) return null;
    return infos.find(i => i.path === path) ?? infos[0];
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private initSummary(): SyncSessionSummary {
    return {
      startedAt: Date.now(), completedAt: null,
      uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
      mergedCount: 0, conflictedCount: 0,
      errorCount: 0, retriedFiles: [], errors: [],
    };
  }

  /** Count an error and keep its detail for the sync-status dialog. Empty path = session-level. */
  private recordError(summary: SyncSessionSummary, path: string, err: unknown): void {
    summary.errorCount++;
    const message = err instanceof Error ? err.message : String(err);
    summary.errors.push({ path, message });
    if (path) this.recordHistory(path, 'error', message); // session-level errors aren't file history
  }

  /** Append one per-file outcome to the persisted 24h history (no-op when no store is injected). */
  private recordHistory(path: string, op: SyncFileOp, message?: string, detail?: SyncHistoryDetail): void {
    const now = Date.now();
    // Group key for the Sync Status dialog: the active full-sync run's start time, or — for watch-mode
    // single-file ops (no session) — this op's own time, so each forms its own group.
    const runStartedAt = this.currentRunStartedAt ?? now;
    this.opts.historyStore?.record(path, op, now, message, detail, runStartedAt);
  }

  /** First-ever sync: full scan → build plan → execute. */
  private async initialSync(summary: SyncSessionSummary): Promise<void> {
    const client = this.client!;
    const remoteFiles = await client.getFiles('');
    const localFiles = await this.scanLocalFiles();

    // Populate missing server-side checksums (computed by the server, no download) so that
    // files already identical on both sides are recognised as unchanged instead of conflicts.
    await this.resolveRemoteChecksums(remoteFiles, localFiles);

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
          // Fallback to full scan
          remoteFiles = await client.getFiles('');
          isFullScan = true;
          const token = await client.getSyncToken();
          this.opts.stateDB.setSyncToken(token);
          void this.opts.logger?.log(`sync: sync-token expired → FULL SCAN (remote=${remoteFiles.length}, nextToken=${token ? 'obtained' : 'NULL'}). Remote deletions detected by absence (full-scan reconciliation)`);
        } else {
          throw err;
        }
      }
    } else {
      remoteFiles = await client.getFiles('');
      isFullScan = true;
      const token = await client.getSyncToken();
      this.opts.stateDB.setSyncToken(token);
      void this.opts.logger?.log(`sync: FULL SCAN, no prior token (remote=${remoteFiles.length}, nextToken=${token ? 'obtained' : 'NULL'}). Remote deletions detected by absence (full-scan reconciliation)`);
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
    if (isFullScan) await this.reconcileDirectories(summary);
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
   * Local-unchanged fast-path (P0-A). Decides whether `path` can be skipped WITHOUT reading/hashing
   * its content, using the stat signature we captured immediately after our own last write
   * (`localMtime`/`localSize`). This works on mobile, where `setMtime` is a no-op so the on-disk
   * mtime never equals the remote mtime — the old `mtime <= base.mtime` filter therefore failed for
   * every previously-synced file and forced a full-vault rehash every sync.
   *
   * Returns false (⇒ must hash) when: the signature is absent (migrated/old state), the size or
   * mtime differs, OR the file's mtime is within SIGNATURE_SAFETY_WINDOW_MS of now / the last sync
   * completion. The time-window guard prevents missing a same-size in-place edit made within the
   * filesystem's mtime granularity (1–2 s on some mobile storage).
   */
  private isLocallyUnchanged(base: FileState, stat: { mtime: number; size: number }): boolean {
    if (base.localMtime == null || base.localSize == null) return false; // no signature → hash once
    if (stat.size !== base.localSize) return false;
    if (stat.mtime !== base.localMtime) return false;
    const now = Date.now();
    const lastSync = this.opts.stateDB.getLastSyncTime();
    if (this.withinSafetyWindow(stat.mtime, now)) return false;
    if (lastSync > 0 && this.withinSafetyWindow(stat.mtime, lastSync)) return false;
    return true;
  }

  private withinSafetyWindow(mtime: number, ref: number): boolean {
    return Math.abs(ref - mtime) < SIGNATURE_SAFETY_WINDOW_MS;
  }

  /**
   * Stamp the post-write local stat signature (and optional remoteMtime) onto a FileState by
   * re-stat-ing the on-disk file. This captures what the OS actually wrote — the only reliable
   * change-detection key on mobile (no utimes). Call at every content-write / converge site so the
   * next sync's fast-path recognises the file as unchanged. Best-effort: if stat fails, the fields
   * stay undefined and the file is simply hashed next time (correct, just not fast).
   */
  private async withLocalSignature(fs: FileState, remoteMtime?: number | null): Promise<FileState> {
    const st = await this.opts.localAdapter.stat(fs.path);
    if (st) {
      fs.localMtime = st.mtime;
      fs.localSize = st.size;
    }
    if (remoteMtime != null) fs.remoteMtime = remoteMtime;
    return fs;
  }

  /** Parent-directory key of a vault-relative path ('' for a root-level file). */
  private static parentDir(path: string): string {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
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
      const dir = SyncEngine.parentDir(pathOf(it));
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
    } else if (!localStat) {
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
  private async applyLocalDeletion(
    remote: RemoteFileInfo, base: FileState, remoteId: string, idType: FileState['idType'],
    summary: SyncSessionSummary,
  ): Promise<void> {
    // Decide ONLY from a real content hash of the server copy. A SHA-256 match against what we last
    // synced is the only proof that the server copy is unchanged and the deletion is genuinely local.
    let serverHash = remote.checksum ?? null;
    if (!serverHash) {
      try { serverHash = await this.client!.recalcChecksum(remote.path); } catch { serverHash = null; }
    }

    if (serverHash && serverHash === base.localHash) {
      // Server copy is byte-identical to our base → genuine local deletion → propagate (trashbin).
      void this.opts.logger?.log(`delete-remote: local deletion (server checksum matches base) → ${remote.path}`);
      try {
        await this.client!.deleteFile(remote.path, base.remoteId);
        summary.deletedCount++;
        this.recordHistory(remote.path, 'deleted', undefined, {
          localHash: base.localHash, remoteId, remoteIdType: idType,
          localSize: base.size, remoteSize: remote.size,
        });
      } catch (err) {
        if (!(err instanceof NetworkError && err.status === 404)) throw err;
      }
      this.opts.stateDB.deleteFile(remote.path);
    } else if (serverHash && serverHash !== base.localHash) {
      // Server copy diverged after our base → restore it locally so a remote edit is never dropped.
      void this.opts.logger?.log(`conflict(local-delete vs remote-edit): restoring remote → ${remote.path}`);
      await this.downloadFile(remote, remoteId, idType, summary);
    } else {
      // No reliable server checksum (e.g. plain WebDAV, or recalc failed) → do NOT delete. The
      // etag/size are not proof of unchanged content, so deleting here could discard a remote edit.
      // Leave both sides as-is; the deletion still propagates via the incremental token path.
      void this.opts.logger?.log(`delete-remote: SKIPPED — no reliable server checksum to confirm unchanged → ${remote.path}`);
    }
  }

  private async uploadFile(
    path: string, localHash: string, remoteId: string,
    idType: FileState['idType'], remote: RemoteFileInfo,
    summary: SyncSessionSummary,
  ): Promise<void> {
    const stat = await this.opts.localAdapter.stat(path);
    if (!stat) return;

    const data = await this.opts.localAdapter.readBinary(path);

    // US4: Acquire lock (only when enabled and supported by the server). If locked by someone else, skip and queue for retry.
    let token: string | null;
    try {
      token = await this.acquireLock(path);
    } catch (err) {
      if (err instanceof FileLockedError) {
        this.retryQueue.push(path);
        return;
      }
      throw err;
    }

    let outcome: 'uploaded' | 'skipped';
    try {
      // US3: Delegate to the upload strategy (chunked/single/skip).
      // P1-B: send If-Match using the known remote etag (when updating an existing remote file) so a
      // remote that changed since our baseline returns 412 → PreconditionFailedError → conflict. New
      // local files carry a null etag (synthetic remote) → no precondition.
      outcome = await this.uploadStrategy!.upload(this.client!, path, data, stat.mtime, { ifMatchEtag: remote.etag });
    } finally {
      await this.releaseLock(path, token);
    }

    if (outcome === 'skipped') return; // Size limit exceeded. Already warned by the strategy (no retry needed).
    summary.uploadedCount++;
    this.recordHistory(path, 'uploaded', undefined, {
      localHash, remoteId, remoteIdType: idType,
      localSize: stat.size, remoteSize: remote.size,
    });

    this.opts.stateDB.setFile(await this.withLocalSignature({
      path, localHash, remoteId, idType,
      size: stat.size, mtime: stat.mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    }, remote.lastModified));
  }

  // ── US4: Lock acquire/release ──────────────────────────────────────────────

  /**
   * Acquire a file lock before updating. Returns null if locking is disabled/unsupported.
   * If locked by someone else (423), retries with backoff and throws FileLockedError if not released.
   */
  private async acquireLock(path: string): Promise<string | null> {
    if (!this.opts.settings.fileLockingEnabled || !this.features?.hasFilesLocking) return null;
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const token = await this.client!.lockFile(path);
        if (token) this.heldLocks.set(path, token);
        return token;
      } catch (err) {
        if (err instanceof FileLockedError) {
          if (attempt < maxAttempts - 1) {
            await this.sleep(500 * Math.pow(2, attempt)); // exponential backoff
            continue;
          }
          throw err;
        }
        if (err instanceof FeatureUnsupportedError) return null;
        // NetworkError (e.g. HTTP 500 / 404 when the file does not yet exist on the server)
        // must not abort the entire sync — proceed without a lock rather than failing.
        if (err instanceof NetworkError) return null;
        throw err;
      }
    }
    return null;
  }

  /** Release the lock after updating (best-effort). */
  private async releaseLock(path: string, token: string | null): Promise<void> {
    if (!token) return;
    await this.client!.unlockFile(path, token);
    this.heldLocks.delete(path);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  // ── US2: Version history ───────────────────────────────────────────────────

  /** Return the version list for the active note. Throws FeatureUnsupportedError if unsupported or fileId is missing. */
  async listVersions(path: string): Promise<FileVersion[]> {
    const { client, features } = await this.ensureClient();
    if (!features.isNextcloud) throw new FeatureUnsupportedError('versions');
    const fileId = this.opts.stateDB.getFile(path)?.remoteFileId;
    if (!fileId) throw new FeatureUnsupportedError('versions');
    return client.listVersions(fileId);
  }

  /** Restore the specified version, apply it locally, and update the state DB (FR-007/008). */
  async restoreVersion(path: string, version: FileVersion): Promise<void> {
    const { client, features } = await this.ensureClient();
    if (!features.isNextcloud) throw new FeatureUnsupportedError('versions');
    const fileId = this.opts.stateDB.getFile(path)?.remoteFileId;
    if (!fileId) throw new FeatureUnsupportedError('versions');

    // 1. Restore on the server side (MOVE restore).
    await client.restoreVersion(version, fileId);
    // 2. Fetch the current content after restore and atomically apply it locally.
    const data = await client.downloadFile(path);
    await this.opts.localAdapter.atomicWriteBinary(path, data);
    // 3. Update the state DB (localHash=remoteId=hash of restored content, isConflicted=false).
    const localHash = await sha256(data);
    const stat = await this.opts.localAdapter.stat(path);
    this.opts.stateDB.setFile(await this.withLocalSignature({
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: stat?.size ?? data.byteLength, mtime: stat?.mtime ?? Date.now(),
      remoteFileId: fileId, isConflicted: false,
    }));
    await this.opts.stateDB.save();
  }

  private async downloadFile(
    remote: RemoteFileInfo, remoteId: string,
    idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    const data = await this.client!.downloadFile(remote.path);
    await this.opts.localAdapter.atomicWriteBinary(remote.path, data);
    summary.downloadedCount++;

    // Preserve remote mtime on the local file so the two stay in sync.
    if (remote.lastModified) {
      await this.opts.localAdapter.setMtime(remote.path, remote.lastModified);
    }

    const localHash = await sha256(data);
    this.recordHistory(remote.path, 'downloaded', undefined, {
      localHash, remoteId, remoteIdType: idType,
      localSize: data.byteLength, remoteSize: remote.size,
    });
    const mtime = remote.lastModified || (await this.opts.localAdapter.stat(remote.path))?.mtime || Date.now();
    this.opts.stateDB.setFile(await this.withLocalSignature({
      path: remote.path, localHash, remoteId, idType,
      size: remote.size, mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    }, remote.lastModified));
  }

  private async handleConflict(
    path: string, base: FileState | undefined, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    // Capture local mtime BEFORE writing the merge result so we can compute max(local, remote).
    const localStatBefore = await this.opts.localAdapter.stat(path);
    const localMtimeBefore = localStatBefore?.mtime ?? 0;

    // Config-folder files (appearance.json, etc.) are JSON state, not authored prose: writing
    // text conflict markers would corrupt the JSON and stop Obsidian reading the setting. Resolve
    // these by newest-wins (most recent mtime), reusing the prefer-local/prefer-remote paths so
    // markers/merge are never applied. Equal mtime → remote-wins (stable tiebreak).
    if (this.configSync.isConfigFolderConflictPath(path)) {
      if ((remote.lastModified || 0) >= localMtimeBefore) {
        const remoteData = await this.client!.downloadFile(remote.path);
        void this.opts.logger?.log(`conflict(config): remote newer, pulling → ${path}`);
        await this.resolveByPreferRemote(path, remote, remoteData, remoteId, idType, summary);
      } else {
        void this.opts.logger?.log(`conflict(config): local newer, pushing → ${path}`);
        await this.resolveByPreferLocal(path, remote, summary);
      }
      return;
    }

    const localContent = await this.opts.localAdapter.read(path);
    const remoteData = await this.client!.downloadFile(remote.path);
    const remoteContent = new TextDecoder().decode(remoteData);

    const resolver = new ConflictResolver(this.opts.app, this.opts.localAdapter, this.opts.settings);
    const decision = resolver.decide(path, '', localContent, remoteContent);

    switch (decision.action) {
      case 'skip':
        // Failure policy 'error' (or non-text × conflict-markers fallback): touch NEITHER side.
        // Leave the StateDB hashes untouched so the next sync re-detects the divergence; only flag
        // the entry as conflicted (for the UI). Count as an error and retry within this session.
        this.recordError(summary, path, new Error('Unresolved conflict — both sides left untouched (failure policy: error)'));
        this.retryQueue.push(path);
        if (base) this.opts.stateDB.setFile({ ...base, isConflicted: true });
        void this.opts.logger?.log(`conflict: skipped (policy=error), left both sides untouched → ${path}`);
        return;

      case 'prefer-local':
        await this.resolveByPreferLocal(path, remote, summary);
        return;

      case 'prefer-remote':
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
    this.opts.stateDB.setFile(await this.withLocalSignature({
      path, localHash: mergedHash,
      // When the merged content is on the server, record it as the synced remote id so the next sync
      // sees both sides as identical (converged) instead of re-detecting the conflict.
      remoteId: uploaded ? mergedHash : remoteId,
      idType: uploaded ? 'sha256' : idType,
      size: stat?.size ?? 0, mtime: maxMtime,
      remoteFileId: remote.fileId, isConflicted: !clean,
    }, remote.lastModified));
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
    void this.opts.logger?.log(`conflict: resolved by prefer-local (remote overwritten) → ${path}`);
  }

  /** 'remote-wins' action: overwrite the local with the remote copy. */
  private async resolveByPreferRemote(
    path: string, remote: RemoteFileInfo, remoteData: ArrayBuffer,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
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
    void this.opts.logger?.log(`conflict: resolved by prefer-remote (local overwritten) → ${path}`);
  }

  private async processRemoteDeletion(path: string, summary: SyncSessionSummary): Promise<void> {
    // Security boundary (centralized at the delete sink): never act on a server-reported deletion
    // for a path the engine treats as out of scope (the Obsidian config folder, other plugins, etc.).
    // A malicious/compromised server could fabricate a REPORT deletion for `.obsidian/...`; without
    // this guard it would reach the raw fs remove below and permanently destroy config the sync
    // engine otherwise never touches. Every other server-driven sink already filters with
    // isSystemExcluded; enforcing it here covers all callers (incremental + full-scan).
    if (this.isSystemExcluded(path)) {
      void this.opts.logger?.log(`delete-local: ignored out-of-scope remote deletion → ${path}`);
      return;
    }
    void this.opts.logger?.log(`delete-local: applying remote deletion → ${path}`);
    const file = this.opts.app.vault.getAbstractFileByPath(path);
    const normalized = normalizePath(path);
    try {
      if (file instanceof TFile || file instanceof TFolder) {
        // Honor the user's Obsidian "Deleted files" setting (system trash / .trash / permanent
        // delete) instead of forcing one behavior. trashFile handles both files and folders.
        await this.opts.app.fileManager.trashFile(file);
        summary.downloadedCount++;
        this.recordHistory(path, 'deleted'); // remote deletion applied locally
      } else if (isSafeVaultRelativePath(path) && await this.opts.app.vault.adapter.exists(normalized)) {
        // Not a vault-tracked abstract file (e.g. dotfiles under a config folder): delete it
        // directly so the deletion is never silently skipped. Defense-in-depth: only when the
        // path is safe (no traversal / not absolute), so an attacker-controlled remote path can
        // never reach this raw fs sink even if the boundary guard is ever bypassed.
        await this.opts.app.vault.adapter.remove(normalized);
        summary.downloadedCount++;
        this.recordHistory(path, 'deleted'); // remote deletion applied locally (config dotfile)
      }
      // else: already gone locally — nothing to delete, fall through to state cleanup.
    } catch (err) {
      // Don't abort the whole sync session for one failed deletion; notify and keep the
      // StateDB entry so the next sync retries this path.
      new Notice(`❌ Failed to delete ${path}: ${(err as Error).message}`, 6000);
      return;
    }
    this.opts.stateDB.deleteFile(path);
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
        }
      }
      this.opts.stateDB.deleteFile(path);
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
      const limit = massDeleteLimit(tracked);
      if (candidates.length > limit) {
        void this.opts.logger?.log(`delete-local: SKIPPED ${candidates.length} absence-deletions — exceeds safety limit (${limit}); likely a partial remote listing`);
        new Notice(`⚠️ ${candidates.length} files look deleted on the server — skipped to avoid mass deletion. Re-sync to retry.`, 10000);
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
  private async reconcileDirectories(summary: SyncSessionSummary): Promise<void> {
    let remoteDirInfos: RemoteDirInfo[];
    try {
      remoteDirInfos = await this.client!.getDirectories('');
    } catch (err) {
      void this.opts.logger?.log(`dir-sync: listing failed — skip this session: ${(err as Error).message}`);
      return; // self-heal next sync
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
    if (deleteRemote.length + trashLocal.length > massDeleteLimit(denom)) {
      void this.opts.logger?.log(`dir-sync: SKIPPED ${deleteRemote.length + trashLocal.length} dir deletions — exceeds safety limit; likely a partial listing`);
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

  /**
   * For files that exist on both sides but whose server-side checksum is not yet stored,
   * ask the server to compute SHA-256 on demand (no download; Nextcloud ChecksumUpdatePlugin).
   * Best-effort and bounded-parallel: clients/servers without support leave the checksum null,
   * which makes buildInitialPlan fall back to content-based conflict resolution.
   */
  private async resolveRemoteChecksums(
    remoteFiles: RemoteFileInfo[],
    localFiles: Map<string, { size: number; mtime: number }>,
  ): Promise<void> {
    const targets = remoteFiles.filter(rf => !rf.checksum && localFiles.has(rf.path));
    const concurrency = Math.max(1, this.opts.settings.networkConcurrency);
    for (let i = 0; i < targets.length; i += concurrency) {
      const batch = targets.slice(i, i + concurrency);
      await Promise.all(batch.map(async (rf) => {
        try {
          const sum = await this.client!.recalcChecksum(rf.path);
          if (sum) rf.checksum = sum;
        } catch { /* leave null; falls back to conflict resolution */ }
      }));
    }
  }

  private async scanLocalFiles(): Promise<Map<string, { size: number; mtime: number }>> {
    const results = new Map<string, { size: number; mtime: number }>();
    // Enumerate Vault-tracked files from the in-memory index (no native FS round-trips on mobile).
    // Task 3 (P1): hashing is deferred entirely to buildInitialPlan, which only hashes files that
    // need a checksum comparison to be classified as unchanged (remote exists + sizes match + server
    // checksum present). This eliminates all readBinary calls during the initial scan on mobile.
    for (const e of this.opts.localAdapter.listVaultFiles()) {
      if (this.isSystemExcluded(e.path)) continue;
      results.set(e.path, { size: e.size, mtime: e.mtime });
    }
    // The config folder is not Vault-tracked; inject the enabled config-sync category paths explicitly.
    for (const p of await this.configSync.enumerateIncludedPaths()) {
      const stat = await this.opts.localAdapter.stat(p);
      if (stat) results.set(p, { size: stat.size, mtime: stat.mtime });
    }
    // Task 7 (C1 fix): Vault.getFiles() omits ALL dot-prefixed paths, but the previous
    // adapter.list() scan synced non-.obsidian dot files/folders. Re-enumerate them here.
    await this.collectDotPaths(results);
    return results;
  }

  /** Collect path→stat for local files in sync scope without computing hashes (Vault-cache based). */
  private async collectLocalStats(_dir: string, out: Map<string, { size: number; mtime: number }>): Promise<void> {
    for (const e of this.opts.localAdapter.listVaultFiles()) {
      if (this.isSystemExcluded(e.path)) continue;
      out.set(e.path, { size: e.size, mtime: e.mtime });
    }
    // The config folder is not Vault-tracked; the caller injects enabled config-sync paths separately.
    // Task 7 (C1 fix): supplement with non-config dot paths that Vault.getFiles() omits.
    await this.collectDotPaths(out);
  }

  /**
   * Re-enumerate non-config dot paths that Vault.getFiles() omits. Vault excludes ALL dot-prefixed
   * paths, but the previous adapter.list scan synced non-.obsidian dotfiles/folders (e.g. .archive/),
   * so the Vault switch would silently stop syncing them. The config folder is handled separately by
   * ConfigSyncResolver and is skipped here. NOTE: dot files nested inside NON-dot folders
   * (e.g. notes/.foo.md) are intentionally out of scope — Obsidian does not index them and a full
   * recursion would defeat the Vault-cache round-trip savings.
   */
  private async collectDotPaths(out: Map<string, { size: number; mtime: number }>): Promise<void> {
    let root: { files: string[]; folders: string[] };
    try { root = await this.opts.localAdapter.list(''); } catch { return; }
    for (const file of root.files) {
      if (!SyncEngine.isDotName(file)) continue;
      if (this.isSystemExcluded(file)) continue;
      const st = await this.opts.localAdapter.stat(file);
      if (st) out.set(file, { size: st.size, mtime: st.mtime });
    }
    for (const folder of root.folders) {
      if (!SyncEngine.isDotName(folder)) continue;
      if (this.configSync.isUnderConfigDir(folder)) continue; // .obsidian handled by ConfigSyncResolver
      await this.collectStatsRecursiveViaAdapter(folder, out);
    }
  }

  /** True when a vault path's last segment is dot-prefixed. */
  private static isDotName(path: string): boolean {
    const i = path.lastIndexOf('/');
    return (i < 0 ? path : path.slice(i + 1)).startsWith('.');
  }

  /** Recursively enumerate a (Vault-untracked) directory's files via the adapter, stats only. */
  private async collectStatsRecursiveViaAdapter(dir: string, out: Map<string, { size: number; mtime: number }>): Promise<void> {
    let listing: { files: string[]; folders: string[] };
    try { listing = await this.opts.localAdapter.list(dir); } catch { return; }
    for (const file of listing.files) {
      if (this.isSystemExcluded(file)) continue;
      const st = await this.opts.localAdapter.stat(file);
      if (st) out.set(file, { size: st.size, mtime: st.mtime });
    }
    for (const folder of listing.folders) {
      await this.collectStatsRecursiveViaAdapter(folder, out);
    }
  }

  private isSystemExcluded(path: string): boolean {
    // The plugin's own atomic-write temp files are never sync content (defense in depth:
    // the vault watchers already filter them, but a leftover tmp must not be uploaded either).
    if (isSyncTmpPath(path)) return true;
    // This device's own per-device log file, while its output toggle is ON: the plugin appends to
    // it during the sync, so syncing it would race the live append (Obsidian's rename throws
    // "Destination file already exists!") and churn. Turning the log OFF makes it static and
    // syncable again. Another device's log (different host) is not written here and stays syncable.
    if (this.opts.isActiveLogFile?.(path)) return true;
    // Ordinary vault files (outside the config folder) are never system-excluded.
    if (!this.configSync.isUnderConfigDir(path)) return false;
    // Inside the config folder: excluded unless an enabled config-sync category includes it.
    // Community plugins (plugins/) and the plugin's own state DB are never included (hard
    // exclusions inside ConfigSyncResolver), so the remote-deletion scope guard — which also
    // calls this method — keeps protecting them.
    return !this.configSync.isIncluded(path);
  }
}

