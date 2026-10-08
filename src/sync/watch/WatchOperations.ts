// Watch-mode single-file and single-folder operations: one file saved, deleted, renamed; one folder created,
// deleted, renamed. Each touches one path and avoids the full-vault scan and remote listing (docs/spec.md §5.7).
//
// Unlike the other extracted modules this one CALLS INTO the sync loop: deciding what to do with a changed
// file is the full sync's classifier, reached through the `processFile` port rather than an engine import.
//
// Rules that run through all of it:
//   Never run alongside a full sync. A multi-step resolve must not interleave with the full sync writing the
//   same file. Edits are DEFERRED (re-evaluated when the run ends); deletions are DROPPED, since the running
//   scan already propagates a tracked path that vanished locally and queuing one risks a second delete.
//   Stay silent unless the user has to know: only a failure or a genuine divergence raises a notice.
//   Respect "Wi-Fi only": on cellular each operation does nothing, and the next full sync's scan picks the
//   change up (docs/spec.md §5.7c).
import { Notice } from 'obsidian';
import { FileState, RemoteFileInfo, SyncSessionSummary, NetworkError } from '../../types';
import { LocalAdapter } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { SyncHistoryStore } from '../../data/SyncHistoryStore';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy } from '../upload/IUploadStrategy';
import { IStatusBar } from '../../ui/StatusBarItem';
import { RenameTracker } from '../RenameTracker';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { TransferService } from '../transfer/TransferService';
import { DeletionService } from '../deletion/DeletionService';
import { ResolutionService } from '../resolution/ResolutionService';
import { isLocallyUnchanged } from '../policy';
import { FileLogger } from '../../util/FileLogger';
import { sha256 } from '../../util/hash';
import { AsyncMutex } from '../../util/AsyncMutex';

// Operation names used in the "skipped on cellular" log line.
type WatchOpName = 'sync' | 'delete' | 'rename' | 'folder-create' | 'folder-delete' | 'folder-rename';

export interface Connection {
  client: IWebDAVClient;
  uploadStrategy: IUploadStrategy;
}

export interface WatchDeps {
  localAdapter: Pick<LocalAdapter, 'stat' | 'readBinary'>;
  stateDB: Pick<StateDB, 'getFile' | 'deleteFile' | 'getDir' | 'setDir' | 'deleteDir' | 'requestSave' | 'getLastSyncTime'>;
  historyStore?: Pick<SyncHistoryStore, 'save'>;
  statusBar: IStatusBar;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  transfer: TransferService;
  deletion: DeletionService;
  resolution: Pick<ResolutionService, 'dropCleanSnapshot'>;
  isSystemExcluded(path: string): boolean;
  connect(): Promise<Connection>;
  // Created lazily by the engine because it needs the connected client.
  renameTracker(): RenameTracker;

  // The SAME "Wi-Fi only" decision the full sync makes at its entry. True skips the operation entirely: no
  // network, no local write, no StateDB change.
  isBlockedByWifiOnly(): boolean;
  isSyncRunning(): boolean;
  // The full sync's per-file classifier, so watch mode and "Sync now" run the same decision code and reach
  // identical results.
  processFile(remote: RemoteFileInfo, summary: SyncSessionSummary): Promise<void>;
  // Outbound port: this path needs another attempt on the next sync.
  queueRetry(path: string): void;
  // How many conflicts the engine has encountered so far (see notifyWatchOutcome).
  conflictEncounters(): number;
  logger?: Pick<FileLogger, 'log'>;
  // Injected so the outcome rules can be exercised without an Obsidian runtime.
  notify?(message: string, timeout?: number): void;
}

export class WatchOperations {
  // Watch-mode ops currently propagating to the remote; drives the status bar.
  private inFlight = 0;

  // One mutex per path so two watch cycles for the SAME file never interleave: a cycle that PROPFINDs after its
  // predecessor's upload but before its baseline write sees a phantom remote change and would resolve a conflict
  // over the file being edited (issue #42, docs/spec.md §5.7b). Keyed by path, not global, because syncing is
  // mostly network wait and one lock would serialize every file. Entries are not evicted: the map is bounded by
  // paths touched per session, and a wrong eviction predicate would silently drop exclusion.
  private readonly pathLocks = new Map<string, AsyncMutex>();

  // Paths whose single-file sync arrived while a full sync was running, drained when the run finishes (deferred,
  // not dropped, since the full sync may already have passed that file). In memory only: losing them on reload is
  // harmless because the next full sync detects the same change, and persisting would add a second source of truth.
  private readonly pendingPaths = new Set<string>();

  constructor(private readonly deps: WatchDeps) {}

  // Guarded by the running check so it never fights a concurrent full sync, which owns the status during its run.
  private begin(): void {
    this.inFlight++;
    if (!this.deps.isSyncRunning()) this.deps.statusBar.setStatus('syncing');
  }

  private end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0 && !this.deps.isSyncRunning()) this.deps.statusBar.setStatus('idle');
  }

  // Decided at execution time, before any lock, StateDB read or network call, so a skip leaves nothing behind:
  // the next full sync finds the change on its own scan. Silent apart from one log line.
  private skippedOnCellular(op: WatchOpName, target: string): boolean {
    if (!this.deps.isBlockedByWifiOnly()) return false;
    void this.deps.logger?.log(`watch: skipped ${op} ${target} — Wi-Fi only is on and the connection is cellular`);
    return true;
  }

  private withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.pathLocks.get(path);
    if (!lock) { lock = new AsyncMutex(); this.pathLocks.set(path, lock); }
    return lock.run(fn);
  }

  // Locks are taken in lexicographic order: renames crossing in opposite directions (a to b and b to a) would
  // otherwise each hold what the other waits for.
  private withTwoPathLocks<T>(a: string, b: string, fn: () => Promise<T>): Promise<T> {
    if (a === b) return this.withPathLock(a, fn);
    const [first, second] = a < b ? [a, b] : [b, a];
    return this.withPathLock(first, () => this.withPathLock(second, fn));
  }

  // Fetches the remote's current state, then hands it to the SAME classifier the full sync uses (processFile), so
  // a blind PUT can never overwrite another device's edit silently (issue #23). No decision lives here.
  async syncSingleFile(path: string): Promise<void> {
    if (this.deps.isSystemExcluded(path)) return;
    if (this.skippedOnCellular('sync', path)) return;
    // The early exits stay OUTSIDE the lock: neither touches shared state and a no-op must not queue behind real work.
    return this.withPathLock(path, () => this.syncSingleFileLocked(path));
  }

  private async syncSingleFileLocked(path: string): Promise<void> {
    // Never run alongside a full sync: defer the path and re-evaluate it when the run finishes. Deferring, not
    // dropping, keeps the edit from being missed if the full sync already passed this file.
    if (this.deps.isSyncRunning()) {
      this.pendingPaths.add(path);
      void this.deps.logger?.log(`watch: full sync in progress → deferred ${path}`);
      return;
    }
    const stat = await this.deps.localAdapter.stat(path);
    if (!stat) return; // already deleted before the debounce fired
    const base = this.deps.stateDB.getFile(path);
    // Decide "nothing changed" from LOCAL data only, before touching the network: the stat-signature fast path
    // answers most saves without reading the file, and a miss falls back to hashing.
    if (base && this.locallyUnchanged(base, stat)) return;
    const data = await this.deps.localAdapter.readBinary(path);
    const localHash = await sha256(data);
    if (base && localHash === base.localHash) return; // content unchanged (e.g. mtime-only touch)

    const conn = await this.deps.connect();
    // A real summary: its counters decide whether to notify the user, and processFile maintains them as in a full sync.
    const summary = this.deps.journal.newSummary();
    const conflictsBefore = this.deps.conflictEncounters();
    this.begin();
    try {
      const remote = await conn.client.statFile(path);
      if (remote) {
        void this.deps.logger?.log(`watch: remote state fetched → classifying ${path}`);
        await this.deps.processFile(remote, summary);
      } else {
        // Not on the server at all: a plain create. If-Match against a non-existent resource always fails,
        // so keep the synthetic null etag.
        void this.deps.logger?.log(`watch: not on remote → upload as new ${path}`);
        await this.deps.transfer.uploadFile(
          conn.client, conn.uploadStrategy,
          path, localHash, base?.remoteId ?? localHash, base?.idType ?? 'sha256',
          { path, fileId: base?.remoteFileId ?? null, checksum: null, etag: null, size: stat.size, lastModified: stat.mtime },
          summary,
        );
      }
      // Coalesced via a trailing debounce so rapid edits do not each rewrite the state file; onunload flushes it.
      this.deps.stateDB.requestSave();
      await this.deps.historyStore?.save();
    } catch (err) {
      // Never lose the edit: a network failure queues the path for the next sync; the local file is untouched.
      console.warn(`[SyncEngine] Single-file sync failed for ${path}:`, err);
      void this.deps.logger?.log(`watch: FAILED ${path} — ${(err as Error).message}`, 'error');
      this.deps.journal.recordError(summary, path, err);
      if (err instanceof NetworkError) this.deps.queueRetry(path);
    } finally {
      this.end();
    }
    this.notifyWatchOutcome(path, summary, conflictsBefore);
  }

  // Runs the SAME guard as the full sync (applyLocalDeletion): delete only while the server's recomputed checksum
  // still matches our base, else restore the remote copy. `deleteFile`'s expected-id argument is ignored by
  // every client (blind DELETE), so it cannot serve as the guard.
  async deleteSingleFile(path: string): Promise<void> {
    if (this.deps.isSystemExcluded(path)) return;
    if (this.skippedOnCellular('delete', path)) return;
    // Same lock as syncSingleFile: an upload and a delete crossing on one path would otherwise decide by timing.
    return this.withPathLock(path, () => this.deleteSingleFileLocked(path));
  }

  private async deleteSingleFileLocked(path: string): Promise<void> {
    const base = this.deps.stateDB.getFile(path);
    if (!base) return; // not tracked, nothing to do on the remote
    // During a full sync do nothing, and do NOT defer: the running scan propagates the deletion itself, so
    // queuing it here would only risk a second delete.
    if (this.deps.isSyncRunning()) {
      void this.deps.logger?.log(`watch: full sync in progress → deletion of ${path} left to the running scan`);
      return;
    }
    const conn = await this.deps.connect();
    const summary = this.deps.journal.newSummary();
    const conflictsBefore = this.deps.conflictEncounters();
    this.begin();
    try {
      // The same decision the full scan makes for a path missing from its listing (ask the server, forget on 404,
      // else demand a checksum match). It owns the StateDB cleanup, keeping the entry when the DELETE fails so
      // the delete is retried instead of coming back as a re-download.
      await this.deps.deletion.deleteLocallyMissing(conn.client, path, base, summary);
      this.deps.stateDB.requestSave();
      await this.deps.historyStore?.save();
    } catch (err) {
      console.warn(`[SyncEngine] Single-file delete failed for ${path}:`, err);
      void this.deps.logger?.log(`watch: delete FAILED ${path} — ${(err as Error).message}`, 'error');
      this.deps.journal.recordError(summary, path, err);
    } finally {
      this.end();
    }
    this.notifyWatchOutcome(path, summary, conflictsBefore);
  }

  async renameSingleFile(oldPath: string, newPath: string): Promise<void> {
    if (this.deps.isSystemExcluded(oldPath) && this.deps.isSystemExcluded(newPath)) return;
    if (this.skippedOnCellular('rename', `${oldPath} → ${newPath}`)) return;
    // Both ends are locked: a rename moves state between two paths, so one lock leaves the other open to a
    // concurrent cycle acting on a half-applied move.
    return this.withTwoPathLocks(oldPath, newPath, () => this.renameSingleFileLocked(oldPath, newPath));
  }

  private async renameSingleFileLocked(oldPath: string, newPath: string): Promise<void> {
    await this.deps.connect();
    const rt = this.deps.renameTracker();
    this.begin();
    try {
      await rt.applyLocalRename(oldPath, newPath);
      this.deps.stateDB.requestSave();
    } catch (err) {
      console.warn(`[SyncEngine] Single-file rename failed ${oldPath} → ${newPath}:`, err);
    } finally {
      this.end();
    }
  }

  // MKCOL is idempotent (405 swallowed), which also makes it safe against a stray download-created-folder event.
  async createSingleFolder(path: string): Promise<void> {
    if (this.deps.isSystemExcluded(path)) return;
    if (this.skippedOnCellular('folder-create', path)) return;
    const conn = await this.deps.connect();
    this.begin();
    try {
      await conn.client.createDirectory(path);
      this.deps.stateDB.setDir({ path, remoteFileId: null });
      this.deps.stateDB.requestSave();
      void this.deps.logger?.log(`watch: folder created → MKCOL ${path}`);
    } catch (err) {
      console.warn(`[SyncEngine] Single-folder create failed for ${path}:`, err);
    } finally {
      this.end();
    }
  }

  // Only a TRACKED folder is propagated; an untracked one was never on the server. The remote delete routes
  // through the Nextcloud trashbin (recoverable) and a 404 is the desired end state.
  async deleteSingleFolder(path: string): Promise<void> {
    if (this.deps.isSystemExcluded(path)) return;
    if (this.skippedOnCellular('folder-delete', path)) return;
    if (!this.deps.stateDB.getDir(path)) return;
    // Same rule as deleteSingleFile, and this is the loudest sink (a recursive collection DELETE): a running scan
    // trashes folders itself and those trashes fire delete events, which must not become unproven DELETEs.
    if (this.deps.isSyncRunning()) {
      void this.deps.logger?.log(`watch: full sync in progress → folder deletion of ${path} left to the running scan`);
      return;
    }
    const conn = await this.deps.connect();
    this.begin();
    let succeeded = false;
    try {
      await conn.client.deleteCollection(path); // 404 is handled inside as success
      void this.deps.logger?.log(`watch: folder deleted → remote collection removed ${path}`);
      succeeded = true;
    } catch (err) {
      console.warn(`[SyncEngine] Single-folder delete failed for ${path}:`, err);
    } finally {
      this.end();
    }
    // Drop the tracked directory only when the remote delete succeeded; otherwise the next sync re-creates it locally.
    if (!succeeded) return;
    this.deps.stateDB.deleteDir(path);
    this.deps.stateDB.requestSave();
  }

  // The server moves the whole subtree. Child-file rename events fired alongside are handled best-effort by
  // renameSingleFile; their 404s are harmless because the parent MOVE already relocated them.
  async renameSingleFolder(oldPath: string, newPath: string): Promise<void> {
    if (this.deps.isSystemExcluded(oldPath) && this.deps.isSystemExcluded(newPath)) return;
    if (this.skippedOnCellular('folder-rename', `${oldPath} → ${newPath}`)) return;
    const conn = await this.deps.connect();
    this.begin();
    try {
      await conn.client.moveFile(oldPath, newPath);
      this.deps.stateDB.deleteDir(oldPath);
      this.deps.stateDB.setDir({ path: newPath, remoteFileId: null });
      this.deps.stateDB.requestSave();
      void this.deps.logger?.log(`watch: folder renamed → MOVE ${oldPath} → ${newPath}`);
    } catch (err) {
      console.warn(`[SyncEngine] Single-folder rename failed ${oldPath} → ${newPath}:`, err);
    } finally {
      this.end();
    }
  }

  // Called once the run has finished. The set is drained into a local copy first so re-entry cannot loop.
  // Failures are per-path and already handled inside syncSingleFile.
  async drainPending(): Promise<void> {
    if (this.pendingPaths.size === 0) return;
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    void this.deps.logger?.log(`watch: full sync finished → re-evaluating ${paths.length} deferred path(s)`);
    for (const p of paths) {
      await this.syncSingleFile(p);
    }
  }

  // `conflictsBefore` is conflictEncounters captured before the operation: a conflict settled by a deterministic
  // strategy shows up in NO summary counter (it is recorded as a plain upload/download) yet drops one side's
  // content, so notifying only on merged/conflicted would stay silent about the most destructive resolution.
  private notifyWatchOutcome(path: string, summary: SyncSessionSummary, conflictsBefore: number): void {
    if (summary.errorCount > 0) {
      this.notify(`❌ Sync failed: ${path}`, 6000);
      return;
    }
    if (summary.conflictedCount > 0) {
      this.notify(`⚠️ Conflict in ${path} — the note holds both versions; review and resolve it.`, 8000);
      return;
    }
    if (summary.mergedCount > 0) {
      this.notify(`🔀 Merged remote changes into ${path}`, 6000);
      return;
    }
    if (this.deps.conflictEncounters() > conflictsBefore) {
      this.notify(`🔀 ${path} changed on both sides — resolved by your conflict settings.`, 6000);
    }
  }

  private locallyUnchanged(base: FileState, stat: { mtime: number; size: number }): boolean {
    return isLocallyUnchanged(base, stat, {
      now: () => Date.now(),
      lastSyncTime: () => this.deps.stateDB.getLastSyncTime(),
    });
  }

  private notify(message: string, timeout?: number): void {
    if (this.deps.notify) this.deps.notify(message, timeout);
    else new Notice(message, timeout);
  }
}
