// Deletion propagation in both directions. applyLocalDeletion deletes on the server ONLY when a real content
// hash proves the server copy never diverged. processRemoteDeletion applies a server deletion locally through
// the user's "Deleted files" setting and never outside sync scope (docs/spec.md §8).
import { Notice, TFile, TFolder, normalizePath, App } from 'obsidian';
import { FileState, RemoteFileInfo, SyncSessionSummary, NetworkError } from '../../types';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { TransferService } from '../transfer/TransferService';
import { FileLogger } from '../../util/FileLogger';
import { isSafeVaultRelativePath } from '../../network/remotePath';
import { collectSubtreePaths, dropSubtreeTracking } from './subtreeTracking';

// What a local deletion did; a caller that must report failures (the mirror) reads it, an ordinary sync ignores it.
export type RemoteDeletionOutcome =
  | { status: 'deleted' }
  | { status: 'absent' }
  | { status: 'ignored' }
  | { status: 'failed'; message: string };

export interface DeletionDeps {
  app: App;
  stateDB: Pick<StateDB, 'deleteFile' | 'getFile' | 'getAllFiles' | 'getAllDirs' | 'deleteDir'>;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  transfer: TransferService;
  isSystemExcluded(path: string): boolean;
  dropCleanSnapshot(path: string): void;
  // Registers a path so the vault event this plugin causes is not fed back to the watcher. Required: an
  // unwired no-op here turns a plugin trash back into a server DELETE.
  markOwnEvent(path: string): void;
  logger?: Pick<FileLogger, 'log'>;
}

export class DeletionService {
  constructor(private readonly deps: DeletionDeps) {}


  async applyLocalDeletion(
    client: IWebDAVClient,
    remote: RemoteFileInfo, base: FileState, remoteId: string, idType: FileState['idType'],
    summary: SyncSessionSummary,
  ): Promise<'deleted' | 'restored' | 'kept'> {
    // Decide only from a real content hash: a SHA-256 match with the last synced base is the only proof the
    // server copy is unchanged.
    let serverHash = remote.checksum ?? null;
    if (!serverHash) {
      try { serverHash = await client.recalcChecksum(remote.path); } catch { serverHash = null; }
    }

    if (serverHash && serverHash === base.localHash) {
      void this.deps.logger?.log(`delete-remote: local deletion (server checksum matches base) → ${remote.path}`);
      try {
        await client.deleteFile(remote.path, base.remoteId);
        summary.deletedCount++;
        this.deps.journal.recordHistory(remote.path, 'deleted', undefined, {
          localHash: base.localHash, remoteId, remoteIdType: idType,
          localSize: base.size, remoteSize: remote.size,
        });
      } catch (err) {
        if (!(err instanceof NetworkError && err.status === 404)) throw err;
      }
      this.deps.stateDB.deleteFile(remote.path);
      this.deps.mergeBase.drop(remote.path);
      return 'deleted';
    }
    if (serverHash && serverHash !== base.localHash) {
      // The server copy diverged after our base; restore it so a remote edit is never dropped.
      void this.deps.logger?.log(`conflict(local-delete vs remote-edit): restoring remote → ${remote.path}`);
      await this.deps.transfer.downloadFile(client, remote, remoteId, idType, summary);
      return 'restored';
    }
    // Without a reliable checksum (plain WebDAV, or recalc failed) do NOT delete: etag/size do not prove
    // unchanged content. The deletion still propagates via the incremental token path.
    void this.deps.logger?.log(`delete-remote: SKIPPED — no reliable server checksum to confirm unchanged → ${remote.path}`);
    return 'kept';
  }

  // For a file absent locally and from the remote listing (not a rename). The listing can be incomplete
  // (issue #46), so a Depth 0 PROPFIND decides: gone (forget it), present (hand to the proof path),
  // unanswerable (keep and retry next sync).
  async deleteLocallyMissing(
    client: IWebDAVClient, path: string, base: FileState, summary: SyncSessionSummary,
  ): Promise<'deleted' | 'untracked' | 'restored' | 'kept'> {
    // A throw reaches the caller, which keeps the tracking entry: an unanswerable probe must never be read as
    // "gone", or an outage would quietly discard the file's history.
    const remote = await client.statFile(path);
    if (!remote) {
      void this.deps.logger?.log(`delete-remote: not on the server (Depth:0 404) — dropping tracking, no DELETE → ${path}`);
      this.deps.journal.recordHistory(path, 'deleted');
      this.dropTracking(path);
      return 'untracked';
    }

    void this.deps.logger?.log(`delete-remote: absent from the listing but present on the server — proving before delete → ${path}`);
    const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
    const idType: FileState['idType'] = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');
    const outcome = await this.applyLocalDeletion(client, remote, base, remoteId, idType, summary);
    // applyLocalDeletion never drops the clean sides; drop them here so no snapshot outlives the path.
    if (outcome === 'deleted') this.deps.dropCleanSnapshot(path);
    return outcome;
  }

  private dropTracking(path: string): void {
    this.deps.stateDB.deleteFile(path);
    this.deps.mergeBase.drop(path);
    this.deps.dropCleanSnapshot(path);
  }

  async processRemoteDeletion(path: string, summary: SyncSessionSummary): Promise<RemoteDeletionOutcome> {
    // Security boundary at the delete sink: a compromised server could fabricate a deletion for
    // `.obsidian/...`, which would otherwise reach the raw fs remove below. Enforced here for all callers.
    if (this.deps.isSystemExcluded(path)) {
      void this.deps.logger?.log(`delete-local: ignored out-of-scope remote deletion → ${path}`);
      return { status: 'ignored' };
    }
    void this.deps.logger?.log(`delete-local: applying remote deletion → ${path}`);
    const file = this.deps.app.vault.getAbstractFileByPath(path);
    const normalized = normalizePath(path);
    let removed = false;
    try {
      if (file instanceof TFile || file instanceof TFolder) {
        // trashFile honours the user's "Deleted files" setting. A folder is trashed with its contents and
        // Obsidian fires a `delete` event for each; register the subtree as our own so watch mode does not
        // push them to the server as user deletions.
        if (file instanceof TFolder) {
          const stale = collectSubtreePaths(this.deps.stateDB, path);
          // The set keeps `path` from registering twice when it is already in stale.dirs.
          for (const p of new Set([path, ...stale.files, ...stale.dirs])) this.deps.markOwnEvent(p);
        }
        await this.deps.app.fileManager.trashFile(file);
        removed = true;
        summary.downloadedCount++;
        this.deps.journal.recordHistory(path, 'deleted');
      } else if (isSafeVaultRelativePath(path) && await this.deps.app.vault.adapter.exists(normalized)) {
        // Not a vault-tracked file (e.g. dotfiles under a config folder): delete directly. Defence in depth:
        // only for a safe path (no traversal, not absolute) so a remote-controlled path never reaches this sink.
        await this.deps.app.vault.adapter.remove(normalized);
        removed = true;
        summary.downloadedCount++;
        this.deps.journal.recordHistory(path, 'deleted');
      }
      // Already gone locally: fall through to state cleanup.
    } catch (err) {
      // One failed deletion must not abort the session; keep the StateDB entry so the next sync retries.
      new Notice(`❌ Failed to delete ${path}: ${(err as Error).message}`, 6000);
      return { status: 'failed', message: (err as Error).message };
    }
    this.deps.stateDB.deleteFile(path);
    this.deps.mergeBase.drop(path);
    this.deps.dropCleanSnapshot(path);
    // When `path` was a folder, trashFile took its contents too; leftover child rows would be read next sync
    // as local deletions and pushed back to the server. A file path matches nothing here.
    const dropped = dropSubtreeTracking(this.deps, path);
    if (dropped.files + dropped.dirs > 0) {
      void this.deps.logger?.log(`delete-local: plugin trash — dropped tracking for ${dropped.files} files / ${dropped.dirs} dirs under ${path} (not a local deletion)`);
    }
    return { status: removed ? 'deleted' : 'absent' };
  }
}
