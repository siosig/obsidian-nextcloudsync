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
import { collectSubtreePaths, dropSubtreeTracking } from './subtreeTracking';

export interface DeletionDeps {
  app: App;
  stateDB: Pick<StateDB, 'deleteFile' | 'getFile' | 'getAllFiles' | 'getAllDirs' | 'deleteDir'>;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  transfer: TransferService;
  /** The system-exclusion rules, already bound to the caller's settings. */
  isSystemExcluded(path: string): boolean;
  /** Drop the feature 044 clean-side snapshot for a path that is no longer tracked. */
  dropCleanSnapshot(path: string): void;
  /**
   * Register a path so the vault event this plugin is about to cause is not fed back to the watcher
   * (the existing LocalAdapter ignore list behind `isOwnSyncEvent`). Required, not optional: a
   * silently-unwired no-op here turns a plugin trash back into a server DELETE.
   */
  markOwnEvent(path: string): void;
  logger?: Pick<FileLogger, 'log'>;
}

export class DeletionService {
  constructor(private readonly deps: DeletionDeps) {}

  /**
   * The file is absent locally and present remotely. Propagate the deletion to the server — but only
   * on proof that the server copy is what we last synced.
   *
   * Returns which of the three arms was taken, so a caller that has to report an outcome does not
   * have to reverse-engineer it from side effects.
   */
  async applyLocalDeletion(
    client: IWebDAVClient,
    remote: RemoteFileInfo, base: FileState, remoteId: string, idType: FileState['idType'],
    summary: SyncSessionSummary,
  ): Promise<'deleted' | 'restored' | 'kept'> {
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
      return 'deleted';
    }
    if (serverHash && serverHash !== base.localHash) {
      // Server copy diverged after our base → restore it locally so a remote edit is never dropped.
      void this.deps.logger?.log(`conflict(local-delete vs remote-edit): restoring remote → ${remote.path}`);
      await this.deps.transfer.downloadFile(client, remote, remoteId, idType, summary);
      return 'restored';
    }
    // No reliable server checksum (e.g. plain WebDAV, or recalc failed) → do NOT delete. The
    // etag/size are not proof of unchanged content, so deleting here could discard a remote edit.
    // Leave both sides as-is; the deletion still propagates via the incremental token path.
    void this.deps.logger?.log(`delete-remote: SKIPPED — no reliable server checksum to confirm unchanged → ${remote.path}`);
    return 'kept';
  }

  /**
   * The file is absent locally AND absent from the remote listing, and it is not a rename. Settle it
   * (feature 086, issue #46).
   *
   * This used to be a bare DELETE: absence from the listing was taken as proof the server had nothing
   * left to lose, and a 404 back was counted as success. That reasoning only holds while the listing
   * is complete, and this issue is the evidence that it is not — the same glitch that dropped a folder
   * from the directory listing can drop a file from the file listing, and then the DELETE lands on a
   * copy the server really had. Every other deletion path already demands proof; this one now does too.
   *
   * One Depth 0 PROPFIND answers both questions at once — is it there, and is it still what we last
   * synced — so a complete listing costs the same round trip it always did, just a PROPFIND instead of
   * a DELETE. The three answers map straight onto the three outcomes: gone (forget it), present
   * (hand it to the proof path), unanswerable (keep it and retry next sync).
   */
  async deleteLocallyMissing(
    client: IWebDAVClient, path: string, base: FileState, summary: SyncSessionSummary,
  ): Promise<'deleted' | 'untracked' | 'restored' | 'kept'> {
    // A throw here reaches the caller, which keeps the tracking entry (G1-2): an unanswerable probe
    // must never be read as "gone", or an outage would quietly discard the file's history.
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
    // applyLocalDeletion owns the state row and the merge base; the clean sides are the one thing it
    // has never dropped, so finish the job here rather than leaving a snapshot behind for a path that
    // no longer exists on either side.
    if (outcome === 'deleted') this.deps.dropCleanSnapshot(path);
    return outcome;
  }

  /** Forget a path completely: state row, merge base, and any captured clean sides. */
  private dropTracking(path: string): void {
    this.deps.stateDB.deleteFile(path);
    this.deps.mergeBase.drop(path);
    this.deps.dropCleanSnapshot(path);
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
        //
        // Feature 086: a folder is trashed WITH ITS CONTENTS, and Obsidian fires a vault `delete`
        // event for each one. Watch mode would read those as user deletions and push them to the
        // server, so the subtree is registered as the plugin's own doing before the trash runs.
        if (file instanceof TFolder) {
          const stale = collectSubtreePaths(this.deps.stateDB, path);
          // `path` is already in stale.dirs when tracked; the set keeps it from registering twice.
          for (const p of new Set([path, ...stale.files, ...stale.dirs])) this.deps.markOwnEvent(p);
        }
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
    // Reached only on success — the catch above returns, keeping every row so the next sync retries.
    this.deps.stateDB.deleteFile(path);
    this.deps.mergeBase.drop(path); // feature 038: remote deletion applied locally → drop merge base
    this.deps.dropCleanSnapshot(path); // feature 044: the file is gone → its clean sides are stale
    // Feature 086: when `path` was a folder, trashFile took its CONTENTS with it. Leaving the child
    // rows tracked made the next sync read them as local deletions and push them to the server —
    // turning a deletion that came FROM the server into a second, unproven one going back to it.
    // A file path matches nothing here, so this is a no-op for the common case.
    const dropped = dropSubtreeTracking(this.deps, path);
    if (dropped.files + dropped.dirs > 0) {
      void this.deps.logger?.log(`delete-local: plugin trash — dropped tracking for ${dropped.files} files / ${dropped.dirs} dirs under ${path} (not a local deletion)`);
    }
  }
}
