// File transfer, lifted out of SyncEngine (feature 074, Phase 4).
//
// One upload, one download, and the locking and size guards that wrap them. It decides nothing about
// WHICH files move — the engine's reconcile loop does that — only how a single file crosses.
//
// This extraction failed its leaf-ness gate the first time it was assessed, and the record of that is
// worth keeping: transfer reached back into the engine for recordHistory, recordError,
// recordMergeBase and withLocalSignature, which made it a shell that called into the middle of the
// graph rather than a leaf. Those four now live in `sync/session` and `data/localSignature` and
// arrive here as collaborators. What remains pointing outward are two ports — a retry queue and a
// user notifier — and neither re-enters the sync loop.
//
// The WebDAV client and upload strategy are PARAMETERS, never fields: SyncEngine creates both lazily
// and can replace them, so a captured one would go stale.
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

export interface TransferDeps {
  localAdapter: Pick<LocalAdapter, 'stat' | 'readBinary' | 'atomicWriteBinary' | 'setMtime'>;
  stateDB: Pick<StateDB, 'getFile' | 'setFile'>;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  /** Read at call time — the cap is a live setting. */
  maxFileSizeMB(): number;
  /** Whether the server advertises the files-locking capability (arrives on connect). */
  hasFilesLocking(): boolean;
  /**
   * Ask for `path` to be retried later in this session. An outbound port, not a call back into the
   * sync loop: transfer says a file needs another attempt and takes no view on when.
   */
  queueRetry(path: string): void;
  logger?: Pick<FileLogger, 'log'>;
  /** User-facing notice. Injected so the size guard can be tested without an Obsidian runtime. */
  notify?(message: string): void;
}

export class TransferService {
  /**
   * Locks this service currently holds, keyed by path. Owned here rather than by the engine because
   * nothing outside acquire/release ever reads it.
   */
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

    // US4: Acquire lock (only when enabled and supported by the server). If locked by someone else, skip and queue for retry.
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
      // US3: Delegate to the upload strategy (chunked/single/skip).
      // P1-B: send If-Match using the known remote etag (when updating an existing remote file) so a
      // remote that changed since our baseline returns 412 → PreconditionFailedError → conflict. New
      // local files carry a null etag (synthetic remote) → no precondition.
      outcome = await uploadStrategy.upload(client, path, data, stat.mtime, { ifMatchEtag: remote.etag });
    } finally {
      await this.releaseLock(client, path, token);
    }

    if (outcome === 'skipped') return; // Size limit exceeded. Already warned by the strategy (no retry needed).
    summary.uploadedCount++;
    // Feature 064 (C-4): record the state the server now holds, not the one it held before the PUT.
    // Both upload strategies send `OC-Checksum: SHA256:<localHash>` (NextcloudClient.uploadFile /
    // the chunked assembling MOVE), and Nextcloud persists it and returns it as oc:checksums — so the
    // remote id of what we just stored IS localHash. Keeping the PRE-upload remoteId here made every
    // following sync read "remote changed" and download the file we had just uploaded, over and over.
    // resolveByWrite already records the merged body this way; this brings the plain upload in line.
    const uploadedRemoteId = localHash;
    const uploadedIdType: FileState['idType'] = 'sha256';
    this.deps.journal.recordHistory(path, 'uploaded', undefined, {
      localHash, remoteId: uploadedRemoteId, remoteIdType: uploadedIdType,
      localSize: stat.size, remoteSize: remote.size,
    });

    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path, localHash, remoteId: uploadedRemoteId, idType: uploadedIdType,
      size: stat.size, mtime: stat.mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    }, remote.lastModified));
    // Feature 038: remote now equals the local body we just uploaded → it is the new merge base.
    this.deps.mergeBase.record(path, new TextDecoder().decode(data));
  }

  async downloadFile(
    client: IWebDAVClient,
    remote: RemoteFileInfo, remoteId: string,
    idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    // Size guard (spec 035): skip oversized remote files BEFORE the GET. Covers the normal
    // remote→local download AND the local-delete-vs-remote-edit restore path (both route here). Leave
    // local + Base untouched and do NOT queue a retry: a permanent skip until the cap is raised (then
    // the next reconcile re-detects remote-changed and downloads it — self-healing). Not an error.
    if (this.isRemoteOverSizeLimit(remote)) {
      this.warnDownloadSkipped(remote.path, remote.size);
      void this.deps.logger?.log(`download: SKIPPED over size limit (${remote.size}B > ${this.deps.maxFileSizeMB()}MB) → ${remote.path}`);
      return;
    }
    const data = await client.downloadFile(remote.path);
    // Server-anomaly guard (spec 025): refuse to overwrite local with content whose byte length does
    // not match the size the server advertised (0-byte / truncated body on a buggy/inconsistent
    // server). Leave local + Base untouched and retry next sync; a legitimate empty file (advertised
    // size 0) is not flagged.
    if (isAnomalousRemoteContent(remote.size, data.byteLength)) {
      this.deps.journal.recordError(summary, remote.path, new Error(`Refused remote overwrite: server advertised ${remote.size} bytes but returned ${data.byteLength} (server anomaly)`));
      this.deps.queueRetry(remote.path);
      const base = this.deps.stateDB.getFile(remote.path);
      if (base) this.deps.stateDB.setFile({ ...base, isConflicted: true });
      void this.deps.logger?.log(`download: REFUSED anomalous remote (size ${remote.size}≠${data.byteLength}) → kept local, queued retry → ${remote.path}`);
      return;
    }
    await this.deps.localAdapter.atomicWriteBinary(remote.path, data);
    summary.downloadedCount++;

    // Preserve remote mtime on the local file so the two stay in sync.
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
    // Feature 038: local now equals the remote body → that body is the new merge base.
    this.deps.mergeBase.record(remote.path, new TextDecoder().decode(data));
  }

  /**
   * Download-side size guard (spec 035, symmetric with the upload strategies' `isOverFileSizeLimit`).
   * Decides — BEFORE issuing a GET — whether a remote file exceeds `maxFileSizeMB`, using the size the
   * server advertised in PROPFIND (`RemoteFileInfo.size`, getcontentlength) as the source of truth. No
   * body is fetched. `maxFileSizeMB` of 0 means unlimited. This is the single decision point shared by
   * every remote-body fetch path (normal download, deletion-vs-edit restore, conflict, compare, pull):
   * `requestUrl` buffers the whole body in memory and Android base64-encodes it, so a large remote file
   * would OOM the app (issue #8). The threshold logic is reused from upload so both directions agree.
   */
  isRemoteOverSizeLimit(remote: RemoteFileInfo): boolean {
    return isOverFileSizeLimit(remote.size, this.deps.maxFileSizeMB());
  }

  /** User-facing notice for a download skipped by the size guard (mirrors the upload "too large" notice). */
  warnDownloadSkipped(path: string, sizeBytes: number): void {
    const sizeMB = sizeBytes / 1024 / 1024;
    const message = `⚠️ File too large to download: ${path} (${sizeMB.toFixed(1)} MB > ${this.deps.maxFileSizeMB()} MB)`;
    if (this.deps.notify) this.deps.notify(message);
    else new Notice(message);
  }

  // ── US4: Lock acquire/release ──────────────────────────────────────────────

  /**
   * Acquire a file lock before updating. Returns null if locking is disabled/unsupported.
   * If locked by someone else (423), retries with backoff and throws FileLockedError if not released.
   *
   * Public because the engine's conflict-resolution and clean-side write paths take the same lock
   * around their own writes — uploadFile is not the only writer.
   */
  async acquireLock(client: IWebDAVClient, path: string): Promise<string | null> {
    // Feature 033: file locking is always off — lost-update safety is the always-on If-Match
    // precondition, without the LOCK/UNLOCK round-trips. The mechanism below is retained but never
    // engaged from the normal sync path.
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
  async releaseLock(client: IWebDAVClient, path: string, token: string | null): Promise<void> {
    if (!token) return;
    await client.unlockFile(path, token);
    this.heldLocks.delete(path);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
}
