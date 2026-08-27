// Deletion propagation, lifted out of SyncEngine (feature 074, Phase 5).
//
// Two directions, both of which can destroy data if they get it wrong, which is why they are worth
// having in one readable place:
//
//   applyLocalDeletion    — the file is gone locally but present remotely. Delete it on the server
//                           ONLY when a real content hash proves the server copy never diverged.
//   processRemoteDeletion — the server says a file is gone. Apply that locally, through the user's
//                           own "Deleted files" setting, and never outside sync scope.
//
// The scope guard in processRemoteDeletion is a security boundary, not tidiness: a malicious or
// compromised server can fabricate a deletion for `.obsidian/...`, and this is the check standing
// between that and a raw filesystem remove.
import { Notice, TFile, TFolder, normalizePath, App } from 'obsidian';
import { FileState, RemoteFileInfo, SyncSessionSummary, NetworkError } from '../../types';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { TransferService } from '../transfer/TransferService';
import { FileLogger } from '../../util/FileLogger';
import { isSafeVaultRelativePath } from '../../network/remotePath';

export interface DeletionDeps {
  app: App;
  stateDB: Pick<StateDB, 'deleteFile'>;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  transfer: TransferService;
  /** The system-exclusion rules, already bound to the caller's settings. */
  isSystemExcluded(path: string): boolean;
  logger?: Pick<FileLogger, 'log'>;
}

export class DeletionService {
  constructor(private readonly deps: DeletionDeps) {}

  /**
   * The file is absent locally and present remotely. Propagate the deletion to the server — but only
   * on proof that the server copy is what we last synced.
   */
  async applyLocalDeletion(
    client: IWebDAVClient,
    remote: RemoteFileInfo, base: FileState, remoteId: string, idType: FileState['idType'],
    summary: SyncSessionSummary,
  ): Promise<void> {
    // Decide ONLY from a real content hash of the server copy. A SHA-256 match against what we last
    // synced is the only proof that the server copy is unchanged and the deletion is genuinely local.
    let serverHash = remote.checksum ?? null;
    if (!serverHash) {
      try { serverHash = await client.recalcChecksum(remote.path); } catch { serverHash = null; }
    }

    if (serverHash && serverHash === base.localHash) {
      // Server copy is byte-identical to our base → genuine local deletion → propagate (trashbin).
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
      this.deps.mergeBase.drop(remote.path); // feature 038: local deletion propagated → drop merge base
    } else if (serverHash && serverHash !== base.localHash) {
      // Server copy diverged after our base → restore it locally so a remote edit is never dropped.
      void this.deps.logger?.log(`conflict(local-delete vs remote-edit): restoring remote → ${remote.path}`);
      await this.deps.transfer.downloadFile(client, remote, remoteId, idType, summary);
    } else {
      // No reliable server checksum (e.g. plain WebDAV, or recalc failed) → do NOT delete. The
      // etag/size are not proof of unchanged content, so deleting here could discard a remote edit.
      // Leave both sides as-is; the deletion still propagates via the incremental token path.
      void this.deps.logger?.log(`delete-remote: SKIPPED — no reliable server checksum to confirm unchanged → ${remote.path}`);
    }
  }

  /** The server reports `path` gone. Apply that locally, honouring the user's deletion setting. */
  async processRemoteDeletion(path: string, summary: SyncSessionSummary): Promise<void> {
    // Security boundary (centralized at the delete sink): never act on a server-reported deletion
    // for a path the engine treats as out of scope (the Obsidian config folder, other plugins, etc.).
    // A malicious/compromised server could fabricate a REPORT deletion for `.obsidian/...`; without
    // this guard it would reach the raw fs remove below and permanently destroy config the sync
    // engine otherwise never touches. Every other server-driven sink already filters with
    // isSystemExcluded; enforcing it here covers all callers (incremental + full-scan).
    if (this.deps.isSystemExcluded(path)) {
      void this.deps.logger?.log(`delete-local: ignored out-of-scope remote deletion → ${path}`);
      return;
    }
    void this.deps.logger?.log(`delete-local: applying remote deletion → ${path}`);
    const file = this.deps.app.vault.getAbstractFileByPath(path);
    const normalized = normalizePath(path);
    try {
      if (file instanceof TFile || file instanceof TFolder) {
        // Honor the user's Obsidian "Deleted files" setting (system trash / .trash / permanent
        // delete) instead of forcing one behavior. trashFile handles both files and folders.
        await this.deps.app.fileManager.trashFile(file);
        summary.downloadedCount++;
        this.deps.journal.recordHistory(path, 'deleted'); // remote deletion applied locally
      } else if (isSafeVaultRelativePath(path) && await this.deps.app.vault.adapter.exists(normalized)) {
        // Not a vault-tracked abstract file (e.g. dotfiles under a config folder): delete it
        // directly so the deletion is never silently skipped. Defense-in-depth: only when the
        // path is safe (no traversal / not absolute), so an attacker-controlled remote path can
        // never reach this raw fs sink even if the boundary guard is ever bypassed.
        await this.deps.app.vault.adapter.remove(normalized);
        summary.downloadedCount++;
        this.deps.journal.recordHistory(path, 'deleted'); // remote deletion applied locally (config dotfile)
      }
      // else: already gone locally — nothing to delete, fall through to state cleanup.
    } catch (err) {
      // Don't abort the whole sync session for one failed deletion; notify and keep the
      // StateDB entry so the next sync retries this path.
      new Notice(`❌ Failed to delete ${path}: ${(err as Error).message}`, 6000);
      return;
    }
    this.deps.stateDB.deleteFile(path);
    this.deps.mergeBase.drop(path); // feature 038: remote deletion applied locally → drop merge base
  }
}
