// Manual and forced resolution, lifted out of SyncEngine (feature 074, Phase 5).
//
// Everything the USER can do to settle one file, as opposed to what the sync loop does on its own:
// look at both sides (Compare with remote), force one side to win (push / pull), or recover the
// pre-conflict content that a marker write buried (the clean-side snapshots of feature 044).
//
// Compare and the clean-side snapshots are one module rather than two because they are one feature:
// applyCleanLocal/applyCleanRemote fall back to push/pull when no snapshot exists, so splitting them
// would only produce two modules that call each other.
//
// Nothing here is part of a sync session — no summary is threaded through, and every method is
// reachable from a menu. Failures reject (or land in the compare result's `state`) so the caller can
// surface them, rather than being counted into a session that is not running.
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

/** The local-side fields of a compare result, shared by every `compareWithRemote` outcome. */
type CompareLocalSide = Pick<
  RemoteCompareResult,
  'path' | 'localExists' | 'localMtime' | 'localChecksum' | 'localText' | 'localSize'
>;

/** The connected server, resolved by the caller because it is created lazily and can be replaced. */
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
  /** Used for its lock handling and its size guard — the same ones the sync path uses. */
  transfer: TransferService;
  autoMergeFileTypes(): readonly string[];
  maxFileSizeMB(): number;
  logger?: Pick<FileLogger, 'log'>;
  /** User-facing notice; injected so the size guard can be exercised without an Obsidian runtime. */
  notify?(message: string): void;
}

export class ResolutionService {
  constructor(private readonly deps: ResolutionDeps) {}

  getUnresolvedConflictCount(): Promise<number> {
    return Promise.resolve(this.deps.stateDB.countConflicted());
  }

  // ── Compare with remote ────────────────────────────────────────────────────

  /**
   * Read-only comparison of one file against its remote counterpart, for the explorer
   * "Compare with remote" popup. Fetches remote metadata + content (never mutates) and computes
   * modification times, byte-level SHA-256 checksums (so the match indicator is valid for binary
   * files too), and decoded text for the diff (text-eligible files only). Failures are captured in
   * the returned `state` (`remote-missing` / `error`) rather than thrown.
   */
  async compareWithRemote(client: IWebDAVClient, path: string): Promise<RemoteCompareResult> {
    const textEligible = isTextEligible(path, this.deps.autoMergeFileTypes());

    // Local side
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

      // Size guard (spec 035, FR-011): never fetch an oversized remote body just to diff it (the
      // fetch itself can OOM on Android). Show the metadata comparison (sizes/mtimes) but no line
      // diff — the same shape as a binary/non-text file (remoteText null, diffAvailable false).
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

  // ── Force resolution: push / pull ──────────────────────────────────────────

  /**
   * Manual resolution (push): overwrite the REMOTE file with the local content. Reuses the upload
   * strategy + lock handling, records an 'uploaded' history entry, and converges StateDB so the
   * next sync sees no spurious change. Rejects on failure so the caller can surface it (and records
   * nothing in that case).
   */
  async pushLocalToRemote(conn: Connection, path: string): Promise<void> {
    const stat = await this.deps.localAdapter.stat(path);
    if (!stat) throw new Error(`Local file not found: ${path}`);
    const localData = await this.deps.localAdapter.readBinary(path);
    const localHash = await sha256(localData);
    const remote = await this.fetchRemoteInfo(conn.client, path); // null ⇒ creating the remote from local

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

  /**
   * Manual resolution (pull): overwrite the LOCAL file with the remote content. The write is marked
   * as the plugin's own (atomicWriteBinary registers an ignore) so the modify watcher does not echo
   * it back as an upload. Records a 'downloaded' history entry and converges StateDB. Rejects on
   * failure (local left unchanged when the download fails before any write).
   */
  async pullRemoteToLocal(client: IWebDAVClient, path: string): Promise<void> {
    const remote = await this.fetchRemoteInfo(client, path);
    if (!remote) throw new Error(`Remote file not found: ${path}`);

    // Size guard (spec 035, FR-011): refuse a manual pull of an oversized remote (the download would
    // risk OOM). Surface a clear error to the caller (symmetric with pushLocalToRemote throwing on an
    // oversized upload). Local file and StateDB are left untouched.
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

  // ── Clean-side snapshots (feature 044) ─────────────────────────────────────

  /**
   * Feature 044: capture the two CLEAN sides of a note at conflict-detection time, before a marker
   * write overwrites them. Only called on the marker-write path (clean:false). Metrics are the clean
   * sides' own mtime/size, used later by the Latest/Biggest force-resolution choices.
   */
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

  /** Drop the captured clean sides for `path` (on resolution / convergence / deletion) — no leak (044). */
  dropCleanSnapshot(path: string): void {
    if (!this.deps.cleanSideStore) return;
    if (this.deps.cleanSideStore.get(path) === undefined) return;
    this.deps.cleanSideStore.delete(path);
    this.deps.cleanSideStore.requestSave();
  }

  /**
   * Feature 044 self-heal safety net: after a sync, drop the captured clean sides of any path that is
   * no longer marker-conflicted in StateDB (converged via a prefer-side / clean-merge / hand-resolve /
   * download). This keeps captures bounded to currently-conflicted files (FR-008/SC-003) regardless of
   * which convergence path ran, without threading a drop into every call site.
   */
  sweepResolvedSnapshots(): void {
    const store = this.deps.cleanSideStore;
    if (!store) return;
    for (const path of store.paths()) {
      if (!this.deps.stateDB.getFile(path)?.isConflicted) this.dropCleanSnapshot(path);
    }
  }

  /**
   * Feature 044 recovery: the captured clean-side metrics for a marker-conflicted `path`, or null when
   * no snapshot exists. Force-resolution uses this to decide whether to recover from the snapshot
   * (present) or fall back to current-content push/pull (absent). Implements CompareEngine (044).
   */
  cleanSideMetrics(path: string): CleanSideMetrics | null {
    const snap = this.deps.cleanSideStore?.get(path);
    if (!snap) return null;
    return { localMtime: snap.localMtime, remoteMtime: snap.remoteMtime, localSize: snap.localSize, remoteSize: snap.remoteSize };
  }

  /** Feature 044 recovery: restore the captured clean REMOTE side (or fall back to pull if none). */
  async applyCleanRemote(conn: Connection, path: string): Promise<void> {
    const snap = this.deps.cleanSideStore?.get(path);
    if (!snap) { await this.pullRemoteToLocal(conn.client, path); return; }
    await this.applyCleanSide(conn, path, snap.remote, 'remote');
  }

  /** Feature 044 recovery: restore the captured clean LOCAL side (or fall back to push if none). */
  async applyCleanLocal(conn: Connection, path: string): Promise<void> {
    const snap = this.deps.cleanSideStore?.get(path);
    if (!snap) { await this.pushLocalToRemote(conn, path); return; }
    await this.applyCleanSide(conn, path, snap.local, 'local');
  }

  /**
   * Write `content` (a captured clean side) to BOTH local and remote so the conflict converges on a
   * real, marker-free version. Uploads first (if that fails, nothing local changes and the file stays
   * conflicted — no false "resolved"), then writes local, converges StateDB (isConflicted:false),
   * records the new merge base, and drops the snapshot. (CSS-2/CSS-4/CSS-6)
   */
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
    // Both sides now hold the clean content → it is the new merge base; the snapshot has served its
    // purpose and is dropped (no leak).
    this.deps.mergeBase.record(path, content);
    this.dropCleanSnapshot(path);
    await this.deps.stateDB.save();
    await this.deps.historyStore?.save();
    void this.deps.logger?.log(`conflict: force-resolved from clean ${side} snapshot (both sides converged) → ${path}`);
  }

  /** Fetch a single remote file's metadata via PROPFIND; null when the remote file is absent. */
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
