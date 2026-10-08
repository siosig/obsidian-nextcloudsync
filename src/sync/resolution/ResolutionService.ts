// Everything the USER can do to settle one file: compare with the remote, force one side to win (push / pull),
// or recover pre-conflict content from the clean-side snapshots (docs/spec.md §6.4). Compare and snapshots share
// a module because applyCleanLocal/applyCleanRemote fall back to push/pull when no snapshot exists. Nothing here
// belongs to a sync session: failures reject (or land in the compare result's `state`) for the caller to surface.
import { Notice } from 'obsidian';
import { RemoteFileInfo, RemoteCompareResult } from '../../types';
import { LocalAdapter } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { CleanSideStore } from '../../data/CleanSideStore';
import { SyncHistoryStore } from '../../data/SyncHistoryStore';
import { CleanSideMetrics } from '../../ui/compareResolution';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy } from '../upload/IUploadStrategy';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { TransferService } from '../transfer/TransferService';
import { withLocalSignature } from '../../data/localSignature';
import { isTextEligible } from '../policy';
import { FileLogger } from '../../util/FileLogger';
import { sha256 } from '../../util/hash';

type CompareLocalSide = Pick<
  RemoteCompareResult,
  'path' | 'localExists' | 'localMtime' | 'localChecksum' | 'localText' | 'localSize'
>;

// Resolved by the caller because the connection is created lazily and can be replaced.
export interface Connection {
  client: IWebDAVClient;
  uploadStrategy: IUploadStrategy;
}

export interface ResolutionDeps {
  localAdapter: Pick<LocalAdapter, 'stat' | 'readBinary' | 'atomicWriteBinary' | 'setMtime'>;
  stateDB: Pick<StateDB, 'getFile' | 'setFile' | 'save' | 'countConflicted'>;
  historyStore?: Pick<SyncHistoryStore, 'save'>;
  cleanSideStore?: Pick<CleanSideStore, 'get' | 'set' | 'delete' | 'paths' | 'requestSave'>;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  // Used for its lock handling and size guard, the same ones the sync path uses.
  transfer: TransferService;
  autoMergeFileTypes(): readonly string[];
  maxFileSizeMB(): number;
  logger?: Pick<FileLogger, 'log'>;
  // Injected so the size guard can be exercised without an Obsidian runtime.
  notify?(message: string): void;
}

export class ResolutionService {
  constructor(private readonly deps: ResolutionDeps) {}

  getUnresolvedConflictCount(): Promise<number> {
    return Promise.resolve(this.deps.stateDB.countConflicted());
  }

  // Read-only. Checksums are byte-level SHA-256 so the match indicator is valid for binary files; failures
  // land in the returned `state` instead of being thrown.
  async compareWithRemote(client: IWebDAVClient, path: string): Promise<RemoteCompareResult> {
    const textEligible = isTextEligible(path, this.deps.autoMergeFileTypes());

    const stat = await this.deps.localAdapter.stat(path);
    const localExists = stat != null;
    let localChecksum: string | null = null;
    let localText: string | null = null;
    if (localExists) {
      const localBytes = await this.deps.localAdapter.readBinary(path);
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
      const remote = await this.fetchRemoteInfo(client, path);
      if (!remote) return this.compareWithoutRemote(local, 'remote-missing');

      // Size guard: never fetch an oversized remote body just to diff it (OOM on Android). Return the metadata
      // comparison without a diff, like a binary file (docs/spec.md §9.4).
      if (this.deps.transfer.isRemoteOverSizeLimit(remote)) {
        const sizeMB = remote.size / 1024 / 1024;
        this.notify(
          `⚠️ File too large to preview: ${path} (${sizeMB.toFixed(1)} MB > ${this.deps.maxFileSizeMB()} MB)`,
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

      const remoteBytes = await client.downloadFile(path);
      // Hash the actual bytes, not the server-reported checksum, so checksumMatch always agrees with the diff.
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


  private compareWithoutRemote(
    local: CompareLocalSide, state: 'remote-missing' | 'error', errorMessage?: string,
  ): RemoteCompareResult {
    return {
      ...local, state, errorMessage,
      remoteExists: false, remoteMtime: null, remoteChecksum: null, checksumMatch: false,
      remoteText: null, diffAvailable: false, remoteSize: null,
    };
  }

  // Rejects on failure and records nothing in that case; StateDB is converged so the next sync sees no change.
  async pushLocalToRemote(conn: Connection, path: string): Promise<void> {
    const stat = await this.deps.localAdapter.stat(path);
    if (!stat) throw new Error(`Local file not found: ${path}`);
    const localData = await this.deps.localAdapter.readBinary(path);
    const localHash = await sha256(localData);
    const remote = await this.fetchRemoteInfo(conn.client, path); // null when creating the remote from local

    const lockToken = await this.deps.transfer.acquireLock(conn.client, path);
    try {
      const outcome = await conn.uploadStrategy.upload(conn.client, path, localData, stat.mtime);
      if (outcome === 'skipped') throw new Error(`Upload skipped (over the size limit): ${path}`);
    } finally {
      await this.deps.transfer.releaseLock(conn.client, path, lockToken);
    }

    this.deps.journal.recordHistory(path, 'uploaded', undefined, {
      localHash, remoteId: localHash, remoteIdType: 'sha256',
      localSize: stat.size, remoteSize: remote?.size,
    });
    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: stat.size, mtime: stat.mtime,
      remoteFileId: remote?.fileId ?? null, isConflicted: false,
    }, remote?.lastModified));
    await this.deps.stateDB.save();
    await this.deps.historyStore?.save();
  }

  // atomicWriteBinary registers an ignore so the modify watcher does not echo the write back as an upload.
  // Rejects on failure, leaving local unchanged when the download fails before any write.
  async pullRemoteToLocal(client: IWebDAVClient, path: string): Promise<void> {
    const remote = await this.fetchRemoteInfo(client, path);
    if (!remote) throw new Error(`Remote file not found: ${path}`);

    // Refuse an oversized remote (OOM risk), leaving local file and StateDB untouched (docs/spec.md §9.4).
    if (this.deps.transfer.isRemoteOverSizeLimit(remote)) {
      const sizeMB = remote.size / 1024 / 1024;
      throw new Error(`File too large to download (${sizeMB.toFixed(1)} MB > ${this.deps.maxFileSizeMB()} MB): ${path}`);
    }

    const remoteData = await client.downloadFile(path);
    await this.deps.localAdapter.atomicWriteBinary(path, remoteData);
    if (remote.lastModified) await this.deps.localAdapter.setMtime(path, remote.lastModified);

    const localHash = await sha256(remoteData);
    const remoteId = remote.checksum ?? localHash;
    const mtime = remote.lastModified || (await this.deps.localAdapter.stat(path))?.mtime || Date.now();
    this.deps.journal.recordHistory(path, 'downloaded', undefined, {
      localHash, remoteId, remoteIdType: 'sha256',
      localSize: remoteData.byteLength, remoteSize: remote.size,
    });
    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path, localHash, remoteId, idType: 'sha256',
      size: remote.size, mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    }, remote.lastModified));
    await this.deps.stateDB.save();
    await this.deps.historyStore?.save();
  }

  // Captured before a marker write overwrites them; only called on the marker-write path (clean:false).
  // The metrics are the clean sides' own mtime/size, used by the Latest/Biggest force-resolution choices.
  captureCleanSides(
    path: string, local: string, remote: string,
    localMtime: number, localSize: number, remoteInfo: RemoteFileInfo,
  ): void {
    if (!this.deps.cleanSideStore) return;
    this.deps.cleanSideStore.set(path, {
      local, remote,
      localMtime, remoteMtime: remoteInfo.lastModified || 0,
      localSize, remoteSize: remoteInfo.size,
    });
    this.deps.cleanSideStore.requestSave();
  }

  dropCleanSnapshot(path: string): void {
    if (!this.deps.cleanSideStore) return;
    if (this.deps.cleanSideStore.get(path) === undefined) return;
    this.deps.cleanSideStore.delete(path);
    this.deps.cleanSideStore.requestSave();
  }

  // Safety net after a sync: drops captures of paths no longer marker-conflicted, so captures stay bounded
  // to conflicted files whichever convergence path ran.
  sweepResolvedSnapshots(): void {
    const store = this.deps.cleanSideStore;
    if (!store) return;
    for (const path of store.paths()) {
      if (!this.deps.stateDB.getFile(path)?.isConflicted) this.dropCleanSnapshot(path);
    }
  }

  // Null when no snapshot exists; force-resolution then falls back to current-content push/pull.
  cleanSideMetrics(path: string): CleanSideMetrics | null {
    const snap = this.deps.cleanSideStore?.get(path);
    if (!snap) return null;
    return { localMtime: snap.localMtime, remoteMtime: snap.remoteMtime, localSize: snap.localSize, remoteSize: snap.remoteSize };
  }

  async applyCleanRemote(conn: Connection, path: string): Promise<void> {
    const snap = this.deps.cleanSideStore?.get(path);
    if (!snap) { await this.pullRemoteToLocal(conn.client, path); return; }
    await this.applyCleanSide(conn, path, snap.remote, 'remote');
  }

  async applyCleanLocal(conn: Connection, path: string): Promise<void> {
    const snap = this.deps.cleanSideStore?.get(path);
    if (!snap) { await this.pushLocalToRemote(conn, path); return; }
    await this.applyCleanSide(conn, path, snap.local, 'local');
  }

  // Writes the clean side to BOTH local and remote. Upload goes first: if it fails nothing local changes and
  // the file stays conflicted, never falsely "resolved".
  private async applyCleanSide(
    conn: Connection, path: string, content: string, side: 'local' | 'remote',
  ): Promise<void> {
    const data = new TextEncoder().encode(content).buffer;
    const mtime = Date.now();
    const remote = await this.fetchRemoteInfo(conn.client, path);

    const lockToken = await this.deps.transfer.acquireLock(conn.client, path);
    try {
      const outcome = await conn.uploadStrategy.upload(conn.client, path, data, mtime);
      if (outcome === 'skipped') throw new Error(`Upload skipped (over the size limit): ${path}`);
    } finally {
      await this.deps.transfer.releaseLock(conn.client, path, lockToken);
    }

    await this.deps.localAdapter.atomicWriteBinary(path, data);
    await this.deps.localAdapter.setMtime(path, mtime);

    const localHash = await sha256(data);
    this.deps.journal.recordHistory(path, 'uploaded', undefined, {
      localHash, remoteId: localHash, remoteIdType: 'sha256',
      localSize: data.byteLength, remoteSize: remote?.size,
    });
    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: data.byteLength, mtime,
      remoteFileId: remote?.fileId ?? null, isConflicted: false,
    }, remote?.lastModified));
    // Both sides now hold the clean content, so it is the new merge base and the snapshot is dropped.
    this.deps.mergeBase.record(path, content);
    this.dropCleanSnapshot(path);
    await this.deps.stateDB.save();
    await this.deps.historyStore?.save();
    void this.deps.logger?.log(`conflict: force-resolved from clean ${side} snapshot (both sides converged) → ${path}`);
  }

  async fetchRemoteInfo(client: IWebDAVClient, path: string): Promise<RemoteFileInfo | null> {
    const infos = await client.getFiles(path);
    if (infos.length === 0) return null;
    return infos.find(i => i.path === path) ?? infos[0];
  }

  private notify(message: string): void {
    if (this.deps.notify) this.deps.notify(message);
    else new Notice(message);
  }
}
