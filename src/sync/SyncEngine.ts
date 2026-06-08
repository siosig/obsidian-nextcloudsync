import { App, Notice, TFile } from 'obsidian';
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
} from '../types';
import { LocalAdapter } from '../data/LocalAdapter';
import { StateDB } from '../data/StateDB';
import { StatusBarItem } from '../ui/StatusBarItem';
import { WebDAVFactory } from '../network/WebDAVFactory';
import { IWebDAVClient } from '../network/IWebDAVClient';
import { DryRunModal, DryRunPlan } from '../ui/DryRunModal';
import { RenameTracker } from './RenameTracker';
import { ConflictResolver } from './ConflictResolver';
import { sha256 } from '../util/hash';
import { IUploadStrategy } from './upload/IUploadStrategy';
import { SimpleUploadStrategy } from './upload/SimpleUploadStrategy';
import { ChunkedUploadStrategy } from './upload/ChunkedUploadStrategy';

export interface SyncEngineOptions {
  app: App;
  settings: DavSyncSettings;
  localAdapter: LocalAdapter;
  stateDB: StateDB;
  statusBar: StatusBarItem;
  webdavFactory: WebDAVFactory;
  pluginDir: string;
}

// Paths always excluded from sync
const SYSTEM_EXCLUDE_PATTERNS = ['.obsidian/plugins/obsidian-nextcloudsync/'];

export class SyncEngine {
  private autoSyncHandle: number | null = null;
  private lastSummary: SyncSessionSummary | null = null;
  private retryQueue: string[] = [];
  private client: IWebDAVClient | null = null;
  private features: NextcloudFeatures | null = null;
  private uploadStrategy: IUploadStrategy | null = null;
  /** 同期実行中フラグ（多重起動防止）。 */
  private running = false;
  /** 取得中のロックトークン（path → token）。 */
  private readonly heldLocks = new Map<string, string>();

  constructor(private readonly opts: SyncEngineOptions) {}

  /**
   * WebDAV クライアント・Capability・アップロード戦略を一度だけ初期化する。
   * Capability を見て chunked/lock 等の拡張可否を決める（Progressive Enhancement）。
   */
  private async ensureClient(): Promise<{ client: IWebDAVClient; features: NextcloudFeatures }> {
    if (!this.client || !this.features) {
      const { client, features } = await this.opts.webdavFactory.createClient();
      this.client = client;
      this.features = features;
      this.uploadStrategy = (this.opts.settings.chunkedUploadEnabled && features.isNextcloud)
        ? new ChunkedUploadStrategy(this.opts.settings)
        : new SimpleUploadStrategy();
    }
    return { client: this.client, features: this.features };
  }

  /** Manual sync: Dry Run → user approval → execute */
  async syncManual(): Promise<void> {
    // 多重起動防止（ウォッチモードや定期同期と手動実行の競合を避ける）。
    if (this.running) return;
    this.running = true;
    await this.ensureClient();
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
      this.running = false;
    }
  }

  startAutoSync(intervalMinutes: number): void {
    this.stopAutoSync();
    const ms = intervalMinutes * 60 * 1000;
    this.autoSyncHandle = window.setInterval(async () => {
      await this.syncManual();
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

  getUnresolvedConflictCount(): Promise<number> {
    return Promise.resolve(this.opts.stateDB.countConflicted());
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private initSummary(): SyncSessionSummary {
    return {
      startedAt: Date.now(), completedAt: null,
      uploadedCount: 0, downloadedCount: 0, conflictCount: 0,
      errorCount: 0, retriedFiles: [],
    };
  }

  /** First-ever sync: full scan → Dry Run → user approval → execute */
  private async initialSync(summary: SyncSessionSummary): Promise<void> {
    const client = this.client!;
    const remoteFiles = await client.getFiles('');
    const localFiles = await this.scanLocalFiles();

    const plan = this.buildInitialPlan(localFiles, remoteFiles);

    const modal = new DryRunModal(this.opts.app, plan);
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
    for (const remote of remoteFiles) {
      if (this.isSystemExcluded(remote.path)) continue;
      await this.processFileWithRetry(remote, summary);
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

    // US4: ロック取得（有効かつ対応サーバーのみ）。他者ロック中はスキップしてリトライへ。
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
      // US3: アップロード戦略（チャンク/単一/スキップ）に委譲。
      outcome = await this.uploadStrategy!.upload(this.client!, path, data);
    } finally {
      await this.releaseLock(path, token);
    }

    if (outcome === 'skipped') return; // 上限超過。戦略側で警告済み（リトライ不要）。
    summary.uploadedCount++;

    this.opts.stateDB.setFile({
      path, localHash, remoteId, idType,
      size: stat.size, mtime: stat.mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    });
  }

  // ── US4: ロック取得・解放 ──────────────────────────────────────────────────

  /**
   * 更新前にファイルロックを取得する。ロック無効/非対応なら null。
   * 他者ロック中（423）はバックオフ再試行し、解放されなければ FileLockedError を投げる。
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
            await this.sleep(500 * Math.pow(2, attempt)); // 指数バックオフ
            continue;
          }
          throw err;
        }
        if (err instanceof FeatureUnsupportedError) return null;
        throw err;
      }
    }
    return null;
  }

  /** 更新後にロックを解放する（ベストエフォート）。 */
  private async releaseLock(path: string, token: string | null): Promise<void> {
    if (!token) return;
    await this.client!.unlockFile(path, token);
    this.heldLocks.delete(path);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  // ── US2: バージョン履歴 ────────────────────────────────────────────────────

  /** アクティブノートのバージョン一覧を返す。非対応・fileId 無しは FeatureUnsupportedError。 */
  async listVersions(path: string): Promise<FileVersion[]> {
    const { client, features } = await this.ensureClient();
    if (!features.isNextcloud) throw new FeatureUnsupportedError('versions');
    const fileId = this.opts.stateDB.getFile(path)?.remoteFileId;
    if (!fileId) throw new FeatureUnsupportedError('versions');
    return client.listVersions(fileId);
  }

  /** 指定バージョンを復元し、ローカルへ反映して状態DBを更新する（FR-007/008）。 */
  async restoreVersion(path: string, version: FileVersion): Promise<void> {
    const { client, features } = await this.ensureClient();
    if (!features.isNextcloud) throw new FeatureUnsupportedError('versions');
    const fileId = this.opts.stateDB.getFile(path)?.remoteFileId;
    if (!fileId) throw new FeatureUnsupportedError('versions');

    // 1. サーバー側を復元（MOVE restore）。
    await client.restoreVersion(version, fileId);
    // 2. 復元後の現行内容を取得してローカルへアトミック反映。
    await client.downloadFile(path, '');
    const data = client.getLastDownloadBuffer();
    await this.opts.localAdapter.atomicWriteBinary(path, data);
    // 3. 状態DB を更新（localHash=remoteId=復元内容のハッシュ、isConflicted=false）。
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
    await this.client!.downloadFile(remote.path, ''); // tmp path handled below
    const data = this.client!.getLastDownloadBuffer();
    await this.opts.localAdapter.atomicWriteBinary(remote.path, data);
    summary.downloadedCount++;

    // Recompute local hash
    const localHash = await sha256(data);
    const stat = await this.opts.localAdapter.stat(remote.path);
    this.opts.stateDB.setFile({
      path: remote.path, localHash, remoteId, idType,
      size: remote.size, mtime: stat?.mtime ?? Date.now(),
      remoteFileId: remote.fileId, isConflicted: false,
    });
  }

  private async handleConflict(
    path: string, base: FileState | undefined, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    const localContent = await this.opts.localAdapter.read(path);
    await this.client!.downloadFile(remote.path, '');
    const remoteData = this.client!.getLastDownloadBuffer();
    const remoteContent = new TextDecoder().decode(remoteData);
    const baseContent = ''; // Base content not stored; use empty as base for 3-way diff

    const resolver = new ConflictResolver(this.opts.app, this.opts.localAdapter, this.opts.settings);
    await resolver.resolve(path, baseContent, localContent, remoteContent);
    summary.conflictCount++;

    const stat = await this.opts.localAdapter.stat(path);
    const localHash = await sha256(await this.opts.localAdapter.readBinary(path));
    this.opts.stateDB.setFile({
      path, localHash, remoteId, idType,
      size: stat?.size ?? 0, mtime: stat?.mtime ?? Date.now(),
      remoteFileId: remote.fileId, isConflicted: true,
    });
    void base;
  }

  private async processRemoteDeletion(path: string, summary: SyncSessionSummary): Promise<void> {
    const file = this.opts.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.opts.app.vault.trash(file, true);
      summary.downloadedCount++;
    }
    this.opts.stateDB.deleteFile(path);
  }

  private async processLocalModifications(remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary): Promise<void> {
    const remotePathSet = new Set(remoteFiles.map(f => f.path));
    for (const base of this.opts.stateDB.getAllFiles()) {
      if (remotePathSet.has(base.path)) continue; // already handled
      const stat = await this.opts.localAdapter.stat(base.path);
      if (!stat) continue; // file deleted locally — handled elsewhere
      if (stat.mtime <= base.mtime) continue; // unchanged
      const data = await this.opts.localAdapter.readBinary(base.path);
      const localHash = await sha256(data);
      if (localHash === base.localHash) continue;
      await this.uploadFile(base.path, localHash, base.remoteId, base.idType, { path: base.path, fileId: base.remoteFileId, checksum: null, etag: null, size: stat.size, lastModified: stat.mtime }, summary);
    }
  }

  private buildInitialPlan(
    localFiles: Map<string, { hash: string; size: number; mtime: number }>,
    remoteFiles: RemoteFileInfo[],
  ): DryRunPlan {
    const uploads: string[] = [];
    const downloads: string[] = [];
    const conflicts: string[] = [];
    const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));

    for (const [path] of localFiles) {
      if (!remoteMap.has(path)) uploads.push(path);
      else conflicts.push(path); // exists on both sides — assume conflict for first sync
    }
    for (const remote of remoteFiles) {
      if (!localFiles.has(remote.path)) downloads.push(remote.path);
    }
    return { uploads, downloads, conflicts, deletes: [] };
  }

  private async executePlan(plan: DryRunPlan, remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary): Promise<void> {
    const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));
    const localFiles = await this.scanLocalFiles();

    for (const path of plan.uploads) {
      try {
        const lf = localFiles.get(path);
        if (!lf) continue;
        const data = await this.opts.localAdapter.readBinary(path);
        const outcome = await this.uploadStrategy!.upload(this.client!, path, data);
        if (outcome === 'skipped') continue; // 上限超過（戦略側で警告済み）
        summary.uploadedCount++;
        const stat = await this.opts.localAdapter.stat(path);
        this.opts.stateDB.setFile({ path, localHash: lf.hash, remoteId: lf.hash, idType: 'sha256', size: lf.size, mtime: stat?.mtime ?? 0, remoteFileId: null, isConflicted: false });
      } catch { summary.errorCount++; this.retryQueue.push(path); }
    }

    for (const path of plan.downloads) {
      try {
        const remote = remoteMap.get(path)!;
        await this.downloadFile(remote, remote.checksum ?? remote.etag ?? String(remote.size), remote.checksum ? 'sha256' : 'etag', summary);
      } catch { summary.errorCount++; this.retryQueue.push(path); }
    }
  }

  private async scanLocalFiles(): Promise<Map<string, { hash: string; size: number; mtime: number }>> {
    const results = new Map<string, { hash: string; size: number; mtime: number }>();
    // ローカルは常に Vault 全体をスキャンする（リモート側は Vault 名フォルダ配下に同期される）。
    await this.scanDir('', results);
    return results;
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
    return SYSTEM_EXCLUDE_PATTERNS.some(p => path.startsWith(p));
  }
}

