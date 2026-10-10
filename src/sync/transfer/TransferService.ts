// One upload, one download, and the locking and size guards around them. It decides nothing about WHICH files
// move, only how a single file crosses. The WebDAV client and upload strategy are PARAMETERS, never fields:
// SyncEngine creates both lazily and can replace them, so a captured one would go stale.
import { Notice } from 'obsidian';
import { FileState, RemoteFileInfo, SyncSessionSummary } from '../../types';
import { FileLockedError, FeatureUnsupportedError, NetworkError } from '../../types';
import { LocalAdapter } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy } from '../upload/IUploadStrategy';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { withLocalSignature } from '../../data/localSignature';
import { FileLogger } from '../../util/FileLogger';
import { FIXED } from '../../util/fixedSyncConfig';
import { isAnomalousRemoteContent, isOverFileSizeLimit } from '../../util/limits';
import { sha256 } from '../../util/hash';
import { remoteIdOf } from '../remoteIdentity';
import { bytesEqual } from '../identity/contentIdentity';

export interface TransferDeps {
  localAdapter: Pick<LocalAdapter, 'stat' | 'readBinary' | 'atomicWriteBinary' | 'setMtime'>;
  stateDB: Pick<StateDB, 'getFile' | 'setFile'>;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  // Read at call time: the cap is a live setting.
  maxFileSizeMB(): number;
  hasFilesLocking(): boolean;
  // Asks which client is running, not what the server said: `StandardWebDAVClient` hardcodes `checksum: null`,
  // so recording a SHA-256 against plain WebDAV would mismatch what the next sync reads back (docs/spec.md §4.1).
  // Deliberately NOT the server's `hasChecksums` capability, which is false on the official Docker image even
  // though PROPFIND returns checksums.
  clientReportsChecksums(): boolean;
  // An outbound port, not a call back into the sync loop: transfer says a file needs another attempt, not when.
  queueRetry(path: string): void;
  logger?: Pick<FileLogger, 'log'>;
  // Injected so the size guard can be tested without an Obsidian runtime.
  notify?(message: string): void;
}

export class TransferService {
  // Held locks keyed by path; only acquire/release read it.
  private readonly heldLocks = new Map<string, string>();

  constructor(private readonly deps: TransferDeps) {}

  async uploadFile(
    client: IWebDAVClient, uploadStrategy: IUploadStrategy,
    path: string, localHash: string, remoteId: string,
    idType: FileState['idType'], remote: RemoteFileInfo,
    summary: SyncSessionSummary,
  ): Promise<void> {
    const stat = await this.deps.localAdapter.stat(path);
    if (!stat) return;

    const data = await this.deps.localAdapter.readBinary(path);

    // A path locked by someone else is skipped and queued for retry.
    let token: string | null;
    try {
      token = await this.acquireLock(client, path);
    } catch (err) {
      if (err instanceof FileLockedError) {
        this.deps.queueRetry(path);
        return;
      }
      throw err;
    }

    let outcome: 'uploaded' | 'skipped';
    try {
      // If-Match with the known remote etag makes a remote changed since our baseline return 412
      // (PreconditionFailedError, a conflict). New local files carry a null etag, so no precondition.
      outcome = await uploadStrategy.upload(client, path, data, stat.mtime, { ifMatchEtag: remote.etag });
    } finally {
      await this.releaseLock(client, path, token);
    }

    if (outcome === 'skipped') return; // Over the size limit; the strategy already warned, no retry needed.
    summary.uploadedCount++;
    // Record the state the server holds now, not before the PUT. Both strategies send `OC-Checksum: SHA256:<localHash>`
    // and Nextcloud returns it as oc:checksums, so the remote id IS localHash; keeping the pre-upload id would make
    // every later sync download the file just uploaded. Only true where the client can read a checksum back: on
    // plain WebDAV the next PROPFIND yields an ETag, so ask the server and record that instead.
    let uploadedRemoteId = localHash;
    let uploadedIdType: FileState['idType'] = 'sha256';
    if (!this.deps.clientReportsChecksums()) {
      // A failed or empty stat keeps the sha256 values on purpose: recording nothing would strand the baseline
      // and the next sync would see BOTH sides changed (a conflict over the user's file). The cost is one
      // redundant download, after which the real remote id is recorded.
      try {
        const fresh = await client.statFile(path);
        if (fresh) ({ remoteId: uploadedRemoteId, idType: uploadedIdType } = remoteIdOf(fresh));
      } catch (err) {
        void this.deps.logger?.log(`upload: could not re-read ${path} after upload — ${(err as Error).message}`);
      }
    }
    this.deps.journal.recordHistory(path, 'uploaded', undefined, {
      localHash, remoteId: uploadedRemoteId, remoteIdType: uploadedIdType,
      localSize: stat.size, remoteSize: remote.size,
    });

    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path, localHash, remoteId: uploadedRemoteId, idType: uploadedIdType,
      size: stat.size, mtime: stat.mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    }, remote.lastModified));
    // The remote now equals the uploaded body, so it is the new merge base.
    this.deps.mergeBase.record(path, new TextDecoder().decode(data));
  }

  async downloadFile(
    client: IWebDAVClient,
    remote: RemoteFileInfo, remoteId: string,
    idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    // Skip oversized remote files BEFORE the GET, covering the normal download and the local-delete-vs-remote-edit
    // restore. Local and Base stay untouched and no retry is queued: the skip is permanent until the cap is
    // raised, then the next reconcile downloads it. Not an error (docs/spec.md §9.4).
    if (this.isRemoteOverSizeLimit(remote)) {
      this.warnDownloadSkipped(remote.path, remote.size);
      void this.deps.logger?.log(`download: SKIPPED over size limit (${remote.size}B > ${this.deps.maxFileSizeMB()}MB) → ${remote.path}`);
      return;
    }
    const data = await client.downloadFile(remote.path);
    // Refuse to overwrite local with a body whose length differs from the advertised size (0-byte or truncated
    // body from a buggy server). Local and Base stay untouched and the file is retried; an advertised size 0
    // is not flagged.
    if (isAnomalousRemoteContent(remote.size, data.byteLength)) {
      this.deps.journal.recordError(summary, remote.path, new Error(`Refused remote overwrite: server advertised ${remote.size} bytes but returned ${data.byteLength} (server anomaly)`));
      this.deps.queueRetry(remote.path);
      const base = this.deps.stateDB.getFile(remote.path);
      if (base) this.deps.stateDB.setFile({ ...base, isConflicted: true });
      void this.deps.logger?.log(`download: REFUSED anomalous remote (size ${remote.size}≠${data.byteLength}) → kept local, queued retry → ${remote.path}`);
      return;
    }
    // A fetched body equal to the local file is not written (docs/spec.md §5.3a): the mtime stays and no vault event fires.
    const localStat = await this.deps.localAdapter.stat(remote.path);
    if (localStat && localStat.size === data.byteLength
        && bytesEqual(await this.deps.localAdapter.readBinary(remote.path), data)) {
      const sameHash = await sha256(data);
      this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
        path: remote.path, localHash: sameHash, remoteId, idType,
        size: remote.size, mtime: remote.lastModified || localStat.mtime,
        remoteFileId: remote.fileId, isConflicted: false,
      }, remote.lastModified));
      this.deps.mergeBase.record(remote.path, new TextDecoder().decode(data));
      void this.deps.logger?.log(`download: body identical to the local file → state converged, no write → ${remote.path}`);
      return;
    }
    await this.deps.localAdapter.atomicWriteBinary(remote.path, data);
    summary.downloadedCount++;

    if (remote.lastModified) {
      await this.deps.localAdapter.setMtime(remote.path, remote.lastModified);
    }

    const localHash = await sha256(data);
    this.deps.journal.recordHistory(remote.path, 'downloaded', undefined, {
      localHash, remoteId, remoteIdType: idType,
      localSize: data.byteLength, remoteSize: remote.size,
    });
    const mtime = remote.lastModified || (await this.deps.localAdapter.stat(remote.path))?.mtime || Date.now();
    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path: remote.path, localHash, remoteId, idType,
      size: remote.size, mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    }, remote.lastModified));
    // Local now equals the remote body, so it is the new merge base.
    this.deps.mergeBase.record(remote.path, new TextDecoder().decode(data));
  }

  // Decided BEFORE any GET from the PROPFIND-advertised size; `maxFileSizeMB` 0 means unlimited. The single
  // decision point for every remote-body fetch: `requestUrl` buffers the whole body (and Android base64-encodes
  // it), so a large file would OOM the app (issue #8, docs/spec.md §9.4).
  isRemoteOverSizeLimit(remote: RemoteFileInfo): boolean {
    return isOverFileSizeLimit(remote.size, this.deps.maxFileSizeMB());
  }

  warnDownloadSkipped(path: string, sizeBytes: number): void {
    const sizeMB = sizeBytes / 1024 / 1024;
    const message = `⚠️ File too large to download: ${path} (${sizeMB.toFixed(1)} MB > ${this.deps.maxFileSizeMB()} MB)`;
    if (this.deps.notify) this.deps.notify(message);
    else new Notice(message);
  }

  // Returns null if locking is disabled/unsupported; on 423 retries with backoff, then throws FileLockedError.
  // Public because the conflict-resolution and clean-side write paths take the same lock around their writes.
  async acquireLock(client: IWebDAVClient, path: string): Promise<string | null> {
    // File locking is always off: lost-update safety is the If-Match precondition, without LOCK/UNLOCK
    // round-trips. The mechanism is retained but not engaged by the normal sync path (docs/spec.md §6.5).
    if (!FIXED.fileLockingEnabled || !this.deps.hasFilesLocking()) return null;
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const token = await client.lockFile(path);
        if (token) this.heldLocks.set(path, token);
        return token;
      } catch (err) {
        if (err instanceof FileLockedError) {
          if (attempt < maxAttempts - 1) {
            await this.sleep(500 * Math.pow(2, attempt));
            continue;
          }
          throw err;
        }
        if (err instanceof FeatureUnsupportedError) return null;
        // A NetworkError (e.g. 404 for a file not yet on the server) must not abort the sync; proceed without a lock.
        if (err instanceof NetworkError) return null;
        throw err;
      }
    }
    return null;
  }

  async releaseLock(client: IWebDAVClient, path: string, token: string | null): Promise<void> {
    if (!token) return;
    await client.unlockFile(path, token);
    this.heldLocks.delete(path);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
}
