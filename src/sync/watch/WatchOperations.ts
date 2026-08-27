// Watch-mode single-file and single-folder operations, lifted out of SyncEngine (feature 074,
// Phase 7).
//
// Everything Obsidian's vault watcher triggers: one file saved, deleted, renamed; one folder created,
// deleted, renamed. Each touches exactly one path and avoids the full-vault scan and remote listing a
// "Sync now" performs — that economy is the entire point of watch mode.
//
// The direction of dependency here is the opposite of the other extracted modules, and deliberately
// so. Policy, scan, transfer and conflict are called BY the sync loop; this module CALLS INTO it,
// because feature 064 settled that watch mode must not decide anything itself. Deciding what to do
// with a changed file is the full sync's classifier, and it is reached through the `processFile` port
// below rather than by importing the engine — so the runtime hand-off exists without an import cycle.
//
// Two rules run through all of it:
//
//   Never run alongside a full sync. A multi-step resolve (stat → compare → write → push) must not
//   interleave with the full sync writing the same file. Edits are DEFERRED (re-evaluated when the
//   run ends), while deletions are DROPPED — the running scan already propagates a tracked path that
//   vanished locally, so queuing one would risk a second delete.
//
//   Stay silent unless the user has to know. Watch mode runs unattended, so routine uploads and
//   downloads say nothing; only a failure or a genuine divergence raises a notice.
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

/** The connected server, resolved by the caller before each operation. */
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

  /** Connect (or reuse the connection) and return the client plus its upload strategy. */
  connect(): Promise<Connection>;
  /** The rename tracker, created lazily by the engine because it needs the connected client. */
  renameTracker(): RenameTracker;

  /** Whether a full sync is running right now. */
  isSyncRunning(): boolean;
  /**
   * The full sync's per-file classifier. Injected as a port rather than imported: feature 064 (C-3)
   * settled that watch mode and "Sync now" must reach identical results, which means watch mode runs
   * the same decision code instead of a second copy of it.
   */
  processFile(remote: RemoteFileInfo, summary: SyncSessionSummary): Promise<void>;
  /** Outbound port: this path needs another attempt on the next sync. */
  queueRetry(path: string): void;
  /** How many conflicts the engine has encountered so far (see notifyWatchOutcome). */
  conflictEncounters(): number;
  logger?: Pick<FileLogger, 'log'>;
  /** User-facing notice; injected so the outcome rules can be exercised without an Obsidian runtime. */
  notify?(message: string, timeout?: number): void;
}

export class WatchOperations {
  /**
   * Feature 046: number of watch-mode single-file/folder ops currently propagating to the remote.
   * Drives the status bar so the user can see immediate (watch) propagation happening. Owned here
   * because nothing outside these operations reads it.
   */
  private inFlight = 0;

  /**
   * Feature 064 (C-5): paths whose watch-mode single-file sync arrived while a full sync was running.
   * Drained once the run finishes — deferring rather than dropping keeps the edit from being missed
   * when the full sync had already passed that file.
   *
   * Held in memory only — losing them on a plugin reload is harmless because the next full sync
   * detects the same local change anyway (self-healing); persisting them would add a second, weaker
   * source of truth for "what changed locally".
   */
  private readonly pendingPaths = new Set<string>();

  constructor(private readonly deps: WatchDeps) {}

  /**
   * Feature 046: reflect watch-mode (immediate) propagation on the status bar. Each in-flight
   * single-file/folder op shows "syncing"; when the last one finishes the bar returns to idle. Guarded
   * by the running check so it never fights a concurrent full sync (which owns the status during its run).
   */
  private begin(): void {
    this.inFlight++;
    if (!this.deps.isSyncRunning()) this.deps.statusBar.setStatus('syncing');
  }

  private end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0 && !this.deps.isSyncRunning()) this.deps.statusBar.setStatus('idle');
  }

  /**
   * Sync ONE locally-changed file (watch mode). No-ops if the content is unchanged.
   *
   * Feature 064 (GitHub issue #23): this used to PUT the local body straight to the server —
   * no PROPFIND, no base comparison, and (because it passed `etag: null`) no If-Match either. Any
   * edit made on another device since our last sync was therefore overwritten silently: no conflict,
   * no merge, no notice. Since "Sync on file change" defaults to ON on desktop, that was the DEFAULT
   * path to losing data. The fix is not to bolt a precondition onto the blind upload but to give this
   * path the one thing it lacked — the remote's current state — and then hand it to the SAME
   * classifier the full sync uses (processFile). Watch mode and "Sync now" now converge on
   * identical results (contract C-3); nothing about the decision lives here.
   */
  async syncSingleFile(path: string): Promise<void> {
    if (this.deps.isSystemExcluded(path)) return;
    // C-5: never run alongside a full sync. The multi-step resolve below (stat → compare → write →
    // push) must not interleave with the full sync's writes to the same file, so defer the path and
    // re-evaluate it once the run finishes — deferring rather than dropping keeps the edit from being
    // missed when the full sync had already passed this file.
    if (this.deps.isSyncRunning()) {
      this.pendingPaths.add(path);
      void this.deps.logger?.log(`watch: full sync in progress → deferred ${path}`);
      return;
    }
    const stat = await this.deps.localAdapter.stat(path);
    if (!stat) return; // already deleted before the debounce fired
    const base = this.deps.stateDB.getFile(path);
    // FR-006: decide "nothing changed" from LOCAL data only, before touching the network. The stat
    // signature fast-path (P0-A) answers most saves without even reading the file; a signature miss
    // falls back to hashing. Only a real content change is worth a round-trip.
    if (base && this.locallyUnchanged(base, stat)) return;
    const data = await this.deps.localAdapter.readBinary(path);
    const localHash = await sha256(data);
    if (base && localHash === base.localHash) return; // content unchanged (e.g. mtime-only touch)

    const conn = await this.deps.connect();
    // A real (not dummy) summary: its counters are what tells us whether to notify the user (C-6),
    // and processFile/handleConflict already maintain them exactly as they do in a full sync.
    const summary = this.deps.journal.newSummary();
    const conflictsBefore = this.deps.conflictEncounters();
    this.begin();
    try {
      const remote = await conn.client.statFile(path);
      if (remote) {
        // The whole classification (upload / download / conflict → merge, If-Match from remote.etag,
        // size guards, marker re-entrancy, feature-063 untracked handling) is the full sync's code.
        void this.deps.logger?.log(`watch: remote state fetched → classifying ${path}`);
        await this.deps.processFile(remote, summary);
      } else {
        // C-1 row 4: not on the server at all → a plain create. A precondition would be wrong here
        // (If-Match against a non-existent resource always fails), so keep the synthetic null etag.
        void this.deps.logger?.log(`watch: not on remote → upload as new ${path}`);
        await this.deps.transfer.uploadFile(
          conn.client, conn.uploadStrategy,
          path, localHash, base?.remoteId ?? localHash, base?.idType ?? 'sha256',
          { path, fileId: base?.remoteFileId ?? null, checksum: null, etag: null, size: stat.size, lastModified: stat.mtime },
          summary,
        );
      }
      // Watch-mode single-file op: coalesce the state write via a trailing debounce so rapid
      // edits don't each rewrite the whole state file (P0-B). onunload flushes any pending save.
      this.deps.stateDB.requestSave();
      await this.deps.historyStore?.save(); // persist the entry recorded by the branch above
    } catch (err) {
      // FR-009: never lose the edit. A network failure queues the path so the next sync re-evaluates
      // it; the local file is untouched either way.
      console.warn(`[SyncEngine] Single-file sync failed for ${path}:`, err);
      void this.deps.logger?.log(`watch: FAILED ${path} — ${(err as Error).message}`, 'error');
      this.deps.journal.recordError(summary, path, err);
      if (err instanceof NetworkError) this.deps.queueRetry(path);
    } finally {
      this.end();
    }
    this.notifyWatchOutcome(path, summary, conflictsBefore);
  }

  /**
   * Delete a single file from the remote when it was deleted locally (watch mode).
   *
   * Feature 064 (C-2): this used to DELETE unconditionally. `deleteFile(path, expectedRemoteId)`
   * reads like a guarded delete, but every client ignores that argument (blind DELETE, spec 023), so a
   * note another device had just edited was removed anyway — the full sync's delete path has guarded
   * against exactly that since spec 023, and this one did not. It now runs the SAME guard
   * (applyLocalDeletion): delete only while the server's recomputed checksum still matches our base,
   * otherwise restore the remote copy locally instead of destroying it.
   */
  async deleteSingleFile(path: string): Promise<void> {
    if (this.deps.isSystemExcluded(path)) return;
    const base = this.deps.stateDB.getFile(path);
    if (!base) return; // not tracked — nothing to do on remote
    // C-2 row 1: during a full sync, do nothing — and do NOT defer either. The running scan detects a
    // tracked path that is gone locally and propagates the deletion itself, so queuing it here would
    // only risk a second delete against a path the scan already handled.
    if (this.deps.isSyncRunning()) {
      void this.deps.logger?.log(`watch: full sync in progress → deletion of ${path} left to the running scan`);
      return;
    }
    const conn = await this.deps.connect();
    const summary = this.deps.journal.newSummary();
    const conflictsBefore = this.deps.conflictEncounters();
    this.begin();
    try {
      const remote = await conn.client.statFile(path);
      if (!remote) {
        // C-2 row 3: already absent on the server — that IS the desired end state. Stop tracking it.
        void this.deps.logger?.log(`watch: already gone on remote → dropping tracking for ${path}`);
        this.deps.journal.recordHistory(path, 'deleted');
        this.deps.stateDB.deleteFile(path);
        this.deps.mergeBase.drop(path); // feature 038: file gone → drop its merge base
        this.deps.resolution.dropCleanSnapshot(path); // feature 044: file gone → drop any captured clean sides
      } else {
        const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
        const idType: FileState['idType'] = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');
        // Shared with the full sync: deletes on a checksum match, restores the remote copy when it
        // diverged, and does nothing when the server cannot prove the copy is unchanged. It owns the
        // StateDB cleanup too — including the G1-2 rule of keeping the entry when the DELETE fails,
        // so a failed delete is retried instead of coming back as a re-download.
        await this.deps.deletion.applyLocalDeletion(conn.client, remote, base, remoteId, idType, summary);
        if (!this.deps.stateDB.getFile(path)) this.deps.resolution.dropCleanSnapshot(path);
      }
      this.deps.stateDB.requestSave(); // coalesced watch-mode save (P0-B)
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

  /** MOVE a single file on the remote when it was renamed/moved locally. */
  async renameSingleFile(oldPath: string, newPath: string): Promise<void> {
    if (this.deps.isSystemExcluded(oldPath) && this.deps.isSystemExcluded(newPath)) return;
    await this.deps.connect();
    const rt = this.deps.renameTracker();
    this.begin();
    try {
      await rt.applyLocalRename(oldPath, newPath);
      this.deps.stateDB.requestSave(); // coalesced watch-mode save (P0-B)
    } catch (err) {
      console.warn(`[SyncEngine] Single-file rename failed ${oldPath} → ${newPath}:`, err);
    } finally {
      this.end();
    }
  }

  /**
   * Feature 046 (watch-mode folder propagation): create a single folder on the remote immediately
   * when it is created locally (MKCOL). Idempotent — a folder that already exists on the server is a
   * no-op (405 swallowed), which also makes it safe against a stray download-created-folder event.
   */
  async createSingleFolder(path: string): Promise<void> {
    if (this.deps.isSystemExcluded(path)) return;
    const conn = await this.deps.connect();
    this.begin();
    try {
      await conn.client.createDirectory(path); // idempotent: existing folder → harmless
      this.deps.stateDB.setDir({ path, remoteFileId: null });
      this.deps.stateDB.requestSave(); // coalesced watch-mode save
      void this.deps.logger?.log(`watch: folder created → MKCOL ${path}`);
    } catch (err) {
      console.warn(`[SyncEngine] Single-folder create failed for ${path}:`, err);
    } finally {
      this.end();
    }
  }

  /**
   * Feature 046: delete a single folder on the remote immediately when it is deleted locally. Only a
   * TRACKED folder (present in the StateDB directory set) is propagated — an untracked folder was
   * never on the server, so deleting it locally is a no-op remotely (mirrors deleteSingleFile). The
   * remote delete routes through the Nextcloud trashbin (recoverable); a 404 is the desired end state.
   */
  async deleteSingleFolder(path: string): Promise<void> {
    if (this.deps.isSystemExcluded(path)) return;
    if (!this.deps.stateDB.getDir(path)) return; // untracked → nothing to do on the remote
    const conn = await this.deps.connect();
    this.begin();
    let succeeded = false;
    try {
      await conn.client.deleteCollection(path); // trashbin; 404 handled inside as success
      void this.deps.logger?.log(`watch: folder deleted → remote collection removed ${path}`);
      succeeded = true;
    } catch (err) {
      console.warn(`[SyncEngine] Single-folder delete failed for ${path}:`, err);
    } finally {
      this.end();
    }
    // BUG G1-2 fix: only drop the tracked directory when the remote delete actually succeeded (see
    // deleteSingleFile for the full rationale) — otherwise the next sync would re-create it locally.
    if (!succeeded) return;
    this.deps.stateDB.deleteDir(path);
    this.deps.stateDB.requestSave();
  }

  /**
   * Feature 046: MOVE a single folder on the remote immediately when it is renamed/moved locally.
   * Collections are moved with the same WebDAV MOVE as files; the server moves the whole subtree.
   * Any child-file rename events Obsidian fires alongside are handled best-effort by renameSingleFile
   * (their 404s are harmless because the parent MOVE already relocated them) and converge next sync.
   */
  async renameSingleFolder(oldPath: string, newPath: string): Promise<void> {
    if (this.deps.isSystemExcluded(oldPath) && this.deps.isSystemExcluded(newPath)) return;
    const conn = await this.deps.connect();
    this.begin();
    try {
      await conn.client.moveFile(oldPath, newPath); // MOVE works for collections too
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

  /**
   * C-5: re-evaluate every path whose watch-mode sync was deferred by a full sync. Called once the
   * run has finished (running === false). The set is drained into a local copy first so a path
   * deferred again mid-drain (it cannot be — running is false — but also so re-entry is impossible)
   * never loops. Failures are per-path and already handled inside syncSingleFile.
   */
  async drainPending(): Promise<void> {
    if (this.pendingPaths.size === 0) return;
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    void this.deps.logger?.log(`watch: full sync finished → re-evaluating ${paths.length} deferred path(s)`);
    for (const p of paths) {
      await this.syncSingleFile(p);
    }
  }

  /**
   * C-6: watch mode runs unattended, so it stays silent for the routine outcomes (upload, download,
   * nothing to do) and speaks up only when the user has to know — the sync failed, or the two sides
   * had diverged and something had to be decided about it.
   *
   * `conflictsBefore` is the conflictEncounters value captured before the operation: a conflict
   * settled by a deterministic strategy shows up in NO summary counter (it is recorded as a plain
   * upload/download), and that is exactly the case where one side's content was dropped. Notifying
   * only on merged/conflicted would stay silent about the most destructive resolution of all.
   */
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

  /** Binds the ambient clock and last-sync time for the local-unchanged fast path. */
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
