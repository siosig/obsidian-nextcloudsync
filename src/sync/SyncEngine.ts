import { App, Notice, Platform, TFile, TFolder, normalizePath } from 'obsidian';
import {
  DavSyncSettings,
  FileState,
  FileVersion,
  NextcloudFeatures,
  RemoteFileInfo,
  SyncSessionSummary,
  SyncTokenExpiredError,
  NetworkError,
  FileLockedError,
  FeatureUnsupportedError,
  SyncAction,
  SyncPlanEntry,
  MergePreview,
} from '../types';
import { LocalAdapter } from '../data/LocalAdapter';
import { StateDB } from '../data/StateDB';
import { IStatusBar } from '../ui/StatusBarItem';
import { WebDAVFactory } from '../network/WebDAVFactory';
import { IWebDAVClient } from '../network/IWebDAVClient';
import { DryRunModal, DryRunPlan } from '../ui/DryRunModal';
import { DiffModal } from '../ui/DiffModal';
import { RenameTracker } from './RenameTracker';
import { ConflictResolver } from './ConflictResolver';
import { sha256 } from '../util/hash';
import { isCellularBlocked } from '../util/limits';
import { isSafeVaultRelativePath } from '../network/remotePath';
import { IUploadStrategy } from './upload/IUploadStrategy';
import { SimpleUploadStrategy } from './upload/SimpleUploadStrategy';
import { ChunkedUploadStrategy } from './upload/ChunkedUploadStrategy';

export interface SyncEngineOptions {
  app: App;
  settings: DavSyncSettings;
  localAdapter: LocalAdapter;
  stateDB: StateDB;
  statusBar: IStatusBar;
  webdavFactory: WebDAVFactory;
  pluginDir: string;
  /** Obsidian's configuration folder (Vault#configDir), e.g. `.obsidian`. User-configurable. */
  configDir: string;
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
  /** Sync-in-progress flag (prevents concurrent runs). */
  private running = false;
  /** Currently held lock tokens (path → token). */
  private readonly heldLocks = new Map<string, string>();
  /** Progress counters updated during a sync run (reset each run). */
  private syncProgress = { processed: 0, total: 0 };
  private renameTracker: RenameTracker | null = null;

  constructor(private readonly opts: SyncEngineOptions) {}

  /** Obsidian's bookmarks config file (the only candidate exception to the config-folder exclusion). */
  private get bookmarksPath(): string {
    return `${this.opts.configDir}/bookmarks.json`;
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

  /** Manual sync: Dry Run → user approval → execute */
  /**
   * "Wi-Fi only" gate. Skips when enabled and on a cellular connection.
   * Network type is only detectable on Chromium (desktop / Android); iOS (WebKit) has no
   * `navigator.connection`, so the setting is ignored there (and its toggle is disabled).
   */
  private isBlockedByWifiOnly(): boolean {
    const conn = (navigator as Navigator & { connection?: { type?: string } }).connection;
    return isCellularBlocked(this.opts.settings.syncOnWifiOnly, Platform.isIosApp, conn?.type);
  }

  async syncManual(): Promise<void> {
    // Prevent concurrent runs (avoid clashing with watch mode or scheduled sync).
    if (this.running) return;
    if (this.isBlockedByWifiOnly()) return; // "Wi-Fi only" enabled and on cellular
    this.running = true;
    await this.ensureClient();
    this.syncProgress = { processed: 0, total: 0 };
    this.opts.statusBar.setStatus('syncing');
    const summary = this.initSummary();

    try {
      const isFirstSync = !this.opts.stateDB.getSyncToken() && this.opts.stateDB.getAllFiles().length === 0;

      if (isFirstSync) {
        await this.initialSync(summary);
      } else {
        await this.incrementalSync(summary);
      }
    } catch (err) {
      console.error('[SyncEngine] Sync failed:', err);
      new Notice(`❌ Sync failed: ${(err as Error).message}`, 6000);
      summary.errorCount++;
    } finally {
      summary.completedAt = Date.now();
      this.lastSummary = summary;
      this.opts.stateDB.setLastSyncTime(Date.now());
      await this.opts.stateDB.save();
      const conflictCount = this.opts.stateDB.countConflicted();
      this.opts.statusBar.setSyncComplete(
        summary.uploadedCount, summary.downloadedCount,
        conflictCount, summary.errorCount,
      );
      // Sync results are reflected in the status bar only (no completion popup).
      // Genuine failures still surface via the catch-block notice / NextcloudErrorParser.
      this.running = false;
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
      await this.opts.stateDB.save();
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
    } catch (err) {
      if (!(err instanceof NetworkError && err.status === 404)) {
        console.warn(`[SyncEngine] Single-file delete failed for ${path}:`, err);
      }
    }
    this.opts.stateDB.deleteFile(path);
    await this.opts.stateDB.save();
  }

  /** MOVE a single file on the remote when it was renamed/moved locally. */
  async renameSingleFile(oldPath: string, newPath: string): Promise<void> {
    if (this.isSystemExcluded(oldPath) && this.isSystemExcluded(newPath)) return;
    await this.ensureClient();
    const rt = this.getOrCreateRenameTracker();
    try {
      await rt.applyLocalRename(oldPath, newPath);
      await this.opts.stateDB.save();
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

  getLastSessionSummary(): SyncSessionSummary | null {
    return this.lastSummary;
  }

  /**
   * Snapshot for the status-bar dialog: last session summary plus the current lists of
   * conflicted files and files queued for retry (the two things the status bar counts).
   */
  getStatusReport(): { summary: SyncSessionSummary | null; conflictedFiles: string[]; retryFiles: string[] } {
    const conflictedFiles = this.opts.stateDB.getAllFiles()
      .filter(f => f.isConflicted)
      .map(f => f.path);
    return { summary: this.lastSummary, conflictedFiles, retryFiles: [...this.retryQueue] };
  }

  getUnresolvedConflictCount(): Promise<number> {
    return Promise.resolve(this.opts.stateDB.countConflicted());
  }

  /**
   * Compute a dry-run plan (debug mode): classify each file by what a sync would do,
   * without making any change. Best-effort approximation of the real sync decisions.
   */
  async previewSync(): Promise<SyncPlanEntry[]> {
    const { client } = await this.ensureClient();
    const remoteFiles = await client.getFiles('');
    const remoteList = remoteFiles.filter(f => !this.isSystemExcluded(f.path));
    const localFiles = await this.scanLocalFiles();
    // Resolve missing server-side checksums (computed by the server, no download) so the preview
    // matches what a real first sync would decide. Without this, files that are byte-identical on
    // both sides but have no recorded base state are all mis-reported as merges.
    await this.resolveRemoteChecksums(remoteList, localFiles);
    const remoteMap = new Map(remoteList.map(f => [f.path, f]));

    // First sync (no recorded base): the decision is purely content identity (mirrors buildInitialPlan).
    const firstSyncBoth = (identical: boolean): SyncAction =>
      identical ? 'unchanged' : (this.opts.settings.autoMergeEnabled ? 'merge' : 'conflict');

    const entries: SyncPlanEntry[] = [];
    // Include StateDB paths so locally-deleted files (in StateDB but not local/remote) are shown.
    const allPaths = new Set<string>([
      ...localFiles.keys(),
      ...remoteMap.keys(),
      ...this.opts.stateDB.getAllFiles().map(f => f.path),
    ]);
    for (const path of allPaths) {
      const lf = localFiles.get(path);
      const rf = remoteMap.get(path);
      const base = this.opts.stateDB.getFile(path);
      const localExists = lf !== undefined;
      const remoteExists = rf !== undefined;
      const remoteId = rf ? (rf.checksum ?? rf.etag ?? String(rf.size)) : null;

      let action: SyncAction;
      if (localExists && remoteExists) {
        if (!base) {
          action = firstSyncBoth(rf.checksum != null && rf.checksum === lf.hash);
        } else {
          const localChanged = base.localHash !== lf.hash;
          const remoteChanged = base.remoteId !== remoteId;
          if (!localChanged && !remoteChanged) action = 'unchanged';
          else if (localChanged && !remoteChanged) action = 'upload';
          else if (!localChanged && remoteChanged) action = 'download';
          else action = firstSyncBoth(false);
        }
      } else if (localExists && !remoteExists) {
        // Remote missing: new local file → upload; previously synced → remote was deleted.
        action = !base ? 'upload' : (base.localHash !== lf.hash ? 'upload' : 'delete-local');
      } else {
        // Local missing: new remote file → download; previously synced → local was deleted.
        action = !base ? 'download' : (base.remoteId !== remoteId ? 'download' : 'delete-remote');
      }

      entries.push({ path, action, localExists, remoteExists });
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  /**
   * Debug-mode merge preview for one file: read the local content, fetch the remote content,
   * and compute what a real sync would write — all WITHOUT modifying anything. For files that
   * exist only on one side, the "after" side is simply that side's content (upload/download as-is).
   */
  async previewMerge(path: string): Promise<MergePreview> {
    const { client } = await this.ensureClient();
    const stat = await this.opts.localAdapter.stat(path);
    const localExists = stat != null;
    const local = localExists ? await this.opts.localAdapter.read(path) : '';

    let remote = '';
    let remoteExists = false;
    try {
      await client.downloadFile(path, '');
      remote = new TextDecoder().decode(client.getLastDownloadBuffer());
      remoteExists = true;
    } catch {
      remoteExists = false; // remote missing (e.g. a new local file)
    }

    let after: string;
    let clean = true;
    if (localExists && !remoteExists) {
      after = local; // upload as-is
    } else if (!localExists && remoteExists) {
      after = remote; // download as-is
    } else {
      // Both sides present: compute exactly what ConflictResolver would write (base unknown → '').
      const resolver = new ConflictResolver(this.opts.app, this.opts.localAdapter, this.opts.settings);
      const res = resolver.computeResolution('', local, remote);
      after = res.content;
      clean = res.clean;
    }

    return { path, localExists, remoteExists, local, remote, after, clean };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * One-line, settings-aware description of what a conflict resolution will produce.
   * Shown in the dry-run preview so the user knows the outcome before approving.
   */
  private describeConflictOutcome(): string {
    const s = this.opts.settings;
    if (s.autoMergeEnabled) {
      return 'Each conflicting file is auto-merged where the two sides changed different parts '
        + '(frontmatter included). Anything that cannot be merged is kept as BOTH versions with '
        + '<<<<<<< / >>>>>>> markers and a #conflict tag — nothing is discarded. '
        + 'Select a file to preview the exact merged result.';
    }
    return 'Both versions are kept in the file with <<<<<<< / >>>>>>> conflict markers and a '
      + '#conflict tag — nothing is overwritten. Select a file to preview the exact result.';
  }

  private initSummary(): SyncSessionSummary {
    return {
      startedAt: Date.now(), completedAt: null,
      uploadedCount: 0, downloadedCount: 0, deletedCount: 0, conflictCount: 0,
      errorCount: 0, retriedFiles: [],
    };
  }

  /** First-ever sync: full scan → Dry Run → user approval → execute */
  private async initialSync(summary: SyncSessionSummary): Promise<void> {
    const client = this.client!;
    const remoteFiles = await client.getFiles('');
    const localFiles = await this.scanLocalFiles();

    // Populate missing server-side checksums (computed by the server, no download) so that
    // files already identical on both sides are recognised as unchanged instead of conflicts.
    await this.resolveRemoteChecksums(remoteFiles, localFiles);

    const plan = this.buildInitialPlan(localFiles, remoteFiles);

    const modal = new DryRunModal(this.opts.app, plan, {
      conflictNote: this.describeConflictOutcome(),
      onSelectConflict: (path) => {
        // Read-only preview of the exact content the resolution will write for this file.
        void (async () => {
          try {
            const preview = await this.previewMerge(path);
            new DiffModal(this.opts.app, preview).open();
          } catch (err) {
            new Notice(`❌ Merge preview failed: ${(err as Error).message}`, 6000);
          }
        })();
      },
    });
    const approved = await modal.waitForDecision();
    if (!approved) {
      new Notice('Sync cancelled.');
      return;
    }

    await this.executePlan(plan, remoteFiles, summary);

    // Save sync-token
    const token = await client.getSyncToken();
    this.opts.stateDB.setSyncToken(token);
  }

  /** Incremental sync using sync-token (falls back to full PROPFIND on 410) */
  private async incrementalSync(summary: SyncSessionSummary): Promise<void> {
    const client = this.client!;
    let remoteFiles: RemoteFileInfo[];

    const existingToken = this.opts.stateDB.getSyncToken();
    if (existingToken) {
      try {
        const changes = await client.getChanges(existingToken);
        this.opts.stateDB.setSyncToken(changes.newSyncToken);
        remoteFiles = changes.modified;

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
          const token = await client.getSyncToken();
          this.opts.stateDB.setSyncToken(token);
        } else {
          throw err;
        }
      }
    } else {
      remoteFiles = await client.getFiles('');
      const token = await client.getSyncToken();
      this.opts.stateDB.setSyncToken(token);
    }

    // Retry queue files
    const retried = this.retryQueue.splice(0);
    summary.retriedFiles = retried;

    // Process each remote file
    const eligible = remoteFiles.filter(f => !this.isSystemExcluded(f.path));
    this.syncProgress = { processed: 0, total: eligible.length };
    if (eligible.length > 0) this.opts.statusBar.setProgress(0, eligible.length);
    for (const remote of eligible) {
      await this.processFileWithRetry(remote, summary);
      this.tickProgress();
    }

    // Process local modifications (files in stateDB not covered by remote changes)
    await this.processLocalModifications(remoteFiles, summary);
  }

  private async processFileWithRetry(remote: RemoteFileInfo, summary: SyncSessionSummary): Promise<void> {
    try {
      await this.processRemoteFile(remote, summary);
    } catch (err) {
      if (err instanceof NetworkError) {
        console.warn(`[SyncEngine] Error syncing ${remote.path}, queuing retry:`, err);
        this.retryQueue.push(remote.path);
        summary.errorCount++;
        // Continue with next file (FR-015)
      } else {
        throw err;
      }
    }
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
      if (localStat.mtime > base.mtime) {
        // Recompute hash
        const buf = await this.opts.localAdapter.readBinary(remote.path);
        localHash = await sha256(buf);
        localChanged = localHash !== base.localHash;
      }
    } else if (!localStat) {
      localChanged = false; // new from remote
    }

    if (!remoteChanged && !localChanged) return; // Unchanged

    if (localChanged && !remoteChanged) {
      await this.uploadFile(remote.path, localHash, remoteId, idType, remote, summary);
    } else if (!localChanged && remoteChanged) {
      await this.downloadFile(remote, remoteId, idType, summary);
    } else {
      // Both changed: Conflicted
      await this.handleConflict(remote.path, base, remote, remoteId, idType, summary);
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
      outcome = await this.uploadStrategy!.upload(this.client!, path, data, stat.mtime);
    } finally {
      await this.releaseLock(path, token);
    }

    if (outcome === 'skipped') return; // Size limit exceeded. Already warned by the strategy (no retry needed).
    summary.uploadedCount++;

    this.opts.stateDB.setFile({
      path, localHash, remoteId, idType,
      size: stat.size, mtime: stat.mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    });
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
    await client.downloadFile(path, '');
    const data = client.getLastDownloadBuffer();
    await this.opts.localAdapter.atomicWriteBinary(path, data);
    // 3. Update the state DB (localHash=remoteId=hash of restored content, isConflicted=false).
    const localHash = await sha256(data);
    const stat = await this.opts.localAdapter.stat(path);
    this.opts.stateDB.setFile({
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: stat?.size ?? data.byteLength, mtime: stat?.mtime ?? Date.now(),
      remoteFileId: fileId, isConflicted: false,
    });
    await this.opts.stateDB.save();
  }

  private async downloadFile(
    remote: RemoteFileInfo, remoteId: string,
    idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    await this.client!.downloadFile(remote.path, '');
    const data = this.client!.getLastDownloadBuffer();
    await this.opts.localAdapter.atomicWriteBinary(remote.path, data);
    summary.downloadedCount++;

    // Preserve remote mtime on the local file so the two stay in sync.
    if (remote.lastModified) {
      await this.opts.localAdapter.setMtime(remote.path, remote.lastModified);
    }

    const localHash = await sha256(data);
    const mtime = remote.lastModified || (await this.opts.localAdapter.stat(remote.path))?.mtime || Date.now();
    this.opts.stateDB.setFile({
      path: remote.path, localHash, remoteId, idType,
      size: remote.size, mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    });
  }

  private async handleConflict(
    path: string, base: FileState | undefined, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    // Capture local mtime BEFORE writing the merge result so we can compute max(local, remote).
    const localStatBefore = await this.opts.localAdapter.stat(path);
    const localMtimeBefore = localStatBefore?.mtime ?? 0;

    const localContent = await this.opts.localAdapter.read(path);
    await this.client!.downloadFile(remote.path, '');
    const remoteData = this.client!.getLastDownloadBuffer();
    const remoteContent = new TextDecoder().decode(remoteData);
    const baseContent = '';

    const resolver = new ConflictResolver(this.opts.app, this.opts.localAdapter, this.opts.settings);
    await resolver.resolve(path, baseContent, localContent, remoteContent);
    summary.conflictCount++;

    // Apply max(local, remote) mtime to the local file.
    // Remote mtime update via PROPPATCH is not supported on Nextcloud (live property, silently ignored);
    // X-OC-MTime on upload already handles mtime for newly uploaded files.
    const maxMtime = Math.max(localMtimeBefore, remote.lastModified || 0) || Date.now();
    await this.opts.localAdapter.setMtime(path, maxMtime);

    const stat = await this.opts.localAdapter.stat(path);
    const localHash = await sha256(await this.opts.localAdapter.readBinary(path));
    this.opts.stateDB.setFile({
      path, localHash, remoteId, idType,
      size: stat?.size ?? 0, mtime: maxMtime,
      remoteFileId: remote.fileId, isConflicted: true,
    });
    void base;
  }

  private async processRemoteDeletion(path: string, summary: SyncSessionSummary): Promise<void> {
    const file = this.opts.app.vault.getAbstractFileByPath(path);
    const normalized = normalizePath(path);
    try {
      if (file instanceof TFile || file instanceof TFolder) {
        // Honor the user's Obsidian "Deleted files" setting (system trash / .trash / permanent
        // delete) instead of forcing one behavior. trashFile handles both files and folders.
        await this.opts.app.fileManager.trashFile(file);
        summary.downloadedCount++;
      } else if (isSafeVaultRelativePath(path) && await this.opts.app.vault.adapter.exists(normalized)) {
        // Not a vault-tracked abstract file (e.g. dotfiles under a config folder): delete it
        // directly so the deletion is never silently skipped. Defense-in-depth: only when the
        // path is safe (no traversal / not absolute), so an attacker-controlled remote path can
        // never reach this raw fs sink even if the boundary guard is ever bypassed.
        await this.opts.app.vault.adapter.remove(normalized);
        summary.downloadedCount++;
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

  private async processLocalModifications(remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary): Promise<void> {
    const remotePathSet = new Set(remoteFiles.map(f => f.path));

    // Scan local files in scope for sync (both new and modified).
    const localStats = new Map<string, { size: number; mtime: number }>();
    await this.collectLocalStats('', localStats);
    // The config folder is not scanned, so explicitly add bookmarks when allowed.
    if (this.opts.settings.syncBookmarks) {
      const st = await this.opts.localAdapter.stat(this.bookmarksPath);
      if (st) localStats.set(this.bookmarksPath, { size: st.size, mtime: st.mtime });
    }

    for (const [path, st] of localStats) {
      if (remotePathSet.has(path)) continue; // already handled in the remote-changes loop
      const base = this.opts.stateDB.getFile(path);
      // For known files, use mtime as a first-pass filter to quickly skip unchanged ones.
      if (base && st.mtime <= base.mtime) continue;
      const data = await this.opts.localAdapter.readBinary(path);
      const localHash = await sha256(data);
      if (base && localHash === base.localHash) continue; // content unchanged
      // For new files, use the local hash as remoteId (= the server checksum after upload).
      const remoteId = base?.remoteId ?? localHash;
      const idType: FileState['idType'] = base?.idType ?? 'sha256';
      await this.uploadFile(
        path, localHash, remoteId, idType,
        { path, fileId: base?.remoteFileId ?? null, checksum: null, etag: null, size: st.size, lastModified: st.mtime },
        summary,
      );
    }

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
        summary.errorCount++;
      }
    }

    // Remaining missing paths (not renames) are genuine local deletions → delete from remote.
    for (const path of missingPaths) {
      if (localRenames.has(path)) continue; // handled as rename above
      const fileState = this.opts.stateDB.getFile(path);
      if (!fileState) continue;
      try {
        await this.client!.deleteFile(path, fileState.remoteId);
        summary.deletedCount++;
      } catch (err) {
        if (err instanceof NetworkError && err.status === 404) {
          // Already gone from remote — StateDB cleanup is sufficient.
        } else {
          console.warn(`[SyncEngine] Failed to delete ${path} from remote:`, err);
          summary.errorCount++;
        }
      }
      this.opts.stateDB.deleteFile(path);
    }
  }

  private buildInitialPlan(
    localFiles: Map<string, { hash: string; size: number; mtime: number }>,
    remoteFiles: RemoteFileInfo[],
  ): DryRunPlan {
    const uploads: string[] = [];
    const downloads: string[] = [];
    const conflicts: string[] = [];
    const unchanged: string[] = [];
    const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));

    for (const [path, lf] of localFiles) {
      const remote = remoteMap.get(path);
      if (!remote) { uploads.push(path); continue; }
      // Identical content (server-computed SHA-256 == local) → no transfer needed.
      // When the checksum is unavailable (older/standard server), fall back to conflict resolution.
      if (remote.checksum && remote.checksum === lf.hash) unchanged.push(path);
      else conflicts.push(path);
    }
    for (const remote of remoteFiles) {
      if (this.isSystemExcluded(remote.path)) continue; // do not import excluded paths (.obsidian, etc.)
      if (!localFiles.has(remote.path)) downloads.push(remote.path);
    }
    return { uploads, downloads, conflicts, unchanged, deletes: [] };
  }

  private async executePlan(plan: DryRunPlan, remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary): Promise<void> {
    const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));
    const localFiles = await this.scanLocalFiles();
    const actionFiles = plan.uploads.length + plan.downloads.length + plan.conflicts.length;
    this.syncProgress = { processed: 0, total: actionFiles };
    if (actionFiles > 0) this.opts.statusBar.setProgress(0, actionFiles);

    for (const path of plan.uploads) {
      try {
        const lf = localFiles.get(path);
        if (!lf) continue;
        const data = await this.opts.localAdapter.readBinary(path);
        const outcome = await this.uploadStrategy!.upload(this.client!, path, data, lf.mtime);
        if (outcome === 'skipped') continue;
        summary.uploadedCount++;
        const stat = await this.opts.localAdapter.stat(path);
        this.opts.stateDB.setFile({ path, localHash: lf.hash, remoteId: lf.hash, idType: 'sha256', size: lf.size, mtime: stat?.mtime ?? 0, remoteFileId: null, isConflicted: false });
      } catch { summary.errorCount++; this.retryQueue.push(path); }
      this.tickProgress();
    }

    for (const path of plan.downloads) {
      try {
        const remote = remoteMap.get(path)!;
        await this.downloadFile(remote, remote.checksum ?? remote.etag ?? String(remote.size), remote.checksum ? 'sha256' : 'etag', summary);
      } catch { summary.errorCount++; this.retryQueue.push(path); }
      this.tickProgress();
    }

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
      this.opts.stateDB.setFile({
        path, localHash: lf.hash, remoteId: remote.checksum ?? lf.hash, idType: 'sha256',
        size: lf.size, mtime, remoteFileId: remote.fileId, isConflicted: false,
      });
    }

    // Files present on both sides with differing content: resolve as conflicts.
    for (const path of plan.conflicts) {
      try {
        const remote = remoteMap.get(path)!;
        const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
        const idType: FileState['idType'] = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');
        await this.handleConflict(path, undefined, remote, remoteId, idType, summary);
      } catch { summary.errorCount++; this.retryQueue.push(path); }
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
    localFiles: Map<string, { hash: string; size: number; mtime: number }>,
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

  private async scanLocalFiles(): Promise<Map<string, { hash: string; size: number; mtime: number }>> {
    const results = new Map<string, { hash: string; size: number; mtime: number }>();
    // Locally, always scan the entire Vault (remotely, content is synced under a folder named after the Vault).
    await this.scanDir('', results);
    // The entire config folder is excluded from scanning, so explicitly inject bookmarks when allowed.
    if (this.opts.settings.syncBookmarks) {
      const stat = await this.opts.localAdapter.stat(this.bookmarksPath);
      if (stat) {
        const data = await this.opts.localAdapter.readBinary(this.bookmarksPath);
        results.set(this.bookmarksPath, { hash: await sha256(data), size: stat.size, mtime: stat.mtime });
      }
    }
    return results;
  }

  /** Collect path→stat for local files in sync scope without computing hashes (first-pass filter for change detection). */
  private async collectLocalStats(dir: string, out: Map<string, { size: number; mtime: number }>): Promise<void> {
    try {
      const listing = await this.opts.localAdapter.list(dir);
      for (const file of listing.files) {
        if (this.isSystemExcluded(file)) continue;
        const stat = await this.opts.localAdapter.stat(file);
        if (stat) out.set(file, { size: stat.size, mtime: stat.mtime });
      }
      for (const folder of listing.folders) {
        if (!this.isSystemExcluded(folder)) await this.collectLocalStats(folder, out);
      }
    } catch { /* ignore unreadable dirs */ }
  }

  private async scanDir(dir: string, results: Map<string, { hash: string; size: number; mtime: number }>): Promise<void> {
    try {
      const listing = await this.opts.localAdapter.list(dir);
      for (const file of listing.files) {
        if (this.isSystemExcluded(file)) continue;
        const stat = await this.opts.localAdapter.stat(file);
        if (!stat) continue;
        const data = await this.opts.localAdapter.readBinary(file);
        const hash = await sha256(data);
        results.set(file, { hash, size: stat.size, mtime: stat.mtime });
      }
      for (const folder of listing.folders) {
        if (!this.isSystemExcluded(folder)) {
          await this.scanDir(folder, results);
        }
      }
    } catch { /* ignore unreadable dirs */ }
  }

  private isSystemExcluded(path: string): boolean {
    // Bookmarks are synced only when enabled in settings (an exception to the config-folder exclusion).
    if (path === this.bookmarksPath) return !this.opts.settings.syncBookmarks;
    // Everything under the config folder (settings, themes, other plugins, state DB, etc.) is always excluded.
    const configDir = this.opts.configDir;
    return path === configDir || path.startsWith(`${configDir}/`);
  }
}

